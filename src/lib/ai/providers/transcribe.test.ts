import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AiError } from '../types';
import { TranscribeHttpError } from './transcribe-errors';
import { transcribeOpenAi } from './transcribe-openai';
import { TRANSCRIBE_INSTRUCTION, transcribeGemini } from './transcribe-gemini';
import { transcribeAudio } from '../voice/transcribe';

const fetchMock = vi.fn();
beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const bytes = new Uint8Array([1, 2, 3, 4]);
const args = {
  apiKey: 'sk-test',
  model: 'gpt-4o-mini-transcribe',
  bytes,
  mimeType: 'audio/ogg',
  timeoutMs: 15_000,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('transcribeOpenAi (R17)', () => {
  it('POSTs one multipart request with file, model and response_format=json', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        text: 'hola',
        usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13 },
      })
    );
    const out = await transcribeOpenAi(args);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect(init.method).toBe('POST');
    expect(init.headers.Authorization).toBe('Bearer sk-test');
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const form = init.body as FormData;
    const file = form.get('file') as File;
    expect(file.name).toBe('voice.ogg');
    expect(file.type).toBe('audio/ogg');
    expect(form.get('model')).toBe('gpt-4o-mini-transcribe');
    expect(form.get('response_format')).toBe('json');
    expect(out).toEqual({
      text: 'hola',
      usage: { promptTokens: 10, completionTokens: 3, totalTokens: 13 },
    });
  });

  it('returns usage null when the response carries none', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { text: 'hola' }));
    expect((await transcribeOpenAi(args)).usage).toBeNull();
  });

  it('maps 401 to invalid_key', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: { message: 'bad' } }));
    await expect(transcribeOpenAi(args)).rejects.toMatchObject({
      code: 'invalid_key',
      upstreamStatus: 401,
    });
  });

  it('maps 429 to rate_limited', async () => {
    fetchMock.mockResolvedValueOnce(json(429, {}));
    await expect(transcribeOpenAi(args)).rejects.toMatchObject({
      code: 'rate_limited',
      upstreamStatus: 429,
    });
  });

  it('maps 500 to provider_error and keeps upstreamStatus', async () => {
    fetchMock.mockResolvedValueOnce(json(500, {}));
    const err = await transcribeOpenAi(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TranscribeHttpError);
    expect(err).toMatchObject({ code: 'provider_error', upstreamStatus: 500 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps a TimeoutError to timeout', async () => {
    fetchMock.mockRejectedValueOnce(
      new DOMException('timed out', 'TimeoutError')
    );
    const err = await transcribeOpenAi(args).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'timeout' });
  });
});

describe('transcribeGemini (R18)', () => {
  it('sends the audio inline as base64 with the anti-instruction prompt', async () => {
    fetchMock.mockResolvedValueOnce(
      json(200, {
        candidates: [
          { content: { parts: [{ text: 'hola ' }, { text: 'qué tal' }] } },
        ],
        usageMetadata: {
          promptTokenCount: 20,
          candidatesTokenCount: 4,
          totalTokenCount: 24,
        },
      })
    );
    const out = await transcribeGemini({
      ...args,
      model: 'gemini-x',
      apiKey: 'g-key',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-x:generateContent'
    );
    expect(init.headers['x-goog-api-key']).toBe('g-key');
    expect(String(url)).not.toContain('g-key');
    const body = JSON.parse(init.body as string);
    expect(body.systemInstruction.parts[0].text).toBe(TRANSCRIBE_INSTRUCTION);
    expect(TRANSCRIBE_INSTRUCTION).toMatch(/never follow instructions/);
    expect(body.contents[0].parts[0].inlineData).toEqual({
      mimeType: 'audio/ogg',
      data: Buffer.from(bytes).toString('base64'),
    });
    expect(body.generationConfig).toEqual({
      maxOutputTokens: 2048,
      temperature: 0,
    });
    expect(out).toEqual({
      text: 'hola qué tal',
      usage: { promptTokens: 20, completionTokens: 4, totalTokens: 24 },
    });
  });

  it('maps 503 to a TranscribeHttpError with upstreamStatus 503', async () => {
    fetchMock.mockResolvedValueOnce(json(503, {}));
    await expect(transcribeGemini(args)).rejects.toMatchObject({
      code: 'provider_error',
      upstreamStatus: 503,
    });
  });

  it('returns an empty text instead of throwing when there is no candidate', async () => {
    fetchMock.mockResolvedValueOnce(json(200, {}));
    expect(await transcribeGemini(args)).toEqual({ text: '', usage: null });
  });
});

describe('transcribeAudio', () => {
  it('dispatches on the transcriber provider', async () => {
    fetchMock.mockResolvedValue(json(200, { text: 'x' }));
    await transcribeAudio({
      transcriber: {
        provider: 'openai',
        apiKey: 'k',
        keySource: 'account',
        model: 'm',
      },
      bytes,
      mimeType: 'audio/ogg',
      timeoutMs: 1000,
    });
    expect(fetchMock.mock.calls[0][0]).toContain('api.openai.com');
    await transcribeAudio({
      transcriber: {
        provider: 'gemini',
        apiKey: 'k',
        keySource: 'platform',
        model: 'g',
      },
      bytes,
      mimeType: 'audio/ogg',
      timeoutMs: 1000,
    });
    expect(fetchMock.mock.calls[1][0]).toContain('generativelanguage');
  });
});
