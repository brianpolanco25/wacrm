// ============================================================
// /api/billing/webhook — PayPal events (Fase 3 §3).
//
// This is the only thing in the product that turns a payment into
// service. The return page of §2 informs; this activates.
//
// THE FOUR PROPERTIES THIS FILE EXISTS TO HOLD
// --------------------------------------------
// 1. **Fail closed on the signature.** PayPal does not sign with HMAC:
//    the five `paypal-transmission-*` headers plus `PAYPAL_WEBHOOK_ID`
//    and the *raw* body go back to PayPal, which answers SUCCESS or
//    FAILURE. `await request.text()` happens before any parsing, because
//    `JSON.parse` + `JSON.stringify` does not round-trip the bytes
//    PayPal signed.
//
// 2. **Idempotence before processing.** The row lands in
//    `billing_events` *first*; `UNIQUE (provider, provider_event_id)`
//    from migration 041 is the lock. A clash means the event was
//    already taken, and the answer is 200 with nothing done. PayPal
//    redelivers aggressively — this is what stops a replay from
//    extending a paid period twice.
//
// 3. **No assumed order.** Every handler reads the row as it is now and
//    decides against it (src/lib/billing/webhook-events.ts). An event
//    older than `subscriptions.last_event_at` may only push the period
//    end forward.
//
// 4. **Every write scoped by account.** This runs with the service-role
//    client, which bypasses RLS. The account is resolved from OUR OWN
//    records — the `checkout_intents` row of §2 or an existing
//    `subscriptions` row, both keyed by the PayPal subscription id —
//    and every subsequent query carries `.eq('account_id', …)`. The
//    `custom_id` PayPal echoes back is used only to *contradict* that
//    resolution, never to pick a tenant.
//
// CP11: nothing here touches the WhatsApp webhook. Inbound messages
// keep being stored whatever a tenant's billing status is.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { verifyPayPalWebhook } from '@/lib/billing/paypal-webhook-signature';
import {
  customIdOf,
  decideSubscriptionChange,
  isHandledEventType,
  parseWebhookEvent,
  providerPlanIdOf,
  subscriptionIdOf,
  type IntentState,
  type PayPalWebhookEvent,
  type SubscriptionPatch,
  type SubscriptionState,
} from '@/lib/billing/webhook-events';
import type { BillingCycle } from '@/lib/billing/paypal';

const PROVIDER = 'paypal';

const SUBSCRIPTION_COLUMNS =
  'account_id, plan_id, status, provider_subscription_id, current_period_end, ' +
  'grace_until, cancel_at_period_end, addons, last_event_at';

const INTENT_COLUMNS = 'account_id, plan_id, cycle, status, provider_plan_id';

interface SubscriptionRow extends SubscriptionState {
  account_id: string;
}

interface IntentRow extends IntentState {
  account_id: string;
  status: string;
  provider_plan_id: string | null;
}

/** What happened to an event, recorded on its `billing_events` row. */
type Outcome =
  | { status: 'processed'; note?: string }
  | { status: 'skipped'; note: string }
  | { status: 'unmatched'; note: string };

/** A database call failed. The lock is released so PayPal can retry. */
class TransientWebhookError extends Error {
  constructor(
    message: string,
    readonly cause?: unknown
  ) {
    super(message);
    this.name = 'TransientWebhookError';
  }
}

