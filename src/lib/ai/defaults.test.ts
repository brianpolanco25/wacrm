import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, HANDOFF_SENTINEL } from './defaults';

describe('buildSystemPrompt — hand-off protocol', () => {
  it('teaches the sentinel in auto-reply mode only', () => {
    expect(
      buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' })
    ).toContain(HANDOFF_SENTINEL);
    expect(
      buildSystemPrompt({ userPrompt: null, mode: 'draft' })
    ).not.toContain(HANDOFF_SENTINEL);
  });

  it('tells the model that greetings and confirmations are handled, not handed off', () => {
    const prompt = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(prompt).toMatch(/never hand off a message you can handle/);
    expect(prompt).toMatch(/greeting/);
    expect(prompt).toMatch(/confirmation/);
  });

  it('adds the resume paragraph only when the thread came back from a human', () => {
    const resumed = buildSystemPrompt({
      userPrompt: null,
      mode: 'auto_reply',
      resumedAfterHandoff: true,
    });
    expect(resumed).toMatch(/returned the thread to you/);
    expect(resumed).toMatch(/Do not hand off again for the same reason/);

    const fresh = buildSystemPrompt({ userPrompt: null, mode: 'auto_reply' });
    expect(fresh).not.toMatch(/returned the thread to you/);

    // Drafts are written by a human; the resume protocol is meaningless there.
    const draft = buildSystemPrompt({
      userPrompt: null,
      mode: 'draft',
      resumedAfterHandoff: true,
    });
    expect(draft).not.toMatch(/returned the thread to you/);
  });

  it('keeps the business instructions after the scaffold', () => {
    const prompt = buildSystemPrompt({
      userPrompt: 'Eres la asistente de REHACTIVE.',
      mode: 'auto_reply',
      resumedAfterHandoff: true,
    });
    expect(prompt.indexOf('returned the thread to you')).toBeLessThan(
      prompt.indexOf('Eres la asistente de REHACTIVE.')
    );
  });
});
