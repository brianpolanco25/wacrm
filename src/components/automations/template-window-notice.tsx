'use client';

// ============================================================
// "Template sent with the window open" notice for the automation
// builder (p11.5).
//
// Advice only: nothing here blocks a save, activation or edit, and the
// payload sent to the API does not change. The decision lives in the
// pure `templateWindowWarnings`; this file only renders it and shares
// the result through a context so the step editor (full notice) and the
// collapsed step header (badge) read the same map.
// ============================================================

import { createContext, useContext, useMemo, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  FREE_SERVICE_MESSAGES_PER_NUMBER,
  templateWindowWarnings,
  type TemplateWindowWarning,
  type WindowStep,
  type WindowTemplate,
} from '@/lib/automations/template-window';
import type { AutomationTriggerType } from '@/types';

export type MetaBilling = 'direct' | 'managed';

interface TemplateWindowState {
  warnings: Map<string, TemplateWindowWarning>;
  metaBilling: MetaBilling | undefined;
}

const TemplateWindowContext = createContext<TemplateWindowState>({
  warnings: new Map(),
  metaBilling: undefined,
});

/** Warnings for the current automation, keyed by step `cid`. */
export function useTemplateWindow(): TemplateWindowState {
  return useContext(TemplateWindowContext);
}

/**
 * Recomputes the warnings whenever the trigger, the step tree or the
 * synced templates change (R10). Templates still loading (`[]`) simply
 * yield no warnings.
 */
export function TemplateWindowProvider({
  triggerType,
  steps,
  templates,
  metaBilling,
  children,
}: {
  triggerType: AutomationTriggerType;
  steps: WindowStep[];
  templates: WindowTemplate[];
  metaBilling: MetaBilling | undefined;
  children: ReactNode;
}) {
  const warnings = useMemo(
    () => templateWindowWarnings(triggerType, steps, templates),
    [triggerType, steps, templates]
  );
  const value = useMemo(
    () => ({ warnings, metaBilling }),
    [warnings, metaBilling]
  );
  return (
    <TemplateWindowContext.Provider value={value}>
      {children}
    </TemplateWindowContext.Provider>
  );
}

/**
 * Full notice under the template picker. `metaBilling` unknown is
 * treated as `direct`: the quota sentence applies to most customers.
 */
export function TemplateWindowNotice({
  kind,
  metaBilling,
}: {
  kind: TemplateWindowWarning | undefined;
  metaBilling: MetaBilling | undefined;
}) {
  const t = useTranslations('Automations.builder.templateWindow');
  if (!kind) return null;
  return (
    <Alert className="mt-2 border-amber-500/40" data-template-window={kind}>
      <AlertTriangle className="text-amber-500" aria-hidden />
      <AlertTitle>{t('title')}</AlertTitle>
      <AlertDescription>
        <p>
          {kind === 'utility' ? t('utility') : t('marketing')}
          {metaBilling !== 'managed' && (
            <>
              {' '}
              {t('quotaNote', { freeTier: FREE_SERVICE_MESSAGES_PER_NUMBER })}
            </>
          )}
        </p>
        <p className="text-xs">{t('estimate')}</p>
      </AlertDescription>
    </Alert>
  );
}

/** Amber marker on the collapsed step header. */
export function TemplateWindowBadge() {
  const t = useTranslations('Automations.builder.templateWindow');
  const label = t('badge');
  return (
    <span
      role="img"
      aria-label={label}
      title={label}
      className="flex-shrink-0 text-amber-500"
      data-template-window-badge=""
    >
      <AlertTriangle className="h-4 w-4" aria-hidden />
    </span>
  );
}
