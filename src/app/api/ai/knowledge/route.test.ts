import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Fase 3 §4 — `knowledge_documents`.
//
// Stock limit: the cap is on how many documents exist right now, not on
// how many were ever created. Deleting one frees the slot, which a
// monotonic `usage_counters` row could never express.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getEntitlements: vi.fn(),
  ingestDocument: vi.fn(async () => {}),
  state: {
    docCount: 0,
    countError: null as { message: string } | null,
    inserted: null as Record<string, unknown> | null,
    counted: [] as { table: string; filters: [string, unknown][] }[],
  },
}));

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  getEntitlements: mocks.getEntitlements,
}));

vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));

vi.mock('@/lib/ai/config', () => ({
  loadEmbeddingsKey: async () => ({ key: null, corrupt: false }),
}));

vi.mock('@/lib/ai/knowledge', () => ({
  ingestDocument: (...args: unknown[]) =>
    (mocks.ingestDocument as unknown as (...a: unknown[]) => unknown)(...args),
}));

import { POST } from './route';

function supabaseMock() {
  return {
    from: (table: string) => {
      const entry = {
        table,
        counting: false,
        filters: [] as [string, unknown][],
      };
      const chain: Record<string, unknown> = {
        select: (_cols?: string, opts?: { head?: boolean }) => {
          if (opts?.head) {
            entry.counting = true;
            mocks.state.counted.push(entry);
          }
          return chain;
        },
        eq: (col: string, val: unknown) => {
          entry.filters.push([col, val]);
          return chain;
        },
        insert: (row: Record<string, unknown>) => {
          mocks.state.inserted = row;
          return chain;
        },
        single: async () => ({ data: { id: 'doc-1' }, error: null }),
        then: (resolve: (v: unknown) => unknown) =>
          resolve({
            count: mocks.state.docCount,
            error: mocks.state.countError,
          }),
      };
      return chain;
    },
  };
}

function entitlements(knowledgeDocuments: number | null) {
  return {
    planId: 'inicio',
    status: 'active',
    limits: { knowledge_documents: knowledgeDocuments },
    features: ['ai_knowledge'],
    readOnly: false,
    trialEndsAt: null,
  };
}

function post(body: Record<string, unknown> = { title: 'T', content: 'C' }) {
  return POST(
    new Request('https://crm.example.com/api/ai/knowledge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

beforeEach(() => {
  mocks.state.docCount = 0;
  mocks.state.countError = null;
  mocks.state.inserted = null;
  mocks.state.counted = [];
  mocks.requireRole.mockReset();
  mocks.requireRole.mockResolvedValue({
    supabase: supabaseMock(),
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  });
  mocks.getEntitlements.mockReset();
  mocks.getEntitlements.mockResolvedValue(entitlements(10));
  mocks.ingestDocument.mockReset();
  mocks.ingestDocument.mockResolvedValue(undefined);
});

describe('POST /api/ai/knowledge — knowledge_documents (fase 3 §4)', () => {
  it('saves the document while the plan has room', async () => {
    mocks.state.docCount = 9;
    const res = await post();
    expect(res.status).toBe(200);
    expect(mocks.state.inserted).toMatchObject({ account_id: 'acct-1' });
  });

  it('402s once the plan allowance is full, without writing anything', async () => {
    mocks.state.docCount = 10;

    const res = await post();
    const json = await res.json();

    expect(res.status).toBe(402);
    expect(json.code).toBe('plan_limit_reached');
    expect(json.metric).toBe('knowledge_documents');
    expect(json.limit).toBe(10);
    expect(json.used).toBe(10);
    expect(json.upgradeUrl).toBe('/billing');
    expect(mocks.state.inserted).toBeNull();
    expect(mocks.ingestDocument).not.toHaveBeenCalled();
  });

  it("counts only this account's documents (leak test)", async () => {
    await post();
    expect(mocks.state.counted).toHaveLength(1);
    expect(mocks.state.counted[0].table).toBe('ai_knowledge_documents');
    expect(mocks.state.counted[0].filters).toContainEqual([
      'account_id',
      'acct-1',
    ]);
    expect(mocks.getEntitlements).toHaveBeenCalledWith('acct-1');
  });

  it('fails closed when the count cannot be taken', async () => {
    mocks.state.countError = { message: 'permission denied' };
    const res = await post();
    expect(res.status).toBe(500);
    expect(mocks.state.inserted).toBeNull();
  });

  it('never blocks on a plan with no document cap', async () => {
    mocks.getEntitlements.mockResolvedValue(entitlements(null));
    mocks.state.docCount = 100_000;
    const res = await post();
    expect(res.status).toBe(200);
  });
});
