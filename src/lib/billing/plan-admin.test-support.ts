/**
 * Test support for the plan-admin routes and the PayPal sync (s9.3).
 * Only `*.test.ts` files import it.
 *
 *   - `seedPlanTables()`: the catalogue as a migrated database holds it
 *     (041 + 059 + 065 + 070 columns), for `FakeDatabase`.
 *   - `paypalFake()`: a global `fetch` that answers like PayPal's REST
 *     API for the calls the sync makes (token, product list/create, plan
 *     create/read), recording every request — same approach as
 *     `paypal.test.ts`, which asserts on what PayPal would have received.
 */

import type { Row, Tables } from '@/lib/security/fake-supabase';

export const OPERATOR = '11111111-1111-4111-8111-111111111111';
export const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';

export const FULL_LIMITS = {
  operators: 10,
  contacts: 10000,
  messages_out: 15000,
  ai_replies: 3000,
  broadcast_recipients: 10000,
  knowledge_documents: 50,
  numbers: 1,
  retention_months: 24,
};

function plan(overrides: Row): Row {
  return {
    name: 'Plan',
    description: null,
    price_usd_month: 35,
    price_usd_year: 350,
    limits: { ...FULL_LIMITS },
    features: ['ai_autoreply'],
    is_public: true,
    sort_order: 1,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
    provider_plan_id_month: null,
    provider_plan_id_year: null,
    ...overrides,
  };
}

export function seedPlanTables(): Tables {
  return {
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    plans: [
      plan({ id: 'inicio', name: 'Inicio', sort_order: 1 }),
      plan({
        id: 'pro',
        name: 'Pro',
        price_usd_month: 100,
        price_usd_year: 1000,
        sort_order: 2,
        features: ['ai_autoreply', 'api', 'webhooks'],
      }),
      plan({
        id: 'oculto',
        name: 'Oculto',
        price_usd_month: 0,
        price_usd_year: null,
        is_public: false,
        sort_order: 99,
      }),
    ],
    plan_provider_history: [],
  };
}

export interface PayPalRequest {
  method: string;
  path: string;
  body: unknown;
  headers: Record<string, string>;
}

export interface PayPalFakeOptions {
  products?: { id: string; name: string }[];
  /**
   * What `GET /v1/billing/plans/:id` answers, by id: a REGULAR cycle with
   * this interval and USD price, and this `status` (default ACTIVE). Leave
   * `unit` or `value` out to drop `interval_unit` / `pricing_scheme`, or
   * give `raw` to answer that body verbatim.
   */
  remotePlans?: Record<
    string,
    { unit?: 'MONTH' | 'YEAR'; value?: string; status?: string; raw?: unknown }
  >;
  /** Force an HTTP status on plan creation. */
  createPlanStatus?: number;
}

export function paypalFake(options: PayPalFakeOptions = {}) {
  const requests: PayPalRequest[] = [];
  const products = [...(options.products ?? [])];
  let minted = 0;

  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const fetchImpl = async (
    input: string | URL | Request,
    init: RequestInit = {}
  ): Promise<Response> => {
    const url = new URL(String(input));
    const method = init.method ?? 'GET';
    const headers = (init.headers ?? {}) as Record<string, string>;
    let body: unknown = init.body ?? null;
    if (typeof body === 'string' && body.startsWith('{')) {
      body = JSON.parse(body);
    }
    requests.push({ method, path: url.pathname, body, headers });

    if (url.pathname === '/v1/oauth2/token') {
      return json({ access_token: 'tok', expires_in: 3600 });
    }
    if (url.pathname === '/v1/catalogs/products' && method === 'GET') {
      return json({ products });
    }
    if (url.pathname === '/v1/catalogs/products' && method === 'POST') {
      const created = {
        id: `PROD-${products.length + 1}`,
        name: (body as { name: string }).name,
      };
      products.push(created);
      return json(created, 201);
    }
    if (url.pathname === '/v1/billing/plans' && method === 'POST') {
      if (options.createPlanStatus) {
        return json({ name: 'UNPROCESSABLE' }, options.createPlanStatus);
      }
      minted += 1;
      return json({ id: `P-NEW-${minted}`, status: 'ACTIVE' }, 201);
    }
    const planMatch = /^\/v1\/billing\/plans\/([^/]+)$/.exec(url.pathname);
    if (planMatch && method === 'GET') {
      const remote = options.remotePlans?.[decodeURIComponent(planMatch[1])];
      if (!remote) return json({ name: 'RESOURCE_NOT_FOUND' }, 404);
      if (remote.raw !== undefined) return json(remote.raw);
      return json({
        id: planMatch[1],
        status: remote.status ?? 'ACTIVE',
        billing_cycles: [
          {
            tenure_type: 'REGULAR',
            sequence: 1,
            frequency: remote.unit
              ? { interval_unit: remote.unit, interval_count: 1 }
              : { interval_count: 1 },
            ...(remote.value
              ? {
                  pricing_scheme: {
                    fixed_price: { value: remote.value, currency_code: 'USD' },
                  },
                }
              : {}),
          },
        ],
      });
    }
    return json({ name: 'NOT_MOCKED', path: url.pathname }, 500);
  };

  return {
    fetch: fetchImpl,
    requests,
    /** Requests other than the OAuth token exchange. */
    apiCalls: () =>
      requests
        .filter((r) => r.path !== '/v1/oauth2/token')
        .map((r) => `${r.method} ${r.path}`),
  };
}
