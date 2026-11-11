import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

// engineSendText's module pulls in the admin client; the tests inject
// `send`, so the real one must never run.
vi.mock('@/lib/flows/meta-send', () => ({
  engineSendText: vi.fn(async () => {
    throw new Error('real engineSendText must not be called');
  }),
}));

import { sendVoiceFallback } from './fallback';
import { fakeDb } from './voice-test-support';
import { checkRateLimit } from '@/lib/rate-limit';

const TEXT = 'No puedo escuchar notas de voz, ¿me lo escribes?';
const NOW = Date.parse('2026-11-11T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

let seq = 0;
const okLimiter = () => ({ success: true, remaining: 0, reset: 0, limit: 1 });

function setup(
  rows: Record<string, unknown>[] = [],
  opts: Parameters<typeof fakeDb>[1] = {}
) {
  const conv = `conv-${++seq}`;
  const f = fakeDb(
    { messages: rows.map((r) => ({ conversation_id: conv, ...r })) },
    opts
  );
  const send = vi.fn(async () => ({ whatsapp_message_id: 'wamid' }));
  const limiter = vi.fn(okLimiter);
  const run = (over: Partial<Parameters<typeof sendVoiceFallback>[0]> = {}) =>
    sendVoiceFallback({
      db: f.db as unknown as SupabaseClient,
      accountId: 'acc-a',
      conversationId: conv,
      contactId: 'contact-1',
      userId: 'owner-1',
      messageId: 'msg-1',
      text: TEXT,
      deps: { send, limiter, now: () => NOW },
      ...over,
    });
  return { ...f, conv, send, limiter, run };
}

let logs: unknown[][];
beforeEach(() => {
  logs = [];
  for (const m of ['log', 'info', 'warn', 'error'] as const) {
    vi.spyOn(console, m).mockImplementation((...a: unknown[]) => {
      logs.push(a);
    });
  }
});
afterEach(() => vi.restoreAllMocks());

describe('sendVoiceFallback — opt-out (R41)', () => {
  it('null and blank text → opted_out without a query or a send', async () => {
    for (const text of [null, '   ', undefined]) {
      const t = setup();
      expect(await t.run({ text })).toBe('opted_out');
      expect(t.queries).toHaveLength(0);
      expect(t.send).not.toHaveBeenCalled();
    }
  });
});

describe('sendVoiceFallback — send (R28)', () => {
  it('no previous row → sent with aiGenerated and the trimmed text', async () => {
    const t = setup();
    expect(await t.run({ text: `  ${TEXT}  ` })).toBe('sent');
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.send).toHaveBeenCalledWith({
      accountId: 'acc-a',
      userId: 'owner-1',
      conversationId: t.conv,
      contactId: 'contact-1',
      text: TEXT,
      aiGenerated: true,
    });
  });

  it('filters by conversation, bot sender, the text and the window', async () => {
    const t = setup();
    await t.run();
    const read = t.queries.find((q) => q.table === 'messages')!;
    expect(read.filters).toEqual([
      ['eq', 'conversation_id', t.conv],
      ['eq', 'sender_type', 'bot'],
      ['eq', 'content_text', TEXT],
      ['gte', 'created_at', minutesAgo(10)],
    ]);
    expect(t.limiter).toHaveBeenCalledWith(`ai-voice-fallback:${t.conv}`, {
      limit: 1,
      windowMs: 10 * 60_000,
    });
  });
});

describe('sendVoiceFallback — cooldown (R29)', () => {
  it('a bot row with the same text 9 min ago → cooldown, no send', async () => {
    const t = setup([
      { sender_type: 'bot', content_text: TEXT, created_at: minutesAgo(9) },
    ]);
    expect(await t.run()).toBe('cooldown');
    expect(t.send).not.toHaveBeenCalled();
    expect(JSON.stringify(logs)).toContain('fallback cooldown');
  });

  it('the same row 11 min ago → sent', async () => {
    const t = setup([
      { sender_type: 'bot', content_text: TEXT, created_at: minutesAgo(11) },
    ]);
    expect(await t.run()).toBe('sent');
  });

  it('a row with the text in ANOTHER conversation does not cause cooldown', async () => {
    const t = setup();
    t.tables.messages.push({
      conversation_id: 'conv-of-account-b',
      sender_type: 'bot',
      content_text: TEXT,
      created_at: minutesAgo(1),
    });
    expect(await t.run()).toBe('sent');
  });

  it('two calls in a row with the real limiter and an empty table → one send', async () => {
    const t = setup();
    const deps = { send: t.send, limiter: checkRateLimit, now: () => NOW };
    expect(await t.run({ deps })).toBe('sent');
    expect(await t.run({ deps })).toBe('cooldown');
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('a read error fails open and sends', async () => {
    const t = setup([], { selectError: { message: 'db down' } });
    expect(await t.run()).toBe('sent');
  });
});

describe('sendVoiceFallback — send failure (R42)', () => {
  it('a throwing send → send_failed, not propagated, text not logged', async () => {
    const t = setup();
    t.send.mockRejectedValueOnce(new Error(`Meta said no to ${TEXT}`));
    await expect(t.run()).resolves.toBe('send_failed');
    expect(JSON.stringify(logs)).not.toContain(TEXT);
  });
});
