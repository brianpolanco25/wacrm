import { describe, it, expect } from 'vitest';
import {
  OVERLAPPING_TRIGGERS,
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

  it('counts welcome automations too: they answer the first inbound', () => {
    // The webhook dispatches these with `inbound_message_id` in the
    // context and fires them BEFORE the content triggers, so a greeting
    // on a brand-new contact does take the reservation for that message
    // and the bot does stand down for it.
    const found = overlappingAutomations([
      row({ id: 'a1', trigger_type: 'first_inbound_message' }),
      row({ id: 'a2', trigger_type: 'new_contact_created' }),
    ]);
    expect(found.map((a) => a.id)).toEqual(['a1', 'a2']);
  });

  it('ignores triggers a customer message never fires on its own', () => {
    const found = overlappingAutomations([
      // Only reachable through another automation's add_tag step.
      row({ id: 'a1', trigger_type: 'tag_added' }),
      // The AI auto-reply never runs for an interactive tap, so a menu
      // automation cannot collide with it.
      row({ id: 'a2', trigger_type: 'interactive_reply' }),
      row({ id: 'a3', trigger_type: 'conversation_assigned' }),
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

  it('covers exactly the triggers the webhook dispatches for an inbound', () => {
    expect([...OVERLAPPING_TRIGGERS]).toEqual([
      'first_inbound_message',
      'new_contact_created',
      'new_message_received',
      'keyword_match',
    ]);
  });
});
