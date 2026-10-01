'use client';

// ============================================================
// «Estados de cuenta» on /billing (fase 10, s10.4): what a managed
// account owes at each cut-off, read-only.
//
// For each statement: period, status, due date, and the breakdown —
// number, category, delivered, how many went over the package, the price
// applied and the amount — with the fee and the total. Never the
// `billable` mark nor Meta's cost: `/api/billing/statements` does not
// send them. «Ya pagué» on an open one leaves a note for Cabbity.
//
// Renders nothing for an account with no statements (every account not
// on managed billing) or for a member below admin (the route 403s).
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import type { CustomerStatement } from '@/lib/billing/statements';

import {
  claimStatementPaid,
  formatDay,
  formatPeriod,
  formatRate,
  formatUsd,
} from './statement-claim';

const CATEGORY_KEYS = new Set([
  'service',
  'utility',
  'marketing',
  'authentication',
  'authentication_international',
]);

/** The account's statements; `[]` on 403 (below admin) or any error. */
async function fetchStatements(): Promise<CustomerStatement[]> {
  try {
    const res = await fetch('/api/billing/statements', { cache: 'no-store' });
    if (!res.ok) return [];
    const body = (await res.json()) as { statements?: CustomerStatement[] };
    return body.statements ?? [];
  } catch {
    return [];
  }
}

export function StatementsSection({
  initial,
}: {
  /** Pre-seeded list (tests); normally fetched. */
  initial?: CustomerStatement[];
}) {
  const t = useTranslations('Billing.statements');
  const [statements, setStatements] = useState<CustomerStatement[] | null>(
    initial ?? null
  );

  const load = useCallback(() => {
    void fetchStatements().then(setStatements);
  }, []);

  useEffect(() => {
    if (initial) return;
    let alive = true;
    void fetchStatements().then((list) => {
      if (alive) setStatements(list);
    });
    return () => {
      alive = false;
    };
  }, [initial]);

  if (!statements || statements.length === 0) return null;

  return (
    <section className="mt-8 flex flex-col gap-3" data-statements>
      <div>
        <h2 className="text-foreground text-lg font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-sm">{t('subtitle')}</p>
      </div>
      {statements.map((statement) => (
        <StatementCard
          key={statement.id}
          statement={statement}
          onClaimed={load}
        />
      ))}
      <p className="text-muted-foreground text-xs">{t('taxNote')}</p>
    </section>
  );
}

export function StatementCard({
  statement,
  onClaimed,
}: {
  statement: CustomerStatement;
  onClaimed: () => void;
}) {
  const t = useTranslations('Billing.statements');
  const locale = useLocale();
  const [busy, setBusy] = useState(false);
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;

  const claim = useCallback(async () => {
    setBusy(true);
    try {
      const outcome = await claimStatementPaid(statement.id);
      if (outcome.kind === 'claimed') {
        toast.success(t('claimed'));
        onClaimed();
      } else {
        toast.error(t(`claimErrors.${outcome.reason}`));
      }
    } finally {
      setBusy(false);
    }
  }, [onClaimed, statement.id, t]);

  const category = (value: string) =>
    CATEGORY_KEYS.has(value) ? t(`category.${value}`) : value;
  const status =
    statement.status === 'paid' ||
    statement.status === 'void' ||
    statement.status === 'issued'
      ? t(`status.${statement.status}`)
      : statement.status;

  return (
    <Card>
      <CardContent
        className="flex flex-col gap-3 p-4"
        data-statement={statement.id}
      >
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-foreground text-sm font-semibold">
            {formatPeriod(statement.periodStart, statement.periodEnd, locale)}
          </h3>
          <Badge
            variant={statement.status === 'issued' ? 'destructive' : 'outline'}
          >
            {status}
          </Badge>
          <span className="text-muted-foreground text-xs">
            {statement.status === 'paid' && statement.paidAt
              ? t('paidOn', { date: formatDay(statement.paidAt, locale) })
              : t('dueOn', { date: formatDay(statement.dueAt, locale) })}
          </span>
        </div>

        <p className="text-muted-foreground text-xs">
          {t('package', {
            used: Math.min(statement.messagesTotal, statement.includedMessages),
            included: statement.includedMessages,
            overage: statement.overageMessages,
          })}
        </p>

        {statement.lines.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-muted-foreground text-left text-xs">
                <tr>
                  <th className="py-1 pr-3 font-medium">{t('col.number')}</th>
                  <th className="py-1 pr-3 font-medium">{t('col.category')}</th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('col.delivered')}
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('col.overage')}
                  </th>
                  <th className="py-1 pr-3 text-right font-medium">
                    {t('col.price')}
                  </th>
                  <th className="py-1 text-right font-medium">
                    {t('col.amount')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {statement.lines.map((line, i) => (
                  <tr key={i} className="border-t">
                    <td className="py-1 pr-3">{line.number ?? '—'}</td>
                    <td className="py-1 pr-3">{category(line.category)}</td>
                    <td className="py-1 pr-3 text-right">{line.delivered}</td>
                    <td className="py-1 pr-3 text-right">{line.overage}</td>
                    <td className="py-1 pr-3 text-right">
                      US$ {formatRate(line.unitPriceUsd, locale)}
                    </td>
                    <td className="py-1 text-right">{usd(line.chargeUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : null}

        {statement.uncategorized > 0 ? (
          <p className="text-muted-foreground text-xs">
            {t('uncategorized', { count: statement.uncategorized })}
          </p>
        ) : null}

        <dl className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t('fee')}</dt>
          <dd className="text-right">
            {statement.planFeeUsd > 0
              ? usd(statement.planFeeUsd)
              : t('feeNone')}
          </dd>
          <dt className="text-muted-foreground">{t('overageTotal')}</dt>
          <dd className="text-right">{usd(statement.usageChargeUsd)}</dd>
          <dt className="text-foreground font-semibold">{t('total')}</dt>
          <dd className="text-right font-semibold" data-statement-total>
            {usd(statement.totalUsd)}
          </dd>
        </dl>

        {statement.status === 'issued' ? (
          <div className="flex flex-wrap items-center gap-2">
            {statement.claimedPaidAt ? (
              <span className="text-muted-foreground text-xs">
                {t('claimedOn', {
                  date: formatDay(statement.claimedPaidAt, locale),
                })}
              </span>
            ) : (
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={claim}
              >
                {t('claim')}
              </Button>
            )}
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
