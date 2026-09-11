'use client';

// ============================================================
// SubscriptionPanel — Settings → Subscription (Fase 3 §6).
//
// Four blocks, exactly the four the spec asks for: plan and status,
// consumption of the cycle against the plan's limits, receipts, and
// the three actions (change plan, cancel, reactivate).
//
// Everything it shows comes from `GET /api/billing/subscription` in one
// round trip, including the usage figures — which are `usage_counters`
// verbatim, not a number this component derives. The only arithmetic
// here is a bar width.
//
// Nothing here decides a status. Cancelling and changing plan tell
// PayPal and then say "we are waiting": the webhook of §3 is what turns
// the answer into service. A panel that flipped the badge to "Active"
// on its own would be the return-URL mistake of §2 wearing a different
// hat.
//
// Visible to admin+ (`RequireRole`), and it must keep working while the
// account is read-only — a suspended tenant staring at a settings page
// that refuses to load its own billing has no way out.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { ExternalLink, Loader2 } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RequireRole } from '@/components/auth/require-role';
import { cn } from '@/lib/utils';

import { SettingsPanelHead } from './settings-panel-head';

type Cycle = 'month' | 'year';

interface UsageLine {
  metric: string;
  used: number;
  limit: number | null;
  percent: number | null;
}

interface Receipt {
  id: string;
  transactionId: string | null;
  amount: string | null;
  currency: string | null;
  paidAt: string | null;
  link: string | null;
}

interface SubscriptionData {
  planId: string;
  planName: string | null;
  status: string;
  readOnly: boolean;
  cycle: Cycle | null;
  cancelAtPeriodEnd: boolean;
  currentPeriodEnd: string | null;
  graceUntil: string | null;
  trialEndsAt: string | null;
  nextChargeAt: string | null;
  usage: UsageLine[];
  receipts: Receipt[];
  actions: {
    cancel: boolean;
    reactivate: 'activate' | 'checkout' | null;
    changePlan: 'revise' | 'checkout';
  };
}

interface CataloguePlan {
  id: string;
  name: string;
  availableCycles: { month: boolean; year: boolean };
}

/** i18n key for a usage metric; unknown metrics print their raw key. */
const METRIC_KEY: Record<string, string> = {
  messages_out: 'metricMessagesOut',
  ai_replies: 'metricAiReplies',
  broadcast_recipients: 'metricBroadcastRecipients',
};

const STATUS_TONE: Record<string, 'default' | 'secondary' | 'destructive'> = {
  trialing: 'secondary',
  active: 'default',
  past_due: 'destructive',
  suspended: 'destructive',
  cancelled: 'secondary',
  expired: 'destructive',
};

