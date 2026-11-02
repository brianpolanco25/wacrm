// ============================================================
// #1650 — Coexistencia: app de WhatsApp Business + Cloud API.
//
// A number onboarded through Embedded Signup with the coexistence
// option (`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`) stays on the
// phone's WhatsApp Business app AND is on Cloud API. Meta then lets us
// ask, ONCE per sync type and only within 24 h of the onboarding, for
// the app's contacts (`smb_app_state_sync`) and chat history
// (`history`). A second request for the same type is refused and the
// only way back is to disconnect and repeat the onboarding — so the
// "once" is enforced here with an atomic claim on the row, never with
// a blind retry.
//
// The data itself arrives by webhook; processing it is #1651.
//
// Nothing here throws to the caller and nothing logs the token: only
// `error.message` of Supabase/Meta failures.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  syncSmbAppData,
  type SmbAppDataSyncType,
} from '@/lib/whatsapp/meta-api';

export const SMB_SYNC_TYPES = ['smb_app_state_sync', 'history'] as const;
export type SmbSyncType = (typeof SMB_SYNC_TYPES)[number];
export type SmbSyncState =
  'requested' | 'already_done' | 'in_flight' | 'failed';
export interface SmbSyncOutcome {
  state_sync: SmbSyncState;
  history: SmbSyncState;
}

import { SMB_SYNC_UNSAVED_MARKER } from '@/lib/whatsapp/coexistence-window';

export {
  SMB_SYNC_UNSAVED_MARKER,
  SMB_SYNC_WINDOW_MS,
  hasUnsavedSmbSync,
  isWithinSmbSyncWindow,
} from '@/lib/whatsapp/coexistence-window';
/** A claim older than this is considered abandoned and can be retaken. */
export const SMB_SYNC_CLAIM_TTL_MS = 5 * 60 * 1000;
/** `smb_sync_error` is capped so a verbose Meta error cannot bloat the row. */
export const SMB_SYNC_ERROR_MAX = 500;

const COLUMNS: Record<
  SmbSyncType,
  { requestedAt: string; requestId: string; outcome: keyof SmbSyncOutcome }
> = {
  smb_app_state_sync: {
    requestedAt: 'smb_state_sync_requested_at',
    requestId: 'smb_state_sync_request_id',
    outcome: 'state_sync',
  },
  history: {
    requestedAt: 'smb_history_sync_requested_at',
    requestId: 'smb_history_sync_request_id',
    outcome: 'history',
  },
};

export type BizAppStatus =
  'coexistence' | 'biz_app_only' | 'not_on_biz_app' | 'unknown';

/**
 * Read Meta's `is_on_biz_app` + `platform_type` of a phone number.
 *
 *  - `true` + `CLOUD_API`      → coexistence: messages reach Cloud API
 *  - `true` + any other string → the number lives on the phone app only;
 *                                Meta does not deliver to the CRM
 *  - `false`                   → ordinary Cloud API number
 *  - anything else             → we could not tell (probe failed)
 */
export function classifyBizAppStatus(
  isOnBizApp: unknown,
  platformType: unknown
): BizAppStatus {
  if (isOnBizApp === true) {
    if (platformType === 'CLOUD_API') return 'coexistence';
    if (typeof platformType === 'string' && platformType) return 'biz_app_only';
    return 'unknown';
  }
  if (isOnBizApp === false) return 'not_on_biz_app';
  return 'unknown';
}

export type PickCoexistenceNumberResult =
  | { ok: true; phoneNumberId: string }
  | { ok: false; reason: 'none' | 'ambiguous' };

/**
 * Which number of the WABA was just onboarded in coexistence. Meta's
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` event carries only the
 * `waba_id`, so the server lists the WABA's numbers and keeps the one
 * with `is_on_biz_app === true`. More than one is ambiguous and the
 * caller must refuse rather than guess.
 */
export function pickCoexistencePhoneNumber(
  numbers: ReadonlyArray<{ id: string; is_on_biz_app?: unknown }>
): PickCoexistenceNumberResult {
  const onApp = numbers.filter((n) => n.is_on_biz_app === true);
  if (onApp.length === 1) return { ok: true, phoneNumberId: onApp[0].id };
  return { ok: false, reason: onApp.length === 0 ? 'none' : 'ambiguous' };
}

function messageOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === 'object' && 'message' in err) {
    const m = (err as { message?: unknown }).message;
    if (typeof m === 'string') return m;
  }
  return 'Unknown error';
}

/**
 * Request the two coexistence syncs for one `whatsapp_config` row, each
 * at most once.
 *
 * For each type, in Meta's documented order (contacts, then history):
 *
 *  1. claim: `UPDATE … SET <type>_requested_at = now WHERE id AND
 *     account_id AND <type>_request_id IS NULL AND (<type>_requested_at
 *     IS NULL OR < now − 5 min)`. No row back → somebody already did it
 *     (`already_done`) or is doing it (`in_flight`); Meta is not called.
 *  2. call Meta with the token.
 *  3. success → persist the `request_id` → `requested`.
 *  4. failure → release the claim → `failed`, and go on with the other.
 *
 * Finally `smb_sync_error` is cleared when nothing failed and nothing is
 * left in flight, or set to the failures (truncated) when something
 * failed. Every write is scoped by row id AND account id.
 */
