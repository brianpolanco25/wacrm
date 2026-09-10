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
// Keyed by accountId (a multi-account user switching workspaces must not
// see the previous account's status), and only *successful* fetches are
// cached — a transient failure returns a default without poisoning the
// cache, so it retries on the next mount rather than hiding the banner
// for the whole session.
// ------------------------------------------------------------
export interface AiAccountStatus {
  autoReplyOn: boolean;
}

const statusCache = new Map<string, AiAccountStatus>();
// The banner and the list mount together, so the two would otherwise
// race and both miss the (still empty) cache. Sharing the in-flight
// promise keeps it at literally one request per account.
const inFlight = new Map<string, Promise<AiAccountStatus>>();

export function fetchAiAccountStatus(
  accountId: string
): Promise<AiAccountStatus> {
  const cached = statusCache.get(accountId);
  if (cached) return Promise.resolve(cached);
  const pending = inFlight.get(accountId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch('/api/ai/config', { cache: 'no-store' });
      if (!res.ok) return { autoReplyOn: false }; // don't cache a transient failure
      const j = await res.json();
      const status = {
        // AI auto-reply is "live" only when configured, the master
        // switch is on, and the inbound bot is enabled.
        autoReplyOn: !!(j?.configured && j?.is_active && j?.auto_reply_enabled),
      };
      statusCache.set(accountId, status);
      return status;
    } catch {
      return { autoReplyOn: false }; // don't cache
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
 * `null` while it's still unknown (nothing has resolved yet). Callers
 * that only care about "is it on" can treat `null` as off; the banner
 * distinguishes them so it doesn't flash.
 */
export function useAiAccountStatus(): boolean | null {
  const { accountId } = useAuth();
  const [autoReplyOn, setAutoReplyOn] = useState<boolean | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchAiAccountStatus(accountId).then(
      (s) => alive && setAutoReplyOn(s.autoReplyOn)
    );
    return () => {
      alive = false;
    };
  }, [accountId]);

  return autoReplyOn;
}
