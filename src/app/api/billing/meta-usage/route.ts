// ============================================================
// GET /api/billing/meta-usage — Meta consumption, live (fase 10, s10.5).
//
//   managed  «Consumo del ciclo»: package used over the included
//            messages, overage by category and the estimate at the
//            cut-off, from `buildStatement` over the cycle in progress.
//            A missing rate answers `state: 'rate_pending'` with the
//            package still counted: it never fails the panel.
//   direct   Meta's free service quota per number — the SAME count as
//            `/api/whatsapp/service-cap` (`loadServiceUsage` +
//            `serviceCapState`, p11.3) with its percentage and the
//            80/100 % alert — and what Meta will charge this month
//            (only `billable` deliveries, at Meta's rate, no multiplier).
//
// `admin+` like the rest of the money of `/api/billing/*`, reachable
// while read-only (`allowReadOnly`): it is a read, and seeing what is
// owed is part of the way out of the lock.
//
// Every read runs with the service role (`message_charges` and
// `service_quota_usage` are admin-only / service-only) and carries the
// caller's `account_id` by hand (CP3). Never calls Meta.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { loadRateCard, MetaRateMissingError } from '@/lib/billing/meta-rates';
import {
  directMetaCost,
  freeTierAlert,
  loadBillableCharges,
  loadManagedCycle,
  loadMetaUsageSubscription,
  managedUsageOf,
  percentOf,
  type DirectMetaCost,
} from '@/lib/billing/meta-usage';
import {
  SERVICE_FREE_TIER_PER_NUMBER,
  loadServiceUsage,
  serviceCapState,
  serviceMonthWindow,
} from '@/lib/billing/service-cap';
import { metaBillingOf } from '@/lib/whatsapp/payment-method';

const LOAD_FAILED = 'Failed to load the Meta usage';

export async function GET() {
  try {
    const ctx = await requireRole('admin', { allowReadOnly: true });
    const now = new Date();
    const db = supabaseAdmin();

    try {
      const sub = await loadMetaUsageSubscription(db, ctx.accountId);
      const metaBilling = metaBillingOf(
        sub as unknown as Record<string, unknown> | null
      );

      if (metaBilling === 'managed' && sub) {
        const cycle = await loadManagedCycle(db, ctx.accountId, sub, now);
        return NextResponse.json(managedUsageOf(ctx.accountId, cycle));
      }

      const { monthStart, resetsAt } = serviceMonthWindow(now);
      const { data: rows, error: cfgErr } = await db
        .from('whatsapp_config')
        .select('id, label, display_phone_number, is_default, created_at')
        .eq('account_id', ctx.accountId)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true });
      if (cfgErr) throw new Error(`whatsapp_config: ${cfgErr.message}`);
      const numbers = (rows ?? []) as Array<{
        id: string;
        label: string | null;
        display_phone_number: string | null;
      }>;

      const usage =
        numbers.length > 0
          ? await loadServiceUsage(db, ctx.accountId, now)
          : new Map();

      let metaCost: DirectMetaCost | null = null;
      let missingRate: { market: string; category: string } | null = null;
      if (numbers.length > 0) {
        const [charges, rateCard] = await Promise.all([
          loadBillableCharges(
            db,
            ctx.accountId,
            monthStart.toISOString(),
            resetsAt.toISOString()
          ),
          loadRateCard(db),
        ]);
        try {
          metaCost = directMetaCost(
            charges,
            rateCard,
            monthStart.toISOString(),
            resetsAt.toISOString()
          );
        } catch (err) {
          if (!(err instanceof MetaRateMissingError)) throw err;
          missingRate = { market: err.market, category: err.category };
        }
      } else {
        metaCost = { totalUsd: 0, byCategory: [] };
      }

      return NextResponse.json({
        metaBilling: 'direct',
        state: missingRate ? 'rate_pending' : 'ok',
        freeTier: SERVICE_FREE_TIER_PER_NUMBER,
        monthStart: monthStart.toISOString(),
        resetsAt: resetsAt.toISOString(),
        numbers: numbers.map((n) => {
          const state = serviceCapState(usage.get(n.id));
          return {
            id: n.id,
            label: n.label ?? null,
            displayPhoneNumber: n.display_phone_number ?? null,
            used: state.used,
            exhausted: state.exhausted,
            percent: state.exhausted
              ? 100
              : percentOf(state.used, SERVICE_FREE_TIER_PER_NUMBER),
            alert: freeTierAlert(state),
          };
        }),
        metaCost,
        missingRate,
      });
    } catch (err) {
      console.error(
        '[meta-usage] GET failed:',
        err instanceof Error ? err.message : err
      );
      return NextResponse.json({ error: LOAD_FAILED }, { status: 500 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
