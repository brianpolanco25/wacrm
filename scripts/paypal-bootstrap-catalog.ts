// ============================================================
// scripts/paypal-bootstrap-catalog.ts — create the PayPal catalogue
// (one product, six billing plans) and store the plan ids in `plans`.
//
// Run against a database dedicated to the selected PayPal environment
// (sandbox first, live when prices are final), with the service-role key:
//
//   node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts
//
// Node 24 executes TypeScript directly (type stripping) — hence the
// explicit `.ts` import extensions and the absence of `@/` aliases.
//
// `plans.provider_plan_id_month` / `_year` hold ids for exactly ONE
// PayPal environment, so sandbox and live need separate databases: see
// "Going from sandbox to live" in docs/docker.md. Never point a live run
// at the sandbox database or the inverse.
//
// Idempotent within one database: a plan that already has
// `provider_plan_id_<cycle>` is left alone. PayPal plans are effectively
// immutable once they have subscribers; re-creating them would strand
// existing customers on the old id. The product is looked up by name over
// the whole (paginated) catalogue, never just its first page.
//
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV,
//      NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      PAYPAL_PRODUCT_NAME (optional, default 'wacrm').
// ============================================================

import { pathToFileURL } from 'node:url';

import { createClient } from '@supabase/supabase-js';

import {
  createPlan,
  createProduct,
  listProducts,
  paypalBaseUrl,
  type BillingCycle,
  type CreatePlanArgs,
  type PayPalProduct,
} from '../src/lib/billing/paypal.ts';

export interface PlanRow {
  id: string;
  name: string;
  price_usd_month: number | string;
  price_usd_year: number | string | null;
  provider_plan_id_month: string | null;
  provider_plan_id_year: string | null;
}

export interface CatalogueStore {
  loadPlans(): Promise<PlanRow[]>;
  savePlanId(
    planId: string,
    cycle: BillingCycle,
    providerPlanId: string
  ): Promise<void>;
}

export interface PayPalCatalogueClient {
  listProducts(): Promise<PayPalProduct[]>;
  createProduct(name: string, description: string): Promise<PayPalProduct>;
  createPlan(args: CreatePlanArgs): Promise<{ id: string }>;
}

export interface BootstrapCatalogOptions {
  store: CatalogueStore;
  paypal: PayPalCatalogueClient;
  productName: string;
  env: 'sandbox' | 'live';
  log?: (message: string) => void;
}

function requireEnv(name: string): string {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(
      `Missing env ${name}. Run with: node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts`
    );
    process.exit(1);
  }
  return v;
}

function money(value: number | string): string {
  return Number(value).toFixed(2);
}

export async function bootstrapCatalog({
  store,
  paypal,
  productName,
  env,
  log = console.log,
}: BootstrapCatalogOptions): Promise<void> {
  const plans = await store.loadPlans();
  if (plans.length === 0) {
    throw new Error('plans is empty — apply migration 041 first');
  }

  // A row that already carries an id belongs to whichever PayPal
  // environment created it, and there is no way to tell sandbox ids from
  // live ones by looking at them. Say so out loud on a live run instead
  // of silently skipping: the usual cause is pointing `PAYPAL_ENV=live`
  // at the sandbox database. Only warn — aborting would make a live run
  // that crashed halfway impossible to resume.
  const populated = plans.filter(
    (plan) => plan.provider_plan_id_month || plan.provider_plan_id_year
  );
  if (env === 'live' && populated.length > 0) {
    log(
      `WARNING: ${populated.length} plan row(s) already hold provider ids ` +
        '(kept as-is). They must be LIVE ids: if this database was ever ' +
        'bootstrapped against the sandbox, it is the wrong database — ' +
        'sandbox and live need separate databases, see docs/docker.md.'
    );
  }

  // Product: reuse by name, create otherwise.
  const existing = (await paypal.listProducts()).find(
    (product) => product.name === productName
  );
  const product =
    existing ??
    (await paypal.createProduct(
      productName,
      'CRM for WhatsApp — subscription plans'
    ));
  log(
    `${existing ? 'Reusing' : 'Created'} product ${product.id} (${product.name})`
  );

  for (const plan of plans) {
    const cycles: {
      cycle: BillingCycle;
      price: number | string | null;
      current: string | null;
    }[] = [
      {
        cycle: 'month',
        price: plan.price_usd_month,
        current: plan.provider_plan_id_month,
      },
      {
        cycle: 'year',
        price: plan.price_usd_year,
        current: plan.provider_plan_id_year,
      },
    ];

    for (const { cycle, price, current } of cycles) {
      if (current) {
        log(`  ${plan.id}/${cycle}: already ${current}, skipping`);
        continue;
      }
      if (price === null || price === undefined) {
        log(`  ${plan.id}/${cycle}: no price, skipping`);
        continue;
      }
      const created = await paypal.createPlan({
        productId: product.id,
        name: `${plan.name} (${cycle === 'year' ? 'yearly' : 'monthly'})`,
        description: `wacrm ${plan.name} plan, billed ${cycle === 'year' ? 'yearly' : 'monthly'}`,
        cycle,
        priceUsd: money(price),
        // Stable per env+plan+cycle so a crashed run can be re-run without
        // PayPal minting a second plan for the same request.
        requestId: `wacrm-${env}-${plan.id}-${cycle}-v1`,
      });
      await store.savePlanId(plan.id, cycle, created.id);
      log(`  ${plan.id}/${cycle}: created ${created.id} (${money(price)} USD)`);
    }
  }
  log('Done.');
}

async function main(): Promise<void> {
  requireEnv('PAYPAL_CLIENT_ID');
  requireEnv('PAYPAL_CLIENT_SECRET');
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const serviceKey = requireEnv('SUPABASE_SERVICE_ROLE_KEY');
  const productName = process.env.PAYPAL_PRODUCT_NAME?.trim() || 'wacrm';
  const env = process.env.PAYPAL_ENV === 'live' ? 'live' : 'sandbox';

  console.log(`PayPal env: ${env} (${paypalBaseUrl()})`);
  if (env === 'live') {
    console.log(
      'Creating LIVE plans in the live database. Prices become contracts once someone subscribes.'
    );
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const store: CatalogueStore = {
    async loadPlans() {
      const { data, error } = await db
        .from('plans')
        .select(
          'id, name, price_usd_month, price_usd_year, provider_plan_id_month, provider_plan_id_year'
        )
        .order('sort_order', { ascending: true });
      if (error) throw new Error(`plans query failed: ${error.message}`);
      return (data ?? []) as PlanRow[];
    },
    async savePlanId(planId, cycle, providerPlanId) {
      const column =
        cycle === 'year' ? 'provider_plan_id_year' : 'provider_plan_id_month';
      const { error } = await db
        .from('plans')
        .update({ [column]: providerPlanId })
        .eq('id', planId);
      if (error) {
        throw new Error(
          `plans update failed for ${planId}/${cycle}: ${error.message}`
        );
      }
    },
  };

  await bootstrapCatalog({
    store,
    paypal: { listProducts, createProduct, createPlan },
    productName,
    env,
  });
}

// Run only when invoked as `node scripts/paypal-bootstrap-catalog.ts`.
// `bootstrapCatalog` is also imported by its test, which must not open a
// Supabase client nor demand PayPal credentials.
const entry = process.argv[1];
if (entry && import.meta.url === pathToFileURL(entry).href) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
