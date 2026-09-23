import { describe, it, expect, vi, beforeEach } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import type { Conversation, Profile } from '@/types';

/**
 * p8.2: in a one-person account the list shows neither the amber
 * "Nobody on it" badge nor the "Unattended" filter chip; a team of two
 * sees both, as before.
 *
 * No jsdom / testing-library in this repo (and no new deps), so the list
 * is rendered to static markup, where effects never run: the profiles
 * and conversations it would fetch are injected through a thin
 * `useState` shim instead — the first `null`-initialised state of each
 * render pass is `profiles`, `loading` starts done, and the filter can
 * start on a chosen value. The positive case (two members → badge and
 * chip present) is what proves the shim is wired: if the state order
 * changed, it would fail rather than pass vacuously.
 */

const shim = vi.hoisted(() => ({
  profiles: null as unknown,
  initialFilter: 'all' as string,
  nullSeen: 0,
}));

vi.mock('react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react')>();
  const useState = ((init: unknown) => {
    if (init === null && shim.nullSeen++ === 0) {
      return actual.useState(shim.profiles);
    }
    if (init === true) return actual.useState(false); // `loading`
    if (init === 'all') return actual.useState(shim.initialFilter);
    return actual.useState(init);
  }) as typeof actual.useState;
  return { ...actual, default: { ...actual, useState }, useState };
});

vi.mock('next-intl', () => ({
  // Keys come back verbatim, so the markup can be searched for them.
  // Called once at the top of every render pass of the list: resets the
  // shim's counter.
  useTranslations: () => {
    shim.nullSeen = 0;
    return (key: string) => key;
  },
}));

vi.mock('@/hooks/use-auth', () => ({
  useAuth: () => ({ accountId: 'acc-1' }),
}));
vi.mock('@/hooks/use-presence', () => ({
  usePresence: () => ({
    getPresence: () => undefined,
    getRow: () => undefined,
    now: 0,
  }),
}));
// The account's bot is off: every unassigned open chat is a candidate
// for the alarm — the exact situation that prompted p8.2.
vi.mock('@/hooks/use-ai-account-status', () => ({
  useAiAccountStatus: () => false,
}));
vi.mock('@/lib/supabase/client', () => ({
  createClient: () => {
    throw new Error('no fetch during a static render');
  },
}));
// Base UI renders a closed menu's items nowhere; flatten it so the
// options are in the markup.
vi.mock('@/components/ui/dropdown-menu', () => {
  const Pass = ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  );
  return {
    DropdownMenu: Pass,
    DropdownMenuTrigger: Pass,
    DropdownMenuContent: Pass,
    DropdownMenuItem: ({ children }: { children?: React.ReactNode }) => (
      <div data-filter-option>{children}</div>
    ),
    DropdownMenuCheckboxItem: Pass,
  };
});
vi.mock('@/components/ui/scroll-area', () => ({
  ScrollArea: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
}));

import { ConversationList } from './conversation-list';

function profile(userId: string): Profile {
  return {
    id: userId,
    user_id: userId,
    full_name: userId,
  } as Profile;
}

const conversations: Conversation[] = [
  {
    id: 'c1',
    user_id: 'u1',
    contact_id: 'ct1',
    status: 'open',
    unread_count: 0,
    created_at: '',
    updated_at: '',
    ai_autoreply_disabled: true,
    contact: { id: 'ct1', name: 'Cliente Uno' } as Conversation['contact'],
  },
];

function render(profiles: Profile[] | null, initialFilter = 'all'): string {
  shim.profiles = profiles;
  shim.initialFilter = initialFilter;
  return renderToStaticMarkup(
    <ConversationList
      activeConversationId={null}
      onSelect={() => {}}
      conversations={conversations}
      onConversationsLoaded={() => {}}
    />
  );
}

describe('ConversationList and the team size (p8.2)', () => {
  beforeEach(() => {
    shim.nullSeen = 0;
  });

  it('shows the badge and the chip to a team of two', () => {
    const html = render([profile('u1'), profile('u2')]);
    expect(html).toContain('attentionUnattended');
    expect(html).toContain('filterUnattended');
    expect(html).toContain('data-attention="unattended"');
  });

  it('shows neither to a one-person account', () => {
    const html = render([profile('u1')]);
    expect(html).not.toContain('attentionUnattended');
    expect(html).not.toContain('data-attention="unattended"');
    expect(html).not.toContain('filterUnattended');
    // The row itself is still listed.
    expect(html).toContain('Cliente Uno');
  });

  it('shows no badge while the team size is unknown, but keeps the chip', () => {
    const html = render(null);
    expect(html).not.toContain('attentionUnattended');
    expect(html).toContain('filterUnattended');
  });

  it('falls back to "all" when "unattended" was active and the chip goes', () => {
    const html = render([profile('u1')], 'unattended');
    // Filter reset: the chat is listed instead of an empty queue.
    expect(html).toContain('Cliente Uno');
    expect(html).not.toContain('noConversations');
    expect(html).not.toContain('filterUnattended');
  });

  it('keeps the "unattended" queue for a team', () => {
    const html = render([profile('u1'), profile('u2')], 'unattended');
    expect(html).toContain('Cliente Uno');
    expect(html).toContain('data-attention="unattended"');
  });
});
