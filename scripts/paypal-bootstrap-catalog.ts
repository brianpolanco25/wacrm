// ============================================================
// scripts/paypal-bootstrap-catalog.ts — create the PayPal catalogue
// (one product, six billing plans) and store the plan ids in `plans`.
//
// Run once per PayPal environment (sandbox first, live when prices are
// final), with the service-role key:
//
//   node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts
//
// Node 24 executes TypeScript directly (type stripping) — hence the
// explicit `.ts` import extensions and the absence of `@/` aliases.
//
// Idempotent: a plan that already has `provider_plan_id_<cycle>` is
// left alone (PayPal plans are effectively immutable once they have
// subscribers; re-creating them would strand existing customers on the
// old id). The product is looked up by name before it is created.
//
// Env: PAYPAL_CLIENT_ID, PAYPAL_CLIENT_SECRET, PAYPAL_ENV,
//      NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY,
//      PAYPAL_PRODUCT_NAME (optional, default 'wacrm').
// ============================================================

import { createClient } from '@supabase/supabase-js';

import {
  createPlan,
  createProduct,
  listProducts,
  paypalBaseUrl,
  type BillingCycle,
} from '../src/lib/billing/paypal.ts';

interface PlanRow {
  id: string;
  name: string;
  price_usd_month: number | string;
  price_usd_year: number | string | null;
  provider_plan_id_month: string | null;
  provider_plan_id_year: string | null;
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
      'Creating LIVE plans. Prices become contracts once someone subscribes.'
    );
  }

  const db = createClient(supabaseUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: plans, error } = await db
    .from('plans')
    .select(
      'id, name, price_usd_month, price_usd_year, provider_plan_id_month, provider_plan_id_year'
    )
    .order('sort_order', { ascending: true });
  if (error) throw new Error(`plans query failed: ${error.message}`);
  if (!plans || plans.length === 0) {
    throw new Error('plans is empty — apply migration 041 first');
  }

  // Product: reuse by name, create otherwise.
  const existing = (await listProducts()).find((p) => p.name === productName);
  const product =
    existing ??
    (await createProduct(productName, 'CRM for WhatsApp — subscription plans'));
  console.log(
    `${existing ? 'Reusing' : 'Created'} product ${product.id} (${product.name})`
  );

  for (const plan of plans as PlanRow[]) {
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
        console.log(`  ${plan.id}/${cycle}: already ${current}, skipping`);
        continue;
      }
      if (price === null || price === undefined) {
        console.log(`  ${plan.id}/${cycle}: no price, skipping`);
        continue;
      }
      const created = await createPlan({
        productId: product.id,
        name: `${plan.name} (${cycle === 'year' ? 'yearly' : 'monthly'})`,
        description: `wacrm ${plan.name} plan, billed ${cycle === 'year' ? 'yearly' : 'monthly'}`,
        cycle,
        priceUsd: money(price),
        // Stable per env+plan+cycle so a crashed run can be re-run without
        // PayPal minting a second plan for the same request.
        requestId: `wacrm-${env}-${plan.id}-${cycle}-v1`,
      });
      const column =
        cycle === 'year' ? 'provider_plan_id_year' : 'provider_plan_id_month';
      const { error: updErr } = await db
        .from('plans')
        .update({ [column]: created.id })
        .eq('id', plan.id);
      if (updErr)
        throw new Error(
          `plans update failed for ${plan.id}/${cycle}: ${updErr.message}`
        );
      console.log(
        `  ${plan.id}/${cycle}: created ${created.id} (${money(price)} USD)`
      );
    }
  }

  console.log('Done.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
