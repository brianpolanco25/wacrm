// ============================================================
// GET /api/billing/broadcast-estimate — what a broadcast will cost,
// shown on the scheduling step before sending (fase 10, s10.5).
//
//   ?recipients=<n>&whatsappConfigId=<uuid>&category=marketing|utility|authentication
//
//   direct   «{n} destinatarios × tarifa = US$ {x}»: Meta's rate
//            (`rateFor`, s10.2) for the template's category in the
//            market of the sending number.
//   managed  how many fit in what is left of the package of the cycle
//            in progress, how many go to overage and at what price — the
//            account's price, never Meta's rate (internal, as on the
//            statement).
//
// Information only (CP11): a missing rate answers `ratePending: true`,
// never an error, and nothing here guards the send. The confirmation
// when the broadcast generates overage is a dialog on the client.
//
// `agent+` — whoever can send a broadcast — and reachable while
// read-only (a read). Service role for `message_charges`, every query
// filtered by the caller's account (CP3).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  loadRateCard,
  MetaRateMissingError,
  type RateCard,
} from '@/lib/billing/meta-rates';
import { priceFor } from '@/lib/billing/meta-pricing';
import {
  asBroadcastCategory,
  countPackage,
  directBroadcastEstimate,
  loadManagedCycle,
  loadMetaUsageSubscription,
  managedBroadcastEstimate,
  type BroadcastCategory,
} from '@/lib/billing/meta-usage';
import { countryFromPhone } from '@/lib/whatsapp/phone-country';
import { metaBillingOf } from '@/lib/whatsapp/payment-method';

/** Far above any audience; catches a garbage parameter. */
const MAX_RECIPIENTS = 10_000_000;
/** Ids of `whatsapp_config` are UUIDs; anything else is refused early. */
const ID_RE = /^[\w-]{1,64}$/;

function rateOrNull(
  card: RateCard,
  country: string | null,
  category: BroadcastCategory,
  now: Date
): number | null {
  try {
    return card.rateFor(country, category, now).usdPerMessage;
  } catch (err) {
    if (err instanceof MetaRateMissingError) return null;
    throw err;
  }
}

export async function GET(request: Request) {
  try {
    const ctx = await requireRole('agent', { allowReadOnly: true });
    const url = new URL(request.url);

    const rawRecipients = url.searchParams.get('recipients') ?? '';
    const recipients = Number(rawRecipients);
    if (
      !/^\d+$/.test(rawRecipients) ||
      !Number.isSafeInteger(recipients) ||
      recipients > MAX_RECIPIENTS
    ) {
      return NextResponse.json(
        { error: 'recipients must be a whole number' },
        { status: 400 }
      );
    }
    const configId = url.searchParams.get('whatsappConfigId');
    if (configId && !ID_RE.test(configId)) {
      return NextResponse.json(
        { error: 'Invalid whatsappConfigId' },
        { status: 400 }
      );
    }
    const category = asBroadcastCategory(url.searchParams.get('category'));
    const now = new Date();
    const db = supabaseAdmin();

    try {
      // The sending number: the one asked for, if it is this account's;
      // otherwise the account's default, then its oldest.
      let query = db
        .from('whatsapp_config')
        .select('id, display_phone_number')
        .eq('account_id', ctx.accountId);
      query = configId
        ? query.eq('id', configId)
        : query
            .order('is_default', { ascending: false })
            .order('created_at', { ascending: true });
      const { data: number, error: numErr } = await query
        .limit(1)
        .maybeSingle();
      if (numErr) throw new Error(`whatsapp_config: ${numErr.message}`);
      if (configId && !number) {
        return NextResponse.json(
          { error: 'Number not found' },
          { status: 404 }
        );
      }

      const sub = await loadMetaUsageSubscription(db, ctx.accountId);
      const metaBilling = metaBillingOf(
        sub as unknown as Record<string, unknown> | null
      );

      const country = countryFromPhone(
        (number as { display_phone_number?: string | null } | null)
          ?.display_phone_number ?? null
      );

      if (metaBilling === 'managed' && sub) {
        const cycle = await loadManagedCycle(db, ctx.accountId, sub, now);
        const market = cycle.rateCard.marketFor(country);
        if (!cycle.pricing) {
          return NextResponse.json(
            managedBroadcastEstimate({
              recipients,
              category,
              market,
              remaining: 0,
              unitPriceUsd: null,
            })
          );
        }
        const counted = countPackage(
          cycle.charges,
          cycle.pricing,
          cycle.period
        );
        // A fixed price per message needs no rate; a multiplier does.
        const fixed = cycle.pricing.overage[category]?.usd_per_message;
        const rate =
          fixed === undefined
            ? rateOrNull(cycle.rateCard, country, category, now)
            : null;
        const unitPriceUsd =
          fixed === undefined && rate === null
            ? null
            : priceFor(cycle.pricing, category, rate ?? 0);
        return NextResponse.json(
          managedBroadcastEstimate({
            recipients,
            category,
            market,
            remaining: cycle.pricing.included_messages - counted.packageUsed,
            unitPriceUsd,
          })
        );
      }

      const card = await loadRateCard(db);
      return NextResponse.json(
        directBroadcastEstimate({
          recipients,
          category,
          market: card.marketFor(country),
          rateUsd: rateOrNull(card, country, category, now),
        })
      );
    } catch (err) {
      console.error(
        '[broadcast-estimate] GET failed:',
        err instanceof Error ? err.message : err
      );
      return NextResponse.json(
        { error: 'Failed to estimate the broadcast' },
        { status: 500 }
      );
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}
