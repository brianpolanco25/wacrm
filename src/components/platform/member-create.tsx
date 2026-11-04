'use client';

// ============================================================
// «Crear miembro» in the «Equipo (N)» block of the company file (i12.2).
//
// For when the invitation by link gets lost: the operator types a name,
// an email, a role and a password (or generates one) plus a reason, and
// `/api/platform/accounts/[id]/members/create` writes the bitácora first
// and creates a CONFIRMED user who is born inside this company — no
// email, no link. The password is shown once, to be copied and handed
// over a safe channel; «Cerrar» forgets it. Same pattern as
// `member-password.tsx`. The form validates for quick feedback
// (`member-create-form.ts`); the route is the authority.
// ============================================================

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Loader2, UserPlus } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';
import {
  generatePassword,
  MAX_MEMBER_NAME_LENGTH,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from '@/lib/platform/password-rules';
import {
  MEMBER_CREATE_ROLES,
  memberCreateErrorKey,
  validateMemberCreate,
  type MemberCreateRole,
} from './member-create-form';

const SELECT_CLASS =
  'border-input bg-background h-8 w-full rounded-lg border px-2.5 text-sm outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50';

/** Every ICU value the error texts may use; extra ones are ignored. */
const ERROR_VALUES = {
  min: OPERATOR_MIN_PASSWORD_LENGTH,
  max: OPERATOR_MAX_PASSWORD_LENGTH,
};

/** What a successful create shows, once: the email and the password. */
export function MemberCreateResult({
  email,
  password,
  onCopy,
}: {
  email: string;
  password: string;
  onCopy: () => void;
}) {
  const t = useTranslations('Platform');
  return (
    <div
      className="border-border bg-muted/40 flex flex-col gap-2 rounded-lg border p-3 text-sm"
      role="status"
    >
      <p className="text-foreground font-medium">{t('memberCreateDone')}</p>
      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t('memberCreateEmailLabel')}</dt>
        <dd className="break-all">{email}</dd>
        <dt className="text-muted-foreground">
          {t('memberCreatePasswordLabel')}
        </dt>
        <dd className="font-mono break-all">{password}</dd>
      </dl>
      <div>
        <Button type="button" variant="outline" size="sm" onClick={onCopy}>
          {t('memberCreateCopy')}
        </Button>
      </div>
    </div>
  );
}

export function MemberCreate({
  accountId,
  onCreated,
}: {
  accountId: string;
  onCreated: () => void;
}) {
  const t = useTranslations('Platform');
  const [open, setOpen] = useState(false);
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<MemberCreateRole>('agent');
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [created, setCreated] = useState<{
    email: string;
    password: string;
  } | null>(null);

  const close = useCallback(() => {
    // The password is kept nowhere else: closing forgets it.
    setOpen(false);
    setFullName('');
    setEmail('');
    setRole('agent');
    setPassword('');
    setReason('');
    setCreated(null);
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (busy || created) return;
      const invalid = validateMemberCreate({
        fullName,
        email,
        role,
        password,
        reason,
      });
      if (invalid) {
        toast.error(t(invalid.key, invalid.values));
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/platform/accounts/${accountId}/members/create`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({
              fullName: fullName.trim(),
              email: email.trim(),
              role,
              password,
              reason: reason.trim(),
            }),
          }
        );
        if (res.status === 201) {
          const body = (await res.json().catch(() => null)) as {
            member?: { email?: string };
          } | null;
          setCreated({
            email: body?.member?.email ?? email.trim().toLowerCase(),
            password,
          });
          onCreated();
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        toast.error(
          t(memberCreateErrorKey(res.status, body?.code), ERROR_VALUES)
        );
      } catch {
        toast.error(t('memberCreateFailed'));
      } finally {
        setBusy(false);
      }
    },
    [
      accountId,
      busy,
      created,
      email,
      fullName,
      onCreated,
      password,
      reason,
      role,
      t,
    ]
  );

  const copy = useCallback(async () => {
    const value = created?.password ?? password;
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      toast.success(t('memberCreateCopied'));
    } catch {
      // Clipboard blocked: the password is visible, it can be copied by hand.
    }
  }, [created, password, t]);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <UserPlus className="size-3.5" />
        {t('memberCreateButton')}
      </Button>
    );
  }

  const locked = busy || created !== null;

  return (
    <form
      className="border-border mt-2 flex w-full flex-col gap-3 rounded-lg border p-3"
      onSubmit={submit}
      aria-busy={busy}
    >
      <div>
        <h3 className="text-foreground text-sm font-semibold">
          {t('memberCreateTitle')}
        </h3>
        <p className="text-muted-foreground text-xs">{t('memberCreateHelp')}</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <Label htmlFor={`mc-name-${accountId}`}>
            {t('memberCreateNameLabel')}
          </Label>
          <Input
            id={`mc-name-${accountId}`}
            value={fullName}
            maxLength={MAX_MEMBER_NAME_LENGTH}
            disabled={locked}
            onChange={(e) => setFullName(e.target.value)}
          />
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor={`mc-email-${accountId}`}>
            {t('memberCreateEmailLabel')}
          </Label>
          <Input
            id={`mc-email-${accountId}`}
            type="email"
            value={email}
            autoComplete="off"
            disabled={locked}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1 sm:max-w-48">
        <Label htmlFor={`mc-role-${accountId}`}>
          {t('memberCreateRoleLabel')}
        </Label>
        <select
          id={`mc-role-${accountId}`}
          className={SELECT_CLASS}
          value={role}
          disabled={locked}
          onChange={(e) => setRole(e.target.value as MemberCreateRole)}
        >
          {MEMBER_CREATE_ROLES.map((r) => (
            <option key={r} value={r}>
              {t(`provisioning.roles.${r}`)}
            </option>
          ))}
        </select>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`mc-pw-${accountId}`}>
          {t('memberCreatePasswordLabel')}
        </Label>
        <div className="flex gap-2">
          <Input
            id={`mc-pw-${accountId}`}
            value={password}
            autoComplete="off"
            maxLength={OPERATOR_MAX_PASSWORD_LENGTH}
            disabled={locked}
            onChange={(e) => setPassword(e.target.value)}
          />
          <Button
            type="button"
            variant="outline"
            disabled={locked}
            onClick={() => setPassword(generatePassword())}
          >
            {t('memberCreateGenerate')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!password}
            onClick={copy}
          >
            {t('memberCreateCopy')}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`mc-reason-${accountId}`}>
          {t('memberCreateReasonLabel')}
        </Label>
        <Input
          id={`mc-reason-${accountId}`}
          value={reason}
          minLength={MIN_REASON_LENGTH}
          placeholder={t('memberCreateReasonPlaceholder')}
          disabled={locked}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      {created && (
        <MemberCreateResult
          email={created.email}
          password={created.password}
          onCopy={copy}
        />
      )}
      <div className="flex gap-2">
        <Button type="submit" disabled={locked}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t('memberCreateSubmit')}
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          {t('memberCreateCancel')}
        </Button>
      </div>
    </form>
  );
}
