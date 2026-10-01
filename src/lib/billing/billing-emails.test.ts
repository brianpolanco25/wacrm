import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import type { EmailProvider, EmailSendResult } from '@/lib/email/provider';

import {
  claimDecision,
  EMAIL_SWEEP_ACCOUNT_LIMIT,
  monthKeyUtc,
  numberLabel,
  quotaEventFor,
  recipientsFrom,
  statementEventsFor,
  sweepBillingEmails,
  type EmailStatementRow,
  type NotificationRow,
} from './billing-emails';

// p11.7 — R8–R20 contra la base en memoria (evalúa las consultas de
// verdad) con un proveedor falso. Sin red.

const NOW = Date.parse('2026-10-20T12:00:00.000Z');
const HOUR = 3600_000;
const A = 'acct-a';
const B = 'acct-b';

function iso(ms: number) {
  return new Date(ms).toISOString();
}

// ------------------------------------------------------------------
// Lógica pura
// ------------------------------------------------------------------

describe('quotaEventFor (R8)', () => {
  it.each([
    [799, 0, null],
    [800, 0, 'service_quota_80'],
    [999, 0, 'service_quota_80'],
    [1000, 0, 'service_quota_100'],
    [10, 1, 'service_quota_100'],
  ])('used %i, billable %i → %s', (used, billable, expected) => {
    expect(quotaEventFor({ used, billable })).toBe(expected);
  });
});

describe('monthKeyUtc (R8)', () => {
  it('the last minute of the year and the first of the next', () => {
    expect(monthKeyUtc(Date.parse('2026-12-31T23:59:00.000Z'))).toBe('2026-12');
    expect(monthKeyUtc(Date.parse('2027-01-01T00:00:00.000Z'))).toBe('2027-01');
    expect(monthKeyUtc(Date.parse('2026-03-01T00:00:00.000Z'))).toBe('2026-03');
  });
});

function st(over: Partial<EmailStatementRow> = {}): EmailStatementRow {
  return {
    id: 'st-1',
    account_id: A,
    period_start: '2026-09-20T00:00:00.000Z',
    period_end: '2026-10-20T00:00:00.000Z',
    total_usd: '1037.85',
    status: 'issued',
    issued_at: iso(NOW - HOUR),
    due_at: iso(NOW + 3 * 24 * HOUR),
    ...over,
  };
}

describe('statementEventsFor (R11, R12, R13)', () => {
  const kinds = (rows: EmailStatementRow[]) =>
    statementEventsFor(rows, NOW).map((e) => `${e.kind}:${e.ref}`);

  it('issued 1 h ago → statement_issued', () => {
    expect(kinds([st()])).toEqual(['statement_issued:st-1']);
  });
  it('issued 73 h ago → nothing', () => {
    expect(kinds([st({ issued_at: iso(NOW - 73 * HOUR) })])).toEqual([]);
  });
  it.each(['paid', 'void'])('%s → nothing', (status) => {
    expect(kinds([st({ status, due_at: iso(NOW - 2 * HOUR) })])).toEqual([]);
  });
  it('overdue 2 h ago → statement_due', () => {
    expect(
      kinds([
        st({ issued_at: iso(NOW - 74 * HOUR), due_at: iso(NOW - 2 * HOUR) }),
      ])
    ).toEqual(['statement_due:st-1']);
  });
  it('due within 1 h → no statement_due yet', () => {
    expect(
      kinds([st({ issued_at: iso(NOW - 74 * HOUR), due_at: iso(NOW + HOUR) })])
    ).toEqual([]);
  });
  it('overdue 73 h ago → nothing', () => {
    expect(
      kinds([
        st({ issued_at: iso(NOW - 150 * HOUR), due_at: iso(NOW - 73 * HOUR) }),
      ])
    ).toEqual([]);
  });
  it('paid after falling due → nothing', () => {
    expect(
      kinds([
        st({
          status: 'paid',
          issued_at: iso(NOW - 74 * HOUR),
          due_at: iso(NOW - 2 * HOUR),
        }),
      ])
    ).toEqual([]);
  });
  it('issued and overdue inside the window → both', () => {
    expect(kinds([st({ due_at: iso(NOW - 10 * 60_000) })])).toEqual([
      'statement_issued:st-1',
      'statement_due:st-1',
    ]);
  });
});

function nrow(over: Partial<NotificationRow>): NotificationRow {
  return {
    id: 'n-1',
    kind: 'statement_issued',
    ref: 'st-1',
    status: 'failed',
    attempts: 1,
    updated_at: iso(NOW - 2 * HOUR),
    ...over,
  };
}

