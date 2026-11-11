import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError, type AiConfig, type ProviderResult } from '../types';
import { TranscribeHttpError } from '../providers/transcribe-errors';
import { ensureVoiceTranscript } from './ensure-transcript';
import type { LoadedAudio } from './audio-source';
import { fakeDb } from './voice-test-support';
import type { SupabaseClient } from '@supabase/supabase-js';

const CONV_A = 'conv-a';
const CONV_B = 'conv-b';
const MSG = 'msg-1';
const TRANSCRIPT = 'quiero una cita el jueves por la tarde';

function cfg(over: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-5.4-mini',
    apiKey: 'sk-account',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 5,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
    ...over,
  };
}

function audioRow(over: Record<string, unknown> = {}) {
  return {
    id: MSG,
    conversation_id: CONV_A,
    content_type: 'audio',
    sender_type: 'customer',
    media_url: '/api/whatsapp/media/m1',
    media_type: 'audio/ogg; codecs=opus',
    transcript: null,
    transcript_status: null,
    ...over,
  };
}

const okAudio = (
  over: Partial<Extract<LoadedAudio, { ok: true }>> = {}
): LoadedAudio => ({
  ok: true,
  bytes: new Uint8Array([1, 2, 3]),
  mimeType: 'audio/ogg',
  ...over,
});

const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };

function setup(rows = [audioRow()], dbOpts: Parameters<typeof fakeDb>[1] = {}) {
  const f = fakeDb({ messages: rows, ai_usage_log: [] }, dbOpts);
  const transcribe = vi.fn<(...args: unknown[]) => Promise<ProviderResult>>(
    async () => ({ text: `  ${TRANSCRIPT}\n `, usage })
  );
  const loadAudio = vi.fn(async () => okAudio());
  const sleep = vi.fn(async () => {});
  const run = (
    over: Partial<Parameters<typeof ensureVoiceTranscript>[0]> = {}
  ) =>
    ensureVoiceTranscript({
      db: f.db as unknown as SupabaseClient,
      accountId: 'acc-a',
      conversationId: CONV_A,
      messageId: MSG,
      config: cfg(),
      source: { metaMediaId: 'm1', accessToken: 'tok' },
      deps: { transcribe, loadAudio, sleep },
      ...over,
    });
  return { ...f, transcribe, loadAudio, sleep, run };
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
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

const updates = (queries: ReturnType<typeof fakeDb>['queries']) =>
  queries.filter((q) => q.table === 'messages' && q.op === 'update');

describe('ensureVoiceTranscript — reuse (R8)', () => {
  it('a done row is reused without loading or transcribing', async () => {
    const t = setup([
      audioRow({ transcript: 'ya', transcript_status: 'done' }),
    ]);
    expect(await t.run()).toEqual({ status: 'done', text: 'ya' });
    expect(t.loadAudio).not.toHaveBeenCalled();
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(updates(t.queries)).toHaveLength(0);
  });

  it('a failed row → previous_attempt without calls', async () => {
    const t = setup([audioRow({ transcript_status: 'failed' })]);
    expect(await t.run()).toEqual({
      status: 'failed',
      reason: 'previous_attempt',
    });
    expect(t.loadAudio).not.toHaveBeenCalled();
    expect(t.transcribe).not.toHaveBeenCalled();
  });
});

describe('ensureVoiceTranscript — skipped before the call (R14–R16)', () => {
  it('no transcriber → UPDATE skipped and no download', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
    vi.stubEnv('AI_PLATFORM_GEMINI_API_KEY', '');
    const t = setup();
    expect(await t.run({ config: cfg({ provider: 'anthropic' }) })).toEqual({
      status: 'skipped',
      reason: 'no_transcriber',
    });
    expect(t.loadAudio).not.toHaveBeenCalled();
    expect(t.tables.messages[0]).toMatchObject({
      transcript: null,
      transcript_status: 'skipped',
    });
  });

  it('audio/amr → skipped/unsupported_format', async () => {
    const t = setup();
    t.loadAudio.mockResolvedValueOnce(okAudio({ mimeType: 'audio/amr' }));
    expect(await t.run()).toEqual({
      status: 'skipped',
      reason: 'unsupported_format',
    });
    expect(t.transcribe).not.toHaveBeenCalled();
  });

  it('an Ogg of 400 s → skipped/too_long', async () => {
    const page = new Uint8Array(32);
    page.set([0x4f, 0x67, 0x67, 0x53, 0]);
    new DataView(page.buffer).setBigInt64(6, BigInt(48000 * 400), true);
    const t = setup();
    t.loadAudio.mockResolvedValueOnce(okAudio({ bytes: page }));
    expect(await t.run()).toEqual({ status: 'skipped', reason: 'too_long' });
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(t.tables.messages[0].transcript_status).toBe('skipped');
  });

  it('a loader skipped/too_large or failed/forbidden_path → 0 transcribe calls', async () => {
    for (const r of [
      { ok: false, status: 'skipped', reason: 'too_large' },
      { ok: false, status: 'failed', reason: 'forbidden_path' },
      { ok: false, status: 'failed', reason: 'download_failed' },
    ] as LoadedAudio[]) {
      const t = setup();
      t.loadAudio.mockResolvedValueOnce(r);
      const out = await t.run();
      expect(out).toMatchObject({ status: (r as { status: string }).status });
      expect(t.transcribe).not.toHaveBeenCalled();
      expect(t.sleep).not.toHaveBeenCalled();
    }
  });
});

