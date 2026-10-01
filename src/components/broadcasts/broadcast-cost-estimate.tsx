'use client';

// ============================================================
// What a broadcast will cost, on the scheduling step (fase 10, s10.5).
//
//   direct   «{n} destinatarios × US$ {rate} = US$ {x}» at Meta's rate.
//   managed  how many fit in the package and how many go to overage, at
//            what price. When there is overage the confirmation dialog
//            asks for an explicit tick before sending
//            (`needsOverageConsent`).
//
// Information only (CP11): a missing rate says so and never blocks the
// send; the tick is a dialog of the client, not a server guard.
// ============================================================

import { useLocale, useTranslations } from 'next-intl';

import { formatRate, formatUsd } from '@/components/billing/statement-claim';
import type {
  BroadcastEstimate,
  BroadcastCategory,
} from '@/lib/billing/meta-usage';

/** The estimate for this send, or null on any error (no line shown). */
export async function fetchBroadcastEstimate(
  args: {
    recipients: number;
    whatsAppConfigId: string | null;
    category: BroadcastCategory;
  },
  doFetch: typeof fetch = fetch
): Promise<BroadcastEstimate | null> {
  const params = new URLSearchParams({
    recipients: String(Math.max(0, Math.floor(args.recipients))),
    category: args.category,
  });
  if (args.whatsAppConfigId) {
    params.set('whatsappConfigId', args.whatsAppConfigId);
  }
  try {
    const res = await doFetch(`/api/billing/broadcast-estimate?${params}`, {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as BroadcastEstimate;
    return body?.metaBilling === 'managed' || body?.metaBilling === 'direct'
      ? body
      : null;
  } catch {
    return null;
  }
}

/** The template's category as the estimate route takes it. */
export function templateCategory(value: unknown): BroadcastCategory {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return v === 'utility' || v === 'authentication' ? v : 'marketing';
}

/** True when sending generates overage: the dialog asks for a tick. */
export function needsOverageConsent(
  estimate: BroadcastEstimate | null
): boolean {
  return estimate?.metaBilling === 'managed' && estimate.overage > 0;
}

export function BroadcastCostEstimate({
  estimate,
}: {
  estimate: BroadcastEstimate;
}) {
  const t = useTranslations('Broadcasts.wizard.scheduleSend.cost');
  const tc = useTranslations('Billing.statements.category');
  const locale = useLocale();
  const count = (value: number) => value.toLocaleString(locale);
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;
  const rate = (value: number) => `US$ ${formatRate(value, locale)}`;
  const category = tc(estimate.category);

  if (estimate.metaBilling === 'direct') {
    return (
      <div className="text-sm" data-broadcast-cost="direct">
        {estimate.ratePending || estimate.unitUsd === null ? (
          <p className="text-muted-foreground" data-rate-pending>
            {t('ratePending', { category })}
          </p>
        ) : (
          <p className="text-foreground">
            {t('direct', {
              recipients: count(estimate.recipients),
              category,
              rate: rate(estimate.unitUsd),
              total: usd(estimate.totalUsd ?? 0),
            })}
          </p>
        )}
        <p className="text-muted-foreground mt-1 text-xs">{t('directNote')}</p>
      </div>
    );
  }

  return (
    <div className="space-y-1 text-sm" data-broadcast-cost="managed">
      <p className="text-foreground">
        {t('managedPackage', {
          inPackage: count(estimate.inPackage),
          remaining: count(estimate.remaining),
        })}
      </p>
      {estimate.overage > 0 ? (
        estimate.unitPriceUsd === null ? (
          <p className="text-amber-600 dark:text-amber-400" data-rate-pending>
            {t('managedOveragePending', {
              overage: count(estimate.overage),
              category,
            })}
          </p>
        ) : (
          <p
            className="text-amber-600 dark:text-amber-400"
            data-overage={estimate.overage}
          >
            {t('managedOverage', {
              overage: count(estimate.overage),
              category,
              price: rate(estimate.unitPriceUsd),
              total: usd(estimate.overageUsd ?? 0),
            })}
          </p>
        )
      ) : (
        <p className="text-muted-foreground">{t('managedNoOverage')}</p>
      )}
    </div>
  );
}

/** The sentence the confirmation tick carries. */
export function OverageConsentText({
  estimate,
}: {
  estimate: BroadcastEstimate;
}) {
  const t = useTranslations('Broadcasts.wizard.scheduleSend.cost');
  const locale = useLocale();
  if (estimate.metaBilling !== 'managed') return null;
  return (
    <>
      {estimate.overageUsd === null
        ? t('consentPending', {
            overage: estimate.overage.toLocaleString(locale),
          })
        : t('consent', {
            overage: estimate.overage.toLocaleString(locale),
            total: `US$ ${formatUsd(estimate.overageUsd, locale)}`,
          })}
    </>
  );
}
