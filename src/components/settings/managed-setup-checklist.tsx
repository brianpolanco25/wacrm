'use client';

// ============================================================
// s10.6 — checklist for connecting a MANAGED number (option A of
// fase 10): the customer's WABA lives in Cabbity's own Meta portfolio,
// paid with Cabbity's card, so the number skips Embedded Signup and is
// connected through the manual form with a permanent system-user token.
//
// Everything on the list happens in Meta's Business Manager, not here:
// the boxes are a memory aid for whoever is doing the paperwork, kept in
// component state only (nothing is stored, nothing is sent), and they
// reset on reload. That is on purpose — a stored "done" would read as the
// CRM vouching for a step it cannot see.
//
// No links to Meta: the repo has no verified URL for these screens, and a
// guessed one rots silently. Each step says where to look instead, with
// «verify in the Business Manager».
//
// Shown only when the account's subscription says Cabbity pays Meta
// (`subscriptions.meta_billing = 'managed'`, migration 076). Any other
// value — `direct`, unknown, not loaded yet — renders nothing.
// ============================================================

import { useState } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { useTranslations } from 'next-intl';
import { Building2 } from 'lucide-react';

import { Checkbox } from '@/components/ui/checkbox';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';

export type ManagedSetupBilling = 'managed' | 'direct';

/** The steps of option A, in the order they have to happen. */
export const MANAGED_SETUP_STEPS = [
  'waba',
  'number',
  'token',
  'displayName',
  'paste',
] as const;

export type ManagedSetupStep = (typeof MANAGED_SETUP_STEPS)[number];

export interface ManagedSetupLabels {
  addNumber: string;
  manualSetup: string;
  phoneNumberId: string;
  wabaId: string;
  accessToken: string;
  testConnection: string;
}

/** Steps that are paperwork in Meta (all but the last, which is here). */
export const META_STEPS: ReadonlySet<ManagedSetupStep> = new Set([
  'waba',
  'number',
  'token',
  'displayName',
]);

/** Pure toggle so the checkbox state can be tested without a DOM. */
export function toggleStep(
  done: ReadonlySet<ManagedSetupStep>,
  step: ManagedSetupStep,
  checked: boolean
): Set<ManagedSetupStep> {
  const next = new Set(done);
  if (checked) next.add(step);
  else next.delete(step);
  return next;
}

/**
 * Who pays Meta for this account, read with the browser client.
 *
 * `subscriptions_select` (041) lets any member read the account's own row
 * (and a support session, 057); the explicit `account_id` filter is the
 * house rule on top of RLS. `null` = unknown (no account, read failed):
 * the caller shows nothing, never a guess. No row, or any value other
 * than `managed`, is `direct` — the same narrowing as `asMetaBilling` in
 * `entitlements.ts`, which is not imported here because it lives next to
 * the service-role client.
 */
export async function fetchMetaBilling(
  supabase: SupabaseClient,
  accountId: string
): Promise<ManagedSetupBilling | null> {
  try {
    const { data, error } = await supabase
      .from('subscriptions')
      .select('meta_billing')
      .eq('account_id', accountId)
      .maybeSingle();
    if (error) return null;
    const value = (data as { meta_billing?: unknown } | null)?.meta_billing;
    return value === 'managed' ? 'managed' : 'direct';
  } catch {
    return null;
  }
}

export function ManagedSetupChecklist({
  metaBilling,
  fieldLabels,
  initialDone,
}: {
  metaBilling: ManagedSetupBilling | null;
  /**
   * The labels of the page and its manual form, so "paste it here" names
   * the buttons and fields the reader actually sees.
   */
  fieldLabels: ManagedSetupLabels;
  /** Test seam; the page never passes it. */
  initialDone?: ManagedSetupStep[];
}) {
  const t = useTranslations('Settings.managedSetup');
  const [done, setDone] = useState<Set<ManagedSetupStep>>(
    () => new Set(initialDone ?? [])
  );

  if (metaBilling !== 'managed') return null;

  return (
    <Card data-testid="managed-setup-checklist">
      <CardHeader>
        <CardTitle className="text-foreground flex items-center gap-2">
          <Building2 className="size-4" />
          {t('title')}
        </CardTitle>
        <CardDescription className="text-muted-foreground">
          {t('description')}
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <ol className="space-y-3">
          {MANAGED_SETUP_STEPS.map((step, index) => {
            const checked = done.has(step);
            const id = `managed-setup-${step}`;
            return (
              <li
                key={step}
                data-step={step}
                data-done={checked ? 'true' : 'false'}
                className="border-border flex items-start gap-3 rounded-md border p-3"
              >
                <Checkbox
                  id={id}
                  checked={checked}
                  onCheckedChange={(value) =>
                    setDone((current) =>
                      toggleStep(current, step, value === true)
                    )
                  }
                  aria-label={t(`steps.${step}.title`)}
                  className="mt-0.5"
                />
                <div className="min-w-0 space-y-1">
                  <label
                    htmlFor={id}
                    className={
                      'text-foreground block text-sm font-medium ' +
                      (checked ? 'line-through opacity-70' : '')
                    }
                  >
                    {index + 1}. {t(`steps.${step}.title`)}
                  </label>
                  <p className="text-muted-foreground text-xs leading-relaxed">
                    {step === 'paste'
                      ? t('steps.paste.body', { ...fieldLabels })
                      : t(`steps.${step}.body`)}
                  </p>
                  <p className="text-xs font-medium text-amber-600 dark:text-amber-500">
                    {META_STEPS.has(step) ? t('inMeta') : t('inCrm')}
                  </p>
                </div>
              </li>
            );
          })}
        </ol>
        <p className="text-muted-foreground text-xs">{t('localOnly')}</p>
        <p className="text-muted-foreground text-xs">{t('tokenNote')}</p>
      </CardContent>
    </Card>
  );
}
