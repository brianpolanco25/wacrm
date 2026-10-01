'use client';

// ============================================================
// «Estados de cuenta» on the operator's file (fase 10, s10.4).
//
// The list — period, total, status, due date — with what only the
// operator sees: the real cost at Meta (billable only), the margin, the
// messages delivered without a category, and the customer's «Ya pagué»
// note. On an open statement, two acts:
//
//   Confirmar pago  date, reference, note. No reason: the payment is.
//   Anular          a reason of at least MIN_REASON_LENGTH.
//
// Both reopen the account and move the cut-off a month from the period
// end (the routes do it; this only asks and reports).
//
// s10.7: under the figures, the reconciliation with Meta — what Meta's
// `pricing_analytics` reports for the period against our real cost, or
// «sin dato de Meta». Only shown: the difference is settled as a manual
// line on the next statement, and the text says so.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useLocale, useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';
import type { PlatformStatement } from '@/lib/platform/statements';
import type { StatementReconciliation } from '@/lib/billing/meta-reconciliation';
import {
  formatDay,
  formatPeriod,
  formatUsd,
} from '@/components/billing/statement-claim';

export type SettleResult =
  | { kind: 'done' }
  | {
      kind: 'error';
      reason: 'notOpen' | 'notFound' | 'invalid' | 'failed';
      detail?: string;
    };

