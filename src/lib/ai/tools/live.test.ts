import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// n13.7 R9, R11–R15: lecturas en vivo y su caché.

import type { SupabaseClient } from '@supabase/supabase-js';

import {
  AI_LIVE_CACHE_MAX,
  __liveCacheSizeForTests,
  __resetLiveCacheForTests,
  invalidateLiveCache,
  loadLiveData,
} from './live';
import type { AiToolset } from './types';

const db = { tag: 'db' } as unknown as SupabaseClient;
const NOW = new Date('2026-11-10T03:30:00Z');
const SECRET_PARAM = 'LOC-SECRET-77';
const SECRET_DATA = 'PATIENT-DATA-99';

function toolset(
  over: {
    params?: Record<string, string | number | boolean>;
    slug?: string;
  } = {}
): AiToolset {
  const slug = over.slug ?? 'cabbity-health';
  return {
    tools: [
      {
        name: 'cabbity_health__find_availability',
        integrationSlug: slug,
        integrationName: 'Cabbity Health',
        operationKey: 'find_availability',
        method: 'GET',
        description: '',
        parameters: { type: 'object', properties: {} },
        declaredParams: [],
        policy: { grounds: ['schedule'] },
      },
    ],
    integrations: [
      {
        slug,
        name: 'Cabbity Health',
        instructions: null,
        timezone: 'America/Santo_Domingo',
        liveReads: [
          {
            operation: 'find_availability',
            params: over.params ?? {
              location_id: SECRET_PARAM,
              from: '{{today}}',
              to: '{{today+13d}}',
            },
          },
        ],
      },
    ],
  };
}

let clock = 1_000_000;
const nowMs = () => clock;
type ExecInput = { accountId: string; operationKey: string };
type Exec = (db: unknown, input: ExecInput) => Promise<unknown>;
const okExec = () =>
  vi.fn<Exec>(async () => ({
    ok: true as const,
    status: 200,
    data: { data: [{ note: SECRET_DATA }] },
    latencyMs: 1,
  }));
const failExec = () =>
  vi.fn<Exec>(async () => ({
    ok: false as const,
    outcome: 'http_error' as const,
    status: 401,
    latencyMs: 1,
  }));

const load = (
  execute: ReturnType<typeof vi.fn>,
  over: {
    accountId?: string;
    ts?: AiToolset;
    conversationId?: string | null;
  } = {}
) =>
  loadLiveData(
    db,
    {
      accountId: over.accountId ?? 'acct-A',
      toolset: over.ts ?? toolset(),
      conversationId: over.conversationId ?? null,
      now: NOW,
    },
    { execute: execute as never, nowMs }
  );