describe('ensureVoiceTranscript — success (R20, R23)', () => {
  it('stores the clean transcript with the guarded UPDATE and logs transcription usage', async () => {
    const t = setup();
    expect(await t.run()).toEqual({ status: 'done', text: TRANSCRIPT });
    const [upd] = updates(t.queries);
    expect(upd.payload).toEqual({
      transcript: TRANSCRIPT,
      transcript_status: 'done',
    });
    expect(upd.filters).toEqual([
      ['eq', 'id', MSG],
      ['eq', 'conversation_id', CONV_A],
      ['is', 'transcript_status', null],
    ]);
    await vi.waitFor(() => expect(t.tables.ai_usage_log).toHaveLength(1));
    expect(t.tables.ai_usage_log[0]).toMatchObject({
      account_id: 'acc-a',
      conversation_id: CONV_A,
      mode: 'transcription',
      provider: 'openai',
      model: 'gpt-4o-mini-transcribe',
      key_source: 'account',
    });
  });

  it('an anthropic account logs the transcriber (openai/platform), not AiConfig', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const t = setup();
    await t.run({
      config: cfg({
        provider: 'anthropic',
        model: 'claude-x',
        keySource: 'account',
      }),
    });
    await vi.waitFor(() => expect(t.tables.ai_usage_log).toHaveLength(1));
    expect(t.tables.ai_usage_log[0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-4o-mini-transcribe',
      key_source: 'platform',
    });
  });

  it('a blank result → failed/empty', async () => {
    const t = setup();
    t.transcribe.mockResolvedValueOnce({ text: '  \n ', usage });
    expect(await t.run()).toEqual({ status: 'failed', reason: 'empty' });
    expect(t.tables.messages[0]).toMatchObject({
      transcript: null,
      transcript_status: 'failed',
    });
  });

  it('an UPDATE error still returns done (R22)', async () => {
    const t = setup([audioRow()], { updateError: { message: 'boom' } });
    expect(await t.run()).toEqual({ status: 'done', text: TRANSCRIPT });
  });

  it('a throwing loader → failed, not propagated (R30)', async () => {
    const t = setup();
    t.loadAudio.mockRejectedValueOnce(new Error('kaboom'));
    await expect(t.run()).resolves.toEqual({
      status: 'failed',
      reason: 'provider_error',
    });
  });
});

