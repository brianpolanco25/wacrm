import { Gift } from 'lucide-react';

import { cn } from '@/lib/utils';

interface FreeWindowBadgeProps {
  /** Ya traducido: «Ventana gratis hasta …». */
  label: string;
  /** Ya traducido: por qué es gratis y hasta cuándo. */
  title: string;
  className?: string;
}

/**
 * Ventana gratis de punto de entrada (p11.6): la conversación empezó
 * desde un anuncio Click to WhatsApp y Meta no cobra los mensajes del
 * negocio hasta la hora indicada. Presentacional: el padre decide si se
 * muestra (`freeWindowUntil`) y pasa los textos.
 *
 * Marca y color a la vez, nunca solo color. `data-free-window` es el
 * gancho de los tests.
 */
export function FreeWindowBadge({
  label,
  title,
  className,
}: FreeWindowBadgeProps) {
  return (
    <span
      data-free-window
      title={title}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 text-[11px] leading-4 text-emerald-600 dark:text-emerald-400',
        className
      )}
    >
      <Gift className="h-3 w-3 shrink-0" aria-hidden="true" />
      <span className="truncate">{label}</span>
    </span>
  );
}
