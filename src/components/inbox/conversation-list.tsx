'use client';

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import { createClient } from '@/lib/supabase/client';
import {
  CONVERSATION_SELECT,
  matchesContactFilters,
  normalizeConversations,
} from '@/lib/inbox/conversations';
import {
  deriveAttentionState,
  isUnattended,
  offersUnattendedFilter,
  type AttentionState,
} from '@/lib/inbox/attention';
import { AttentionBadge } from '@/components/inbox/attention-badge';
import { FreeWindowBadge } from '@/components/inbox/free-window-badge';
import { useAiAccountStatus } from '@/hooks/use-ai-account-status';
import { usePresence } from '@/hooks/use-presence';
import { useAuth } from '@/hooks/use-auth';
import { useBillingStatus } from '@/hooks/use-billing-status';
import { useMinuteClock } from '@/hooks/use-minute-clock';
import {
  freeWindowDateTimeOptions,
  freeWindowUntil,
} from '@/lib/inbox/free-window';
import { presenceLabel, type PresenceStatus } from '@/lib/presence';
import { cn } from '@/lib/utils';
import type { Conversation, ConversationStatus, Profile, Tag } from '@/types';
import { Search, ChevronDown, X } from 'lucide-react';
import { formatDistanceToNow } from 'date-fns';
import { useFormatter, useTranslations } from 'next-intl';
import {
  contactDisplayName,
  contactMatchesSearch,
} from '@/lib/contacts/display';
import { Input } from '@/components/ui/input';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { ScrollArea } from '@/components/ui/scroll-area';

interface ConversationListProps {
  activeConversationId: string | null;
  onSelect: (conversation: Conversation) => void;
  conversations: Conversation[];
  onConversationsLoaded: (conversations: Conversation[]) => void;
  /**
   * Increment to force the fetch effect below to refire. The parent
   * bumps this on realtime reconnect / tab visibility → visible so the
   * list catches up on any events sent while the WS was disconnected
   * or the tab was throttled. Optional so existing callers keep working.
   */
  resyncToken?: number;
}

const STATUS_COLORS: Record<ConversationStatus, string> = {
  open: 'bg-primary',
  pending: 'bg-amber-500',
  closed: 'bg-muted-foreground',
};

type InboxFilter = ConversationStatus | 'all' | 'unread' | 'unattended';

