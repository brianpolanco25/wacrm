// The bootstrap flow of `scripts/paypal-bootstrap-catalog.ts`: the script
// exports `bootstrapCatalog` with the catalogue store and the PayPal client
// injected, so the loop that turns the three `plans` rows into six PayPal
// plans is testable without a database or a PayPal account.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  bootstrapCatalog,
  DEFAULT_PRODUCT_NAME,
  type CatalogueStore,
  type PayPalCatalogueClient,
  type PlanRow,
} from '../../../scripts/paypal-bootstrap-catalog.ts';
import {
  __resetPayPalForTests,
  listProducts,
  type BillingCycle,
  type CreatePlanArgs,
  type PayPalProduct,
} from './paypal';

/**
 * The three catalogue rows a migrated database holds, un-bootstrapped:
 * seeded by 041, with Inicio repriced to 35/350 by 059.
 */
const seededPlans = (): PlanRow[] => [
  {
    id: 'inicio',
    name: 'Inicio',
    price_usd_month: 35,
    price_usd_year: 350,
    provider_plan_id_month: null,
    provider_plan_id_year: null,
  },
  {
    id: 'pro',
    name: 'Pro',
    price_usd_month: 79,
    price_usd_year: 790,
    provider_plan_id_month: null,
    provider_plan_id_year: null,
  },
  {
    id: 'negocio',
    name: 'Negocio',
    price_usd_month: 199,
    price_usd_year: 1990,
    provider_plan_id_month: null,
    provider_plan_id_year: null,
  },
];

/** A store backed by the rows themselves, so a save is visible to a re-run. */
function memoryStore(plans: PlanRow[]) {
  const savePlanId = vi.fn(
    async (planId: string, cycle: BillingCycle, providerPlanId: string) => {
      const plan = plans.find((item) => item.id === planId);
      if (!plan) throw new Error(`unknown plan ${planId}`);
      if (cycle === 'month') plan.provider_plan_id_month = providerPlanId;
      else plan.provider_plan_id_year = providerPlanId;
    }
  );
  return {
    loadPlans: async () => plans,
    savePlanId,
  } satisfies CatalogueStore;
}

function fakePayPal(products: PayPalProduct[]) {
  const createProduct = vi.fn(async (name: string): Promise<PayPalProduct> => ({
    id: `PROD-${name}`,
    name,
  }));
  // The plan id PayPal mints is opaque; deriving it from the idempotency
  // key lets the assertions show which request produced which stored id.
  const createPlan = vi.fn(async ({ requestId }: CreatePlanArgs) => ({
    id: `P-${requestId}`,
  }));
  return {
    listProducts: async () => products,
    createProduct,
    createPlan,
  } satisfies PayPalCatalogueClient;
}

const wacrmOnPageTwo: PayPalProduct = {
  id: 'PROD-wacrm-page-2',
  name: 'wacrm',
};

