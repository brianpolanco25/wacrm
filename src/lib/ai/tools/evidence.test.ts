import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';
import {
  ACCOUNT_A,
  ACCOUNT_B,
  HEALTH_ID,
  seedIntegrationTables,
} from '@/lib/integrations/integrations.test-support';

import { loadPriorEvidence } from './evidence';

// n13.7 R28, R31, R34: evidencia previa de una conversación.

const NOW = new Date('2026-11-10T15:00:00.000Z');
const CONV = 'c0000000-0000-4000-8000-000000000001';

let seq = 0;
function call(over: Partial<Row>): Row {
  seq += 1;
  return {
    id: `call-${seq}`,
    account_id: ACCOUNT_A,
    integration_id: HEALTH_ID,
    operation_key: 'list_appointments',
    source: 'ai',
    outcome: 'ok',
    status_code: 200,
    latency_ms: 5,
    conversation_id: CONV,
    ai_preload: false,
    created_at: '2026-11-10T14:00:00.000Z',
    ...over,
  };
}

let db: FakeDatabase;
const client = () => db.admin as unknown as SupabaseClient;

beforeEach(() => {
  seq = 0;
  const tables = seedIntegrationTables();
  tables.integration_calls = [
    call({
      operation_key: 'find_availability',
      created_at: '2026-11-10T14:05:00.000Z',
    }),
    call({
      operation_key: 'list_appointments',
      created_at: '2026-11-10T14:00:00.000Z',
    }),
    // fuera: lectura en vivo, otro source, fallida, otra conversación, > 24 h
    call({ operation_key: 'preload_op', ai_preload: true }),
    call({ operation_key: 'flow_op', source: 'flow' }),
    call({ operation_key: 'failed_op', outcome: 'http_error' }),
    call({ operation_key: 'other_conv', conversation_id: 'c-other' }),
    call({ operation_key: 'old_op', created_at: '2026-11-09T14:59:00.000Z' }),
    // la misma conversación (id falso) en la cuenta B
    call({ account_id: ACCOUNT_B, operation_key: 'get_appointment' }),
  ];
  db = new FakeDatabase(tables);
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe('loadPriorEvidence', () => {
  it('only ok AI calls of this account and conversation in 24 h, not live reads, in order', async () => {
    const ev = await loadPriorEvidence(client(), ACCOUNT_A, CONV, NOW);
    expect(ev).toEqual([
      { integrationSlug: 'health', operationKey: 'list_appointments' },
      { integrationSlug: 'health', operationKey: 'find_availability' },
    ]);
    const filters = db.log.find(
      (e) => e.table === 'integration_calls'
    )!.filters;
    expect(filters).toEqual(
      expect.arrayContaining([
        { column: 'account_id', op: 'eq', value: ACCOUNT_A },
        { column: 'conversation_id', op: 'eq', value: CONV },
        { column: 'source', op: 'eq', value: 'ai' },
        { column: 'ai_preload', op: 'eq', value: false },
        { column: 'outcome', op: 'eq', value: 'ok' },
        { column: 'created_at', op: 'gte', value: '2026-11-09T15:00:00.000Z' },
      ])
    );
  });

  it('R34: two accounts sharing a fake conversation_id never mix', async () => {
    const a = await loadPriorEvidence(client(), ACCOUNT_A, CONV, NOW);
    const b = await loadPriorEvidence(client(), ACCOUNT_B, CONV, NOW);
    expect(a.map((e) => e.operationKey)).not.toContain('get_appointment');
    expect(b).toEqual([
      { integrationSlug: 'health', operationKey: 'get_appointment' },
    ]);
  });

  it('without a conversation: [] and no query', async () => {
    expect(await loadPriorEvidence(client(), ACCOUNT_A, null, NOW)).toEqual([]);
    expect(db.log).toEqual([]);
  });

  it('R31: a database error → [] (never throws)', async () => {
    const failing = {
      from: () => {
        const q: Record<string, unknown> = {};
        for (const m of ['select', 'eq', 'gte', 'order', 'in']) q[m] = () => q;
        q.then = (resolve: (v: unknown) => void) =>
          resolve({ data: null, error: { message: 'boom' } });
        return q;
      },
    } as unknown as SupabaseClient;
    expect(await loadPriorEvidence(failing, ACCOUNT_A, CONV, NOW)).toEqual([]);
    expect(console.error).toHaveBeenCalledWith(
      '[ai tools] could not load prior evidence for account',
      ACCOUNT_A
    );
  });
});
