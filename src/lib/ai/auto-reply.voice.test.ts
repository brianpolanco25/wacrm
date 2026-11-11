import { beforeEach, describe, expect, it, vi } from 'vitest';

// n15.1 (R4, R7, R8, R24, R27, R28, R30): the voice note goes through the
// same gates as a text, is transcribed only after the reservation, and
// without a transcript the bot sends the fallback text and nothing else.

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  conv: null as Record<string, unknown> | null,
  claimWon: true,
  paused: false,
  quotaThrows: false,
  context: [] as { role: string; content: string; voice?: boolean }[],
  ensureVoiceTranscript: vi.fn(),
  sendVoiceFallback: vi.fn(),
  generateReply: vi.fn(),
  buildSystemPrompt: vi.fn(),
  retrieveKnowledge: vi.fn<(...args: unknown[]) => Promise<string[]>>(
    async () => []
  ),
  engineSendText: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  updates: [] as { table: string; payload: unknown }[],
  rpcs: [] as string[],
  db: null as unknown,
}));

vi.mock('./voice/ensure-transcript', () => ({
  ensureVoiceTranscript: h.ensureVoiceTranscript,
}));
vi.mock('./voice/fallback', () => ({ sendVoiceFallback: h.sendVoiceFallback }));
vi.mock('./tools/load', () => ({
  loadAiToolset: vi.fn(async () => ({ tools: [], integrations: [] })),
}));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./defaults', async (orig) => {
  const real = await orig<typeof import('./defaults')>();
  h.buildSystemPrompt.mockImplementation(real.buildSystemPrompt);
  return { ...real, buildSystemPrompt: h.buildSystemPrompt };
});
vi.mock('./usage', () => ({ logAiUsage: vi.fn(async () => {}) }));
vi.mock('./config', () => ({ loadAiConfig: vi.fn(async () => h.config) }));
vi.mock('./context', () => ({
  buildConversationContext: vi.fn(async () => h.context),
}));
vi.mock('./knowledge', () => ({ retrieveKnowledge: h.retrieveKnowledge }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: h.engineSendText }));
vi.mock('@/lib/automations/reply-marker', () => ({
  claimInboundAutoReply: vi.fn(async () => h.claimWon),
}));
vi.mock('@/lib/billing/service-cap', () => ({
  isAiPausedByServiceCap: vi.fn(async () => h.paused),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { aiAutoReplyAccount: {} },
}));
vi.mock('@/lib/billing/enforce', () => ({
  assertWritable: vi.fn(async () => ({ features: ['ai_autoreply'] })),
  assertPlanFeature: vi.fn(async () => {}),
  assertQuota: vi.fn(async () => {
    if (h.quotaThrows) throw new Error('quota');
  }),
  recordUsage: h.recordUsage,
}));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }));

import { dispatchInboundToAiReply } from './auto-reply';

const CONFIG = {
  provider: 'openai',
  model: 'm',
  apiKey: 'k',
  keySource: 'account',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffMode: 'queue',
  handoffAgentId: null,
  handoffMessage: null,
  embeddingsApiKey: null,
  embeddingsProvider: 'openai',
  voiceFallbackMessage: 'Escríbeme, por favor.',
};
const OPEN_CONV = {
  status: 'open',
  assigned_agent_id: null,
  ai_autoreply_disabled: false,
  ai_reply_count: 0,
  whatsapp_config_id: null,
};
const VOICE = { metaMediaId: 'media-1', accessToken: 'tok' };

function fakeDb() {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      q.update = (payload: unknown) => {
        h.updates.push({ table, payload });
        return q;
      };
      q.maybeSingle = async () => ({ data: h.conv, error: null });
      return q;
    },
    rpc: async (name: string) => {
      h.rpcs.push(name);
      return { data: true, error: null };
    },
  };
}

const dispatch = (opts: { text?: boolean } = {}) =>
  dispatchInboundToAiReply({
    accountId: 'acct-A',
    conversationId: 'conv-1',
    contactId: 'contact-1',
    inboundMessageId: 'msg-1',
    configOwnerUserId: 'owner-1',
    ...(opts.text ? {} : { voiceNote: VOICE }),
  });

