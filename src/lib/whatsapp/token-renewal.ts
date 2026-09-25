// ============================================================
// Renewal of the 60-day tokens minted by Embedded Signup.
//
// Why this exists: the Embedded Signup configuration of our Meta app
// (4722841751306607) was created from Meta's WhatsApp template, and
// that template fixes the token lifetime at 60 days — the panel does
// not let it be changed to "never", and the manual wizard that offers
// "never" does not list WhatsApp accounts as an asset. So every number
// a customer connects through the dialog stops sending two months
// later unless somebody refreshes its token first. This module is that
// somebody.
//
// It runs inside the sweep of `GET /api/webhooks/cron` (every minute)
// rather than on its own route: a separate route would need its own
// scheduler entry, and the failure mode of a forgotten entry is exactly
// the one this file exists to prevent. The cost of riding along is one
// indexed query per minute (migration 067) that returns nothing 99 %
// of the time.
//
// Per row, in order:
//   1. skip if a renewal was attempted less than RETRY_MS ago (the
//      sweep is a minute apart; Meta is not to be hammered);
//   2. skip — and record why — if the token already expired: Meta
//      refuses to exchange an expired token, and the only remedy is
//      reconnecting the number from Settings;
//   3. decrypt, ask Meta for a fresh token, encrypt, write it with the
//      new expiry;
//   4. on any failure, write the attempt and Meta's message (only the
//      message: never the token, never the URL that carries the app
//      secret).
//
// No claim / optimistic lock: two overlapping sweeps could refresh the
// same row twice, and that is harmless — Meta keeps the previous token
// valid until its own expiry, so whichever write lands last is a good
// token and the other one simply goes unused.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { decrypt, encrypt } from '@/lib/whatsapp/encryption';
import { refreshBusinessToken } from '@/lib/whatsapp/embedded-signup';
import {
  getMetaAppSecret,
  getPlatformSignupConfig,
} from '@/lib/whatsapp/platform-mode';

/** Renew when the token has this much life left, or less. */
export const TOKEN_RENEWAL_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
/** Do not retry a row before this much time since the last attempt. */
export const TOKEN_RENEWAL_RETRY_MS = 6 * 60 * 60 * 1000;
/** Rows looked at per sweep. Plenty: renewals are spread over weeks. */
export const TOKEN_RENEWAL_SCAN_LIMIT = 50;

/** What the settings screen shows when the date passed without a renewal. */
export const TOKEN_EXPIRED_MESSAGE =
  'The WhatsApp token expired before it could be renewed. Reconnect the number from Settings → WhatsApp.';

const ERROR_MAX_LENGTH = 500;

export interface TokenRenewalResult {
  /** `false` when this deployment is self-hosted (no platform app). */
  enabled: boolean;
  /** Rows whose token expires within the window. */
  scanned: number;
  /** Tokens replaced by a fresh one. */
  renewed: number;
  /** Rows where Meta (or decryption) said no; recorded on the row. */
  failed: number;
  /** Rows left alone: retried too recently, or already expired. */
  skipped: number;
}

interface RenewableRow {
  id: string;
  account_id: string;
  access_token: string;
  token_expires_at: string;
  token_renewal_attempted_at: string | null;
  token_renewal_error: string | null;
}

export interface RenewTokensOptions {
  /** Injection point for tests; defaults to the real clock. */
  now?: () => Date;
  scanLimit?: number;
  windowMs?: number;
  retryMs?: number;
  /** Injection point for tests; defaults to the real Meta call. */
  refresh?: typeof refreshBusinessToken;
}

/**
 * One pass over the rows whose token is about to expire.
 *
 * Never throws: the cron that hosts it reports what it managed to do,
 * and a renewal problem must not stop the webhook deliveries that share
 * the sweep.
 */
