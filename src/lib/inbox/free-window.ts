import type { Conversation } from '@/types';

/**
 * Hasta cuándo dura la ventana gratis de punto de entrada de una
 * conversación (p11.6, migración 082). `null` = sin insignia.
 *
 * Solo se muestra si la cuenta paga Meta directamente (`direct`): en
 * `managed` Cabbity cobra todos los mensajes entregados, también los que
 * Meta no cobra (decisión 3 de la fase 10), así que la ventana no le
 * ahorra nada al cliente. Mientras `metaBilling` no se conozca, tampoco:
 * una insignia «gratis» falsa cuesta dinero; una que falta no.
 *
 * Puro: el reloj entra como argumento (`useMinuteClock`).
 */
export function freeWindowUntil(
  conversation: Pick<Conversation, 'free_window_until'>,
  nowMs: number,
  metaBilling: 'direct' | 'managed' | undefined
): Date | null {
  if (metaBilling !== 'direct') return null;
  const raw = conversation.free_window_until;
  if (!raw || typeof raw !== 'string') return null;
  const untilMs = Date.parse(raw);
  if (!Number.isFinite(untilMs)) return null;
  if (untilMs <= nowMs) return null;
  return new Date(untilMs);
}

/**
 * Formato de la hora de la insignia: «sáb 4, 12:00». Lleva la zona del
 * navegador explícita porque el repo no configura un `timeZone` global
 * de next-intl, y sin él `format.dateTime` avisa `ENVIRONMENT_FALLBACK`
 * en cada llamada. La insignia solo se pinta en el cliente (las
 * conversaciones se cargan en el navegador), así que es la hora local
 * del operador.
 */
export function freeWindowDateTimeOptions(): {
  weekday: 'short';
  day: 'numeric';
  hour: '2-digit';
  minute: '2-digit';
  timeZone: string;
} {
  return {
    weekday: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}
