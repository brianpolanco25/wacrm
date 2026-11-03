// ============================================================
// Núcleo de red de las integraciones (n13.1, R22–R26).
//
// Único sitio que hace la petición saliente. En orden:
//
//   1. cubo `integrationCall:<accountId>` (60/min, D6) → `rate_limited`;
//   2. literal privado (también IPv4-mapped en hex, `[::ffff:7f00:1]`) o
//      nombre interno, y `isDeliverableUrl` sobre la URL final → `blocked`
//      sin `fetch`;
//   3. `fetch` con `redirect: 'manual'` (un 3xx no se sigue: podría
//      rebotar a una IP interna) y un plazo de 10 s que cubre también la
//      lectura del cuerpo → `timeout`;
//   4. cuerpo de como mucho 256 KiB: `content-length` mayor, o el stream
//      que lo supere, se cancela → `too_large`.
//
// No registra nada ni escribe en consola: quien llama (execute.ts) decide
// qué guardar, y nunca guarda cuerpos ni cabeceras (R20).
// ============================================================

import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

import { isForbiddenHost } from './catalog-validate';
import type { BuiltRequest } from './request';
import {
  INTEGRATION_MAX_RESPONSE_BYTES,
  INTEGRATION_TIMEOUT_MS,
} from './types';

export interface IntegrationHttpDeps {
  /** Tests: sustituye al `fetch` global. */
  fetch?: typeof fetch;
  /** Por defecto `isDeliverableUrl`. */
  isDeliverable?: (url: string) => Promise<boolean>;
  now?: () => number;
}

export type HttpOutcome =
  | 'ok'
  | 'http_error'
  | 'timeout'
  | 'too_large'
  | 'unreachable'
  | 'blocked'
  | 'rate_limited';

export interface HttpResult {
  outcome: HttpOutcome;
  status: number | null;
  data: unknown;
  latencyMs: number;
}

class TooLarge extends Error {}

async function cancelBody(res: Response): Promise<void> {
  try {
    await res.body?.cancel();
  } catch {
    // El cuerpo ya estaba cerrado o bloqueado: nada que liberar.
  }
}

/** Lee el cuerpo entero sin pasar de `max` bytes. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      try {
        await reader.cancel();
      } catch {
        // ignorado: lo que importa es dejar de leer
      }
      throw new TooLarge();
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export async function performIntegrationRequest(
  accountId: string,
  req: BuiltRequest,
  deps: IntegrationHttpDeps = {}
): Promise<HttpResult> {
  const now = deps.now ?? Date.now;
  const started = now();
  const done = (
    outcome: HttpOutcome,
    status: number | null,
    data: unknown = null
  ) => ({
    outcome,
    status,
    data,
    latencyMs: Math.max(0, Math.round(now() - started)),
  });

  const limit = checkRateLimit(
    `integrationCall:${accountId}`,
    RATE_LIMITS.integrationCall
  );
  if (!limit.success) return done('rate_limited', null);

  // Literal privado o nombre interno: fuera sin preguntar al resolutor
  // (también cuando un test o un llamador inyecta el suyo).
  let hostname: string;
  try {
    hostname = new URL(req.url).hostname;
  } catch {
    return done('blocked', null);
  }
  if (isForbiddenHost(hostname)) return done('blocked', null);

  const isDeliverable = deps.isDeliverable ?? isDeliverableUrl;
  if (!(await isDeliverable(req.url))) return done('blocked', null);

  const doFetch = deps.fetch ?? fetch;
  // Plazo propio (no `AbortSignal.timeout`) para que cubra también la
  // lectura del cuerpo y para que los relojes simulados de los tests lo
  // controlen.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), INTEGRATION_TIMEOUT_MS);
  try {
    let res: Response;
    try {
      res = await doFetch(req.url, {
        method: req.method,
        headers: req.headers,
        body: req.body,
        redirect: 'manual',
        signal: controller.signal,
      });
    } catch {
      return done(controller.signal.aborted ? 'timeout' : 'unreachable', null);
    }

    // 3xx (no seguido) y cualquier no-2xx: el cuerpo se descarta.
    if (res.status < 200 || res.status >= 300) {
      await cancelBody(res);
      return done('http_error', res.status);
    }

    const declared = Number(res.headers.get('content-length'));
    if (
      Number.isFinite(declared) &&
      declared > INTEGRATION_MAX_RESPONSE_BYTES
    ) {
      await cancelBody(res);
      return done('too_large', res.status);
    }

    let bytes: Uint8Array;
    try {
      bytes = await readCapped(res, INTEGRATION_MAX_RESPONSE_BYTES);
    } catch (err) {
      if (err instanceof TooLarge) return done('too_large', res.status);
      return done(
        controller.signal.aborted ? 'timeout' : 'unreachable',
        res.status
      );
    }

    const text = new TextDecoder().decode(bytes);
    const type = res.headers.get('content-type') ?? '';
    if (!type.toLowerCase().includes('json'))
      return done('ok', res.status, text);
    if (text.trim() === '') return done('ok', res.status, null);
    try {
      return done('ok', res.status, JSON.parse(text));
    } catch {
      return done('http_error', res.status);
    }
  } finally {
    clearTimeout(timer);
  }
}
