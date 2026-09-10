import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  alreadyContracted,
  checkoutRequestId,
  checkoutUrls,
  isBillingCycle,
  priceFor,
  providerPlanIdFor,
  resolveAppOrigin,
  type CheckoutPlanRow,
} from './checkout';

const PRO: CheckoutPlanRow = {
  id: 'pro',
  name: 'Pro',
  is_public: true,
  price_usd_month: '79.00',
  price_usd_year: '790.00',
  provider_plan_id_month: 'P-PRO-MONTH',
  provider_plan_id_year: 'P-PRO-YEAR',
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('isBillingCycle', () => {
  it('accepts only the two cycles PayPal plans were created for', () => {
    expect(isBillingCycle('month')).toBe(true);
    expect(isBillingCycle('year')).toBe(true);
    expect(isBillingCycle('week')).toBe(false);
    expect(isBillingCycle(undefined)).toBe(false);
    expect(isBillingCycle(1)).toBe(false);
  });
});

describe('providerPlanIdFor', () => {
  it('picks the id for the requested cycle', () => {
    expect(providerPlanIdFor(PRO, 'month')).toBe('P-PRO-MONTH');
    expect(providerPlanIdFor(PRO, 'year')).toBe('P-PRO-YEAR');
  });

  it('treats a missing or blank id as "not contractable yet"', () => {
    // The bootstrap script has not run for this cycle: the route must
    // say so rather than posting an empty plan_id to PayPal.
    expect(
      providerPlanIdFor({ ...PRO, provider_plan_id_year: null }, 'year')
    ).toBeNull();
    expect(
      providerPlanIdFor({ ...PRO, provider_plan_id_month: '  ' }, 'month')
    ).toBeNull();
  });
});

describe('priceFor', () => {
  it('formats the advertised price as a two-decimal string', () => {
    expect(priceFor(PRO, 'month')).toBe('79.00');
    expect(priceFor({ ...PRO, price_usd_year: 1990 }, 'year')).toBe('1990.00');
  });

  it('refuses a null, zero or negative price', () => {
    // PayPal rejects a 0.00 subscription; catching it here keeps the
    // failure on our side of the wire.
    expect(priceFor({ ...PRO, price_usd_year: null }, 'year')).toBeNull();
    expect(priceFor({ ...PRO, price_usd_month: 0 }, 'month')).toBeNull();
    expect(priceFor({ ...PRO, price_usd_month: -5 }, 'month')).toBeNull();
  });
});

describe('alreadyContracted', () => {
  it('blocks a second checkout for an account PayPal already charges', () => {
    for (const status of ['active', 'past_due', 'suspended']) {
      expect(
        alreadyContracted({ status, provider_subscription_id: 'I-1' })
      ).toBe(true);
    }
  });

  it('lets trialing, cancelled and expired accounts contract', () => {
    for (const status of ['trialing', 'cancelled', 'expired']) {
      expect(
        alreadyContracted({ status, provider_subscription_id: 'I-1' })
      ).toBe(false);
    }
  });

  it('ignores a status with no provider subscription behind it', () => {
    // A row seeded as `active` by a trial or a migration is not a
    // PayPal subscription and must not lock the customer out of paying.
    expect(
      alreadyContracted({ status: 'active', provider_subscription_id: null })
    ).toBe(false);
    expect(alreadyContracted(null)).toBe(false);
  });
});

describe('checkoutRequestId', () => {
  it('is stable inside a ten-minute window and changes after it', () => {
    const base = 1_700_000_000_000;
    const first = checkoutRequestId('acct-1', 'pro', 'month', base);
    expect(checkoutRequestId('acct-1', 'pro', 'month', base + 60_000)).toBe(
      first
    );
    // A double click reuses PayPal's idempotency and gets the *same*
    // pending subscription back — one approval, one charge.
    expect(
      checkoutRequestId('acct-1', 'pro', 'month', base + 11 * 60_000)
    ).not.toBe(first);
  });

  it('never collides across accounts, plans or cycles', () => {
    const base = 1_700_000_000_000;
    const ids = new Set([
      checkoutRequestId('acct-1', 'pro', 'month', base),
      checkoutRequestId('acct-2', 'pro', 'month', base),
      checkoutRequestId('acct-1', 'negocio', 'month', base),
      checkoutRequestId('acct-1', 'pro', 'year', base),
    ]);
    expect(ids.size).toBe(4);
  });
});

describe('checkoutUrls', () => {
  it('sends the customer back to the informational return page', () => {
    expect(checkoutUrls('https://app.example.com')).toEqual({
      returnUrl: 'https://app.example.com/billing/return',
      cancelUrl: 'https://app.example.com/billing?checkout=cancelled',
    });
  });

  it('tolerates a trailing slash on the origin', () => {
    expect(checkoutUrls('https://app.example.com//').returnUrl).toBe(
      'https://app.example.com/billing/return'
    );
  });
});

describe('resolveAppOrigin', () => {
  const req = (headers: Record<string, string>) =>
    new Request('http://localhost:3000/api/billing/checkout', { headers });

  it('prefers the configured canonical site URL', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://crm.example.com/');
    expect(resolveAppOrigin(req({ host: 'whatever.example' }))).toBe(
      'https://crm.example.com'
    );
  });

  it('falls back to the proxy headers, then to the Host header', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    expect(
      resolveAppOrigin(
        req({
          'x-forwarded-host': 'crm.example.com',
          'x-forwarded-proto': 'https',
        })
      )
    ).toBe('https://crm.example.com');
    expect(resolveAppOrigin(req({ host: 'localhost:3000' }))).toBe(
      'http://localhost:3000'
    );
  });

  it('never falls back to a domain that is not this deployment', () => {
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', '');
    // A customer who just paid must land back in the app, not on a
    // marketing site that 404s on /billing/return.
    const origin = resolveAppOrigin(
      new Request('https://app.example.com/api/billing/checkout')
    );
    expect(origin).toBe('https://app.example.com');
  });
});
