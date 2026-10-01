'use client';

// ============================================================
// Meta consumption, live, in Settings → Subscription (fase 10, s10.5).
//
//   managed  «Consumo del ciclo»: package used over the included
//            messages (bar, 80 % and 100 % notices), overage by category
//            and the estimate at the cut-off (fee + overage).
//   direct   Meta's free service quota per number (bar, 80 % / 100 %)
//            and what Meta will charge this month.
//
// Everything comes from `GET /api/billing/meta-usage`; the only
// arithmetic here is a bar width. A missing Meta rate is a notice, never
// a broken panel. Renders nothing while loading or when the route fails
// (the rest of the subscription panel stays useful).
// ============================================================

import { useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';

import { Card, CardContent } from '@/components/ui/card';
import type { ManagedUsage, UsageAlert } from '@/lib/billing/meta-usage';
import { cn } from '@/lib/utils';

import { formatDay, formatRate, formatUsd } from './statement-claim';

export interface DirectUsageNumber {
  id: string;
  label: string | null;
  displayPhoneNumber: string | null;
  used: number;
  exhausted: boolean;
  percent: number;
  alert: UsageAlert;
}

export interface DirectUsage {
  metaBilling: 'direct';
  state: 'ok' | 'rate_pending';
  freeTier: number;
  monthStart: string;
  resetsAt: string;
  numbers: DirectUsageNumber[];
  metaCost: {
    totalUsd: number;
    byCategory: Array<{ category: string; billable: number; costUsd: number }>;
  } | null;
  missingRate: { market: string; category: string } | null;
}

export type MetaUsage = ManagedUsage | DirectUsage;

const CATEGORY_KEYS = new Set([
  'service',
  'utility',
  'marketing',
  'authentication',
  'authentication_international',
]);

/** The usage, or null on any error (403 below admin included). */
export async function fetchMetaUsage(
  doFetch: typeof fetch = fetch
): Promise<MetaUsage | null> {
  try {
    const res = await doFetch('/api/billing/meta-usage', {
      cache: 'no-store',
    });
    if (!res.ok) return null;
    const body = (await res.json()) as MetaUsage;
    return body?.metaBilling === 'managed' || body?.metaBilling === 'direct'
      ? body
      : null;
  } catch {
    return null;
  }
}

function Bar({ percent, alert }: { percent: number; alert: UsageAlert }) {
  return (
    <div
      className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
      role="presentation"
    >
      <div
        className={cn(
          'h-full rounded-full transition-all',
          alert === 'full'
            ? 'bg-destructive'
            : alert === 'warn'
              ? 'bg-amber-500'
              : 'bg-primary'
        )}
        style={{ width: `${Math.max(0, Math.min(100, percent))}%` }}
      />
    </div>
  );
}

export function MetaUsageCard({ initial }: { initial?: MetaUsage | null }) {
  const [usage, setUsage] = useState<MetaUsage | null>(initial ?? null);

  useEffect(() => {
    if (initial !== undefined) return;
    let alive = true;
    void fetchMetaUsage().then((value) => {
      if (alive) setUsage(value);
    });
    return () => {
      alive = false;
    };
  }, [initial]);

  if (!usage) return null;
  return usage.metaBilling === 'managed' ? (
    <ManagedUsageBlock usage={usage} />
  ) : (
    <DirectUsageBlock usage={usage} />
  );
}

function useCategoryLabel() {
  const ts = useTranslations('Billing.statements');
  return (value: string) =>
    CATEGORY_KEYS.has(value) ? ts(`category.${value}`) : value;
}

export function ManagedUsageBlock({ usage }: { usage: ManagedUsage }) {
  const t = useTranslations('Billing.metaUsage');
  const ts = useTranslations('Billing.statements');
  const locale = useLocale();
  const category = useCategoryLabel();
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;
  const count = (value: number) => value.toLocaleString(locale);

  return (
    <Card>
      <CardContent className="space-y-4 py-5" data-meta-usage="managed">
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t('managedTitle')}
          </h3>
          <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">
            {usage.cutAt
              ? t('managedPeriod', {
                  start: formatDay(usage.periodStart, locale),
                  cut: formatDay(usage.cutAt, locale),
                })
              : t('managedPeriodNoCut', {
                  start: formatDay(usage.periodStart, locale),
                })}
          </p>
        </div>

        {usage.state === 'pricing_missing' ? (
          <p className="text-muted-foreground text-sm" data-pricing-missing>
            {t('pricingMissing')}
          </p>
        ) : (
          <>
            <div>
              <div className="flex items-baseline justify-between gap-3 text-sm">
                <span className="text-foreground">{t('packageLabel')}</span>
                <span className="text-muted-foreground tabular-nums">
                  {t('packageOf', {
                    used: count(usage.packageUsed),
                    included: count(usage.includedMessages),
                  })}
                </span>
              </div>
              <Bar percent={usage.percent} alert={usage.alert} />
              {usage.alert ? (
                <p
                  className={cn(
                    'mt-2 text-sm',
                    usage.alert === 'full'
                      ? 'text-destructive'
                      : 'text-amber-600 dark:text-amber-400'
                  )}
                  data-usage-alert={usage.alert}
                >
                  {usage.alert === 'full'
                    ? t('packageFull', {
                        overage: count(usage.overageMessages),
                      })
                    : t('packageWarn', { percent: usage.percent })}
                </p>
              ) : null}
            </div>

            {usage.state === 'rate_pending' ? (
              <p
                className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
                data-rate-pending
              >
                {t('ratePending', {
                  category: category(usage.missingRate?.category ?? ''),
                  market: usage.missingRate?.market ?? '—',
                })}
              </p>
            ) : null}

            {usage.overageByCategory.length > 0 ? (
              <div className="overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="text-muted-foreground text-left text-xs">
                    <tr>
                      <th className="py-1 pr-3 font-medium">
                        {ts('col.category')}
                      </th>
                      <th className="py-1 pr-3 text-right font-medium">
                        {ts('col.overage')}
                      </th>
                      <th className="py-1 pr-3 text-right font-medium">
                        {ts('col.price')}
                      </th>
                      <th className="py-1 text-right font-medium">
                        {ts('col.amount')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {usage.overageByCategory.map((line) => (
                      <tr key={line.category} className="border-t">
                        <td className="py-1 pr-3">{category(line.category)}</td>
                        <td className="py-1 pr-3 text-right">
                          {count(line.messages)}
                        </td>
                        <td className="py-1 pr-3 text-right">
                          {line.unitPriceUsd === null
                            ? '—'
                            : `US$ ${formatRate(line.unitPriceUsd, locale)}`}
                        </td>
                        <td className="py-1 text-right">
                          {line.chargeUsd === null ? '—' : usd(line.chargeUsd)}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {usage.uncategorized > 0 ? (
              <p className="text-muted-foreground text-xs">
                {ts('uncategorized', { count: usage.uncategorized })}
              </p>
            ) : null}

            <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
              <dt className="text-muted-foreground">{ts('fee')}</dt>
              <dd className="text-right">{usd(usage.feeUsd)}</dd>
              <dt className="text-muted-foreground">{ts('overageTotal')}</dt>
              <dd className="text-right">
                {usage.overageUsd === null ? '—' : usd(usage.overageUsd)}
              </dd>
              <dt className="text-foreground font-semibold">
                {t('estimateLabel')}
              </dt>
              <dd className="text-right font-semibold" data-estimate>
                {usage.estimatedTotalUsd === null
                  ? t('estimatePending')
                  : usd(usage.estimatedTotalUsd)}
              </dd>
            </dl>
            {usage.paymentMethod === 'paypal' && usage.dueAtCutUsd !== null ? (
              <p className="text-muted-foreground text-xs" data-paypal-note>
                {t('paypalNote', { amount: usd(usage.dueAtCutUsd) })}
              </p>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('estimateNote')}</p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function DirectUsageBlock({ usage }: { usage: DirectUsage }) {
  const t = useTranslations('Billing.metaUsage');
  const locale = useLocale();
  const category = useCategoryLabel();
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;
  const count = (value: number) => value.toLocaleString(locale);

  return (
    <Card>
      <CardContent className="space-y-4 py-5" data-meta-usage="direct">
        <div>
          <h3 className="text-foreground text-sm font-semibold">
            {t('directTitle')}
          </h3>
          <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">
            {t('directDesc', {
              free: count(usage.freeTier),
              date: formatDay(usage.resetsAt, locale),
            })}
          </p>
        </div>

        {usage.numbers.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('noNumbers')}</p>
        ) : (
          <ul className="space-y-3">
            {usage.numbers.map((n) => (
              <li key={n.id} data-number={n.id}>
                <div className="flex items-baseline justify-between gap-3 text-sm">
                  <span className="text-foreground">
                    {n.label || n.displayPhoneNumber || t('unnamedNumber')}
                  </span>
                  <span className="text-muted-foreground tabular-nums">
                    {t('freeOf', {
                      used: count(n.used),
                      free: count(usage.freeTier),
                    })}
                  </span>
                </div>
                <Bar percent={n.percent} alert={n.alert} />
                {n.alert ? (
                  <p
                    className={cn(
                      'mt-1 text-xs',
                      n.alert === 'full'
                        ? 'text-destructive'
                        : 'text-amber-600 dark:text-amber-400'
                    )}
                    data-usage-alert={n.alert}
                  >
                    {n.alert === 'full'
                      ? t('freeFull')
                      : t('freeWarn', { percent: n.percent })}
                  </p>
                ) : null}
              </li>
            ))}
          </ul>
        )}

        {usage.state === 'rate_pending' ? (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-sm"
            data-rate-pending
          >
            {t('ratePending', {
              category: category(usage.missingRate?.category ?? ''),
              market: usage.missingRate?.market ?? '—',
            })}
          </p>
        ) : usage.metaCost ? (
          <div className="space-y-2">
            <div className="flex items-baseline justify-between gap-3 text-sm">
              <span className="text-foreground font-semibold">
                {t('metaCostLabel')}
              </span>
              <span className="font-semibold tabular-nums" data-meta-cost>
                {usd(usage.metaCost.totalUsd)}
              </span>
            </div>
            {usage.metaCost.byCategory.length > 0 ? (
              <ul className="text-muted-foreground space-y-0.5 text-xs">
                {usage.metaCost.byCategory.map((line) => (
                  <li
                    key={line.category}
                    className="flex justify-between gap-3"
                  >
                    <span>
                      {t('metaCostLine', {
                        category: category(line.category),
                        count: count(line.billable),
                      })}
                    </span>
                    <span className="tabular-nums">{usd(line.costUsd)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <p className="text-muted-foreground text-xs">{t('metaCostNote')}</p>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
