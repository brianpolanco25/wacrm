'use client';

// ============================================================
// Account billing status — one request per account, shared by every
// consumer.
//
// It used to live inside `billing-status-alert.tsx` as a bare `fetch`
// in a `useEffect`. p6.2 adds a second consumer in the header (the
// trial countdown), and the spec is explicit that the banner must not
// cost a query of its own ("sin consulta nueva por página"). So the
// fetch and its cache moved here and both consumers share them: the
// dunning alert and the trial banner together cost at most one
// `/api/billing/status` round-trip per account.
//
// The endpoint is the one f3.5 opened to ANY member (`getCurrentAccount`,
// no role floor) — deliberately not `/api/billing/subscription`, which
// is admin-only and would 403 for the agents and viewers who are exactly
// who the trial countdown is for. It resolves the subscription through
// the same entitlements layer the server enforces with, scoped by
// `account_id` on top of RLS.
//
// Same three rules as `use-ai-account-status.ts`, for the same reasons:
//
//   1. Keyed by accountId — a support session or a workspace switch must
//      never show the previous account's billing state.
//   2. A failure resolves to `null` = **unknown**, never to a state.
//      Inventing "your account is suspended" (or "your trial ends
//      today") out of a network blip is worse than saying nothing.
//   3. Successful reads expire (TTL). Contracting a plan from `/billing`
//      has to make the trial banner go away without a hard reload.
// ============================================================

import { useEffect, useState } from 'react';

import { useAuth } from '@/hooks/use-auth';

/** The body of `GET /api/billing/status`, plus when we read it. */
export interface BillingStatus {
  planId: string;
  status: string;
  readOnly: boolean;
  /** A platform operator suspended the account by hand (fase 4 §2). */
  manualHold?: boolean;
  graceUntil: string | null;
  trialEndsAt: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  /**
   * Epoch ms at the moment this snapshot landed.
   *
   * The trial countdown needs a clock, and React 19 forbids reading one
   * during render (`Date.now()` is impure — the compiler's lint rule
   * catches it). So the clock is read where the data is, once, and
   * travels with it: the component stays a pure function of its input
   * and the number it prints is as fresh as the read behind it.
   */
  readAt: number;
}

/**
 * How long a successful read is reused. Short enough that the trial
 * banner disappears on its own after checkout (the return page lands
 * back in the shell, not on a fresh document), long enough that two
 * consumers mounting together cost one request.
 */
export const BILLING_STATUS_TTL_MS = 30_000;

interface CacheEntry {
  status: BillingStatus;
  /** `Date.now()` at the time the response landed. */
  at: number;
}

const statusCache = new Map<string, CacheEntry>();
// The header banner and the in-page alert mount in the same commit, so
// without this they would both miss the (still empty) cache and race.
const inFlight = new Map<string, Promise<BillingStatus | null>>();

/**
 * Resolves the account's billing status, or `null` when it could not be
 * established (non-OK response or network error). `null` is not "all
 * good": callers must treat it as unknown and render nothing.
 */
export function fetchBillingStatus(
  accountId: string
): Promise<BillingStatus | null> {
  const cached = statusCache.get(accountId);
  if (cached && Date.now() - cached.at < BILLING_STATUS_TTL_MS) {
    return Promise.resolve(cached.status);
  }
  if (cached) statusCache.delete(accountId);
  const pending = inFlight.get(accountId);
  if (pending) return pending;

  const request = (async () => {
    try {
      const res = await fetch('/api/billing/status', { cache: 'no-store' });
      if (!res.ok) return null; // unknown — not "nothing to warn about"
      const body = (await res.json()) as Omit<BillingStatus, 'readAt'>;
      const status: BillingStatus = { ...body, readAt: Date.now() };
      statusCache.set(accountId, { status, at: status.readAt });
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
export function __resetBillingStatusCache() {
  statusCache.clear();
  inFlight.clear();
}

/**
 * The account's billing status, or `null` while it is **unknown** —
 * nothing has resolved yet, no account resolved, or the read failed.
 * Every consumer renders nothing for `null`.
 */
export function useBillingStatus(): BillingStatus | null {
  const { accountId } = useAuth();
  const [status, setStatus] = useState<BillingStatus | null>(null);

  useEffect(() => {
    if (!accountId) return;
    let alive = true;
    fetchBillingStatus(accountId).then((s) => {
      if (alive) setStatus(s);
    });
    return () => {
      alive = false;
    };
  }, [accountId]);

  return status;
}
