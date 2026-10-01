// ============================================================
// Meta's rate card (fase 10, s10.2): what Meta charges per delivered
// message, by market of the recipient and pricing category, with an
// effective date (`meta_rates`, migration 076).
//
//   rateFor(countryCode, category, at)
//     country of the recipient (ISO-3166 alpha-2, from
//     `countryFromPhone()` in `src/lib/whatsapp/phone-country.ts`)
//     → market (`meta_market_countries`; a country without a row is
//     `rest_of_world`) → the row of that market and category with the
//     latest `effective_from` that is not after the UTC day of `at`.
//
// It NEVER resolves to 0 and never borrows another market's price: a
// country of a known market whose category has no rate, or an unknown
// country when `rest_of_world` has none either, throws
// `MetaRateMissingError`, which says which market and category are
// missing so the operator can load them from /platform/rates. A
// statement priced with a silent 0 would bill the customer nothing and
// leave Cabbity paying Meta.
//
// Pure: `buildRateCard()` works on rows (synthetic in the tests, the
// whole table in production — a few hundred rows at most). The module
// imports only the TYPE of the Supabase client, so client components can
// use the constants without pulling the service role into the bundle.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { countryFromPhone } from '@/lib/whatsapp/phone-country';

/** Values of `meta_rates.category` (076) — Meta's pricing categories. */
export const META_CATEGORIES = [
  'service',
  'utility',
  'marketing',
  'authentication',
  'authentication_international',
] as const;

export type MetaCategory = (typeof META_CATEGORIES)[number];

/** Market of every country that has no row in `meta_market_countries`. */
export const REST_OF_WORLD = 'rest_of_world';

/** `meta_rates.market` / `meta_market_countries.market` (076 CHECK). */
export const MARKET_RE = /^[a-z][a-z0-9_]{1,39}$/;

export function isMetaCategory(value: unknown): value is MetaCategory {
  return (
    typeof value === 'string' &&
    (META_CATEGORIES as readonly string[]).includes(value)
  );
}

/** A row of `meta_rates` as PostgREST returns it (numeric → string). */
export interface MetaRateRow {
  market: string;
  category: string;
  usd_per_message: number | string;
  effective_from: string;
}

/** A row of `meta_market_countries`. */
export interface MarketCountryRow {
  country_code: string;
  market: string;
}

export interface ResolvedRate {
  market: string;
  category: MetaCategory;
  usdPerMessage: number;
  effectiveFrom: string;
}

export class MetaRateMissingError extends Error {
  readonly market: string;
  readonly category: string;
  readonly countryCode: string | null;
  readonly day: string;

  constructor(args: {
    market: string;
    category: string;
    countryCode: string | null;
    day: string;
  }) {
    super(
      `No Meta rate for market '${args.market}', category '${args.category}' on ${args.day}` +
        (args.countryCode ? ` (recipient country ${args.countryCode})` : '') +
        ' — load it from /platform/rates'
    );
    this.name = 'MetaRateMissingError';
    this.market = args.market;
    this.category = args.category;
    this.countryCode = args.countryCode;
    this.day = args.day;
  }
}

/** UTC calendar day (`YYYY-MM-DD`) of an instant or of a date string. */
export function utcDay(at: Date | string): string {
  if (typeof at === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(at)) return at;
  const date = at instanceof Date ? at : new Date(at);
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`Invalid date for a Meta rate: ${String(at)}`);
  }
  return date.toISOString().slice(0, 10);
}

export interface RateCard {
  /** Market the country is billed in (`rest_of_world` when unmapped). */
  marketFor(countryCode: string | null | undefined): string;
  /** The rate in force; throws `MetaRateMissingError`, never returns 0. */
  rateFor(
    countryCode: string | null | undefined,
    category: MetaCategory,
    at: Date | string
  ): ResolvedRate;
}

interface CardEntry {
  effectiveFrom: string;
  usdPerMessage: number;
}

export function buildRateCard(
  rates: readonly MetaRateRow[],
  countries: readonly MarketCountryRow[]
): RateCard {
  const marketOf = new Map<string, string>();
  for (const row of countries) {
    marketOf.set(row.country_code.toUpperCase(), row.market);
  }

  // market|category → entries, newest first.
  const entries = new Map<string, CardEntry[]>();
  for (const row of rates) {
    const usd = Number(row.usd_per_message);
    // The 076 CHECK forbids it; a broken row is skipped rather than
    // allowed to price a message at 0 or at NaN.
    if (!Number.isFinite(usd) || usd <= 0) continue;
    const key = `${row.market}|${row.category}`;
    const list = entries.get(key) ?? [];
    list.push({
      effectiveFrom: String(row.effective_from).slice(0, 10),
      usdPerMessage: usd,
    });
    entries.set(key, list);
  }
  for (const list of entries.values()) {
    list.sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? 1 : -1));
  }

  function marketFor(countryCode: string | null | undefined): string {
    if (!countryCode) return REST_OF_WORLD;
    return marketOf.get(countryCode.toUpperCase()) ?? REST_OF_WORLD;
  }

  function rateFor(
    countryCode: string | null | undefined,
    category: MetaCategory,
    at: Date | string
  ): ResolvedRate {
    const day = utcDay(at);
    const market = marketFor(countryCode);
    const entry = entries
      .get(`${market}|${category}`)
      ?.find((e) => e.effectiveFrom <= day);
    if (!entry) {
      throw new MetaRateMissingError({
        market,
        category,
        countryCode: countryCode ? countryCode.toUpperCase() : null,
        day,
      });
    }
    return {
      market,
      category,
      usdPerMessage: entry.usdPerMessage,
      effectiveFrom: entry.effectiveFrom,
    };
  }

  return { marketFor, rateFor };
}

/** `rateFor` with the recipient's phone number instead of its country. */
export function rateForPhone(
  card: RateCard,
  phone: string | null | undefined,
  category: MetaCategory,
  at: Date | string
): ResolvedRate {
  return card.rateFor(countryFromPhone(phone), category, at);
}

/**
 * The whole rate card from the database. Both tables are global (no
 * `account_id`): any client may read them — the 076 policies let every
 * authenticated user SELECT — and the service role is what the crons use.
 */
export async function loadRateCard(client: SupabaseClient): Promise<RateCard> {
  const [rates, countries] = await Promise.all([
    client
      .from('meta_rates')
      .select('market, category, usd_per_message, effective_from'),
    client.from('meta_market_countries').select('country_code, market'),
  ]);
  if (rates.error) throw rates.error;
  if (countries.error) throw countries.error;
  return buildRateCard(
    (rates.data ?? []) as MetaRateRow[],
    (countries.data ?? []) as MarketCountryRow[]
  );
}
