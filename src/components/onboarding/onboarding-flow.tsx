'use client';

// ============================================================
// OnboardingFlow — the three steps of the paid onboarding (s9.6).
//
//   1. Company   name, country, phone, industry, team size
//                → POST /api/onboarding/company (owner only)
//   2. Plan      `PlanPicker` as on /billing → PayPal
//   3. PayPal    /onboarding/return waits for the webhook (CheckoutReturn)
//
// Which step to show is decided on the SERVER (`loadOnboardingState`) and
// arrives as `state`: after saving the company this component asks the
// server again (`router.refresh()`), it never advances on its own say-so.
// The only local state is the form itself and "I want to correct the
// company details" on step 2.
// ============================================================

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, CreditCard, Loader2, Clock } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { PlanPicker } from '@/components/billing/plan-picker';
import {
  COUNTRIES,
  INDUSTRIES,
  MAX_NAME_LEN,
  TEAM_SIZES,
  validateCompanyProfile,
  type CompanyField,
} from '@/lib/onboarding/profile';
import type { OnboardingProfile, OnboardingStep } from '@/lib/onboarding/state';
import { cn } from '@/lib/utils';

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive';

export interface OnboardingFlowState {
  step: Exclude<OnboardingStep, 'done'>;
  canEditCompany: boolean;
  canPay: boolean;
  profile: OnboardingProfile;
}

/** Country names in the user's language, sorted by that name. */
function useCountryOptions() {
  const locale = useLocale();
  return useMemo(() => {
    let names: Intl.DisplayNames | null = null;
    try {
      names = new Intl.DisplayNames([locale], { type: 'region' });
    } catch {
      names = null;
    }
    return COUNTRIES.map((code) => ({
      code,
      label: names?.of(code) ?? code,
    })).sort((a, b) => a.label.localeCompare(b.label, locale));
  }, [locale]);
}

function Steps({ current }: { current: 1 | 2 | 3 }) {
  const t = useTranslations('Onboarding.steps');
  const items = [
    { n: 1, label: t('company'), icon: Building2 },
    { n: 2, label: t('plan'), icon: CreditCard },
    { n: 3, label: t('payment'), icon: Clock },
  ] as const;
  return (
    <ol
      className="mb-8 flex flex-wrap items-center gap-2 text-sm"
      aria-label={t('label')}
    >
      {items.map(({ n, label, icon: Icon }) => (
        <li
          key={n}
          aria-current={n === current ? 'step' : undefined}
          className={cn(
            'flex items-center gap-2 rounded-full border px-3 py-1',
            n === current
              ? 'border-primary bg-primary/10 text-foreground'
              : n < current
                ? 'border-border text-foreground'
                : 'border-border text-muted-foreground'
          )}
        >
          <Icon className="h-4 w-4" aria-hidden />
          <span>
            {n}. {label}
          </span>
        </li>
      ))}
    </ol>
  );
}