/** POST confirm / void and say what happened. Pure of React. */
export async function settleStatementRequest(
  accountId: string,
  statementId: string,
  action: 'confirm' | 'void',
  body: Record<string, unknown>,
  doFetch: typeof fetch = fetch
): Promise<SettleResult> {
  try {
    const res = await doFetch(
      `/api/platform/accounts/${accountId}/statements/${statementId}/${action}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }
    );
    const json = (await res.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (res.ok) return { kind: 'done' };
    if (res.status === 409) return { kind: 'error', reason: 'notOpen' };
    if (res.status === 404) return { kind: 'error', reason: 'notFound' };
    if (res.status === 400) {
      return {
        kind: 'error',
        reason: 'invalid',
        detail: typeof json?.error === 'string' ? json.error : undefined,
      };
    }
    return { kind: 'error', reason: 'failed' };
  } catch {
    return { kind: 'error', reason: 'failed' };
  }
}

export function PlatformStatements({
  accountId,
  initial,
  onChanged,
}: {
  accountId: string;
  /** Pre-seeded list (tests); normally fetched. */
  initial?: PlatformStatement[];
  /** The file reloads: the subscription status moved. */
  onChanged?: () => void;
}) {
  const t = useTranslations('Platform.statements');
  const [statements, setStatements] = useState<PlatformStatement[] | null>(
    initial ?? null
  );
  const [failed, setFailed] = useState(false);

  const load = useCallback(async () => {
    setFailed(false);
    try {
      const res = await fetch(
        `/api/platform/accounts/${accountId}/statements`,
        {
          cache: 'no-store',
        }
      );
      if (!res.ok) throw new Error(String(res.status));
      const body = (await res.json()) as { statements?: PlatformStatement[] };
      setStatements(body.statements ?? []);
    } catch {
      setFailed(true);
      setStatements((s) => s ?? []);
    }
  }, [accountId]);

  useEffect(() => {
    if (initial) return;
    void load();
  }, [initial, load]);

  const changed = useCallback(() => {
    void load();
    onChanged?.();
  }, [load, onChanged]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4" data-platform-statements>
        <h2 className="text-foreground text-sm font-semibold">{t('title')}</h2>
        <p className="text-muted-foreground text-xs">{t('help')}</p>
        {failed ? (
          <p className="text-destructive text-sm">{t('loadFailed')}</p>
        ) : null}
        {statements === null ? (
          <p className="text-muted-foreground flex items-center gap-2 text-sm">
            <Loader2 className="size-4 animate-spin" />
            {t('loading')}
          </p>
        ) : statements.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('none')}</p>
        ) : (
          <ul className="flex flex-col gap-3">
            {statements.map((statement) => (
              <StatementItem
                key={statement.id}
                accountId={accountId}
                statement={statement}
                onChanged={changed}
              />
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}

function StatementItem({
  accountId,
  statement,
  onChanged,
}: {
  accountId: string;
  statement: PlatformStatement;
  onChanged: () => void;
}) {
  const t = useTranslations('Platform.statements');
  const locale = useLocale();
  const [open, setOpen] = useState<'confirm' | 'void' | null>(null);
  const [paidAt, setPaidAt] = useState('');
  const [reference, setReference] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;

  const submit = useCallback(
    async (action: 'confirm' | 'void') => {
      setBusy(true);
      try {
        const body =
          action === 'confirm'
            ? {
                ...(paidAt ? { paidAt } : {}),
                ...(reference.trim() ? { reference: reference.trim() } : {}),
                ...(note.trim() ? { note: note.trim() } : {}),
              }
            : { reason: reason.trim() };
        const result = await settleStatementRequest(
          accountId,
          statement.id,
          action,
          body
        );
        if (result.kind === 'error') {
          toast.error(
            result.reason === 'invalid'
              ? t('errors.invalid', { detail: result.detail ?? '' })
              : t(`errors.${result.reason}`)
          );
          return;
        }
        toast.success(action === 'confirm' ? t('confirmed') : t('voided'));
        setOpen(null);
        onChanged();
      } finally {
        setBusy(false);
      }
    },
    [accountId, note, onChanged, paidAt, reason, reference, statement.id, t]
  );

  const status =
    statement.status === 'issued' ||
    statement.status === 'paid' ||
    statement.status === 'void'
      ? t(`status.${statement.status}`)
      : statement.status;
  const voidReady = reason.trim().length >= MIN_REASON_LENGTH;

  return (
    <li
      className="flex flex-col gap-2 rounded-lg border p-3"
      data-statement={statement.id}
    >
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <span className="text-foreground font-medium">
          {formatPeriod(statement.periodStart, statement.periodEnd, locale)}
        </span>
        <Badge
          variant={statement.status === 'issued' ? 'destructive' : 'outline'}
        >
          {status}
        </Badge>
        <span className="font-semibold">{usd(statement.totalUsd)}</span>
        <span className="text-muted-foreground text-xs">
          {t('dueOn', { date: formatDay(statement.dueAt, locale) })}
        </span>
      </div>
      <p className="text-muted-foreground text-xs">
        {t('figures', {
          fee: usd(statement.planFeeUsd),
          overage: usd(statement.usageChargeUsd),
          cost: usd(statement.metaCostUsd),
          margin: usd(statement.marginUsd),
          messages: statement.messagesTotal,
          overageMessages: statement.overageMessages,
        })}
      </p>
      {statement.reconciliation ? (
        <Reconciliation
          reconciliation={statement.reconciliation}
          ourCostUsd={statement.metaCostUsd}
        />
      ) : null}
      {statement.uncategorized.total > 0 ? (
        <p className="text-muted-foreground text-xs" data-uncategorized>
          {t('uncategorized', {
            count: statement.uncategorized.total,
            detail: Object.entries(statement.uncategorized.byCategory)
              .map(([k, v]) => `${k}: ${v}`)
              .join(', '),
          })}
        </p>
      ) : null}
      {statement.claimedPaidAt ? (
        <p className="text-sm" data-claim>
          {t('claim', {
            date: formatDay(statement.claimedPaidAt, locale),
            note: statement.claimNote ?? '—',
          })}
        </p>
      ) : null}
      {statement.status === 'paid' ? (
        <p className="text-muted-foreground text-xs">
          {t('paid', {
            date: statement.paidAt ? formatDay(statement.paidAt, locale) : '—',
            reference: statement.paidReference ?? '—',
          })}
        </p>
      ) : null}

      {statement.status === 'issued' ? (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant={open === 'confirm' ? 'default' : 'outline'}
              onClick={() => setOpen(open === 'confirm' ? null : 'confirm')}
            >
              {t('confirm')}
            </Button>
            <Button
              size="sm"
              variant={open === 'void' ? 'destructive' : 'outline'}
              onClick={() => setOpen(open === 'void' ? null : 'void')}
            >
              {t('void')}
            </Button>
          </div>
          {open === 'confirm' ? (
            <div className="grid gap-2 sm:grid-cols-3" data-confirm-form>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`paid-at-${statement.id}`}>
                  {t('paidAtLabel')}
                </Label>
                <Input
                  id={`paid-at-${statement.id}`}
                  type="date"
                  value={paidAt}
                  onChange={(e) => setPaidAt(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`reference-${statement.id}`}>
                  {t('referenceLabel')}
                </Label>
                <Input
                  id={`reference-${statement.id}`}
                  value={reference}
                  onChange={(e) => setReference(e.target.value)}
                />
              </div>
              <div className="flex flex-col gap-1">
                <Label htmlFor={`note-${statement.id}`}>{t('noteLabel')}</Label>
                <Input
                  id={`note-${statement.id}`}
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                />
              </div>
              <p className="text-muted-foreground text-xs sm:col-span-3">
                {t('confirmHelp')}
              </p>
              <div>
                <Button
                  size="sm"
                  disabled={busy}
                  onClick={() => submit('confirm')}
                >
                  {busy ? <Loader2 className="size-4 animate-spin" /> : null}
                  {t('confirmSubmit')}
                </Button>
              </div>
            </div>
          ) : null}
          {open === 'void' ? (
            <div className="flex flex-col gap-2" data-void-form>
              <Label htmlFor={`void-reason-${statement.id}`}>
                {t('voidReasonLabel')}
              </Label>
              <Input
                id={`void-reason-${statement.id}`}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
              />
              <p className="text-muted-foreground text-xs">
                {t('voidHelp', { min: MIN_REASON_LENGTH })}
              </p>
              <div>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={busy || !voidReady}
                  onClick={() => submit('void')}
                >
                  {t('voidSubmit')}
                </Button>
              </div>
            </div>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function Reconciliation({
  reconciliation,
  ourCostUsd,
}: {
  reconciliation: StatementReconciliation;
  ourCostUsd: number;
}) {
  const t = useTranslations('Platform.statements');
  const locale = useLocale();
  const usd = (value: number) => `US$ ${formatUsd(value, locale)}`;
  const signed = (value: number) =>
    value > 0 ? `+${usd(value)}` : value < 0 ? `−${usd(-value)}` : usd(0);

  if (
    reconciliation.metaReportedCostUsd === null ||
    reconciliation.differenceUsd === null
  ) {
    return (
      <p className="text-muted-foreground text-xs" data-reconciliation="none">
        {t('reconciliation.noData')}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1 text-xs" data-reconciliation="data">
      <p className="text-muted-foreground">
        {t('reconciliation.figures', {
          meta: usd(reconciliation.metaReportedCostUsd),
          volume: reconciliation.volume ?? 0,
          ours: usd(ourCostUsd),
          difference: signed(reconciliation.differenceUsd),
        })}
      </p>
      {reconciliation.wabas.length > 1 ? (
        <ul className="text-muted-foreground flex flex-col">
          {reconciliation.wabas.map((w) => (
            <li key={w.wabaId}>
              {w.metaReportedCostUsd === null
                ? t('reconciliation.wabaNoData', { waba: w.wabaId })
                : t('reconciliation.waba', {
                    waba: w.wabaId,
                    meta: usd(w.metaReportedCostUsd),
                    volume: w.volume ?? 0,
                  })}
            </li>
          ))}
        </ul>
      ) : null}
      {reconciliation.partial ? (
        <p className="text-muted-foreground" data-reconciliation-partial>
          {reconciliation.lastFetchedAt
            ? t('reconciliation.partial', {
                date: formatDay(reconciliation.lastFetchedAt, locale),
              })
            : t('reconciliation.partialMissing')}
        </p>
      ) : null}
      <p className="text-muted-foreground">{t('reconciliation.adjust')}</p>
    </div>
  );
}
