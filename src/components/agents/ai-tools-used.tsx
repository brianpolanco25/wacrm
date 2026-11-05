'use client';

// ============================================================
// Herramientas usadas en un turno de IA (n13.3, R35). Presentacional:
// la línea «Usó: …» bajo la respuesta del playground y el aviso fijo de
// que las herramientas se ejecutan de verdad.
// ============================================================

import { TriangleAlert, Wrench } from 'lucide-react';
import { useTranslations } from 'next-intl';

import type { ToolUseRecord } from '@/lib/ai/tools/types';

export function ToolsUsedLine({ toolsUsed }: { toolsUsed: ToolUseRecord[] }) {
  const t = useTranslations('AiTools');
  if (toolsUsed.length === 0) return null;
  const label = `${t('used')} ${toolsUsed
    .map(
      (u) => `${u.integration} · ${u.operation} ${u.ok ? t('ok') : t('failed')}`
    )
    .join(', ')}`;
  return (
    <p
      className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-1 text-xs"
      aria-label={label}
      data-tools-used
    >
      <Wrench className="size-3.5" aria-hidden />
      <span aria-hidden>{t('used')}</span>
      {toolsUsed.map((u, i) => (
        <span
          key={`${u.integration}-${u.operation}-${i}`}
          aria-hidden
          data-tool-ok={u.ok ? 'true' : 'false'}
          className={u.ok ? undefined : 'text-destructive'}
        >
          {u.integration} · {u.operation} {u.ok ? '✓' : '✗'}
          {i < toolsUsed.length - 1 ? ',' : ''}
        </span>
      ))}
    </p>
  );
}

export function PlaygroundToolsNotice() {
  const t = useTranslations('AiTools');
  return (
    <p
      className="border-border text-muted-foreground flex items-center gap-1.5 border-b px-4 py-2 text-xs"
      role="note"
      data-playground-tools-notice
    >
      <TriangleAlert className="size-3.5 shrink-0 text-amber-500" aria-hidden />
      {t('playgroundNotice')}
    </p>
  );
}
