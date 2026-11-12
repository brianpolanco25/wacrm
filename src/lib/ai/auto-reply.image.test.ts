import { beforeEach, describe, expect, it, vi } from 'vitest';

// n15.2 (R4, R5, R25, R27, R28, R30): a customer photo goes through the
// same gates as a text, is downloaded only after them, reaches the model
// as image bytes, and an unloadable image never derails the turn.

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://proj.supabase.co';
const PATH = `account-${ACCOUNT}/inbound/1-image-2.jpg`;
const MEDIA_URL = `${ORIGIN}/storage/v1/object/public/chat-media/${PATH}`;
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0x10, 0x20, 0x30, 0x40]);
const B64 = Buffer.from(JPEG).toString('base64');

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  conv: null as Record<string, unknown> | null,
  claimWon: true,
  paused: false,
  writableThrows: false,
  planThrows: false,
  quotaThrows: false,
  context: [] as unknown[],
  storageResult: null as { data: Blob | null; error: unknown } | null,
  download: vi.fn(),
  getMediaUrl: vi.fn(),
  downloadMedia: vi.fn(),
  generateReply: vi.fn(),
  buildSystemPrompt: vi.fn(),
  logAiUsage: vi.fn(async () => {}),
  retrieveKnowledge: vi.fn<(...args: unknown[]) => Promise<string[]>>(
    async () => []
  ),
  engineSendText: vi.fn(async () => {}),
  recordUsage: vi.fn(async () => {}),
  writes: [] as { table: string; op: string; payload: unknown }[],
  rpcs: [] as string[],
  db: null as unknown,
}));

vi.mock('@/lib/whatsapp/meta-api', async (orig) => ({
  ...(await orig<typeof import('@/lib/whatsapp/meta-api')>()),
  getMediaUrl: h.getMediaUrl,
  downloadMedia: h.downloadMedia,
}));
vi.mock('./voice/ensure-transcript', () => ({
  ensureVoiceTranscript: vi.fn(),
}));
vi.mock('./voice/fallback', () => ({ sendVoiceFallback: vi.fn() }));
vi.mock('./tools/load', () => ({
  loadAiToolset: vi.fn(async () => ({ tools: [], integrations: [] })),
}));
vi.mock('./generate', () => ({ generateReply: h.generateReply }));
vi.mock('./defaults', async (orig) => {
  const real = await orig<typeof import('./defaults')>();
  h.buildSystemPrompt.mockImplementation(real.buildSystemPrompt);
  return { ...real, buildSystemPrompt: h.buildSystemPrompt };
});
vi.mock('./usage', () => ({ logAiUsage: h.logAiUsage }));
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
  assertWritable: vi.fn(async () => {
    if (h.writableThrows) throw new Error('read-only');
    return { features: ['ai_autoreply'] };
  }),
  assertPlanFeature: vi.fn(async () => {
    if (h.planThrows) throw new Error('plan');
  }),
  assertQuota: vi.fn(async () => {
    if (h.quotaThrows) throw new Error('quota');
  }),
  recordUsage: h.recordUsage,
}));
vi.mock('./admin-client', () => ({ supabaseAdmin: () => h.db }));

import { dispatchInboundToAiReply } from './auto-reply';

const CONFIG = {
  provider: 'openai',
  model: 'gpt-4o-mini',
  apiKey: 'k',
  keySource: 'account',
  systemPrompt: null,
  isActive: true,
  autoReplyEnabled: true,
  autoReplyMaxPerConversation: 3,
  handoffMode: 'queue',
  handoffAgentId: null,
  handoffMessage: 'Te paso con una persona.',
  embeddingsApiKey: null,
  embeddingsProvider: 'openai',
};
const OPEN_CONV = {
  status: 'open',
  assigned_agent_id: null,
  ai_autoreply_disabled: false,
  ai_reply_count: 0,
  whatsapp_config_id: null,
};
const SOURCE = { metaMediaId: 'img-1', accessToken: 'EAAG-token' };
const USAGE = { promptTokens: 1300, completionTokens: 20, totalTokens: 1320 };

