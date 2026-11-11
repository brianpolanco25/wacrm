// ============================================================
// Guardia del texto final (n13.7, R35, R37).
//
// Puro. `mentionsSchedule` detecta afirmaciones de agenda en español o
// inglés: una hora, un día de la semana, una fecha numérica o día + mes.
// «hoy», «mañana», «today» o «tomorrow» solos no cuentan. Normaliza con
// NFD y sin diacríticos (`miércoles` = `miercoles`), sin mayúsculas.
// ============================================================

const MONTHS = [
  // es
  'enero',
  'febrero',
  'marzo',
  'abril',
  'mayo',
  'junio',
  'julio',
  'agosto',
  'septiembre',
  'setiembre',
  'octubre',
  'noviembre',
  'diciembre',
  'ene',
  'abr',
  'ago',
  'dic',
  // en
  'january',
  'february',
  'march',
  'april',
  'may',
  'june',
  'july',
  'august',
  'september',
  'october',
  'november',
  'december',
  'jan',
  'feb',
  'mar',
  'apr',
  'jun',
  'jul',
  'aug',
  'sep',
  'sept',
  'oct',
  'nov',
  'dec',
].join('|');

const PATTERNS: RegExp[] = [
  // 10:30, 10.30, 10h30 (no un precio ni parte de un número más largo)
  /(?<![\d$.,:])(?:[01]?\d|2[0-3])[:.h][0-5]\d(?![\d]|[.,:]\d)/,
  // 3 pm, 3pm, 3 p. m., 10 a.m.
  /\b(?:1[0-2]|0?[1-9])\s*[ap]\.?\s*m\b/,
  // días de la semana
  /\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
  // 12/11, 12/11/2026
  /(?<![\d/])\d{1,2}\/\d{1,2}(?:\/\d{2,4})?(?![\d/])/,
  // 2026-11-12
  /\b\d{4}-\d{2}-\d{2}\b/,
  // 12 de noviembre, 12 nov, 12 November
  new RegExp(`\\b\\d{1,2}\\s+(?:de\\s+)?(?:${MONTHS})\\b`),
  // November 12, nov. 12
  new RegExp(`\\b(?:${MONTHS})\\.?\\s+\\d{1,2}(?!\\d)`),
];

function normalize(text: string): string {
  return text
    .normalize('NFD')
    .replace(/\p{Diacritic}/gu, '')
    .toLowerCase();
}

/** R35: ¿el texto afirma un día, una fecha o una hora? */
export function mentionsSchedule(text: string): boolean {
  if (typeof text !== 'string' || text.trim() === '') return false;
  const plain = normalize(text);
  return PATTERNS.some((re) => re.test(plain));
}

/** R37: nota que se añade al system prompt en la vuelta correctiva. */
export const GROUNDING_RETRY_NOTE =
  'Grounding check: your previous draft mentioned days, dates or times without any tool data in this reply to support them. Do not send it. Call the availability tool now to get real data, or answer without mentioning any day, date or time.';
