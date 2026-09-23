import { describe, it, expect } from 'vitest';
import {
  deriveAttentionState,
  isUnattended,
  offersUnattendedFilter,
} from './attention';
import type { Conversation } from '@/types';

// A team of two: the size at which every rule of f1.3 applies unchanged.
// The one-person account and the unknown size have their own block.
const TEAM = 2;

function conv(patch: Partial<Conversation> = {}): Conversation {
  return {
    id: 'c1',
    user_id: 'u1',
    contact_id: 'ct1',
    status: 'open',
    unread_count: 0,
    created_at: '',
    updated_at: '',
    ...patch,
  };
}

describe('deriveAttentionState', () => {
  it("reads a thread the bot is handling as 'ai'", () => {
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: false }), true, TEAM)
    ).toBe('ai');
  });

  it('treats a missing ai_autoreply_disabled as not paused', () => {
    // Rows written before migration 029 (and realtime payloads that
    // omit the column) must still read as "the bot has this one".
    expect(deriveAttentionState(conv(), true, TEAM)).toBe('ai');
  });

  it("reads an assigned thread as 'assigned'", () => {
    expect(
      deriveAttentionState(
        conv({ assigned_agent_id: 'agent-1', ai_autoreply_disabled: true }),
        true,
        TEAM
      )
    ).toBe('assigned');
  });

  it("puts the human first even if the pause flag hasn't landed yet", () => {
    // Assignment and the pause write are two separate updates; between
    // them the row is assigned but not paused. "Operator X" is the
    // state the team must see, not "AI".
    expect(
      deriveAttentionState(
        conv({ assigned_agent_id: 'agent-1', ai_autoreply_disabled: false }),
        true,
        TEAM
      )
    ).toBe('assigned');
  });

  it("reads a handed-off thread nobody picked up as 'unattended'", () => {
    // The case that dies in silence: the bot stopped, no human took it.
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: true }), true, TEAM)
    ).toBe('unattended');
  });

  it("never returns 'ai' when the account has auto-reply off", () => {
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: false }), false, TEAM)
    ).toBe('unattended');
    expect(deriveAttentionState(conv(), false, TEAM)).toBe('unattended');
  });

  it('still shows the assignee when the account has auto-reply off', () => {
    expect(
      deriveAttentionState(conv({ assigned_agent_id: 'agent-1' }), false, TEAM)
    ).toBe('assigned');
  });
});

describe("when the account's AI status is unknown (null)", () => {
  // `/api/ai/config` still in flight, or it failed (a 401 mid token
  // refresh, an offline blip). Guessing "off" would paint the amber
  // alarm on every chat the bot is quietly handling, for the whole life
  // of the mount. The guard lives in the derivation so the badge and
  // the filter cannot disagree.
  it('decides nothing for an unassigned thread', () => {
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: false }), null, TEAM)
    ).toBe(null);
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: true }), null, TEAM)
    ).toBe(null);
  });

  it('never reports "unattended" on a failed or pending read', () => {
    // The regression the review caught: unknown must not be readable as
    // "the account has no bot".
    const rows = [
      conv({ id: 'idle', ai_autoreply_disabled: false }),
      conv({ id: 'handed-off', ai_autoreply_disabled: true }),
    ];
    expect(rows.some((c) => isUnattended(c, null, TEAM))).toBe(false);
  });

  it('still names the assignee — a human is knowable without the flag', () => {
    expect(
      deriveAttentionState(conv({ assigned_agent_id: 'agent-1' }), null, TEAM)
    ).toBe('assigned');
  });
});

describe('closed threads', () => {
  // "Unattended" is a work queue, not a history listing: an account
  // with the assistant off and 800 closed chats would otherwise light
  // up its entire archive in amber and drown the filter.
  it('gets no alarm when nobody is on a closed thread', () => {
    expect(
      deriveAttentionState(
        conv({ status: 'closed', ai_autoreply_disabled: true }),
        true,
        TEAM
      )
    ).toBe(null);
    expect(
      deriveAttentionState(
        conv({ status: 'closed', ai_autoreply_disabled: false }),
        false,
        TEAM
      )
    ).toBe(null);
  });

  it('still shows who owns a closed thread', () => {
    expect(
      deriveAttentionState(
        conv({ status: 'closed', assigned_agent_id: 'agent-1' }),
        false,
        TEAM
      )
    ).toBe('assigned');
  });

  it('keeps the alarm on the open and pending ones', () => {
    for (const status of ['open', 'pending'] as const) {
      expect(
        deriveAttentionState(
          conv({ status, ai_autoreply_disabled: true }),
          true,
          TEAM
        )
      ).toBe('unattended');
    }
  });
});

describe('the realtime UPDATE over `conversations`', () => {
  // The inbox page merges the payload of every conversation UPDATE
  // into the row it already holds (`{ ...c, ...conv }`, page.tsx), and
  // the badge is derived at render — so an assignment made from the
  // thread by ANOTHER member repaints the row without a refetch. These
  // pin that the derivation reacts to the merged row; the end-to-end
  // path over the socket is verified by hand (see the impl report).
  const before = conv({ id: 'c1', ai_autoreply_disabled: false });

  it("flips a row to 'assigned' when the payload brings an assignee", () => {
    const payload: Partial<Conversation> = {
      assigned_agent_id: 'agent-2',
      ai_autoreply_disabled: true,
    };
    expect(deriveAttentionState({ ...before, ...payload }, true, TEAM)).toBe(
      'assigned'
    );
  });

  it("flips a row back to 'unattended' when the assignee is dropped", () => {
    // Realtime sends the whole row, so "unassigned" arrives as an
    // explicit undefined/null — not as an absent key.
    const assigned = conv({ assigned_agent_id: 'agent-2' });
    const payload = {
      assigned_agent_id: undefined,
      ai_autoreply_disabled: true,
    };
    expect(deriveAttentionState({ ...assigned, ...payload }, true, TEAM)).toBe(
      'unattended'
    );
  });
});

