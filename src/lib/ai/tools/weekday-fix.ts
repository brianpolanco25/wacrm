// ============================================================
// Red de seguridad del día de la semana en el texto final (n13.11).
//
// Puro y determinista. Aunque el prompt y los resultados ya traen el día
// de la semana calculado (n13.9) y hoy/mañana/pasado (n13.11), el modelo
// aún escribía «Mañana jueves 13 de noviembre» siendo viernes. Aquí se
// corrige SOLO la palabra del día de la semana cuando contradice al
// calendario:
//
//   (a) junto a una fecha explícita: «jueves 13 de noviembre [de 2026]»,
//       «Thursday, November 13», «Thursday the 13th of November»;
//   (b) junto a un día relativo: «mañana jueves», «hoy, viernes»,
//       «tomorrow Thursday».
//
// Se detecta sin mayúsculas ni acentos, pero se sustituye en el texto
// original solo el weekday, en su idioma y con su mayúscula. Nunca se toca
// nada más (ni «mañana», ni el número, ni precios u horas).
// ============================================================

import { addDays, daysBetween, type CalendarDate } from './local-time';

const ES_WEEKDAYS = [
  'domingo',
  'lunes',
  'martes',
  'miércoles',
  'jueves',
  'viernes',
  'sábado',
] as const;
const EN_WEEKDAYS = [
  'sunday',
  'monday',
  'tuesday',
  'wednesday',
  'thursday',
  'friday',
  'saturday',
] as const;

const ES_MONTHS: Record<string, number> = {
  enero: 1,
  febrero: 2,
  marzo: 3,
  abril: 4,
  mayo: 5,
  junio: 6,
  julio: 7,
  agosto: 8,
  septiembre: 9,
  setiembre: 9,
  octubre: 10,
  noviembre: 11,
  diciembre: 12,
};
const EN_MONTHS: Record<string, number> = {
  january: 1,
  february: 2,
  march: 3,
  april: 4,
  may: 5,
  june: 6,
  july: 7,
  august: 8,
  september: 9,
  october: 10,
  november: 11,
  december: 12,
};

/** Sin una fecha explícita de año, una fecha más de 60 días atrás es del año siguiente. */
const PAST_YEAR_WINDOW_DAYS = 60;

const strip = (s: string) =>
  s.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

const ES_WD = ES_WEEKDAYS.map(strip);
const EN_WD = [...EN_WEEKDAYS];

const B = '(?<![a-z0-9])';
const E = '(?![a-z0-9])';
const WD_ES = `(${ES_WD.join('|')})`;
const WD_EN = `(${EN_WD.join('|')})`;
const WD_ANY = `(${[...ES_WD, ...EN_WD].join('|')})`;
const MON_ES = `(${Object.keys(ES_MONTHS).join('|')})`;
const MON_EN = `(${Object.keys(EN_MONTHS).join('|')})`;
const ORD = '(?:st|nd|rd|th)?';

// Grupos: 1 weekday, día, mes, año (orden según patrón).
const ES_DATE_RE = new RegExp(
  `${B}${WD_ES},?\\s+(?:el\\s+)?(\\d{1,2})\\s+de\\s+${MON_ES}${E}(?:\\s+(?:de|del)\\s+(\\d{4})(?!\\d))?`,
  'g'
);
const EN_DAY_MONTH_RE = new RegExp(
  `${B}${WD_EN},?\\s+(?:the\\s+)?(\\d{1,2})${ORD}\\s+(?:of\\s+)?${MON_EN}${E}(?:,?\\s+(\\d{4})(?!\\d))?`,
  'g'
);
const EN_MONTH_DAY_RE = new RegExp(
  `${B}${WD_EN},?\\s+${MON_EN}\\s+(?:the\\s+)?(\\d{1,2})(?!\\d)${ORD}${E}(?:,?\\s+(\\d{4})(?!\\d))?`,
  'g'
);
// «la mañana» / «esta mañana» es «la mañana del día», no «mañana».
const RELATIVE_RE = new RegExp(
  `${B}(?<!${B}(?:la|esta)\\s+)(pasado\\s+manana|manana|hoy|today|tomorrow)[,:]?\\s+(?:el\\s+)?${WD_ANY}${E}`,
  'g'
);

const RELATIVE_OFFSET: Record<string, number> = {
  hoy: 0,
  today: 0,
  manana: 1,
  tomorrow: 1,
  'pasado manana': 2,
};

interface Normalized {
  text: string;
  /** Índice en el original de cada carácter del texto normalizado. */
  origin: number[];
}

/** Minúsculas y sin acentos, recordando el índice original de cada carácter. */
function normalize(text: string): Normalized {
  let out = '';
  const origin: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const n = strip(text[i]);
    for (const ch of n) {
      out += ch;
      origin.push(i);
    }
  }
  return { text: out, origin };
}

