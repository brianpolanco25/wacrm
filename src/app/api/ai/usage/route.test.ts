import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Supuesto S1 (la IA la paga el servicio): migration 047 widened the
// `ai_usage_log.mode` CHECK with 'playground', and the playground route now
// writes those rows. This route is the ONLY reader of that table, so the
// summary has to survive every value the database accepts — including ones
// added after this file was written.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  rows: [] as Record<string, unknown>[],
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  // Mirrors the real helper: anything that isn't an AuthError becomes a 500.
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'Internal server error' }, { status: 500 })
  ),
}));

import { GET } from './route';

/** An `ai_usage_log` client whose terminal `.limit()` resolves to `rows`. */
function supabaseMock() {
  const chain = {
    select: () => chain,
    eq: () => chain,
    gte: () => chain,
    order: () => chain,
    limit: () => Promise.resolve({ data: mocks.rows, error: null }),
  };
  return { from: () => chain };
}

function usageRow(mode: string, totalTokens: number): Record<string, unknown> {
  return {
    created_at: new Date().toISOString(),
    mode,
    provider: 'openai',
    model: 'gpt-4o-mini',
    prompt_tokens: Math.floor(totalTokens / 2),
    completion_tokens: totalTokens - Math.floor(totalTokens / 2),
    total_tokens: totalTokens,
  };
}

function sumTokens(byMode: Record<string, { calls: number; tokens: number }>) {
  return Object.values(byMode).reduce((acc, m) => acc + m.tokens, 0);
}

describe('GET /api/ai/usage', () => {
  beforeEach(() => {
    mocks.rows = [];
    mocks.requireRole.mockReset();
    mocks.requireRole.mockResolvedValue({
      supabase: supabaseMock(),
      accountId: 'acct-1',
    });
  });

  it('summarises auto_reply, draft and playground rows without dropping any tokens', async () => {
    mocks.rows = [
      usageRow('auto_reply', 100),
      usageRow('draft', 50),
      usageRow('playground', 30),
    ];

    const res = await GET(new Request('http://x/api/ai/usage?days=7'));
    const body = await res.json();

    expect(res.status).toBe(200);

    // The breakdown has a slot for each mode the DB CHECK allows.
    expect(body.by_mode.auto_reply).toEqual({ calls: 1, tokens: 100 });
    expect(body.by_mode.draft).toEqual({ calls: 1, tokens: 50 });
    expect(body.by_mode.playground).toEqual({ calls: 1, tokens: 30 });

    // And the headline total is exactly the sum of that breakdown, which is
    // what the card renders side by side.
    expect(body.totals.total_tokens).toBe(180);
    expect(sumTokens(body.by_mode)).toBe(body.totals.total_tokens);
    expect(body.totals.calls).toBe(3);
  });

  it('tallies a mode it has never heard of instead of failing the request', async () => {
    // The CHECK constraint can grow again; a fourth mode must not turn the
    // spend card into a 500 for the whole window.
    mocks.rows = [usageRow('auto_reply', 10), usageRow('future_mode', 7)];

    const res = await GET(new Request('http://x/api/ai/usage'));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.by_mode.future_mode).toEqual({ calls: 1, tokens: 7 });
    expect(sumTokens(body.by_mode)).toBe(body.totals.total_tokens);
  });

  it('keeps the summary scoped to the caller account', async () => {
    const filters: [string, unknown][] = [];
    const chain = {
      select: () => chain,
      eq: (col: string, val: unknown) => {
        filters.push([col, val]);
        return chain;
      },
      gte: () => chain,
      order: () => chain,
      limit: () => Promise.resolve({ data: [], error: null }),
    };
    mocks.requireRole.mockResolvedValue({
      supabase: { from: () => chain },
      accountId: 'acct-1',
    });

    const res = await GET(new Request('http://x/api/ai/usage'));

    expect(res.status).toBe(200);
    expect(filters).toContainEqual(['account_id', 'acct-1']);
  });
});

// ---------------------------------------------------------------------------
// Fase 3 §5 — a locked account is read-only, not blind.
//
// `requireRole` refuses any `min` above `viewer` while the subscription
// is suspended (the ladder itself is tested in `src/lib/auth/account.test.ts`).
// This GET asks for `admin` because spend is billing-class data, not
// because it writes anything — and the spend page is exactly where an
// operator goes to understand the bill it is being asked to settle. The
// mock below reproduces the real rule: refuse unless the caller opted
// out of the gate.
// ---------------------------------------------------------------------------

describe('GET /api/ai/usage — a suspended account keeps reading (fase 3 §5)', () => {
  it('answers with the subscription suspended', async () => {
    mocks.rows = [usageRow('auto_reply', 10)];
    mocks.requireRole.mockImplementation(
      async (min: string, options?: { allowReadOnly?: boolean }) => {
        if (min !== 'viewer' && !options?.allowReadOnly) {
          throw new Error('account is read-only');
        }
        return { supabase: supabaseMock(), accountId: 'acct-1' };
      }
    );

    const res = await GET(new Request('http://x/api/ai/usage'));

    expect(res.status).toBe(200);
    expect((await res.json()).totals.total_tokens).toBe(10);
  });
});
