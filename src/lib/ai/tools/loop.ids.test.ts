import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// p16.4 D1: un id protegido solo se usa si una herramienta lo devolvió en
// esta conversación.

const h = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock('@/lib/integrations/execute', () => ({
  executeIntegrationOperation: h.execute,
}));

import type { SupabaseClient } from '@supabase/supabase-js';

import { CABBITY_HEALTH_CATALOG } from '@/lib/integrations/catalogs/cabbity-health';

import type { ProviderToolResult } from '../providers/shared';
import type { AiConfig } from '../types';
import { __resetIdCacheForTests } from './ids';
import { runToolLoop } from './loop';
import { buildAiTools } from './schema';
import type { AiToolset, PriorEvidence, ToolCall } from './types';

const db = { tag: 'db' } as unknown as SupabaseClient;
const SLUG = CABBITY_HEALTH_CATALOG.integration.slug;

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

// El catálogo real (parámetros y `ai_policy`), como lo arma `loadAiToolset`.
const tools = buildAiTools(
  CABBITY_HEALTH_CATALOG.operations.map((op) => ({
    integration: { slug: SLUG, name: 'Cabbity Health', sortOrder: 1 },
    operation: {
      key: op.key,
      name: op.name,
      description: op.description,
      method: op.method,
      params: op.params,
      responseDescription: op.response_description,
      sortOrder: op.sort_order,
      aiPolicy: op.ai_policy ?? null,
    },
  })),
  { mode: 'auto_reply' }
);
const toolset: AiToolset = {
  tools,
  integrations: [
    { slug: SLUG, name: 'Cabbity Health', instructions: null, timezone: null },
  ],
};
const nameOf = (key: string) => {
  const t = tools.find((x) => x.operationKey === key);
  if (!t) throw new Error(`no tool ${key}`);
  return t.name;
};

// requires_prior de cancel_appointment ya cumplido en mensajes anteriores.
const PRIOR: PriorEvidence[] = [
  { integrationSlug: SLUG, operationKey: 'list_appointments' },
  { integrationSlug: SLUG, operationKey: 'find_availability' },
];

// Lo que devuelve Cabbity Health por operación (formas de response_description).
const DATA: Record<string, unknown> = {
  lookup_patient: { data: { source: 'center', matches: [{ id: 88 }] } },
  list_appointments: {
    data: [
      {
        id: 1234,
        patient_id: 88,
        status: 'scheduled',
        starts_at: '2026-11-21T10:00:00-04:00',
        practitioner: { id: 5, membership_id: 12, name: 'Dra. A' },
        location: { id: 3, name: 'Sede' },
      },
    ],
  },
  find_availability: {
    data: [
      {
        membership_id: 12,
        practitioner_name: 'Dra. A',
        location_id: 3,
        starts_at: '2026-11-22T09:00:00-04:00',
      },
    ],
    meta: { truncated: false },
  },
  list_practitioners: {
    data: [{ membership_id: 12, name: 'Dra. A', location_ids: [3] }],
  },
  get_practitioner: { data: { membership_id: 12, name: 'Dra. A' } },
  get_center: { data: { center: { id: 7, name: 'C' } } },
  cancel_appointment: { data: { id: 1234, status: 'cancelled' } },
};

const call = (id: string, key: string, args: unknown): ToolCall => ({
  id,
  name: nameOf(key),
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
      priorEvidence: PRIOR,
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
  call(id, 'cancel_appointment', { id: appt });
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
      data: DATA[a.operationKey] ?? { data: null },
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
    // 9 refusals: if they counted towards AI_TOOL_MAX_CALLS (8), the next
    // round would be final and the lookup would never run.
    const refusals = Array.from({ length: 9 }, (_, i) => cancel(`r${i}`));
    await run([
      round(refusals),
      round([call('c1', 'lookup_patient', { phone: '+1809' })]),
      round([], 'x'),
    ]);
    expect(executedKeys()).toEqual(['lookup_patient']);
  });
});

