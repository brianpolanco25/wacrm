'use client';

// ============================================================
// One account's file (fase 4 §2, «Ficha de cuenta»), plus the two acts
// an operator can perform on it: suspend / reactivate by hand, and
// impersonate for support.
//
// The impersonation button does NOT reimplement f4.4: it posts to
// `/api/platform/impersonate` with the same mandatory reason and then
// reloads, which is when the session banner takes over.
//
// Both acts ask for a reason in the same prompt-and-refuse shape,
// because both write the same line of the same bitácora and neither is
// allowed to happen without one.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Loader2,
  ShieldAlert,
  UserRoundSearch,
  Ban,
  CircleCheck,
} from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';

interface UsageLine {
  metric: string;
  used: number;
  limit: number | null;
  percent: number | null;
}

interface Member {
  userId: string;
  fullName: string | null;
  email: string | null;
  role: string | null;
}

interface WhatsAppNumber {
  id: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  label: string | null;
  status: string;
  isDefault: boolean;
  registeredAt: string | null;
  lastRegistrationError: string | null;
}

interface BillingEntry {
  id: string;
  eventType: string;
  receivedAt: string | null;
  processedAt: string | null;
  error: string | null;
  amount: string | null;
  currency: string | null;
}

interface AuditEntry {
  id: string;
  action: string;
  actorUserId: string;
  reason: string;
  at: string;
  endedAt: string | null;
  endedReason: string | null;
}

interface Detail {
  accountId: string;
  name: string;
  createdAt: string;
  planId: string;
  planName: string | null;
  subscriptionStatus: string;
  readOnly: boolean;
  manualHold: boolean;
  manualHoldAt: string | null;
  manualHoldReason: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  usage: UsageLine[];
  limits: Record<string, number | null>;
  members: Member[];
  numbers: WhatsAppNumber[];
  lastActivityAt: string | null;
  billingHistory: BillingEntry[];
  audit: AuditEntry[];
}

function moment(value: string | null): string {
  if (!value) return '—';
  const d = new Date(value);
  return Number.isFinite(d.getTime()) ? d.toLocaleString() : '—';
}

