'use client';

// ============================================================
// /join/[token] — the invitation link (i12.1).
//
// No "Accept" button. On load:
//
//   signed in  → the invitation is redeemed once, automatically, and a
//                200 sends the person to /dashboard with a full reload
//                (so the AuthProvider reads the new account). That
//                covers the existing user with an empty personal
//                account (moved in) and the person who signed up
//                through the link or came from the operator's email
//                (already a member since migration 090: a no-op).
//                409 opens the conflict modal; 400 shows why.
//   signed out → the company and the role, with "Create account &
//                join" → /signup?invite= and "I already have an
//                account" → /login?invite=.
//
// The decision lives in `resolveJoin` (src/lib/auth/join-flow.ts) and
// the rendering in `JoinView`; this file only wires them to the
// browser. The redeem RPC's guard (sole owner of an EMPTY personal
// account) is what makes joining without a confirmation click safe.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import { useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';

import { resolveJoin, type JoinState } from '@/lib/auth/join-flow';
import { createClient, endSupportSession } from '@/lib/supabase/client';

import { JoinView } from './join-view';

export default function JoinPage() {
  const params = useParams<{ token: string }>();
  const token = params?.token ?? '';
  const t = useTranslations('JoinPage');

  const [state, setState] = useState<JoinState | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  // Resolves the state; never sets it (the callers do, after the await).
  const resolve = useCallback(
    () =>
      resolveJoin({
        token,
        isSignedIn: async () => {
          // The AuthProvider lives inside the (dashboard) group and does
          // not reach this page: ask Supabase directly, as /login does.
          const { data } = await createClient().auth.getUser();
          return Boolean(data.user);
        },
      }),
    [token]
  );

  // Once per page load. StrictMode (dev) mounts twice; without the ref
  // the invitation would be POSTed twice. The first pass is never
  // cancelled, so its result still lands.
  const started = useRef(false);
  useEffect(() => {
    if (!token || started.current) return;
    started.current = true;
    void resolve().then((next) => {
      if (next.kind === 'redirect') {
        // Full reload so the AuthProvider reads the new account.
        window.location.replace(next.to);
        return;
      }
      setState(next);
    });
  }, [token, resolve]);

  const retry = useCallback(() => {
    setState(null);
    void resolve().then((next) => {
      if (next.kind === 'redirect') {
        window.location.replace(next.to);
        return;
      }
      setState(next);
    });
  }, [resolve]);

  const handleSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      // End the support session first, exactly as `useAuth().signOut()`
      // does. This is the other sign-out in the app, and skipping it
      // would leave the bitácora row open and both support cookies alive
      // for whoever signs in next on this browser — the httpOnly one
      // cannot be dropped from here any other way.
      await endSupportSession();
      await createClient().auth.signOut();
      // Hard reload: the page comes back signed out, with the token
      // still in the URL, and shows "Create account & join".
      window.location.reload();
    } catch (err) {
      console.error('[join] sign-out error:', err);
      toast.error(t('signOutError'));
      setSigningOut(false);
    }
  }, [t]);

  return (
    <JoinView
      state={state}
      token={token}
      onRetry={retry}
      onSignOut={handleSignOut}
      signingOut={signingOut}
    />
  );
}
