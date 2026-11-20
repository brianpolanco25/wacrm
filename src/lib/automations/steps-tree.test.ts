import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDatabase }));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

import { replaceSteps } from './steps-tree';

const A = 'acct-a';
const B = 'acct-b';

beforeEach(() => {
  h.db = new FakeDatabase({
    automation_steps: [
      {
        id: 'cond',
        automation_id: 'auto-a',
        parent_step_id: null,
        branch: null,
        step_type: 'condition',
        step_config: {},
        position: 0,
      },
      {
        id: 'wait',
        automation_id: 'auto-a',
        parent_step_id: 'cond',
        branch: 'yes',
        step_type: 'wait',
        step_config: { amount: 1, unit: 'days' },
        position: 0,
      },
    ],
    automation_logs: [
      {
        id: 'log-a',
        automation_id: 'auto-a',
        account_id: A,
        status: 'partial',
      },
      {
        id: 'log-b',
        automation_id: 'auto-b',
        account_id: B,
        status: 'partial',
      },
    ],
    automation_pending_executions: [
      {
        id: 'pend-a',
        automation_id: 'auto-a',
        account_id: A,
        log_id: 'log-a',
        parent_step_id: 'cond',
        branch: 'yes',
        next_step_position: 1,
        status: 'pending',
      },
      {
        id: 'pend-b',
        automation_id: 'auto-b',
        account_id: B,
        log_id: 'log-b',
        parent_step_id: null,
        branch: null,
        next_step_position: 1,
        status: 'pending',
      },
    ],
  });
});

describe('replaceSteps — parked runs (audit 2026-11-20 #2)', () => {
  it('saving cancels the runs parked on this automation, so the cron never resumes them', async () => {
    const err = await replaceSteps('auto-a', [
      { step_type: 'send_message', step_config: { text: 'hola' } },
    ]);
    expect(err).toBeNull();

    const pending = h.db.rows('automation_pending_executions');
    expect(pending.find((r) => r.id === 'pend-a')?.status).toBe('failed');
    // The cron only drains `pending` rows.
    expect(
      pending.filter(
        (r) => r.automation_id === 'auto-a' && r.status === 'pending'
      )
    ).toEqual([]);

    const log = h.db.rows('automation_logs').find((r) => r.id === 'log-a');
    expect(log?.status).toBe('failed');
    expect(log?.error_message).toMatch(/edited while this run was waiting/);
  });

  it('leaves other automations (and accounts) parked runs alone', async () => {
    await replaceSteps('auto-a', []);

    expect(
      h.db.rows('automation_pending_executions').find((r) => r.id === 'pend-b')
        ?.status
    ).toBe('pending');
    expect(
      h.db.rows('automation_logs').find((r) => r.id === 'log-b')?.status
    ).toBe('partial');
  });
});