const fetchMock = vi.fn<typeof fetch>();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  __resetPayPalForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  vi.stubEnv('PAYPAL_CLIENT_ID', 'client-id');
  vi.stubEnv('PAYPAL_CLIENT_SECRET', 'client-secret');
  vi.stubEnv('PAYPAL_ENV', 'sandbox');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('bootstrapCatalog', () => {
  it('turns three plan rows into six PayPal plans and stores the six ids', async () => {
    const plans = seededPlans();
    const store = memoryStore(plans);
    const paypal = fakePayPal([{ id: 'PROD-wacrm', name: 'wacrm' }]);

    await bootstrapCatalog({
      store,
      paypal,
      productName: 'wacrm',
      env: 'sandbox',
      log: vi.fn(),
    });

    expect(paypal.createProduct).not.toHaveBeenCalled();
    expect(paypal.createPlan).toHaveBeenCalledTimes(6);
    expect(store.savePlanId).toHaveBeenCalledTimes(6);

    // One product, six plans: three tiers × monthly and yearly, each with
    // its own stable idempotency key and the right interval and price.
    expect(
      paypal.createPlan.mock.calls.map(([args]) => [
        args.productId,
        args.cycle,
        args.priceUsd,
        args.requestId,
      ])
    ).toEqual([
      ['PROD-wacrm', 'month', '35.00', 'wacrm-sandbox-inicio-month-v1'],
      ['PROD-wacrm', 'year', '350.00', 'wacrm-sandbox-inicio-year-v1'],
      ['PROD-wacrm', 'month', '79.00', 'wacrm-sandbox-pro-month-v1'],
      ['PROD-wacrm', 'year', '790.00', 'wacrm-sandbox-pro-year-v1'],
      ['PROD-wacrm', 'month', '199.00', 'wacrm-sandbox-negocio-month-v1'],
      ['PROD-wacrm', 'year', '1990.00', 'wacrm-sandbox-negocio-year-v1'],
    ]);

    // …and the six ids land in the two `plans` columns.
    expect(
      plans.map((plan) => [
        plan.id,
        plan.provider_plan_id_month,
        plan.provider_plan_id_year,
      ])
    ).toEqual([
      [
        'inicio',
        'P-wacrm-sandbox-inicio-month-v1',
        'P-wacrm-sandbox-inicio-year-v1',
      ],
      ['pro', 'P-wacrm-sandbox-pro-month-v1', 'P-wacrm-sandbox-pro-year-v1'],
      [
        'negocio',
        'P-wacrm-sandbox-negocio-month-v1',
        'P-wacrm-sandbox-negocio-year-v1',
      ],
    ]);
  });

  it('creates and updates nothing on a second execution', async () => {
    const plans = seededPlans();
    const store = memoryStore(plans);
    const paypal = fakePayPal([{ id: 'PROD-wacrm', name: 'wacrm' }]);
    const options = {
      store,
      paypal,
      productName: 'wacrm',
      env: 'sandbox' as const,
    };

    await bootstrapCatalog({ ...options, log: vi.fn() });
    const afterFirstRun = structuredClone(plans);

    const log = vi.fn();
    await bootstrapCatalog({ ...options, log });

    expect(paypal.createProduct).not.toHaveBeenCalled();
    expect(paypal.createPlan).toHaveBeenCalledTimes(6); // still the first six
    expect(store.savePlanId).toHaveBeenCalledTimes(6);
    expect(plans).toEqual(afterFirstRun);
    expect(
      log.mock.calls.filter(([message]) => String(message).includes('skipping'))
    ).toHaveLength(6);
  });

  it('reuses a product that lives past the first page of the catalogue', async () => {
    // 20 products PayPal returns on page 1, wacrm alone on page 2.
    const firstPage = Array.from({ length: 20 }, (_, index) => ({
      id: `PROD-other-${index}`,
      name: `other-${index}`,
    }));
    fetchMock.mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes('/v1/oauth2/token')) {
        return jsonResponse({ access_token: 'tok', expires_in: 3600 });
      }
      return jsonResponse({
        products: url.includes('page=1') ? firstPage : [wacrmOnPageTwo],
      });
    });

    const plans = seededPlans();
    const store = memoryStore(plans);
    const paypal = fakePayPal([]);

    await bootstrapCatalog({
      store,
      // The real, paginating client — only the writes stay faked.
      paypal: { ...paypal, listProducts },
      productName: 'wacrm',
      env: 'sandbox',
      log: vi.fn(),
    });

    expect(paypal.createProduct).not.toHaveBeenCalled();
    expect(
      new Set(paypal.createPlan.mock.calls.map(([args]) => args.productId))
    ).toEqual(new Set(['PROD-wacrm-page-2']));
  });

  it('warns on a live run when the database already holds provider ids', async () => {
    const plans = seededPlans();
    plans[0].provider_plan_id_month = 'P-SANDBOX-LEFTOVER';
    const store = memoryStore(plans);
    const paypal = fakePayPal([{ id: 'PROD-wacrm', name: 'wacrm' }]);
    const log = vi.fn();

    await bootstrapCatalog({
      store,
      paypal,
      productName: 'wacrm',
      env: 'live',
      log,
    });

    expect(
      log.mock.calls.filter(([message]) =>
        String(message).startsWith('WARNING:')
      )
    ).toHaveLength(1);
    // The stored id is never overwritten — a live plan with subscribers
    // must keep the id they subscribed to.
    expect(plans[0].provider_plan_id_month).toBe('P-SANDBOX-LEFTOVER');
    expect(paypal.createPlan).toHaveBeenCalledTimes(5);
  });
});

// Fase 6, §1: PayPal is the one place the product name leaves the app and
// lands on something the subscriber keeps — the agreement page and every
// receipt. Both strings below are read by a paying customer, so they carry
// the visible brand. The `requestId` prefix deliberately does not: it is an
// idempotency key, and changing it would make PayPal mint a second plan for
// a tier that already has subscribers.
describe('brand on the PayPal catalogue', () => {
  it('defaults the product name to the visible brand', () => {
    expect(DEFAULT_PRODUCT_NAME).toBe('Cabbity CRM');
  });

  it('names the brand in every plan description', async () => {
    const store = memoryStore(seededPlans());
    const paypal = fakePayPal([{ id: 'PROD-1', name: DEFAULT_PRODUCT_NAME }]);

    await bootstrapCatalog({
      store,
      paypal,
      productName: DEFAULT_PRODUCT_NAME,
      env: 'sandbox',
      log: vi.fn(),
    });

    const descriptions = paypal.createPlan.mock.calls.map(
      ([args]) => args.description
    );
    expect(descriptions).toHaveLength(6);
    for (const description of descriptions) {
      expect(description).toContain('Cabbity CRM');
      expect(description).not.toMatch(/wa\s?crm/i);
    }
  });

  it('keeps the idempotency keys on their original prefix', async () => {
    const store = memoryStore(seededPlans());
    const paypal = fakePayPal([{ id: 'PROD-1', name: DEFAULT_PRODUCT_NAME }]);

    await bootstrapCatalog({
      store,
      paypal,
      productName: DEFAULT_PRODUCT_NAME,
      env: 'sandbox',
      log: vi.fn(),
    });

    expect(paypal.createPlan.mock.calls[0][0].requestId).toBe(
      'wacrm-sandbox-inicio-month-v1'
    );
  });
});