function validDate(year: number, month: number, day: number): boolean {
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  const t = new Date(Date.UTC(year, month - 1, day));
  return t.getUTCMonth() === month - 1 && t.getUTCDate() === day;
}

function resolveYear(
  month: number,
  day: number,
  explicit: string | undefined,
  today: CalendarDate
): CalendarDate | null {
  if (explicit) {
    const year = Number(explicit);
    return validDate(year, month, day) ? { year, month, day } : null;
  }
  // Fecha inválida en el año de hoy (31 de noviembre) → no se toca. El 29
  // de febrero puede valer solo en el año siguiente.
  let date: CalendarDate = { year: today.year, month, day };
  if (
    !validDate(date.year, month, day) ||
    daysBetween(date, today) > PAST_YEAR_WINDOW_DAYS
  ) {
    date = { year: today.year + 1, month, day };
  }
  return validDate(date.year, month, day) ? date : null;
}

function weekdayIndex(d: CalendarDate): number {
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** El weekday correcto con la forma del original (Mayúscula / MAYÚSCULAS). */
function shaped(original: string, correct: string): string {
  const letters = original.replace(/[^\p{L}]/gu, '');
  if (letters.length > 1 && letters === letters.toUpperCase()) {
    return correct.toUpperCase();
  }
  if (original[0] && original[0] !== original[0].toLowerCase()) {
    return correct[0].toUpperCase() + correct.slice(1);
  }
  return correct;
}

interface Replacement {
  start: number;
  end: number;
  correctIndex: number;
  spanish: boolean;
}

/**
 * Corrige el nombre del día de la semana que contradice al calendario.
 * `today` es la fecha local de hoy (mes 1–12). `fixes` = palabras cambiadas.
 */
export function fixWeekdays(
  text: string,
  today: CalendarDate
): { text: string; fixes: number } {
  if (!text) return { text, fixes: 0 };
  const norm = normalize(text);
  const byStart = new Map<number, Replacement>();

  const toOriginal = (normStart: number, word: string) => {
    const start = norm.origin[normStart];
    const normEnd = normStart + word.length;
    const end =
      normEnd < norm.origin.length ? norm.origin[normEnd] : text.length;
    return { start, end };
  };

  const consider = (
    normStart: number,
    word: string,
    correctIndex: number,
    spanish: boolean
  ) => {
    const { start, end } = toOriginal(normStart, word);
    if (byStart.has(start)) return;
    byStart.set(start, { start, end, correctIndex, spanish });
  };

  // (a) Fechas explícitas: ganan sobre (b) si ambas cubren el mismo weekday.
  const datePatterns: {
    re: RegExp;
    spanish: boolean;
    pick: (m: RegExpExecArray) => {
      day: string;
      month: number;
      year?: string;
    };
  }[] = [
    {
      re: ES_DATE_RE,
      spanish: true,
      pick: (m) => ({ day: m[2], month: ES_MONTHS[m[3]], year: m[4] }),
    },
    {
      re: EN_DAY_MONTH_RE,
      spanish: false,
      pick: (m) => ({ day: m[2], month: EN_MONTHS[m[3]], year: m[4] }),
    },
    {
      re: EN_MONTH_DAY_RE,
      spanish: false,
      pick: (m) => ({ day: m[3], month: EN_MONTHS[m[2]], year: m[4] }),
    },
  ];
  for (const { re, spanish, pick } of datePatterns) {
    re.lastIndex = 0;
    for (const m of norm.text.matchAll(re)) {
      const { day, month, year } = pick(m);
      const date = resolveYear(month, Number(day), year, today);
      if (!date) continue;
      consider(m.index, m[1], weekdayIndex(date), spanish);
    }
  }

  // (b) Días relativos: hoy/mañana/pasado mañana + weekday.
  for (const m of norm.text.matchAll(RELATIVE_RE)) {
    const relative = m[1].replace(/\s+/g, ' ');
    const offset = RELATIVE_OFFSET[relative];
    if (offset === undefined) continue;
    const word = m[2];
    const wordStart = m.index + m[0].length - word.length;
    consider(
      wordStart,
      word,
      weekdayIndex(addDays(today, offset)),
      ES_WD.includes(word)
    );
  }

  let fixes = 0;
  let out = text;
  const ordered = [...byStart.values()].sort((a, b) => b.start - a.start);
  for (const r of ordered) {
    const original = text.slice(r.start, r.end);
    const correct = (r.spanish ? ES_WEEKDAYS : EN_WEEKDAYS)[r.correctIndex];
    if (strip(original) === strip(correct)) continue;
    out = out.slice(0, r.start) + shaped(original, correct) + out.slice(r.end);
    fixes += 1;
  }
  return { text: fixes > 0 ? out : text, fixes };
}
