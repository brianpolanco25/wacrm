'use client';

import { useEffect, useState } from 'react';
import { useAuth } from '@/hooks/use-auth';

// ------------------------------------------------------------
// Account AI status — one query per account, shared by everything that
// needs it.
//
// It used to live inside ai-thread-banner.tsx. The inbox list needs the
// exact same flag to tell "the AI has this one" from "nobody has this
// one" (fase 1 §3), and it must not pay a query per conversation — so
// the fetch and its cache moved here and both consumers share them: the
// banner and the whole list together cost at most one /api/ai/config
// round-trip per account.
//
// Three rules, all of them load-bearing now that the value drives the
// whole list and not just a banner:
//
//   1. Keyed by accountId — a multi-account user switching workspaces
//      must not see the previous account's status.
//   2. A failure resolves to `null` = **unknown**, never to "off".
//      "Off" is a claim: it paints the amber "nobody on it" alarm on
//      every unassigned row and drags them into the Unattended filter.
//      A 401 during a token refresh must not do that.
//   3. Successful reads expire (STATUS_TTL_MS). An admin who turns the
//      assistant off in Settings shouldn't have to hard-reload the tab
//      for the list to stop saying "AI replying".
// ------------------------------------------------------------
export interface AiAccountStatus {
  autoReplyOn: boolean;
}

/**
 * How long a successful read is reused. Short enough that toggling the
 * assistant in Settings shows up in the inbox on its own, long enough
 * that scrolling a list of hundreds of rows costs zero extra requests
 * (the value is read once per mount, not per row).
 */
export const STATUS_TTL_MS = 30_000;

interface CacheEntry {
  status: AiAccountStatus;
  /** `Date.now()` at the time the response landed. */
  at: number;
}

const statusCache = new Map<string, CacheEntry>();
// The banner and the list mount together, so the two would otherwise
// race and both miss the (still empty) cache. Sharing the in-flight
// promise keeps it at literally one request per account.
const inFlight = new Map<string, Promise<AiAccountStatus | null>>();

/**
 * Resolves the account's AI status, or `null` when it could not be
 * established (non-OK response or network error). `null` is not "off":
 * callers must treat it as unknown and show nothing.
 */
export function fetchAiAccountStatus(
  accountId: string
): Promise<AiAccountStatus | null> {
  const cached = statusCache.get(accountId);
  if (cached && Date.now() - cached.at < STATUS_TTL_MS) {
    return Promise.resolve(cached.status);
  }
  if (cached) statusCache.delete(accountId);
  const pending = inFlight.get(accountId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch('/api/ai/config', { cache: 'no-store' });
      if (!res.ok) return null; // unknown — not "the account has no bot"
      const j = await res.json();
      const status = {
        // AI auto-reply is "live" only when configured, the master
        // switch is on, and the inbound bot is enabled.
        autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
      };
      statusCache.set(accountId, { status, at: Date.now() });
      return status;
    } catch {
      return null; // unknown, and not cached: the next mount retries
    }
  })();

  inFlight.set(accountId, request);
  void request.finally(() => inFlight.delete(accountId));
  return request;
}

/** Test seam — drops the module-level caches between cases. */
export function __resetAiAccountStatusCache() {
  statusCache.clear();
  inFlight.clear();
}

/**
 * `true` when the account's AI is live and answering inbound messages,
 * `false` when it isn't, and `null` while it is **unknown** — nothing
 * has resolved yet, or the read failed. Consumers must not collapse
 * `null` into `false`: see `lib/inbox/attention.ts`, which keeps that
 * guard in one place for both the row badge and the Unattended filter.
 * (The thread banner renders nothing for either, which is right: with
 * no answer there is nothing to say about the bot.)
 */
export function useAiAccountStatus(): boolean | null {
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then(
      (s) => alive && setAutoReplyOn(s === null ? null : s.autoReplyOn)
    );
    return () => {
      alive = false;
    };
  }, [accountId]);

  return autoReplyOn;
}
