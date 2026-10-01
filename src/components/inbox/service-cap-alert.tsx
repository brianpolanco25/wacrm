'use client';

// ============================================================
// ServiceCapAlert — franja ámbar de la bandeja cuando un número agotó
// los mensajes de servicio gratis del mes (p11.3, R16).
//
// Sin botón de cerrar: mientras dure el mes, Meta cobra cada respuesta
// de ese número y eso no se descarta. Nombra los números agotados y, si
// la cuenta eligió `pause_ai`, dice hasta cuándo la IA no responde sola;
// con `warn`, que la IA sigue respondiendo.
//
// No pinta nada para `managed` (Cabbity paga a Meta), sin dato (`null`:
// la lectura falló o aún no llegó, R8) ni sin números agotados.
//
// La fecha sale del dato (`resetsAt`), nunca del reloj en render, y se
// formatea en UTC: es el día 1 del mes siguiente en UTC (S-C4).
// ============================================================

import { useFormatter, useTranslations } from 'next-intl';
import { AlertTriangle } from 'lucide-react';

import { useServiceCap, type ServiceCapStatus } from '@/hooks/use-service-cap';

export function ServiceCapAlert({
  status,
}: {
  status: ServiceCapStatus | null;
}) {
  const t = useTranslations('Inbox.serviceCap');
  const format = useFormatter();
  if (!status || status.metaBilling !== 'direct') return null;
  const spent = status.numbers.filter((n) => n.exhausted);
  if (spent.length === 0) return null;

  const names = spent
    .map((n) => n.label?.trim() || n.displayPhoneNumber || n.id)
    .join(', ');
  const date = format.dateTime(new Date(status.resetsAt), {
    dateStyle: 'long',
    timeZone: 'UTC',
  });

  return (
    <div
      role="status"
      data-service-cap-alert
      className="flex shrink-0 items-start justify-center gap-2 border-b border-amber-500/20 bg-amber-500/10 px-4 py-2"
    >
      <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-400" />
      <div className="text-xs text-amber-400">
        <p className="font-medium">{t('title')}</p>
        <p>
          {t('numbers', {
            numbers: names,
            freeTier: status.freeTier,
            count: spent.length,
          })}{' '}
          {status.action === 'pause_ai'
            ? t('paused', { count: spent.length, date })
            : t('warnOnly')}
        </p>
      </div>
    </div>
  );
}

/** Montado en la bandeja: lee la cuota compartida y pinta la franja. */
export function InboxServiceCapAlert() {
  const { status } = useServiceCap();
  return <ServiceCapAlert status={status} />;
}
