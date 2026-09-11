import { describe, expect, it } from 'vitest';

// The coherence rules of Fase 3 §3, tested without a database or a
// PayPal sandbox. The spec's demand — "cada manejador comprueba
// coherencia antes de escribir en vez de asumir secuencia" — is what
// most of this file asserts: events arrive out of order, and a late one
// must never undo a newer one.

import {
  addCycle,
  addDays,
  customIdOf,
  decideSubscriptionChange,
  GRACE_DAYS,
  HANDLED_EVENT_TYPES,
  isHandledEventType,
  laterIso,
  nextBillingTimeOf,
  parseWebhookEvent,
  providerPlanIdOf,
  subscriptionIdOf,
  type Decision,
  type IntentState,
  type PayPalWebhookEvent,
  type SubscriptionState,
} from './webhook-events';

const NOW = new Date('2026-03-15T12:00:00.000Z');

function event(
  eventType: string,
  resource: Record<string, unknown> = {},
  createTime = '2026-03-15T12:00:00Z'
): PayPalWebhookEvent {
  // Normalised exactly as `parseWebhookEvent` would hand it over.
  return {
    id: 'WH-1',
    eventType,
    createTime: new Date(createTime).toISOString(),
    resource,
  };
}

function subscription(
  overrides: Partial<SubscriptionState> = {}
): SubscriptionState {
  return {
    plan_id: 'pro',
    status: 'active',
    provider_subscription_id: 'I-SUB',
    current_period_end: '2026-04-15T12:00:00.000Z',
    grace_until: null,
    cancel_at_period_end: false,
    addons: null,
    last_event_at: '2026-03-15T12:00:00.000Z',
    ...overrides,
  };
}

const INTENT: IntentState = { plan_id: 'pro', cycle: 'month' };

function decide(
  e: PayPalWebhookEvent,
  existing: SubscriptionState | null,
  intent: IntentState | null = INTENT,
  planFromProviderPlanId: string | null = null
): Decision {
  return decideSubscriptionChange({
    event: e,
    existing,
    intent,
    planFromProviderPlanId,
    now: NOW,
  });
}

function applied(decision: Decision) {
  if (decision.kind !== 'apply') {
    throw new Error(`expected apply, got ${decision.kind}: ${decision.reason}`);
  }
  return decision;
}

// ---------------------------------------------------------------------------
describe('parseWebhookEvent', () => {
  it('reads the envelope of a real PayPal delivery', () => {
    const parsed = parseWebhookEvent({
      id: 'WH-7',
      event_type: 'BILLING.SUBSCRIPTION.ACTIVATED',
      create_time: '2026-03-15T12:00:00Z',
      resource: { id: 'I-SUB', custom_id: 'acct-a' },
    });

    expect(parsed).toEqual({
      id: 'WH-7',
      eventType: 'BILLING.SUBSCRIPTION.ACTIVATED',
      createTime: '2026-03-15T12:00:00.000Z',
      resource: { id: 'I-SUB', custom_id: 'acct-a' },
    });
  });

  it('refuses a body with no event id — there would be no idempotency key', () => {
    expect(parseWebhookEvent({ event_type: 'X' })).toBeNull();
    expect(parseWebhookEvent({ id: '  ', event_type: 'X' })).toBeNull();
    expect(parseWebhookEvent({ id: 'WH-1' })).toBeNull();
    expect(parseWebhookEvent(null)).toBeNull();
    expect(parseWebhookEvent([{ id: 'WH-1', event_type: 'X' }])).toBeNull();
    expect(parseWebhookEvent('WH-1')).toBeNull();
  });

  it('tolerates a missing or non-object resource and a bad create_time', () => {
    const parsed = parseWebhookEvent({
      id: 'WH-7',
      event_type: 'X',
      create_time: 'not a date',
      resource: 'nope',
    });
    expect(parsed).toMatchObject({ resource: {}, createTime: null });
  });
});

