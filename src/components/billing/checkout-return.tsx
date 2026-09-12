'use client';

// ============================================================
// CheckoutReturn — the page PayPal sends the customer back to
// (Fase 3 §2, "the trap to avoid").
//
// It ACTIVATES NOTHING. It polls a read-only endpoint and waits for
// the webhook to do its job. Two failures this prevents:
//
//   - the customer who closes the browser after approving would never
//     get service if this page were the activator;
//   - anyone at all could gift themselves a plan by opening this URL
//     by hand.
//
// So the only thing that can change here is what the screen says.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { CheckCircle2, Clock, Loader2 } from 'lucide-react';

import { buttonVariants } from '@/components/ui/button';

/** How often we ask "did the event land?". */
const POLL_MS = 4000;
/** Give up polling after this long and tell the truth: still waiting. */
const POLL_TIMEOUT_MS = 150_000;

interface StatusPayload {
  intent: { planId: string; cycle: string; status: string } | null;
  subscription: {
    planId: string;
    /** Catalogue name ('Pro'); null if the plan vanished from it. */
    planName: string | null;
    status: string;
  } | null;
  activated: boolean;
}

type Phase = 'confirming' | 'active' | 'slow';

export function CheckoutReturn() {
  const t = useTranslations('Billing.return');
  const searchParams = useSearchParams();
  const subscriptionId = searchParams.get('subscription_id');

  const [phase, setPhase] = useState<Phase>('confirming');
  const [planName, setPlanName] = useState<string | null>(null);

  const poll = useCallback(async (): Promise<boolean> => {
    const query = subscriptionId
      ? `?subscription_id=${encodeURIComponent(subscriptionId)}`
      : '';
    const res = await fetch(`/api/billing/checkout${query}`, {
      cache: 'no-store',
    });
    if (!res.ok) return false;
    const data = (await res.json()) as StatusPayload;
    if (data.activated) {
      // The name the customer chose, not the internal id. Falling back
      // to the id keeps the sentence readable if the catalogue lost it.
      setPlanName(
        data.subscription?.planName ??
          data.subscription?.planId ??
          data.intent?.planId ??
          null
      );
      setPhase('active');
      return true;
    }
    return false;
  }, [subscriptionId]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    // Read the clock inside the effect, not during render.
    const deadline = Date.now() + POLL_TIMEOUT_MS;

    const tick = async () => {
      if (cancelled) return;
      let done = false;
      try {
        done = await poll();
      } catch {
        // Network hiccup — keep waiting; the webhook does not depend
        // on this page succeeding.
      }
      if (cancelled || done) return;
      if (Date.now() >= deadline) {
        setPhase('slow');
        return;
      }
      timer = setTimeout(tick, POLL_MS);
    };

    tick();
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [poll]);

  return (
    <div className="mx-auto flex max-w-xl flex-col items-center gap-4 py-16 text-center">
      {phase === 'active' ? (
        <CheckCircle2 className="text-primary h-10 w-10" aria-hidden />
      ) : phase === 'slow' ? (
        <Clock className="text-muted-foreground h-10 w-10" aria-hidden />
      ) : (
        <Loader2 className="text-primary h-10 w-10 animate-spin" aria-hidden />
      )}

      <h1 className="text-foreground text-2xl font-bold">
        {phase === 'active'
          ? t('activeTitle')
          : phase === 'slow'
            ? t('slowTitle')
            : t('title')}
      </h1>

      <p className="text-muted-foreground text-sm">
        {phase === 'active'
          ? t('activeBody', { plan: planName ?? '' })
          : phase === 'slow'
            ? t('slowBody')
            : t('body')}
      </p>

      {/* Anchor styled with `buttonVariants`: the wacrm Button is the
          Base UI primitive and has no Radix-style `asChild` slot. */}
      <Link
        href="/dashboard"
        className={buttonVariants({
          variant: phase === 'active' ? 'default' : 'outline',
        })}
      >
        {t('backToDashboard')}
      </Link>
    </div>
  );
}
