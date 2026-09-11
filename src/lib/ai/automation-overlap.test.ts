import { describe, it, expect } from 'vitest';
import {
  MESSAGE_LEVEL_TRIGGERS,
  overlappingAutomations,
} from './automation-overlap';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'a1',
  name: 'Opening hours',
  trigger_type: 'keyword_match',
  is_active: true,
  ...over,
});

describe('overlappingAutomations', () => {
  it('lists the active automations that answer on message content', () => {
    const found = overlappingAutomations([
      row({ id: 'a1', trigger_type: 'keyword_match' }),
      row({ id: 'a2', trigger_type: 'new_message_received' }),
    ]);
    expect(found.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('ignores paused automations', () => {
    expect(overlappingAutomations([row({ is_active: false })])).toEqual([]);
  });

  it('ignores relationship triggers — they are about who writes, not what they said', () => {
    const found = overlappingAutomations([
      row({ id: 'a1', trigger_type: 'first_inbound_message' }),
      row({ id: 'a2', trigger_type: 'new_contact_created' }),
      row({ id: 'a3', trigger_type: 'tag_added' }),
      // The AI auto-reply never runs for an interactive tap, so a menu
      // automation cannot collide with it.
      row({ id: 'a4', trigger_type: 'interactive_reply' }),
    ]);
    expect(found).toEqual([]);
  });

  it('survives a missing or malformed list', () => {
    expect(overlappingAutomations(null)).toEqual([]);
    expect(overlappingAutomations(undefined)).toEqual([]);
    expect(overlappingAutomations([row({ trigger_type: undefined })])).toEqual(
      []
    );
  });

  it('covers exactly the triggers the webhook dispatches for message content', () => {
    expect([...MESSAGE_LEVEL_TRIGGERS]).toEqual([
      'new_message_received',
      'keyword_match',
    ]);
  });
});