export async function POST(request: Request) {
  // The exact bytes PayPal signed, read before anything else touches
  // the request.
  const rawBody = await request.text();

  // Shape first, signature second. The verification call splices these
  // bytes into a JSON document as the value of `webhook_event`
  // (`verifyWebhookSignature` in src/lib/billing/paypal.ts), so proving
  // first that they are one plain JSON object is what stops a crafted
  // body from smuggling a second root-level `webhook_id` past a lenient
  // parser on the other side. The bytes are still forwarded verbatim —
  // JSON.parse + JSON.stringify does not round-trip what PayPal signed.
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }

  if (!(await verifyPayPalWebhook(rawBody, request.headers))) {
    // 401, not 200: a signature that stops matching is a configuration
    // emergency and must show up red on PayPal's delivery dashboard
    // instead of being silently swallowed. Same choice as the Meta
    // webhook.
    console.warn(
      '[billing/webhook] rejected a delivery with no valid signature'
    );
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const event = parseWebhookEvent(payload);
  if (!event) {
    // No `id` means no idempotency key, and without one a redelivery
    // would be processed twice. PayPal always sends one.
    return NextResponse.json(
      { error: 'Not a PayPal webhook event' },
      { status: 400 }
    );
  }

  const admin = supabaseAdmin();

  // ---- Idempotence lock, before any processing -------------------
  const { error: lockError } = await admin.from('billing_events').insert({
    provider: PROVIDER,
    provider_event_id: event.id,
    event_type: event.eventType,
    payload,
  });

  if (lockError) {
    if (lockError.code !== '23505') {
      console.error('[billing/webhook] could not record the event:', lockError);
      // We cannot guarantee idempotence, so we must not process. 500
      // asks PayPal to redeliver.
      return NextResponse.json(
        { error: 'Could not record the event' },
        { status: 500 }
      );
    }

    // Already recorded. If the first attempt FINISHED, applying it
    // again is the one thing we must not do: that is the replay the
    // UNIQUE of migration 041 exists to stop.
    //
    // If it did not finish — an event left `unmatched`, or one that
    // died on an unexpected failure — the row is not a processed event
    // but an entry in the reconciliation queue, and the redelivery (or
    // the "Resend" of docs/docker.md) is precisely the retry that gets
    // it out of there. Reprocessing is safe because every handler
    // decides against the row as it is now and writes absolute values.
    const { data: recorded, error: readError } = await admin
      .from('billing_events')
      .select('processed_at')
      .eq('provider', PROVIDER)
      .eq('provider_event_id', event.id)
      .maybeSingle();

    if (readError) {
      console.error(
        '[billing/webhook] could not read the recorded event:',
        readError
      );
      return NextResponse.json(
        { error: 'Could not record the event' },
        { status: 500 }
      );
    }

    const processedAt =
      (recorded as { processed_at?: string | null } | null)?.processed_at ??
      null;
    if (!recorded || processedAt) {
      return NextResponse.json({ status: 'duplicate' }, { status: 200 });
    }
  }

  try {
    const outcome = await handleEvent(admin, event);
    await finishEvent(admin, event.id, outcome);
    return NextResponse.json(
      {
        status: outcome.status,
        ...(outcome.note ? { note: outcome.note } : {}),
      },
      { status: 200 }
    );
  } catch (err) {
    if (err instanceof TransientWebhookError) {
      console.error('[billing/webhook]', err.message, err.cause);
      // Release the lock so PayPal's redelivery gets a real second
      // attempt. Keeping it would turn a transient database blip into a
      // permanently lost activation: the retry would clash on the
      // UNIQUE and be answered with "already processed".
      //
      // Safe to release: the handler writes one row at a time with
      // absolute values, so replaying it lands on the same state.
      const { error: unlockError } = await admin
        .from('billing_events')
        .delete()
        .eq('provider', PROVIDER)
        .eq('provider_event_id', event.id);

      if (unlockError) {
        console.error(
          '[billing/webhook] could not release the idempotence lock for',
          event.id,
          unlockError
        );
      }
      return NextResponse.json(
        { error: 'Could not process the event' },
        { status: 500 }
      );
    }
    console.error('[billing/webhook] unexpected failure:', err);
    // Leave a trace that can be queried. Without it the row keeps
    // `processed_at IS NULL` *and* `error IS NULL`, which the
    // reconciliation query of docs/docker.md cannot see: a paid
    // activation lost with nothing to look at. `processed_at` stays
    // NULL on purpose — that pair is the queue, and it is also what
    // makes PayPal's redelivery reprocess the event instead of being
    // answered "duplicate".
    await recordFailure(admin, event.id, err);
    return NextResponse.json(
      { error: 'Could not process the event' },
      { status: 500 }
    );
  }
}

// ------------------------------------------------------------
// Processing
// ------------------------------------------------------------

async function handleEvent(
  admin: SupabaseClient,
  event: PayPalWebhookEvent
): Promise<Outcome> {
  if (!isHandledEventType(event.eventType)) {
    // Stored for the audit trail and acknowledged. PayPal subscriptions
    // emit far more than the six events of the spec's table, and a 500
    // for each of them would just make its dashboard useless.
    return { status: 'skipped', note: `unhandled event ${event.eventType}` };
  }

  const subscriptionId = subscriptionIdOf(event);
  if (!subscriptionId) {
    return {
      status: 'unmatched',
      note: 'event carries no PayPal subscription id',
    };
  }

  const resolved = await resolveAccount(admin, event, subscriptionId);
  if ('note' in resolved) return { status: 'unmatched', note: resolved.note };

  const { accountId, subscription, intent } = resolved;

  const decision = decideSubscriptionChange({
    event,
    existing: subscription,
    intent,
    planFromProviderPlanId: await resolvePlanForEvent(admin, event),
    now: new Date(),
  });

  if (decision.kind === 'skip') {
    return { status: 'skipped', note: decision.reason };
  }
  if (decision.kind === 'error') {
    return { status: 'unmatched', note: decision.reason };
  }

  await writeSubscription(
    admin,
    accountId,
    subscription,
    decision.patch,
    intent
  );

  if (decision.intentStatus) {
    await markIntent(admin, accountId, subscriptionId, decision.intentStatus);
  }

  return {
    status: 'processed',
    note: decision.stale ? 'late delivery: only the period moved' : undefined,
  };
}

