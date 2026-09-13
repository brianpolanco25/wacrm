import { Sparkles, CircleAlert } from 'lucide-react';

import { cn } from '@/lib/utils';
import { PresenceDot } from '@/components/presence/presence-dot';
import type { PresenceStatus } from '@/lib/presence';
import type { AttentionState } from '@/lib/inbox/attention';

interface AttentionBadgeProps {
  state: AttentionState;
  /** Already-translated text: "AI replying", the operator's name, … */
  label: string;
  /** Only read for `state === "assigned"` — the assignee's presence. */
  presence?: PresenceStatus;
  /** Tooltip for the presence dot ("Offline — last seen 2 hours ago"). */
  presenceTitle?: string;
  className?: string;
}

/**
 * Who is attending a conversation, one line per row in the inbox list
 * (fase 1 §3). The three states have to be told apart at a glance
 * without opening the chat, so each carries its own mark AND its own
 * colour — never colour alone:
 *
 *   - `ai`         → sparkles, accent colour
 *   - `assigned`   → the operator's presence dot + their name
 *   - `unattended` → alert circle, amber
 *
 * `data-attention` is the stable hook the tests assert on (and a handy
 * one for debugging a row in the browser).
 */
export function AttentionBadge({
  state,
  label,
  presence = 'offline',
  presenceTitle,
  className,
}: AttentionBadgeProps) {
  return (
    <span
      data-attention={state}
      title={state === 'assigned' ? presenceTitle : label}
      className={cn(
        'inline-flex min-w-0 items-center gap-1 text-[11px] leading-4',
        state === 'ai' && 'text-primary',
        state === 'assigned' && 'text-muted-foreground',
        state === 'unattended' && 'text-amber-600 dark:text-amber-400',
        className
      )}
    >
      {state === 'ai' && <Sparkles className="h-3 w-3 shrink-0" />}
      {state === 'assigned' && (
        <PresenceDot status={presence} className="size-1.5" />
      )}
      {state === 'unattended' && <CircleAlert className="h-3 w-3 shrink-0" />}
      <span className="truncate">{label}</span>
    </span>
  );
}
