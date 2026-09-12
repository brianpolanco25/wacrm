'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { Eye, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import type { SupportBanner } from '@/lib/auth/support-view';

/**
 * Permanent notice that this browser is looking at somebody else's
 * company.
 *
 * It sits ABOVE the header rather than inside the page area on purpose:
 * an operator scrolls, switches pages and gets interrupted, and the one
 * thing that must never scroll out of view is "these are not your
 * customers". The exit button is here for the same reason — the way out
 * has to be wherever the warning is.
 *
 * Renders nothing outside a support session, which is every request but
 * a handful.
 */
export function ImpersonationBanner({
  session,
}: {
  session: SupportBanner | null;
}) {
  const t = useTranslations('Impersonation');
  const [leaving, setLeaving] = useState(false);

  if (!session) return null;

  const exit = async () => {
    setLeaving(true);
    try {
      await fetch('/api/platform/impersonate/stop', { method: 'POST' });
    } catch {
      // The cookie may already be gone (expired, or stopped in another
      // tab). Leaving is never blocked by the network.
    }
    // Full reload, not router.refresh(): every server component on the
    // page was rendered against the impersonated account and the account
    // context lives in a cookie the client cannot see change.
    window.location.href = '/dashboard';
  };

  return (
    <div
      role="status"
      aria-live="polite"
      className="flex flex-wrap items-center justify-between gap-2 border-b border-amber-500/40 bg-amber-500/15 px-4 py-2 text-sm text-amber-900 dark:text-amber-100"
    >
      <span className="flex items-center gap-2">
        <Eye className="h-4 w-4 shrink-0" />
        <span>
          {t('viewing', {
            // The name is absent when the impersonated account could not be
            // read (deleted mid-session). The banner still renders: it
            // carries the exit button.
            account: session.accountName ?? t('unknownAccount'),
          })}
        </span>
      </span>
      <Button size="sm" variant="outline" onClick={exit} disabled={leaving}>
        {leaving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
        {leaving ? t('exiting') : t('exit')}
      </Button>
    </div>
  );
}
