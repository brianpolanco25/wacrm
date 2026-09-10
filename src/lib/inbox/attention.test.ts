import { describe, it, expect } from 'vitest';
import { deriveAttentionState, isUnattended } from './attention';
import type { Conversation } from '@/types';

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
      deriveAttentionState(conv({ ai_autoreply_disabled: false }), true)
    ).toBe('ai');
  });

  it('treats a missing ai_autoreply_disabled as not paused', () => {
    // Rows written before migration 029 (and realtime payloads that
    // omit the column) must still read as "the bot has this one".
    expect(deriveAttentionState(conv(), true)).toBe('ai');
  });

  it("reads an assigned thread as 'assigned'", () => {
    expect(
      deriveAttentionState(
        conv({ assigned_agent_id: 'agent-1', ai_autoreply_disabled: true }),
        true
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
        true
      )
    ).toBe('assigned');
  });

  it("reads a handed-off thread nobody picked up as 'unattended'", () => {
    // The case that dies in silence: the bot stopped, no human took it.
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: true }), true)
    ).toBe('unattended');
  });

  it("never returns 'ai' when the account has auto-reply off", () => {
    expect(
      deriveAttentionState(conv({ ai_autoreply_disabled: false }), false)
    ).toBe('unattended');
    expect(deriveAttentionState(conv(), false)).toBe('unattended');
  });

  it('still shows the assignee when the account has auto-reply off', () => {
    expect(
      deriveAttentionState(conv({ assigned_agent_id: 'agent-1' }), false)
    ).toBe('assigned');
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
    expect(deriveAttentionState({ ...before, ...payload }, true)).toBe(
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
    expect(deriveAttentionState({ ...assigned, ...payload }, true)).toBe(
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
  ];

  it('returns the chats with no operator AND no AI, handed-off included', () => {
    expect(rows.filter((c) => isUnattended(c, true)).map((c) => c.id)).toEqual([
      'handed-off',
    ]);
  });

  it("returns every unassigned chat once the account's AI is off", () => {
    expect(rows.filter((c) => isUnattended(c, false)).map((c) => c.id)).toEqual(
      ['ai', 'handed-off']
    );
  });
});