describe('event field readers', () => {
  it('takes the subscription id from the resource, and from billing_agreement_id for a sale', () => {
    expect(
      subscriptionIdOf(event('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-A' }))
    ).toBe('I-A');
    expect(
      subscriptionIdOf(
        event('PAYMENT.SALE.COMPLETED', {
          id: 'SALE-1',
          billing_agreement_id: 'I-A',
        })
      )
    ).toBe('I-A');
    // A sale that is not part of a subscription has no link to a tenant.
    expect(subscriptionIdOf(event('PAYMENT.SALE.COMPLETED', { id: 'S' }))).toBe(
      null
    );
  });

  it('reads custom_id, plan_id and billing_info.next_billing_time', () => {
    const e = event('BILLING.SUBSCRIPTION.UPDATED', {
      custom_id: 'acct-a',
      plan_id: 'P-PRO-MONTH',
      billing_info: { next_billing_time: '2026-05-01T00:00:00Z' },
    });
    expect(customIdOf(e)).toBe('acct-a');
    expect(providerPlanIdOf(e)).toBe('P-PRO-MONTH');
    expect(nextBillingTimeOf(e)).toBe('2026-05-01T00:00:00.000Z');
    expect(nextBillingTimeOf(event('X', {}))).toBeNull();
  });

  it('knows exactly the six event types of the spec', () => {
    expect(HANDLED_EVENT_TYPES).toHaveLength(6);
    expect(isHandledEventType('BILLING.SUBSCRIPTION.ACTIVATED')).toBe(true);
    expect(isHandledEventType('BILLING.SUBSCRIPTION.RE-ACTIVATED')).toBe(false);
    expect(isHandledEventType('PAYMENT.SALE.REFUNDED')).toBe(false);
  });
});

