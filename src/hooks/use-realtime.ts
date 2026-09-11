"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import { eventBelongsToAccount } from "@/lib/realtime/account-scope";
import type { Message, Conversation } from "@/types";
import type { RealtimeChannel } from "@supabase/supabase-js";

interface RealtimeEvent<T> {
  eventType: "INSERT" | "UPDATE" | "DELETE";
  new: T;
  old: Partial<T>;
}

interface UseRealtimeOptions {
  channelName: string;
  /**
   * The account this browser is showing (`useAuth().accountId`) — the
   * customer's during a support session. Events from any other account
   * are dropped instead of being handed to the callbacks; without this
   * the operator's own conversations landed in the customer's inbox,
   * live, under the customer's banner. Nothing is subscribed at all
   * while this is null.
   */
  accountId: string | null;
  onMessageEvent?: (event: RealtimeEvent<Message>) => void;
  onConversationEvent?: (event: RealtimeEvent<Conversation>) => void;
  enabled?: boolean;
}

/**
 * The handler `useRealtime` registers for `conversations`, built apart
 * from the hook so the account check can be exercised directly (there is
 * no DOM in this test setup to run the effect in).
 */
export function conversationPayloadHandler(
  accountId: string | null,
  emit: (event: RealtimeEvent<Conversation>) => void,
): (payload: {
  eventType: string;
  new: unknown;
  old: unknown;
}) => void {
  return (payload) => {
    // Belt 2 (see `account-scope.ts`). The subscription already asks the
    // server to filter, but a tab that opened before the support flag
    // changed, or a DELETE with no old `account_id`, must not get
    // through on the strength of RLS alone.
    if (!eventBelongsToAccount(payload.new, accountId)) return;
    emit({
      eventType: payload.eventType as RealtimeEvent<Conversation>["eventType"],
      new: payload.new as Conversation,
      old: payload.old as Partial<Conversation>,
    });
  };
}

export function useRealtime({
  channelName,
  accountId,
  onMessageEvent,
  onConversationEvent,
  enabled = true,
}: UseRealtimeOptions) {
  const channelRef = useRef<RealtimeChannel | null>(null);
  const [isConnected, setIsConnected] = useState(false);

  // Store latest callbacks in refs to avoid re-subscribing when the
  // parent re-renders with fresh closures. Assigned inside an effect
  // so the mutation doesn't happen during render (React 19's refs
  // rule) — subscribers only read `.current` inside async Realtime
  // callbacks, which always run after the render that updates it.
  const onMessageRef = useRef(onMessageEvent);
  const onConversationRef = useRef(onConversationEvent);
  useEffect(() => {
    onMessageRef.current = onMessageEvent;
    onConversationRef.current = onConversationEvent;
  });

  useEffect(() => {
    // No account, nothing to listen to: an unscoped subscription is how
    // the operator's rows reached the customer's inbox.
    if (!enabled || !accountId) return;

    const supabase = createClient();

    const channel = supabase
      .channel(channelName)
      .on(
        "postgres_changes",
        // `messages` has no `account_id` column — it reaches the account
        // through `conversations` — so neither a server-side filter nor
        // a row check can scope it here. The consumer does it instead:
        // a message for a conversation the (account-filtered) list does
        // not know about goes to `hydrateConversation`, which reads the
        // row `.eq("account_id", accountId)` and finds nothing for
        // another company's conversation.
        { event: "*", schema: "public", table: "messages" },
        (payload) => {
          onMessageRef.current?.({
            eventType: payload.eventType as RealtimeEvent<Message>["eventType"],
            new: payload.new as Message,
            old: payload.old as Partial<Message>,
          });
        }
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `account_id=eq.${accountId}`,
        },
        conversationPayloadHandler(accountId, (event) => {
          onConversationRef.current?.(event);
        })
      )
      .subscribe((status) => {
        setIsConnected(status === "SUBSCRIBED");
      });

    channelRef.current = channel;

    return () => {
      supabase.removeChannel(channel);
      channelRef.current = null;
      setIsConnected(false);
    };
  }, [channelName, accountId, enabled]);

  const unsubscribe = useCallback(() => {
    if (channelRef.current) {
      const supabase = createClient();
      supabase.removeChannel(channelRef.current);
      channelRef.current = null;
      setIsConnected(false);
    }
  }, []);

  return { isConnected, unsubscribe };
}
