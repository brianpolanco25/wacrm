'use client';

// ============================================================
// /reset-password — choose a password (s9.8).
//
// Both an invitation (the owner an operator created in s9.4, or a
// member invited by email) and a recovery link end up here through
// `/auth/callback`, with a session already open. Without one there is
// nothing to update: the page says so and points at /forgot-password.
// `?invite=<token>` is carried to `/join/<token>` afterwards, and
// `?welcome=1` (set for invitations) only changes the wording.
// ============================================================

import { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { ArrowRight, Eye, EyeOff, KeyRound, Loader2, Lock } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  MIN_PASSWORD_LENGTH,
  submitNewPassword,
  type NewPasswordError,
} from '@/lib/auth/reset-password';
import { createClient } from '@/lib/supabase/client';

// `useSearchParams` needs a Suspense boundary to keep the page
// prerenderable — same pattern as /login and /signup.
export default function ResetPasswordPage() {
  return (
    <Suspense fallback={null}>
      <ResetPasswordInner />
    </Suspense>
  );
}

const FIELD_CLASS =
  'h-12 rounded-xl border-border bg-muted/50 pl-11 pr-12 text-base text-foreground shadow-none placeholder:text-muted-foreground/70 focus-visible:border-primary focus-visible:bg-card focus-visible:ring-primary/20 md:text-[0.95rem]';

type SessionState = 'checking' | 'ready' | 'missing';

function ResetPasswordInner() {
  const t = useTranslations('ResetPassword');
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get('invite');
  const welcome = searchParams.get('welcome') === '1' || Boolean(inviteToken);

  const [session, setSession] = useState<SessionState>('checking');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState<NewPasswordError | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void createClient()
      .auth.getUser()
      .then(({ data }) => {
        if (!cancelled) setSession(data?.user ? 'ready' : 'missing');
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    const result = await submitNewPassword({
      password,
      confirm,
      invite: inviteToken,
      auth: createClient().auth,
    });
    if (!result.ok) {
      if (result.error === 'noSession') setSession('missing');
      setError(result.error);
      setLoading(false);
      return;
    }
    // Full-page navigation so the middleware sees the session (#365).
    window.location.href = result.destination;
  };

  if (session === 'checking') {
    return (
      <AuthCard
        title={t('checking')}
        icon={<Loader2 className="size-6 animate-spin" />}
      >
        <span className="sr-only" role="status">
          {t('checking')}
        </span>
      </AuthCard>
    );
  }

  if (session === 'missing') {
    return (
      <AuthCard
        title={t('noSessionTitle')}
        description={t('noSessionDesc')}
        icon={<KeyRound className="size-6" />}
      >
        <Link href="/forgot-password">
          <Button className="bg-primary text-primary-foreground hover:bg-primary-hover h-12 w-full rounded-xl text-base font-semibold">
            {t('requestNewLink')}
          </Button>
        </Link>
        <Link
          href="/login"
          className="text-muted-foreground hover:text-foreground text-center text-sm transition-colors"
        >
          {t('backToSignIn')}
        </Link>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={welcome ? t('titleWelcome') : t('titleReset')}
      description={welcome ? t('descWelcome') : t('descReset')}
      icon={<KeyRound className="size-6" />}
    >
      <form onSubmit={handleSubmit} className="flex flex-col gap-5">
        {error && (
          <div
            role="alert"
            className="border-destructive/20 bg-destructive/10 text-destructive rounded-xl border px-4 py-3 text-sm"
          >
            {t(`errors.${error}`, { min: MIN_PASSWORD_LENGTH })}
          </div>
        )}

        <div className="flex flex-col gap-2">
          <Label htmlFor="password" className="text-foreground">
            {t('passwordLabel')}
          </Label>
          <div className="relative">
            <Lock
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2"
            />
            <Input
              id="password"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder={t('passwordPlaceholder', {
                min: MIN_PASSWORD_LENGTH,
              })}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={MIN_PASSWORD_LENGTH}
              className={FIELD_CLASS}
            />
            <button
              type="button"
              onClick={() => setShowPassword((v) => !v)}
              aria-label={showPassword ? t('hidePassword') : t('showPassword')}
              aria-pressed={showPassword}
              className="text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-ring/40 absolute top-1/2 right-3 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg transition-colors focus-visible:ring-2 focus-visible:outline-none"
            >
              {showPassword ? (
                <EyeOff className="size-4.5" />
              ) : (
                <Eye className="size-4.5" />
              )}
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <Label htmlFor="confirmPassword" className="text-foreground">
            {t('confirmLabel')}
          </Label>
          <div className="relative">
            <Lock
              aria-hidden="true"
              className="text-muted-foreground pointer-events-none absolute top-1/2 left-4 size-4.5 -translate-y-1/2"
            />
            <Input
              id="confirmPassword"
              type={showPassword ? 'text' : 'password'}
              autoComplete="new-password"
              placeholder={t('confirmPlaceholder')}
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              className={FIELD_CLASS}
            />
          </div>
        </div>

        <Button
          type="submit"
          disabled={loading}
          className="group bg-primary text-primary-foreground hover:bg-primary-hover mt-1 h-12 w-full rounded-xl text-base font-semibold shadow-[0_12px_30px_-12px_var(--cb-token-brand)] transition-all hover:shadow-[0_16px_34px_-12px_var(--cb-token-brand)] disabled:opacity-60"
        >
          {loading ? (
            <>
              <Loader2 className="size-5 animate-spin" />
              {t('saving')}
            </>
          ) : (
            <>
              {t('submit')}
              <ArrowRight className="size-5 transition-transform duration-300 group-hover:translate-x-1" />
            </>
          )}
        </Button>
      </form>
    </AuthCard>
  );
}
