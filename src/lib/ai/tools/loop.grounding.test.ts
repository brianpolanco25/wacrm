import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// n13.7 R13, R29, R30, R33, R36–R41: guardias del bucle de herramientas.

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/integrations/execute', () => ({
  executeIntegrationOperation: h.execute,
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { HANDOFF_SENTINEL } from '../defaults';
import { generateReply } from '../generate';
import type { ProviderToolArgs, ProviderToolResult } from '../providers/shared';
import type { AiConfig } from '../types';
import { GROUNDING_RETRY_NOTE } from './grounding';
import { runToolLoop, type ToolLoopArgs, type ToolLoopDeps } from './loop';
import type { OperationAiPolicy } from '@/lib/integrations/types';

import {
  AI_TOOL_MAX_CALLS,
  type AiTool,
  type AiToolset,
  type LiveDataBlock,
  type ToolCall,
} from './types';

const ACCOUNT = 'acct-A';
const SLUG = 'cabbity-health';
const db = { tag: 'db' } as unknown as SupabaseClient;

function config(): AiConfig {
  return {
    provider: 'openai',
    model: 'm',
    apiKey: 'sk',
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
  };
}

function tool(
  key: string,
  method: AiTool['method'],
  policy?: OperationAiPolicy
): AiTool {
  return {
    name: `cabbity_health__${key}`,
    integrationSlug: SLUG,
    integrationName: 'Cabbity Health',
    operationKey: key,
    method,
    description: key,
    parameters: { type: 'object', properties: {} },
    declaredParams: [],
    ...(policy ? { policy } : {}),
  };
}

const SCHEDULE = { grounds: ['schedule' as const] };
const CANCEL_POLICY = {
  requires_prior: [
    ['list_appointments', 'get_appointment'],
    ['find_availability'],
  ],
};

const healthToolset: AiToolset = {
  tools: [
    tool('find_availability', 'GET', SCHEDULE),
    tool('list_appointments', 'GET', SCHEDULE),
    tool('get_appointment', 'GET', SCHEDULE),
    tool('create_appointment', 'POST', SCHEDULE),
    tool('cancel_appointment', 'POST', CANCEL_POLICY),
  ],
  integrations: [
    { slug: SLUG, name: 'Cabbity Health', instructions: null, timezone: null },
  ],
};
const plainToolset: AiToolset = {
  tools: [tool('search', 'GET')],
  integrations: healthToolset.integrations,
};

function round(calls: ToolCall[], text = ''): ProviderToolResult {
  return {
    text,
    toolCalls: calls,
    usage: null,
    assistant: { calls: calls.map((c) => c.id) },
  };
}
const call = (id: string, key: string): ToolCall => ({
  id,
  name: `cabbity_health__${key}`,
  args: {},
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
  vi.fn<(db: unknown, input: Record<string, unknown>) => Promise<unknown>>(
    async () => ({
      ok: true as const,
      status: 200,
      data: [],
      latencyMs: 1,
    })
  );

function run(deps: ToolLoopDeps, over: Partial<ToolLoopArgs> = {}) {
  return runToolLoop(
    {
      config: config(),
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'hola' }],
      toolset: healthToolset,
      db,
      accountId: ACCOUNT,
      mode: 'auto_reply',
      conversationId: 'conv-1',
      ...over,
    },
    { invalidate: vi.fn(), ...deps }
  );
}

