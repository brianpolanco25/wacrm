// ============================================================
// Fechas locales con día de la semana (n13.7, n13.9).
//
// Puro. Zonas IANA, hora de pared de un instante en una zona y el día de
// la semana en inglés ya calculado, para que el modelo nunca lo deduzca
// de cabeza (n13.9: ofrecía «jueves 13 de noviembre» cuando era viernes).
// Lo comparten la sección de herramientas del prompt, el bloque «Live
// data» y los resultados de herramienta.
//
// n13.11: también los días relativos (hoy, mañana, «in 5 days»), siempre
// sobre fechas de calendario locales, nunca sobre epoch/24 h.
// ============================================================

import { AI_TIMEZONE_MAX } from './types';

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

/** Fecha-hora ISO 8601 con offset explícito (`Z` o `±HH:MM`). */
export const ISO_WITH_OFFSET_RE =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::\d{2})?(?:\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

const pad = (n: number, width = 2) => String(Math.abs(n)).padStart(width, '0');

/** Zona IANA que `Intl` reconoce. */
export function isValidTimeZone(tz: string): boolean {
  if (typeof tz !== 'string' || tz.length < 1 || tz.length > AI_TIMEZONE_MAX) {
    return false;
  }
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** n13.7: `+HH:MM` / `-HH:MM` de un offset en minutos. */
export function offsetLabel(offsetMinutes: number): string {
  const sign = offsetMinutes < 0 ? '-' : '+';
  return `${sign}${pad(Math.floor(Math.abs(offsetMinutes) / 60))}:${pad(Math.abs(offsetMinutes) % 60)}`;
}

/** Día de la semana en inglés de una fecha de calendario (mes 1–12). */
export function weekdayOf(year: number, month: number, day: number): string {
  return WEEKDAYS[new Date(Date.UTC(year, month - 1, day)).getUTCDay()];
}

/**
 * La fecha y hora de pared de `now` en `timeZone` y su offset en minutos;
 * `null` si la zona no vale. La comparten `formatNowInZone` y el render
 * de datos en vivo (n13.7).
 */
export function wallClockInZone(
  now: Date,
  timeZone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  offsetMinutes: number;
} | null {
  if (!isValidTimeZone(timeZone) || Number.isNaN(now.getTime())) return null;
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(now);
  const get = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? NaN);
  const year = get('year');
  const month = get('month');
  const day = get('day');
  const hour = get('hour');
  const minute = get('minute');
  const second = get('second');
  const wallAsUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const nowSeconds = Math.floor(now.getTime() / 1000) * 1000;
  const offsetMinutes = Math.round((wallAsUtc - nowSeconds) / 60_000);
  return { year, month, day, hour, minute, second, offsetMinutes };
}

/** `2026-11-05T10:31:00-04:00`; `null` si la zona no vale. */
export function formatNowInZone(now: Date, timeZone: string): string | null {
  const w = wallClockInZone(now, timeZone);
  if (!w) return null;
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}T${pad(w.hour)}:${pad(w.minute)}:${pad(w.second)}${offsetLabel(w.offsetMinutes)}`;
}

/** n13.9: el día de la semana de `now` en `timeZone`; `null` si no vale. */
export function weekdayInZone(now: Date, timeZone: string): string | null {
  const w = wallClockInZone(now, timeZone);
  return w ? weekdayOf(w.year, w.month, w.day) : null;
}

/** n13.11: fecha de calendario (mes 1–12). */
export interface CalendarDate {
  year: number;
  month: number;
  day: number;
}

/** n13.11: `YYYY-MM-DD`. */
export function formatDate(d: CalendarDate): string {
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)}`;
}

/** n13.11: la fecha `n` días de calendario después (o antes, si `n < 0`). */
export function addDays(d: CalendarDate, n: number): CalendarDate {
  const t = new Date(Date.UTC(d.year, d.month - 1, d.day + n));
  return {
    year: t.getUTCFullYear(),
    month: t.getUTCMonth() + 1,
    day: t.getUTCDate(),
  };
}

