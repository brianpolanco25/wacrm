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

import { useEffect, useRef, useState } from 'react';
import { useTranslations } from 'next-intl';
import { Loader2 } from 'lucide-react';

import { AuthCard } from '@/components/auth/auth-card';
import {
  completeAuthCallback,
  type CallbackErrorReason,
} from '@/lib/auth/callback';
import { isSameOriginPath } from '@/lib/auth/redirects';
import { createClient } from '@/lib/supabase/client';

import { CallbackFailure } from './callback-failure';

export default function AuthCallbackCompletePage() {
  const t = useTranslations('AuthCallback');
  // The reason, and the query of this page for the failure screen's
  // links (they keep `?invite=`, i12.1).
  const [failure, setFailure] = useState<{
    reason: CallbackErrorReason;
    search: string;
  } | null>(null);

  // Runs once per page load. React's StrictMode (on in dev) mounts,
  // unmounts and mounts again: a second pass would find the fragment
  // already wiped from the address bar and lose the link's `type`. So
  // the URL is read once, and the first pass is never cancelled —
  // StrictMode keeps the same state, so its result still lands.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
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
      if (!result.ok) {
        setFailure({ reason: result.reason, search });
        return;
      }
      // Last line of defence: never leave the site, whatever was built.
      window.location.replace(
        isSameOriginPath(result.destination) ? result.destination : '/dashboard'
      );
    });
  }, []);

  if (!failure) {
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

  return <CallbackFailure reason={failure.reason} search={failure.search} />;
}