const liveOk: LiveDataBlock = {
  integrationSlug: SLUG,
  integrationName: 'Cabbity Health',
  operationKey: 'find_availability',
  timeZone: null,
  loadedAt: new Date(),
  result: { ok: true, data: [] },
  grounds: ['schedule'],
};

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => {
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('destructive guard (R28–R31)', () => {
  it('cancel without prior evidence → policy_requires_prior, no execute, blocked in toolsUsed', async () => {
    const execute = okExec();
    const loadEvidence = vi.fn(async () => []);
    const { fn, seen } = scripted([
      round([call('c1', 'cancel_appointment')]),
      round([], 'Antes de cancelar, ¿quiere ver otras fechas?'),
    ]);
    const r = await run({
      callProvider: fn,
      execute: execute as never,
      loadEvidence,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(seen[1].steps[0].results[0]).toMatchObject({
      callId: 'c1',
      isError: true,
      payload: {
        ok: false,
        outcome: 'policy_requires_prior',
        error: 'policy_requires_prior',
        required: [
          'cabbity_health__list_appointments or cabbity_health__get_appointment',
          'cabbity_health__find_availability',
        ],
      },
    });
    const hint = seen[1].steps[0].results[0].payload.hint as string;
    expect(hint).toMatch(
      /^This action is not allowed yet\. First call: cabbity_health__list_appointments/
    );
    expect(hint).toMatch(/only be done in a later message/);
    expect(r.toolsUsed).toEqual([
      {
        integration: 'Cabbity Health',
        operation: 'cancel_appointment',
        ok: false,
        slug: SLUG,
        blocked: 'policy',
      },
    ]);
  });

  it('with ordered prior evidence → executed with the conversation id', async () => {
    const execute = okExec();
    const loadEvidence = vi.fn(async () => [
      { integrationSlug: SLUG, operationKey: 'get_appointment' },
      { integrationSlug: SLUG, operationKey: 'find_availability' },
    ]);
    const { fn } = scripted([
      round([call('c1', 'cancel_appointment')]),
      round([], 'Cancelada.'),
    ]);
    const r = await run({
      callProvider: fn,
      execute: execute as never,
      loadEvidence,
    });
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][1]).toEqual({
      accountId: ACCOUNT,
      integrationSlug: SLUG,
      operationKey: 'cancel_appointment',
      params: {},
      source: 'ai',
      conversationId: 'conv-1',
    });
    expect(r.toolsUsed[0]).toMatchObject({ ok: true, slug: SLUG });
    expect(loadEvidence).toHaveBeenCalledWith(
      db,
      ACCOUNT,
      'conv-1',
      expect.any(Date)
    );
  });

  it('evidence is loaded once per turn and calls of THIS turn never count', async () => {
    const execute = okExec();
    const loadEvidence = vi.fn(async () => []);
    const { fn, seen } = scripted([
      round([call('c1', 'list_appointments'), call('c2', 'find_availability')]),
      round([call('c3', 'cancel_appointment')]),
      round([], 'Le ofrezco el jueves.'),
    ]);
    await run({ callProvider: fn, execute: execute as never, loadEvidence });
    expect(loadEvidence).toHaveBeenCalledTimes(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(seen[2].steps[1].results[0].payload.outcome).toBe(
      'policy_requires_prior'
    );
  });

  it('R31: evidence loader that throws → empty evidence (blocked)', async () => {
    const execute = okExec();
    const loadEvidence = vi.fn(async () => {
      throw new Error('db');
    });
    const { fn } = scripted([
      round([call('c1', 'cancel_appointment')]),
      round([], 'No puedo aún.'),
    ]);
    const r = await run({
      callProvider: fn,
      execute: execute as never,
      loadEvidence,
    });
    expect(execute).not.toHaveBeenCalled();
    expect(r.toolsUsed[0].blocked).toBe('policy');
  });

  it('R32: the playground priorEvidence replaces the database', async () => {
    const execute = okExec();
    const loadEvidence = vi.fn(async () => []);
    const { fn } = scripted([
      round([call('c1', 'cancel_appointment')]),
      round([], 'Cancelada.'),
    ]);
    await run(
      { callProvider: fn, execute: execute as never, loadEvidence },
      {
        mode: 'playground',
        conversationId: null,
        priorEvidence: [
          { integrationSlug: SLUG, operationKey: 'list_appointments' },
          { integrationSlug: SLUG, operationKey: 'find_availability' },
        ],
      }
    );
    expect(loadEvidence).not.toHaveBeenCalled();
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('R13: a write ok invalidates the live cache of the account and integration', async () => {
    const invalidate = vi.fn();
    const { fn } = scripted([
      round([
        call('c1', 'create_appointment'),
        call('c2', 'find_availability'),
      ]),
      round([], 'Listo, cita creada.'),
    ]);
    await run({
      callProvider: fn,
      execute: okExec() as never,
      invalidate,
      loadEvidence: async () => [],
    });
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(invalidate).toHaveBeenCalledWith(ACCOUNT, SLUG);
  });
});

describe('final text guard (R35–R41)', () => {
  const deps = (rounds: ProviderToolResult[]) => {
    const s = scripted(rounds);
    return {
      s,
      d: {
        callProvider: s.fn,
        execute: okExec() as never,
        loadEvidence: async () => [],
      } satisfies ToolLoopDeps,
    };
  };

  it('schedule text without data → one extra round with the note and toolChoice auto', async () => {
    const { s, d } = deps([
      round([], 'Tenemos el jueves a las 10:00.'),
      round([], 'Déjeme consultar la agenda y le digo.'),
    ]);
    const r = await run(d);
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1].systemPrompt).toBe(`SYS\n\n${GROUNDING_RETRY_NOTE}`);
    expect(s.seen[1].toolChoice).toBe('auto');
    expect(s.seen[1].steps).toEqual([]); // el borrador no se reenvía
    expect(r).toMatchObject({
      text: 'Déjeme consultar la agenda y le digo.',
      grounding: 'retried',
    });
  });

  it('if the extra round calls find_availability ok → its text is returned', async () => {
    const { s, d } = deps([
      round([], 'El jueves a las 10:00.'),
      round([call('c1', 'find_availability')]),
      round([], 'Hay hueco el jueves a las 9:00.'),
    ]);
    const r = await run(d);
    expect(s.seen[2].systemPrompt).toBe('SYS'); // vuelve al prompt original
    expect(r.text).toBe('Hay hueco el jueves a las 9:00.');
    expect(r.grounding).toBe('retried');
  });

  it('if it insists → [[HANDOFF]], grounding handoff, and a warn without the text', async () => {
    const { d } = deps([
      round([], 'El jueves a las 10:00.'),
      round([], 'Seguro: el viernes a las 11:00.'),
    ]);
    const r = await run(d);
    expect(r.text).toBe(HANDOFF_SENTINEL);
    expect(r.grounding).toBe('handoff');
    expect(warn).toHaveBeenCalledWith(
      '[ai grounding]',
      ACCOUNT,
      'auto_reply',
      'handoff'
    );
    expect(JSON.stringify(warn.mock.calls)).not.toContain('viernes');
  });

  it('through generateReply the handoff is a real handoff', async () => {
    const rounds = [
      round([], 'El jueves a las 10:00.'),
      round([], 'El viernes a las 11:00.'),
    ];
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const next = rounds.shift()!;
        return new Response(
          JSON.stringify({
            choices: [{ message: { content: next.text, tool_calls: [] } }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        );
      })
    );
    const r = await generateReply({
      config: config(),
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'hola' }],
      tools: { toolset: healthToolset, db, accountId: ACCOUNT },
      grounding: { mode: 'playground', priorEvidence: [] },
    });
    vi.unstubAllGlobals();
    expect(r).toMatchObject({ text: '', handoff: true, grounding: 'handoff' });
  });

  it('with a live read ok → no extra round', async () => {
    const { s, d } = deps([round([], 'Tenemos el jueves a las 10:00.')]);
    const r = await run(d, { liveData: [liveOk] });
    expect(s.seen).toHaveLength(1);
    expect(r.text).toBe('Tenemos el jueves a las 10:00.');
    expect(r.grounding).toBeUndefined();
  });

  it.each([
    'Estamos en la Av. Churchill, Santo Domingo. La consulta cuesta RD$ 15.00.',
    'Nuestra sede está en Santo Domingo Este; atendemos a las 3 personas del grupo.',
  ])(
    'ronda 2: no schedule claim without data → no extra round (%s)',
    async (text) => {
      const { s, d } = deps([round([], text)]);
      const r = await run(d);
      expect(s.seen).toHaveLength(1);
      expect(r.text).toBe(text);
      expect(r.grounding).toBeUndefined();
    }
  );

  it('ronda 2: «a las 4 de la tarde» without data → one extra round', async () => {
    const { s, d } = deps([
      round([], 'Le agendo mañana a las 4 de la tarde.'),
      round([], 'Déjeme consultar la agenda.'),
    ]);
    const r = await run(d);
    expect(s.seen).toHaveLength(2);
    expect(r.grounding).toBe('retried');
  });

  it('a failed live read does not ground', async () => {
    const { s, d } = deps([
      round([], 'El jueves a las 10:00.'),
      round([], 'Lo consulto.'),
    ]);
    await run(d, { liveData: [{ ...liveOk, result: { ok: false } }] });
    expect(s.seen).toHaveLength(2);
  });

  it('a find_availability ok earlier in the turn grounds the text', async () => {
    const { s, d } = deps([
      round([call('c1', 'find_availability')]),
      round([], 'Hay el jueves a las 10:00.'),
    ]);
    const r = await run(d);
    expect(s.seen).toHaveLength(2);
    expect(r.text).toBe('Hay el jueves a las 10:00.');
  });

  it('R39: draft mode → no guard', async () => {
    const { s, d } = deps([round([], 'El jueves a las 10:00.')]);
    const r = await run(d, { mode: 'draft' });
    expect(s.seen).toHaveLength(1);
    expect(r.text).toBe('El jueves a las 10:00.');
  });

  it('R40: a toolset without grounds behaves as before', async () => {
    const { s, d } = deps([round([], 'El jueves a las 10:00.')]);
    const r = await run(d, { toolset: plainToolset });
    expect(s.seen).toHaveLength(1);
    expect(r).toEqual({
      text: 'El jueves a las 10:00.',
      usage: null,
      toolsUsed: [],
    });
  });

  it('AI_TOOL_MAX_CALLS reached → straight handoff, no extra round', async () => {
    const calls = Array.from({ length: AI_TOOL_MAX_CALLS }, (_, i) =>
      call(`c${i}`, 'list_appointments')
    );
    // Una herramienta sin grounds, para que las 8 llamadas no fundamenten.
    const ts: AiToolset = {
      tools: [...healthToolset.tools, tool('search', 'GET')],
      integrations: healthToolset.integrations,
    };
    const searchCalls = calls.map((c) => ({
      ...c,
      name: 'cabbity_health__search',
    }));
    const { s, d } = deps([
      round(searchCalls),
      round([], 'El jueves a las 10:00.'),
    ]);
    const r = await run(d, { toolset: ts });
    expect(s.seen).toHaveLength(2);
    expect(s.seen[1].toolChoice).toBe('none');
    expect(r.text).toBe(HANDOFF_SENTINEL);
    expect(r.grounding).toBe('handoff');
  });

  it('R41: no provider call ever gets a toolChoice other than auto or none', async () => {
    const { s, d } = deps([
      round([], 'El jueves a las 10:00.'),
      round([call('c1', 'find_availability')]),
      round([], 'Hay el jueves.'),
    ]);
    await run(d);
    for (const a of s.seen) expect(['auto', 'none']).toContain(a.toolChoice);
  });

  it('a [[HANDOFF]] text is not guarded', async () => {
    const { s, d } = deps([round([], `${HANDOFF_SENTINEL} el jueves`)]);
    await run(d);
    expect(s.seen).toHaveLength(1);
  });
});
