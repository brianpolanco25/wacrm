// ============================================================
// Reading a JSON body on the public API — the three checks every
// `/api/v1` write shares (fase 7 §1).
//
//   1. `Content-Type: application/json`, or 415. Without it an
//      integrator that forgets the header gets a confusing "body must
//      be a JSON object" 400 instead of the real problem, and a
//      browser form post (`text/plain`, no preflight) could reach a
//      write endpoint — the classic CSRF-on-a-JSON-API shape. We have
//      no cookie auth here, so it is not exploitable today; requiring
//      the header keeps it that way for free.
//   2. A 1 MiB ceiling, or 413. Enforced WHILE READING, not after: a
//      `Content-Length` header is a claim, and `await request.text()`
//      on a 500 MB stream would buffer all of it before anyone could
//      object. The declared length is only used as a cheap early
//      reject.
//   3. Valid JSON, and a JSON *object* at the top level, or 400.
//
// Returns the parsed object AND the raw text, because the idempotency
// layer hashes the exact bytes the client sent (a body can only be
// consumed once, so one read has to serve both).
// ============================================================

import {
  badRequest,
  payloadTooLarge,
  unsupportedMediaType,
} from '@/lib/api/v1/respond';

/** Hard ceiling on a request body: 1 MiB. */
export const MAX_BODY_BYTES = 1024 * 1024;

export interface JsonBody {
  /** The parsed top-level object. Unknown fields are the caller's problem. */
  data: Record<string, unknown>;
  /** Exactly the bytes we read, as UTF-8 text. Used for the request hash. */
  raw: string;
}

/**
 * True for `application/json` and any `…+json` media type, ignoring
 * parameters (`; charset=utf-8`) and case.
 */
function isJsonContentType(header: string | null): boolean {
  if (!header) return false;
  const type = header.split(';', 1)[0].trim().toLowerCase();
  return type === 'application/json' || type.endsWith('+json');
}

/**
 * Read the body as text, refusing to buffer more than `max` bytes.
 * Streams in chunks and aborts the moment the running total crosses
 * the ceiling, so an oversized (or deliberately hostile) upload costs
 * us one chunk of memory, not the whole payload.
 */
async function readCappedText(request: Request, max: number): Promise<string> {
  const declared = request.headers.get('content-length');
  if (declared) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > max) {
      throw payloadTooLarge(
        `Request body exceeds the ${max}-byte limit for this API`
      );
    }
  }

  const stream = request.body;
  if (!stream) {
    // No body at all (or a Request implementation without a stream, as
    // some test doubles are). `text()` is safe here: the ceiling check
    // above already rejected anything that *declared* itself too big,
    // and the length check below catches the rest.
    const text = await request.text();
    if (Buffer.byteLength(text, 'utf8') > max) {
      throw payloadTooLarge(
        `Request body exceeds the ${max}-byte limit for this API`
      );
    }
    return text;
  }

  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > max) {
        throw payloadTooLarge(
          `Request body exceeds the ${max}-byte limit for this API`
        );
      }
      chunks.push(value);
    }
  } finally {
    // Releases the connection instead of leaving the peer writing into
    // a stream nobody is draining.
    await reader.cancel().catch(() => {});
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The single entry point every `/api/v1` write uses to get its body.
 * Throws `ApiError` (415 / 413 / 400), which `toApiErrorResponse` maps
 * to the public envelope.
 *
 * Routes should not call `request.json()` directly: doing so skips all
 * three checks and consumes the body the idempotency layer needs.
 */
export async function readJsonBody(request: Request): Promise<JsonBody> {
  if (!isJsonContentType(request.headers.get('content-type'))) {
    throw unsupportedMediaType(
      "Content-Type must be 'application/json' for this request"
    );
  }

  const raw = await readCappedText(request, MAX_BODY_BYTES);

  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? null : JSON.parse(raw);
  } catch {
    throw badRequest('Request body is not valid JSON');
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw badRequest('Request body must be a JSON object');
  }

  return { data: parsed as Record<string, unknown>, raw };
}
