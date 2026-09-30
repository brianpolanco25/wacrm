import { describe, expect, it, vi } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';

// s9.6: the three steps of /onboarding, rendered to static markup like
// the rest of the component tests (no jsdom). The step comes from the
// server; this checks that each one renders what it should, in es/en/ko.

vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: () => {}, refresh: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));
// The plan step reuses PlanPicker as-is; its catalogue fetch runs in an
// effect, which static rendering never reaches. Its role gate needs auth.
vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ profileLoading: false, accountRole: 'owner' }),
}));

import { OnboardingFlow, type OnboardingFlowState } from './onboarding-flow';

type Catalogue = typeof es;
const CATALOGUES: Array<['es' | 'en' | 'ko', Catalogue]> = [
  ['es', es],
  ['en', en as Catalogue],
  ['ko', ko as Catalogue],
];

function render(
  state: OnboardingFlowState,
  locale: 'es' | 'en' | 'ko' = 'es',
  messages: Catalogue = es
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <OnboardingFlow state={state} />
    </NextIntlClientProvider>
  );
}

const EMPTY = {
  name: 'Acme',
  country: null,
  phone: null,
  industry: null,
  teamSize: null,
};

describe('OnboardingFlow', () => {
  it.each(CATALOGUES)(
    'step 1 for the owner: the five fields, translated (%s)',
    (locale, messages) => {
      const html = render(
        { step: 'company', canEditCompany: true, canPay: true, profile: EMPTY },
        locale,
        messages
      );
      const c = messages.Onboarding.company;
      for (const label of [
        c.title,
        c.name,
        c.country,
        c.phone,
        c.industry,
        c.teamSize,
        c.continue,
      ]) {
        expect(html).toContain(label);
      }
      expect(html).toContain(messages.Onboarding.company.industries.other);
      // Country names come from Intl in the user's language: DO is there.
      expect(html).toContain('value="DO"');
      expect(html).toContain('value="51+"');
      expect(html).toContain('aria-current="step"');
      expect(html).toContain('value="Acme"');
    }
  );

  it('step 1 for a member who is not the owner: says who has to do it, no form', () => {
    const html = render({
      step: 'company',
      canEditCompany: false,
      canPay: false,
      profile: EMPTY,
    });
    expect(html).toContain(es.Onboarding.ownerOnlyTitle);
    expect(html).not.toContain('<form');
  });

  it('step 2: the plan picker, and the way back to correct the company', () => {
    const html = render({
      step: 'plan',
      canEditCompany: true,
      canPay: true,
      profile: {
        ...EMPTY,
        country: 'DO',
        phone: '1',
        industry: 'retail',
        teamSize: '1',
      },
    });
    expect(html).toContain(es.Billing.title);
    expect(html).toContain(es.Onboarding.editCompany);
    expect(html).not.toContain('<form');
  });

  it('step 2 for an agent: tells them an admin has to pay', () => {
    const html = render({
      step: 'plan',
      canEditCompany: false,
      canPay: false,
      profile: EMPTY,
    });
    expect(html).toContain(es.Onboarding.adminOnlyTitle);
    expect(html).not.toContain(es.Onboarding.editCompany);
  });
});

describe('no trial left in the catalogues (s9.6)', () => {
  it.each(CATALOGUES)(
    '%s.json has no trial countdown and has the Onboarding namespace',
    (_l, messages) => {
      const billing = messages.Billing as Record<string, unknown>;
      expect(billing.trialEndsIn).toBeUndefined();
      expect(billing.trialEndsToday).toBeUndefined();
      expect(billing.trialChoosePlan).toBeUndefined();
      const sub = messages.Billing.subscription as Record<string, unknown>;
      expect(sub.trialEnds).toBeUndefined();
      expect(sub.trialNoDate).toBeUndefined();
      expect(messages.Billing.subscription.status.incomplete).toBeTruthy();
      expect(messages.Billing.incomplete.action).toBeTruthy();
      expect(messages.Platform.metrics.status.incomplete).toBeTruthy();
      expect(Object.keys(messages.Onboarding).sort()).toEqual(
        Object.keys(en.Onboarding).sort()
      );
    }
  );

  it('es says «Alta incompleta» where the spec asks for it', () => {
    expect(es.Billing.subscription.status.incomplete).toBe('Alta incompleta');
    expect(es.Platform.metrics.status.incomplete).toBe('Alta incompleta');
  });
});
