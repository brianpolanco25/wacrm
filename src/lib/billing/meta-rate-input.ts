// ============================================================
// What the operator may write to Meta's rate card from /platform/rates
// (fase 10, s10.2): one new rate, a CSV import, and the country → market
// table. Pure — the routes call these before touching the database, and
// the import's preview is exactly this classification.
//
// A rate in force is NEVER edited. A price change is a new row with a
// later `effective_from`; `meta_rates` has no UPDATE path in the code at
// all. Two cases are refused because they would amount to an edit:
//
//   exists/conflict  the same (market, category, effective_from) already
//                    exists. Same price → `exists` (an import that is
//                    pasted twice is a no-op); another price → `conflict`.
//   retroactive      a date before today (UTC) for a market and category
//                    that already had a rate on that day: it would
//                    re-price messages already delivered. A past date
//                    with no earlier rate (filling a market the seed did
//                    not have) is allowed.
// ============================================================

import { MARKET_RE, META_CATEGORIES, type MetaCategory } from './meta-rates';

export interface RateWrite {
  market: string;
  category: MetaCategory;
  usd_per_message: number;
  effective_from: string;
}

export type RateValidation =
  { ok: true; value: RateWrite } | { ok: false; error: string };

/** `numeric(8,5)`. */
export const RATE_MAX = 999.99999;
export const IMPORT_MAX_ROWS = 2000;
export const MARKET_ENTRIES_MAX = 300;

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const COUNTRY_RE = /^[A-Z]{2}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

export function isValidDay(value: unknown): value is string {
  if (typeof value !== 'string' || !DAY_RE.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function toRate(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') n = value;
  else if (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))
    n = Number(value.trim());
  else return null;
  if (!Number.isFinite(n) || n <= 0 || n > RATE_MAX) return null;
  const scaled = n * 1e5;
  if (Math.abs(Math.round(scaled) - scaled) > 1e-6) return null;
  return n;
}

const FIELDS = ['market', 'category', 'usd_per_message', 'effective_from'];

/** One rate, from the «nueva tarifa» form or a CSV row. */
export function validateRateInput(body: unknown): RateValidation {
  if (!isPlainObject(body)) {
    return { ok: false, error: 'body must be a JSON object' };
  }
  for (const key of Object.keys(body)) {
    if (!FIELDS.includes(key)) {
      return { ok: false, error: `unknown field '${key}'` };
    }
  }
  const market =
    typeof body.market === 'string' ? body.market.trim().toLowerCase() : '';
  if (!MARKET_RE.test(market)) {
    return {
      ok: false,
      error: "'market' must be a slug: a-z, 0-9 and _ (e.g. rest_of_latam)",
    };
  }
  const category =
    typeof body.category === 'string' ? body.category.trim().toLowerCase() : '';
  if (!(META_CATEGORIES as readonly string[]).includes(category)) {
    return {
      ok: false,
      error: `'category' must be one of ${META_CATEGORIES.join(', ')}`,
    };
  }
  const usd = toRate(body.usd_per_message);
  if (usd === null) {
    return {
      ok: false,
      error: "'usd_per_message' must be > 0 with at most 5 decimals",
    };
  }
  const day =
    typeof body.effective_from === 'string' ? body.effective_from.trim() : '';
  if (!isValidDay(day)) {
    return { ok: false, error: "'effective_from' must be a date YYYY-MM-DD" };
  }
  return {
    ok: true,
    value: {
      market,
      category: category as MetaCategory,
      usd_per_message: usd,
      effective_from: day,
    },
  };
}

export interface ExistingRate {
  market: string;
  category: string;
  usd_per_message: number | string;
  effective_from: string;
}

export type RateStatus = 'new' | 'exists' | 'conflict' | 'retroactive';

/** Where a new rate stands against the rows already in `meta_rates`. */
export function classifyRate(
  rate: RateWrite,
  existing: readonly ExistingRate[],
  today: string
): RateStatus {
  const same = existing.filter(
    (r) => r.market === rate.market && r.category === rate.category
  );
  const twin = same.find(
    (r) => String(r.effective_from).slice(0, 10) === rate.effective_from
  );
  if (twin) {
    return Math.abs(Number(twin.usd_per_message) - rate.usd_per_message) < 1e-9
      ? 'exists'
      : 'conflict';
  }
  if (
    rate.effective_from < today &&
    same.some(
      (r) => String(r.effective_from).slice(0, 10) < rate.effective_from
    )
  ) {
    return 'retroactive';
  }
  return 'new';
}

export interface ImportRow {
  /** 1-based line of the pasted text. */
  line: number;
  status: RateStatus | 'invalid' | 'duplicate';
  value: RateWrite | null;
  error: string | null;
}

export interface ImportPreview {
  rows: ImportRow[];
  /** Rows that would be inserted. */
  toInsert: RateWrite[];
  /** True when nothing blocks the import (only `new` and `exists`). */
  importable: boolean;
}

function splitCsvLine(line: string): string[] {
  // `;` is what a spreadsheet in a Spanish locale exports, with a
  // decimal comma (`0,0113`); otherwise plain `,`.
  if (line.includes(';')) {
    return line.split(';').map((cell, i) => {
      const v = cell.trim().replace(/^"(.*)"$/, '$1');
      return i === 2 ? v.replace(',', '.') : v;
    });
  }
  return line.split(',').map((cell) => cell.trim().replace(/^"(.*)"$/, '$1'));
}

/**
 * Parse and classify a pasted CSV: `market,category,usd_per_message,
 * effective_from`, one rate per line, header optional. Nothing is
 * written here: the route inserts `toInsert` only when `importable`.
 */
export function previewRateImport(
  text: string,
  existing: readonly ExistingRate[],
  today: string
): { ok: true; value: ImportPreview } | { ok: false; error: string } {
  const lines = text.split(/\r?\n/);
  const rows: ImportRow[] = [];
  const seen = new Set<string>();
  let first = true;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i].trim();
    if (!raw || raw.startsWith('#')) continue;
    const cells = splitCsvLine(raw);
    if (first) {
      first = false;
      if (cells[0]?.toLowerCase() === 'market') continue;
    }
    if (rows.length >= IMPORT_MAX_ROWS) {
      return {
        ok: false,
        error: `at most ${IMPORT_MAX_ROWS} rates per import`,
      };
    }
    if (cells.length !== 4) {
      rows.push({
        line: i + 1,
        status: 'invalid',
        value: null,
        error:
          'expected 4 columns: market,category,usd_per_message,effective_from',
      });
      continue;
    }
    const parsed = validateRateInput({
      market: cells[0],
      category: cells[1],
      usd_per_message: cells[2],
      effective_from: cells[3],
    });
    if (!parsed.ok) {
      rows.push({
        line: i + 1,
        status: 'invalid',
        value: null,
        error: parsed.error,
      });
      continue;
    }
    const key = `${parsed.value.market}|${parsed.value.category}|${parsed.value.effective_from}`;
    if (seen.has(key)) {
      rows.push({
        line: i + 1,
        status: 'duplicate',
        value: parsed.value,
        error: 'the same market, category and date appear twice',
      });
      continue;
    }
    seen.add(key);
    rows.push({
      line: i + 1,
      status: classifyRate(parsed.value, existing, today),
      value: parsed.value,
      error: null,
    });
  }
  if (rows.length === 0) {
    return { ok: false, error: 'the CSV has no rates' };
  }
  const toInsert = rows
    .filter((r) => r.status === 'new')
    .map((r) => r.value as RateWrite);
  return {
    ok: true,
    value: {
      rows,
      toInsert,
      importable: rows.every(
        (r) => r.status === 'new' || r.status === 'exists'
      ),
    },
  };
}

