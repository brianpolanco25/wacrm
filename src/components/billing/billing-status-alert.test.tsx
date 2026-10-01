import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';

// s9.6: the dunning banner gains the `incomplete` rung — an account that
// signed up and never paid — whose way out is /onboarding, not /billing.

const h = vi.hoisted(() => ({
  status: null as Record<string, unknown> | null,
  supportSession: false,
}));
vi.mock('@/hooks/use-billing-status', () => ({
  useBillingStatus: () => h.status,
}));
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ supportSession: h.supportSession }),
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: () => {} }) }));

import { BillingStatusAlert } from './billing-status-alert';

function render(locale: 'es' | 'en' = 'es') {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={locale === 'es' ? es : en}
    >
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

// s10.4: the `statement_due` variant of a managed account.
describe('BillingStatusAlert — statement_due (s10.4)', () => {
  const STATEMENT = {
    id: 'st-1',
    periodStart: '2026-10-01T00:00:00.000Z',
    periodEnd: '2026-11-01T00:00:00.000Z',
    dueAt: '2026-11-04T00:00:00.000Z',
    totalUsd: 1069.9,
  };
  // Read on 2 Nov at 06:00 UTC: 1 day and 18 hours to go → 2 days.
  const READ_AT = Date.parse('2026-11-02T06:00:00.000Z');

  it('before the due date: amount, period, due date and days left, with «Ya pagué»', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      readOnly: false,
      manualHold: false,
      graceUntil: STATEMENT.dueAt,
      statement: STATEMENT,
      readAt: READ_AT,
    };
    const html = render();
    expect(html).toContain('data-statement-alert="due"');
    expect(html).toContain(es.Billing.statementAlert.dueTitle);
    expect(html).toContain('1069,90');
    expect(html).toContain('te quedan 2 días');
    expect(html).toContain('4 nov 2026');
    expect(html).toContain(es.Billing.statementAlert.claim);
    expect(html).toContain(es.Billing.statementAlert.view);
    // Not the generic «a payment failed» of PayPal.
    expect(html).not.toContain(es.Billing.pastDueTitle);
  });

  it('a viewer is told the dates, never the amount, and gets no «Ya pagué»', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      readOnly: false,
      manualHold: false,
      statement: { ...STATEMENT, totalUsd: null },
      readAt: READ_AT,
    };
    const html = render();
    expect(html).toContain('quedan 2 días');
    expect(html).not.toContain('1069');
    expect(html).not.toContain(es.Billing.statementAlert.claim);
  });

  it('past the due date: read-only in its own words, with the way to /billing', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      readOnly: true,
      readOnlyReason: 'statement',
      manualHold: false,
      statement: STATEMENT,
      readAt: Date.parse('2026-11-05T00:00:00.000Z'),
    };
    const html = render();
    expect(html).toContain('data-statement-alert="locked"');
    expect(html).toContain(es.Billing.statementAlert.lockedTitle);
    expect(html).toContain(es.Billing.statementAlert.view);
    expect(html).not.toContain(es.Billing.lockedTitle);
    expect(render('en')).toContain(en.Billing.statementAlert.lockedTitle);
  });

  it('a manual hold still wins: only the operator can lift it', () => {
    h.status = {
      ...BASE,
      status: 'active',
      readOnly: true,
      manualHold: true,
      statement: STATEMENT,
      readAt: READ_AT,
    };
    const html = render();
    expect(html).toContain(es.Billing.heldTitle);
    expect(html).not.toContain(es.Billing.statementAlert.dueTitle);
  });

  it('locked by the subscription with a statement not yet due: the subscription banner and its way out, the statement as a warning', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      // A PayPal charge failed and its grace ran out before the cut-off.
      graceUntil: '2026-11-01T00:00:00.000Z',
      readOnly: true,
      readOnlyReason: 'subscription',
      manualHold: false,
      statement: STATEMENT,
      readAt: READ_AT,
    };
    const html = render();
    expect(html).toContain(es.Billing.lockedTitle);
    expect(html).toContain(es.Billing.fixNow);
    expect(html).toContain('data-statement-alert="due"');
    expect(html).toContain('te quedan 2 días');
    expect(html).not.toContain('data-statement-alert="locked"');
    expect(html).not.toContain(es.Billing.statementAlert.lockedTitle);
  });

  it('no «Ya pagué» during a support session: the route refuses it', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      readOnly: false,
      manualHold: false,
      statement: STATEMENT,
      readAt: READ_AT,
    };
    h.supportSession = true;
    try {
      const html = render();
      expect(html).toContain(es.Billing.statementAlert.dueTitle);
      expect(html).toContain(es.Billing.statementAlert.view);
      expect(html).not.toContain(es.Billing.statementAlert.claim);
    } finally {
      h.supportSession = false;
    }
  });

  it('the due-today wording', () => {
    h.status = {
      ...BASE,
      status: 'past_due',
      readOnly: false,
      manualHold: false,
      statement: STATEMENT,
      readAt: Date.parse(STATEMENT.dueAt),
    };
    expect(render()).toContain('vence hoy');
  });
});
