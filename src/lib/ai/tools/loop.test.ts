import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// n13.3 R15, R17–R22, R29, R37: el bucle de herramientas.

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/integrations/execute', () => ({
  executeIntegrationOperation: h.execute,
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { HANDOFF_SENTINEL } from '../defaults';
import { generateReply } from '../generate';
import type { ProviderToolArgs, ProviderToolResult } from '../providers/shared';
import { AiError, type AiConfig, type AiUsage } from '../types';
import { runToolLoop, type ToolLoopDeps } from './loop';
import {
  INVALID_ARGS,
  type AiTool,
  type AiToolset,
  type ToolCall,
} from './types';

const ACCOUNT = 'acct-A';
const db = { tag: 'db' } as unknown as SupabaseClient;

function config(over: Partial<AiConfig> = {}): AiConfig {
  return {
    provider: 'anthropic',
    model: 'm',
    apiKey: 'sk-provider',
    keySource: 'account',
    systemPrompt: null,
    isActive: true,
    autoReplyEnabled: true,
    autoReplyMaxPerConversation: 3,
    handoffMode: 'queue',
    handoffAgentId: null,
    handoffMessage: null,
    embeddingsApiKey: null,
    embeddingsProvider: 'openai',
    ...over,
  };
}

function tool(key: string): AiTool {
  return {
    name: `health__${key}`,
    integrationSlug: 'health',
    integrationName: 'Cabbity Health',
    operationKey: key,
    method: 'GET',
    description: key,
    parameters: { type: 'object', properties: {} },
    declaredParams: [
      {
        name: 'doc',
        in: 'query',
        type: 'string',
        required: true,
        description: '',
      },
    ],
  };
}

const toolset: AiToolset = {
  tools: [tool('search'), tool('create')],
  integrations: [
    {
      slug: 'health',
      name: 'Cabbity Health',
      instructions: null,
      timezone: null,
    },
  ],
};

function round(
  calls: ToolCall[],
  text = '',
  usage: AiUsage | null = null
): ProviderToolResult {
  return {
    text,
    toolCalls: calls,
    usage,
    assistant: { calls: calls.map((c) => c.id) },
  };
}

const call = (
  id: string,
  name = 'health__search',
  args: unknown = { doc: '1' }
): ToolCall => ({
  id,
  name,
  args,
});

function scripted(rounds: ProviderToolResult[]) {
  const seen: ProviderToolArgs[] = [];
  const fn = vi.fn(async (_p: string, a: ProviderToolArgs) => {
    seen.push(a);
    const next = rounds.shift();
    if (!next) throw new Error('no more rounds');
    return next;
  });
  return { fn, seen };
}

const okExec = () =>
  vi.fn(async () => ({
    ok: true as const,
    status: 200,
    data: { id: 1 },
    latencyMs: 1,
  }));

function run(deps: ToolLoopDeps, ts: AiToolset = toolset) {
  return runToolLoop(
    {
      config: config(),
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      toolset: ts,
      db,
      accountId: ACCOUNT,
    },
    deps
  );
}

beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('runToolLoop', () => {
  it('executes calls in order, one at a time, with source ai and the account', async () => {
    const order: string[] = [];
    let running = 0;
    const execute = vi.fn(
      async (_db: unknown, input: { operationKey: string }) => {
        running += 1;
        expect(running).toBe(1);
        await new Promise((r) => setTimeout(r, 1));
        order.push(input.operationKey);
        running -= 1;
        return {
          ok: true as const,
          status: 200,
          data: { k: input.operationKey },
          latencyMs: 1,
        };
      }
    );
    const { fn, seen } = scripted([
      round([
        call('c1', 'health__create', { doc: 'x' }),
        call('c2', 'health__search', { doc: { a: 1 } }),
      ]),
      round([], 'Listo'),
    ]);
    const r = await run({ callProvider: fn, execute: execute as never });
    expect(order).toEqual(['create', 'search']);
    expect(execute.mock.calls[0][0]).toBe(db);
    expect(execute.mock.calls[0][1]).toEqual({
      accountId: ACCOUNT,
      integrationSlug: 'health',
      operationKey: 'create',
      params: { doc: 'x' },
      source: 'ai',
    });
    expect(execute.mock.calls[1][1]).toMatchObject({ params: { 'doc.a': 1 } });
    expect(r).toEqual({
      text: 'Listo',
      usage: null,
      toolsUsed: [
        { integration: 'Cabbity Health', operation: 'create', ok: true },
        { integration: 'Cabbity Health', operation: 'search', ok: true },
      ],
    });
    // Round 2 carries the native assistant turn and both results.
    expect(seen[1].steps).toEqual([
      {
        assistant: { calls: ['c1', 'c2'] },
        results: [
          {
            callId: 'c1',
            name: 'health__create',
            isError: false,
            payload: { ok: true, status: 200, data: { k: 'create' } },
          },
          {
            callId: 'c2',
            name: 'health__search',
            isError: false,
            payload: { ok: true, status: 200, data: { k: 'search' } },
          },
        ],
      },
    ]);
    expect(seen[0].toolChoice).toBe('auto');
    expect(seen[0].tools.map((t) => t.name)).toEqual([
      'health__search',
      'health__create',
    ]);
  });

  it('unknown tool and invalid arguments answer an error without the executor', async () => {
    const execute = okExec();
    const { fn, seen } = scripted([
      round([
        call('c1', 'evil__drop'),
        call('c2', 'health__search', INVALID_ARGS),
      ]),
      round([], 'ok'),
    ]);
    const r = await run({ callProvider: fn, execute: execute as never });
    expect(execute).not.toHaveBeenCalled();
    expect(
      seen[1].steps[0].results.map((x) => [x.isError, x.payload.outcome])
    ).toEqual([
      [true, 'unknown_tool'],
      [true, 'invalid_arguments'],
    ]);
    expect(r.toolsUsed).toEqual([]);
  });

  it('after 5 rounds with calls the 6th is final with toolChoice none', async () => {
    const execute = okExec();
    const rounds = Array.from({ length: 5 }, (_, i) => round([call(`c${i}`)]));
    rounds.push(round([call('ignored')], 'Final'));
    const { fn, seen } = scripted(rounds);
    const r = await run({ callProvider: fn, execute: execute as never });
    expect(fn).toHaveBeenCalledTimes(6);
    expect(seen.map((s) => s.toolChoice)).toEqual([
      'auto',
      'auto',
      'auto',
      'auto',
      'auto',
      'none',
    ]);
    expect(execute).toHaveBeenCalledTimes(5);
    expect(r.text).toBe('Final');
  });

  it('the 9th call gets limit_reached and the next round is final', async () => {
    const execute = okExec();
    const nine = Array.from({ length: 9 }, (_, i) => call(`c${i}`));
    const { fn, seen } = scripted([round(nine), round([], 'Done')]);
    const r = await run({ callProvider: fn, execute: execute as never });
    expect(execute).toHaveBeenCalledTimes(8);
    const results = seen[1].steps[0].results;
    expect(results[8].payload.outcome).toBe('limit_reached');
    expect(results[7].isError).toBe(false);
    expect(seen[1].toolChoice).toBe('none');
    expect(r.toolsUsed).toHaveLength(8);
  });

  it('past the 40 s budget the next round is final', async () => {
    let t = 0;
    const execute = vi.fn(async () => {
      t += 40_001;
      return { ok: true as const, status: 200, data: 1, latencyMs: 1 };
    });
    const { fn, seen } = scripted([round([call('c1')]), round([], 'late')]);
    await run({ callProvider: fn, execute: execute as never, now: () => t });
    expect(seen[1].toolChoice).toBe('none');
  });

  it('AI_TOOL_BUDGET_MS changes the budget', async () => {
    vi.stubEnv('AI_TOOL_BUDGET_MS', '100');
    let t = 0;
    const execute = vi.fn(async () => {
      t += 101;
      return { ok: true as const, status: 200, data: 1, latencyMs: 1 };
    });
    const { fn, seen } = scripted([round([call('c1')]), round([], 'x')]);
    await run({ callProvider: fn, execute: execute as never, now: () => t });
    expect(seen[1].toolChoice).toBe('none');

    vi.stubEnv('AI_TOOL_BUDGET_MS', '1000');
    t = 0;
    const second = scripted([round([call('c1')]), round([], 'x')]);
    await run({
      callProvider: second.fn,
      execute: execute as never,
      now: () => t,
    });
    expect(second.seen[1].toolChoice).toBe('auto');
  });

  it('only the last round text is the answer', async () => {
    const { fn } = scripted([
      round([call('c1')], 'Let me check'),
      round([], 'Your doctor is Ana'),
    ]);
    const r = await run({ callProvider: fn, execute: okExec() as never });
    expect(r.text).toBe('Your doctor is Ana');
  });

  it('an executor that throws gives the model an error payload and goes on', async () => {
    const execute = vi.fn(async () => {
      throw new Error('boom with secret');
    });
    const { fn, seen } = scripted([round([call('c1')]), round([], 'Sorry')]);
    const r = await run({ callProvider: fn, execute: execute as never });
    expect(seen[1].steps[0].results[0]).toMatchObject({
      isError: true,
      payload: { outcome: 'error' },
    });
    expect(r).toMatchObject({
      text: 'Sorry',
      toolsUsed: [{ operation: 'search', ok: false }],
    });
  });

  it('a provider AiError in round 2 propagates (calls already ran)', async () => {
    const execute = okExec();
    const fn = vi
      .fn()
      .mockResolvedValueOnce(round([call('c1')]))
      .mockRejectedValueOnce(
        new AiError('down', { code: 'timeout', status: 504 })
      );
    await expect(
      run({ callProvider: fn, execute: execute as never })
    ).rejects.toMatchObject({
      code: 'timeout',
    });
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('a provider AiError after earlier rounds carries their usage (finding 6)', async () => {
    const u = (p: number, c: number) => ({
      promptTokens: p,
      completionTokens: c,
      totalTokens: p + c,
    });
    const fn = vi
      .fn()
      .mockResolvedValueOnce(round([call('c1')], '', u(10, 1)))
      .mockResolvedValueOnce(round([call('c2')], '', u(20, 2)))
      .mockRejectedValueOnce(new AiError('down', { code: 'timeout' }));
    const err = await run({
      callProvider: fn,
      execute: okExec() as never,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AiError);
    expect((err as AiError).usage).toEqual(u(30, 3));

    // A failure in the first round has nothing to carry.
    const first = await run({
      callProvider: vi.fn().mockRejectedValue(new AiError('x')),
      execute: okExec() as never,
    }).catch((e: unknown) => e);
    expect((first as AiError).usage).toBeNull();
  });

  it('sums usage over all rounds; null when none reported', async () => {
    const u = (p: number, c: number) => ({
      promptTokens: p,
      completionTokens: c,
      totalTokens: p + c,
    });
    const { fn } = scripted([
      round([call('c1')], '', u(10, 1)),
      round([call('c2')], '', null),
      round([], 'x', u(30, 3)),
    ]);
    const r = await run({ callProvider: fn, execute: okExec() as never });
    expect(r.usage).toEqual({
      promptTokens: 40,
      completionTokens: 4,
      totalTokens: 44,
    });

    const none = scripted([round([call('c1')]), round([], 'x')]);
    expect(
      (await run({ callProvider: none.fn, execute: okExec() as never })).usage
    ).toBeNull();
  });

  it('console never carries arguments, response bodies or result text (R29)', async () => {
    const ARG = 'cedula-00112345678';
    const DATA = 'patient-secret-name';
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        data: { name: DATA },
        latencyMs: 1,
      })
      .mockResolvedValueOnce({
        ok: false,
        outcome: 'http_error',
        status: 422,
        latencyMs: 1,
        remoteError: { code: 'x', message: DATA },
      })
      .mockRejectedValueOnce(new Error(DATA));
    const { fn } = scripted([
      round([
        call('c1', 'health__search', { doc: ARG }),
        call('c2', 'health__create', { doc: ARG }),
        call('c3', 'health__search', { doc: ARG }),
      ]),
      round([], 'x'),
    ]);
    await run({ callProvider: fn, execute: execute as never });
    const logged = JSON.stringify([
      ...(console.info as unknown as { mock: { calls: unknown[] } }).mock.calls,
      ...(console.error as unknown as { mock: { calls: unknown[] } }).mock
        .calls,
    ]);
    expect(logged).toContain(ACCOUNT);
    expect(logged).toContain('http_error');
    expect(logged).not.toContain(ARG);
    expect(logged).not.toContain(DATA);
    expect(logged).not.toContain('sk-provider');
  });
});

describe('runToolLoop — weekday of dates (n13.9)', () => {
  it('annotates tool results in the time zone of the integration', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: [{ starts_at: '2026-11-13T23:30:00-04:00' }],
      latencyMs: 1,
    }));
    const { fn, seen } = scripted([round([call('c1')]), round([], 'x')]);
    const madrid: AiToolset = {
      ...toolset,
      integrations: [{ ...toolset.integrations[0], timezone: 'Europe/Madrid' }],
    };
    // n13.11: un `now` fijo lejos de la fecha, sin etiqueta relativa.
    await run(
      {
        callProvider: fn,
        execute: execute as never,
        now: () => Date.parse('2027-01-01T00:00:00Z'),
      },
      madrid
    );
    expect(seen[1].steps[0].results[0].payload.data).toEqual([
      {
        starts_at: '2026-11-13T23:30:00-04:00',
        starts_at_local: 'Saturday 2026-11-14 04:30 (+01:00)',
      },
    ]);
  });
});