/** Records every write; the storage exposes only `download` (no upload). */
function fakeDb() {
  return {
    from: (table: string) => {
      const q: Record<string, unknown> = {};
      for (const m of ['select', 'eq']) q[m] = () => q;
      for (const op of ['update', 'insert', 'upsert']) {
        q[op] = (payload: unknown) => {
          h.writes.push({ table, op, payload });
          return q;
        };
      }
      q.maybeSingle = async () => ({ data: h.conv, error: null });
      return q;
    },
    rpc: async (name: string) => {
      h.rpcs.push(name);
      return { data: true, error: null };
    },
    storage: {
      from: (bucket: string) => ({
        download: (path: string) => {
          h.download(bucket, path);
          return Promise.resolve(h.storageResult);
        },
      }),
    },
  };
}

const imageTurn = (mediaUrl: string | null = MEDIA_URL) => ({
  role: 'user',
  content: '[imagen no disponible]',
  image: { messageId: 'msg-1', mediaUrl, mediaType: 'image/jpeg' },
});

const dispatch = () =>
  dispatchInboundToAiReply({
    accountId: ACCOUNT,
    conversationId: 'conv-1',
    contactId: 'contact-1',
    inboundMessageId: 'msg-1',
    configOwnerUserId: 'owner-1',
    inboundImage: SOURCE,
  });

let consoleSpies: ReturnType<typeof vi.spyOn>[] = [];

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', ORIGIN);
  vi.stubEnv('AI_IMAGE_MAX_PER_TURN', '');
  h.config = { ...CONFIG };
  h.conv = { ...OPEN_CONV };
  h.claimWon = true;
  h.paused = false;
  h.writableThrows = false;
  h.planThrows = false;
  h.quotaThrows = false;
  h.writes = [];
  h.rpcs = [];
  h.db = fakeDb();
  h.context = [{ role: 'user', content: 'hola' }, imageTurn()];
  h.storageResult = { data: new Blob([JPEG]), error: null };
  h.generateReply.mockResolvedValue({
    text: 'Gracias, ya tengo tu cédula.',
    handoff: false,
    usage: USAGE,
  });
  consoleSpies = (['log', 'info', 'warn', 'error', 'debug'] as const).map((k) =>
    vi.spyOn(console, k).mockImplementation(() => {})
  );
});

const loggedText = () =>
  JSON.stringify(consoleSpies.flatMap((s) => s.mock.calls));

describe('image gates (R4): nothing is downloaded', () => {
  const gates: [string, () => void][] = [
    ['AI off', () => (h.config = null)],
    [
      'auto-reply off',
      () => (h.config = { ...CONFIG, autoReplyEnabled: false }),
    ],
    ['read-only account', () => (h.writableThrows = true)],
    ['plan without ai_autoreply', () => (h.planThrows = true)],
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
      h.context = [imageTurn(null)];
      await dispatch();
      expect(h.download).not.toHaveBeenCalled();
      expect(h.getMediaUrl).not.toHaveBeenCalled();
      expect(h.generateReply).not.toHaveBeenCalled();
    });
  }
});

