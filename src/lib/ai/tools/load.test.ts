import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  entitlementsWith,
  HEALTH_ID,
  integration,
  seedIntegrationTables,
} from '@/lib/integrations/integrations.test-support';
import type { Entitlements } from '@/lib/billing/entitlements';

import { loadAiToolset } from './load';

// n13.3 R1–R5, R28 (carga): qué herramientas ve la IA de una cuenta.

const AGENDA_ID = '9a000000-0000-4000-8000-0000000000a9';
const ents = (features: string[]) =>
  entitlementsWith(features) as unknown as Entitlements;

function seed(): FakeDatabase {
  const tables = seedIntegrationTables();
  // A activa health con ai_enabled y zona; B ya la tiene activada sin IA.
  tables.account_integrations.push({
    id: 'ai-a-health',
    account_id: ACCOUNT_A,
    integration_id: HEALTH_ID,
    is_enabled: true,
    credential: 'enc-a',
    credential_last4: 'aaaa',
    ai_enabled: true,
    ai_instructions: '  Citas de 30 min.  ',
    ai_timezone: 'America/Santo_Domingo',
  });
  for (const r of tables.account_integrations) {
    if (r.account_id === ACCOUNT_B) r.ai_enabled = false;
  }
  tables.integrations.push(
    integration({
      id: AGENDA_ID,
      slug: 'agenda',
      name: 'Agenda',
      base_url: 'https://agenda.example.com',
      sort_order: 0,
    })
  );
  tables.integration_operations.push({
    id: 'op-agenda',
    integration_id: AGENDA_ID,
    key: 'slots',
    name: 'Huecos',
    description: 'Huecos libres',
    method: 'GET',
    path: '/slots',
    params: [],
    outputs: [],
    response_description: null,
    is_active: true,
    sort_order: 1,
  });
  return new FakeDatabase(tables);
}

let db: FakeDatabase;
const client = () => db.admin as unknown as SupabaseClient;
const actA = () =>
  db.rows('account_integrations').find((r) => r.id === 'ai-a-health') as Row;

beforeEach(() => {
  db = seed();
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('loadAiToolset', () => {
  it('loads the active operations of the ai-enabled integrations of the account', async () => {
    const set = await loadAiToolset(client(), ACCOUNT_A, {
      mode: 'auto_reply',
      entitlements: ents(['integrations']),
    });
    // old_op is inactive; agenda is not activated by A.
    expect(set.tools.map((t) => t.name)).toEqual([
      'health__list_doctors',
      'health__create_appointment',
    ]);
    expect(set.integrations).toEqual([
      {
        slug: 'health',
        name: 'Cabbity Health',
        instructions: 'Citas de 30 min.',
        timezone: 'America/Santo_Domingo',
      },
    ]);
    const filters = db.log.find(
      (e) => e.table === 'account_integrations'
    )!.filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        { column: 'account_id', op: 'eq', value: ACCOUNT_A },
        { column: 'is_enabled', op: 'eq', value: true },
        { column: 'ai_enabled', op: 'eq', value: true },
        { column: 'credential', op: 'not.is', value: null },
      ])
    );
  });

  it.each([
    ['ai_enabled off', { ai_enabled: false }],
    ['deactivated', { is_enabled: false }],
    ['no credential', { credential: null }],
  ])('nothing when %s', async (_label, patch) => {
    Object.assign(actA(), patch);
    const set = await loadAiToolset(client(), ACCOUNT_A, {
      mode: 'auto_reply',
      entitlements: ents(['integrations']),
    });
    expect(set).toEqual({ tools: [], integrations: [] });
  });

  it('nothing when the integration is retired or the operations inactive', async () => {
    db.rows('integrations').find((r) => r.id === HEALTH_ID)!.is_active = false;
    expect(
      (
        await loadAiToolset(client(), ACCOUNT_A, {
          mode: 'auto_reply',
          entitlements: ents(['integrations']),
        })
      ).tools
    ).toEqual([]);
    db.rows('integrations').find((r) => r.id === HEALTH_ID)!.is_active = true;
    for (const op of db.rows('integration_operations')) op.is_active = false;
    expect(
      (
        await loadAiToolset(client(), ACCOUNT_A, {
          mode: 'auto_reply',
          entitlements: ents(['integrations']),
        })
      ).tools
    ).toEqual([]);
  });

  it('B, with the same integration but ai off, gets nothing', async () => {
    const set = await loadAiToolset(client(), ACCOUNT_B, {
      mode: 'auto_reply',
      entitlements: ents(['integrations']),
    });
    expect(set.tools).toEqual([]);
  });

  it('draft keeps only GET', async () => {
    const set = await loadAiToolset(client(), ACCOUNT_A, {
      mode: 'draft',
      entitlements: ents(['integrations']),
    });
    expect(set.tools.map((t) => t.operationKey)).toEqual(['list_doctors']);
  });

  it('an invalid stored zone is ignored', async () => {
    actA().ai_timezone = 'Mars/Base';
    const set = await loadAiToolset(client(), ACCOUNT_A, {
      mode: 'auto_reply',
      entitlements: ents(['integrations']),
    });
    expect(set.integrations[0].timezone).toBeNull();
  });

  it('a plan without integrations → nothing, without touching the tables (R2)', async () => {
    const set = await loadAiToolset(client(), ACCOUNT_A, {
      mode: 'auto_reply',
      entitlements: ents(['ai_autoreply']),
    });
    expect(set.tools).toEqual([]);
    expect(db.log).toEqual([]);
  });

  it('asks for entitlements only when they were not passed', async () => {
    const getEntitlements = vi.fn(async () => ents(['integrations']));
    await loadAiToolset(
      client(),
      ACCOUNT_A,
      { mode: 'auto_reply', entitlements: ents(['integrations']) },
      { getEntitlements }
    );
    expect(getEntitlements).not.toHaveBeenCalled();
    const set = await loadAiToolset(
      client(),
      ACCOUNT_A,
      { mode: 'auto_reply' },
      { getEntitlements }
    );
    expect(getEntitlements).toHaveBeenCalledWith(ACCOUNT_A);
    expect(set.tools).toHaveLength(2);
  });

  it('a database or plan error → nothing and one fixed console line (R3)', async () => {
    const broken = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'not', 'in']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { message: 'relation secret_xyz' } });
        return q;
      },
    } as unknown as SupabaseClient;
    const set = await loadAiToolset(broken, ACCOUNT_A, {
      mode: 'auto_reply',
      entitlements: ents(['integrations']),
    });
    expect(set).toEqual({ tools: [], integrations: [] });
    const failingPlan = await loadAiToolset(
      client(),
      ACCOUNT_A,
      { mode: 'auto_reply' },
      {
        getEntitlements: async () => {
          throw new Error('plan secret_xyz');
        },
      }
    );
    expect(failingPlan.tools).toEqual([]);
    const calls = vi.mocked(console.error).mock.calls;
    expect(calls).toEqual([
      ['[ai tools] could not load tools for account', ACCOUNT_A],
      ['[ai tools] could not load tools for account', ACCOUNT_A],
    ]);
    expect(JSON.stringify(calls)).not.toContain('secret_xyz');
  });
});
