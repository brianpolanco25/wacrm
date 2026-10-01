'use client';

import { useEffect } from 'react';

import { createClient, supportSessionActive } from '@/lib/supabase/client';
import { useAuth } from '@/hooks/use-auth';
import {
  HEARTBEAT_MS,
  IDLE_AFTER_MS,
  type StoredPresence,
} from '@/lib/presence';

/** What the heartbeat needs from the browser, injectable for the tests. */
export interface HeartbeatEnv {
  /** `supabase.rpc('touch_presence', …)`, reduced to its error. */
  touch: (status: StoredPresence) => PromiseLike<{
    error: { message: string } | null;
  }>;
  /**
   * Re-read on every beat: the support flag can appear while this effect
   * is running (a session opened in another tab) before React re-renders.
   */
  inSupportSession: () => boolean;
  document: Pick<
    Document,
    'hidden' | 'addEventListener' | 'removeEventListener'
  >;
  window: Pick<Window, 'addEventListener' | 'removeEventListener'>;
}

/**
 * Start reporting this tab's presence; returns the cleanup.
 *
 * Does nothing at all — no RPC, no listeners — while the account is not
 * known yet, or while a support session is open (s9.12). During a session
 * `touch_presence` would stamp the OPERATOR as present in their own
 * company (it resolves the account from `auth.uid()`), and the browser
 * client refuses it in a session anyway (`SUPPORT_BLOCKED_RPCS`): the
 * only thing beating would achieve is a `console.error` every 30 seconds.
 */
export function startPresenceHeartbeat(
  accountId: string | null,
  supportSession: boolean,
  env: HeartbeatEnv
): () => void {
  // Hold off until the account is known. Beating during the brief
  // window on a fresh signup — authed but profile/account row not yet
  // created — would make touch_presence raise "No account for caller"
  // and log a spurious error. The effect re-runs once accountId lands.
  if (!accountId || supportSession) return () => {};

  const { document: doc, window: win } = env;
  let cancelled = false;
  let lastBeatAt = 0;
  let lastActivity = Date.now();

  const markActive = () => {
    lastActivity = Date.now();
  };

  const currentStatus = (): StoredPresence => {
    if (doc.hidden) return 'away';
    if (Date.now() - lastActivity > IDLE_AFTER_MS) return 'away';
    return 'online';
  };

  const beat = async () => {
    if (cancelled) return;
    // A session opened since this effect started: stand down until the
    // re-render (which re-runs the effect with `supportSession`) catches up.
    if (env.inSupportSession()) return;
    // Coalesce bursts: a tab refocus fires visibilitychange AND focus
    // together, so skip a beat within 1s of the last to avoid two RPCs
    // in the same frame. The 30s interval is never affected.
    const t = Date.now();
    if (t - lastBeatAt < 1_000) return;
    lastBeatAt = t;
    const { error } = await env.touch(currentStatus());
    if (error && !cancelled) {
      // Non-fatal: presence is best-effort. Log once per failure so a
      // misconfigured RPC is visible without spamming.
      console.error(
        '[PresenceHeartbeat] touch_presence failed:',
        error.message
      );
    }
  };

  // Activity listeners. `passive` so we never block scroll/input.
  const activityEvents: (keyof DocumentEventMap)[] = [
    'mousemove',
    'keydown',
    'pointerdown',
    'scroll',
  ];
  activityEvents.forEach((e) =>
    doc.addEventListener(e, markActive, { passive: true })
  );

  // Returning to the tab should beat immediately so a member flips
  // back to online without a 30s wait. The debounce in beat() absorbs
  // the visibilitychange + focus double-fire.
  const onReturn = () => {
    if (!doc.hidden) markActive();
    void beat();
  };
  doc.addEventListener('visibilitychange', onReturn);
  win.addEventListener('focus', onReturn);

  void beat();
  const interval = setInterval(() => void beat(), HEARTBEAT_MS);

  return () => {
    cancelled = true;
    clearInterval(interval);
    activityEvents.forEach((e) => doc.removeEventListener(e, markActive));
    doc.removeEventListener('visibilitychange', onReturn);
    win.removeEventListener('focus', onReturn);
  };
}

/**
 * PresenceHeartbeat — headless. Mount ONCE per signed-in dashboard tab
 * (in the dashboard shell, below the auth gate). Reports this tab's
 * presence to the `member_presence` table via the `touch_presence` RPC
 * roughly every HEARTBEAT_MS.
 *
 * The client only ever reports 'online' or 'away':
 *   - 'away'   when the tab is hidden, or no user input for IDLE_AFTER_MS
 *   - 'online' otherwise
 * It keeps heartbeating while away (so the row stays fresh, i.e. not
 * offline). When the tab closes the beats simply stop and viewers derive
 * 'offline' from staleness — no unreliable unload write needed.
 *
 * Silent during a support session — see `startPresenceHeartbeat`.
 */
export function PresenceHeartbeat() {
  const { accountId, supportSession } = useAuth();

  useEffect(() => {
    const supabase = createClient();
    return startPresenceHeartbeat(accountId, supportSession, {
      touch: (status) => supabase.rpc('touch_presence', { p_status: status }),
      inSupportSession: supportSessionActive,
      document,
      window,
    });
  }, [accountId, supportSession]);

  return null;
}