describe('claimDecision (R16, R18)', () => {
  it('no row → insert', () => {
    expect(claimDecision(undefined, NOW)).toBe('insert');
  });
  it.each(['sent', 'skipped'])('%s → skip', (status) => {
    expect(
      claimDecision(nrow({ status, updated_at: iso(NOW - 99 * HOUR) }), NOW)
    ).toBe('skip');
  });
  it('failed 30 min ago → skip', () => {
    expect(
      claimDecision(nrow({ updated_at: iso(NOW - 30 * 60_000) }), NOW)
    ).toBe('skip');
  });
  it('failed 61 min ago → reclaim', () => {
    expect(
      claimDecision(nrow({ updated_at: iso(NOW - 61 * 60_000) }), NOW)
    ).toBe('reclaim');
  });
  it('pending for more than 1 h (the run died) → reclaim', () => {
    expect(
      claimDecision(
        nrow({ status: 'pending', updated_at: iso(NOW - 61 * 60_000) }),
        NOW
      )
    ).toBe('reclaim');
  });
  it('pending 10 min (another run is on it) → skip', () => {
    expect(
      claimDecision(
        nrow({ status: 'pending', updated_at: iso(NOW - 10 * 60_000) }),
        NOW
      )
    ).toBe('skip');
  });
  it('attempts = 3 → never again', () => {
    expect(
      claimDecision(
        nrow({ attempts: 3, updated_at: iso(NOW - 99 * HOUR) }),
        NOW
      )
    ).toBe('skip');
  });
});

describe('numberLabel and recipientsFrom', () => {
  it('label → verified_name → display_phone_number → phone_number_id', () => {
    const full = {
      id: 'c',
      label: 'Ventas',
      verified_name: 'Tienda',
      display_phone_number: '+1 809',
      phone_number_id: 'pn',
    };
    expect(numberLabel(full)).toBe('Ventas');
    expect(numberLabel({ ...full, label: ' ' })).toBe('Tienda');
    expect(numberLabel({ ...full, label: null, verified_name: null })).toBe(
      '+1 809'
    );
    expect(
      numberLabel({
        ...full,
        label: null,
        verified_name: null,
        display_phone_number: null,
      })
    ).toBe('pn');
  });

  it('no blanks, no duplicates ignoring case, at most 20', () => {
    expect(
      recipientsFrom([
        { email: 'a@x.test' },
        { email: ' A@X.test ' },
        { email: '' },
        { email: null },
        { email: 'b@x.test' },
      ])
    ).toEqual(['a@x.test', 'b@x.test']);
    const many = Array.from({ length: 30 }, (_, i) => ({
      email: `u${i}@x.test`,
    }));
    expect(recipientsFrom(many)).toHaveLength(20);
  });
});

// ------------------------------------------------------------------
// Barrido
// ------------------------------------------------------------------

/** used/billable por número, que la RPC falsa devuelve por cuenta. */
let usage: Record<string, { used: number; billable: number }>;
let rpcFails: Set<string>;
let db: FakeDatabase;
let provider: EmailProvider & { send: ReturnType<typeof vi.fn> };
let sendResult: EmailSendResult;

function profile(
  accountId: string,
  role: string,
  email: string | null,
  tag = role
): Row {
  return {
    id: `profile-${accountId}-${tag}`,
    user_id: `user-${accountId}-${tag}`,
    account_id: accountId,
    account_role: role,
    email,
  };
}

function number(accountId: string, n = 1): Row {
  return {
    id: `cfg-${accountId}-${n}`,
    account_id: accountId,
    status: 'connected',
    label: null,
    verified_name: `Tienda ${accountId}`,
    display_phone_number: `+1 809 ${accountId}`,
    phone_number_id: `pn-${accountId}-${n}`,
  };
}

function makeDb(seed: Record<string, Row[]> = {}): FakeDatabase {
  return new FakeDatabase(
    {
      whatsapp_config: [number(B), number(A)],
      subscriptions: [
        { id: 'sub-b', account_id: B, meta_billing: 'direct' },
        { id: 'sub-a', account_id: A, meta_billing: 'direct' },
      ],
      profiles: [
        profile(B, 'owner', 'owner-b@b.test'),
        profile(A, 'owner', 'owner-a@a.test'),
      ],
      statements: [],
      notification_emails: [],
      messages: [],
      conversations: [],
      ...seed,
    },
    {
      service_quota_usage: (args) => {
        const acc = args.p_account_id as string;
        if (rpcFails.has(acc))
          return { data: null, error: { message: 'boom' } };
        return Object.entries(usage)
          .filter(([cfg]) => cfg.startsWith(`cfg-${acc}-`))
          .map(([cfg, u]) => ({ whatsapp_config_id: cfg, ...u }));
      },
    }
  );
}

