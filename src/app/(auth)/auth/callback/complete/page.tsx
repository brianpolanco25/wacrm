'use client';

// ============================================================
// /auth/callback/complete — the browser half of the callback (s9.8).
//
// `/auth/callback` sends here whatever it could not finish on the
// server: an error from Supabase, or an implicit-flow link
// (`inviteUserByEmail` with the default email template) whose tokens
// travel in `#access_token=…`, which never reaches a server. This page
// reads the fragment, opens the session with `setSession` and moves on
// with a full-page navigation, so the next request carries the new
// cookies to the middleware (same reason as /login, issue #365).
// ============================================================

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useTranslations } from 'next-intl';
import { Loader2, MailX } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import { Button } from '@/components/ui/button';
import {
  completeAuthCallback,
  type CallbackErrorReason,
} from '@/lib/auth/callback';
import { createClient } from '@/lib/supabase/client';

export default function AuthCallbackCompletePage() {
  const t = useTranslations('AuthCallback');
  const [reason, setReason] = useState<CallbackErrorReason | null>(null);

  useEffect(() => {
    let cancelled = false;
    const { hash, search, pathname } = window.location;
    // The tokens must not linger in the address bar or in history,
    // whatever happens next.
    if (hash) {
      window.history.replaceState(window.history.state, '', pathname + search);
    }
    void completeAuthCallback({
      hash,
      search,
      auth: createClient().auth,
    }).then((result) => {
      if (cancelled) return;
      if (result.ok) window.location.replace(result.destination);
      else setReason(result.reason);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!reason) {
    return (
      <AuthCard
        title={t('title')}
        description={t('description')}
        icon={<Loader2 className="size-6 animate-spin" />}
      >
        <span className="sr-only" role="status">
          {t('description')}
        </span>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title={t('errorTitle')}
      description={t(`errors.${reason}`)}
      icon={<MailX className="size-6" />}
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
