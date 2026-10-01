'use client';

// ============================================================
// Managed Meta billing on the file of a company (fase 10, s10.3):
//
//   - ManagedTermsFields: what «Asignar plan a mano» adds for a plan with
//     a Meta price policy (`gestionado`): payment method, «Meta lo paga
//     Cabbity» and the price (included messages, fee, overage per
//     category), preloaded from the plan and editable.
//   - CheckoutLinkNotice: the PayPal approval link of a managed account
//     paid through PayPal, for the operator to send to the owner (no
//     mail provider). Kept by the file, like the invitation link.
//   - ManagedPricingCard: «Precio de Meta gestionado», the price and the
//     payment method of an account already on managed billing.
//
// The routes validate everything again (`parseMetaPricing`); the UI only
// asks and reports.
// ============================================================

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';
import { META_CATEGORIES } from '@/lib/billing/meta-rates';

import {
  formToPricing,
  pricingToForm,
  type ManagedTermsForm,
  type PaymentMethodChoice,
  type PriceMode,
  type PricingForm,
} from './managed-form';

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

const METHODS: readonly PaymentMethodChoice[] = ['manual', 'paypal'];
const MODES: readonly PriceMode[] = ['multiplier', 'usd'];

// ------------------------------------------------------------
// The price fields, shared by the assignment and the later edit
// ------------------------------------------------------------

