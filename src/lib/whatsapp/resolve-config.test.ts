import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase } from '@/lib/security/fake-supabase';
import {
  resolveWhatsAppConfig,
  listWhatsAppConfigs,
  configIdForPhoneNumberId,
  WhatsAppConfigError,
  WHATSAPP_NOT_CONFIGURED_MESSAGE,
} from './resolve-config';

// ============================================================
// Fase 4 §1, criterio «una empresa con varios números envía por el que
// elige». The resolution order is the whole feature: get it wrong and a
// reply leaves through a number the customer has never seen, or — the
// case that used to be impossible and now isn't — a `.single()` blows up
// on the second row and the account simply stops being able to send.
//
// The database is `fake-supabase.ts`, which evaluates the queries for
// real (filters, ordering, limits), so an `.eq('account_id', …)` that
// goes missing shows up here as a leaked row rather than as a passing
// test against a hand-rolled mock.
// ============================================================

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => `plain:${v}`,
  encrypt: (v: string) => v,
  isLegacyFormat: (v: string) => v.startsWith('legacy:'),
}));

const A = 'acct-a';
const B = 'acct-b';

function cfg(over: Record<string, unknown>) {
  return {
    id: 'cfg-x',
    account_id: A,
    user_id: 'user-a',
    phone_number_id: 'pn-x',
    access_token: 'tok-x',
    is_default: false,
    status: 'connected',
    created_at: '2026-01-01T00:00:00Z',
    ...over,
  };
}

/**
 * Two accounts. A has two numbers (sales = default, support); B has one.
 * B's rows are seeded FIRST and B's number is also the oldest overall,
 * so any query that forgets its account filter lands on B.
 */
function db(extra: Record<string, unknown[]> = {}) {
  return new FakeDatabase({
    whatsapp_config: [
      cfg({
        id: 'cfg-b',
        account_id: B,
        user_id: 'user-b',
        phone_number_id: 'pn-b',
        access_token: 'tok-b',
        is_default: true,
        created_at: '2025-01-01T00:00:00Z',
      }),
      cfg({
        id: 'cfg-sales',
        phone_number_id: 'pn-sales',
        access_token: 'tok-sales',
        is_default: true,
        label: 'Sales',
        created_at: '2026-01-01T00:00:00Z',
      }),
      cfg({
        id: 'cfg-support',
        phone_number_id: 'pn-support',
        access_token: 'tok-support',
        label: 'Support',
        created_at: '2026-02-01T00:00:00Z',
      }),
    ],
    conversations: [
      {
        id: 'conv-b',
        account_id: B,
        user_id: 'user-b',
        contact_id: 'ct-b',
        whatsapp_config_id: 'cfg-b',
      },
      {
        id: 'conv-support',
        account_id: A,
        user_id: 'user-a',
        contact_id: 'ct-a',
        whatsapp_config_id: 'cfg-support',
      },
      {
        id: 'conv-legacy',
        account_id: A,
        user_id: 'user-a',
        contact_id: 'ct-a2',
        // Pre-053 thread: the column exists but was never sealed.
        whatsapp_config_id: null,
      },
    ],
    ...extra,
  });
}

const admin = (d: FakeDatabase) => d.admin as unknown as SupabaseClient;