/**
 * Which tenant this event belongs to, and what that tenant's
 * subscription looks like right now.
 *
 * Resolved from our own rows, never from the event: `subscriptions` and
 * `checkout_intents` both hold the PayPal subscription id under a
 * UNIQUE constraint, so it identifies exactly one account. Those two
 * are the only lookups here that cannot carry an `account_id` filter —
 * they are the lookups that *produce* the account — and they are safe
 * precisely because the key they match on is globally unique, and
 * because they select nothing but the owner. The row we then act on is
 * read back **by `account_id`**, which is also what makes a tenant that
 * is still `trialing` (a `subscriptions` row with no provider id yet)
 * get updated instead of inserted over.
 */
async function resolveAccount(
  admin: SupabaseClient,
  event: PayPalWebhookEvent,
  subscriptionId: string
): Promise<
  | {
      accountId: string;
      subscription: SubscriptionState | null;
      intent: IntentState | null;
    }
  | { note: string }
> {
  const { data: ownerData, error: ownerError } = await admin
    .from('subscriptions')
    .select('account_id')
    .eq('provider', PROVIDER)
    .eq('provider_subscription_id', subscriptionId)
    .maybeSingle();

  if (ownerError) {
    throw new TransientWebhookError('subscription lookup failed', ownerError);
  }

  const { data: intentData, error: intentError } = await admin
    .from('checkout_intents')
    .select(INTENT_COLUMNS)
    .eq('provider', PROVIDER)
    .eq('provider_subscription_id', subscriptionId)
    .maybeSingle();

  if (intentError) {
    throw new TransientWebhookError(
      'checkout intent lookup failed',
      intentError
    );
  }

  const owner = (ownerData as { account_id: string } | null) ?? null;
  const intent = (intentData as IntentRow | null) ?? null;

  if (!owner && !intent) {
    // Nobody here ever asked PayPal for this subscription. It stays in
    // `billing_events` with `processed_at IS NULL` for reconciliation
    // (see the partial index of migration 050) instead of being written
    // anywhere on a guess.
    return {
      note: `no account owns PayPal subscription ${subscriptionId}`,
    };
  }

  if (owner && intent && owner.account_id !== intent.account_id) {
    // Two of our own rows disagree about who owns the money. Writing to
    // either would be a coin flip between two tenants.
    return {
      note: `subscription ${subscriptionId} maps to two accounts (${owner.account_id} / ${intent.account_id})`,
    };
  }

  const accountId = owner?.account_id ?? intent!.account_id;

  const customId = customIdOf(event);
  if (customId && customId !== accountId) {
    // `custom_id` is the account id we sent when creating the
    // subscription. If PayPal echoes back a different one, our records
    // and the provider's disagree; refuse rather than pick a side.
    return {
      note: `custom_id ${customId} does not match the account that owns subscription ${subscriptionId}`,
    };
  }

  // The row we are about to change, read by account. An account that
  // is still `trialing` has a `subscriptions` row with no provider id,
  // which the lookup above cannot see — inserting over it would hit the
  // primary key, and worse, would mean we never recognised the tenant's
  // existing state.
  const { data: subData, error: subError } = await admin
    .from('subscriptions')
    .select(SUBSCRIPTION_COLUMNS)
    .eq('account_id', accountId)
    .maybeSingle();

  if (subError) {
    throw new TransientWebhookError('subscription read failed', subError);
  }

  return {
    accountId,
    subscription: (subData as SubscriptionRow | null) ?? null,
    intent: intent
      ? {
          plan_id: intent.plan_id,
          cycle: cycleOf(intent),
          // Contrasted against the plan the ACTIVATED event carries;
          // migration 048 stores it for exactly that.
          provider_plan_id: intent.provider_plan_id ?? null,
        }
      : null,
  };
}

function cycleOf(intent: IntentRow): BillingCycle {
  return intent.cycle === 'year' ? 'year' : 'month';
}