describe('image turn answered (R5, R27, R28, R30)', () => {
  it('sends the image bytes to the model with images: true in the prompt', async () => {
    await dispatch();
    expect(h.download).toHaveBeenCalledWith('chat-media', PATH);
    expect(h.getMediaUrl).not.toHaveBeenCalled();
    const sent = h.generateReply.mock.calls[0][0];
    expect(sent.messages).toEqual([
      { role: 'user', content: 'hola' },
      {
        ...imageTurn(),
        content: '[imagen]',
        images: [{ mimeType: 'image/jpeg', data: B64 }],
      },
    ]);
    expect(h.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      images: true,
    });
    expect(sent.systemPrompt).toContain('"[imagen]"');
    // The prompt never carries the bytes.
    expect(sent.systemPrompt).not.toContain(B64);
  });

  it('logs one usage row with the provider usage and charges one ai_replies', async () => {
    await dispatch();
    expect(h.logAiUsage).toHaveBeenCalledTimes(1);
    expect(h.logAiUsage.mock.calls[0]).toEqual([
      h.db,
      expect.objectContaining({ mode: 'auto_reply', usage: USAGE }),
    ]);
    expect(h.recordUsage).toHaveBeenCalledTimes(1);
    expect(h.recordUsage).toHaveBeenCalledWith(ACCOUNT, 'ai_replies', 1);
    expect(h.rpcs).toContain('claim_ai_reply_slot');
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
  });

  it('fetches the current inbound from Meta when it was not mirrored (R12)', async () => {
    h.context = [imageTurn('/api/whatsapp/media/img-1')];
    h.getMediaUrl.mockResolvedValue({
      url: 'https://lookaside/x',
      mimeType: 'image/jpeg',
      fileSize: JPEG.length,
    });
    h.downloadMedia.mockResolvedValue({
      buffer: Buffer.from(JPEG),
      contentType: 'image/jpeg',
    });
    await dispatch();
    expect(h.getMediaUrl).toHaveBeenCalledWith({
      mediaId: 'img-1',
      accessToken: 'EAAG-token',
    });
    expect(h.generateReply.mock.calls[0][0].messages[0].images).toEqual([
      { mimeType: 'image/jpeg', data: B64 },
    ]);
  });

  it('never writes nor logs the base64 (R28)', async () => {
    await dispatch();
    expect(JSON.stringify(h.writes)).not.toContain(B64);
    expect(h.writes.filter((w) => w.op !== 'update')).toEqual([]);
    expect(loggedText()).not.toContain(B64);
    expect(loggedText()).not.toContain('EAAG-token');
  });
});

describe('image not available (R25)', () => {
  it('a failed download still replies, with the unavailable marker, no handoff', async () => {
    h.storageResult = { data: null, error: { message: 'gone' } };
    await dispatch();
    expect(h.generateReply).toHaveBeenCalledTimes(1);
    const turn = h.generateReply.mock.calls[0][0].messages[1];
    expect(turn.content).toBe('[imagen no disponible]');
    expect(turn).not.toHaveProperty('images');
    expect(h.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      images: true,
    });
    expect(h.engineSendText).toHaveBeenCalledTimes(1);
    expect(h.engineSendText.mock.calls[0]).toEqual([
      expect.objectContaining({ text: 'Gracias, ya tengo tu cédula.' }),
    ]);
    expect(
      h.writes.filter(
        (w) =>
          w.table === 'conversations' &&
          (w.payload as Record<string, unknown>).ai_autoreply_disabled === true
      )
    ).toEqual([]);
  });

  it('an image of another account is never downloaded (CP3)', async () => {
    const other = `${ORIGIN}/storage/v1/object/public/chat-media/account-22222222-2222-4222-8222-222222222222/inbound/x.jpg`;
    h.context = [imageTurn(other)];
    await dispatch();
    expect(h.download).not.toHaveBeenCalled();
    expect(h.generateReply.mock.calls[0][0].messages[0].content).toBe(
      '[imagen no disponible]'
    );
  });
});

describe('text inbound', () => {
  it('without image turns: no hydration, images flag false', async () => {
    h.context = [{ role: 'user', content: 'hola' }];
    await dispatchInboundToAiReply({
      accountId: ACCOUNT,
      conversationId: 'conv-1',
      contactId: 'contact-1',
      inboundMessageId: 'msg-1',
      configOwnerUserId: 'owner-1',
    });
    expect(h.download).not.toHaveBeenCalled();
    expect(h.buildSystemPrompt.mock.calls[0][0]).toMatchObject({
      images: false,
    });
    expect(h.generateReply.mock.calls[0][0].messages).toEqual(h.context);
  });
});
