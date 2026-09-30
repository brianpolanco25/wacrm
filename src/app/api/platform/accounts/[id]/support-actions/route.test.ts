import { beforeEach, describe, expect, it, vi } from 'vitest';

// GET /api/platform/accounts/[id]/support-actions (s9.5). The guard, the
// 404s, and that the id in the URL is the only account ever asked about.

const h = vi.hoisted(() => ({
  user: null as { id: string } | null,
  admins: new Set<string>(),
  summary: true,
  asked: [] as string[],
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

vi.mock('@/lib/platform/accounts', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform/accounts')>()),
  loadAccountSummary: async (id: string) =>
    h.summary ? { id, name: 'Company', createdAt: '2026-01-01' } : null,
}));

vi.mock('@/lib/platform/support-activity', () => ({
  loadSupportActivity: async (id: string) => {
    h.asked.push(id);
    return {
      sessions: [{ id: `log-of-${id}`, actions: [] }],
      truncated: false,
    };
  },
}));

const { GET } = await import('./route');

const OPERATOR = '11111111-1111-4111-8111-111111111111';
const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

function call(id: string) {
  return GET(
    new Request(`http://localhost/api/platform/accounts/${id}/support-actions`),
    { params: Promise.resolve({ id }) }
  );
}

beforeEach(() => {
  h.user = { id: OPERATOR };
  h.admins = new Set([OPERATOR]);
  h.summary = true;
  h.asked = [];
});

describe('GET /api/platform/accounts/[id]/support-actions', () => {
  it('401s without a session', async () => {
    h.user = null;
    expect((await call(A)).status).toBe(401);
    expect(h.asked).toEqual([]);
  });

  it('403s a company owner who is not a platform operator', async () => {
    h.user = { id: PLAIN_OWNER };
    const res = await call(A);
    expect(res.status).toBe(403);
    expect(h.asked).toEqual([]);
    expect(JSON.stringify(await res.json())).not.toContain('log-of');
  });

  it('404s a malformed id and an account that does not exist', async () => {
    expect((await call('nope')).status).toBe(404);
    h.summary = false;
    expect((await call(A)).status).toBe(404);
    expect(h.asked).toEqual([]);
  });

  it('answers for the account in the URL and no other (A↔B)', async () => {
    const a = await (await call(A)).json();
    const b = await (await call(B)).json();
    expect(a.sessions[0].id).toBe(`log-of-${A}`);
    expect(b.sessions[0].id).toBe(`log-of-${B}`);
    expect(h.asked).toEqual([A, B]);
  });

  it('is never cached by a shared cache', async () => {
    expect((await call(A)).headers.get('cache-control')).toBe(
      'private, no-store'
    );
  });
});
