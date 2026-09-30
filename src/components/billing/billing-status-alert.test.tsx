import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import es from '../../../messages/es.json';

// s9.6: the dunning banner gains the `incomplete` rung — an account that
// signed up and never paid — whose way out is /onboarding, not /billing.

const h = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
}));
vi.mock('@/hooks/use-billing-status', () => ({
  useBillingStatus: () => h.status,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BillingStatusAlert } from './billing-status-alert';

function render() {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale="es" timeZone="UTC" messages={es}>
      <BillingStatusAlert />
    </NextIntlClientProvider>
  );
}

const BASE = {
  planId: 'inicio',
  graceUntil: null,
  trialEndsAt: null,
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
  readAt: 0,
};

describe('BillingStatusAlert', () => {
  it('an incomplete account: «completa tu alta», not «settle the subscription»', () => {
    h.status = {
      ...BASE,
      status: 'incomplete',
      readOnly: true,
      manualHold: false,
    };
    const html = render();
    expect(html).toContain(es.Billing.incomplete.title);
    expect(html).toContain(es.Billing.incomplete.action);
    expect(html).not.toContain(es.Billing.lockedTitle);
    expect(html).not.toContain(es.Billing.fixNow);
  });

  it('a suspended account keeps the lock message and /billing', () => {
    h.status = {
      ...BASE,
      status: 'suspended',
      readOnly: true,
      manualHold: false,
    };
    const html = render();
    expect(html).toContain(es.Billing.lockedTitle);
    expect(html).toContain(es.Billing.fixNow);
    expect(html).not.toContain(es.Billing.incomplete.title);
  });

  it('a manual hold wins over incomplete: only the operator can lift it', () => {
    h.status = {
      ...BASE,
      status: 'incomplete',
      readOnly: true,
      manualHold: true,
    };
    const html = render();
    expect(html).toContain(es.Billing.heldTitle);
    expect(html).not.toContain(es.Billing.incomplete.action);
  });

  it('an active account renders nothing', () => {
    h.status = {
      ...BASE,
      status: 'active',
      readOnly: false,
      manualHold: false,
    };
    expect(render()).toBe('');
  });
});