function fmtDate(iso: string | null): string | null {
  if (!iso) return null;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function SubscriptionPanel() {
  const t = useTranslations('Billing');
  const ts = useTranslations('Billing.subscription');
  const router = useRouter();

  const [data, setData] = useState<SubscriptionData | null>(null);
  const [loading, setLoading] = useState(true);
  const [plans, setPlans] = useState<CataloguePlan[]>([]);
  const [busy, setBusy] = useState<null | 'cancel' | 'reactivate' | 'change'>(
    null
  );
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [targetPlan, setTargetPlan] = useState<string>('');
  const [targetCycle, setTargetCycle] = useState<Cycle>('month');

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/billing/subscription', {
        cache: 'no-store',
      });
      if (!res.ok)
        throw new Error(`subscription request failed: ${res.status}`);
      const payload = (await res.json()) as SubscriptionData;
      setData(payload);
      setTargetPlan(payload.planId);
      setTargetCycle(payload.cycle ?? 'month');
    } catch {
      // Same treatment as a refused response: say so once and stop
      // spinning. Inventing a status out of a network blip would be
      // worse than an empty panel with an error on it.
      toast.error(ts('loadFailed'));
      setData(null);
    } finally {
      setLoading(false);
    }
  }, [ts]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/billing/plans', { cache: 'no-store' });
        if (!res.ok) return;
        const payload = (await res.json()) as { plans?: CataloguePlan[] };
        if (!cancelled) setPlans(payload.plans ?? []);
      } catch {
        // The catalogue only feeds the "change plan" selector. Without
        // it the rest of the panel is still useful, so this stays quiet.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const act = useCallback(
    async (
      key: 'cancel' | 'reactivate' | 'change',
      body: Record<string, unknown>,
      done: (payload: Record<string, unknown>) => void
    ) => {
      setBusy(key);
      try {
        const res = await fetch('/api/billing/subscription', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const payload = (await res.json().catch(() => ({}))) as Record<
          string,
          unknown
        >;
        if (!res.ok) {
          toast.error(
            typeof payload.error === 'string'
              ? payload.error
              : ts('actionFailed')
          );
          return;
        }
        done(payload);
      } catch {
        toast.error(ts('actionFailed'));
      } finally {
        setBusy(null);
      }
    },
    [ts]
  );

  const onCancel = () =>
    act('cancel', { action: 'cancel' }, () => {
      setConfirmCancel(false);
      toast.success(ts('cancelDone'));
      load();
    });

  const onReactivate = () =>
    act('reactivate', { action: 'reactivate' }, () => {
      toast.success(ts('reactivateDone'));
      load();
    });

  const onChangePlan = () =>
    act(
      'change',
      { action: 'change_plan', planId: targetPlan, cycle: targetCycle },
      (payload) => {
        const approvalUrl = payload.approvalUrl;
        if (typeof approvalUrl === 'string' && approvalUrl) {
          // PayPal wants the buyer to approve the new amount. Nothing
          // has changed there yet, so this is a redirect, not a
          // confirmation.
          toast.info(ts('changePlanApproval'));
          window.location.assign(approvalUrl);
          return;
        }
        toast.success(ts('changePlanRequested'));
        load();
      }
    );

  if (loading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="text-muted-foreground size-5 animate-spin" />
      </div>
    );
  }

  if (!data) {
    return (
      <div>
        <SettingsPanelHead title={ts('title')} description={ts('desc')} />
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {ts('loadFailed')}
          </CardContent>
        </Card>
      </div>
    );
  }

  const periodEnd = fmtDate(data.currentPeriodEnd);
  const nextCharge = fmtDate(data.nextChargeAt);
  const graceDate = fmtDate(data.graceUntil);
  const trialEnd = fmtDate(data.trialEndsAt);

  // One sentence that says where this account stands. Ordered by how
  // much it matters to the person reading it.
  const note = data.cancelAtPeriodEnd
    ? periodEnd
      ? ts('cancelScheduled', { date: periodEnd })
      : ts('cancelScheduledNoDate')
    : data.readOnly
      ? t('lockedBody')
      : data.status === 'past_due'
        ? graceDate
          ? t('pastDueBodyWithDate', { date: graceDate })
          : t('pastDueBody')
        : data.status === 'trialing'
          ? trialEnd
            ? ts('trialEnds', { date: trialEnd })
            : ts('trialNoDate')
          : data.status === 'cancelled' || data.status === 'expired'
            ? ts('noSubscription')
            : null;

  const cycleLabel =
    data.cycle === 'year'
      ? ts('cycleYear')
      : data.cycle === 'month'
        ? ts('cycleMonth')
        : ts('cycleUnknown');

  const selectedPlan = plans.find((p) => p.id === targetPlan);
  const cycleAvailable =
    !selectedPlan ||
    (targetCycle === 'year'
      ? selectedPlan.availableCycles.year
      : selectedPlan.availableCycles.month);
  const sameAsNow = targetPlan === data.planId && targetCycle === data.cycle;

  return (
    <RequireRole
      min="admin"
      fallback={
        <Card>
          <CardContent className="text-muted-foreground py-8 text-center text-sm">
            {t('adminOnly')}
          </CardContent>
        </Card>
      }
    >
      <div className="space-y-6">
        <SettingsPanelHead title={ts('title')} description={ts('desc')} />

        {/* ---- Plan, status and next charge ---- */}
        <Card>
          <CardContent className="space-y-4 py-5">
            <div className="flex flex-wrap items-center gap-3">
              <span className="text-foreground text-lg font-semibold">
                {data.planName ?? data.planId}
              </span>
              <Badge variant={STATUS_TONE[data.status] ?? 'secondary'}>
                {ts(`status.${data.status}`)}
              </Badge>
              <span className="text-muted-foreground text-xs">
                {cycleLabel}
              </span>
            </div>

            {note ? (
              <p className="text-muted-foreground max-w-[70ch] text-sm">
                {note}
              </p>
            ) : null}

            <dl className="grid gap-4 sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {ts('nextChargeLabel')}
                </dt>
                <dd className="text-foreground mt-1 text-sm">
                  {nextCharge ?? ts('noNextCharge')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
                  {ts('periodEndLabel')}
                </dt>
                <dd className="text-foreground mt-1 text-sm">
                  {periodEnd ?? ts('noNextCharge')}
                </dd>
              </div>
            </dl>

            <div className="flex flex-wrap gap-2">
              {data.actions.changePlan === 'checkout' ? (
                <Button size="sm" onClick={() => router.push('/billing')}>
                  {ts('goToPlans')}
                </Button>
              ) : null}
              {data.actions.reactivate === 'activate' ? (
                <Button
                  size="sm"
                  onClick={onReactivate}
                  disabled={busy !== null}
                >
                  {busy === 'reactivate' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {ts('reactivate')}
                </Button>
              ) : null}
              {data.actions.reactivate === 'checkout' ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => router.push('/billing')}
                >
                  {ts('reactivateCheckout')}
                </Button>
              ) : null}
              {data.actions.cancel ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setConfirmCancel(true)}
                  disabled={busy !== null}
                >
                  {ts('cancelAction')}
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>

        {/* ---- Change plan (only with a live PayPal subscription) ---- */}
        {data.actions.changePlan === 'revise' ? (
          <Card>
            <CardContent className="space-y-4 py-5">
              <div>
                <h3 className="text-foreground text-sm font-semibold">
                  {ts('changePlan')}
                </h3>
                <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">
                  {ts('changePlanNote')}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <Select
                  value={targetPlan}
                  onValueChange={(v) => setTargetPlan(v ?? '')}
                >
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {plans.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                <Select
                  value={targetCycle}
                  onValueChange={(v) =>
                    setTargetCycle(v === 'year' ? 'year' : 'month')
                  }
                >
                  <SelectTrigger className="w-[150px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="month">{t('cycleMonthly')}</SelectItem>
                    <SelectItem value="year">{t('cycleYearly')}</SelectItem>
                  </SelectContent>
                </Select>
                <Button
                  size="sm"
                  onClick={onChangePlan}
                  disabled={busy !== null || sameAsNow || !cycleAvailable}
                >
                  {busy === 'change' ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : null}
                  {ts('changePlanApply')}
                </Button>
              </div>
              {!cycleAvailable ? (
                <p className="text-muted-foreground text-xs">
                  {t('cycleUnavailable')}
                </p>
              ) : null}
            </CardContent>
          </Card>
        ) : null}

        {/* ---- Consumption of the cycle ---- */}
        <Card>
          <CardContent className="space-y-4 py-5">
            <div>
              <h3 className="text-foreground text-sm font-semibold">
                {ts('usageTitle')}
              </h3>
              <p className="text-muted-foreground mt-1 max-w-[70ch] text-sm">
                {ts('usageDesc')}
              </p>
            </div>
            <ul className="space-y-3">
              {data.usage.map((line) => (
                <li key={line.metric}>
                  <div className="flex items-baseline justify-between gap-3 text-sm">
                    <span className="text-foreground">
                      {METRIC_KEY[line.metric]
                        ? ts(METRIC_KEY[line.metric])
                        : line.metric}
                    </span>
                    <span className="text-muted-foreground tabular-nums">
                      {line.limit === null
                        ? ts('usageUnlimited', { used: line.used })
                        : ts('usageOf', {
                            used: line.used,
                            limit: line.limit,
                          })}
                    </span>
                  </div>
                  <div
                    className="bg-muted mt-1.5 h-1.5 w-full overflow-hidden rounded-full"
                    role="presentation"
                  >
                    <div
                      className={cn(
                        'h-full rounded-full transition-all',
                        (line.percent ?? 0) >= 100
                          ? 'bg-destructive'
                          : 'bg-primary'
                      )}
                      style={{ width: `${line.percent ?? 0}%` }}
                    />
                  </div>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {/* ---- Receipts ---- */}
        <Card>
          <CardContent className="space-y-4 py-5">
            <h3 className="text-foreground text-sm font-semibold">
              {ts('receiptsTitle')}
            </h3>
            {data.receipts.length === 0 ? (
              <p className="text-muted-foreground text-sm">
                {ts('receiptsEmpty')}
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{ts('receiptDate')}</TableHead>
                    <TableHead>{ts('receiptAmount')}</TableHead>
                    <TableHead>{ts('receiptTransaction')}</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.receipts.map((r) => (
                    <TableRow key={r.id}>
                      <TableCell>{fmtDate(r.paidAt) ?? '—'}</TableCell>
                      <TableCell className="tabular-nums">
                        {r.amount
                          ? `${r.amount} ${r.currency ?? ''}`.trim()
                          : '—'}
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {r.transactionId ?? '—'}
                      </TableCell>
                      <TableCell className="text-right">
                        {r.link ? (
                          <a
                            href={r.link}
                            target="_blank"
                            rel="noreferrer noopener"
                            className="text-primary inline-flex items-center gap-1 text-xs"
                          >
                            {ts('receiptLink')}
                            <ExternalLink className="size-3" />
                          </a>
                        ) : null}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>

        <Dialog open={confirmCancel} onOpenChange={setConfirmCancel}>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>{ts('cancelConfirmTitle')}</DialogTitle>
              <DialogDescription>
                {periodEnd
                  ? ts('cancelConfirmBody', { date: periodEnd })
                  : ts('cancelConfirmBodyNoDate')}
              </DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button
                variant="outline"
                onClick={() => setConfirmCancel(false)}
                disabled={busy !== null}
              >
                {ts('cancelKeep')}
              </Button>
              <Button
                variant="destructive"
                onClick={onCancel}
                disabled={busy !== null}
              >
                {busy === 'cancel' ? (
                  <Loader2 className="size-4 animate-spin" />
                ) : null}
                {ts('cancelConfirm')}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </RequireRole>
  );
}
