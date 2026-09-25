import { AiError, type AiEmbeddingsProvider } from './types';
import { aiRequestTimeoutMs } from './defaults';
import { providerHttpError, toNetworkError } from './providers/shared';

// ============================================================
// Embeddings — OpenAI or Google Gemini (migration 068).
//
// Used for the knowledge base's optional semantic-search path: embed
// each chunk at ingest, and embed the query at retrieval. Anthropic has
// no embeddings endpoint, so the choice is between the other two; the
// account supplies a (possibly separate) embeddings key and says whose
// it is (`ai_configs.embeddings_provider`).
//
// Both produce 1536-dim vectors to fit the `vector(1536)` column of
// migration 030: that is OpenAI's native size for
// text-embedding-3-small and, for Gemini, a truncation the API does
// itself (`outputDimensionality`) — Gemini's recommended sizes are 768,
// 1536 and 3072, and gemini-embedding-2 re-normalises truncated
// vectors. Vectors from the two providers are NOT comparable: a chunk
// embedded by one and a query embedded by the other rank as noise, so
// switching provider means reindexing.
// ============================================================

const OPENAI_EMBEDDINGS_URL = 'https://api.openai.com/v1/embeddings';
const GEMINI_EMBEDDINGS_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/models';

export const EMBEDDING_MODEL = 'text-embedding-3-small';
export const GEMINI_EMBEDDING_MODEL = 'gemini-embedding-2';
export const EMBEDDING_DIMENSIONS = 1536;

// Both APIs accept a list per call; keep batches modest so a big
// re-index stays under request-size limits (Gemini caps a batch at 100)
// and partial failures are cheap.
const BATCH_SIZE = 96;

interface EmbeddingResponse {
  data?: { embedding?: number[]; index?: number }[];
}

interface GeminiEmbeddingResponse {
  embeddings?: { values?: number[] }[];
}

/** Format a vector for a pgvector column / RPC param: `[0.1,0.2,...]`.
 *  PostgREST casts this text literal to `vector`; a raw JS array does
 *  not cast reliably. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(',')}]`;
}

/**
 * Embed a list of strings, preserving input order. Batched; throws
 * `AiError` on provider/network failure so callers can decide whether
 * to degrade (retrieval) or surface (ingest).
 *
 * `provider` defaults to OpenAI so every caller written before
 * migration 068 keeps its meaning.
 */
export async function embedTexts(
  apiKey: string,
  inputs: string[],
  provider: AiEmbeddingsProvider = 'openai'
): Promise<number[][]> {
  if (inputs.length === 0) return [];
  return provider === 'gemini'
    ? embedWithGemini(apiKey, inputs)
    : embedWithOpenAI(apiKey, inputs);
}

async function embedWithOpenAI(
  apiKey: string,
  inputs: string[]
): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs();
  const out: number[][] = [];

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);

    let res: Response;
    try {
      res = await fetch(OPENAI_EMBEDDINGS_URL, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ model: EMBEDDING_MODEL, input: batch }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError('OpenAI embeddings', res);
    }

    const data = (await res
      .json()
      .catch(() => null)) as EmbeddingResponse | null;
    const rows = data?.data;
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      });
    }

    // Sort by index so order matches the input batch regardless of how
    // the provider returns them. Require a real numeric index — defaulting
    // a missing one to 0 would silently misalign chunks with their
    // vectors (chunk N gets chunk M's embedding), so fail loud instead.
    if (rows.some((r) => typeof r.index !== 'number')) {
      throw new AiError('Embeddings response was missing result indices.', {
        code: 'embeddings_malformed',
      });
    }
    const ordered = [...rows].sort((a, b) => a.index! - b.index!);
    for (const r of ordered) {
      if (!Array.isArray(r.embedding)) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        });
      }
      out.push(r.embedding);
    }
  }

  return out;
}

/**
 * Gemini's `batchEmbedContents`: one request per text, all in one HTTP
 * call, answered in the same order (there is no index to sort by, so a
 * length mismatch is the only misalignment we can detect — and we do).
 * The key travels in `x-goog-api-key`, never in the URL, same as the
 * chat adapter. `gemini-embedding-2` takes no task type — Google
 * dropped it for this model — so nothing distinguishes a document
 * embedding from a query embedding beyond the text itself.
 */
async function embedWithGemini(
  apiKey: string,
  inputs: string[]
): Promise<number[][]> {
  const timeoutMs = aiRequestTimeoutMs();
  const out: number[][] = [];
  const url = `${GEMINI_EMBEDDINGS_BASE_URL}/${GEMINI_EMBEDDING_MODEL}:batchEmbedContents`;

  for (let start = 0; start < inputs.length; start += BATCH_SIZE) {
    const batch = inputs.slice(start, start + BATCH_SIZE);

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: {
          'x-goog-api-key': apiKey,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          requests: batch.map((text) => ({
            model: `models/${GEMINI_EMBEDDING_MODEL}`,
            content: { parts: [{ text }] },
            embedContentConfig: { outputDimensionality: EMBEDDING_DIMENSIONS },
          })),
        }),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (err) {
      throw toNetworkError(err);
    }

    if (!res.ok) {
      throw await providerHttpError('Gemini embeddings', res);
    }

    const data = (await res
      .json()
      .catch(() => null)) as GeminiEmbeddingResponse | null;
    const rows = data?.embeddings;
    if (!rows || rows.length !== batch.length) {
      throw new AiError('Embeddings response was malformed.', {
        code: 'embeddings_malformed',
      });
    }
    for (const r of rows) {
      if (
        !Array.isArray(r.values) ||
        r.values.length !== EMBEDDING_DIMENSIONS
      ) {
        throw new AiError('Embeddings response missing a vector.', {
          code: 'embeddings_malformed',
        });
      }
      out.push(r.values);
    }
  }

  return out;
}
