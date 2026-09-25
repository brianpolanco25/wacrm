import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { generateReply, parseGeneration } from './generate';
import { AiError, type AiConfig } from './types';

function config(overrides: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'openai',
    model: 'gpt-test',
    apiKey: 'sk-test',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: false,
    autoReplyMaxPerConversation: 3,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
    ...overrides,
  };
}

function okResponse(json: unknown): Response {
  return {
    ok: true,
    status: 200,
    json: async () => json,
  } as unknown as Response;
}

function errResponse(status: number, json: unknown): Response {
  return {
    ok: false,
    status,
    json: async () => json,
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
});
afterEach(() => vi.unstubAllGlobals());

describe('parseGeneration', () => {
  it('returns text with no handoff', () => {
    expect(parseGeneration('Hello there')).toEqual({
      text: 'Hello there',
      handoff: false,
      usage: null,
    });
  });

  it('detects + strips the handoff sentinel', () => {
    expect(parseGeneration('[[HANDOFF]]')).toEqual({
      text: '',
      handoff: true,
      usage: null,
    });
    expect(parseGeneration('Let me get a human [[HANDOFF]]')).toEqual({
      text: 'Let me get a human',
      handoff: true,
      usage: null,
    });
  });

  it('passes usage straight through', () => {
    const usage = { promptTokens: 10, completionTokens: 5, totalTokens: 15 };
    expect(parseGeneration('Hi', usage)).toEqual({
      text: 'Hi',
      handoff: false,
      usage,
    });
  });
});

describe('generateReply — OpenAI', () => {
  it('calls the chat completions endpoint and returns the reply', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        choices: [{ message: { content: 'Sure — happy to help!' } }],
        usage: { prompt_tokens: 42, completion_tokens: 8, total_tokens: 50 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    });

    expect(res).toEqual({
      text: 'Sure — happy to help!',
      handoff: false,
      usage: { promptTokens: 42, completionTokens: 8, totalTokens: 50 },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openai.com');
    expect(opts.headers.Authorization).toBe('Bearer sk-test');
  });

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errResponse(401, { error: { message: 'Incorrect API key' } })
        )
    );

    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 });
  });

  it('throws on an empty completion', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ choices: [{ message: { content: '' } }] })
        )
    );
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toBeInstanceOf(AiError);
  });
});

describe('generateReply — Anthropic', () => {
  it('calls the messages endpoint with the version header and parses text blocks', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        content: [{ type: 'text', text: 'Hi there!' }],
        usage: { input_tokens: 30, output_tokens: 6 },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const res = await generateReply({
      config: config({ provider: 'anthropic', apiKey: 'sk-ant-x' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hello' }],
    });

    // Anthropic reports input/output only — total is summed by normalizeUsage.
    expect(res).toEqual({
      text: 'Hi there!',
      handoff: false,
      usage: { promptTokens: 30, completionTokens: 6, totalTokens: 36 },
    });
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.anthropic.com');
    expect(opts.headers['x-api-key']).toBe('sk-ant-x');
    expect(opts.headers['anthropic-version']).toBeTruthy();
  });

  it('detects handoff in the model output', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ content: [{ type: 'text', text: '[[HANDOFF]]' }] })
        )
    );
    const res = await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'I want to speak to a person' }],
    });
    expect(res.handoff).toBe(true);
    expect(res.text).toBe('');
  });

  it('drops a leading assistant turn so the payload starts on the customer', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ content: [{ type: 'text', text: 'ok' }] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: config({ provider: 'anthropic' }),
      systemPrompt: 'sys',
      messages: [
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
      ],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.messages[0].role).toBe('user');
    expect(body.messages).toHaveLength(1);
  });
});

