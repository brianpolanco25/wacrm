'use client';

// ============================================================
// What the platform panel CREATES (s9.4), as UI pieces:
//
//   - «Nueva empresa» on /platform/accounts (NewAccountButton + form);
//   - the plan selector of the file, with confirmation (PlanAssignment);
//   - «Añadir miembro» on the file (AddMemberForm).
//
// Every act posts to its `/api/platform/*` route, which checks
// `requirePlatformAdmin()`, writes the bitácora first and refuses what
// must be refused (a live PayPal subscription, an email that already has
// a user…). The UI only asks and reports; it decides nothing.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Building2, Loader2, UserPlus } from 'lucide-react';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';

import {
  termsBody,
  termsFromPlan,
  type ManagedTermsForm,
} from './managed-form';
import { ManagedTermsFields } from './platform-managed';

export interface PlanOption {
  id: string;
  name: string;
  isPublic: boolean;
  /**
   * The plan's default Meta price policy (077), or null. A plan with one
   * (`gestionado`) is assigned with a payment method and a price (s10.3).
   */
  metaPricing?: unknown;
}

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** The plans an operator may assign, from `/api/platform/plan-options`. */
export function usePlanOptions(): {
  plans: PlanOption[] | null;
  failed: boolean;
} {
  const [plans, setPlans] = useState<PlanOption[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch('/api/platform/plan-options', { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { plans?: PlanOption[] };
        if (alive) setPlans(body.plans ?? []);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  return { plans, failed };
}

function PlanSelect({
  id,
  plans,
  value,
  onChange,
  noneLabel,
  placeholder,
}: {
  id: string;
  plans: PlanOption[];
  value: string;
  onChange: (value: string) => void;
  /** When set, an empty choice with this label is offered. */
  noneLabel?: string;
  placeholder?: string;
}) {
  const t = useTranslations('Platform.provisioning');
  return (
    <select
      id={id}
      className={SELECT_CLASS}
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {noneLabel !== undefined ? (
        <option value="">{noneLabel}</option>
      ) : (
        <option value="" disabled>
          {placeholder}
        </option>
      )}
      {plans.map((plan) => (
        <option key={plan.id} value={plan.id}>
          {plan.name}
          {plan.isPublic ? '' : ` ${t('privatePlan')}`}
        </option>
      ))}
    </select>
  );
}

async function postJson(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  return { res, json };
}

// ------------------------------------------------------------
// «Nueva empresa»
// ------------------------------------------------------------

export function CreateAccountForm({
  plans,
  onCancel,
  onCreated,
}: {
  plans: PlanOption[] | null;
  onCancel: () => void;
  onCreated: (created: { accountId: string; email: string }) => void;
}) {
  const t = useTranslations('Platform.provisioning');
  const [name, setName] = useState('');
  const [ownerEmail, setOwnerEmail] = useState('');
  const [ownerName, setOwnerName] = useState('');
  const [planId, setPlanId] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const ready =
    name.trim().length > 0 &&
    ownerEmail.trim().length > 0 &&
    reason.trim().length >= MIN_REASON_LENGTH;

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!ready) return;
      setBusy(true);
      try {
        const { res, json } = await postJson('/api/platform/accounts', {
          name: name.trim(),
          ownerEmail: ownerEmail.trim(),
          ownerName: ownerName.trim() || undefined,
          planId: planId || undefined,
          reason: reason.trim(),
        });
        if (res.status === 409) {
          toast.error(t('emailExists'));
          return;
        }
        if (!res.ok || !json?.accountId) {
          toast.error(t('createFailed'));
          return;
        }
        if (json.planError) toast.warning(t('createdPlanFailed'));
        onCreated({
          accountId: json.accountId as string,
          email: ownerEmail.trim(),
        });
      } finally {
        setBusy(false);
      }
    },
    [name, onCreated, ownerEmail, ownerName, planId, ready, reason, t]
  );

  return (
    <Card>
      <CardContent className="p-4">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div>
            <h2 className="text-foreground text-sm font-semibold">
              {t('createTitle')}
            </h2>
            <p className="text-muted-foreground text-xs">{t('createHelp')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-account-name">{t('nameLabel')}</Label>
              <Input
                id="new-account-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t('namePlaceholder')}
                maxLength={120}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-account-plan">{t('planLabel')}</Label>
              <PlanSelect
                id="new-account-plan"
                plans={plans ?? []}
                value={planId}
                onChange={setPlanId}
                noneLabel={t('planNone')}
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-account-email">{t('ownerEmailLabel')}</Label>
              <Input
                id="new-account-email"
                type="email"
                value={ownerEmail}
                onChange={(e) => setOwnerEmail(e.target.value)}
                placeholder="owner@example.com"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="new-account-owner">{t('ownerNameLabel')}</Label>
              <Input
                id="new-account-owner"
                value={ownerName}
                onChange={(e) => setOwnerName(e.target.value)}
              />
            </div>
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="new-account-reason">{t('reasonLabel')}</Label>
            <Input
              id="new-account-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
            <p className="text-muted-foreground text-xs">
              {t('reasonHelp', { min: MIN_REASON_LENGTH })}
            </p>
          </div>
          <div className="flex gap-2">
            <Button type="submit" size="sm" disabled={busy || !ready}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : null}
              {t('create')}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={onCancel}
              disabled={busy}
            >
              {t('cancel')}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** The «Nueva empresa» button of the census, and what it opens. */
export function NewAccountButton({
  onCreated,
  initiallyOpen = false,
}: {
  onCreated?: () => void;
  initiallyOpen?: boolean;
}) {
  const t = useTranslations('Platform.provisioning');
  const [open, setOpen] = useState(initiallyOpen);
  const [created, setCreated] = useState<{
    accountId: string;
    email: string;
  } | null>(null);
  const { plans } = usePlanOptions();

  return (
    <div className="flex flex-col gap-3">
      {!open ? (
        <div>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Building2 className="size-4" />
            {t('newAccount')}
          </Button>
        </div>
      ) : (
        <CreateAccountForm
          plans={plans}
          onCancel={() => setOpen(false)}
          onCreated={(result) => {
            setCreated(result);
            setOpen(false);
            onCreated?.();
          }}
        />
      )}
      {created ? (
        <p className="text-muted-foreground text-sm" role="status">
          {t('created', { email: created.email })}{' '}
          <Link
            href={`/platform/${created.accountId}`}
            className="text-primary font-medium hover:underline"
          >
            {t('openFile')}
          </Link>
        </p>
      ) : null}
    </div>
  );
}

// ------------------------------------------------------------
// The plan, on the file
// ------------------------------------------------------------

export function PlanAssignment({
  accountId,
  accountName,
  planId,
  planName,
  provider,
  subscriptionStatus,
  plans,
  onChanged,
  onCheckoutLink,
  initialChoice = '',
}: {
  accountId: string;
  accountName: string;
  planId: string;
  planName: string | null;
  provider: string | null;
  subscriptionStatus: string;
  plans: PlanOption[] | null;
  onChanged: () => void;
  /**
   * s10.3: the PayPal approval link of a managed plan paid through
   * PayPal (or null after any other assignment). The file keeps it.
   */
  onCheckoutLink?: (url: string | null) => void;
  /** Pre-selected plan (tests). */
  initialChoice?: string;
}) {
  const t = useTranslations('Platform.provisioning');
  const tm = useTranslations('Platform.managed');
  const termsFor = useCallback(
    (id: string): ManagedTermsForm | null => {
      const pricing = plans?.find((p) => p.id === id)?.metaPricing;
      return pricing ? termsFromPlan(pricing) : null;
    },
    [plans]
  );
  const [choice, setChoiceState] = useState(initialChoice);
  const [terms, setTerms] = useState<ManagedTermsForm | null>(() =>
    initialChoice ? termsFor(initialChoice) : null
  );
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const setChoice = useCallback(
    (id: string) => {
      setChoiceState(id);
      setTerms(termsFor(id));
    },
    [termsFor]
  );

  const manual = provider === 'manual';
  const ready = Boolean(choice) && reason.trim().length >= MIN_REASON_LENGTH;

  const assign = useCallback(async () => {
    if (!ready) return;
    let extra: Record<string, unknown> = {};
    if (terms) {
      const built = termsBody(terms);
      if (!built.ok) {
        toast.error(tm('invalidPricing', { error: built.error }));
        return;
      }
      extra = built.body;
    }
    const target = plans?.find((p) => p.id === choice)?.name ?? choice;
    const account = accountName || accountId;
    const question = terms
      ? tm(
          terms.paymentMethod === 'paypal'
            ? 'assignConfirmPayPal'
            : 'assignConfirmManual',
          { plan: target, account }
        )
      : t('assignConfirm', { plan: target, account });
    if (!window.confirm(question)) return;
    setBusy(true);
    try {
      const { res, json } = await postJson(
        `/api/platform/accounts/${accountId}/plan`,
        { planId: choice, reason: reason.trim(), ...extra }
      );
      if (res.status === 409 && json?.code === 'paypal_active') {
        toast.error(t('paypalActive'));
        return;
      }
      if (res.status === 409 && json?.code === 'checkout_in_progress') {
        toast.error(tm('errors.checkoutInProgress'));
        return;
      }
      if (res.status === 503) {
        toast.error(tm('errors.paypalNotConfigured'));
        return;
      }
      if (res.status === 502) {
        toast.error(tm('errors.paypalFailed'));
        return;
      }
      if (res.status === 400 && terms && typeof json?.error === 'string') {
        toast.error(tm('invalidPricing', { error: json.error }));
        return;
      }
      if (!res.ok) {
        toast.error(t('assignFailed'));
        return;
      }
      const approvalUrl =
        typeof json?.approvalUrl === 'string' ? json.approvalUrl : null;
      onCheckoutLink?.(approvalUrl);
      toast.success(approvalUrl ? tm('assignedPayPal') : t('assigned'));
      setChoice('');
      setReason('');
      onChanged();
    } finally {
      setBusy(false);
    }
  }, [
    accountId,
    accountName,
    choice,
    onChanged,
    onCheckoutLink,
    plans,
    ready,
    reason,
    setChoice,
    t,
    terms,
    tm,
  ]);

  return (
    <Card>
      <CardContent className="flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-foreground text-sm font-semibold">
            {t('planTitle')}
          </h2>
          <Badge variant="outline">
            {planName ?? planId} · {subscriptionStatus}
          </Badge>
          {manual ? (
            <Badge variant="secondary">{t('manualBadge')}</Badge>
          ) : provider ? (
            <Badge variant="outline">{provider}</Badge>
          ) : null}
        </div>
        <p className="text-muted-foreground text-xs">
          {manual ? t('manualHelp') : t('assignHelp')}
        </p>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="flex flex-col gap-1">
            <Label htmlFor="assign-plan">{t('assignPlan')}</Label>
            <PlanSelect
              id="assign-plan"
              plans={plans ?? []}
              value={choice}
              onChange={setChoice}
              placeholder={t('planPlaceholder')}
            />
          </div>
          <div className="flex flex-col gap-1">
            <Label htmlFor="assign-reason">{t('reasonLabel')}</Label>
            <Input
              id="assign-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </div>
        </div>
        {terms ? (
          <ManagedTermsFields value={terms} onChange={setTerms} />
        ) : null}
        <p className="text-muted-foreground text-xs">
          {t('reasonHelp', { min: MIN_REASON_LENGTH })}
        </p>
        <div>
          <Button size="sm" disabled={busy || !ready} onClick={assign}>
            {busy ? <Loader2 className="size-4 animate-spin" /> : null}
            {t('assign')}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

// ------------------------------------------------------------
// «Añadir miembro»
// ------------------------------------------------------------

const MEMBER_ROLES = ['admin', 'agent', 'viewer'] as const;

export type MemberInviteOutcome =
  | { kind: 'emailed'; email: string }
  /** No email went out: this URL is the ONLY delivery of the token. */
  | { kind: 'link'; url: string }
  | { kind: 'error'; reason: 'alreadyMember' | 'seatLimit' | 'failed' };

/**
 * POST the invitation and say what the operator has to do next. Pure of
 * React so the flow can be tested without a DOM.
 */
export async function sendMemberInvite(
  accountId: string,
  email: string,
  role: (typeof MEMBER_ROLES)[number],
  doFetch: typeof fetch = fetch
): Promise<MemberInviteOutcome> {
  const res = await doFetch(`/api/platform/accounts/${accountId}/members`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, role }),
  });
  const json = (await res.json().catch(() => null)) as Record<
    string,
    unknown
  > | null;
  if (res.status === 409) return { kind: 'error', reason: 'alreadyMember' };
  if (res.status === 402) return { kind: 'error', reason: 'seatLimit' };
  if (!res.ok) return { kind: 'error', reason: 'failed' };
  if (json?.emailed) return { kind: 'emailed', email };
  if (typeof json?.url === 'string' && json.url) {
    return { kind: 'link', url: json.url };
  }
  return { kind: 'error', reason: 'failed' };
}

/**
 * «Añadir miembro». The share link is NOT kept here: the file owns it
 * (`link`), so reloading the file after an invite cannot unmount it away —
 * for someone who already has a user it is the only way the invitation
 * reaches them, and the token is never shown again.
 */
export function AddMemberForm({
  accountId,
  link,
  onInvited,
}: {
  accountId: string;
  link: string | null;
  onInvited: (outcome: MemberInviteOutcome) => void;
}) {
  const t = useTranslations('Platform.provisioning');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<(typeof MEMBER_ROLES)[number]>('agent');
  const [busy, setBusy] = useState(false);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (!email.trim()) return;
      setBusy(true);
      try {
        const outcome = await sendMemberInvite(accountId, email.trim(), role);
        if (outcome.kind === 'error') {
          toast.error(
            t(outcome.reason === 'failed' ? 'inviteFailed' : outcome.reason)
          );
          return;
        }
        if (outcome.kind === 'emailed') {
          toast.success(t('invited', { email: outcome.email }));
        }
        setEmail('');
        onInvited(outcome);
      } catch {
        toast.error(t('inviteFailed'));
      } finally {
        setBusy(false);
      }
    },
    [accountId, email, onInvited, role, t]
  );

  return (
    <Card>
      <CardContent className="p-4">
        <form className="flex flex-col gap-3" onSubmit={submit}>
          <div>
            <h2 className="text-foreground text-sm font-semibold">
              {t('memberTitle')}
            </h2>
            <p className="text-muted-foreground text-xs">{t('memberHelp')}</p>
          </div>
          <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
            <div className="flex flex-col gap-1">
              <Label htmlFor="member-email">{t('memberEmailLabel')}</Label>
              <Input
                id="member-email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="agent@example.com"
              />
            </div>
            <div className="flex flex-col gap-1">
              <Label htmlFor="member-role">{t('memberRoleLabel')}</Label>
              <select
                id="member-role"
                className={SELECT_CLASS}
                value={role}
                onChange={(e) =>
                  setRole(e.target.value as (typeof MEMBER_ROLES)[number])
                }
              >
                {MEMBER_ROLES.map((r) => (
                  <option key={r} value={r}>
                    {t(`roles.${r}`)}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <Button type="submit" size="sm" disabled={busy || !email.trim()}>
              {busy ? (
                <Loader2 className="size-4 animate-spin" />
              ) : (
                <UserPlus className="size-4" />
              )}
              {t('invite')}
            </Button>
          </div>
          {link ? (
            <div className="flex flex-col gap-1" role="status">
              <p className="text-muted-foreground text-xs">{t('inviteLink')}</p>
              <Input readOnly value={link} onFocus={(e) => e.target.select()} />
            </div>
          ) : null}
        </form>
      </CardContent>
    </Card>
  );
}
