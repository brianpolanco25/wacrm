'use client';

import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { createClient } from '@/lib/supabase/client';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { AuthCard } from '@/components/auth/auth-card';
import {
  isInviteSignupRejection,
  signupInviteGate,
  signupOptions,
} from '@/lib/auth/signup-invite';
import { CheckCircle, UsersRound } from 'lucide-react';

import {
  SignupInviteCheckEmail,
  SignupInviteChecking,
  SignupInviteFail,
  useSignupInviteCopy,
} from './signup-invite-view';

// `useSearchParams` opts the component out of static prerendering
// unless wrapped in Suspense — same pattern as /login.
export default function SignupPage() {
  return (
    <Suspense fallback={null}>
      <SignupPageInner />
    </Suspense>
  );
}

const FIELD_CLASS =
  'h-12 rounded-xl border-border bg-muted/50 text-base text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:bg-card focus-visible:ring-primary/20 md:text-[0.95rem]';

function SignupPageInner() {
  const searchParams = useSearchParams();
  // When the user lands here from `/join/<token>` the invite token comes
  // in the query (i12.1). It is checked before the form shows, and it
  // goes to `signUp` as `invite_token`: the database trigger
  // (migration 090) creates the person INSIDE the company. The
  // confirmation link still carries it to /join/<token>, where the
  // automatic redeem is a no-op for someone already in.
  const inviteToken = searchParams.get('invite');

  // Raw peek answer; `undefined` = not answered yet.
  const [peekBody, setPeekBody] = useState<unknown | undefined>(undefined);
  const loadPeek = useCallback(async (): Promise<unknown> => {
    if (!inviteToken) return undefined;
    try {
      const res = await fetch(
        `/api/invitations/${encodeURIComponent(inviteToken)}/peek`,
        { cache: 'no-store' }
      );
      return await res.json();
    } catch {
      return { ok: false, reason: 'server_error' };
    }
  }, [inviteToken]);

  useEffect(() => {
    if (!inviteToken) return;
    let cancelled = false;
    void loadPeek().then((body) => {
      if (!cancelled) setPeekBody(body);
    });
    return () => {
      cancelled = true;
    };
  }, [inviteToken, loadPeek]);

  const gate = signupInviteGate(inviteToken, peekBody);
  const invitePeek = gate.kind === 'ok' ? gate.peek : null;
  const inviteCopy = useSignupInviteCopy(invitePeek);
  const t = useTranslations('SignupInvite');

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const supabase = createClient();

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters');
      return;
    }

    setLoading(true);

    // The verification email comes back through /auth/callback (s9.8),
    // which exchanges the PKCE code for a session and then sends the
    // user to /join/<token> when there is an invite, or to the
    // dashboard. With an invite, `invite_token` also rides in the user
    // metadata for the signup trigger (i12.1).
    const { error } = await supabase.auth.signUp({
      email,
      password,
      options: signupOptions({
        fullName,
        inviteToken: invitePeek ? inviteToken : null,
        origin: window.location.origin,
      }),
    });

    if (error) {
      if (invitePeek && isInviteSignupRejection(error)) {
        // The trigger refused the invitation (used meanwhile, expired,
        // the team filled up): say why, not GoTrue's database error.
        const body = await loadPeek();
        const again = signupInviteGate(inviteToken, body);
        if (again.kind === 'fail') {
          setPeekBody(body);
        } else {
          setError(t('rejected'));
        }
        setLoading(false);
        return;
      }
      setError(error.message);
      setLoading(false);
      return;
    }

    setSuccess(true);
    setLoading(false);
  };

  if (gate.kind === 'loading') return <SignupInviteChecking />;
  if (gate.kind === 'fail') {
    return (
      <SignupInviteFail
        reason={gate.reason}
        onRetry={() => {
          setPeekBody(undefined);
          void loadPeek().then(setPeekBody);
        }}
      />
    );
  }

  if (success && invitePeek && inviteToken) {
    return (
      <SignupInviteCheckEmail
        email={email}
        accountName={invitePeek.account_name}
        token={inviteToken}
      />
    );
  }

  if (success) {
    return (
      <AuthCard
        title="Check your email"
        description={
          <>
            We&apos;ve sent a confirmation link to{' '}
            <span className="text-foreground font-medium">{email}</span>. Please
            check your inbox and click the link to verify your account.
          </>
        }
        icon={<CheckCircle className="size-6" />}
      >
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : '/login'
          }
        >
          <Button
            variant="outline"
            className="border-border text-foreground hover:bg-muted h-12 w-full rounded-xl"
          >
            Back to sign in
          </Button>
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={inviteCopy ? inviteCopy.title : 'Create account'}
      description={
        inviteCopy ? inviteCopy.description : 'Get started with Cabbity CRM'
      }
      icon={inviteCopy ? <UsersRound className="size-6" /> : undefined}
    >
      <form onSubmit={handleSignup} className="flex flex-col gap-5">
        {error && (
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
          >
            {error}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="fullName" className="text-foreground">
            Full name
          </Label>
          <Input
            id="fullName"
            type="text"
            autoComplete="name"
            placeholder="John Doe"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="email" className="text-foreground">
            Email
          </Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="password" className="text-foreground">
            Password
          </Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            placeholder="At least 6 characters"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword" className="text-foreground">
            Confirm password
          </Label>
          <Input
            id="confirmPassword"
            type="password"
            autoComplete="new-password"
            placeholder="Repeat your password"
            value={confirmPassword}
            onChange={(e) => setConfirmPassword(e.target.value)}
            required
            className={FIELD_CLASS}
          />
        </div>

        <Button
          type="submit"
          disabled={loading}
          className="bg-primary text-primary-foreground hover:bg-primary-hover mt-1 h-12 w-full rounded-xl text-base font-semibold shadow-[0_12px_30px_-12px_var(--cb-token-brand)] disabled:opacity-60"
        >
          {loading ? 'Creating account...' : 'Create account'}
        </Button>
      </form>

      <p className="text-muted-foreground text-center text-sm">
        Already have an account?{' '}
        <Link
          href={
            inviteToken
              ? `/login?invite=${encodeURIComponent(inviteToken)}`
              : '/login'
          }
          className="text-brand-ink hover:text-brand-ink/80 font-semibold transition-colors"
        >
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
