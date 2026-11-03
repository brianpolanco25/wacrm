'use client';

// ============================================================
// The invitation screens of /signup?invite= (i12.1). Presentational;
// the page decides which one with `signupInviteGate`
// (src/lib/auth/signup-invite.ts).
//
//   checking   → "Checking your invitation…" (before the form)
//   fail       → why the link is no good, same copy as /join
//   form copy  → "Create your account at <company>"
//   check mail → names the company the confirmation lands in
// ============================================================

import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { CheckCircle, Loader2, MailX } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import type { InvitePeek, JoinFailReason } from '@/lib/auth/join-flow';

const PRIMARY =
  'bg-primary text-primary-foreground hover:bg-primary-hover h-12 w-full rounded-xl text-base font-semibold';
const OUTLINE =
  'border-border text-foreground hover:bg-muted h-12 w-full rounded-xl';

/** Title and description of the form when it comes with an invitation. */
export function useSignupInviteCopy(peek: InvitePeek | null): {
  title: string;
  description: string;
} | null {
  const t = useTranslations('SignupInvite');
  const tj = useTranslations('JoinPage');
  if (!peek) return null;
  return {
    title: t('title', { account: peek.account_name }),
    description: t('description', {
      account: peek.account_name,
      role: tj(`roles.${peek.role}`),
    }),
  };
}

export function SignupInviteChecking() {
  const t = useTranslations('SignupInvite');
  return (
    <AuthCard
      title={t('checking')}
      icon={<Loader2 className="size-6 animate-spin" aria-hidden />}
    >
      <span className="sr-only" role="status" aria-busy="true">
        {t('checking')}
      </span>
    </AuthCard>
  );
}

export function SignupInviteFail({
  reason,
  onRetry,
}: {
  reason: JoinFailReason;
  onRetry?: () => void;
}) {
  const t = useTranslations('SignupInvite');
  const tj = useTranslations('JoinPage');
  return (
    <AuthCard
      title={tj(`fail.${reason}.title`)}
      description={tj(`fail.${reason}.body`)}
      icon={<MailX className="size-6" />}
    >
      <div role="alert" className="sr-only">
        {tj(`fail.${reason}.title`)}
      </div>
      {reason === 'server_error' && onRetry ? (
        <Button onClick={onRetry} className={PRIMARY}>
          {tj('tryAgain')}
        </Button>
      ) : null}
      <Link href="/signup">
        <Button
          variant={reason === 'server_error' ? 'outline' : 'default'}
          className={reason === 'server_error' ? OUTLINE : PRIMARY}
        >
          {t('signupWithoutInvite')}
        </Button>
      </Link>
      <Link
        href="/login"
        className="text-muted-foreground hover:text-foreground text-center text-sm transition-colors"
      >
        {tj('signIn')}
      </Link>
    </AuthCard>
  );
}

export function SignupInviteCheckEmail({
  email,
  accountName,
  token,
}: {
  email: string;
  accountName: string;
  token: string;
}) {
  const t = useTranslations('SignupInvite');
  return (
    <AuthCard
      title={t('checkEmailTitle')}
      description={t('checkEmailBody', { email, account: accountName })}
      icon={<CheckCircle className="size-6" />}
    >
      <Link href={`/login?invite=${encodeURIComponent(token)}`}>
        <Button variant="outline" className={OUTLINE}>
          {t('backToSignIn')}
        </Button>
      </Link>
    </AuthCard>
  );
}