describe('ensureVoiceTranscript — retry (R19)', () => {
  it('timeout then success → done, 2 calls, sleep(1000) once', async () => {
    const t = setup();
    t.transcribe.mockRejectedValueOnce(new AiError('t', { code: 'timeout' }));
    expect(await t.run()).toEqual({ status: 'done', text: TRANSCRIPT });
    expect(t.transcribe).toHaveBeenCalledTimes(2);
    expect(t.sleep).toHaveBeenCalledTimes(1);
    expect(t.sleep).toHaveBeenCalledWith(1000);
  });

  it('503 twice → failed/provider_error with exactly 2 calls', async () => {
    const t = setup();
    const e = () =>
      new TranscribeHttpError(
        new AiError('x', { code: 'provider_error' }),
        503
      );
    t.transcribe.mockRejectedValueOnce(e()).mockRejectedValueOnce(e());
    expect(await t.run()).toEqual({
      status: 'failed',
      reason: 'provider_error',
    });
    expect(t.transcribe).toHaveBeenCalledTimes(2);
  });

  it('429 twice → failed/rate_limited with 2 calls', async () => {
    const t = setup();
    const e = () =>
      new TranscribeHttpError(new AiError('x', { code: 'rate_limited' }), 429);
    t.transcribe.mockRejectedValueOnce(e()).mockRejectedValueOnce(e());
    expect(await t.run()).toEqual({ status: 'failed', reason: 'rate_limited' });
    expect(t.transcribe).toHaveBeenCalledTimes(2);
  });

  it('invalid_key → 1 call, no sleep', async () => {
    const t = setup();
    t.transcribe.mockRejectedValueOnce(
      new TranscribeHttpError(
        new AiError('x', { code: 'invalid_key', status: 401 }),
        401
      )
    );
    expect(await t.run()).toEqual({ status: 'failed', reason: 'invalid_key' });
    expect(t.transcribe).toHaveBeenCalledTimes(1);
    expect(t.sleep).not.toHaveBeenCalled();
  });

  it('400 → 1 call', async () => {
    const t = setup();
    t.transcribe.mockRejectedValueOnce(
      new TranscribeHttpError(new AiError('x', { code: 'provider_error' }), 400)
    );
    expect(await t.run()).toEqual({
      status: 'failed',
      reason: 'provider_error',
    });
    expect(t.transcribe).toHaveBeenCalledTimes(1);
  });
});

describe('ensureVoiceTranscript — isolation and logs (R31, R32)', () => {
  it('a message of account B with the same id in another conversation is neither read nor written', async () => {
    const rowB = audioRow({ conversation_id: CONV_B, media_url: 'b-url' });
    const t = setup([rowB]); // only B's row exists
    const out = await t.run();
    expect(out).toEqual({ status: 'failed', reason: 'download_failed' });
    expect(t.loadAudio).not.toHaveBeenCalled();
    expect(t.transcribe).not.toHaveBeenCalled();
    expect(rowB).toMatchObject({ transcript: null, transcript_status: null });
    const read = t.queries.find(
      (q) => q.table === 'messages' && q.op === 'select'
    )!;
    expect(read.filters).toEqual([
      ['eq', 'id', MSG],
      ['eq', 'conversation_id', CONV_A],
    ]);
  });

  it('with both rows present only A is updated', async () => {
    const rowA = audioRow();
    const rowB = audioRow({ conversation_id: CONV_B });
    const t = setup([rowB, rowA]);
    await t.run();
    expect(rowA.transcript_status).toBe('done');
    expect(rowB).toMatchObject({ transcript: null, transcript_status: null });
  });

  it('no log line contains the transcript or the token', async () => {
    const t = setup();
    await t.run();
    const t2 = setup();
    t2.transcribe.mockResolvedValueOnce({ text: '', usage: null });
    await t2.run();
    const dump = JSON.stringify(logs);
    expect(dump).toContain(`message ${MSG}`);
    expect(dump).not.toContain(TRANSCRIPT);
    expect(dump).not.toContain('tok');
  });
});