describe('runToolLoop — weekday guard (n13.11)', () => {
  // Jueves 12 de noviembre de 2026, 15:00 en Santo Domingo.
  const NOW = Date.parse('2026-11-12T15:00:00-04:00');
  const sd: AiToolset = {
    ...toolset,
    integrations: [
      { ...toolset.integrations[0], timezone: 'America/Santo_Domingo' },
    ],
  };

  it('fixes the weekday of the final text and warns, in auto_reply', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn } = scripted([
      round([], 'Mañana jueves 13 de noviembre a las 2:00 p.m.'),
    ]);
    const r = await run({ callProvider: fn, now: () => NOW }, sd);
    expect(r.text).toBe('Mañana viernes 13 de noviembre a las 2:00 p.m.');
    expect(warn).toHaveBeenCalledWith('[ai weekday-fix]', ACCOUNT, 1);
  });

  it('also in draft', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn } = scripted([round([], 'Jueves 13 de noviembre')]);
    const r = await runToolLoop(
      {
        config: config(),
        systemPrompt: 'SYS',
        messages: [{ role: 'user', content: 'hi' }],
        toolset: sd,
        db,
        accountId: ACCOUNT,
        mode: 'draft',
      },
      { callProvider: fn, now: () => NOW }
    );
    expect(r.text).toBe('Viernes 13 de noviembre');
  });

  it('uses the local date of the zone, not UTC, late at night', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // 21:30 en Santo Domingo = viernes 13 en UTC: «mañana» sigue siendo el 13.
    const late = Date.parse('2026-11-12T21:30:00-04:00');
    const { fn } = scripted([round([], 'mañana jueves')]);
    const r = await run({ callProvider: fn, now: () => late }, sd);
    expect(r.text).toBe('mañana viernes');
  });

  it('a right text is returned as is, without a warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = 'Mañana viernes 13 de noviembre a las 2:00 p.m.';
    const { fn } = scripted([round([], text)]);
    const r = await run({ callProvider: fn, now: () => NOW }, sd);
    expect(r.text).toBe(text);
    expect(warn).not.toHaveBeenCalled();
  });

  it('H2: without a valid zone, a relative day is not touched at night', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Jueves 21:00 en Santo Domingo = viernes 01:00 UTC; «mañana viernes» es correcto.
    const late = Date.parse('2026-11-12T21:00:00-04:00');
    const { fn } = scripted([
      round([], 'mañana viernes; el jueves 13 de noviembre no hay'),
    ]);
    const r = await run({ callProvider: fn, now: () => late }, toolset);
    // La fecha explícita sí se corrige (13-nov-2026 es viernes).
    expect(r.text).toBe('mañana viernes; el viernes 13 de noviembre no hay');
    expect(warn).toHaveBeenCalledWith('[ai weekday-fix]', ACCOUNT, 1);
  });

  it('H3: a disagreement is left as is and warned as conflict', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const text = 'mañana viernes 14 de noviembre';
    const { fn } = scripted([round([], text)]);
    const r = await run({ callProvider: fn, now: () => NOW }, sd);
    expect(r.text).toBe(text);
    expect(warn).toHaveBeenCalledWith(
      '[ai weekday-fix]',
      ACCOUNT,
      'conflict',
      1
    );
  });

  it('the handoff text is never touched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { fn } = scripted([
      round([], `${HANDOFF_SENTINEL} jueves 13 de noviembre`),
    ]);
    const r = await run({ callProvider: fn, now: () => NOW }, sd);
    expect(r.text).toBe(`${HANDOFF_SENTINEL} jueves 13 de noviembre`);
    expect(warn).not.toHaveBeenCalled();
  });

  it('tool results carry the relative day of the turn', async () => {
    const execute = vi.fn(async () => ({
      ok: true as const,
      status: 200,
      data: [{ starts_at: '2026-11-13T14:00:00-04:00' }],
      latencyMs: 1,
    }));
    const { fn, seen } = scripted([round([call('c1')]), round([], 'x')]);
    await run(
      { callProvider: fn, execute: execute as never, now: () => NOW },
      sd
    );
    expect(seen[1].steps[0].results[0].payload.data).toEqual([
      {
        starts_at: '2026-11-13T14:00:00-04:00',
        starts_at_local: 'Friday 2026-11-13 (tomorrow) 14:00 (-04:00)',
      },
    ]);
  });
});