beforeEach(() => {
  vi.clearAllMocks();
  h.config = { ...CONFIG };
  h.conv = { ...OPEN_CONV };
  h.claimWon = true;
  h.paused = false;
  h.quotaThrows = false;
  h.updates = [];
  h.rpcs = [];
  h.db = fakeDb();
  h.context = [
    { role: 'user', content: '[nota de voz] cita el jueves', voice: true },
  ];
  h.ensureVoiceTranscript.mockResolvedValue({
    status: 'done',
    text: 'cita el jueves',
  });
  h.sendVoiceFallback.mockResolvedValue('sent');
  h.generateReply.mockResolvedValue({
    text: 'Sí, a las 10.',
    handoff: false,
    usage: null,
  });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('voice note gates (R7): nothing is downloaded or transcribed', () => {
  const gates: [string, () => void][] = [
    ['AI off', () => (h.config = null)],
    [
      'auto-reply off',
      () => (h.config = { ...CONFIG, autoReplyEnabled: false }),
    ],
    ['quota spent', () => (h.quotaThrows = true)],
    ['closed', () => (h.conv = { ...OPEN_CONV, status: 'closed' })],
    [
      'agent assigned',
      () => (h.conv = { ...OPEN_CONV, assigned_agent_id: 'u1' }),
    ],
    [
      'ai_autoreply_disabled',
      () => (h.conv = { ...OPEN_CONV, ai_autoreply_disabled: true }),
    ],
    ['cap reached', () => (h.conv = { ...OPEN_CONV, ai_reply_count: 3 })],
    ['service-cap pause', () => (h.paused = true)],
    ['reservation lost', () => (h.claimWon = false)],
  ];
  for (const [name, arrange] of gates) {
    it(name, async () => {
      arrange();
      await dispatch();
      expect(h.ensureVoiceTranscript).not.toHaveBeenCalled();
      expect(h.sendVoiceFallback).not.toHaveBeenCalled();
      expect(h.generateReply).not.toHaveBeenCalled();
    });
  }
});

describe('voice note transcribed (R8, R24, R26, R27)', () => {
  it('transcribes after the reservation and replies with the voice context', async () => {
    await dispatch();
    expect(h.ensureVoiceTranscript).toHaveBeenCalledTimes(1);
    expect(h.ensureVoiceTranscript.mock.calls[0][0]).toMatchObject({
      accountId: 'acct-A',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      source: VOICE,
    });
    expect(h.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      voiceNotes: true,
    });
    expect(h.buildSystemPrompt.mock.results[0].value).toContain(
      '[nota de voz]'
    );
    expect(h.generateReply.mock.calls[0][0].messages).toEqual(h.context);
    // The system prompt never carries the transcript itself (R27).
    expect(h.generateReply.mock.calls[0][0].systemPrompt).not.toContain(
      'cita el jueves'
    );
    // Knowledge is queried without the marker (R27).
    expect(h.retrieveKnowledge.mock.calls[0][3]).toBe('cita el jueves');
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
    expect(h.recordUsage).toHaveBeenCalledWith('acct-A', 'ai_replies', 1);
    expect(h.sendVoiceFallback).not.toHaveBeenCalled();
  });

  it('keeps the in-memory transcript when the stored one is missing (R22)', async () => {
    h.context = [{ role: 'assistant', content: 'Hola' }];
    await dispatch();
    expect(h.generateReply.mock.calls[0][0].messages).toEqual([
      { role: 'assistant', content: 'Hola' },
      { role: 'user', content: '[nota de voz] cita el jueves', voice: true },
    ]);
  });
});

describe('voice note without a transcript (R28)', () => {
  for (const outcome of [
    { status: 'skipped', reason: 'no_transcriber' },
    { status: 'failed', reason: 'timeout' },
  ]) {
    it(`${outcome.status}/${outcome.reason} → fallback once, nothing else`, async () => {
      h.ensureVoiceTranscript.mockResolvedValue(outcome);
      await dispatch();
      expect(h.sendVoiceFallback).toHaveBeenCalledTimes(1);
      expect(h.sendVoiceFallback.mock.calls[0][0]).toMatchObject({
        accountId: 'acct-A',
        conversationId: 'conv-1',
        contactId: 'contact-1',
        userId: 'owner-1',
        messageId: 'msg-1',
        text: 'Escríbeme, por favor.',
      });
      expect(h.generateReply).not.toHaveBeenCalled();
      expect(h.updates.filter((u) => u.table === 'conversations')).toEqual([]);
      expect(h.rpcs).not.toContain('claim_ai_reply_slot');
      expect(h.recordUsage).not.toHaveBeenCalled();
      expect(h.engineSendText).not.toHaveBeenCalled();
    });
  }
});

describe('robustness (R30)', () => {
  it('a throwing sendVoiceFallback does not propagate', async () => {
    h.ensureVoiceTranscript.mockResolvedValue({
      status: 'failed',
      reason: 'empty',
    });
    h.sendVoiceFallback.mockRejectedValue(new Error('boom'));
    await expect(dispatch()).resolves.toBeUndefined();
  });

  it('a throwing ensureVoiceTranscript does not propagate', async () => {
    h.ensureVoiceTranscript.mockRejectedValue(new Error('boom'));
    await expect(dispatch()).resolves.toBeUndefined();
    expect(h.generateReply).not.toHaveBeenCalled();
  });
});

describe('text inbound (R5)', () => {
  it('never transcribes nor sends the fallback', async () => {
    h.context = [{ role: 'user', content: 'hola' }];
    await dispatch({ text: true });
    expect(h.ensureVoiceTranscript).not.toHaveBeenCalled();
    expect(h.sendVoiceFallback).not.toHaveBeenCalled();
    expect(h.generateReply).toHaveBeenCalledTimes(1);
    expect(h.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      voiceNotes: false,
    });
    expect(h.buildSystemPrompt.mock.results[0].value).not.toContain(
      '[nota de voz]'
    );
  });
});
