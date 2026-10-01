'use client';

// ============================================================
// The operator's Resumen (s9.2, `/platform`): the whole service at a
// glance, from `GET /api/platform/metrics` (migration 069).
//
// Two rules the whole screen rests on:
//   - it opens on a LOADING state, never on zeros: an operator who reads
//     «0 accounts, $0 MRR» while the request is in flight will act on it;
//   - a failed load says so, out loud, instead of rendering empty cards.
//
// The weekly signups are bars drawn with plain SVG (CP5: no chart
// library). One series, one hue (the brand token), a native `<title>`
// per bar as the hover tooltip and a visually hidden table as the
// text alternative.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { Loader2, RefreshCw, ShieldAlert } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { PlatformMetrics, WeeklySignups } from '@/lib/platform/metrics';

export type OverviewState =
  | { kind: 'loading' }
  | { kind: 'error' }
  | { kind: 'ready'; metrics: PlatformMetrics };

/** Statuses with a translated label; anything else shows its raw key. */
const KNOWN_STATUSES = [
  'active',
  'trialing',
  'past_due',
  'suspended',
  'cancelled',
  'expired',
  'incomplete',
  'none',
] as const;

/** Money in USD, in the operator's locale. Pure; exported for tests. */
export function formatUsd(value: number, locale: string): string {
  return new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'USD',
    maximumFractionDigits: 2,
    minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
  }).format(value);
}

function formatCount(value: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(value);
}

/** Loads the metrics and hands the state to the view. */
export function PlatformOverview() {
  const [state, setState] = useState<OverviewState>({ kind: 'loading' });

  const load = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const res = await fetch('/api/platform/metrics', { cache: 'no-store' });
      if (!res.ok) throw new Error(String(res.status));
      setState({
        kind: 'ready',
        metrics: (await res.json()) as PlatformMetrics,
      });
    } catch {
      setState({ kind: 'error' });
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  return <PlatformOverviewView state={state} onRetry={load} />;
}

export function PlatformOverviewView({
  state,
  onRetry,
}: {
  state: OverviewState;
  onRetry?: () => void;
}) {
  const t = useTranslations('Platform.metrics');

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-foreground text-xl font-semibold">
            {t('title')}
          </h2>
          <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
        </div>
        {onRetry && state.kind !== 'loading' ? (
          <Button size="sm" variant="outline" onClick={onRetry}>
            <RefreshCw className="size-4" />
            {t('refresh')}
          </Button>
        ) : null}
      </div>

      {state.kind === 'loading' ? (
        <div
          className="text-muted-foreground flex items-center gap-2 p-6 text-sm"
          role="status"
          data-overview-state="loading"
        >
          <Loader2 className="size-4 animate-spin" />
          {t('loading')}
        </div>
      ) : state.kind === 'error' ? (
        <div
          className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm"
          role="alert"
          data-overview-state="error"
        >
          <ShieldAlert className="size-4" />
          {t('loadFailed')}
        </div>
      ) : (
        <Ready metrics={state.metrics} />
      )}
    </div>
  );
}

