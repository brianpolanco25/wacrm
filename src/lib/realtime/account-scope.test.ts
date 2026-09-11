import { describe, expect, it } from 'vitest';

import { eventBelongsToAccount } from './account-scope';
import { conversationPayloadHandler } from '@/hooks/use-realtime';
import { applyUnreadEvent } from '@/hooks/use-total-unread';
import { applyNotificationEvent } from '@/hooks/use-unread-notifications';
import { effectiveAccountId } from '@/hooks/use-auth';

// ============================================================
// Realtime during a support session.
//
// `select()` is not the only way this panel reads from Supabase in the
// browser: `postgres_changes` subscriptions are the other one, and until
// this round every one of them relied on RLS to decide which rows it was
// allowed to hear about. Migration 057 ended that — an operator with an
// open support session passes the SELECT policy for their OWN company
// too — so the replication stream handed the operator's rows to a tab
// that was showing the customer's: a conversation of the operator's
// company dropped into the customer's inbox live, and the unread badge
// counted both companies.
//
// These are the handlers, lifted out of their hooks so the discard can
// be exercised without a DOM (this repo runs vitest in `node`, and adds
// no dependency to change that). The subscriptions themselves also ask
// the server to filter by account; that half is pinned by the static
// audit in `src/lib/security/support-session-view.test.ts`.
// ============================================================

/** The operator's own company. */
const OPERATOR_ACCOUNT = 'aaaaaaaa-0000-4000-8000-00000000000a';
/** Account T, the customer being supported. */
const CUSTOMER_ACCOUNT = 'bbbbbbbb-0000-4000-8000-00000000000b';

/** What the tab is showing while the session over T is open. */
const SHOWING = effectiveAccountId(OPERATOR_ACCOUNT, CUSTOMER_ACCOUNT);

function conversationRow(accountId: string, id: string, unread = 1) {
  return {
    id,
    account_id: accountId,
    unread_count: unread,
    last_message_text: 'hola',
  };
}

describe('eventBelongsToAccount', () => {
  it('accepts a row of the account the tab is showing', () => {
    expect(
      eventBelongsToAccount(conversationRow(CUSTOMER_ACCOUNT, 'c1'), SHOWING)
    ).toBe(true);
  });

  it("rejects a row of the operator's own company", () => {
    expect(
      eventBelongsToAccount(conversationRow(OPERATOR_ACCOUNT, 'o1'), SHOWING)
    ).toBe(false);
  });

  it('fails closed with no account to compare against', () => {
    // `accountId` is null while the profile loads, and also when the
    // support flag is present but names no account. Letting rows
    // through there is the mislabelled view again.
    expect(
      eventBelongsToAccount(conversationRow(CUSTOMER_ACCOUNT, 'c1'), null)
    ).toBe(false);
  });

  it('fails closed on a payload that carries no account at all', () => {
    // A DELETE on a table without REPLICA IDENTITY FULL: the old record
    // is just the primary key.
    expect(eventBelongsToAccount({ id: 'c1' }, SHOWING)).toBe(false);
    expect(eventBelongsToAccount({}, SHOWING)).toBe(false);
    expect(eventBelongsToAccount(null, SHOWING)).toBe(false);
    expect(eventBelongsToAccount('c1', SHOWING)).toBe(false);
  });
});

describe("the inbox list during a session over the customer's account", () => {
  /** Collects what the hook would hand to the page's handler. */
  function listenedConversations(
    accountId: string | null,
    payloads: { eventType: string; new: unknown; old: unknown }[]
  ): string[] {
    const list: string[] = [];
    const handler = conversationPayloadHandler(accountId, (event) => {
      list.push(event.new.id);
    });
    for (const p of payloads) handler(p);
    return list;
  }

  it("does not move for a conversation of the operator's own company", () => {
    // The exact scenario the reviewer described: a message arrives at
    // the operator's company while they are supporting T. Before this
    // round the row was prepended to the customer's inbox, live.
    expect(
      listenedConversations(SHOWING, [
        {
          eventType: 'INSERT',
          new: conversationRow(OPERATOR_ACCOUNT, 'mine-1'),
          old: {},
        },
        {
          eventType: 'UPDATE',
          new: conversationRow(OPERATOR_ACCOUNT, 'mine-2'),
          old: {},
        },
      ])
    ).toEqual([]);
  });

  it("still moves for the customer's own conversations", () => {
    // Guards the test above from passing by simply dropping everything.
    expect(
      listenedConversations(SHOWING, [
        {
          eventType: 'INSERT',
          new: conversationRow(CUSTOMER_ACCOUNT, 'theirs-1'),
          old: {},
        },
      ])
    ).toEqual(['theirs-1']);
  });

  it('listens to nothing while the effective account is unknown', () => {
    expect(
      listenedConversations(null, [
        {
          eventType: 'INSERT',
          new: conversationRow(CUSTOMER_ACCOUNT, 'theirs-1'),
          old: {},
        },
      ])
    ).toEqual([]);
  });

  it("goes back to the operator's own conversations after the session", () => {
    const own = effectiveAccountId(OPERATOR_ACCOUNT, null);
    expect(
      listenedConversations(own, [
        {
          eventType: 'INSERT',
          new: conversationRow(OPERATOR_ACCOUNT, 'mine-1'),
          old: {},
        },
        {
          eventType: 'INSERT',
          new: conversationRow(CUSTOMER_ACCOUNT, 'theirs-1'),
          old: {},
        },
      ])
    ).toEqual(['mine-1']);
  });
});

