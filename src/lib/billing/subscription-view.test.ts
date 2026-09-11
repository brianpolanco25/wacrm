import { describe, expect, it } from 'vitest';

// ---------------------------------------------------------------------------
// The pure half of the subscription area (Fase 3 §6).
//
// Two acceptance criteria live here and nowhere else:
//
//   - "El consumo mostrado coincide con `usage_counters`". `buildUsage`
//     must copy the counter across, not adjust it — not clamped to the
//     limit, not rounded, not scaled.
//   - The actions offered per state. Getting these wrong means either a
//     dead button or a second PayPal subscription charging the customer
//     while the first still does.
// ---------------------------------------------------------------------------

import {
  availableActions,
  buildUsage,
  nextChargeAt,
  parseReceipt,
  receiptLink,
} from './subscription-view';

const LIMITS = {
  messages_out: 3000,
  ai_replies: 500,
  broadcast_recipients: null,
};

describe('buildUsage — the consumption shown is usage_counters', () => {
  it('shows the counter value verbatim, not a derived number', () => {
    const lines = buildUsage(LIMITS, [
      { metric: 'messages_out', value: 2731 },
      { metric: 'ai_replies', value: 12 },
    ]);
    const byMetric = Object.fromEntries(lines.map((l) => [l.metric, l]));
    expect(byMetric.messages_out.used).toBe(2731);
    expect(byMetric.ai_replies.used).toBe(12);
  });

  it('does NOT clamp the used figure to the limit', () => {
    // Over quota is a real state: `increment_usage` is atomic but a
    // limit can also shrink when the plan is downgraded. Showing "3000
    // of 3000" when 3211 were sent would hide the reason every send is
    // being refused.
    const [line] = buildUsage(LIMITS, [
      { metric: 'messages_out', value: 3211 },
    ]);
    expect(line.used).toBe(3211);
    expect(line.limit).toBe(3000);
    // Only the BAR is clamped, and it is a separate field.
    expect(line.percent).toBe(100);
  });

  it('decodes a bigint that arrives as a string without changing it', () => {
    const [line] = buildUsage(LIMITS, [
      { metric: 'messages_out', value: '1500' },
    ]);
    expect(line.used).toBe(1500);
    expect(line.percent).toBe(50);
  });

  it('reports zero for a metric with no counter row yet', () => {
    const lines = buildUsage(LIMITS, []);
    expect(lines.map((l) => l.metric)).toEqual([
      'messages_out',
      'ai_replies',
      'broadcast_recipients',
    ]);
    expect(lines.every((l) => l.used === 0)).toBe(true);
  });

  it('shows an unlimited metric with no bar instead of hiding it', () => {
    const lines = buildUsage(LIMITS, [
      { metric: 'broadcast_recipients', value: 90_000 },
    ]);
    const line = lines.find((l) => l.metric === 'broadcast_recipients')!;
    expect(line.used).toBe(90_000);
    expect(line.limit).toBeNull();
    expect(line.percent).toBeNull();
  });

  it('surfaces a counter for a metric the plan does not list', () => {
    const lines = buildUsage(LIMITS, [{ metric: 'something_new', value: 7 }]);
    const line = lines.find((l) => l.metric === 'something_new')!;
    expect(line.used).toBe(7);
    expect(line.limit).toBeNull();
  });

  it('drops a value that is not a number rather than printing NaN', () => {
    const lines = buildUsage(LIMITS, [
      { metric: 'messages_out', value: 'not-a-number' },
    ]);
    expect(lines.find((l) => l.metric === 'messages_out')!.used).toBe(0);
  });
});

