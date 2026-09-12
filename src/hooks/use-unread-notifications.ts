"use client";

import { useEffect, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { useAuth } from "@/hooks/use-auth";
import { eventBelongsToAccount } from "@/lib/realtime/account-scope";
import type { Notification } from "@/types";

/**
 * Fold one `notifications` realtime event into the badge count.
 *
 * Returns `count` unchanged when the event is not about the account this
 * browser is showing. That case is not hypothetical: RLS on
 * `notifications` is `auth.uid() = user_id`, so during a support session
 * the operator's OWN notifications still stream in — the badge said 1
 * while `/notifications`, which filters by account, showed nothing.
 *
 * `notifications` is REPLICA IDENTITY FULL (migration 027), so the old
 * record on a DELETE carries `account_id` and can be checked too.
 */
export function applyNotificationEvent(
  count: number,
  accountId: string | null,
  payload: { eventType: string; new: unknown; old: unknown },
): number {
  if (payload.eventType === "INSERT") {
    if (!eventBelongsToAccount(payload.new, accountId)) return count;
    const row = payload.new as Notification;
    return row.read_at ? count : count + 1;
  }
  if (payload.eventType === "UPDATE") {
    // Updates here only ever set read_at (marking a notification read).
    // Derive purely from the new row so we don't rely on payload.old
    // columns.
    if (!eventBelongsToAccount(payload.new, accountId)) return count;
    const newRow = payload.new as Notification;
    return newRow.read_at ? Math.max(0, count - 1) : count;
  }
  if (payload.eventType === "DELETE") {
    if (!eventBelongsToAccount(payload.old, accountId)) return count;
    const oldRow = payload.old as Partial<Notification>;
    return oldRow.read_at ? count : Math.max(0, count - 1);
  }
  return count;
}

/**
 * Count of unread notifications for the current user. Used by the
 * sidebar to surface a badge on the Notifications nav entry.
 *
 * RLS on `notifications` scopes every read to `auth.uid() = user_id`,
 * and the badge additionally filters by the account being shown so it
 * agrees with `/notifications`: during a support session both are about
 * the customer's account, where an operator has no notifications of
 * their own.
 */
export function useUnreadNotifications(): number {
  const [count, setCount] = useState(0);
  const { accountId } = useAuth();

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      // head:true skips fetching rows — we only need the `count`
      // supabase-js returns alongside the (empty) response body.
      const { count: unreadCount, error } = await supabase
        .from("notifications")
        .select("*", { count: "exact", head: true })
        .eq("account_id", accountId)
        .is("read_at", null);
      if (cancelled || error) return;
      setCount(unreadCount ?? 0);
    })();

    const channel = supabase
      .channel("notifications-unread-count")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "notifications",
          filter: `account_id=eq.${accountId}`,
        },
        (payload) => {
          setCount((n) => applyNotificationEvent(n, accountId, payload));
        },
      )
      .subscribe();

    return () => {
      cancelled = true;
      supabase.removeChannel(channel);
    };
  }, [accountId]);

  return count;
}