export function ConversationList({
  activeConversationId,
  onSelect,
  conversations,
  onConversationsLoaded,
  resyncToken = 0,
}: ConversationListProps) {
  const t = useTranslations('Inbox.conversationList');
  // Ventana gratis de punto de entrada (p11.6). Un solo reloj para toda
  // la lista, nunca uno por fila; y la insignia solo con `metaBilling`
  // conocido y `direct` (lo decide `freeWindowUntil`).
  const tFreeWindow = useTranslations('Inbox.freeWindow');
  const formatter = useFormatter();
  const clockNow = useMinuteClock();
  const metaBilling = useBillingStatus()?.metaBilling;
  // The account this list is showing. Normally the signed-in user's own;
  // the customer's during a support session. Every fetch below filters by
  // it — since migration 057, RLS answers a platform operator with both
  // companies' rows (see `useAuth`).
  const { accountId } = useAuth();

  const ALL_FILTER_OPTIONS: { label: string; value: InboxFilter }[] = useMemo(
    () => [
      { label: t('filterAll'), value: 'all' },
      { label: t('filterUnread'), value: 'unread' },
      // The one that turns the indicator into a tool: the queue nobody
      // is on (fase 1 §3).
      { label: t('filterUnattended'), value: 'unattended' },
      { label: t('filterOpen'), value: 'open' },
      { label: t('filterPending'), value: 'pending' },
      { label: t('filterClosed'), value: 'closed' },
    ],
    [t]
  );

  // Account-wide "the bot is answering inbound" flag. ONE request per
  // account, shared with the thread banner — nothing here is per
  // conversation. `null` while it's unknown (still in flight, or the
  // read failed); both the badge and the Unattended filter go through
  // `deriveAttentionState`, which decides nothing in that case rather
  // than flashing the alarm at every chat the bot is quietly handling.
  const aiStatus = useAiAccountStatus();

  // Presence for the assignee dot. Its own Realtime topic: the thread
  // pane on this same page also calls usePresence, and realtime-js
  // hands back the *existing* channel for a repeated topic (see the
  // hook's doc comment).
  const { getPresence, getRow, now } = usePresence(true, 'inbox-list');

  // Teammates, once — the list needs a name for `assigned_agent_id`,
  // which realtime UPDATE payloads never carry (no joins). Resolving
  // the name from this map rather than from an embedded join is what
  // lets a row flip to "Operator X" the instant the assignment event
  // lands. Same single query the thread pane already makes.
  //
  // It doubles as the account's head count (p8.2): the query filters by
  // `account_id` only — no role filter — and `account_role` lives on
  // `profiles` (one row per member, no memberships table), so its length
  // IS the team size. `null` = unknown (in flight, or the read failed):
  // the attention derivation then decides nothing, same as an unknown
  // AI flag, instead of flashing amber while it loads.
  const [profiles, setProfiles] = useState<Profile[] | null>(null);
  const teamSize = profiles?.length ?? null;

  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<InboxFilter>('all');

  // "Unattended" is a hand-off queue; a one-person account has nobody to
  // hand off to, so the chip goes (only once the size is KNOWN to be 1).
  const FILTER_OPTIONS = useMemo(
    () =>
      offersUnattendedFilter(teamSize)
        ? ALL_FILTER_OPTIONS
        : ALL_FILTER_OPTIONS.filter((o) => o.value !== 'unattended'),
    [ALL_FILTER_OPTIONS, teamSize]
  );
  // …and if it was the active filter, fall back to "all". Adjusted during
  // render (React's "storing information from previous renders" pattern)
  // rather than in an effect, so no frame renders the stale filter.
  if (filter === 'unattended' && !offersUnattendedFilter(teamSize)) {
    setFilter('all');
  }
  const [loading, setLoading] = useState(true);
  // Contact-based filters (issue #272). Tags use OR logic (a conversation
  // matches if its contact carries any selected tag), consistent with
  // Broadcast audience filtering. Company is an exact match on the field.
  const [tags, setTags] = useState<Tag[]>([]);
  const [selectedTagIds, setSelectedTagIds] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState<string | null>(null);

  // Keep the latest callback in a ref so the fetch effect below can
  // have a stable, empty-dep identity. Previously the fetch useCallback
  // depended on `onConversationsLoaded`, which depends on the parent's
  // `deepLinkConvId` — so every URL change (including one the parent
  // triggered via router.replace after a click) caused a fresh
  // conversations fetch. That extra refetch was the trigger for the
  // deep-link auto-select running a second time and wiping the active
  // thread's messages.
  // Mutation lives in an effect (not render) per React 19's refs rule;
  // the fetch runs once on mount so it's fine to read the slightly
  // older value — the very next render updates the ref for any
  // subsequent async completion.
  const onConversationsLoadedRef = useRef(onConversationsLoaded);
  useEffect(() => {
    onConversationsLoadedRef.current = onConversationsLoaded;
  });

  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;

    (async () => {
      const { data, error } = await supabase
        .from('conversations')
        .select(CONVERSATION_SELECT)
        .eq('account_id', accountId)
        .order('last_message_at', { ascending: false });

      if (cancelled) return;

      if (error) {
        // Supabase errors have non-enumerable properties — log fields explicitly
        console.error('Failed to fetch conversations:', {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        setLoading(false);
        return;
      }

      onConversationsLoadedRef.current(normalizeConversations(data ?? []));
      setLoading(false);
    })();

    return () => {
      cancelled = true;
    };
    // `resyncToken` is included so the parent can force a refetch when
    // the realtime channel reconnects or the tab regains focus — catches
    // up on any events sent while the WS was disconnected or throttled.
  }, [resyncToken, accountId]);

  // Tag definitions for the filter picker — loaded once so labels/colours
  // stay stable regardless of which conversations happen to be loaded.
  useEffect(() => {
    if (!accountId) return;
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from('tags')
        .select('*')
        .eq('account_id', accountId)
        .order('name');
      if (!cancelled && data) setTags(data as Tag[]);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  useEffect(() => {
    if (!accountId) return;
    // A new account (entering or leaving a support session) makes the
    // previous head count a lie: back to "unknown" until this account's
    // profiles land, so the attention rule decides nothing meanwhile.
    // One reset per account change, not a render loop.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProfiles(null);
    const supabase = createClient();
    let cancelled = false;
    (async () => {
      const { data, error } = await supabase
        .from('profiles')
        .select('*')
        .eq('account_id', accountId)
        .order('full_name');
      if (cancelled) return;
      if (error) {
        // Not fatal: without names the rows fall back to a generic
        // "Assigned" label, which still beats showing nothing. The team
        // size stays unknown (`null`), so no "Unattended" alarm either.
        console.error('Failed to fetch profiles:', error.message);
        return;
      }
      setProfiles((data as Profile[]) ?? []);
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId]);

  const profilesByUserId = useMemo(() => {
    const m = new Map<string, Profile>();
    for (const p of profiles ?? []) m.set(p.user_id, p);
    return m;
  }, [profiles]);

  // Company options are derived from the loaded conversations — there's no
  // separate companies table, and only companies with a live conversation
  // are worth offering as an inbox filter.
  const companies = useMemo(() => {
    const set = new Set<string>();
    for (const c of conversations) {
      const co = c.contact?.company?.trim();
      if (co) set.add(co);
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [conversations]);

  const tagsById = useMemo(() => {
    const m = new Map<string, Tag>();
    for (const t of tags) m.set(t.id, t);
    return m;
  }, [tags]);

  const filtered = useMemo(() => {
    let result = conversations;

    if (filter === 'unread') {
      result = result.filter((c) => c.unread_count > 0);
    } else if (filter === 'unattended') {
      // No operator AND no AI — handed-off threads nobody picked up
      // included, closed ones excluded (this is a work queue). Resolved
      // in memory over the rows already loaded, so it stays correct the
      // moment a realtime UPDATE reassigns one. Same guard as the
      // badge: with `aiStatus` or `teamSize` unknown nothing is decided,
      // and a one-person account has no such queue (p8.2).
      result = result.filter((c) => isUnattended(c, aiStatus, teamSize));
    } else if (filter !== 'all') {
      result = result.filter((c) => c.status === filter);
    }

    // Contact-based filters (tags via OR logic, exact company match).
    if (selectedTagIds.length > 0 || selectedCompany !== null) {
      result = result.filter((c) =>
        matchesContactFilters(c, {
          tagIds: selectedTagIds,
          company: selectedCompany,
        })
      );
    }

    if (search.trim()) {
      const q = search.toLowerCase();
      result = result.filter((c) => {
        const lastMsg = c.last_message_text?.toLowerCase() ?? '';
        // Nombre, teléfono y —desde fase 6 §5— nombre de usuario, con
        // arroba o sin ella.
        return contactMatchesSearch(c.contact, search) || lastMsg.includes(q);
      });
    }

    return result;
  }, [
    conversations,
    filter,
    search,
    selectedTagIds,
    selectedCompany,
    aiStatus,
    teamSize,
  ]);

  const toggleTag = useCallback((id: string) => {
    setSelectedTagIds((prev) =>
      prev.includes(id) ? prev.filter((t) => t !== id) : [...prev, id]
    );
  }, []);

  const clearContactFilters = useCallback(() => {
    setSelectedTagIds([]);
    setSelectedCompany(null);
  }, []);

  const hasContactFilters =
    selectedTagIds.length > 0 || selectedCompany !== null;

  const handleSearchChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      setSearch(e.target.value);
    },
    []
  );

  const handleSelect = useCallback(
    (conv: Conversation) => {
      onSelect(conv);
    },
    [onSelect]
  );

  const activeFilter = FILTER_OPTIONS.find((o) => o.value === filter);

  // Textos de la insignia de ventana gratis de una fila, o nada. Con el
  // reloj del minuto: cuando pasa `free_window_until`, la insignia se va
  // sola en menos de 60 s (R20).
  const freeWindowTexts = (
    conv: Conversation
  ): { freeWindowLabel?: string; freeWindowTitle?: string } => {
    const until = freeWindowUntil(conv, clockNow, metaBilling);
    if (!until) return {};
    const formatted = formatter.dateTime(until, freeWindowDateTimeOptions());
    return {
      freeWindowLabel: tFreeWindow('badge', { until: formatted }),
      freeWindowTitle: tFreeWindow('tooltip', { until: formatted }),
    };
  };

  return (
    // w-full on mobile so the list occupies the whole viewport when it's
    // the single pane showing; fixed 320px on desktop where it shares the
    // row with the thread + contact sidebar.
    <div className="border-border bg-card flex h-full w-full flex-col border-r lg:w-80">
      {/* Search + Filter */}
      <div className="border-border space-y-2 border-b p-3">
        <div className="relative">
          <Search className="text-muted-foreground absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2" />
          <Input
            value={search}
            onChange={handleSearchChange}
            placeholder={t('searchPlaceholder')}
            className="border-border bg-muted text-foreground placeholder-muted-foreground focus:border-primary/50 pl-9 text-sm"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1">
          <DropdownMenu>
            <DropdownMenuTrigger className="text-muted-foreground hover:text-foreground hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs">
              {activeFilter?.label ?? t('filterAll')}
              <ChevronDown className="h-3 w-3" />
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="border-border bg-popover"
            >
              {FILTER_OPTIONS.map((opt) => (
                <DropdownMenuItem
                  key={opt.value}
                  onClick={() => setFilter(opt.value)}
                  className={cn(
                    'text-sm',
                    filter === opt.value
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {opt.label}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>

          {tags.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedTagIds.length > 0
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('tags')}
                {selectedTagIds.length > 0 && (
                  <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                    {selectedTagIds.length}
                  </span>
                )}
                <ChevronDown className="h-3 w-3" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                {tags.map((t) => (
                  <DropdownMenuCheckboxItem
                    key={t.id}
                    checked={selectedTagIds.includes(t.id)}
                    onCheckedChange={() => toggleTag(t.id)}
                    className="text-popover-foreground text-sm"
                  >
                    <span className="flex items-center gap-2">
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ backgroundColor: t.color }}
                      />
                      <span className="truncate">{t.name}</span>
                    </span>
                  </DropdownMenuCheckboxItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          {companies.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                className={cn(
                  'hover:bg-muted inline-flex h-7 max-w-40 items-center justify-center gap-1 rounded-md px-2 text-xs',
                  selectedCompany
                    ? 'text-primary'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                <span className="truncate">
                  {selectedCompany ?? t('company')}
                </span>
                <ChevronDown className="h-3 w-3 shrink-0" />
              </DropdownMenuTrigger>
              <DropdownMenuContent
                align="start"
                className="border-border bg-popover max-h-64 w-56"
              >
                <DropdownMenuItem
                  onClick={() => setSelectedCompany(null)}
                  className={cn(
                    'text-sm',
                    selectedCompany === null
                      ? 'text-primary'
                      : 'text-popover-foreground'
                  )}
                >
                  {t('allCompanies')}
                </DropdownMenuItem>
                {companies.map((co) => (
                  <DropdownMenuItem
                    key={co}
                    onClick={() => setSelectedCompany(co)}
                    className={cn(
                      'text-sm',
                      selectedCompany === co
                        ? 'text-primary'
                        : 'text-popover-foreground'
                    )}
                  >
                    <span className="truncate">{co}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>

        {hasContactFilters && (
          <div className="flex flex-wrap items-center gap-1">
            {selectedTagIds.map((id) => {
              const tag = tagsById.get(id);
              return (
                <button
                  key={id}
                  onClick={() => toggleTag(id)}
                  className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
                >
                  <span
                    className="h-1.5 w-1.5 shrink-0 rounded-full"
                    style={{
                      backgroundColor: tag?.color ?? 'var(--muted-foreground)',
                    }}
                  />
                  <span className="max-w-24 truncate">
                    {tag?.name ?? t('tags')}
                  </span>
                  <X className="h-3 w-3" />
                </button>
              );
            })}
            {selectedCompany && (
              <button
                onClick={() => setSelectedCompany(null)}
                className="bg-muted text-foreground hover:bg-muted/70 inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px]"
              >
                <span className="max-w-24 truncate">{selectedCompany}</span>
                <X className="h-3 w-3" />
              </button>
            )}
            <button
              onClick={clearContactFilters}
              className="text-muted-foreground hover:text-foreground px-1 text-[11px]"
            >
              {t('clearAll')}
            </button>
          </div>
        )}
      </div>

      {/* Conversation Items.
          `min-h-0` is load-bearing: a flex child defaults to
          min-height:auto, so without it this ScrollArea grows to fit
          every conversation instead of shrinking to the remaining
          space — the list then overflows and gets clipped by the
          parent's overflow-hidden with no scrollbar (issue #229). */}
      <ScrollArea className="min-h-0 flex-1">
        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="border-primary h-5 w-5 animate-spin rounded-full border-2 border-t-transparent" />
          </div>
        ) : filtered.length === 0 ? (
          <div className="px-4 py-12 text-center">
            <p className="text-muted-foreground text-sm">
              {t('noConversations')}
            </p>
          </div>
        ) : (
          <div className="flex flex-col">
            {filtered.map((conv) => {
              // Everything the badge needs is already in hand: the row
              // itself, the account flag, and the two account-wide maps
              // (teammates + presence). No query per conversation.
              const assigneeId = conv.assigned_agent_id ?? null;
              // `null` = nothing to show: the account flag hasn't landed
              // (an assignee is knowable without it, the AI/unattended
              // split isn't), the thread is closed and out of the queue,
              // or the account is one person with nobody to hand off to
              // (or its size isn't known yet). Same call the Unattended
              // filter makes.
              const state = deriveAttentionState(conv, aiStatus, teamSize);
              const presence: PresenceStatus | undefined = assigneeId
                ? getPresence(assigneeId)
                : undefined;
              return (
                <ConversationItem
                  key={conv.id}
                  conversation={conv}
                  isActive={conv.id === activeConversationId}
                  onSelect={handleSelect}
                  attention={state}
                  attentionLabel={
                    state === 'ai'
                      ? t('attentionAi')
                      : state === 'assigned'
                        ? profilesByUserId.get(assigneeId ?? '')?.full_name ||
                          t('attentionAssigned')
                        : t('attentionUnattended')
                  }
                  presence={presence}
                  presenceTitle={
                    presence && assigneeId
                      ? presenceLabel(
                          presence,
                          getRow(assigneeId)?.last_seen_at ?? null,
                          now
                        )
                      : undefined
                  }
                  {...freeWindowTexts(conv)}
                  t={t}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}

interface ConversationItemProps {
  conversation: Conversation;
  isActive: boolean;
  onSelect: (conversation: Conversation) => void;
  /** Who is attending this thread — see `lib/inbox/attention`.
   *  `null` while the account's AI status is still unknown. */
  attention: AttentionState | null;
  /** Translated text for the badge (operator name when assigned). */
  attentionLabel: string;
  presence?: PresenceStatus;
  presenceTitle?: string;
  /** «Ventana gratis hasta …» (p11.6); ausente = sin insignia. */
  freeWindowLabel?: string;
  freeWindowTitle?: string;
  t: ReturnType<typeof useTranslations>;
}

function ConversationItem({
  conversation,
  isActive,
  onSelect,
  attention,
  attentionLabel,
  presence,
  presenceTitle,
  freeWindowLabel,
  freeWindowTitle,
  t,
}: ConversationItemProps) {
  const contact = conversation.contact;
  const displayName = contactDisplayName(contact, t('unknown'));
  const initials = displayName.charAt(0).toUpperCase();

  const handleClick = useCallback(() => {
    onSelect(conversation);
  }, [onSelect, conversation]);

  const timeAgo = conversation.last_message_at
    ? formatDistanceToNow(new Date(conversation.last_message_at), {
        addSuffix: false,
      })
    : '';

  return (
    <button
      onClick={handleClick}
      className={cn(
        'hover:bg-muted/50 flex w-full items-start gap-3 px-3 py-3 text-left transition-colors',
        isActive && 'border-primary bg-muted/70 border-l-2'
      )}
    >
      {/* Avatar */}
      <div className="bg-muted text-foreground flex h-10 w-10 shrink-0 items-center justify-center rounded-full text-sm font-medium">
        {contact?.avatar_url ? (
          <img
            src={contact.avatar_url}
            alt={displayName}
            className="h-10 w-10 rounded-full object-cover"
          />
        ) : (
          initials
        )}
      </div>

      {/* Content */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <span className="text-foreground truncate text-sm font-medium">
            {displayName}
          </span>
          <span className="text-muted-foreground shrink-0 text-[10px]">
            {timeAgo}
          </span>
        </div>
        <div className="mt-0.5 flex items-center justify-between gap-2">
          <p className="text-muted-foreground truncate text-xs">
            {conversation.last_message_text || t('noMessagesYet')}
          </p>
          <div className="flex shrink-0 items-center gap-1.5">
            {conversation.unread_count > 0 && (
              <span className="bg-primary text-primary-foreground flex h-4 min-w-4 items-center justify-center rounded-full px-1 text-[10px] font-bold">
                {conversation.unread_count}
              </span>
            )}
            <span
              className={cn(
                'h-2 w-2 rounded-full',
                STATUS_COLORS[conversation.status]
              )}
              title={conversation.status}
            />
          </div>
        </div>
        {/* Who is attending. Its own line so the operator's name isn't
            fighting the message preview for the 320px the list gets. */}
        {(attention || freeWindowLabel) && (
          <div className="mt-1 flex min-w-0 items-center gap-2">
            {attention && (
              <AttentionBadge
                state={attention}
                label={attentionLabel}
                presence={presence}
                presenceTitle={presenceTitle}
              />
            )}
            {freeWindowLabel && (
              <FreeWindowBadge
                label={freeWindowLabel}
                title={freeWindowTitle ?? freeWindowLabel}
              />
            )}
          </div>
        )}
      </div>
    </button>
  );
}