describe('runToolLoop — id guard is typed by origin (p16.4 D1, review 1)', () => {
  it('a location_id from find_availability opens neither patient_id nor an appointment id', async () => {
    await run([
      round([call('c1', 'find_availability', { from: '2026-11-22' })]),
      round([
        call('c2', 'list_appointments', { patient_id: 3 }),
        cancel('c3', 3),
        cancel('c4', 12),
      ]),
      round([], 'x'),
    ]);
    expect(executedKeys()).toEqual(['find_availability']);
  });

  it('nested practitioner/location ids of an appointment open nothing', async () => {
    await run([
      round([call('c1', 'lookup_patient', { phone: '+1809' })]),
      round([call('c2', 'list_appointments', { patient_id: 88 })]),
      round([
        call('c3', 'list_appointments', { patient_id: 5 }),
        call('c4', 'list_appointments', { patient_id: 3 }),
        cancel('c5', 5),
        // The own patient_id is not an appointment id.
        cancel('c6', 88),
      ]),
      round([], 'x'),
    ]);
    expect(executedKeys()).toEqual(['lookup_patient', 'list_appointments']);
  });

  it('a nested center id from get_center opens nothing', async () => {
    await run([
      round([call('c1', 'get_center', {})]),
      round([
        call('c2', 'list_appointments', { patient_id: 7 }),
        cancel('c3', 7),
      ]),
      round([], 'x'),
    ]);
    expect(executedKeys()).toEqual(['get_center']);
  });

  it('list_practitioners → get_practitioner by membership_id still passes', async () => {
    await run([
      round([call('c1', 'list_practitioners', {})]),
      round([call('c2', 'get_practitioner', { id: 12 })]),
      round([], 'x'),
    ]);
    expect(executedKeys()).toEqual(['list_practitioners', 'get_practitioner']);
  });

  it('every protected parameter of the catalog declares its origins', async () => {
    const { isProtectedParam } = await import('./ids');
    const keys = new Set(CABBITY_HEALTH_CATALOG.operations.map((o) => o.key));
    for (const op of CABBITY_HEALTH_CATALOG.operations) {
      for (const param of op.params.filter(isProtectedParam)) {
        const sources = op.ai_policy?.ids?.[param.name];
        expect(sources, `${op.key}.${param.name}`).toBeDefined();
        for (const source of sources ?? []) {
          expect(keys.has(source.split('.')[0]), source).toBe(true);
        }
      }
    }
  });
});

describe('runToolLoop — id guard without a declaration (default)', () => {
  it('only a top-level record id of the integration counts, never *_id keys', async () => {
    const bare: AiToolset = {
      ...toolset,
      tools: tools.map((t) => ({ ...t, policy: null })),
    };
    const seenIds: string[] = [];
    h.execute.mockImplementation(
      async (
        _db: unknown,
        a: { operationKey: string; params: Record<string, unknown> }
      ) => {
        if (a.operationKey === 'get_appointment')
          seenIds.push(String(a.params.id));
        return {
          ok: true,
          status: 200,
          data: DATA[a.operationKey] ?? { data: null },
          latencyMs: 1,
        };
      }
    );
    await runToolLoop(
      {
        config,
        systemPrompt: 'SYS',
        messages: [{ role: 'user', content: 'x' }],
        toolset: bare,
        db,
        accountId: 'acct-A',
        conversationId: 'conv-default',
      },
      {
        invalidate: () => {},
        callProvider: (() => {
          const rounds = [
            round([call('c1', 'find_availability', { from: '2026-11-22' })]),
            round([call('c2', 'get_appointment', { id: 3 })]),
            round([call('c3', 'lookup_patient', { phone: '+1809' })]),
            round([call('c4', 'get_appointment', { id: 88 })]),
            round([], 'x'),
          ];
          return async () => rounds.shift()!;
        })(),
      }
    );
    expect(seenIds).toEqual(['88']);
  });
});
