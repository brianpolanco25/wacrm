import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/plan-options — the plan selectors of s9.4. Every
// plan of the catalogue, private ones included (that is what a manual
// assignment is for), and only for an operator.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  plans: [] as unknown[],
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: { getUser: async () => ({ data: { user: h.user }, error: null }) },
  }),
}));

vi.mock('@/lib/auth/admin-client', () => ({
  supabaseAdmin: () => ({
    from: () => ({
      select: () => ({
        eq: (_c: string, userId: string) => ({
          maybeSingle: async () => ({
            data: h.admins.has(userId)
              ? { user_id: userId, granted_at: null, note: null }
              : null,
            error: null,
          }),
        }),
      }),
    }),
  }),
}));

vi.mock('@/lib/rate-limit', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/rate-limit')>()),
  checkRateLimit: () => ({ success: true, limit: 1, remaining: 1, reset: 0 }),
}));

vi.mock('@/lib/platform/provisioning', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/provisioning')>()),
  listPlanOptions: async () => h.plans,
}));

const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.plans = [
    { id: 'inicio', name: 'Inicio', isPublic: true },
    { id: 'ilimitado', name: 'Ilimitado', isPublic: false },
  ];
});

describe('GET /api/platform/plan-options', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await GET()).status).toBe(401);
  });

  it('403s a company owner', async () => {
    h.user = { id: '22222222-2222-4222-8222-222222222222' };
    expect((await GET()).status).toBe(403);
  });

  it('gives an operator every plan, private ones included', async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ plans: h.plans });
  });
});
