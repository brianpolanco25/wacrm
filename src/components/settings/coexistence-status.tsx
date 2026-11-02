'use client';

// ============================================================
// CoexistenceStatus — coexistence block of a number card in
// Settings → WhatsApp (#1650, R19–R21).
//
// Presentational only, like `PaymentStatusBadge`: the state was stored
// by the server (migration 088) and the retry button calls `onRetry`,
// which is what talks to `POST /api/whatsapp/config/smb-sync`.
//
//   - `probeCode === 'biz_app_without_coexistence'` (last «Verify with
//     Meta» of THIS row): amber warning — the number is on the phone app
//     without coexistence and Meta does not deliver to the CRM.
//   - `coexistence_onboarded_at` set: badge + sync line (done / pending
//     / failed) + retry button inside Meta's 24 h window, or the
//     "repeat the signup" text outside it.
// ============================================================

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2, RefreshCw, Smartphone } from 'lucide-react';

import { Button } from '@/components/ui/button';
import {
  hasUnsavedSmbSync,
  isWithinSmbSyncWindow,
} from '@/lib/whatsapp/coexistence-window';
import type { WhatsAppConfig } from '@/types';

export type NumberDeliveryState = 'coexistence' | 'registered' | 'unregistered';

/** Which status the card shows instead of a bare «Registered». */
export function numberDeliveryState(
  row: Pick<WhatsAppConfig, 'registered_at' | 'coexistence_onboarded_at'>
): NumberDeliveryState {
  if (row.coexistence_onboarded_at) return 'coexistence';
  return row.registered_at ? 'registered' : 'unregistered';
}

/**
 * The date the «Registered» banner shows: the coexistence onboarding
 * for a coexistence number (it never has `registered_at`), otherwise
 * the last successful /register. `null` = unknown.
 */
export function deliverySinceDate(
  row: Pick<WhatsAppConfig, 'registered_at' | 'coexistence_onboarded_at'>
): string | null {
  if (row.coexistence_onboarded_at) return row.coexistence_onboarded_at;
  return row.registered_at ?? null;
}

export type SmbSyncDisplay = 'done' | 'pending' | 'failed';

export function smbSyncDisplay(
  row: Pick<
    WhatsAppConfig,
    | 'smb_state_sync_request_id'
    | 'smb_history_sync_request_id'
    | 'smb_sync_error'
  >
): SmbSyncDisplay {
  if (row.smb_state_sync_request_id && row.smb_history_sync_request_id) {
    return 'done';
  }
  return row.smb_sync_error ? 'failed' : 'pending';
}

export interface CoexistenceStatusProps {
  row: WhatsAppConfig;
  /** `code` of the last verification OF THIS row. */
  probeCode?: string | null;
  /** = canEditSettings. */
  canRetry: boolean;
  busy: boolean;
  onRetry: () => void;
  /** For tests; defaults to the mount time (no clock read in render). */
  now?: Date;
}

/** The coexistence badge, reused in the card's status line. */
export function CoexistenceBadge() {
  const t = useTranslations('Settings.whatsapp');
  return (
    <span
      className="bg-primary/15 text-primary inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold tracking-wide"
      data-coexistence-badge
    >
      <Smartphone className="size-3" aria-hidden="true" />
      {t('coexistenceBadge')}
    </span>
  );
}

export function CoexistenceStatus({
  row,
  probeCode,
  canRetry,
  busy,
  onRetry,
  now,
}: CoexistenceStatusProps) {
  const t = useTranslations('Settings.whatsapp');
  const [mountedAt] = useState(() => new Date());
  const at = now ?? mountedAt;

  const warning =
    probeCode === 'biz_app_without_coexistence' ? (
      <p
        role="alert"
        className="mt-1 flex items-start gap-1.5 rounded-md border border-amber-900/60 bg-amber-950/30 px-2 py-1.5 text-xs text-amber-300"
      >
        <AlertTriangle className="mt-0.5 size-3 shrink-0" aria-hidden="true" />
        <span>{t('bizAppWithoutCoexistence')}</span>
      </p>
    ) : null;

  if (!row.coexistence_onboarded_at) return warning;

  const sync = smbSyncDisplay(row);
  // Meta accepted a sync whose id could not be saved: retrying would
  // spend the only call Meta allows. Support has to step in.
  const needsSupport = sync !== 'done' && hasUnsavedSmbSync(row.smb_sync_error);
  const inWindow = isWithinSmbSyncWindow(row.coexistence_onboarded_at, at);
  const tone =
    sync === 'done'
      ? 'text-muted-foreground'
      : sync === 'failed'
        ? 'text-red-400'
        : 'text-amber-400';
  const label =
    sync === 'done'
      ? t('coexistenceSyncDone')
      : sync === 'failed'
        ? t('coexistenceSyncFailed', { message: row.smb_sync_error ?? '' })
        : t('coexistenceSyncPending');

  return (
    <>
      {warning}
      <div
        className="mt-0.5 flex flex-wrap items-center gap-2 text-xs"
        data-smb-sync={sync}
      >
        <span className={tone}>{label}</span>
        {needsSupport && (
          <span className="text-muted-foreground" data-smb-sync-needs-support>
            {t('coexistenceSyncNeedsSupport')}
          </span>
        )}
        {sync !== 'done' &&
          !needsSupport &&
          (inWindow ? (
            canRetry && (
              <Button
                variant="outline"
                size="sm"
                disabled={busy}
                aria-busy={busy}
                onClick={onRetry}
                className="border-border text-muted-foreground hover:text-foreground h-6 bg-transparent px-2 text-xs"
              >
                {busy ? (
                  <Loader2 className="size-3 animate-spin" aria-hidden="true" />
                ) : (
                  <RefreshCw className="size-3" aria-hidden="true" />
                )}
                {busy
                  ? t('coexistenceSyncRetrying')
                  : t('coexistenceSyncRetry')}
              </Button>
            )
          ) : (
            <span className="text-muted-foreground" data-smb-sync-expired>
              {t('coexistenceSyncExpired')}
            </span>
          ))}
      </div>
    </>
  );
}