export async function runSmbAppDataSync(
  admin: SupabaseClient,
  args: {
    accountId: string;
    configId: string;
    phoneNumberId: string;
    accessToken: string;
  },
  deps: {
    sync?: typeof syncSmbAppData;
    now?: () => Date;
  } = {}
): Promise<SmbSyncOutcome> {
  const sync = deps.sync ?? syncSmbAppData;
  const now = deps.now ?? (() => new Date());
  const { accountId, configId, phoneNumberId, accessToken } = args;

  const outcome: SmbSyncOutcome = { state_sync: 'failed', history: 'failed' };
  const failures: string[] = [];

  // A type whose accepted sync could not be saved earlier (see step 3)
  // is never retried: Meta would refuse the second request and the row
  // would be stuck in `failed` with the real request id lost. Its
  // segment of the error is carried over so the next write keeps it.
  const { data: current } = await admin
    .from('whatsapp_config')
    .select('smb_sync_error')
    .eq('id', configId)
    .eq('account_id', accountId)
    .maybeSingle();
  const previousError =
    ((current as { smb_sync_error?: unknown } | null)?.smb_sync_error as
      string | null | undefined) ?? '';
  const unsavedSegment = (syncType: SmbSyncType): string | undefined =>
    previousError
      .split(' | ')
      .find((seg) => seg.startsWith(`${syncType}: ${SMB_SYNC_UNSAVED_MARKER}`));

  for (const syncType of SMB_SYNC_TYPES) {
    const cols = COLUMNS[syncType];
    const state = await runOne(syncType as SmbAppDataSyncType, cols);
    outcome[cols.outcome] = state;
  }

  async function runOne(
    syncType: SmbAppDataSyncType,
    cols: (typeof COLUMNS)[SmbSyncType]
  ): Promise<SmbSyncState> {
    const unsaved = unsavedSegment(syncType);
    if (unsaved) {
      failures.push(unsaved);
      return 'failed';
    }

    const at = now();
    const cutoff = new Date(at.getTime() - SMB_SYNC_CLAIM_TTL_MS).toISOString();

    // ---- 1. atomic claim ----------------------------------------
    const { data: claimed, error: claimError } = await admin
      .from('whatsapp_config')
      .update({ [cols.requestedAt]: at.toISOString() })
      .eq('id', configId)
      .eq('account_id', accountId)
      .is(cols.requestId, null)
      .or(`${cols.requestedAt}.is.null,${cols.requestedAt}.lt.${cutoff}`)
      .select('id');
    if (claimError) {
      const message = messageOf(claimError);
      console.warn(`[coexistence] ${syncType} claim failed:`, message);
      failures.push(`${syncType}: ${message}`);
      return 'failed';
    }
    if (!claimed || claimed.length === 0) {
      const { data: row } = await admin
        .from('whatsapp_config')
        .select(cols.requestId)
        .eq('id', configId)
        .eq('account_id', accountId)
        .maybeSingle();
      const requestId = (row as Record<string, unknown> | null)?.[
        cols.requestId
      ];
      return requestId ? 'already_done' : 'in_flight';
    }

    // ---- 2. ask Meta ---------------------------------------------
    let requestId: string;
    try {
      ({ requestId } = await sync({ phoneNumberId, accessToken, syncType }));
    } catch (err) {
      const message = messageOf(err);
      console.warn(`[coexistence] ${syncType} sync failed:`, message);
      failures.push(`${syncType}: ${message}`);
      // ---- 4. release the claim so a manual retry can take it ----
      const { error: releaseError } = await admin
        .from('whatsapp_config')
        .update({ [cols.requestedAt]: null })
        .eq('id', configId)
        .eq('account_id', accountId);
      if (releaseError) {
        console.warn(
          `[coexistence] ${syncType} claim release failed:`,
          messageOf(releaseError)
        );
      }
      return 'failed';
    }

    // ---- 3. persist the request id -------------------------------
    const { error: saveError } = await admin
      .from('whatsapp_config')
      .update({ [cols.requestId]: requestId })
      .eq('id', configId)
      .eq('account_id', accountId);
    if (saveError) {
      // Meta accepted: the claim is NOT released and the type is marked
      // so no later pass (signup or manual retry) asks Meta again. The
      // request id goes to the log (never the token) so it can be
      // restored by hand.
      const message = messageOf(saveError);
      console.error(
        `[coexistence] ${syncType} accepted by Meta (request_id ${requestId}) but not saved:`,
        message
      );
      failures.push(
        `${syncType}: ${SMB_SYNC_UNSAVED_MARKER} ${requestId}: ${message}`
      );
      return 'failed';
    }
    return 'requested';
  }

  const states = Object.values(outcome);
  let smbSyncError: string | null | undefined;
  if (failures.length > 0) {
    smbSyncError = failures.join(' | ').slice(0, SMB_SYNC_ERROR_MAX);
  } else if (!states.includes('in_flight')) {
    smbSyncError = null;
  }
  // With no failures but a sync still in flight elsewhere, the column is
  // left alone: that other pass will write its own verdict.
  if (smbSyncError !== undefined) {
    const { error } = await admin
      .from('whatsapp_config')
      .update({ smb_sync_error: smbSyncError })
      .eq('id', configId)
      .eq('account_id', accountId);
    if (error) {
      console.warn('[coexistence] smb_sync_error not saved:', messageOf(error));
    }
  }

  return outcome;
}