function CompanyForm({
  profile,
  onSaved,
}: {
  profile: OnboardingProfile;
  onSaved: (step: OnboardingStep) => void;
}) {
  const t = useTranslations('Onboarding.company');
  const countries = useCountryOptions();
  const [values, setValues] = useState({
    name: profile.name ?? '',
    country: profile.country ?? '',
    phone: profile.phone ?? '',
    industry: profile.industry ?? '',
    teamSize: profile.teamSize ?? '',
  });
  const [invalid, setInvalid] = useState<CompanyField | null>(null);
  const [saving, setSaving] = useState(false);

  const set = (field: keyof typeof values) => (value: string) => {
    setValues((v) => ({ ...v, [field]: value }));
    if (invalid === field) setInvalid(null);
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const check = validateCompanyProfile(values);
    if (!check.ok) {
      setInvalid(check.field);
      toast.error(t(`errors.${check.field}`));
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/onboarding/company', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(check.value),
      });
      const body = (await res.json().catch(() => ({}))) as {
        step?: OnboardingStep;
        field?: CompanyField;
      };
      if (!res.ok || !body.step) {
        if (body.field) setInvalid(body.field);
        toast.error(body.field ? t(`errors.${body.field}`) : t('saveFailed'));
        setSaving(false);
        return;
      }
      onSaved(body.step);
    } catch {
      toast.error(t('saveFailed'));
      setSaving(false);
    }
  };

  return (
    <Card>
      <CardContent className="p-6">
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>

        <form
          className="mt-6 grid gap-4 sm:grid-cols-2"
          onSubmit={submit}
          noValidate
        >
          <div className="flex flex-col gap-1.5 sm:col-span-2">
            <Label htmlFor="onb-name">{t('name')}</Label>
            <Input
              id="onb-name"
              value={values.name}
              maxLength={MAX_NAME_LEN}
              autoComplete="organization"
              aria-invalid={invalid === 'name' || undefined}
              onChange={(e) => set('name')(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onb-country">{t('country')}</Label>
            <select
              id="onb-country"
              className={SELECT_CLASS}
              value={values.country}
              aria-invalid={invalid === 'country' || undefined}
              onChange={(e) => set('country')(e.target.value)}
            >
              <option value="" disabled>
                {t('choose')}
              </option>
              {countries.map((c) => (
                <option key={c.code} value={c.code}>
                  {c.label}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onb-phone">{t('phone')}</Label>
            <Input
              id="onb-phone"
              type="tel"
              inputMode="tel"
              autoComplete="tel"
              placeholder={t('phonePlaceholder')}
              value={values.phone}
              aria-invalid={invalid === 'phone' || undefined}
              onChange={(e) => set('phone')(e.target.value)}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onb-industry">{t('industry')}</Label>
            <select
              id="onb-industry"
              className={SELECT_CLASS}
              value={values.industry}
              aria-invalid={invalid === 'industry' || undefined}
              onChange={(e) => set('industry')(e.target.value)}
            >
              <option value="" disabled>
                {t('choose')}
              </option>
              {INDUSTRIES.map((key) => (
                <option key={key} value={key}>
                  {t(`industries.${key}`)}
                </option>
              ))}
            </select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="onb-team">{t('teamSize')}</Label>
            <select
              id="onb-team"
              className={SELECT_CLASS}
              value={values.teamSize}
              aria-invalid={invalid === 'teamSize' || undefined}
              onChange={(e) => set('teamSize')(e.target.value)}
            >
              <option value="" disabled>
                {t('choose')}
              </option>
              {TEAM_SIZES.map((size) => (
                <option key={size} value={size}>
                  {t('teamSizeOption', { size })}
                </option>
              ))}
            </select>
          </div>

          <div className="flex justify-end sm:col-span-2">
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="h-4 w-4 animate-spin" />}
              {t('continue')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function Waiting({ title, body }: { title: string; body: string }) {
  return (
    <Card>
      <CardContent className="space-y-2 p-6">
        <h1 className="text-foreground text-2xl font-bold">{title}</h1>
        <p className="text-muted-foreground text-sm">{body}</p>
      </CardContent>
    </Card>
  );
}

export function OnboardingFlow({ state }: { state: OnboardingFlowState }) {
  const t = useTranslations('Onboarding');
  const router = useRouter();
  const [editingCompany, setEditingCompany] = useState(false);

  const onSaved = (step: OnboardingStep) => {
    if (step === 'done') {
      // Already paying (a manual plan, or paid before the onboarding
      // existed): step 1 was all that was missing. Full navigation so the
      // dashboard layout's gate runs on the server with the new profile.
      window.location.assign('/dashboard');
      return;
    }
    setEditingCompany(false);
    router.refresh();
  };

  const showCompany = state.step === 'company' || editingCompany;

  return (
    <div>
      <Steps current={showCompany ? 1 : 2} />

      {showCompany ? (
        state.canEditCompany ? (
          <CompanyForm profile={state.profile} onSaved={onSaved} />
        ) : (
          <Waiting title={t('ownerOnlyTitle')} body={t('ownerOnlyBody')} />
        )
      ) : (
        <div className="space-y-4">
          {!state.canPay && (
            <Waiting title={t('adminOnlyTitle')} body={t('adminOnlyBody')} />
          )}
          <PlanPicker />
          {state.canEditCompany && (
            <Button
              variant="link"
              className="px-0"
              onClick={() => setEditingCompany(true)}
            >
              {t('editCompany')}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
