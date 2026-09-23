import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Migration 065: the public API is a Pro/Negocio feature. Minting a key on
// Inicio is refused up front (402 + upgrade hint) instead of handing out a
// credential that `/api/v1` would reject on every call.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  assertPlanFeature: vi.fn(),
  inserted: null as Record<string, unknown> | null,
}));

// `toErrorResponse` stays real: it is what turns the billing error into
// the 402 with `code` asserted below.
vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: mocks.requireRole,
}));

vi.mock('@/lib/billing/enforce', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/billing/enforce')>()),
  assertPlanFeature: mocks.assertPlanFeature,
}));

import { __resetRateLimitForTests } from '@/lib/rate-limit';
import { POST } from './route';

function fakeClient() {
  return {
    from: () => {
      const chain = {
        insert: (row: Record<string, unknown>) => {
          mocks.inserted = row;
          return chain;
        },
        select: () => chain,
        single: async () => ({
          data: { id: 'key-1', name: mocks.inserted?.name },
          error: null,
        }),
      };
      return chain;
    },
  };
}

function req(body: unknown) {
  return new Request('https://crm.test/api/account/api-keys', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.inserted = null;
  mocks.requireRole.mockReset().mockResolvedValue({
    supabase: fakeClient(),
    accountId: 'acct-1',
    userId: 'user-1',
  });
  mocks.assertPlanFeature.mockReset().mockResolvedValue({});
  __resetRateLimitForTests();
});

describe('POST /api/account/api-keys', () => {
  it('mints a key on a plan with the api feature', async () => {
    const res = await POST(req({ name: 'Zapier', scopes: [] }));
    expect(res.status).toBe(201);
    expect(mocks.assertPlanFeature).toHaveBeenCalledWith('acct-1', 'api');
    expect(mocks.inserted).toMatchObject({ name: 'Zapier' });
  });

  it('refuses to mint on a plan without the api feature', async () => {
    const { FeatureNotAvailableError } = await import('@/lib/billing/enforce');
    mocks.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('api')
    );
    const res = await POST(req({ name: 'Zapier', scopes: [] }));
    expect(res.status).toBe(402);
    expect((await res.json()).code).toBe('feature_unavailable');
    expect(mocks.inserted).toBeNull();
  });

  // a7.8 §1: the dashboard mint reads its body through `readJsonBody`, the
  // same capped reader `/api/v1` uses, and answers in the `{ error }` shape.
  it('answers 413 for a body over 1 MiB, without inserting', async () => {
    const { MAX_BODY_BYTES } = await import('@/lib/api/v1/body');
    const res = await POST(
      new Request('https://crm.test/api/account/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: 'x'.repeat(MAX_BODY_BYTES + 1),
      })
    );
    expect(res.status).toBe(413);
    expect(typeof (await res.json()).error).toBe('string');
    expect(mocks.inserted).toBeNull();
  });

  it('answers 415 for a text/plain body, without inserting', async () => {
    const res = await POST(
      new Request('https://crm.test/api/account/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'text/plain' },
        body: JSON.stringify({ name: 'Zapier' }),
      })
    );
    expect(res.status).toBe(415);
    expect((await res.json()).error).toMatch(/Content-Type/);
    expect(mocks.inserted).toBeNull();
  });

  it('keeps treating an empty body as {} (400 name required)', async () => {
    const res = await POST(
      new Request('https://crm.test/api/account/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("'name' is required");
  });

  it('answers 400 for malformed JSON', async () => {
    const res = await POST(
      new Request('https://crm.test/api/account/api-keys', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{"name":',
      })
    );
    expect(res.status).toBe(400);
    expect(mocks.inserted).toBeNull();
  });
});