/** n13.11: días de calendario de `from` a `to` (negativo si `to` es antes). */
export function daysBetween(from: CalendarDate, to: CalendarDate): number {
  return Math.round(
    (Date.UTC(to.year, to.month - 1, to.day) -
      Date.UTC(from.year, from.month - 1, from.day)) /
      86_400_000
  );
}

/** n13.11: la fecha de hoy en `timeZone`; `null` si la zona no vale. */
export function todayInZone(now: Date, timeZone: string): CalendarDate | null {
  const w = wallClockInZone(now, timeZone);
  return w ? { year: w.year, month: w.month, day: w.day } : null;
}

/**
 * n13.11: `today`, `tomorrow`, `in N days` (hasta 30); `null` si la fecha
 * es pasada o más lejana.
 */
export function relativeDayLabel(days: number): string | null {
  if (!Number.isInteger(days) || days < 0 || days > RELATIVE_DAYS_MAX) {
    return null;
  }
  if (days === 0) return 'today';
  if (days === 1) return 'tomorrow';
  return `in ${days} days`;
}

export const RELATIVE_DAYS_MAX = 30;

export function isIsoWithOffset(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    ISO_WITH_OFFSET_RE.test(value) &&
    !Number.isNaN(Date.parse(value))
  );
}

export interface LocalTime {
  date: string; // YYYY-MM-DD
  weekday: string;
  time: string; // HH:MM
  offset: string; // +HH:MM
  epoch: number;
}

/** Día y hora local del instante en la zona (o en el offset del propio valor). */
export function localTime(
  value: string,
  timeZone: string | null
): LocalTime | null {
  const epoch = Date.parse(value);
  if (Number.isNaN(epoch)) return null;
  if (timeZone && isValidTimeZone(timeZone)) {
    const w = wallClockInZone(new Date(epoch), timeZone);
    if (!w) return null;
    return {
      date: `${w.year}-${pad(w.month)}-${pad(w.day)}`,
      weekday: weekdayOf(w.year, w.month, w.day),
      time: `${pad(w.hour)}:${pad(w.minute)}`,
      offset: offsetLabel(w.offsetMinutes),
      epoch,
    };
  }
  const m = ISO_WITH_OFFSET_RE.exec(value);
  if (!m) return null;
  const [, y, mo, d, h, mi, off] = m;
  return {
    date: `${y}-${mo}-${d}`,
    weekday: weekdayOf(+y, +mo, +d),
    time: `${h}:${mi}`,
    offset: off === 'Z' ? '+00:00' : off,
    epoch,
  };
}

/**
 * n13.9: `Friday 2026-11-13 14:00 (-04:00)`; `null` si no es ISO con offset.
 * n13.11: con `now`, el día relativo tras la fecha cuando cae entre hoy y
 * hoy+30 (`Friday 2026-11-13 (tomorrow) 14:00 (-04:00)`). «Hoy» es el de
 * `timeZone` o, si no vale, el del offset del propio valor.
 */
export function localLabel(
  value: string,
  timeZone: string | null,
  now?: Date
): string | null {
  if (!isIsoWithOffset(value)) return null;
  const t = localTime(value, timeZone);
  if (!t) return null;
  const relative = now ? relativeOf(t, timeZone, now) : null;
  const day = relative ? `${t.date} (${relative})` : t.date;
  return `${t.weekday} ${day} ${t.time} (${t.offset})`;
}

function relativeOf(
  t: LocalTime,
  timeZone: string | null,
  now: Date
): string | null {
  if (Number.isNaN(now.getTime())) return null;
  let today: CalendarDate | null = null;
  if (timeZone && isValidTimeZone(timeZone)) {
    today = todayInZone(now, timeZone);
  } else {
    const m = /^([+-])(\d{2}):(\d{2})$/.exec(t.offset);
    if (!m) return null;
    const minutes = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
    const shifted = new Date(now.getTime() + minutes * 60_000);
    today = {
      year: shifted.getUTCFullYear(),
      month: shifted.getUTCMonth() + 1,
      day: shifted.getUTCDate(),
    };
  }
  if (!today) return null;
  const [y, mo, d] = t.date.split('-').map(Number);
  return relativeDayLabel(daysBetween(today, { year: y, month: mo, day: d }));
}
