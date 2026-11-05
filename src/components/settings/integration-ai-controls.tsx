'use client';

// ============================================================
// IntegrationAiControls — «Usar en IA» de una integración activada
// (n13.3, R34). Presentacional y sin estado: el PATCH y el diálogo de
// instrucciones/zona viven en `integrations-settings.tsx`. Solo aparece
// con la integración activada; en solo lectura o sin plan, todo
// deshabilitado.
// ============================================================

import { Bot } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';
import { Switch } from '@/components/ui/switch';
import type { AccountIntegrationView } from '@/lib/integrations/types';
import type { AccountIntegrationAiFields } from '@/lib/ai/tools/types';

export type IntegrationViewWithAi = AccountIntegrationView &
  Partial<AccountIntegrationAiFields>;

export function IntegrationAiControls({
  integration,
  disabled,
  onToggle,
  onEdit,
}: {
  integration: IntegrationViewWithAi;
  disabled: boolean;
  onToggle: (next: boolean) => void;
  onEdit: () => void;
}) {
  const t = useTranslations('Settings.integrations');
  if (!integration.enabled) return null;
  const on = integration.aiEnabled === true;
  const switchId = `integration-ai-${integration.id}`;

  return (
    <div
      className="border-border flex flex-col gap-2 rounded-lg border p-3"
      data-ai-controls={integration.slug}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <label
            htmlFor={switchId}
            className="text-foreground flex items-center gap-1.5 text-sm font-medium"
          >
            <Bot className="text-primary size-4" aria-hidden />
            {t('aiToggle')}
          </label>
          <p className="text-muted-foreground mt-0.5 text-xs">
            {t('aiToggleHint')}
          </p>
        </div>
        <Switch
          id={switchId}
          checked={on}
          disabled={disabled}
          aria-label={t('aiToggle')}
          onCheckedChange={(next) => onToggle(next)}
          data-ai-toggle
        />
      </div>
      {on ? (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onEdit}
            disabled={disabled}
            data-action="ai-instructions"
          >
            {t('aiInstructionsButton')}
          </Button>
          {integration.aiTimezone ? (
            <span className="text-muted-foreground text-xs" data-ai-timezone>
              {t('aiTimezoneLabel')}: {integration.aiTimezone}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
