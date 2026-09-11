import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { BroadcastError } from './broadcast-core';
import {
  claimBroadcastDelivery,
  planBroadcastResume,
  releaseBroadcastDelivery,
  RESUME_MAX_PER_REQUEST,
} from './broadcast-resume';

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `decrypted:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: () => false,
}));

// ============================================================
// Claim / release — the mutex that stops a double-send.
// ============================================================

interface ClaimCall {
  update: Record<string, unknown>;
  filters: Record<string, unknown>;
  or?: string;
}

function claimDb(returnedRows: unknown[], calls: ClaimCall[]): SupabaseClient {
  return {
    from() {
      const call: ClaimCall = { update: {}, filters: {} };
      const b: Record<string, unknown> = {
        update: (row: Record<string, unknown>) => {
          call.update = row;
          calls.push(call);
          return b;
        },
        eq: (col: string, val: unknown) => {
          call.filters[col] = val;
          return b;
        },
        or: (expr: string) => {
          call.or = expr;
          return b;
        },
        select: async () => ({ data: returnedRows, error: null }),
        then: (resolve: (r: { error: null }) => unknown) =>
          resolve({ error: null }),
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

describe('claimBroadcastDelivery', () => {
  it('claims when the conditional UPDATE matched a row', async () => {
    const calls: ClaimCall[] = [];
    const ok = await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z')
    );

    expect(ok).toBe(true);
    expect(calls[0].filters).toEqual({ id: 'bc-1', account_id: 'acct-1' });
    expect(calls[0].update.delivery_locked_at).toBe('2026-08-11T12:00:00.000Z');
  });

  it('refuses when another pass already holds the lock', async () => {
    // The UPDATE's WHERE didn't match — someone else got there first.
    const ok = await claimBroadcastDelivery(claimDb([], []), 'acct-1', 'bc-1');
    expect(ok).toBe(false);
  });

  it('treats a lock older than the staleness window as abandoned', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(
      claimDb([{ id: 'bc-1' }], calls),
      'acct-1',
      'bc-1',
      new Date('2026-08-11T12:00:00Z')
    );
    // 30 minutes before "now" — a pass whose process died is recoverable
    // without touching the database by hand.
    expect(calls[0].or).toBe(
      'delivery_locked_at.is.null,delivery_locked_at.lt.2026-08-11T11:30:00.000Z'
    );
  });

  it('is scoped to the account, so another tenant cannot claim it', async () => {
    const calls: ClaimCall[] = [];
    await claimBroadcastDelivery(claimDb([], calls), 'acct-9', 'bc-1');
    expect(calls[0].filters.account_id).toBe('acct-9');
  });
});

describe('releaseBroadcastDelivery', () => {
  it('clears the lock', async () => {
    const calls: ClaimCall[] = [];
    await releaseBroadcastDelivery(claimDb([], calls), 'bc-1');
    expect(calls[0].update).toEqual({ delivery_locked_at: null });
    expect(calls[0].filters).toEqual({ id: 'bc-1' });
  });
});

// ============================================================
// Planning — which recipients a pass picks up, and with what params.
// ============================================================

interface PlanFixture {
  broadcast?: Record<string, unknown> | null;
  recipients?: Record<string, unknown>[];
  config?: Record<string, unknown> | null;
  templates?: Record<string, unknown>[];
}

interface PlanWrites {
  statusFilter?: unknown;
  failedIds?: unknown;
  failedUpdate?: Record<string, unknown>;
}

function planDb(fx: PlanFixture, writes: PlanWrites = {}): SupabaseClient {
  return {
    from(table: string) {
      let askedConfigId: string | null = null;
      const b: Record<string, unknown> = {
        select: () => b,
        eq: (col?: string, val?: unknown) => {
          if (table === 'whatsapp_config' && col === 'id') {
            askedConfigId = val as string;
          }
          return b;
        },
        order: () => b,
        in: (col: string, vals: unknown) => {
          if (col === 'status') writes.statusFilter = vals;
          if (col === 'id') writes.failedIds = vals;
          return b;
        },
        update: (row: Record<string, unknown>) => {
          writes.failedUpdate = row;
          return b;
        },
        // Post-053 both the broadcast row and its sender number end on
        // `.maybeSingle()` — the number is resolved by id (the one the
        // campaign froze), never by `.single()` on the account.
        maybeSingle: async () => {
          if (table === 'whatsapp_config') {
            const row = fx.config === undefined ? null : fx.config;
            // The resolver asks for the number BY ID — the one the
            // campaign froze. An id that is not this fixture's row must
            // come back empty, or the test could not tell "resumed
            // through the campaign's number" from "resumed through
            // whatever the fixture had".
            if (
              askedConfigId &&
              row &&
              (row as { id?: string }).id !== askedConfigId
            ) {
              return { data: null, error: null };
            }
            return { data: row, error: null };
          }
          return {
            data: fx.broadcast === undefined ? null : fx.broadcast,
            error: null,
          };
        },
        single: async () => ({
          data: fx.config === undefined ? null : fx.config,
          error: null,
        }),
        then: (resolve: (r: { data: unknown[]; error: null }) => unknown) => {
          if (table === 'broadcast_recipients') {
            return resolve({ data: fx.recipients ?? [], error: null });
          }
          if (table === 'message_templates') {
            return resolve({ data: fx.templates ?? [], error: null });
          }
          return resolve({ data: [], error: null });
        },
      };
      return b;
    },
  } as unknown as SupabaseClient;
}

const BROADCAST = {
  id: 'bc-1',
  template_name: 'order_update',
  template_language: 'en_US',
  // The number this campaign went out on (migration 053). A resume has
  // to use it, never the account default.
  whatsapp_config_id: 'cfg-1',
};

const CONFIG = {
  id: 'cfg-1',
  account_id: 'acct-1',
  phone_number_id: 'pn-1',
  access_token: 'tok',
};

function recipient(
  id: string,
  phone: string | null,
  params: unknown = ['A123']
) {
  return {
    id,
    template_params: params,
    contact: phone ? { phone } : null,
  };
}

describe('planBroadcastResume', () => {
  it('plans the outstanding recipients with their frozen params', async () => {
    const writes: PlanWrites = {};
    const { plan, remaining, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567', ['A123', 'Friday']),
            recipient('r2', '+15559876543', ['B456', 'Monday']),
          ],
        },
        writes
      ),
      'acct-1',
      'bc-1',
      'pending'
    );

    expect(writes.statusFilter).toEqual(['pending']);
    // Phones are stored sanitized (no leading '+'), same as the shape
    // createBroadcast plans — deliverBroadcast feeds them to
    // phoneVariants from here.
    expect(plan.planned).toEqual([
      {
        recipientRowId: 'r1',
        phone: '15551234567',
        params: ['A123', 'Friday'],
      },
      {
        recipientRowId: 'r2',
        phone: '15559876543',
        params: ['B456', 'Monday'],
      },
    ]);
    expect(plan.accessToken).toBe('decrypted:tok');
    expect(remaining).toBe(0);
    expect(unsendable).toBe(0);
  });

  it('scopes to failed rows when retrying, and to both for "all"', async () => {
    const failedWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        failedWrites
      ),
      'acct-1',
      'bc-1',
      'failed'
    );
    expect(failedWrites.statusFilter).toEqual(['failed']);

    const allWrites: PlanWrites = {};
    await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [recipient('r1', '+15551234567')],
        },
        allWrites
      ),
      'acct-1',
      'bc-1',
      'all'
    );
    expect(allWrites.statusFilter).toEqual(['pending', 'failed']);
  });

  it('treats a missing or malformed params column as no params', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: BROADCAST,
        config: CONFIG,
        recipients: [
          // Rows created before migration 038 carry NULL.
          recipient('r1', '+15551234567', null),
          recipient('r2', '+15559876543', 'not-an-array'),
        ],
      }),
      'acct-1',
      'bc-1',
      'pending'
    );
    expect(plan.planned.map((p) => p.params)).toEqual([[], []]);
  });

  it('fails unsendable rows up front so they stop blocking the status', async () => {
    const writes: PlanWrites = {};
    const { plan, unsendable } = await planBroadcastResume(
      planDb(
        {
          broadcast: BROADCAST,
          config: CONFIG,
          recipients: [
            recipient('r1', '+15551234567'),
            recipient('r2', null),
            recipient('r3', 'nonsense'),
          ],
        },
        writes
      ),
      'acct-1',
      'bc-1',
      'pending'
    );

    // Left 'pending', these would keep the broadcast in 'sending'
    // forever — the exact symptom being fixed.
    expect(unsendable).toBe(2);
    expect(writes.failedIds).toEqual(['r2', 'r3']);
    expect(writes.failedUpdate?.status).toBe('failed');
    expect(plan.planned).toHaveLength(1);
  });

  it('caps one pass and reports the leftover', async () => {
    const many = Array.from({ length: RESUME_MAX_PER_REQUEST + 25 }, (_, i) =>
      recipient(`r${i}`, '+1555000' + String(i).padStart(4, '0'))
    );
    const { plan, remaining } = await planBroadcastResume(
      planDb({ broadcast: BROADCAST, config: CONFIG, recipients: many }),
      'acct-1',
      'bc-1',
      'pending'
    );
    expect(plan.planned).toHaveLength(RESUME_MAX_PER_REQUEST);
    // Surfaced to the caller rather than silently dropped.
    expect(remaining).toBe(25);
  });

  it('404s a broadcast that is not on this account', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: null }),
        'acct-1',
        'bc-1',
        'pending'
      )
    ).rejects.toMatchObject({ status: 404 });
  });

  it('refuses when there is nothing outstanding', async () => {
    await expect(
      planBroadcastResume(
        planDb({ broadcast: BROADCAST, config: CONFIG, recipients: [] }),
        'acct-1',
        'bc-1',
        'failed'
      )
    ).rejects.toBeInstanceOf(BroadcastError);
  });

  it('resolves the template row for header + button components', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, template_language: 'en_US' },
        config: CONFIG,
        recipients: [recipient('r1', '+15551234567')],
        templates: [
          {
            id: 'tpl-1',
            user_id: 'u-1',
            name: 'order_update',
            // Synced from Meta as bare 'en' — the resolver bridges it.
            language: 'en',
            body_text: 'Your order {{1}} ships on {{2}}',
          },
        ],
      }),
      'acct-1',
      'bc-1',
      'pending'
    );
    expect(plan.templateRow?.language).toBe('en');
  });
});

// ============================================================
// Fase 4 §1 (criterio 4, fila 4c del plan) — a resume leaves through
// the number the campaign STARTED on.
//
// This is the single easiest thing to get wrong in the whole feature
// and the most expensive: resuming through another number restarts the
// 24-hour window for every recipient still pending, and splits one
// campaign's quality signal across two numbers. It is also invisible
// from the dashboard — the operator sees a campaign that finished.
// ============================================================

describe('planBroadcastResume — sender number (fase 4 §1)', () => {
  const SALES = {
    id: 'cfg-sales',
    account_id: 'acct-1',
    phone_number_id: 'pn-sales',
    access_token: 'tok-sales',
  };

  it("uses the campaign's frozen number even when another one is the default", async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        // The campaign went out on support…
        broadcast: { ...BROADCAST, whatsapp_config_id: 'cfg-support' },
        config: {
          id: 'cfg-support',
          account_id: 'acct-1',
          phone_number_id: 'pn-support',
          access_token: 'tok-support',
        },
        recipients: [recipient('r1', '+15551234567')],
      }),
      'acct-1',
      'bc-1',
      'pending'
    );

    // …so the resume does too, whatever the account default is today.
    expect(plan.phoneNumberId).toBe('pn-support');
    expect(plan.accessToken).toBe('decrypted:tok-support');
  });

  it('falls back to the default for a campaign created before migration 053', async () => {
    const { plan } = await planBroadcastResume(
      planDb({
        // Column exists, never filled: the backfill of 053 covers the
        // rows that were there, this covers the ones it could not.
        broadcast: { ...BROADCAST, whatsapp_config_id: null },
        config: SALES,
        recipients: [recipient('r1', '+15551234567')],
      }),
      'acct-1',
      'bc-1',
      'pending'
    );

    expect(plan.phoneNumberId).toBe('pn-sales');
  });

  it('names the cause when the number the campaign used was disconnected', async () => {
    // The FK is ON DELETE SET NULL, so the id survives only while the
    // row does; a disconnect between two passes lands here.
    const err = await planBroadcastResume(
      planDb({
        broadcast: { ...BROADCAST, whatsapp_config_id: 'cfg-gone' },
        config: SALES,
        recipients: [recipient('r1', '+15551234567')],
      }),
      'acct-1',
      'bc-1',
      'pending'
    ).catch((e) => e);

    expect(err).toBeInstanceOf(BroadcastError);
    expect(err.code).toBe('whatsapp_not_configured');
    expect(err.message).toMatch(/no longer connected/);
  });
});