export async function renewExpiringTokens(
  db: SupabaseClient,
  opts: RenewTokensOptions = {}
): Promise<TokenRenewalResult> {
  const result: TokenRenewalResult = {
    enabled: false,
    scanned: 0,
    renewed: 0,
    failed: 0,
    skipped: 0,
  };

  const platform = getPlatformSignupConfig();
  const appSecret = getMetaAppSecret();
  if (!platform || !appSecret) {
    // Self-hosted: no token here was minted by our app, so there is
    // nothing we could refresh. Not an error — it is the default.
    return result;
  }
  result.enabled = true;

  const now = opts.now ? opts.now() : new Date();
  const nowMs = now.getTime();
  const windowMs = opts.windowMs ?? TOKEN_RENEWAL_WINDOW_MS;
  const retryMs = opts.retryMs ?? TOKEN_RENEWAL_RETRY_MS;
  const refresh = opts.refresh ?? refreshBusinessToken;
  const threshold = new Date(nowMs + windowMs).toISOString();

  const { data, error } = await db
    .from('whatsapp_config')
    .select(
      'id, account_id, access_token, token_expires_at, token_renewal_attempted_at, token_renewal_error'
    )
    .eq('provisioned_via', 'embedded_signup')
    .not('token_expires_at', 'is', null)
    .lte('token_expires_at', threshold)
    .order('token_expires_at', { ascending: true })
    .limit(opts.scanLimit ?? TOKEN_RENEWAL_SCAN_LIMIT);

  if (error) {
    console.error('[token-renewal] scan failed:', error.message);
    return result;
  }

  const rows = (data ?? []) as unknown as RenewableRow[];
  result.scanned = rows.length;

  for (const row of rows) {
    const attemptedAt = row.token_renewal_attempted_at
      ? Date.parse(row.token_renewal_attempted_at)
      : null;
    if (attemptedAt !== null && nowMs - attemptedAt < retryMs) {
      result.skipped += 1;
      continue;
    }

    const expiresAt = Date.parse(row.token_expires_at);
    if (Number.isFinite(expiresAt) && expiresAt <= nowMs) {
      // Too late for Meta to help. Record it once (the retry gate keeps
      // this write from repeating every minute) so the settings screen
      // can say "reconnect" instead of a mysterious send failure.
      if (row.token_renewal_error !== TOKEN_EXPIRED_MESSAGE) {
        await recordAttempt(db, row.id, now, TOKEN_EXPIRED_MESSAGE);
      }
      result.skipped += 1;
      continue;
    }

    let fresh;
    try {
      const current = decrypt(row.access_token);
      fresh = await refresh({
        accessToken: current,
        appId: platform.appId,
        appSecret,
        graphVersion: platform.graphVersion,
      });
    } catch (err) {
      // `err.message` only — see the handling rule in embedded-signup.ts.
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(
        `[token-renewal] refresh failed for config ${row.id}:`,
        message
      );
      await recordAttempt(db, row.id, now, message);
      result.failed += 1;
      continue;
    }

    let encrypted: string;
    try {
      encrypted = encrypt(fresh.accessToken);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      console.error(
        `[token-renewal] encryption failed for config ${row.id}:`,
        message
      );
      await recordAttempt(db, row.id, now, message);
      result.failed += 1;
      continue;
    }

    const { error: writeError } = await db
      .from('whatsapp_config')
      .update({
        access_token: encrypted,
        // Meta always answers a 60-day refresh with `expires_in`; if it
        // ever did not, keeping the old date is the safe reading (it
        // makes the sweep try again, not forget the row).
        ...(fresh.expiresAt ? { token_expires_at: fresh.expiresAt } : {}),
        token_renewed_at: now.toISOString(),
        token_renewal_attempted_at: now.toISOString(),
        token_renewal_error: null,
      })
      .eq('id', row.id);

    if (writeError) {
      console.error(
        `[token-renewal] write failed for config ${row.id}:`,
        writeError.message
      );
      result.failed += 1;
      continue;
    }

    result.renewed += 1;
  }

  return result;
}

async function recordAttempt(
  db: SupabaseClient,
  id: string,
  now: Date,
  message: string
): Promise<void> {
  const { error } = await db
    .from('whatsapp_config')
    .update({
      token_renewal_attempted_at: now.toISOString(),
      token_renewal_error: message.slice(0, ERROR_MAX_LENGTH),
    })
    .eq('id', id);
  if (error) {
    console.error(
      `[token-renewal] could not record attempt for config ${id}:`,
      error.message
    );
  }
}