export interface MarketEntry {
  country_code: string;
  /** `null` removes the country: it falls back to `rest_of_world`. */
  market: string | null;
}

/** Body of `PUT /api/platform/rates/markets`: `{ entries: [...] }`. */
export function validateMarketEntries(
  body: unknown
): { ok: true; value: MarketEntry[] } | { ok: false; error: string } {
  if (!isPlainObject(body) || !Array.isArray(body.entries)) {
    return { ok: false, error: 'body must be { entries: [...] }' };
  }
  if (body.entries.length === 0 || body.entries.length > MARKET_ENTRIES_MAX) {
    return {
      ok: false,
      error: `between 1 and ${MARKET_ENTRIES_MAX} entries`,
    };
  }
  const out: MarketEntry[] = [];
  const seen = new Set<string>();
  for (const entry of body.entries) {
    if (!isPlainObject(entry)) {
      return { ok: false, error: 'every entry must be an object' };
    }
    const country =
      typeof entry.country_code === 'string'
        ? entry.country_code.trim().toUpperCase()
        : '';
    if (!COUNTRY_RE.test(country)) {
      return {
        ok: false,
        error: "'country_code' must be two letters (ISO-3166 alpha-2)",
      };
    }
    if (seen.has(country)) {
      return { ok: false, error: `country '${country}' appears twice` };
    }
    seen.add(country);
    let market: string | null = null;
    if (entry.market !== null) {
      market =
        typeof entry.market === 'string'
          ? entry.market.trim().toLowerCase()
          : '';
      if (!MARKET_RE.test(market)) {
        return {
          ok: false,
          error: `market of '${country}' must be a slug or null`,
        };
      }
    }
    out.push({ country_code: country, market });
  }
  return { ok: true, value: out };
}