function Stat({
  id,
  label,
  value,
  hint,
}: {
  id: string;
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <Card data-metric={id} className="gap-2">
      <CardHeader>
        <CardTitle className="text-muted-foreground text-sm font-medium">
          {label}
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-foreground text-2xl font-semibold tabular-nums">
          {value}
        </p>
        {hint ? (
          <p className="text-muted-foreground mt-1 text-xs">{hint}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}

function Ready({ metrics }: { metrics: PlatformMetrics }) {
  const t = useTranslations('Platform.metrics');
  const locale = useLocale();
  const n = (v: number) => formatCount(v, locale);
  const usd = (v: number) => formatUsd(v, locale);

  const statuses = Object.entries(metrics.accounts.byStatus).sort(
    ([, a], [, b]) => b - a
  );

  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <Stat
          id="accounts"
          label={t('cards.accounts')}
          value={n(metrics.accounts.total)}
        />
        <Stat
          id="mrr"
          label={t('cards.mrr')}
          value={usd(metrics.revenue.mrrUsd)}
          hint={t('payingHint', { count: metrics.revenue.payingAccounts })}
        />
        <Stat
          id="arr"
          label={t('cards.arr')}
          value={usd(metrics.revenue.arrUsd)}
        />
        <Stat
          id="comped"
          label={t('cards.comped')}
          value={n(metrics.comped)}
          hint={t('compedHint')}
        />
        <Stat
          id="signups"
          label={t('cards.signups')}
          value={`${n(metrics.signups.last7Days)} / ${n(metrics.signups.last30Days)}`}
          hint={t('signupsHint')}
        />
        <Stat
          id="delinquent"
          label={t('cards.delinquent')}
          value={n(metrics.delinquent.total)}
          hint={t('delinquentHint', {
            pastDue: metrics.delinquent.pastDue,
            suspended: metrics.delinquent.suspended,
          })}
        />
        <Stat
          id="whatsapp"
          label={t('cards.whatsapp')}
          value={n(metrics.whatsapp.connected)}
        />
        <Stat
          id="messages"
          label={t('cards.messages')}
          value={`${n(metrics.messagesMonth.inbound)} / ${n(metrics.messagesMonth.outbound)}`}
          hint={t('messagesHint')}
        />
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        <Card data-metric="by-status">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t('byStatusTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {statuses.length === 0 ? (
              <p className="text-muted-foreground text-sm">{t('noAccounts')}</p>
            ) : (
              <ul className="flex flex-col gap-2 text-sm">
                {statuses.map(([status, count]) => (
                  <li
                    key={status}
                    className="flex items-center justify-between gap-3"
                    data-status={status}
                  >
                    <span className="text-muted-foreground">
                      {(KNOWN_STATUSES as readonly string[]).includes(status)
                        ? t(
                            `status.${status as (typeof KNOWN_STATUSES)[number]}`
                          )
                        : status}
                    </span>
                    <span className="text-foreground font-medium tabular-nums">
                      {n(count)}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card data-metric="weekly" className="lg:col-span-2">
          <CardHeader>
            <CardTitle className="text-sm font-medium">
              {t('weeklyTitle')}
            </CardTitle>
          </CardHeader>
          <CardContent>
            <WeeklyBars weeks={metrics.signups.weekly} locale={locale} />
          </CardContent>
        </Card>
      </div>
    </>
  );
}

const CHART_H = 120;
const BAR_W = 24;
const GAP = 8;
const LABEL_H = 18;

/** Short `d MMM` label for the Monday a bar stands for. */
function weekLabel(weekStart: string, locale: string): string {
  const d = new Date(`${weekStart}T00:00:00Z`);
  if (!Number.isFinite(d.getTime())) return weekStart;
  return new Intl.DateTimeFormat(locale, {
    day: 'numeric',
    month: 'short',
    timeZone: 'UTC',
  }).format(d);
}

export function WeeklyBars({
  weeks,
  locale,
}: {
  weeks: WeeklySignups[];
  locale: string;
}) {
  const t = useTranslations('Platform.metrics');
  if (weeks.length === 0) {
    return <p className="text-muted-foreground text-sm">{t('noSignups')}</p>;
  }

  const max = Math.max(1, ...weeks.map((w) => w.count));
  const width = weeks.length * (BAR_W + GAP) - GAP;

  return (
    <>
      <svg
        viewBox={`0 0 ${width} ${CHART_H + LABEL_H}`}
        className="h-auto max-h-48 w-full"
        role="img"
        aria-label={t('weeklyTitle')}
      >
        {/* Baseline, recessive. */}
        <line
          x1={0}
          x2={width}
          y1={CHART_H}
          y2={CHART_H}
          className="stroke-border"
          strokeWidth={1}
        />
        {weeks.map((w, i) => {
          const h = (w.count / max) * (CHART_H - 4);
          const x = i * (BAR_W + GAP);
          const label = weekLabel(w.weekStart, locale);
          return (
            <g key={w.weekStart} data-week={w.weekStart} data-count={w.count}>
              <title>{t('weekTooltip', { week: label, count: w.count })}</title>
              {/* Full-height hit target, bigger than the mark. */}
              <rect
                x={x}
                y={0}
                width={BAR_W}
                height={CHART_H}
                fill="transparent"
              />
              {h > 0 ? (
                <rect
                  x={x}
                  y={CHART_H - h}
                  width={BAR_W}
                  height={h}
                  rx={4}
                  className="fill-primary"
                />
              ) : null}
              {i % 2 === weeks.length % 2 ? null : (
                <text
                  x={x + BAR_W / 2}
                  y={CHART_H + LABEL_H - 4}
                  textAnchor="middle"
                  className="fill-muted-foreground text-[9px]"
                >
                  {label}
                </text>
              )}
            </g>
          );
        })}
      </svg>
      {/* sr-only on a wrapper, not on the <table>: a table ignores the
          1px height/overflow clip and, absolutely positioned, stretched
          the document past the h-screen shell (s9.11). */}
      <div className="sr-only">
        <table>
          <caption>{t('weeklyTitle')}</caption>
          <thead>
            <tr>
              <th scope="col">{t('weekColumn')}</th>
              <th scope="col">{t('countColumn')}</th>
            </tr>
          </thead>
          <tbody>
            {weeks.map((w) => (
              <tr key={w.weekStart}>
                <td>{weekLabel(w.weekStart, locale)}</td>
                <td>{w.count}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}
