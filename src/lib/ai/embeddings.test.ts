import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  EMBEDDING_DIMENSIONS,
  embedTexts,
  toVectorLiteral,
} from './embeddings';
import { AiError } from './types';

function okEmbeddings(count: number, shuffle = false): Response {
  const rows = Array.from({ length: count }, (_, i) => ({
    embedding: [i, i + 0.5],
    index: i,
  }));
  if (shuffle) rows.reverse();
  return {
    ok: true,
    status: 200,
    json: async () => ({ data: rows }),
  } as unknown as Response;
}

beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
afterEach(() => vi.unstubAllGlobals());

describe('toVectorLiteral', () => {
  it('formats a pgvector literal', () => {
    expect(toVectorLiteral([0.1, 0.2, 0.3])).toBe('[0.1,0.2,0.3]');
  });
});

describe('embedTexts', () => {
  it('returns [] and makes no request for empty input', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    expect(await embedTexts('sk-x', [])).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('embeds a single batch and sends the key', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length;
      return okEmbeddings(n);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await embedTexts('sk-x', ['a', 'b', 'c']);
    expect(out).toHaveLength(3);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openai.com');
    expect(
      (opts as unknown as { headers: Record<string, string> }).headers
        .Authorization
    ).toBe('Bearer sk-x');
  });

  it('splits large inputs into multiple batches', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length;
      return okEmbeddings(n);
    });
    vi.stubGlobal('fetch', fetchMock);

    const inputs = Array.from({ length: 100 }, (_, i) => `t${i}`);
    const out = await embedTexts('sk-x', inputs);
    expect(out).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2); // 96 + 4
  });

  it('reorders by index when the provider returns them shuffled', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, opts: { body: string }) => {
        const n = JSON.parse(opts.body).input.length;
        return okEmbeddings(n, true);
      })
    );
    const out = await embedTexts('sk-x', ['a', 'b', 'c']);
    expect(out[0]).toEqual([0, 0.5]); // index 0 first despite shuffle
    expect(out[2]).toEqual([2, 2.5]);
  });

  it('maps a 401 to an invalid_key AiError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key' } }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a'])).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });

  it('throws when the provider omits result indices', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({
          data: [{ embedding: [0.1] }, { embedding: [0.2] }],
        }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(
      AiError
    );
  });

  it('throws on a malformed response (count mismatch)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ data: [] }),
      } as unknown as Response)
    );
    await expect(embedTexts('sk-x', ['a', 'b'])).rejects.toBeInstanceOf(
      AiError
    );
  });
});

// Migration 068: the same function, told the key is Google's.
function okGemini(count: number): Response {
  const embeddings = Array.from({ length: count }, (_, i) => ({
    values: Array.from({ length: EMBEDDING_DIMENSIONS }, () => i),
  }));
  return {
    ok: true,
    status: 200,
    json: async () => ({ embeddings }),
  } as unknown as Response;
}

describe('embedTexts (gemini)', () => {
  it('calls batchEmbedContents with the key in the header and 1536 dims', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).requests.length;
      return okGemini(n);
    });
    vi.stubGlobal('fetch', fetchMock);

    const out = await embedTexts('AIza-x', ['a', 'b'], 'gemini');
    expect(out).toHaveLength(2);
    expect(out[1]).toHaveLength(EMBEDDING_DIMENSIONS);
    const [url, opts] = fetchMock.mock.calls[0];
    expect(url).toBe(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-2:batchEmbedContents'
    );
    const o = opts as unknown as {
      headers: Record<string, string>;
      body: string;
    };
    expect(o.headers['x-goog-api-key']).toBe('AIza-x');
    expect(String(url)).not.toContain('AIza-x');
    const body = JSON.parse(o.body);
    expect(body.requests[0]).toEqual({
      model: 'models/gemini-embedding-2',
      content: { parts: [{ text: 'a' }] },
      embedContentConfig: { outputDimensionality: EMBEDDING_DIMENSIONS },
    });
  });

  it('defaults to OpenAI when no provider is given', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).input.length;
      return okEmbeddings(n);
    });
    vi.stubGlobal('fetch', fetchMock);
    await embedTexts('sk-x', ['a']);
    expect(String(fetchMock.mock.calls[0][0])).toContain('api.openai.com');
  });

  it('splits large inputs into batches of at most 96', async () => {
    const fetchMock = vi.fn(async (_url: string, opts: { body: string }) => {
      const n = JSON.parse(opts.body).requests.length;
      expect(n).toBeLessThanOrEqual(96);
      return okGemini(n);
    });
    vi.stubGlobal('fetch', fetchMock);
    const out = await embedTexts(
      'AIza-x',
      Array.from({ length: 100 }, (_, i) => `t${i}`),
      'gemini'
    );
    expect(out).toHaveLength(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('maps a 400 API_KEY_INVALID to invalid_key', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: false,
        status: 400,
        json: async () => ({
          error: {
            message: 'API key not valid. Please pass a valid API key.',
            status: 'INVALID_ARGUMENT',
            details: [{ reason: 'API_KEY_INVALID' }],
          },
        }),
      } as unknown as Response)
    );
    await expect(embedTexts('AIza-x', ['a'], 'gemini')).rejects.toMatchObject({
      code: 'invalid_key',
    });
  });

  it('throws on a count mismatch (order cannot be trusted)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(okGemini(1)));
    await expect(
      embedTexts('AIza-x', ['a', 'b'], 'gemini')
    ).rejects.toBeInstanceOf(AiError);
  });

  it('throws when a vector has the wrong size', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ embeddings: [{ values: [1, 2, 3] }] }),
      } as unknown as Response)
    );
    await expect(embedTexts('AIza-x', ['a'], 'gemini')).rejects.toMatchObject({
      code: 'embeddings_malformed',
    });
  });
});