describe('isUnattended (the header filter)', () => {
  const rows = [
    conv({ id: 'ai', ai_autoreply_disabled: false }),
    conv({ id: 'assigned', assigned_agent_id: 'agent-1' }),
    conv({ id: 'handed-off', ai_autoreply_disabled: true }),
    conv({
      id: 'assigned-and-paused',
      assigned_agent_id: 'agent-1',
      ai_autoreply_disabled: true,
    }),
    conv({
      id: 'closed-and-handed-off',
      status: 'closed',
      ai_autoreply_disabled: true,
    }),
  ];

  it('returns the chats with no operator AND no AI, handed-off included', () => {
    expect(
      rows.filter((c) => isUnattended(c, true, TEAM)).map((c) => c.id)
    ).toEqual(['handed-off']);
  });

  it("returns every unassigned chat once the account's AI is off", () => {
    expect(
      rows.filter((c) => isUnattended(c, false, TEAM)).map((c) => c.id)
    ).toEqual(['ai', 'handed-off']);
  });

  it('never returns a closed chat — the queue is not the archive', () => {
    for (const accountAiOn of [true, false, null]) {
      expect(
        rows.filter((c) => isUnattended(c, accountAiOn, TEAM)).map((c) => c.id)
      ).not.toContain('closed-and-handed-off');
    }
  });

  it("returns nothing while the account's AI status is unknown", () => {
    // Same guard as the badge: with `aiStatus === null` the filter
    // must not list the chats the bot is handling, badge-less, only to
    // make them vanish 200 ms later.
    expect(rows.filter((c) => isUnattended(c, null, TEAM))).toEqual([]);
  });
});

describe('team size (p8.2: silence the alarm in a one-person account)', () => {
  // In a one-member account there is nobody to hand a chat to: every
  // unassigned chat is that person's, so "Nobody is on it" on all of
  // them is noise. Teams of 2+ keep f1.3 as it was. Unknown size
  // (profiles in flight, or the read failed) decides nothing — the
  // same criterion as an unknown AI flag, so no amber flash on load.
  const handedOff = conv({ ai_autoreply_disabled: true });
  const idle = conv({ ai_autoreply_disabled: false });

  it("is 'unattended' only from two members up", () => {
    expect(deriveAttentionState(handedOff, true, 2)).toBe('unattended');
    expect(deriveAttentionState(idle, false, 2)).toBe('unattended');
    expect(deriveAttentionState(handedOff, true, 5)).toBe('unattended');
  });

  it('decides nothing for a one-person account', () => {
    expect(deriveAttentionState(handedOff, true, 1)).toBe(null);
    expect(deriveAttentionState(idle, false, 1)).toBe(null);
    expect(deriveAttentionState(conv(), false, 1)).toBe(null);
  });

  it('treats a size of 0 like one person (never an alarm)', () => {
    // The member's own profile is always readable, so 0 should not
    // happen; if it does, it must not light the list up.
    expect(deriveAttentionState(handedOff, true, 0)).toBe(null);
  });

  it('decides nothing while the team size is unknown', () => {
    expect(deriveAttentionState(handedOff, true, null)).toBe(null);
    expect(deriveAttentionState(idle, false, null)).toBe(null);
  });

  it('still names the assignee whatever the team size', () => {
    const assigned = conv({ assigned_agent_id: 'agent-1' });
    for (const size of [null, 1, 2]) {
      expect(deriveAttentionState(assigned, false, size)).toBe('assigned');
      expect(deriveAttentionState(assigned, true, size)).toBe('assigned');
      expect(deriveAttentionState(assigned, null, size)).toBe('assigned');
    }
  });

  it("still reads the bot's threads as 'ai' whatever the team size", () => {
    for (const size of [null, 1, 2]) {
      expect(deriveAttentionState(idle, true, size)).toBe('ai');
    }
  });

  it('keeps closed threads out of the queue whatever the team size', () => {
    const closed = conv({ status: 'closed', ai_autoreply_disabled: true });
    for (const size of [null, 1, 2]) {
      expect(deriveAttentionState(closed, false, size)).toBe(null);
      expect(deriveAttentionState(closed, true, size)).toBe(null);
    }
  });

  it('the filter agrees with the badge for every size', () => {
    const rows = [
      idle,
      handedOff,
      conv({ id: 'assigned', assigned_agent_id: 'agent-1' }),
      conv({ id: 'closed', status: 'closed', ai_autoreply_disabled: true }),
    ];
    for (const size of [null, 0, 1, 2, 3]) {
      for (const ai of [true, false, null]) {
        for (const c of rows) {
          expect(isUnattended(c, ai, size)).toBe(
            deriveAttentionState(c, ai, size) === 'unattended'
          );
        }
      }
    }
    expect(rows.filter((c) => isUnattended(c, false, 1))).toEqual([]);
    expect(rows.filter((c) => isUnattended(c, false, null))).toEqual([]);
    expect(rows.filter((c) => isUnattended(c, false, 2))).toHaveLength(2);
  });
});

describe('offersUnattendedFilter (the header chip)', () => {
  it('hides the chip only when the account is known to have one member', () => {
    expect(offersUnattendedFilter(1)).toBe(false);
    expect(offersUnattendedFilter(0)).toBe(false);
  });

  it('offers it to teams, and while the size is still unknown', () => {
    expect(offersUnattendedFilter(2)).toBe(true);
    expect(offersUnattendedFilter(10)).toBe(true);
    expect(offersUnattendedFilter(null)).toBe(true);
  });
});
