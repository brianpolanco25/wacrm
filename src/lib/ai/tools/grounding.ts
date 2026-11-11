// ============================================================
// Guardia del texto final (n13.7, R35, R37).
//
// Puro. `mentionsSchedule` detecta afirmaciones de agenda en español o
// inglés: una hora (también «a las 4», «3 de la tarde»), un día de la
// semana, una fecha numérica o día + mes. «Santo Domingo» no es un día y
// un `N.NN` tras un símbolo o código de moneda es un precio.
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

// Símbolo o código de moneda delante (con o sin espacio): `RD$ 15.00`,
// `US$ 2.50`, `$ 3.50`, `USD 15.00` son precios, no horas.
const NOT_AFTER_CURRENCY =
  '(?<!(?:[$€£]|\\b(?:rd|us|usd|dop|eur|gbp|mxn|cop|pen|clp|ars))\\s*)';

// Lo que puede seguir a «a las 4» para que sea una hora: fin, puntuación,
// un complemento horario o una palabra de unión frecuente. Un sustantivo
// («a las 3 personas») no cuenta.
const AFTER_SPANISH_HOUR = [
  '$',
  '[^\\p{L}\\d\\s]',
  'de\\s+la\\s+(?:manana|tarde|noche|madrugada)\\b',
  'del\\s+mediodia\\b',
  'en\\s+punto\\b',
  'y\\s+(?:media|cuarto|\\d)',
  'menos\\b',
  '(?:horas?|hrs?|h)\\b',
  '(?:o|u|y|a|en|para|el|este|esta|hoy|manana|pasado|le|la|lo|te|nos|les|me|se|si|sin|con|por|que|ok|vale)\\b',
].join('|');

const PATTERNS: RegExp[] = [
  // 10:30, 10.30, 10h30 (no un precio ni parte de un número más largo)
  new RegExp(
    `${NOT_AFTER_CURRENCY}(?<![\\d$.,:])(?:[01]?\\d|2[0-3])[:.h][0-5]\\d(?![\\d]|[.,:]\\d)`,
    'u'
  ),
  // 3 pm, 3pm, 3 p. m., 10 a.m.
  /\b(?:1[0-2]|0?[1-9])\s*[ap]\.?\s*m\b/,
  // «a las 4», «a la 1», «a las 10 de la mañana» (n13.7, ronda 2)
  new RegExp(
    `\\ba\\s+las?\\s+(?:[01]?\\d|2[0-3])(?![\\d]|[.,:/]\\d)\\s*(?=${AFTER_SPANISH_HOUR})`,
    'u'
  ),
  // «3 de la tarde», «12 del mediodía»
  /\b(?:[01]?\d|2[0-3])\s+(?:de\s+la\s+(?:manana|tarde|noche|madrugada)|del\s+mediodia)\b/,
  // días de la semana; «Santo Domingo (Este/Norte/Oeste)» no es un día
  /(?<!\b(?:sant[oa]|sto\.?)\s+)\b(?:lunes|martes|miercoles|jueves|viernes|sabado|domingo|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
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
