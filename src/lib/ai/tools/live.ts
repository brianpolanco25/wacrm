// ============================================================
// Lecturas en vivo antes de cada turno de IA (n13.7, R9, R11–R15).
//
// Por cada integración del toolset, sus lecturas configuradas (operación
// `GET` + parámetros fijos con plantillas de fecha) se ejecutan EN
// PARALELO con el ejecutor común (`source: 'ai'`, `preload: true`) y el
// resultado se guarda en una caché de proceso corta: 60 s si fue `ok`
// (`AI_LIVE_DATA_TTL_MS`), 10 s si falló. La clave lleva la cuenta: dos
// cuentas nunca comparten entrada (R14).
//
// Nunca lanza (R15). Consola: cuenta, slug, key y outcome; nunca
// parámetros ni datos.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { executeIntegrationOperation } from '@/lib/integrations/execute';
import type { AiGroundClaim } from '@/lib/integrations/types';

import { resolveLiveParams } from './live-templates';
import {
  AI_LIVE_DATA_DEFAULT_TTL_MS,
  AI_LIVE_DATA_FAIL_TTL_MS,
  type AiToolset,
  type LiveDataBlock,
} from './types';

/** R14: entradas como mucho en la caché de proceso. */
export const AI_LIVE_CACHE_MAX = 500;

interface CacheEntry {
  expiresAt: number;
  loadedAt: Date;
  result: LiveDataBlock['result'];
}

const cache = new Map<string, CacheEntry>();

/** R11: vida de un resultado `ok`. Override con `AI_LIVE_DATA_TTL_MS`. */
export function aiLiveDataTtlMs(): number {
  const raw = Number(process.env.AI_LIVE_DATA_TTL_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : AI_LIVE_DATA_DEFAULT_TTL_MS;
}

/** JSON con claves ordenadas: el orden de los parámetros no cambia la clave. */
function stableJson(params: Record<string, string | number | boolean>): string {
  return JSON.stringify(
    Object.keys(params)
      .sort()
      .map((k) => [k, params[k]])
  );
}

function cacheKey(
  accountId: string,
  slug: string,
  operation: string,
  params: Record<string, string | number | boolean>
): string {
  return `${accountId}\u0000${slug}\u0000${operation}\u0000${stableJson(params)}`;
}

function remember(key: string, entry: CacheEntry): void {
  cache.delete(key);
  cache.set(key, entry);
  // R14: la más antigua primero (orden de inserción del Map).
  while (cache.size > AI_LIVE_CACHE_MAX) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** R13: tras una escritura `ok`, las lecturas de esa cuenta e integración caducan. */
export function invalidateLiveCache(
  accountId: string,
  integrationSlug: string
): void {
  const prefix = `${accountId}\u0000${integrationSlug}\u0000`;
  for (const key of [...cache.keys()]) {
    if (key.startsWith(prefix)) cache.delete(key);
  }
}

export function __resetLiveCacheForTests(): void {
  cache.clear();
}

export function __liveCacheSizeForTests(): number {
  return cache.size;
}

export interface LiveDataDeps {
  execute?: typeof executeIntegrationOperation;
  /** Reloj de la caché (tests). */
  nowMs?: () => number;
}

/**
 * R9: los bloques de datos en vivo del turno, en el orden del toolset y
 * de la configuración. Sin lecturas configuradas, `[]`.
 */
export async function loadLiveData(
  db: SupabaseClient,
  input: {
    accountId: string;
    toolset: AiToolset;
    conversationId: string | null;
    now: Date;
  },
  deps: LiveDataDeps = {}
): Promise<LiveDataBlock[]> {
  const execute = deps.execute ?? executeIntegrationOperation;
  const nowMs = deps.nowMs ?? Date.now;
  const jobs: Promise<LiveDataBlock>[] = [];

  for (const integration of input.toolset.integrations) {
    for (const read of integration.liveReads ?? []) {
      jobs.push(
        (async (): Promise<LiveDataBlock> => {
          const tool = input.toolset.tools.find(
            (t) =>
              t.integrationSlug === integration.slug &&
              t.operationKey === read.operation
          );
          const grounds: AiGroundClaim[] = [...(tool?.policy?.grounds ?? [])];
          const base = {
            integrationSlug: integration.slug,
            integrationName: integration.name,
            operationKey: read.operation,
            timeZone: integration.timezone,
            grounds,
          };
          const log = (outcome: string) =>
            console.info(
              '[ai live]',
              input.accountId,
              integration.slug,
              read.operation,
              outcome
            );
          try {
            const params = resolveLiveParams(
              read.params,
              input.now,
              integration.timezone
            );
            const key = cacheKey(
              input.accountId,
              integration.slug,
              read.operation,
              params
            );
            const hit = cache.get(key);
            if (hit && hit.expiresAt > nowMs()) {
              log(hit.result.ok ? 'cache' : 'cache_failed');
              return { ...base, loadedAt: hit.loadedAt, result: hit.result };
            }
            const loadedAt = input.now;
            let result: LiveDataBlock['result'];
            try {
              const res = await execute(db, {
                accountId: input.accountId,
                integrationSlug: integration.slug,
                operationKey: read.operation,
                params,
                source: 'ai',
                conversationId: input.conversationId,
                preload: true,
              });
              result = res.ok ? { ok: true, data: res.data } : { ok: false };
              log(res.ok ? 'ok' : res.outcome);
            } catch {
              result = { ok: false };
              log('threw');
            }
            remember(key, {
              expiresAt:
                nowMs() +
                (result.ok ? aiLiveDataTtlMs() : AI_LIVE_DATA_FAIL_TTL_MS),
              loadedAt,
              result,
            });
            return { ...base, loadedAt, result };
          } catch {
            log('threw');
            return { ...base, loadedAt: input.now, result: { ok: false } };
          }
        })()
      );
    }
  }
  if (jobs.length === 0) return [];
  return Promise.all(jobs);
}
