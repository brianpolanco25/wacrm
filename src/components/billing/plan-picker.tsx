'use client';

// ============================================================
// PlanPicker — step 1 of contracting (Fase 3 §2).
//
// Lists the public catalogue, lets an admin pick a billing cycle and
// sends them to PayPal's approval page. It never claims the plan is
// active: the approval link is the end of this component's job, and
// what happens after the customer approves is decided by the webhook.
//
// The catalogue comes from `/api/billing/plans`, which reports the
// contractable cycles as booleans — the PayPal plan ids stay on the
// server.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { Check, Loader2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RequireRole } from '@/components/auth/require-role';
import { cn } from '@/lib/utils';

type Cycle = 'month' | 'year';

interface CataloguePlan {
  id: string;
  name: string;
  limits: Record<string, number | null>;
  priceMonth: string | null;
  priceYear: string | null;
  availableCycles: { month: boolean; year: boolean };
}

/** Limit keys rendered on the card, in order. */
const SHOWN_LIMITS = [
  'operators',
  'messages_out',
  'ai_replies',
  'broadcast_recipients',
] as const;

const LIMIT_KEY: Record<(typeof SHOWN_LIMITS)[number], string> = {
  operators: 'limitOperators',
  messages_out: 'limitMessagesOut',
  ai_replies: 'limitAiReplies',
  broadcast_recipients: 'limitBroadcastRecipients',
};

export function PlanPicker() {
  const t = useTranslations('Billing');
  const searchParams = useSearchParams();
  const [plans, setPlans] = useState<CataloguePlan[] | null>(null);
  const [cycle, setCycle] = useState<Cycle>('month');
  const [starting, setStarting] = useState<string | null>(null);

  const cancelled = searchParams.get('checkout') === 'cancelled';

  const load = useCallback(async () => {
    // Offline, DNS failure or a body that is not JSON reject instead of
    // returning `!res.ok`. Unhandled, that rejection escapes the effect
    // below and leaves `plans` at null — a spinner that never stops and
    // never says why. Same treatment as a refused response.
    try {
      const res = await fetch('/api/billing/plans', { cache: 'no-store' });
      if (!res.ok) throw new Error(`catalogue request failed: ${res.status}`);
      const data = (await res.json()) as { plans?: CataloguePlan[] };
      setPlans(data.plans ?? []);
    } catch {
      toast.error(t('loadFailed'));
      setPlans([]);
    }
  }, [t]);

  useEffect(() => {
    load();
  }, [load]);

  const startCheckout = useCallback(
    async (planId: string) => {
      setStarting(planId);
      try {
        const res = await fetch('/api/billing/checkout', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ planId, cycle }),
        });
        const payload = (await res.json().catch(() => ({}))) as {
          approvalUrl?: string;
          error?: string;
        };
        if (!res.ok || !payload.approvalUrl) {
          toast.error(payload.error || t('checkoutFailed'));
          setStarting(null);
          return;
        }
        // Off to PayPal. `assign` (not `replace`) so the browser Back
        // button brings an undecided customer back to this list.
        window.location.assign(payload.approvalUrl);
      } catch {
        toast.error(t('checkoutFailed'));
        setStarting(null);
      }
    },
    [cycle, t]
  );

  const price = (plan: CataloguePlan) =>
    cycle === 'year' ? plan.priceYear : plan.priceMonth;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-foreground text-2xl font-bold">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t('subtitle')}</p>
      </div>

      {cancelled && (
        <div className="border-border bg-muted/40 text-muted-foreground rounded-xl border p-4 text-sm">
          {t('cancelledNotice')}
        </div>
      )}

      <div
        role="group"
        aria-label={t('cycleLabel')}
        className="border-border inline-flex rounded-lg border p-1"
      >
        {(['month', 'year'] as const).map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => setCycle(option)}
            aria-pressed={cycle === option}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm transition-colors',
              cycle === option
                ? 'bg-primary text-primary-foreground'
                : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {option === 'month' ? t('cycleMonthly') : t('cycleYearly')}
          </button>
        ))}
      </div>

      {plans === null ? (
        <div className="flex h-48 items-center justify-center">
          <Loader2 className="text-primary h-6 w-6 animate-spin" />
        </div>
      ) : (
        <div className="grid gap-4 md:grid-cols-3">
          {plans.map((plan) => {
            const available = plan.availableCycles[cycle];
            const amount = price(plan);
            return (
              <Card key={plan.id}>
                <CardContent className="space-y-4 p-6">
                  <div>
                    <h2 className="text-foreground text-lg font-semibold">
                      {plan.name}
                    </h2>
                    <p className="text-foreground mt-1 text-2xl font-bold">
                      {amount
                        ? cycle === 'year'
                          ? t('priceYear', { price: amount })
                          : t('priceMonth', { price: amount })
                        : '—'}
                    </p>
                  </div>

                  <ul className="text-muted-foreground space-y-1.5 text-sm">
                    {SHOWN_LIMITS.map((key) => {
                      const value = plan.limits?.[key];
                      return (
                        <li key={key} className="flex items-start gap-2">
                          <Check
                            className="text-primary mt-0.5 h-4 w-4 flex-shrink-0"
                            aria-hidden
                          />
                          <span>
                            {t(LIMIT_KEY[key], {
                              count:
                                value === null || value === undefined
                                  ? t('unlimited')
                                  : String(value),
                            })}
                          </span>
                        </li>
                      );
                    })}
                  </ul>

                  <RequireRole
                    min="admin"
                    fallback={
                      <p className="text-muted-foreground text-xs">
                        {t('adminOnly')}
                      </p>
                    }
                  >
                    <Button
                      className="w-full"
                      disabled={!available || starting !== null}
                      onClick={() => startCheckout(plan.id)}
                    >
                      {starting === plan.id && (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      )}
                      {available ? t('choose') : t('cycleUnavailable')}
                    </Button>
                  </RequireRole>
                </CardContent>
              </Card>
            );
          })}
        </div>
      )}

      <p className="text-muted-foreground text-xs">{t('taxNote')}</p>
    </div>
  );
}