export function PricingFields({
  idPrefix,
  value,
  onChange,
}: {
  idPrefix: string;
  value: PricingForm;
  onChange: (next: PricingForm) => void;
}) {
  const t = useTranslations('Platform.managed');
  return (
    <div className="flex flex-col gap-3" data-pricing-fields={idPrefix}>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-included`}>{t('included')}</Label>
          <Input
            id={`${idPrefix}-included`}
            inputMode="numeric"
            value={value.included}
            onChange={(e) => onChange({ ...value, included: e.target.value })}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`${idPrefix}-fee`}>{t('fee')}</Label>
          <Input
            id={`${idPrefix}-fee`}
            inputMode="decimal"
            value={value.fee}
            onChange={(e) => onChange({ ...value, fee: e.target.value })}
          />
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <p className="text-foreground text-xs font-medium">
          {t('overageTitle')}
        </p>
        <p className="text-muted-foreground text-xs">{t('overageHelp')}</p>
        {META_CATEGORIES.map((category) => {
          const field = value.overage[category];
          const set = (patch: Partial<typeof field>) =>
            onChange({
              ...value,
              overage: { ...value.overage, [category]: { ...field, ...patch } },
            });
          return (
            <div
              key={category}
              className="grid items-center gap-2 sm:grid-cols-[1fr_10rem_8rem]"
              data-overage={category}
            >
              <Label htmlFor={`${idPrefix}-${category}`}>
                {t(`category.${category}`)}
              </Label>
              <select
                aria-label={t('modeLabel')}
                className={SELECT_CLASS}
                value={field.mode}
                onChange={(e) => set({ mode: e.target.value as PriceMode })}
              >
                {MODES.map((mode) => (
                  <option key={mode} value={mode}>
                    {t(`mode.${mode}`)}
                  </option>
                ))}
              </select>
              <Input
                id={`${idPrefix}-${category}`}
                inputMode="decimal"
                value={field.value}
                onChange={(e) => set({ value: e.target.value })}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function MethodSelect({
  id,
  value,
  onChange,
}: {
  id: string;
  value: PaymentMethodChoice;
  onChange: (next: PaymentMethodChoice) => void;
}) {
  const t = useTranslations('Platform.managed');
  return (
    <select
      id={id}
      className={SELECT_CLASS}
      value={value}
      onChange={(e) => onChange(e.target.value as PaymentMethodChoice)}
    >
      {METHODS.map((method) => (
        <option key={method} value={method}>
          {t(`methods.${method}`)}
        </option>
      ))}
    </select>
  );
}

// ------------------------------------------------------------
// «Asignar plan a mano», for a plan with a price policy
// ------------------------------------------------------------

export function ManagedTermsFields({
  value,
  onChange,
}: {
  value: ManagedTermsForm;
  onChange: (next: ManagedTermsForm) => void;
}) {
  const t = useTranslations('Platform.managed');
  return (
    <div
      className="border-border flex flex-col gap-3 rounded-lg border p-3"
      data-managed-terms
    >
      <div>
        <h3 className="text-foreground text-sm font-semibold">
          {t('termsTitle')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('termsHelp')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor="managed-method">{t('paymentMethod')}</Label>
        <MethodSelect
          id="managed-method"
          value={value.paymentMethod}
          onChange={(paymentMethod) => onChange({ ...value, paymentMethod })}
        />
        <p className="text-muted-foreground text-xs">
          {value.paymentMethod === 'paypal' ? t('paypalHelp') : t('manualHelp')}
        </p>
      </div>
      <div className="flex items-start gap-2">
        <Checkbox
          id="managed-meta"
          checked={value.managed}
          onCheckedChange={(checked) =>
            onChange({ ...value, managed: checked === true })
          }
        />
        <div className="flex flex-col gap-0.5">
          <Label htmlFor="managed-meta">{t('metaManaged')}</Label>
          <p className="text-muted-foreground text-xs">
            {value.managed ? t('metaManagedHelp') : t('metaDirectHelp')}
          </p>
        </div>
      </div>
      {value.managed ? (
        <PricingFields
          idPrefix="managed-price"
          value={value.pricing}
          onChange={(pricing) => onChange({ ...value, pricing })}
        />
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// The PayPal link, kept by the file
// ------------------------------------------------------------

export function CheckoutLinkNotice({ url }: { url: string | null }) {
  const t = useTranslations('Platform.managed');
  if (!url) return null;
  return (
    <Card>
      <CardContent className="flex flex-col gap-2 p-4" role="status">
        <h2 className="text-foreground text-sm font-semibold">
          {t('checkoutTitle')}
        </h2>
        <p className="text-muted-foreground text-xs">{t('checkoutHelp')}</p>
        <Input
          readOnly
          value={url}
          onFocus={(e) => e.target.select()}
          data-checkout-link
        />
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------
// «Precio de Meta gestionado»
// ------------------------------------------------------------

export type ManagedPricingSave =
  | { kind: 'saved'; changed: boolean }
  | {
      kind: 'error';
      reason:
        'notManaged' | 'paypalActive' | 'needsCheckout' | 'invalid' | 'failed';
      detail?: string;
    };

/** PATCH the price and say what happened. Pure of React, for the tests. */
export async function saveManagedPricing(
  accountId: string,
  body: { reason: string; metaPricing: unknown; paymentMethod: string },
  doFetch: typeof fetch = fetch
): Promise<ManagedPricingSave> {
  const res = await doFetch(
    `/api/platform/accounts/${accountId}/meta-pricing`,
    {
      method: 'PATCH',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    }
  );
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (res.ok) return { kind: 'saved', changed: Boolean(json?.changed) };
  const code = json?.code;
  if (code === 'not_managed') return { kind: 'error', reason: 'notManaged' };
  if (code === 'paypal_active') {
    return { kind: 'error', reason: 'paypalActive' };
  }
  if (code === 'needs_checkout') {
    return { kind: 'error', reason: 'needsCheckout' };
  }
  if (res.status === 400) {
    return {
      kind: 'error',
      reason: 'invalid',
      detail: typeof json?.error === 'string' ? json.error : undefined,
    };
  }
  return { kind: 'error', reason: 'failed' };
}

export function ManagedPricingCard({
  accountId,
  metaPricing,
  paymentMethod,
  onChanged,
}: {
  accountId: string;
  metaPricing: unknown;
  paymentMethod: PaymentMethodChoice | null;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.managed');
  const [form, setForm] = useState<PricingForm>(() =>
    pricingToForm(metaPricing)
  );
  const [method, setMethod] = useState<PaymentMethodChoice>(
    paymentMethod ?? 'manual'
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const ready = reason.trim().length >= MIN_REASON_LENGTH;

  const save = useCallback(async () => {
    if (!ready) return;
    const pricing = formToPricing(form);
    if (!pricing.ok) {
      toast.error(t('invalidPricing', { error: pricing.error }));
      return;
    }
    setBusy(true);
    try {
      const outcome = await saveManagedPricing(accountId, {
        reason: reason.trim(),
        metaPricing: pricing.value,
        paymentMethod: method,
      });
      if (outcome.kind === 'error') {
        toast.error(
          outcome.reason === 'invalid'
            ? t('invalidPricing', { error: outcome.detail ?? '' })
            : t(`errors.${outcome.reason}`)
        );
        return;
      }
      toast.success(outcome.changed ? t('saved') : t('unchanged'));
      setReason('');
      onChanged();
    } catch {
      toast.error(t('errors.failed'));
    } finally {
      setBusy(false);
    }
  }, [accountId, form, method, onChanged, ready, reason, t]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4" data-managed-pricing>
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold">
            {t('pricingTitle')}
          </h2>
          <Badge variant="secondary">{t('managedBadge')}</Badge>
          <Badge variant="outline">
            {paymentMethod ? t(`methodShort.${paymentMethod}`) : '—'}
          </Badge>
        </div>
        <p className="text-muted-foreground text-xs">{t('pricingHelp')}</p>
        <div className="flex flex-col gap-1">
          <Label htmlFor="managed-edit-method">{t('paymentMethod')}</Label>
          <MethodSelect
            id="managed-edit-method"
            value={method}
            onChange={setMethod}
          />
          <p className="text-muted-foreground text-xs">
            {t('methodChangeHelp')}
          </p>
        </div>
        <PricingFields
          idPrefix="managed-edit"
          value={form}
          onChange={setForm}
        />
        <div className="flex flex-col gap-1">
          <Label htmlFor="managed-edit-reason">{t('reasonLabel')}</Label>
          <Input
            id="managed-edit-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-muted-foreground text-xs">
            {t('reasonHelp', { min: MIN_REASON_LENGTH })}
          </p>
        </div>
        <div>
          <Button size="sm" disabled={busy || !ready} onClick={save}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('save')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
