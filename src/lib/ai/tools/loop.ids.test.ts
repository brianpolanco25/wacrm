import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// p16.4 D1: un id protegido solo se usa si una herramienta lo devolvió en
// esta conversación.

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/integrations/execute', () => ({
  executeIntegrationOperation: h.execute,
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import type { OperationParam } from '@/lib/integrations/types';

import type { ProviderToolResult } from '../providers/shared';
import type { AiConfig } from '../types';
import { __resetIdCacheForTests } from './ids';
import { runToolLoop } from './loop';
import type { AiTool, AiToolset, ToolCall } from './types';

const db = { tag: 'db' } as unknown as SupabaseClient;

const config = {
  provider: 'anthropic',
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
} as AiConfig;

const p = (
  name: string,
  where: OperationParam['in'],
  type: OperationParam['type'] = 'string'
): OperationParam => ({
  name,
  in: where,
  type,
  required: true,
  description: '',
});

function tool(
  key: string,
  method: AiTool['method'],
  params: OperationParam[]
): AiTool {
  return {
    name: `health__${key}`,
    integrationSlug: 'health',
    integrationName: 'Cabbity Health',
    operationKey: key,
    method,
    description: key,
    parameters: { type: 'object', properties: {} },
    declaredParams: params,
  };
}

const toolset: AiToolset = {
  tools: [
    tool('lookup_patient', 'GET', [p('phone', 'query')]),
    tool('list_appointments', 'GET', [p('patient_id', 'query', 'integer')]),
    tool('cancel_appointment', 'POST', [
      p('appointment_id', 'path', 'integer'),
      p('reason', 'body'),
    ]),
  ],
  integrations: [
    { slug: 'health', name: 'Health', instructions: null, timezone: null },
  ],
};

// Lo que devuelve la integración por operación.
const DATA: Record<string, unknown> = {
  lookup_patient: { data: { source: 'center', matches: [{ id: 88 }] } },
  list_appointments: {
    data: [{ id: 1234, patient_id: 88, starts_at: '2026-11-21T10:00:00Z' }],
  },
  cancel_appointment: { data: { id: 1234, status: 'cancelled' } },
};

const call = (id: string, key: string, args: unknown): ToolCall => ({
  id,
  name: `health__${key}`,
  args,
});

function round(calls: ToolCall[], text = ''): ProviderToolResult {
  return {
    text,
    toolCalls: calls,
    usage: null,
    assistant: { calls: calls.map((c) => c.id) },
  };
}

function run(
  rounds: ProviderToolResult[],
  opts: { accountId?: string; conversationId?: string | null } = {}
) {
  const seen: Record<string, unknown>[][] = [];
  return runToolLoop(
    {
      config,
      systemPrompt: 'SYS',
      messages: [{ role: 'user', content: 'cancela la cita 1234' }],
      toolset,
      db,
      accountId: opts.accountId ?? 'acct-A',
      conversationId:
        opts.conversationId === undefined ? 'conv-1' : opts.conversationId,
    },
    {
      invalidate: () => {},
      callProvider: async (_p, a) => {
        seen.push(a.steps.flatMap((s) => s.results.map((r) => r.payload)));
        const next = rounds.shift();
        if (!next) throw new Error('no more rounds');
        return next;
      },
    }
  ).then((r) => ({ ...r, seen }));
}

const cancel = (id: string, appt: unknown = 1234) =>
  call(id, 'cancel_appointment', { appointment_id: appt, reason: 'x' });
const executedKeys = () =>
  h.execute.mock.calls.map(
    (c) => (c[1] as { operationKey: string }).operationKey
  );

beforeEach(() => {
  __resetIdCacheForTests();
  h.execute.mockReset();
  h.execute.mockImplementation(
    async (_db: unknown, a: { operationKey: string }) => ({
      ok: true,
      status: 200,
      data: DATA[a.operationKey],
      latencyMs: 1,
    })
  );
  vi.spyOn(console, 'info').mockImplementation(() => {});
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('runToolLoop — id guard (p16.4 D1)', () => {
  it('an id the customer typed is not executed; the model is told to look it up', async () => {
    const r = await run([round([cancel('c1')]), round([], 'No pude.')]);
    expect(h.execute).not.toHaveBeenCalled();
    expect(r.seen[1][0]).toMatchObject({ ok: false, outcome: 'unverified_id' });
    expect(r.toolsUsed).toEqual([
      expect.objectContaining({ operation: 'cancel_appointment', ok: false }),
    ]);
  });

  it('an unverified patient_id in the query is refused too', async () => {
    await run([
      round([call('c1', 'list_appointments', { patient_id: 77 })]),
      round([], 'x'),
    ]);
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('an id returned by a tool in this turn is executed', async () => {
    await run([
      round([call('c1', 'lookup_patient', { phone: '+18095551234' })]),
      round([call('c2', 'list_appointments', { patient_id: 88 })]),
      round([cancel('c3', '1234')]),
      round([], 'Cancelada.'),
    ]);
    expect(executedKeys()).toEqual([
      'lookup_patient',
      'list_appointments',
      'cancel_appointment',
    ]);
  });

  it('an id returned in an earlier turn of the same conversation is executed', async () => {
    await run([
      round([call('c1', 'lookup_patient', { phone: '+1809' })]),
      round([call('c2', 'list_appointments', { patient_id: 88 })]),
      round([], '¿Cancelo la del sábado?'),
    ]);
    h.execute.mockClear();
    await run([round([cancel('c3')]), round([], 'Cancelada.')]);
    expect(executedKeys()).toEqual(['cancel_appointment']);
  });

  it('after a restart (empty cache) it refuses, and passes after a lookup', async () => {
    await run([
      round([call('c1', 'lookup_patient', { phone: '+1809' })]),
      round([call('c2', 'list_appointments', { patient_id: 88 })]),
      round([], 'x'),
    ]);
    __resetIdCacheForTests();
    h.execute.mockClear();
    const r = await run([
      round([cancel('c3')]),
      round([call('c4', 'lookup_patient', { phone: '+1809' })]),
      round([call('c5', 'list_appointments', { patient_id: 88 })]),
      round([cancel('c6')]),
      round([], 'Cancelada.'),
    ]);
    expect(r.seen[1][0]).toMatchObject({ outcome: 'unverified_id' });
    expect(executedKeys()).toEqual([
      'lookup_patient',
      'list_appointments',
      'cancel_appointment',
    ]);
  });

  it('another conversation or another account does not share the evidence', async () => {
    await run([
      round([call('c1', 'lookup_patient', { phone: '+1809' })]),
      round([call('c2', 'list_appointments', { patient_id: 88 })]),
      round([], 'x'),
    ]);
    h.execute.mockClear();
    await run([round([cancel('c3')]), round([], 'x')], {
      conversationId: 'conv-2',
    });
    await run([round([cancel('c4')]), round([], 'x')], {
      accountId: 'acct-B',
    });
    await run([round([cancel('c5')]), round([], 'x')], {
      conversationId: null,
    });
    expect(h.execute).not.toHaveBeenCalled();
  });

  it('a refused call does not spend the execution budget', async () => {
    // 9 refusals in one round: none counts towards AI_TOOL_MAX_CALLS (8).
    const refusals = Array.from({ length: 9 }, (_, i) => cancel(`r${i}`));
    const r = await run([round(refusals), round([], 'x')]);
    expect(
      r.seen[1].every((payload) => payload.outcome === 'unverified_id')
    ).toBe(true);
  });
});