function sweep(opts: { nowMs?: number; siteUrl?: string | null } = {}) {
  return sweepBillingEmails(db.admin as unknown as SupabaseClient, {
    nowMs: opts.nowMs ?? NOW,
    resolution: { provider, reason: null },
    locale: 'es',
    siteUrl: opts.siteUrl === undefined ? null : opts.siteUrl,
  });
}

function sentTo(accountEmail: string) {
  return provider.send.mock.calls.filter((c) =>
    (c[0] as { to: string[] }).to.includes(accountEmail)
  );
}

function log(accountId?: string) {
  return db
    .rows('notification_emails')
    .filter((r) => !accountId || r.account_id === accountId);
}

beforeEach(() => {
  usage = {};
  rpcFails = new Set();
  sendResult = { ok: true };
  provider = {
    name: 'console',
    send: vi.fn(async () => sendResult),
  };
  db = makeDb();
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('without a provider (R15)', () => {
  it.each(['not_configured', 'misconfigured'] as const)(
    '%s → enabled false and not a single query',
    async (reason) => {
      const out = await sweepBillingEmails(
        db.admin as unknown as SupabaseClient,
        {
          nowMs: NOW,
          resolution: { provider: null, reason },
        }
      );
      expect(out).toMatchObject({ enabled: false, reason, sent: 0, errors: 0 });
      expect(db.log).toEqual([]);
    }
  );

  it('the default resolution reads the environment: nothing set → off', async () => {
    vi.stubEnv('EMAIL_API_URL', '');
    vi.stubEnv('EMAIL_API_KEY', '');
    vi.stubEnv('EMAIL_FROM', '');
    vi.stubEnv('EMAIL_PROVIDER', '');
    const out = await sweepBillingEmails(
      db.admin as unknown as SupabaseClient,
      { nowMs: NOW }
    );
    expect(out).toMatchObject({ enabled: false, reason: 'not_configured' });
    expect(db.log).toEqual([]);
  });
});

describe('free service quota (R8, R9, R10)', () => {
  it('850 → one 80 % email; 1.000 → one 100 % email; a third run → nothing', async () => {
    usage['cfg-acct-a-1'] = { used: 850, billable: 0 };
    const first = await sweep();
    expect(first).toMatchObject({ enabled: true, sent: 1, errors: 0 });
    expect(provider.send).toHaveBeenCalledTimes(1);
    const msg1 = provider.send.mock.calls[0][0];
    expect(msg1.kind).toBe('service_quota_80');
    expect(msg1.to).toEqual(['owner-a@a.test']);
    expect(msg1.subject).toContain('Tienda acct-a');
    expect(msg1.subject).toContain('850');

    usage['cfg-acct-a-1'] = { used: 1000, billable: 0 };
    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(provider.send.mock.calls[1][0].kind).toBe('service_quota_100');

    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(log(A).map((r) => [r.kind, r.ref, r.status])).toEqual([
      ['service_quota_80', 'cfg-acct-a-1:2026-10', 'sent'],
      ['service_quota_100', 'cfg-acct-a-1:2026-10', 'sent'],
    ]);
    expect(log(A)[0]).toMatchObject({
      recipients: 1,
      sent_at: iso(NOW),
      attempts: 1,
    });
  });

  it('once the 100 % went out, no 80 % of that month follows', async () => {
    db.rows('notification_emails').push({
      id: 'n-100',
      account_id: A,
      kind: 'service_quota_100',
      ref: 'cfg-acct-a-1:2026-10',
      status: 'sent',
      attempts: 1,
      updated_at: iso(NOW - HOUR),
    });
    usage['cfg-acct-a-1'] = { used: 900, billable: 0 };
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('799 sends nothing, and next month starts again', async () => {
    usage['cfg-acct-a-1'] = { used: 799, billable: 0 };
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();

    usage['cfg-acct-a-1'] = { used: 850, billable: 0 };
    await sweep();
    await sweep({ nowMs: Date.parse('2026-11-02T00:00:00.000Z') });
    expect(log(A).map((r) => r.ref)).toEqual([
      'cfg-acct-a-1:2026-10',
      'cfg-acct-a-1:2026-11',
    ]);
  });

  it('the RPC gets the account and the first day of the month (UTC)', async () => {
    await sweep();
    const calls = db.log.filter((e) => e.table === 'rpc:service_quota_usage');
    expect(calls.map((c) => c.args)).toEqual([
      { p_account_id: A, p_since: '2026-10-01T00:00:00.000Z' },
      { p_account_id: B, p_since: '2026-10-01T00:00:00.000Z' },
    ]);
  });

  it('a managed account with a number at 1.000: no email and no RPC call (R10)', async () => {
    db.rows('subscriptions').find((s) => s.account_id === A)!.meta_billing =
      'managed';
    usage['cfg-acct-a-1'] = { used: 1000, billable: 3 };
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
    const rpcAccounts = db.log
      .filter((e) => e.table === 'rpc:service_quota_usage')
      .map((e) => e.args?.p_account_id);
    expect(rpcAccounts).toEqual([B]);
  });

  it('a disconnected number is not evaluated', async () => {
    db.rows('whatsapp_config').find((c) => c.account_id === A)!.status =
      'disconnected';
    usage['cfg-acct-a-1'] = { used: 1000, billable: 0 };
    const out = await sweep();
    expect(provider.send).not.toHaveBeenCalled();
    expect(out.accounts).toBe(1);
  });

  it('each number of an account has its own email', async () => {
    db.rows('whatsapp_config').push({ ...number(A, 2), label: 'Soporte' });
    usage['cfg-acct-a-1'] = { used: 850, billable: 0 };
    usage['cfg-acct-a-2'] = { used: 1200, billable: 200 };
    await sweep();
    expect(provider.send.mock.calls.map((c) => c[0].kind).sort()).toEqual([
      'service_quota_100',
      'service_quota_80',
    ]);
    expect(
      provider.send.mock.calls.some((c) => c[0].subject.includes('Soporte'))
    ).toBe(true);
  });
});

describe('statements (R11–R13)', () => {
  function seedStatement(over: Partial<EmailStatementRow> = {}) {
    db.rows('statements').push(st(over) as unknown as Row);
  }

  it('issued 1 h ago → statement_issued with the total and the due date', async () => {
    seedStatement();
    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(1);
    const msg = provider.send.mock.calls[0][0];
    expect(msg.kind).toBe('statement_issued');
    expect(msg.text).toContain('US$ 1037,85');
    expect(msg.text).toContain('23 de octubre de 2026');
    expect(log(A)).toEqual([
      expect.objectContaining({
        kind: 'statement_issued',
        ref: 'st-1',
        status: 'sent',
      }),
    ]);
  });

  it('overdue and still issued → statement_due once', async () => {
    seedStatement({
      issued_at: iso(NOW - 74 * HOUR),
      due_at: iso(NOW - 2 * HOUR),
    });
    await sweep();
    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0][0].kind).toBe('statement_due');
  });

  it('a statement issued 10 days ago with an empty log sends nothing (no retroactive emails)', async () => {
    seedStatement({
      issued_at: iso(NOW - 240 * HOUR),
      due_at: iso(NOW - 168 * HOUR),
    });
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
    expect(log()).toEqual([]);
  });

  it('paid → nothing', async () => {
    seedStatement({ status: 'paid' });
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('the link to /billing when NEXT_PUBLIC_SITE_URL is set (R23)', async () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
    seedStatement();
    await sweepBillingEmails(db.admin as unknown as SupabaseClient, {
      nowMs: NOW,
      resolution: { provider, reason: null },
      locale: 'es',
    });
    expect(provider.send.mock.calls[0][0].text).toMatch(
      /\n\nDetalles: https:\/\/crm\.example\.com\/billing$/
    );
  });
});

describe('reservation and idempotency (R16, R18)', () => {
  it('three runs in a row → one email per event', async () => {
    db.rows('statements').push(st() as unknown as Row);
    usage['cfg-acct-a-1'] = { used: 850, billable: 0 };
    for (let i = 0; i < 3; i++) await sweep();
    expect(provider.send).toHaveBeenCalledTimes(2);
    expect(log(A)).toHaveLength(2);
  });

  it('two runs at the same time → exactly one send', async () => {
    db.rows('statements').push(st() as unknown as Row);
    const [r1, r2] = await Promise.all([sweep(), sweep()]);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(r1.sent + r2.sent).toBe(1);
    expect(log(A)).toHaveLength(1);
  });

  it('the reservation goes in BEFORE the provider is called', async () => {
    db.rows('statements').push(st() as unknown as Row);
    provider.send.mockImplementationOnce(async () => {
      expect(log(A)).toEqual([
        expect.objectContaining({ status: 'pending', attempts: 1 }),
      ]);
      return { ok: true };
    });
    await sweep();
    expect(log(A)[0].status).toBe('sent');
  });

  function failedRow(minutesAgo: number, attempts: number): Row {
    return {
      id: 'n-failed',
      account_id: A,
      kind: 'statement_issued',
      ref: 'st-1',
      status: 'failed',
      attempts,
      last_error: 'HTTP 500',
      updated_at: iso(NOW - minutesAgo * 60_000),
    };
  }

  it('failed 30 min ago → not retried yet', async () => {
    db.rows('statements').push(st() as unknown as Row);
    db.rows('notification_emails').push(failedRow(30, 1));
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('failed 61 min ago → retried, attempts = 2, sent', async () => {
    db.rows('statements').push(st() as unknown as Row);
    db.rows('notification_emails').push(failedRow(61, 1));
    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(log(A)).toEqual([
      expect.objectContaining({
        id: 'n-failed',
        attempts: 2,
        status: 'sent',
        last_error: null,
      }),
    ]);
  });

  it('attempts = 3 → never retried', async () => {
    db.rows('statements').push(st() as unknown as Row);
    db.rows('notification_emails').push(failedRow(600, 3));
    await sweep();
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('the optimistic reclaim loses to a run that bumped attempts first', async () => {
    db.rows('statements').push(st() as unknown as Row);
    db.rows('notification_emails').push(failedRow(61, 1));
    const [r1, r2] = await Promise.all([sweep(), sweep()]);
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(r1.sent + r2.sent).toBe(1);
    expect(log(A)[0].attempts).toBe(2);
  });

  it('a failed send leaves the row failed with a clean error, and secrets stay out of the log and the base', async () => {
    db.rows('profiles').push(profile(A, 'admin', 'secret-admin@a.test'));
    db.rows('statements').push(st() as unknown as Row);
    sendResult = { ok: false, error: 'HTTP 401' };
    const out = await sweep();
    expect(out).toMatchObject({ sent: 0, failed: 1 });
    expect(log(A)[0]).toMatchObject({
      status: 'failed',
      last_error: 'HTTP 401',
      attempts: 1,
    });
    const consoleText = [console.error, console.warn, console.info]
      .flatMap((f) =>
        (f as unknown as ReturnType<typeof vi.fn>).mock.calls.flat()
      )
      .map(String)
      .join('\n');
    const baseText = JSON.stringify(log());
    for (const text of [consoleText, baseText]) {
      expect(text).not.toContain('secret-admin@a.test');
      expect(text).not.toContain('owner-a@a.test');
      expect(text).not.toContain('1037,85');
    }
  });
});

describe('recipients (R17)', () => {
  it('only the owner and the admins, once each, no blanks', async () => {
    db.rows('profiles').push(
      profile(A, 'admin', 'admin-a@a.test'),
      profile(A, 'agent', 'agent-a@a.test'),
      profile(A, 'viewer', 'viewer-a@a.test'),
      profile(A, 'admin', 'OWNER-A@a.test', 'dup'),
      profile(A, 'admin', '   ', 'blank')
    );
    db.rows('statements').push(st() as unknown as Row);
    await sweep();
    expect(provider.send).toHaveBeenCalledTimes(1);
    expect(provider.send.mock.calls[0][0].to).toEqual([
      'owner-a@a.test',
      'admin-a@a.test',
    ]);
    expect(log(A)[0].recipients).toBe(2);
  });

  it('an account with nobody to write to → skipped, no send', async () => {
    db.rows('profiles').splice(
      0,
      db.rows('profiles').length,
      profile(A, 'agent', 'agent-a@a.test'),
      profile(B, 'owner', 'owner-b@b.test')
    );
    db.rows('statements').push(st() as unknown as Row);
    const out = await sweep();
    expect(provider.send).not.toHaveBeenCalled();
    expect(out.skipped).toBe(1);
    expect(log(A)[0]).toMatchObject({ status: 'skipped' });
    // skipped no se reintenta.
    await sweep({ nowMs: NOW + 5 * HOUR });
    expect(provider.send).not.toHaveBeenCalled();
  });
});

describe('never blocks (R19)', () => {
  it("A's quota RPC fails → B still gets its email", async () => {
    rpcFails.add(A);
    usage['cfg-acct-a-1'] = { used: 900, billable: 0 };
    usage['cfg-acct-b-1'] = { used: 900, billable: 0 };
    const out = await sweep();
    expect(out.errors).toBe(1);
    expect(out.sent).toBe(1);
    expect(sentTo('owner-b@b.test')).toHaveLength(1);
    expect(sentTo('owner-a@a.test')).toHaveLength(0);
  });

  it('a provider that throws (breaking its contract) is caught; the row is failed; the next event still goes', async () => {
    db.rows('statements').push(st() as unknown as Row);
    usage['cfg-acct-b-1'] = { used: 900, billable: 0 };
    provider.send.mockImplementation(async (m: { to: string[] }) => {
      if (m.to.includes('owner-a@a.test'))
        throw new Error('kaboom owner-a@a.test');
      return { ok: true };
    });
    const out = await sweep();
    expect(out).toMatchObject({ errors: 1, sent: 1 });
    expect(log(A)[0]).toMatchObject({ status: 'failed', last_error: 'Error' });
    expect(log(B)[0]).toMatchObject({ status: 'sent' });
  });

  it('the reservation table missing (code before migration 083) → errors, no send, no throw', async () => {
    db.rows('statements').push(st() as unknown as Row);
    const admin = db.admin;
    const original = admin.from.bind(admin);
    admin.from = ((table: string) => {
      if (table === 'notification_emails') {
        return {
          select: () => ({
            eq: () => ({
              in: async () => ({
                data: null,
                error: {
                  message: 'relation "notification_emails" does not exist',
                },
              }),
            }),
          }),
        };
      }
      return original(table);
    }) as typeof admin.from;
    const out = await sweepBillingEmails(admin as unknown as SupabaseClient, {
      nowMs: NOW,
      resolution: { provider, reason: null },
      locale: 'es',
    });
    expect(out).toMatchObject({ enabled: true, errors: 1, sent: 0 });
    expect(provider.send).not.toHaveBeenCalled();
  });

  it('a client that throws on every call → a summary, never an exception', async () => {
    const broken = {
      from: () => {
        throw new Error('down');
      },
      rpc: () => {
        throw new Error('down');
      },
    } as unknown as SupabaseClient;
    const out = await sweepBillingEmails(broken, {
      nowMs: NOW,
      resolution: { provider, reason: null },
    });
    expect(out.enabled).toBe(true);
    expect(out.errors).toBeGreaterThan(0);
  });

  it('reads only; writes only notification_emails', async () => {
    db.rows('statements').push(st() as unknown as Row);
    usage['cfg-acct-a-1'] = { used: 1000, billable: 0 };
    await sweep();
    const writes = new Set(
      db.log
        .filter((e) => e.op !== 'select' && e.op !== 'rpc')
        .map((e) => e.table)
    );
    expect(writes).toEqual(new Set(['notification_emails']));
    const reads = new Set(
      db.log.filter((e) => e.op === 'select').map((e) => e.table)
    );
    expect(reads).toEqual(
      new Set([
        'whatsapp_config',
        'subscriptions',
        'statements',
        'profiles',
        'notification_emails',
      ])
    );
  });
});

describe('cost (R20)', () => {
  it('501 accounts with numbers → 500 treated and truncated', async () => {
    const configs: Row[] = [];
    const subs: Row[] = [];
    for (let i = 0; i < EMAIL_SWEEP_ACCOUNT_LIMIT + 1; i++) {
      const acc = `acct-${String(i).padStart(4, '0')}`;
      configs.push(number(acc));
      subs.push({ id: `sub-${acc}`, account_id: acc, meta_billing: 'direct' });
    }
    db = makeDb({
      whatsapp_config: configs,
      subscriptions: subs,
      profiles: [],
    });
    const out = await sweep();
    expect(out).toMatchObject({ accounts: 500, truncated: true, errors: 0 });
    expect(db.log.filter((e) => e.op === 'rpc')).toHaveLength(500);
  });

  it('exactly 500 → not truncated', async () => {
    const configs: Row[] = [];
    for (let i = 0; i < EMAIL_SWEEP_ACCOUNT_LIMIT; i++) {
      configs.push(number(`acct-${String(i).padStart(4, '0')}`));
    }
    db = makeDb({ whatsapp_config: configs, subscriptions: [], profiles: [] });
    const out = await sweep();
    expect(out).toMatchObject({ accounts: 500, truncated: false });
  });
});