/**
 * Our plan id for the PayPal plan id an UPDATED event carries.
 *
 * `plans` is the global catalogue (no `account_id`), so this read has
 * no tenant scope to apply — and nothing about it is tenant data.
 */
async function resolvePlanForEvent(
  admin: SupabaseClient,
  event: PayPalWebhookEvent
): Promise<string | null> {
  if (event.eventType !== 'BILLING.SUBSCRIPTION.UPDATED') return null;
  const providerPlanId = providerPlanIdOf(event);
  if (!providerPlanId) return null;

  for (const column of ['provider_plan_id_month', 'provider_plan_id_year']) {
    const { data, error } = await admin
      .from('plans')
      .select('id')
      .eq(column, providerPlanId)
      .maybeSingle();

    if (error) {
      throw new TransientWebhookError('plan catalogue lookup failed', error);
    }
    const id = (data as { id?: unknown } | null)?.id;
    if (typeof id === 'string' && id) return id;
  }
  return null;
}

/** Apply the patch, creating the row when the account has none yet. */
async function writeSubscription(
  admin: SupabaseClient,
  accountId: string,
  existing: SubscriptionState | null,
  patch: SubscriptionPatch,
  intent: IntentState | null
): Promise<void> {
  if (existing) {
    const { error } = await admin
      .from('subscriptions')
      .update(patch)
      // The account resolved from our own records — never from the
      // event. `account_id` is the primary key of `subscriptions`.
      .eq('account_id', accountId);

    if (error) {
      throw new TransientWebhookError('subscription update failed', error);
    }
    return;
  }

  const { error } = await admin.from('subscriptions').insert({
    account_id: accountId,
    provider: PROVIDER,
    // `plan_id` is NOT NULL: the decision layer only reaches here with
    // one, from the checkout intent.
    plan_id: patch.plan_id ?? intent?.plan_id,
    ...patch,
  });

  if (error) {
    throw new TransientWebhookError('subscription insert failed', error);
  }
}

/** Move the checkout attempt out of `pending`, scoped to its account. */
async function markIntent(
  admin: SupabaseClient,
  accountId: string,
  subscriptionId: string,
  status: 'activated' | 'cancelled'
): Promise<void> {
  const { error } = await admin
    .from('checkout_intents')
    .update({ status })
    .eq('account_id', accountId)
    .eq('provider', PROVIDER)
    .eq('provider_subscription_id', subscriptionId);

  if (error) {
    throw new TransientWebhookError('checkout intent update failed', error);
  }
}

/**
 * Why an event blew up, written onto its `billing_events` row.
 *
 * Best effort and never throws: we are already handling a failure, and
 * the reply to PayPal must stay a 500 whatever happens here.
 */
async function recordFailure(
  admin: SupabaseClient,
  eventId: string,
  err: unknown
): Promise<void> {
  const reason =
    err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  try {
    const { error } = await admin
      .from('billing_events')
      .update({
        processed_at: null,
        error: `unexpected failure — ${reason}`.slice(0, 500),
      })
      .eq('provider', PROVIDER)
      .eq('provider_event_id', eventId);

    if (error) {
      console.error(
        '[billing/webhook] could not record the failure of',
        eventId,
        error
      );
    }
  } catch (writeErr) {
    console.error(
      '[billing/webhook] could not record the failure of',
      eventId,
      writeErr
    );
  }
}

/**
 * Close the `billing_events` row.
 *
 * `processed_at` is set for everything we understood, including the
 * events we deliberately did nothing about. An `unmatched` event keeps
 * `processed_at IS NULL` and carries its reason in `error`: that pair
 * is the reconciliation queue the partial index of migration 050
 * serves.
 */
async function finishEvent(
  admin: SupabaseClient,
  eventId: string,
  outcome: Outcome
): Promise<void> {
  const matched = outcome.status !== 'unmatched';
  if (!matched) {
    console.error(
      '[billing/webhook] event',
      eventId,
      'could not be applied:',
      outcome.note
    );
  }

  const { error } = await admin
    .from('billing_events')
    .update({
      processed_at: matched ? new Date().toISOString() : null,
      // `error` holds the reason an event changed nothing. A processed
      // event never writes one, so "processed_at IS NULL AND error IS
      // NOT NULL" is exactly the reconciliation queue.
      error: outcome.status === 'processed' ? null : (outcome.note ?? null),
    })
    .eq('provider', PROVIDER)
    .eq('provider_event_id', eventId);

  if (error) {
    throw new TransientWebhookError('billing event update failed', error);
  }
}