export function PlatformAccountDetail({ accountId }: { accountId: string }) {
  const t = useTranslations('Platform');
  const [detail, setDetail] = useState<Detail | null>(null);
  const [loading, setLoading] = useState(true);
  const [failed, setFailed] = useState<'notFound' | 'error' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setFailed(null);
    try {
      const res = await fetch(`/api/platform/accounts/${accountId}`, {
        cache: 'no-store',
      });
      if (res.status === 404) {
        setFailed('notFound');
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      setDetail((await res.json()) as Detail);
    } catch {
      setFailed('error');
    } finally {
      setLoading(false);
    }
  }, [accountId]);

  useEffect(() => {
    load();
  }, [load]);

  const shortReason = reason.trim().length < MIN_REASON_LENGTH;

  const hold = useCallback(
    async (action: 'suspend' | 'reactivate') => {
      if (shortReason) return;
      setBusy(true);
      try {
        const res = await fetch(`/api/platform/accounts/${accountId}/hold`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ action, reason: reason.trim() }),
        });
        const body = (await res.json().catch(() => null)) as {
          error?: string;
        } | null;
        if (!res.ok) {
          toast.error(body?.error ?? t('actionFailed'));
          return;
        }
        toast.success(action === 'suspend' ? t('suspended') : t('reactivated'));
        setReason('');
        await load();
      } finally {
        setBusy(false);
      }
    },
    [accountId, load, reason, shortReason, t]
  );

  const impersonate = useCallback(async () => {
    if (shortReason) return;
    setBusy(true);
    try {
      const res = await fetch('/api/platform/impersonate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ account_id: accountId, reason: reason.trim() }),
      });
      const body = (await res.json().catch(() => null)) as {
        error?: string;
      } | null;
      if (!res.ok) {
        toast.error(body?.error ?? t('actionFailed'));
        return;
      }
      // The session lives in an httpOnly cookie the server just set; a
      // full reload is what makes every server component see it.
      window.location.href = '/dashboard';
    } finally {
      setBusy(false);
    }
  }, [accountId, reason, shortReason, t]);

  if (loading) {
    return (
      <div className="text-muted-foreground flex items-center gap-2 p-6 text-sm">
        <Loader2 className="size-4 animate-spin" />
        {t('loading')}
      </div>
    );
  }

  if (failed || !detail) {
    return (
      <div className="flex flex-col gap-4">
        <Link
          href="/platform"
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" />
          {t('backToList')}
        </Link>
        <div className="border-destructive/40 bg-destructive/10 text-destructive flex items-center gap-2 rounded-lg border p-4 text-sm">
          <ShieldAlert className="size-4" />
          {failed === 'notFound' ? t('notFound') : t('loadFailed')}
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-2">
        <Link
          href="/platform"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1 text-sm"
        >
          <ArrowLeft className="size-4" />
          {t('backToList')}
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-foreground text-xl font-semibold">
            {detail.name || detail.accountId}
          </h1>
          <Badge variant="outline">
            {detail.planName ?? detail.planId} · {detail.subscriptionStatus}
          </Badge>
          {detail.manualHold ? (
            <Badge variant="destructive">{t('held')}</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-sm">
          {t('createdOn', { date: moment(detail.createdAt) })} ·{' '}
          {t('lastActivityOn', { date: moment(detail.lastActivityAt) })}
        </p>
      </div>

      {/* ---- the two acts ------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('actions')}
          </h2>
          <div className="flex flex-col gap-1">
            <Label htmlFor="platform-reason">{t('reasonLabel')}</Label>
            <Input
              id="platform-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder={t('reasonPlaceholder')}
            />
            <p className="text-muted-foreground text-xs">
              {t('reasonHelp', { min: MIN_REASON_LENGTH })}
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            {detail.manualHold ? (
              <Button
                size="sm"
                variant="outline"
                disabled={busy || shortReason}
                onClick={() => hold('reactivate')}
              >
                <CircleCheck className="size-4" />
                {t('reactivate')}
              </Button>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || shortReason}
                onClick={() => hold('suspend')}
              >
                <Ban className="size-4" />
                {t('suspend')}
              </Button>
            )}
            <Button
              size="sm"
              variant="outline"
              disabled={busy || shortReason}
              onClick={impersonate}
            >
              <UserRoundSearch className="size-4" />
              {t('impersonate')}
            </Button>
          </div>
          {detail.manualHold ? (
            <p className="text-muted-foreground text-xs">
              {t('heldSince', {
                date: moment(detail.manualHoldAt),
                reason: detail.manualHoldReason ?? '—',
              })}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ---- consumption -------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('usageTitle')}
          </h2>
          <ul className="flex flex-col gap-2">
            {detail.usage.map((line) => (
              <li key={line.metric} className="flex flex-col gap-1">
                <div className="flex justify-between text-sm">
                  <span className="text-muted-foreground">{line.metric}</span>
                  <span className="tabular-nums">
                    {line.used}
                    {line.limit === null ? '' : ` / ${line.limit}`}
                  </span>
                </div>
                {line.percent === null ? null : (
                  <div className="bg-muted h-1.5 w-full overflow-hidden rounded-full">
                    <div
                      className="bg-primary h-full"
                      style={{ width: `${line.percent}%` }}
                    />
                  </div>
                )}
              </li>
            ))}
          </ul>
          <p className="text-muted-foreground text-xs">{t('usageNote')}</p>
        </CardContent>
      </Card>

      {/* ---- WhatsApp ------------------------------------------------ */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('whatsappTitle')}
          </h2>
          {detail.numbers.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('whatsappNone')}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {detail.numbers.map((number) => (
                <li
                  key={number.id}
                  className="border-border flex flex-wrap items-center gap-2 rounded-md border p-2 text-sm"
                >
                  <span className="font-medium">
                    {number.displayPhoneNumber ?? number.phoneNumberId}
                  </span>
                  {number.label ? (
                    <span className="text-muted-foreground">
                      {number.label}
                    </span>
                  ) : null}
                  <Badge
                    variant={
                      number.status === 'connected' ? 'outline' : 'destructive'
                    }
                  >
                    {number.status}
                  </Badge>
                  {number.isDefault ? (
                    <Badge variant="secondary">{t('defaultNumber')}</Badge>
                  ) : null}
                  {number.lastRegistrationError ? (
                    <span className="text-destructive text-xs">
                      {number.lastRegistrationError}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---- members ------------------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('membersTitle', { count: detail.members.length })}
          </h2>
          <ul className="flex flex-col gap-1 text-sm">
            {detail.members.map((member) => (
              <li key={member.userId} className="flex flex-wrap gap-2">
                <span>{member.fullName ?? member.email ?? member.userId}</span>
                <span className="text-muted-foreground">{member.email}</span>
                <Badge variant="outline">{member.role ?? '—'}</Badge>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      {/* ---- billing history ----------------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('billingTitle')}
          </h2>
          {detail.billingHistory.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('billingNone')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {detail.billingHistory.map((entry) => (
                <li key={entry.id} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">
                    {moment(entry.receivedAt)}
                  </span>
                  <span>{entry.eventType}</span>
                  {entry.amount ? (
                    <span className="tabular-nums">
                      {entry.amount} {entry.currency ?? ''}
                    </span>
                  ) : null}
                  {entry.error ? (
                    <span className="text-destructive text-xs">
                      {entry.error}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {/* ---- the platform's own trail -------------------------------- */}
      <Card>
        <CardContent className="flex flex-col gap-3 p-4">
          <h2 className="text-foreground text-sm font-semibold">
            {t('auditTitle')}
          </h2>
          {detail.audit.length === 0 ? (
            <p className="text-muted-foreground text-sm">{t('auditNone')}</p>
          ) : (
            <ul className="flex flex-col gap-1 text-sm">
              {detail.audit.map((entry) => (
                <li key={entry.id} className="flex flex-wrap gap-2">
                  <span className="text-muted-foreground">
                    {moment(entry.at)}
                  </span>
                  <Badge variant="outline">{entry.action}</Badge>
                  <span className="text-muted-foreground">
                    {entry.actorUserId}
                  </span>
                  <span>{entry.reason}</span>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