describe('resolveWhatsAppConfig — the resolution order', () => {
  it('1. an explicit config_id wins over everything else', async () => {
    const d = db();
    const { row } = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      configId: 'cfg-support',
      // Present and pointing elsewhere on purpose: the explicit choice
      // is the caller saying "send from THIS number", and it has to win.
      conversationId: 'conv-legacy',
    });
    expect(row.id).toBe('cfg-support');
  });

  it("2. otherwise the conversation's own number, not the default", async () => {
    const d = db();
    const { row } = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      conversationId: 'conv-support',
    });
    // The account default is cfg-sales; the customer wrote to support.
    expect(row.id).toBe('cfg-support');
  });

  it('3. a thread with no number sealed falls back to the default', async () => {
    const d = db();
    const { row } = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      conversationId: 'conv-legacy',
    });
    expect(row.id).toBe('cfg-sales');
  });

  it('3b. with no conversation at all, the default', async () => {
    const d = db();
    const { row } = await resolveWhatsAppConfig(admin(d), { accountId: A });
    expect(row.id).toBe('cfg-sales');
  });

  it('4. with the default deleted by hand, the oldest survivor', async () => {
    const d = db();
    const rows = d.rows('whatsapp_config');
    rows.splice(
      rows.findIndex((r) => r.id === 'cfg-sales'),
      1
    );
    const { row } = await resolveWhatsAppConfig(admin(d), { accountId: A });
    expect(row.id).toBe('cfg-support');
  });

  it('5. an account with no numbers raises the message it always raised', async () => {
    const d = new FakeDatabase({ whatsapp_config: [], conversations: [] });
    const err = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppConfigError);
    expect(err.code).toBe('whatsapp_not_configured');
    expect(err.status).toBe(400);
    // Byte-for-byte: routes, translations and tests key off this text.
    expect(err.message).toBe(WHATSAPP_NOT_CONFIGURED_MESSAGE);
  });
});

describe('resolveWhatsAppConfig — tenancy (CP3)', () => {
  it("a config_id from another account is a 404, never that account's row", async () => {
    const d = db();
    const err = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      configId: 'cfg-b',
    }).catch((e) => e);
    expect(err).toBeInstanceOf(WhatsAppConfigError);
    expect(err.code).toBe('whatsapp_number_not_found');
    expect(err.status).toBe(404);
  });

  it("a conversation_id from another account never yields B's number", async () => {
    const d = db();
    const { row } = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      conversationId: 'conv-b',
    });
    // Falls through to A's own default instead of following B's seal.
    expect(row.id).toBe('cfg-sales');
    expect(row.account_id).toBe(A);
  });

  it("an account with no numbers does not inherit another account's", async () => {
    const d = db();
    const err = await resolveWhatsAppConfig(admin(d), {
      accountId: 'acct-empty',
    }).catch((e) => e);
    expect(err.code).toBe('whatsapp_not_configured');
  });
});

describe('resolveWhatsAppConfig — the token', () => {
  it('decrypts only when asked', async () => {
    const d = db();
    const without = await resolveWhatsAppConfig(admin(d), { accountId: A });
    expect(without.accessToken).toBe('');

    const withToken = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      withToken: true,
    });
    expect(withToken.accessToken).toBe('plain:tok-sales');
  });

  it('self-heals a legacy CBC ciphertext by id, scoped to the account', async () => {
    const d = db();
    const row = d.rows('whatsapp_config').find((r) => r.id === 'cfg-sales')!;
    row.access_token = 'legacy:tok-sales';

    const { accessToken } = await resolveWhatsAppConfig(admin(d), {
      accountId: A,
      withToken: true,
    });
    expect(accessToken).toBe('plain:legacy:tok-sales');

    // Fire-and-forget: let the microtask queue drain.
    await Promise.resolve();
    await Promise.resolve();

    const write = d.log.find(
      (e) => e.table === 'whatsapp_config' && e.op === 'update'
    );
    expect(write).toBeDefined();
    expect(write!.filters).toContainEqual({
      op: 'eq',
      column: 'account_id',
      value: A,
    });
    // B's row must be untouched whatever happens.
    expect(
      d.rows('whatsapp_config').find((r) => r.id === 'cfg-b')!.access_token
    ).toBe('tok-b');
  });
});

describe('listWhatsAppConfigs / configIdForPhoneNumberId', () => {
  it('lists the account default first, then oldest first', async () => {
    const d = db();
    const rows = await listWhatsAppConfigs(admin(d), A);
    expect(rows.map((r) => r.id)).toEqual(['cfg-sales', 'cfg-support']);
  });

  it("translates the public phone_number_id into this account's row id", async () => {
    const d = db();
    expect(await configIdForPhoneNumberId(admin(d), A, 'pn-support')).toBe(
      'cfg-support'
    );
    // B's number is not addressable as A, which is what makes the
    // public API's `from` parameter safe to accept from the internet.
    expect(await configIdForPhoneNumberId(admin(d), A, 'pn-b')).toBeNull();
    expect(await configIdForPhoneNumberId(admin(d), A, 'nope')).toBeNull();
  });
});
