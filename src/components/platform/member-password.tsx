'use client';

// ============================================================
// «Cambiar contraseña» next to a member on the company file.
//
// The operator types (or generates) a password and a reason; the route
// `/api/platform/accounts/[id]/members/[userId]/password` writes the
// bitácora first and then sets it through the Auth admin API — no email,
// so it works when Supabase's email rate limit is spent. The UI only
// asks and reports; the route refuses what must be refused (another
// operator, a person from another company, a short reason).
// ============================================================

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { KeyRound, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { MIN_REASON_LENGTH } from '@/lib/auth/support-cookie';
import {
  generatePassword,
  OPERATOR_MAX_PASSWORD_LENGTH,
  OPERATOR_MIN_PASSWORD_LENGTH,
} from '@/lib/platform/password-rules';

export function MemberPassword({
  accountId,
  userId,
  name,
}: {
  accountId: string;
  userId: string;
  name: string;
}) {
  const t = useTranslations('Platform');
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  const close = useCallback(() => {
    // The password is never kept: closing forgets it.
    setOpen(false);
    setPassword('');
    setReason('');
    setDone(false);
  }, []);

  const submit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      if (
        password.length < OPERATOR_MIN_PASSWORD_LENGTH ||
        password.length > OPERATOR_MAX_PASSWORD_LENGTH
      ) {
        toast.error(
          t('passwordInvalid', {
            min: OPERATOR_MIN_PASSWORD_LENGTH,
            max: OPERATOR_MAX_PASSWORD_LENGTH,
          })
        );
        return;
      }
      if (reason.trim().length < MIN_REASON_LENGTH) {
        toast.error(t('passwordReasonShort', { min: MIN_REASON_LENGTH }));
        return;
      }
      setBusy(true);
      try {
        const res = await fetch(
          `/api/platform/accounts/${accountId}/members/${userId}/password`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ password, reason: reason.trim() }),
          }
        );
        if (res.ok) {
          setDone(true);
          toast.success(t('passwordDone'));
          return;
        }
        const body = (await res.json().catch(() => null)) as {
          code?: string;
        } | null;
        toast.error(
          body?.code === 'is_operator'
            ? t('passwordIsOperator')
            : t('passwordFailed')
        );
      } catch {
        toast.error(t('passwordFailed'));
      } finally {
        setBusy(false);
      }
    },
    [accountId, password, reason, t, userId]
  );

  const copy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast.success(t('passwordCopied'));
    } catch {
      // Clipboard blocked: the field is visible, it can be copied by hand.
    }
  }, [password, t]);

  if (!open) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen(true)}
      >
        <KeyRound className="size-3.5" />
        {t('passwordButton')}
      </Button>
    );
  }

  return (
    <form
      className="border-border mt-2 flex w-full flex-col gap-3 rounded-lg border p-3"
      onSubmit={submit}
    >
      <div>
        <h3 className="text-foreground text-sm font-semibold">
          {t('passwordTitle', { name })}
        </h3>
        <p className="text-muted-foreground text-xs">{t('passwordHelp')}</p>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`pw-${userId}`}>{t('passwordLabel')}</Label>
        <div className="flex gap-2">
          <Input
            id={`pw-${userId}`}
            value={password}
            autoComplete="off"
            maxLength={OPERATOR_MAX_PASSWORD_LENGTH}
            onChange={(e) => {
              setPassword(e.target.value);
              setDone(false);
            }}
          />
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setPassword(generatePassword());
              setDone(false);
            }}
          >
            {t('passwordGenerate')}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={!password}
            onClick={copy}
          >
            {t('passwordCopy')}
          </Button>
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <Label htmlFor={`pw-reason-${userId}`}>
          {t('passwordReasonLabel')}
        </Label>
        <Input
          id={`pw-reason-${userId}`}
          value={reason}
          placeholder={t('passwordReasonPlaceholder')}
          onChange={(e) => setReason(e.target.value)}
        />
      </div>
      <div className="flex gap-2">
        <Button type="submit" disabled={busy || done}>
          {busy && <Loader2 className="size-3.5 animate-spin" />}
          {t('passwordSubmit')}
        </Button>
        <Button type="button" variant="ghost" onClick={close}>
          {t('passwordCancel')}
        </Button>
      </div>
    </form>
  );
}
