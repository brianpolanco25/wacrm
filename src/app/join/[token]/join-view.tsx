'use client';

// ============================================================
// What /join/<token> shows (i12.1). Presentational: the page resolves
// the state with `resolveJoin` (src/lib/auth/join-flow.ts) and this
// renders it. There is no "Accept" button any more — a signed-in
// visitor is joined on load and only sees this while it happens, or
// when it could not happen.
//
//   null / redirect → "Taking you to your team…"
//   signedOut       → company + role, "Create account & join" and
//                     "I already have an account"
//   fail            → the reason, with the way out that fits it
//   conflict        → company header + blocking modal (409)
// ============================================================

import type { ReactNode } from 'react';
import Link from 'next/link';
import { useFormatter, useTranslations } from 'next-intl';
import {
  AlertTriangle,
  Loader2,
  MailX,
  ShieldCheck,
  UsersRound,
} from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  CONFLICT_FALLBACK,
  type InvitePeek,
  type JoinFailReason,
  type JoinState,
} from '@/lib/auth/join-flow';

const PRIMARY = 'w-full bg-primary text-primary-foreground hover:bg-primary/90';
const OUTLINE =
  'w-full border-border text-muted-foreground hover:bg-muted hover:text-foreground';

export interface JoinViewProps {
  state: JoinState | null;
  token: string;
  onRetry: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}

export function JoinView({
  state,
  token,
  onRetry,
  onSignOut,
  signingOut,
}: JoinViewProps) {
  if (!state || state.kind === 'redirect') return <JoinLoading />;
  if (state.kind === 'fail') {
    return <JoinFailCard reason={state.reason} onRetry={onRetry} />;
  }
  if (state.kind === 'signedOut') {
    return (
      <Card className="border-border bg-card w-full max-w-md">
        <InviteHeader peek={state.peek} />
        <CardContent className="flex flex-col gap-2">
          <SignedOutActions token={token} />
        </CardContent>
      </Card>
    );
  }
  return (
    <>
      <Card className="border-border bg-card w-full max-w-md">
        {state.peek ? (
          <InviteHeader peek={state.peek} />
        ) : (
          <JoinLoadingContent />
        )}
      </Card>
      {/* Blocking: the only ways out are signing out (to use another
          email) or going back to the account they are in. */}
      <Dialog open>
        <DialogContent
          showCloseButton={false}
          className="bg-popover border-border sm:max-w-md"
        >
          <JoinConflictBody
            message={state.message}
            accountName={state.peek?.account_name ?? null}
            onSignOut={onSignOut}
            signingOut={signingOut}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

function JoinLoadingContent() {
  const t = useTranslations('JoinPage');
  return (
    <CardContent className="flex flex-col items-center gap-3 py-12">
      <Loader2 className="text-primary size-6 animate-spin" aria-hidden />
      <p role="status" className="text-muted-foreground text-sm">
        {t('loading')}
      </p>
    </CardContent>
  );
}

export function JoinLoading() {
  return (
    <Card className="border-border bg-card w-full max-w-md" aria-busy="true">
      <JoinLoadingContent />
    </Card>
  );
}

function InviteHeader({ peek }: { peek: InvitePeek }) {
  const t = useTranslations('JoinPage');
  const format = useFormatter();
  return (
    <CardHeader className="items-center text-center">
      <div className="bg-primary/10 mb-2 flex h-12 w-12 items-center justify-center rounded-xl">
        <UsersRound className="text-primary h-6 w-6" />
      </div>
      <CardTitle className="text-foreground text-xl">
        {t('invitedTo', { account: peek.account_name })}
      </CardTitle>
      <CardDescription className="text-muted-foreground inline-flex items-center justify-center gap-1">
        <ShieldCheck className="text-primary size-3.5 shrink-0" aria-hidden />
        {t('joinAs', {
          role: t(`roles.${peek.role}`),
          date: format.dateTime(new Date(peek.expires_at), {
            year: 'numeric',
            month: 'short',
            day: 'numeric',
          }),
        })}
      </CardDescription>
    </CardHeader>
  );
}

function SignedOutActions({ token }: { token: string }) {
  const t = useTranslations('JoinPage');
  const q = encodeURIComponent(token);
  return (
    <>
      <Link href={`/signup?invite=${q}`}>
        <Button className={PRIMARY}>{t('createAndJoin')}</Button>
      </Link>
      <Link href={`/login?invite=${q}`}>
        <Button variant="outline" className={OUTLINE}>
          {t('haveAccount')}
        </Button>
      </Link>
    </>
  );
}

/** The failure card; also what /signup?invite= shows for a bad link. */
export function JoinFailCard({
  reason,
  onRetry,
  children,
}: {
  reason: JoinFailReason;
  onRetry?: () => void;
  /** Replaces the default actions when given. */
  children?: ReactNode;
}) {
  const t = useTranslations('JoinPage');
  return (
    <Card className="border-border bg-card w-full max-w-md">
      <CardHeader className="items-center text-center">
        <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-red-500/10">
          <MailX className="h-6 w-6 text-red-400" />
        </div>
        <CardTitle className="text-foreground text-xl">
          {t(`fail.${reason}.title`)}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t(`fail.${reason}.body`)}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        {children ??
          (reason === 'server_error' ? (
            <>
              <Button onClick={onRetry} className={PRIMARY}>
                {t('tryAgain')}
              </Button>
              <Link href="/signup">
                <Button variant="outline" className={OUTLINE}>
                  {t('createNewAccount')}
                </Button>
              </Link>
            </>
          ) : (
            <>
              <Link href="/signup">
                <Button className={PRIMARY}>{t('createNewAccount')}</Button>
              </Link>
              <Link href="/login">
                <Button variant="outline" className={OUTLINE}>
                  {t('signIn')}
                </Button>
              </Link>
            </>
          ))}
      </CardContent>
    </Card>
  );
}

/** The inside of the 409 modal (exported so it can be rendered on its own). */
export function JoinConflictBody({
  message,
  accountName,
  onSignOut,
  signingOut,
}: {
  message: string;
  accountName: string | null;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const t = useTranslations('JoinPage');
  return (
    <>
      <DialogHeader>
        <DialogTitle className="text-popover-foreground flex items-center gap-2">
          <AlertTriangle className="size-4 shrink-0 text-amber-400" />
          {accountName
            ? t('conflict.title', { account: accountName })
            : t('conflict.titleNoName')}
        </DialogTitle>
        <DialogDescription className="text-muted-foreground">
          {message === CONFLICT_FALLBACK ? t('conflict.fallback') : message}
        </DialogDescription>
      </DialogHeader>
      <p className="text-muted-foreground py-2 text-xs">{t('conflict.hint')}</p>
      <DialogFooter className="bg-popover border-border">
        <Link href="/dashboard">
          <Button
            variant="outline"
            className="border-border text-popover-foreground hover:bg-muted w-full"
          >
            {t('conflict.goToMyAccount')}
          </Button>
        </Link>
        <Button
          onClick={onSignOut}
          disabled={signingOut}
          aria-busy={signingOut}
          className="bg-primary text-primary-foreground hover:bg-primary/90"
        >
          {signingOut ? (
            <>
              <Loader2 className="size-4 animate-spin" />
              {t('conflict.signingOut')}
            </>
          ) : (
            t('conflict.signOut')
          )}
        </Button>
      </DialogFooter>
    </>
  );
}