describe('date helpers', () => {
  it('adds a month without rolling over the end of the month', () => {
    // A naive setUTCMonth(+1) turns 31 Jan into 3 March.
    expect(addCycle('2026-01-31T10:00:00.000Z', 'month')).toBe(
      '2026-02-28T10:00:00.000Z'
    );
    expect(addCycle('2026-03-31T10:00:00.000Z', 'month')).toBe(
      '2026-04-30T10:00:00.000Z'
    );
    expect(addCycle('2026-03-15T10:00:00.000Z', 'month')).toBe(
      '2026-04-15T10:00:00.000Z'
    );
    expect(addCycle('2026-03-15T10:00:00.000Z', 'year')).toBe(
      '2027-03-15T10:00:00.000Z'
    );
    expect(addCycle('2024-02-29T10:00:00.000Z', 'year')).toBe(
      '2025-02-28T10:00:00.000Z'
    );
  });

  it('adds days and picks the later timestamp', () => {
    expect(addDays('2026-03-15T12:00:00.000Z', 7)).toBe(
      '2026-03-22T12:00:00.000Z'
    );
    expect(laterIso('2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')).toBe(
      '2026-02-01T00:00:00Z'
    );
    expect(laterIso(null, '2026-02-01T00:00:00Z')).toBe('2026-02-01T00:00:00Z');
    expect(laterIso(undefined, null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
describe('BILLING.SUBSCRIPTION.ACTIVATED', () => {
  const activated = (overrides: Record<string, unknown> = {}, time?: string) =>
    event(
      'BILLING.SUBSCRIPTION.ACTIVATED',
      {
        id: 'I-SUB',
        status: 'ACTIVE',
        billing_info: { next_billing_time: '2026-04-15T12:00:00Z' },
        ...overrides,
      },
      time
    );

  it('turns the plan on and fixes the end of the period', () => {
    const decision = applied(decide(activated(), null));

    expect(decision.patch).toEqual({
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-SUB',
      current_period_end: '2026-04-15T12:00:00.000Z',
      grace_until: null,
      cancel_at_period_end: false,
      // Migración 056: the cycle we are being charged on, recorded
      // where a later renewal can still find it after a plan change.
      cycle: 'month',
      last_event_at: '2026-03-15T12:00:00.000Z',
    });
    expect(decision.intentStatus).toBe('activated');
  });

  it('derives the period from the intent cycle when PayPal sends no next_billing_time', () => {
    const decision = applied(
      decide(activated({ billing_info: undefined }), null, {
        plan_id: 'negocio',
        cycle: 'year',
      })
    );
    expect(decision.patch.current_period_end).toBe('2027-03-15T12:00:00.000Z');
    expect(decision.patch.plan_id).toBe('negocio');
  });

  it('clears a grace window and a pending cancellation', () => {
    const decision = applied(
      decide(
        activated(),
        subscription({
          status: 'past_due',
          grace_until: '2026-03-20T00:00:00.000Z',
          cancel_at_period_end: true,
          last_event_at: '2026-03-01T00:00:00.000Z',
        })
      )
    );
    expect(decision.patch).toMatchObject({
      status: 'active',
      grace_until: null,
      cancel_at_period_end: false,
    });
  });

  it('refuses to guess the plan when no intent was ever recorded', () => {
    const decision = decide(activated(), null, null);
    expect(decision.kind).toBe('error');
  });

  it('does not rewrite a LIVE account that is on a different PayPal subscription', () => {
    const decision = decide(
      activated({ id: 'I-OTHER' }),
      subscription({ provider_subscription_id: 'I-SUB' })
    );
    expect(decision).toMatchObject({ kind: 'error' });
  });

  // §2 lets a cancelled account contract again and nothing clears the
  // old provider id. Refusing the new subscription's activation would
  // mean the customer pays and never gets service.
  it('takes over the row left by the subscription the customer cancelled', () => {
    const decision = applied(
      decide(
        activated(),
        subscription({
          provider_subscription_id: 'I-OLD',
          status: 'cancelled',
          cancel_at_period_end: true,
          grace_until: '2026-02-20T00:00:00.000Z',
          current_period_end: '2026-02-01T00:00:00.000Z',
          last_event_at: '2026-02-20T00:00:00.000Z',
        })
      )
    );

    expect(decision.stale).toBe(false);
    expect(decision.patch).toMatchObject({
      status: 'active',
      provider_subscription_id: 'I-SUB',
      current_period_end: '2026-04-15T12:00:00.000Z',
      cancel_at_period_end: false,
      grace_until: null,
    });
    expect(decision.intentStatus).toBe('activated');
  });

  it('refuses to take a row over with no checkout intent of ours behind it', () => {
    const decision = decide(
      activated(),
      subscription({
        provider_subscription_id: 'I-OLD',
        status: 'cancelled',
      }),
      null
    );
    expect(decision).toMatchObject({ kind: 'error' });
  });

  it('will not take over a row whose subscription is still alive', () => {
    // Same shape as re-contracting, but the previous subscription is
    // `past_due`, not terminal: that is a live row and another
    // subscription's activation may not have it.
    const decision = decide(
      activated(),
      subscription({ provider_subscription_id: 'I-OLD', status: 'past_due' })
    );
    expect(decision).toMatchObject({ kind: 'error' });
  });

  it('does not lift a cancelled subscription back with its own activation', () => {
    // The end of the line does not depend on the watermark, which is
    // NULL for every row that predates migration 050.
    const decision = decide(
      activated(),
      subscription({
        status: 'cancelled',
        cancel_at_period_end: true,
        last_event_at: null,
      })
    );
    expect(decision).toMatchObject({ kind: 'skip' });
    if (decision.kind === 'skip') {
      expect(decision.reason).toContain('already cancelled');
    }
  });

  it('refuses an activation of a plan the intent never asked for', () => {
    const decision = decide(activated({ plan_id: 'P-NEGOCIO-YEAR' }), null, {
      plan_id: 'pro',
      cycle: 'month',
      provider_plan_id: 'P-PRO-MONTH',
    });
    expect(decision).toMatchObject({ kind: 'error' });
    if (decision.kind === 'error') {
      expect(decision.reason).toContain('P-NEGOCIO-YEAR');
    }
  });

  it('activates when the activated plan is the one the intent asked for', () => {
    const decision = applied(
      decide(activated({ plan_id: 'P-PRO-MONTH' }), null, {
        plan_id: 'pro',
        cycle: 'month',
        provider_plan_id: 'P-PRO-MONTH',
      })
    );
    expect(decision.patch.status).toBe('active');
  });

  it('adopts the trialing row of an account that had no provider subscription yet', () => {
    const decision = applied(
      decide(
        activated(),
        subscription({
          status: 'trialing',
          provider_subscription_id: null,
          current_period_end: null,
          last_event_at: null,
        })
      )
    );
    expect(decision.patch.provider_subscription_id).toBe('I-SUB');
    expect(decision.patch.status).toBe('active');
  });

  // THE out-of-order case of the spec.
  it('cannot resurrect a subscription cancelled by a newer event', () => {
    const decision = decide(
      activated({}, '2026-03-01T00:00:00Z'),
      subscription({
        status: 'cancelled',
        current_period_end: '2026-03-10T00:00:00.000Z',
        last_event_at: '2026-03-10T00:00:00.000Z',
      })
    );

    // Late delivery: only the period end may move, and only forward.
    const late = applied(decision);
    expect(late.stale).toBe(true);
    expect(late.patch).toEqual({
      current_period_end: '2026-04-15T12:00:00.000Z',
    });
    expect(late.patch.status).toBeUndefined();
    expect(late.intentStatus).toBeNull();
  });

  it('does nothing at all when a late delivery would also rewind the period', () => {
    const decision = decide(
      activated(
        { billing_info: { next_billing_time: '2026-03-20T00:00:00Z' } },
        '2026-03-01T00:00:00Z'
      ),
      subscription({
        status: 'cancelled',
        current_period_end: '2026-06-01T00:00:00.000Z',
        last_event_at: '2026-03-10T00:00:00.000Z',
      })
    );
    expect(decision.kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('BILLING.SUBSCRIPTION.UPDATED', () => {
  const updated = (resource: Record<string, unknown> = {}) =>
    event('BILLING.SUBSCRIPTION.UPDATED', {
      id: 'I-SUB',
      status: 'ACTIVE',
      ...resource,
    });

  it('reconciles the plan against our catalogue', () => {
    const decision = applied(
      decide(
        updated({
          plan_id: 'P-NEGOCIO-MONTH',
          billing_info: { next_billing_time: '2026-05-15T12:00:00Z' },
        }),
        subscription(),
        INTENT,
        'negocio'
      )
    );
    expect(decision.patch).toMatchObject({
      plan_id: 'negocio',
      current_period_end: '2026-05-15T12:00:00.000Z',
    });
  });

  it('reconciles the quantity into addons without losing what was there', () => {
    const decision = applied(
      decide(
        updated({ quantity: '2' }),
        subscription({ addons: { extra_numbers: 1 } }),
        INTENT,
        'pro'
      )
    );
    expect(decision.patch.addons).toEqual({
      extra_numbers: 1,
      paypal_quantity: 2,
    });
  });

  it('records a quantity PayPal sends as a JSON number, not a string', () => {
    const decision = applied(
      decide(updated({ quantity: 2 }), subscription(), INTENT, 'pro')
    );
    expect(decision.patch.addons).toEqual({ paypal_quantity: 2 });
  });

  it('refuses to guess when the PayPal plan is not in our catalogue', () => {
    const decision = decide(
      updated({ plan_id: 'P-UNKNOWN' }),
      subscription(),
      INTENT,
      null
    );
    expect(decision).toMatchObject({ kind: 'error' });
  });

  it('ignores an update for a subscription this account never activated', () => {
    expect(decide(updated(), null).kind).toBe('skip');
  });

  it('carries a status change PayPal reports on the resource', () => {
    const decision = applied(
      decide(updated({ status: 'SUSPENDED' }), subscription(), INTENT, 'pro')
    );
    expect(decision.patch.status).toBe('suspended');
  });

  it('skips an update that changes nothing', () => {
    expect(decide(updated(), subscription(), INTENT, 'pro').kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('BILLING.SUBSCRIPTION.CANCELLED', () => {
  const cancelled = () =>
    event('BILLING.SUBSCRIPTION.CANCELLED', {
      id: 'I-SUB',
      status: 'CANCELLED',
    });

  it('keeps the service to the end of the paid cycle', () => {
    const decision = applied(decide(cancelled(), subscription()));
    expect(decision.patch).toEqual({
      cancel_at_period_end: true,
      last_event_at: '2026-03-15T12:00:00.000Z',
    });
    // The customer paid for this month; status stays active.
    expect(decision.patch.status).toBeUndefined();
    expect(decision.intentStatus).toBe('cancelled');
  });

  it('closes the subscription outright when there is no cycle left to serve', () => {
    const decision = applied(
      decide(
        cancelled(),
        subscription({ current_period_end: '2026-02-01T00:00:00.000Z' })
      )
    );
    expect(decision.patch).toMatchObject({
      cancel_at_period_end: true,
      status: 'cancelled',
    });
  });

  it('cannot cancel a subscription a newer event already reactivated', () => {
    const decision = decide(
      event(
        'BILLING.SUBSCRIPTION.CANCELLED',
        { id: 'I-SUB', status: 'CANCELLED' },
        '2026-03-01T00:00:00Z'
      ),
      subscription({ last_event_at: '2026-03-10T00:00:00.000Z' })
    );
    // Nothing to move forward, so nothing at all: not the flag, not the
    // status, not the attempt.
    expect(decision.kind).toBe('skip');
  });

  it('ignores a cancellation for a subscription this account never activated', () => {
    expect(decide(cancelled(), null).kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('BILLING.SUBSCRIPTION.SUSPENDED', () => {
  const suspended = (time?: string) =>
    event('BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-SUB' }, time);

  it('suspends the account', () => {
    const decision = applied(decide(suspended(), subscription()));
    expect(decision.patch.status).toBe('suspended');
  });

  it('leaves a cancelled subscription alone', () => {
    expect(
      decide(suspended(), subscription({ status: 'cancelled' })).kind
    ).toBe('skip');
  });

  it('ignores a suspension for a subscription that was never activated', () => {
    expect(decide(suspended(), null).kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('BILLING.SUBSCRIPTION.PAYMENT.FAILED', () => {
  const failed = (time = '2026-03-15T12:00:00Z') =>
    event('BILLING.SUBSCRIPTION.PAYMENT.FAILED', { id: 'I-SUB' }, time);

  it('moves to past_due with seven days of grace', () => {
    const decision = applied(decide(failed(), subscription()));
    expect(decision.patch).toMatchObject({
      status: 'past_due',
      grace_until: '2026-03-22T12:00:00.000Z',
    });
    expect(GRACE_DAYS).toBe(7);
  });

  it('counts the grace from the event, not from the redelivery', () => {
    // Same event replayed two days late must not extend the window.
    const decision = applied(
      decide(
        failed('2026-03-13T12:00:00Z'),
        subscription({ last_event_at: '2026-03-10T00:00:00.000Z' })
      )
    );
    expect(decision.patch.grace_until).toBe('2026-03-20T12:00:00.000Z');
  });

  it('does not drag a cancelled subscription back into past_due', () => {
    expect(decide(failed(), subscription({ status: 'cancelled' })).kind).toBe(
      'skip'
    );
  });

  it('cannot undo a newer suspension', () => {
    const decision = decide(
      failed('2026-03-01T00:00:00Z'),
      subscription({
        status: 'suspended',
        last_event_at: '2026-03-10T00:00:00.000Z',
      })
    );
    expect(decision.kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('PAYMENT.SALE.COMPLETED', () => {
  const sale = (time = '2026-04-15T12:00:00Z') =>
    event(
      'PAYMENT.SALE.COMPLETED',
      { id: 'SALE-1', billing_agreement_id: 'I-SUB' },
      time
    );

  it('extends the period by one cycle on renewal and comes back to active', () => {
    const decision = applied(
      decide(
        sale(),
        subscription({
          status: 'past_due',
          grace_until: '2026-04-22T00:00:00.000Z',
          current_period_end: '2026-04-15T12:00:00.000Z',
          last_event_at: '2026-04-10T00:00:00.000Z',
        })
      )
    );
    expect(decision.patch).toMatchObject({
      status: 'active',
      grace_until: null,
      current_period_end: '2026-05-15T12:00:00.000Z',
    });
  });

  // The first payment fires next to ACTIVATED. Taking the later of the
  // two dates is what stops it from handing out two months for one.
  it('does not double-extend the first cycle', () => {
    const decision = applied(
      decide(
        sale('2026-03-15T12:00:05Z'),
        subscription({ current_period_end: '2026-04-15T12:00:00.000Z' })
      )
    );
    // 15 March + 1 month lands within seconds of the activation's own
    // next_billing_time, so the customer gets one month, not two.
    const moved =
      Date.parse(decision.patch.current_period_end!) -
      Date.parse('2026-04-15T12:00:00.000Z');
    expect(moved).toBeLessThan(60_000);
    expect(decision.patch.status).toBeUndefined();
  });

  it('serves the customer when the sale beats its own activation', () => {
    const decision = applied(decide(sale('2026-03-15T12:00:00Z'), null));
    expect(decision.patch).toMatchObject({
      plan_id: 'pro',
      status: 'active',
      provider_subscription_id: 'I-SUB',
      current_period_end: '2026-04-15T12:00:00.000Z',
    });
    expect(decision.intentStatus).toBe('activated');
  });

  it('takes over the cancelled row when the new sale lands before its activation', () => {
    const decision = applied(
      decide(
        sale('2026-03-15T12:00:00Z'),
        subscription({
          provider_subscription_id: 'I-OLD',
          status: 'cancelled',
          cancel_at_period_end: true,
          current_period_end: '2026-02-01T00:00:00.000Z',
          last_event_at: '2026-02-20T00:00:00.000Z',
        })
      )
    );
    expect(decision.patch).toMatchObject({
      status: 'active',
      provider_subscription_id: 'I-SUB',
      current_period_end: '2026-04-15T12:00:00.000Z',
      cancel_at_period_end: false,
      grace_until: null,
    });
  });

  it('refuses when there is no intent to say which plan and cycle were paid', () => {
    expect(decide(sale(), null, null).kind).toBe('error');
  });

  it('does not resurrect a cancelled subscription, but honours what was paid', () => {
    const decision = applied(
      decide(
        sale(),
        subscription({
          status: 'cancelled',
          current_period_end: '2026-04-15T12:00:00.000Z',
        })
      )
    );
    expect(decision.patch.status).toBeUndefined();
    expect(decision.patch.current_period_end).toBe('2026-05-15T12:00:00.000Z');
  });

  it('never rewinds the period end', () => {
    const decision = decide(
      sale('2026-01-01T00:00:00Z'),
      subscription({
        current_period_end: '2026-12-01T00:00:00.000Z',
        last_event_at: '2026-01-01T00:00:00.000Z',
      })
    );
    expect(decision.kind).toBe('skip');
  });
});

// ---------------------------------------------------------------------------
describe('guards shared by every handler', () => {
  it('does nothing for an event type outside the spec table', () => {
    expect(
      decide(event('PAYMENT.SALE.REFUNDED', { id: 'I-SUB' }), subscription())
        .kind
    ).toBe('skip');
  });

  it('fails when the event carries no subscription id', () => {
    expect(
      decide(event('BILLING.SUBSCRIPTION.ACTIVATED', {}), subscription()).kind
    ).toBe('error');
  });

  it('stamps the watermark only when the event was not late', () => {
    const fresh = applied(
      decide(
        event('BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-SUB' }),
        subscription({ last_event_at: '2026-03-01T00:00:00.000Z' })
      )
    );
    expect(fresh.patch.last_event_at).toBe('2026-03-15T12:00:00.000Z');

    const late = applied(
      decide(
        event(
          'BILLING.SUBSCRIPTION.ACTIVATED',
          {
            id: 'I-SUB',
            billing_info: { next_billing_time: '2027-01-01T00:00:00Z' },
          },
          '2026-03-01T00:00:00Z'
        ),
        subscription({ last_event_at: '2026-03-10T00:00:00.000Z' })
      )
    );
    expect(late.patch.last_event_at).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// The billing cycle of a live subscription (migración 056, §6).
//
// Changing plan through the settings area revises the SAME PayPal
// subscription, so the checkout intent keeps saying whatever was bought
// originally. If the cycle is not learned from the UPDATED event, a
// customer who moves from monthly to yearly pays for a year and gets
// their period extended by a month.
// ---------------------------------------------------------------------------
describe('billing cycle', () => {
  function decideWithCycle(
    e: PayPalWebhookEvent,
    existing: SubscriptionState | null,
    intent: IntentState | null,
    planId: string | null,
    cycle: 'month' | 'year' | null
  ): Decision {
    return decideSubscriptionChange({
      event: e,
      existing,
      intent,
      planFromProviderPlanId: planId,
      cycleFromProviderPlanId: cycle,
      now: NOW,
    });
  }

  it('records the contracted cycle when the subscription activates', () => {
    const decision = applied(
      decide(event('BILLING.SUBSCRIPTION.ACTIVATED', { id: 'I-SUB' }), null, {
        plan_id: 'pro',
        cycle: 'year',
      })
    );
    expect(decision.patch.cycle).toBe('year');
  });

  it('learns the new cycle from an update that changes plan', () => {
    const decision = applied(
      decideWithCycle(
        event('BILLING.SUBSCRIPTION.UPDATED', {
          id: 'I-SUB',
          plan_id: 'P-PRO-YEAR',
        }),
        subscription({ cycle: 'month' }),
        INTENT,
        'pro',
        'year'
      )
    );
    expect(decision.patch.cycle).toBe('year');
  });

  it('does not rewrite a cycle that has not moved', () => {
    // Nothing changed at all, so the update writes nothing — not even
    // a no-op cycle that would bump `updated_at` on every redelivery.
    const decision = decideWithCycle(
      event('BILLING.SUBSCRIPTION.UPDATED', {
        id: 'I-SUB',
        plan_id: 'P-PRO-MONTH',
      }),
      subscription({ cycle: 'month' }),
      INTENT,
      'pro',
      'month'
    );
    expect(decision.kind).toBe('skip');
  });

  it('renews on the cycle being charged, not the one contracted', () => {
    // The money case. The intent still says `month` because that is
    // what the customer originally bought; PayPal just charged a year.
    const decision = applied(
      decide(
        event(
          'PAYMENT.SALE.COMPLETED',
          { id: 'SALE-1', billing_agreement_id: 'I-SUB' },
          '2026-04-15T12:00:00Z'
        ),
        subscription({ cycle: 'year' }),
        { plan_id: 'pro', cycle: 'month' }
      )
    );
    expect(decision.patch.current_period_end).toBe('2027-04-15T12:00:00.000Z');
  });

  it('falls back to the intent when no cycle was ever recorded', () => {
    // Every row written before migration 056 has `cycle` NULL. The
    // behaviour there must be exactly what it was before.
    const decision = applied(
      decide(
        event(
          'PAYMENT.SALE.COMPLETED',
          { id: 'SALE-1', billing_agreement_id: 'I-SUB' },
          '2026-04-15T12:00:00Z'
        ),
        subscription({ cycle: null }),
        { plan_id: 'pro', cycle: 'month' }
      )
    );
    expect(decision.patch.current_period_end).toBe('2026-05-15T12:00:00.000Z');
  });

  it('ignores a stored cycle that is not one we sell', () => {
    const decision = applied(
      decide(
        event(
          'PAYMENT.SALE.COMPLETED',
          { id: 'SALE-1', billing_agreement_id: 'I-SUB' },
          '2026-04-15T12:00:00Z'
        ),
        subscription({ cycle: 'week' }),
        { plan_id: 'pro', cycle: 'month' }
      )
    );
    expect(decision.patch.current_period_end).toBe('2026-05-15T12:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// Re-contracting after a cancellation, end to end (fase 3 §6).
//
// §6 lets a customer who cancelled contract again while the row is
// still `active` with `cancel_at_period_end` — that is the ONLY state
// the product ever leaves behind, because the CANCELLED handler writes
// just the flag while there is paid time left and nothing ever moves
// the row on afterwards. If the webhook refuses the new subscription's
// events there, the customer pays and never gets service.
// ---------------------------------------------------------------------------
describe('re-contracting after a cancellation', () => {
  /** The row cancelling leaves behind: alive, paid for, on its way out. */
  const cancelled = () =>
    subscription({
      provider_subscription_id: 'I-OLD',
      status: 'active',
      cancel_at_period_end: true,
      cycle: 'year',
      current_period_end: '2026-04-15T12:00:00.000Z',
      last_event_at: '2026-03-15T12:00:00.000Z',
    });

  const activatedNew = (createTime = '2026-03-16T12:00:00Z') =>
    event(
      'BILLING.SUBSCRIPTION.ACTIVATED',
      {
        id: 'I-NEW',
        status: 'ACTIVE',
        billing_info: { next_billing_time: '2026-04-16T12:00:00Z' },
      },
      createTime
    );

  const saleOfNew = (createTime = '2026-03-16T12:00:00Z') =>
    event(
      'PAYMENT.SALE.COMPLETED',
      { id: 'SALE-NEW', billing_agreement_id: 'I-NEW' },
      createTime
    );

  it('takes the row over when the new subscription activates', () => {
    const decision = applied(decide(activatedNew(), cancelled()));

    expect(decision.stale).toBe(false);
    expect(decision.patch).toMatchObject({
      status: 'active',
      provider_subscription_id: 'I-NEW',
      current_period_end: '2026-04-16T12:00:00.000Z',
      cancel_at_period_end: false,
      grace_until: null,
      cycle: 'month',
    });
    expect(decision.intentStatus).toBe('activated');
  });

  it('takes the row over when the first payment arrives first', () => {
    // PayPal delivers the sale before the activation often enough that
    // the branch exists; it must adopt too, or the money is taken and
    // the account stays on the dead subscription.
    const decision = applied(decide(saleOfNew(), cancelled()));

    expect(decision.patch).toMatchObject({
      status: 'active',
      provider_subscription_id: 'I-NEW',
      cancel_at_period_end: false,
      grace_until: null,
    });
    expect(decision.intentStatus).toBe('activated');
  });

  it('charges the new cycle, not the one the dead subscription had', () => {
    // The row says `year` because that is what the customer used to
    // pay; the intent says `month` because that is what they just
    // bought. Extending a year for a month of money is a month of
    // service given away and, worse, `laterIso` means the later
    // ACTIVATED can never pull the period back.
    const decision = applied(decide(saleOfNew(), cancelled()));

    expect(decision.patch.current_period_end).toBe('2026-04-16T12:00:00.000Z');
    expect(decision.patch.cycle).toBe('month');
  });

  it('still refuses a row that is alive with no cancellation scheduled', () => {
    // The f3.3 rule, unchanged: that row IS being charged, and another
    // subscription's events may not have it.
    expect(
      decide(
        activatedNew(),
        subscription({
          provider_subscription_id: 'I-OLD',
          status: 'active',
          cancel_at_period_end: false,
        })
      )
    ).toMatchObject({ kind: 'error' });
    expect(
      decide(
        saleOfNew(),
        subscription({
          provider_subscription_id: 'I-OLD',
          status: 'past_due',
          cancel_at_period_end: false,
        })
      )
    ).toMatchObject({ kind: 'error' });
  });

  it('refuses even a scheduled-to-cancel row with no intent behind it', () => {
    // The intent is what proves the new subscription is ours: it is
    // what resolved the account in the first place.
    expect(decide(activatedNew(), cancelled(), null)).toMatchObject({
      kind: 'error',
    });
  });

  it('is never treated as a late delivery', () => {
    // The watermark belongs to the subscription that died. An
    // activation stamped before it must still be applied in full.
    const decision = applied(
      decide(activatedNew('2026-03-14T12:00:00Z'), cancelled())
    );
    expect(decision.stale).toBe(false);
    expect(decision.patch.status).toBe('active');
    expect(decision.patch.provider_subscription_id).toBe('I-NEW');
  });

  it('does not adopt on an event that is not a purchase', () => {
    expect(
      decide(
        event('BILLING.SUBSCRIPTION.SUSPENDED', { id: 'I-NEW' }),
        cancelled()
      )
    ).toMatchObject({ kind: 'error' });
  });
});
