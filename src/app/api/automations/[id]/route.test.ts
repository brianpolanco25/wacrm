import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDatabase }));

vi.mock('@/lib/automations/admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({ accountId: 'acct-a', userId: 'u1' }),
  getCurrentAccount: async () => ({ accountId: 'acct-a', userId: 'u1' }),
  toErrorResponse: () => new Response('forbidden', { status: 403 }),
}));

import { PATCH } from './route';

beforeEach(() => {
  h.db = new FakeDatabase({
    automations: [
      {
        id: 'auto-a',
        account_id: 'acct-a',
        user_id: 'u1',
        name: 'Seguimiento',
        is_active: false,
        trigger_type: 'new_message_received',
        trigger_config: {},
      },
    ],
    automation_steps: [
      {
        id: 'step-wait',
        automation_id: 'auto-a',
        parent_step_id: null,
        branch: null,
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
        position: 0,
      },
      {
        id: 'step-send',
        automation_id: 'auto-a',
        parent_step_id: null,
        branch: null,
        step_type: 'send_message',
        step_config: { text: 'hola' },
        position: 1,
      },
    ],
    automation_logs: [
      {
        id: 'log-1',
        automation_id: 'auto-a',
        account_id: 'acct-a',
        status: 'partial',
      },
    ],
    automation_pending_executions: [
      {
        id: 'pend-1',
        automation_id: 'auto-a',
        account_id: 'acct-a',
        log_id: 'log-1',
        parent_step_id: null,
        branch: null,
        next_step_position: 1,
        status: 'pending',
      },
    ],
  });
});

function patch(body: unknown) {
  return PATCH(
    new Request('http://localhost/api/automations/auto-a', {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
    { params: Promise.resolve({ id: 'auto-a' }) }
  );
}

/** What the builder sends on every save: the whole tree, without ids. */
const SAME_STEPS = [
  { step_type: 'wait', step_config: { unit: 'days', amount: 1 } },
  { step_type: 'send_message', step_config: { text: 'hola' } },
];

describe('PATCH /api/automations/[id] — parked runs survive a save without step changes', () => {
  it('renaming with the same steps keeps the parked run pending and the step ids', async () => {
    const res = await patch({ name: 'Seguimiento 2', steps: SAME_STEPS });
    expect(res.status).toBe(200);

    expect(h.db.rows('automation_pending_executions')[0].status).toBe(
      'pending'
    );
    expect(h.db.rows('automation_steps').map((r) => r.id)).toEqual([
      'step-wait',
      'step-send',
    ]);
  });

  it('different steps replace them and cancel the parked run', async () => {
    const res = await patch({
      steps: [
        SAME_STEPS[0],
        { step_type: 'send_message', step_config: { text: 'hola!' } },
      ],
    });
    expect(res.status).toBe(200);

    expect(h.db.rows('automation_pending_executions')[0].status).toBe('failed');
    expect(h.db.rows('automation_steps').map((r) => r.id)).not.toContain(
      'step-wait'
    );
  });
});
