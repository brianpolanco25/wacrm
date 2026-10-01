// ============================================================
// Meta's rate card from the platform panel (fase 10, s10.2).
//
// `meta_rates` and `meta_market_countries` (076) have no client write
// policy: every authenticated user reads them, and only the service role
// writes — here, behind `requirePlatformAdmin()` in /api/platform/rates.
//
// Isolation: both tables are GLOBAL — no `account_id`, they are Meta's
// price list, the same for every company. Nothing here reads or writes
// a tenant's rows; every write is keyed by (market, category,
// effective_from) or by country.
//
// There is no UPDATE and no DELETE of a rate: a price change is a new row
// (see `classifyRate` in `meta-rate-input.ts`).
// ============================================================

import { supabaseAdmin } from '@/lib/auth/admin-client';
import {
  classifyRate,
  previewRateImport,
  type ExistingRate,
  type ImportPreview,
  type MarketEntry,
  type RateStatus,
  type RateWrite,
} from '@/lib/billing/meta-rate-input';
import { REST_OF_WORLD, utcDay } from '@/lib/billing/meta-rates';

export interface PlatformRate {
  market: string;
  category: string;
  usdPerMessage: number;
  effectiveFrom: string;
  createdAt: string | null;
  /** The row that prices a message delivered today. */
  inForce: boolean;
  /** `effective_from` after today: announced, not yet in force. */
  scheduled: boolean;
}

export interface PlatformMarketCountry {
  countryCode: string;
  market: string;
}

interface RateRow extends ExistingRate {
  created_at?: string | null;
}

const RATE_COLUMNS =
  'market, category, usd_per_message, effective_from, created_at';

export class RateRefusedError extends Error {
  readonly status: Exclude<RateStatus, 'new'>;
  constructor(status: Exclude<RateStatus, 'new'>) {
    super(
      status === 'retroactive'
        ? 'A rate already in force on that date cannot be replaced retroactively: use today or a later date'
        : status === 'exists'
          ? 'That rate already exists'
          : 'A rate with that market, category and date already exists: a rate in force is never edited, add one with a later date'
    );
    this.name = 'RateRefusedError';
    this.status = status;
  }
}

export function todayUtc(now: Date = new Date()): string {
  return utcDay(now);
}

async function readRates(): Promise<RateRow[]> {
  const { data, error } = await supabaseAdmin()
    .from('meta_rates')
    .select(RATE_COLUMNS)
    .order('market', { ascending: true })
    .order('category', { ascending: true })
    .order('effective_from', { ascending: false });
  if (error) throw error;
  return (data ?? []) as RateRow[];
}

export function toPlatformRates(
  rows: readonly RateRow[],
  today: string
): PlatformRate[] {
  const inForce = new Map<string, string>();
  for (const row of rows) {
    const day = String(row.effective_from).slice(0, 10);
    if (day > today) continue;
    const key = `${row.market}|${row.category}`;
    const current = inForce.get(key);
    if (!current || day > current) inForce.set(key, day);
  }
  return rows
    .map((row) => {
      const day = String(row.effective_from).slice(0, 10);
      return {
        market: row.market,
        category: row.category,
        usdPerMessage: Number(row.usd_per_message),
        effectiveFrom: day,
        createdAt: row.created_at ?? null,
        inForce: inForce.get(`${row.market}|${row.category}`) === day,
        scheduled: day > today,
      };
    })
    .sort((a, b) =>
      a.market !== b.market
        ? a.market < b.market
          ? -1
          : 1
        : a.category !== b.category
          ? a.category < b.category
            ? -1
            : 1
          : a.effectiveFrom < b.effectiveFrom
            ? 1
            : -1
    );
}

export async function listRates(
  now: Date = new Date()
): Promise<PlatformRate[]> {
  return toPlatformRates(await readRates(), todayUtc(now));
}

/** Insert one new rate; refuses anything that would edit a rate. */
export async function insertRate(
  rate: RateWrite,
  userId: string,
  now: Date = new Date()
): Promise<PlatformRate> {
  const existing = await readRates();
  const status = classifyRate(rate, existing, todayUtc(now));
  if (status !== 'new') throw new RateRefusedError(status);

  const { data, error } = await supabaseAdmin()
    .from('meta_rates')
    .insert({ ...rate, created_by: userId })
    .select(RATE_COLUMNS)
    .single();
  if (error) {
    // Two operators adding the same rate at once: the PK decides.
    if ((error as { code?: unknown }).code === '23505') {
      throw new RateRefusedError('conflict');
    }
    throw error;
  }
  const all = toPlatformRates([...existing, data as RateRow], todayUtc(now));
  return all.find(
    (r) =>
      r.market === rate.market &&
      r.category === rate.category &&
      r.effectiveFrom === rate.effective_from
  )!;
}

export interface ImportOutcome {
  preview: ImportPreview;
  inserted: number;
}

/**
 * Classify a pasted CSV and, unless `dryRun`, insert its new rows in one
 * statement (all or nothing). Refused rows block the whole import: the
 * operator fixes the text and previews again.
 */
export async function importRates(
  text: string,
  userId: string,
  dryRun: boolean,
  now: Date = new Date()
): Promise<{ ok: true; value: ImportOutcome } | { ok: false; error: string }> {
  const existing = await readRates();
  const parsed = previewRateImport(text, existing, todayUtc(now));
  if (!parsed.ok) return parsed;
  const preview = parsed.value;
  if (dryRun || !preview.importable || preview.toInsert.length === 0) {
    return { ok: true, value: { preview, inserted: 0 } };
  }
  const { error } = await supabaseAdmin()
    .from('meta_rates')
    .insert(preview.toInsert.map((r) => ({ ...r, created_by: userId })));
  if (error) {
    if ((error as { code?: unknown }).code === '23505') {
      throw new RateRefusedError('conflict');
    }
    throw error;
  }
  return { ok: true, value: { preview, inserted: preview.toInsert.length } };
}

export async function listMarketCountries(): Promise<PlatformMarketCountry[]> {
  const { data, error } = await supabaseAdmin()
    .from('meta_market_countries')
    .select('country_code, market')
    .order('country_code', { ascending: true });
  if (error) throw error;
  return ((data ?? []) as { country_code: string; market: string }[]).map(
    (r) => ({ countryCode: r.country_code, market: r.market })
  );
}

/** Upsert the entries with a market, delete the ones set to `null`. */
export async function applyMarketEntries(
  entries: readonly MarketEntry[],
  now: Date = new Date()
): Promise<PlatformMarketCountry[]> {
  const upserts = entries
    .filter((e) => e.market !== null)
    .map((e) => ({
      country_code: e.country_code,
      market: e.market as string,
      updated_at: now.toISOString(),
    }));
  const removals = entries
    .filter((e) => e.market === null)
    .map((e) => e.country_code);

  if (upserts.length > 0) {
    const { error } = await supabaseAdmin()
      .from('meta_market_countries')
      .upsert(upserts, { onConflict: 'country_code' });
    if (error) throw error;
  }
  if (removals.length > 0) {
    const { error } = await supabaseAdmin()
      .from('meta_market_countries')
      .delete()
      .in('country_code', removals);
    if (error) throw error;
  }
  return listMarketCountries();
}

/** Markets that appear in either table, plus `rest_of_world`. */
export function knownMarkets(
  rates: readonly PlatformRate[],
  countries: readonly PlatformMarketCountry[]
): string[] {
  return [
    ...new Set([
      ...rates.map((r) => r.market),
      ...countries.map((c) => c.market),
      REST_OF_WORLD,
    ]),
  ].sort();
}
