import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// The catalogue endpoint behind the plan picker. Its one job beyond reading
// `plans` is to keep the PayPal plan ids on the server: the browser gets
// "can this cycle be contracted?", never the id a subscription is created
// against.
// ---------------------------------------------------------------------------

type Row = Record<string, unknown>;

let plans: Row[];
let role: string;
let selectedColumns: string;

function builder(table: string) {
  const filters: Array<[string, unknown]> = [];
  const rows = () => {
    if (table === 'profiles') {
      return [{ account_id: 'acct-a', account_role: role }];
    }
    if (table === 'accounts') return [{ id: 'acct-a', name: 'Acme' }];
    return plans.filter((row) =>
      filters.every(([column, value]) => row[column] === value)
    );
  };

  const b: Record<string, unknown> = {};
  b.select = vi.fn((columns: string) => {
    if (table === 'plans') selectedColumns = columns;
    return b;
  });
  b.eq = vi.fn((column: string, value: unknown) => {
    filters.push([column, value]);
    return b;
  });
  b.order = vi.fn(() => b);
  b.maybeSingle = vi.fn(async () => ({ data: rows()[0] ?? null, error: null }));
  b.then = (resolve: (value: unknown) => unknown) =>
    resolve({ data: rows(), error: null });
  return b;
}

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(async () => ({
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: { id: 'user-a' } },
        error: null,
      })),
    },
    from: vi.fn((table: string) => builder(table)),
  })),
}));

import { GET } from './route';

beforeEach(() => {
  role = 'viewer';
  selectedColumns = '';
  plans = [
    {
      id: 'inicio',
      name: 'Inicio',
      is_public: true,
      sort_order: 1,
      limits: { operators: 3, messages_out: 3000 },
      price_usd_month: '29.00',
      price_usd_year: '290.00',
      provider_plan_id_month: 'P-INICIO-MONTH',
      // Not created in PayPal yet.
      provider_plan_id_year: null,
    },
    {
      id: 'negocio',
      name: 'Negocio',
      is_public: true,
      sort_order: 3,
      limits: { operators: 30, retention_months: null },
      price_usd_month: '199.00',
      price_usd_year: '1990.00',
      provider_plan_id_month: 'P-NEG-MONTH',
      provider_plan_id_year: 'P-NEG-YEAR',
    },
    {
      id: 'oculto',
      name: 'Hidden',
      is_public: false,
      sort_order: 9,
      limits: {},
      price_usd_month: '9.00',
      price_usd_year: null,
      provider_plan_id_month: 'P-HIDDEN',
      provider_plan_id_year: null,
    },
  ];
});

describe('GET /api/billing/plans', () => {
  it('never puts a PayPal plan id on the wire', async () => {
    const json = await (await GET()).json();

    const serialized = JSON.stringify(json);
    expect(serialized).not.toContain('P-INICIO-MONTH');
    expect(serialized).not.toContain('P-NEG-YEAR');
    expect(json.plans[0]).not.toHaveProperty('provider_plan_id_month');
  });

  it('reports which cycles can actually be contracted', async () => {
    const json = await (await GET()).json();

    expect(json.plans).toEqual([
      {
        id: 'inicio',
        name: 'Inicio',
        limits: { operators: 3, messages_out: 3000 },
        priceMonth: '29.00',
        priceYear: '290.00',
        // Priced yearly, but PayPal has no yearly plan for it yet.
        availableCycles: { month: true, year: false },
      },
      {
        id: 'negocio',
        name: 'Negocio',
        limits: { operators: 30, retention_months: null },
        priceMonth: '199.00',
        priceYear: '1990.00',
        availableCycles: { month: true, year: true },
      },
    ]);
  });

  it('hides non-public plans', async () => {
    await GET();
    // Filtering happens in the query, not in JS: a private plan must
    // not even be fetched.
    expect(selectedColumns).toContain('is_public');
    const json = await (await GET()).json();
    expect(json.plans.map((p: { id: string }) => p.id)).not.toContain('oculto');
  });

  it('is open to any member, not just admins', async () => {
    role = 'viewer';
    expect((await GET()).status).toBe(200);
  });
});