describe('the unread conversations badge during that session', () => {
  it("does not count the operator's own unread conversation", () => {
    // Seeded with one unread conversation of the customer's: the badge
    // says 1 and has to keep saying 1.
    const counts = new Map([['theirs-1', 1]]);
    const next = applyUnreadEvent(counts, SHOWING, {
      eventType: 'INSERT',
      new: conversationRow(OPERATOR_ACCOUNT, 'mine-1', 3),
      old: {},
    });
    expect(next).toBeNull(); // nothing to re-render
    expect([...counts.keys()]).toEqual(['theirs-1']);
  });

  it("counts the customer's, so the badge is not simply frozen", () => {
    const counts = new Map([['theirs-1', 1]]);
    expect(
      applyUnreadEvent(counts, SHOWING, {
        eventType: 'INSERT',
        new: conversationRow(CUSTOMER_ACCOUNT, 'theirs-2', 2),
        old: {},
      })
    ).toBe(2);
  });

  it('ignores a DELETE for a conversation it never counted', () => {
    // `conversations` is not REPLICA IDENTITY FULL, so the old record is
    // only the primary key — there is no account on it to check. The map
    // only ever holds this account's rows, so an unknown id is another
    // company's and drops out by not matching.
    const counts = new Map([['theirs-1', 1]]);
    expect(
      applyUnreadEvent(counts, SHOWING, {
        eventType: 'DELETE',
        new: {},
        old: { id: 'mine-1' },
      })
    ).toBeNull();
    expect(counts.size).toBe(1);
  });

  it("applies a DELETE of the customer's own conversation", () => {
    const counts = new Map([
      ['theirs-1', 1],
      ['theirs-2', 1],
    ]);
    expect(
      applyUnreadEvent(counts, SHOWING, {
        eventType: 'DELETE',
        new: {},
        old: { id: 'theirs-1' },
      })
    ).toBe(1);
  });
});

describe('the notifications badge during that session', () => {
  function notification(accountId: string, readAt: string | null) {
    return {
      id: 'n1',
      account_id: accountId,
      user_id: 'operator-user',
      read_at: readAt,
    };
  }

  it("does not rise for the operator's own notification", () => {
    // RLS on `notifications` is `auth.uid() = user_id` — during a
    // support session that is the operator, so their own assignments
    // stream in regardless of 057. The badge used to say 1 while
    // /notifications, filtered by account, showed nothing.
    expect(
      applyNotificationEvent(0, SHOWING, {
        eventType: 'INSERT',
        new: notification(OPERATOR_ACCOUNT, null),
        old: {},
      })
    ).toBe(0);
  });

  it("rises for the customer's", () => {
    expect(
      applyNotificationEvent(0, SHOWING, {
        eventType: 'INSERT',
        new: notification(CUSTOMER_ACCOUNT, null),
        old: {},
      })
    ).toBe(1);
  });

  it('does not fall when the operator reads one of their own', () => {
    expect(
      applyNotificationEvent(1, SHOWING, {
        eventType: 'UPDATE',
        new: notification(OPERATOR_ACCOUNT, '2026-01-01T00:00:00Z'),
        old: {},
      })
    ).toBe(1);
  });

  it("falls when the customer's is marked read", () => {
    expect(
      applyNotificationEvent(1, SHOWING, {
        eventType: 'UPDATE',
        new: notification(CUSTOMER_ACCOUNT, '2026-01-01T00:00:00Z'),
        old: {},
      })
    ).toBe(0);
  });

  it("ignores a DELETE of the operator's own unread notification", () => {
    // `notifications` IS replica identity full (migration 027), so the
    // old record names its account and can be checked.
    expect(
      applyNotificationEvent(1, SHOWING, {
        eventType: 'DELETE',
        new: {},
        old: notification(OPERATOR_ACCOUNT, null),
      })
    ).toBe(1);
  });

  it("applies a DELETE of the customer's unread notification", () => {
    expect(
      applyNotificationEvent(1, SHOWING, {
        eventType: 'DELETE',
        new: {},
        old: notification(CUSTOMER_ACCOUNT, null),
      })
    ).toBe(0);
  });

  it('never goes negative', () => {
    expect(
      applyNotificationEvent(0, SHOWING, {
        eventType: 'UPDATE',
        new: notification(CUSTOMER_ACCOUNT, '2026-01-01T00:00:00Z'),
        old: {},
      })
    ).toBe(0);
  });
});