let spies: ReturnType<typeof vi.spyOn>[];
beforeEach(() => {
  __resetLiveCacheForTests();
  clock = 1_000_000;
  spies = (['info', 'warn', 'error', 'log'] as const).map((m) =>
    vi.spyOn(console, m).mockImplementation(() => {})
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('loadLiveData', () => {
  it('R9: runs with source ai, preload, the conversation and the templates resolved in the zone', async () => {
    const execute = okExec();
    const blocks = await load(execute, { conversationId: 'conv-1' });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0]).toBe(db);
    expect(execute.mock.calls[0][1]).toEqual({
      accountId: 'acct-A',
      integrationSlug: 'cabbity-health',
      operationKey: 'find_availability',
      params: {
        location_id: SECRET_PARAM,
        from: '2026-11-09',
        to: '2026-11-22',
      },
      source: 'ai',
      conversationId: 'conv-1',
      preload: true,
    });
    expect(blocks).toEqual([
      {
        integrationSlug: 'cabbity-health',
        integrationName: 'Cabbity Health',
        operationKey: 'find_availability',
        timeZone: 'America/Santo_Domingo',
        loadedAt: NOW,
        grounds: ['schedule'],
        result: { ok: true, data: { data: [{ note: SECRET_DATA }] } },
      },
    ]);
  });

  it('no live reads → [] without calling', async () => {
    const execute = okExec();
    const ts = toolset();
    ts.integrations[0].liveReads = [];
    expect(await load(execute, { ts })).toEqual([]);
    expect(execute).not.toHaveBeenCalled();
  });

  it('R11: two equal reads within 60 s → one call; at 60 001 ms → another', async () => {
    const execute = okExec();
    await load(execute);
    clock += 59_999;
    const again = await load(execute);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(again[0].result.ok).toBe(true);
    clock += 2; // 60 001 ms después de la primera
    await load(execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('R11: AI_LIVE_DATA_TTL_MS overrides the TTL', async () => {
    vi.stubEnv('AI_LIVE_DATA_TTL_MS', '5000');
    const execute = okExec();
    await load(execute);
    clock += 5001;
    await load(execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('R12: a failure is remembered 10 s and retried after', async () => {
    const execute = failExec();
    const first = await load(execute);
    expect(first[0].result).toEqual({ ok: false });
    clock += 9_999;
    await load(execute);
    expect(execute).toHaveBeenCalledTimes(1);
    clock += 2;
    await load(execute);
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('R13: invalidateLiveCache forces a new call for that account and integration only', async () => {
    const execute = okExec();
    await load(execute);
    await load(execute, { accountId: 'acct-B' });
    invalidateLiveCache('acct-A', 'cabbity-health');
    await load(execute);
    await load(execute, { accountId: 'acct-B' });
    expect(execute.mock.calls.map((c) => c[1].accountId)).toEqual([
      'acct-A',
      'acct-B',
      'acct-A',
    ]);
  });

  it('R14: account A never reuses the entry of B', async () => {
    const execute = okExec();
    await load(execute, { accountId: 'acct-B' });
    await load(execute, { accountId: 'acct-A' });
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it('R14: past 500 entries the oldest is evicted', async () => {
    const execute = okExec();
    for (let i = 0; i <= AI_LIVE_CACHE_MAX; i += 1) {
      await load(execute, { ts: toolset({ params: { location_id: i } }) });
    }
    expect(__liveCacheSizeForTests()).toBe(AI_LIVE_CACHE_MAX);
    expect(execute).toHaveBeenCalledTimes(AI_LIVE_CACHE_MAX + 1);
    // la última sigue en caché; la primera (0) se desalojó
    await load(execute, {
      ts: toolset({ params: { location_id: AI_LIVE_CACHE_MAX } }),
    });
    expect(execute).toHaveBeenCalledTimes(AI_LIVE_CACHE_MAX + 1);
    await load(execute, { ts: toolset({ params: { location_id: 0 } }) });
    expect(execute).toHaveBeenCalledTimes(AI_LIVE_CACHE_MAX + 2);
  });

  it('R15: an execute that throws → a failed block, and the other reads go on', async () => {
    const ts = toolset();
    ts.integrations[0].liveReads!.push({
      operation: 'list_locations',
      params: {},
    });
    const execute = vi.fn(
      async (_db: unknown, input: { operationKey: string }) => {
        if (input.operationKey === 'find_availability')
          throw new Error(SECRET_DATA);
        return { ok: true as const, status: 200, data: [], latencyMs: 1 };
      }
    );
    const blocks = await load(execute as never, { ts });
    expect(blocks.map((b) => [b.operationKey, b.result.ok])).toEqual([
      ['find_availability', false],
      ['list_locations', true],
    ]);
    // sin herramienta en el toolset: sin grounds
    expect(blocks[1].grounds).toEqual([]);
  });

  it('R15: the console never carries params or data', async () => {
    await load(okExec());
    await load(okExec()); // cache
    __resetLiveCacheForTests();
    await load(failExec());
    const logged = JSON.stringify(spies.map((s) => s.mock.calls));
    expect(logged).toContain('[ai live]');
    expect(logged).not.toContain(SECRET_PARAM);
    expect(logged).not.toContain(SECRET_DATA);
    expect(logged).not.toContain('2026-11-09');
  });
});