describe('generateReply with tools', () => {
  function openAi(json: unknown): Response {
    return {
      ok: true,
      status: 200,
      json: async () => json,
    } as unknown as Response;
  }

  it('[[HANDOFF]] in the final round → handoff true, toolsUsed present', async () => {
    h.execute.mockResolvedValue({
      ok: true,
      status: 200,
      data: [],
      latencyMs: 1,
    });
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(
        openAi({
          choices: [
            {
              message: {
                role: 'assistant',
                content: null,
                tool_calls: [
                  {
                    id: 'c1',
                    type: 'function',
                    function: {
                      name: 'health__search',
                      arguments: '{"doc":"1"}',
                    },
                  },
                ],
              },
              finish_reason: 'tool_calls',
            },
          ],
          usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 },
        })
      )
      .mockResolvedValueOnce(
        openAi({
          choices: [
            {
              message: { role: 'assistant', content: '[[HANDOFF]]' },
              finish_reason: 'stop',
            },
          ],
          usage: { prompt_tokens: 20, completion_tokens: 1, total_tokens: 21 },
        })
      );
    vi.stubGlobal('fetch', fetchSpy);
    const r = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      tools: { toolset, db, accountId: ACCOUNT },
    });
    expect(r).toEqual({
      text: '',
      handoff: true,
      usage: { promptTokens: 30, completionTokens: 3, totalTokens: 33 },
      toolsUsed: [
        { integration: 'Cabbity Health', operation: 'search', ok: true },
      ],
    });
    expect(h.execute.mock.calls[0][1]).toMatchObject({
      accountId: ACCOUNT,
      source: 'ai',
    });
  });

  it('an empty toolset takes the plain path (no toolsUsed)', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          openAi({ choices: [{ message: { content: 'Hola' } }] })
        )
    );
    const r = await generateReply({
      config: config({ provider: 'openai' }),
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'hi' }],
      tools: {
        toolset: { tools: [], integrations: [] },
        db,
        accountId: ACCOUNT,
      },
    });
    expect(r).toEqual({ text: 'Hola', handoff: false, usage: null });
    const body = JSON.parse(
      ((vi.mocked(fetch).mock.calls[0] as unknown[])[1] as RequestInit)
        .body as string
    );
    expect(body).not.toHaveProperty('tools');
  });
});