describe('parseReceipt', () => {
  const sale = {
    id: 'evt-1',
    received_at: '2026-09-02T00:00:00.000Z',
    payload: {
      resource: {
        id: '9XY12345AB6789012',
        billing_agreement_id: 'I-SUB-1',
        create_time: '2026-09-01T10:00:00Z',
        amount: { total: '79.00', currency: 'USD' },
      },
    },
  };

  it('reads the amount, the currency, the date and the transaction id', () => {
    expect(parseReceipt(sale)).toEqual({
      id: 'evt-1',
      transactionId: '9XY12345AB6789012',
      amount: '79.00',
      currency: 'USD',
      paidAt: '2026-09-01T10:00:00Z',
      link: null,
    });
  });

  it('keeps the amount as the decimal string PayPal sent', () => {
    const receipt = parseReceipt({
      ...sale,
      payload: {
        resource: {
          ...sale.payload.resource,
          amount: { total: '790.00', currency: 'USD' },
        },
      },
    })!;
    // Not 790, not "790": a receipt that does not match the bank
    // statement character for character is a support ticket.
    expect(receipt.amount).toBe('790.00');
  });

  it('reads the v2-shaped amount too', () => {
    const receipt = parseReceipt({
      ...sale,
      payload: {
        resource: {
          ...sale.payload.resource,
          amount: { value: '29.00', currency_code: 'USD' },
        },
      },
    })!;
    expect(receipt.amount).toBe('29.00');
    expect(receipt.currency).toBe('USD');
  });

  it('falls back to when we received the event if the sale has no date', () => {
    const receipt = parseReceipt({
      ...sale,
      payload: {
        resource: {
          id: 'x',
          amount: { total: '1.00', currency: 'USD' },
        },
      },
    })!;
    expect(receipt.paidAt).toBe('2026-09-02T00:00:00.000Z');
  });

  it('is not a receipt without an amount', () => {
    expect(
      parseReceipt({ id: 'e', payload: { resource: { id: 'x' } } })
    ).toBeNull();
    expect(parseReceipt({ id: 'e', payload: null })).toBeNull();
  });

  it('takes a customer-facing PayPal link and nothing else', () => {
    expect(
      receiptLink([{ rel: 'receipt', href: 'https://www.paypal.com/r/1' }])
    ).toBe('https://www.paypal.com/r/1');
    // The API links a sale carries need an OAuth token; printing one as
    // "your receipt" hands the customer a 401 and leaks our API base.
    expect(
      receiptLink([
        { rel: 'self', href: 'https://api-m.paypal.com/v1/payments/sale/1' },
      ])
    ).toBeNull();
    // Never off PayPal, never plain http: this string arrives from an
    // external system and ends up in an href.
    expect(
      receiptLink([{ rel: 'receipt', href: 'https://evil.example/r/1' }])
    ).toBeNull();
    expect(
      receiptLink([{ rel: 'receipt', href: 'http://www.paypal.com/r/1' }])
    ).toBeNull();
    expect(receiptLink('nope')).toBeNull();
  });
});

describe('availableActions', () => {
  const sub = (over: Partial<Parameters<typeof availableActions>[0]> = {}) => ({
    status: 'active',
    cancelAtPeriodEnd: false,
    providerSubscriptionId: 'I-SUB-1',
    ...over,
  });

  it('offers cancel and an in-place plan change on a live subscription', () => {
    expect(availableActions(sub())).toEqual({
      cancel: true,
      reactivate: null,
      changePlan: 'revise',
    });
  });

  it('changes plan through the checkout while on the trial', () => {
    // Nothing is being charged, so there is no subscription to revise:
    // contracting IS the plan change, and it reuses §2.
    expect(availableActions(null)).toEqual({
      cancel: false,
      reactivate: null,
      changePlan: 'checkout',
    });
    expect(
      availableActions(
        sub({ status: 'trialing', providerSubscriptionId: null })
      )
    ).toEqual({ cancel: false, reactivate: null, changePlan: 'checkout' });
  });

  it('resumes a suspended subscription at PayPal instead of buying again', () => {
    // PayPal can activate what it suspended; buying a second
    // subscription would leave the customer paying twice.
    expect(availableActions(sub({ status: 'suspended' }))).toEqual({
      cancel: true,
      reactivate: 'activate',
      changePlan: 'revise',
    });
  });

  it('offers no second cancel once the cancellation is scheduled', () => {
    // PayPal's cancel is irreversible, so the only way back is a new
    // subscription — never an "undo" that would silently do nothing.
    expect(availableActions(sub({ cancelAtPeriodEnd: true }))).toEqual({
      cancel: false,
      reactivate: 'checkout',
      changePlan: 'checkout',
    });
  });

  it('sends a cancelled or expired account to the checkout', () => {
    for (const status of ['cancelled', 'expired']) {
      expect(availableActions(sub({ status }))).toEqual({
        cancel: false,
        reactivate: 'checkout',
        changePlan: 'checkout',
      });
    }
  });

  it('never offers to cancel something PayPal does not have', () => {
    expect(availableActions(sub({ providerSubscriptionId: null })).cancel).toBe(
      false
    );
  });

  it('resumes at PayPal only while suspended and not cancelled', () => {
    // A suspended subscription can be activated again; the same one
    // with a cancellation already accepted cannot.
    expect(
      availableActions(sub({ status: 'suspended', cancelAtPeriodEnd: true }))
        .reactivate
    ).toBe('checkout');
  });
});

describe('nextChargeAt', () => {
  it('is the period end while the subscription renews', () => {
    expect(
      nextChargeAt({
        status: 'active',
        cancelAtPeriodEnd: false,
        currentPeriodEnd: '2026-10-01T00:00:00Z',
      })
    ).toBe('2026-10-01T00:00:00Z');
  });

  it('is nothing once the cancellation is scheduled', () => {
    // The same date is then the day service STOPS. Labelling it "next
    // charge" would promise a renewal that will not happen.
    expect(
      nextChargeAt({
        status: 'active',
        cancelAtPeriodEnd: true,
        currentPeriodEnd: '2026-10-01T00:00:00Z',
      })
    ).toBeNull();
  });

  it('is nothing for a cancelled or expired subscription', () => {
    for (const status of ['cancelled', 'expired']) {
      expect(
        nextChargeAt({
          status,
          cancelAtPeriodEnd: false,
          currentPeriodEnd: '2026-10-01T00:00:00Z',
        })
      ).toBeNull();
    }
  });
});
