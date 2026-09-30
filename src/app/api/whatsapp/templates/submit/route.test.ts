import { beforeEach, describe, expect, it, vi } from 'vitest';

// POST /api/whatsapp/templates/submit — the cross-account guard (s9.5).
//
// The local upsert is keyed by the legacy UNIQUE (user_id, name,
// language). Inside a support session `userId` is the OPERATOR, so an
// upsert of a template they also have at home would take THEIR row and
// rewrite it into the customer's account. The route refuses first, before
// anything reaches Meta. (DRY_RUN keeps Meta out of the happy path.)

const h = vi.hoisted(() => ({
  existingElsewhere: [] as { id: string }[],
  lookups: [] as [string, string, unknown][][],
  upserts: [] as { row: Record<string, unknown>; onConflict: string }[],
}));

function fakeClient() {
  return {
    from(table: string) {
      const filters: [string, string, unknown][] = [];
      const builder = {
        select: () => builder,
        eq(col: string, value: unknown) {
          filters.push(['eq', col, value]);
          return builder;
        },
        neq(col: string, value: unknown) {
          filters.push(['neq', col, value]);
          return builder;
        },
        limit() {
          h.lookups.push(filters);
          return Promise.resolve({
            data: table === 'message_templates' ? h.existingElsewhere : [],
            error: null,
          });
        },
        upsert(row: Record<string, unknown>, opts: { onConflict: string }) {
          h.upserts.push({ row, onConflict: opts.onConflict });
          return {
            select: () => ({
              single: async () => ({
                data: { id: 't-1', ...row },
                error: null,
              }),
            }),
          };
        },
      };
      return builder;
    },
  };
}

vi.mock('@/lib/auth/account', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/auth/account')>()),
  requireRole: async () => ({
    supabase: fakeClient(),
    accountId: 'customer-account',
    userId: 'operator-uid',
  }),
}));

const { POST } = await import('./route');

function submit() {
  return POST(
    new Request('http://localhost/api/whatsapp/templates/submit', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: 'order_update',
        category: 'Utility',
        language: 'en_US',
        body_text: 'Your order has shipped.',
      }),
    })
  );
}

beforeEach(() => {
  process.env.WHATSAPP_TEMPLATES_DRY_RUN = 'true';
  h.existingElsewhere = [];
  h.lookups = [];
  h.upserts = [];
});

describe('POST /api/whatsapp/templates/submit', () => {
  it('409s, and upserts nothing, when the same user has this template in another account', async () => {
    h.existingElsewhere = [{ id: 'operators-own-template' }];
    const res = await submit();
    expect(res.status).toBe(409);
    expect(h.upserts).toEqual([]);
    // Looked for it by user, name and language, OUTSIDE the effective account.
    expect(h.lookups[0]).toEqual([
      ['eq', 'user_id', 'operator-uid'],
      ['eq', 'name', 'order_update'],
      ['eq', 'language', 'en_US'],
      ['neq', 'account_id', 'customer-account'],
    ]);
  });

  it('saves into the effective account otherwise', async () => {
    const res = await submit();
    expect(res.status).toBeLessThan(300);
    expect(h.upserts).toHaveLength(1);
    expect(h.upserts[0].row).toMatchObject({ account_id: 'customer-account' });
  });
});