describe('generateReply — Gemini', () => {
  const geminiConfig = () =>
    config({
      provider: 'gemini',
      model: 'gemini-3.5-flash-lite',
      apiKey: 'AIza-test',
    });

  it('calls generateContent with the key in a header and a user/model transcript', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      okResponse({
        candidates: [{ content: { parts: [{ text: 'ok' }] } }],
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [
        // A leading agent greeting is dropped: contents must start on user.
        { role: 'assistant', content: 'Welcome!' },
        { role: 'user', content: 'Hi' },
        { role: 'user', content: 'Are you open?' },
        { role: 'assistant', content: 'Yes, until 6.' },
        { role: 'user', content: 'Great' },
      ],
    });

    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash-lite:generateContent'
    );
    // The key never travels in the URL (it would end up in logs).
    expect(url).not.toContain('key=');
    expect(url).not.toContain('AIza-test');
    expect(opts.method).toBe('POST');
    expect(opts.headers['x-goog-api-key']).toBe('AIza-test');

    const body = JSON.parse(opts.body);
    expect(body.systemInstruction).toEqual({ parts: [{ text: 'sys' }] });
    expect(body.generationConfig).toEqual({ maxOutputTokens: 1024 });
    expect(body.contents).toEqual([
      { role: 'user', parts: [{ text: 'Hi\n\nAre you open?' }] },
      { role: 'model', parts: [{ text: 'Yes, until 6.' }] },
      { role: 'user', parts: [{ text: 'Great' }] },
    ]);
  });

  it('never sends an empty transcript', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        okResponse({ candidates: [{ content: { parts: [{ text: 'ok' }] } }] })
      );
    vi.stubGlobal('fetch', fetchMock);

    await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'assistant', content: 'Welcome!' }],
    });

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.contents).toHaveLength(1);
    expect(body.contents[0].role).toBe('user');
  });

  it('joins the text parts of the first candidate and normalizes usage', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            {
              content: {
                parts: [{ text: 'Hola, ' }, { text: '¿en qué ayudo?  ' }],
              },
              finishReason: 'STOP',
            },
          ],
          usageMetadata: {
            promptTokenCount: 40,
            candidatesTokenCount: 7,
            totalTokenCount: 49,
          },
        })
      )
    );

    const res = await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hola' }],
    });

    expect(res).toEqual({
      text: 'Hola, ¿en qué ayudo?',
      handoff: false,
      usage: { promptTokens: 40, completionTokens: 7, totalTokens: 49 },
    });
  });

  it('maps a blocked prompt (promptFeedback.blockReason) to empty_response naming the safety filter', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          okResponse({ promptFeedback: { blockReason: 'SAFETY' } })
        )
    );

    const err = await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((e) => e);
    expect(err).toBeInstanceOf(AiError);
    expect(err).toMatchObject({ code: 'empty_response' });
    expect(err.message).toMatch(/safety filter/i);
  });

  it('maps a SAFETY finish with no text to the safety-filter empty_response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [{ content: { parts: [] }, finishReason: 'SAFETY' }],
        })
      )
    );

    const err = await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'empty_response' });
    expect(err.message).toMatch(/safety filter/i);
  });

  it('uses the generic empty_response when there is no text and no block', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(okResponse({ candidates: [] }))
    );

    const err = await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Hi' }],
    }).catch((e) => e);
    expect(err).toMatchObject({ code: 'empty_response' });
    expect(err.message).not.toMatch(/safety/i);
  });

  it('maps a 400 API_KEY_INVALID to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, {
          error: {
            code: 400,
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [
              {
                '@type': 'type.googleapis.com/google.rpc.ErrorInfo',
                reason: 'API_KEY_INVALID',
                domain: 'googleapis.com',
              },
            ],
          },
        })
      )
    );

    await expect(
      generateReply({
        config: geminiConfig(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_key', status: 401 });
  });

  it('keeps any other 400 as a provider_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(400, {
          error: {
            code: 400,
            message: 'Invalid JSON payload received.',
            status: 'INVALID_ARGUMENT',
          },
        })
      )
    );

    await expect(
      generateReply({
        config: geminiConfig(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });

  it('maps a 403 (key without permission) to invalid_key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        errResponse(403, {
          error: {
            code: 403,
            message: 'Permission denied.',
            status: 'PERMISSION_DENIED',
          },
        })
      )
    );

    await expect(
      generateReply({
        config: geminiConfig(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'invalid_key' });
  });

  it('detects the handoff sentinel in Gemini output', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        okResponse({
          candidates: [
            {
              content: {
                parts: [{ text: 'Te paso con una persona [[HANDOFF]]' }],
              },
            },
          ],
        })
      )
    );

    const res = await generateReply({
      config: geminiConfig(),
      systemPrompt: 'sys',
      messages: [{ role: 'user', content: 'Quiero hablar con alguien' }],
    });
    expect(res.handoff).toBe(true);
    expect(res.text).toBe('Te paso con una persona');
  });
});

describe('providerHttpError — 400 is not an auth failure for OpenAI/Anthropic', () => {
  it('keeps an OpenAI 400 as provider_error', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          errResponse(400, { error: { message: 'Unsupported parameter' } })
        )
    );
    await expect(
      generateReply({
        config: config(),
        systemPrompt: 'sys',
        messages: [{ role: 'user', content: 'Hi' }],
      })
    ).rejects.toMatchObject({ code: 'provider_error', status: 502 });
  });
});
