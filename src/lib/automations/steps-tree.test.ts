import { beforeEach, describe, expect, it, vi } from 'vitest';

import { FakeDatabase } from '@/lib/security/fake-supabase';

const h = vi.hoisted(() => ({ db: null as unknown as FakeDatabase }));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => h.db.admin,
}));

import { loadStepsTree, replaceSteps, stepsChanged } from './steps-tree';

const A = 'acct-a';
const B = 'acct-b';

function pending(
  id: string,
  account: string,
  status: string,
  logId: string
): Record<string, unknown> {
  return {
    id,
    automation_id: 'auto-a',
    account_id: account,
    log_id: logId,
    parent_step_id: 'cond',
    branch: 'yes',
    next_step_position: 1,
    status,
  };
}

function log(id: string, account: string): Record<string, unknown> {
  return {
    id,
    automation_id: 'auto-a',
    account_id: account,
    status: 'partial',
  };
}

beforeEach(() => {
  h.db = new FakeDatabase({
    automation_steps: [
      {
        id: 'cond',
        automation_id: 'auto-a',
        parent_step_id: null,
        branch: null,
        step_type: 'condition',
        step_config: { subject: 'tag_presence', operand: 'tag-1' },
        position: 0,
      },
      {
        id: 'wait',
        automation_id: 'auto-a',
        parent_step_id: 'cond',
        branch: 'yes',
        step_type: 'wait',
        step_config: { unit: 'days', amount: 1 },
        position: 0,
      },
    ],
    automation_logs: [
      log('log-a', A),
      log('log-a-running', A),
      // Same automation id under another account: a filter on the id
      // alone would reach it.
      log('log-b', B),
    ],
    automation_pending_executions: [
      pending('pend-a', A, 'pending', 'log-a'),
      pending('pend-a-running', A, 'running', 'log-a-running'),
      pending('pend-b', B, 'pending', 'log-b'),
    ],
  });
});

function row(table: string, id: string) {
  return h.db.rows(table).find((r) => r.id === id);
}

describe('replaceSteps — parked runs (audit 2026-11-20 #2)', () => {
  it('saving cancels the runs parked on this automation, so the cron never resumes them', async () => {
    const err = await replaceSteps('auto-a', A, [
      { step_type: 'send_message', step_config: { text: 'hola' } },
    ]);
    expect(err).toBeNull();

    expect(row('automation_pending_executions', 'pend-a')?.status).toBe(
      'failed'
    );
    const log = row('automation_logs', 'log-a');
    expect(log?.status).toBe('failed');
    expect(log?.error_message).toMatch(/edited while this run was waiting/);
  });

  it('does not touch a run already running, nor its log', async () => {
    await replaceSteps('auto-a', A, []);

    expect(row('automation_pending_executions', 'pend-a-running')?.status).toBe(
      'running'
    );
    expect(row('automation_logs', 'log-a-running')).toEqual(
      log('log-a-running', A)
    );
  });

  it('leaves another account’s rows with the same automation id alone', async () => {
    await replaceSteps('auto-a', A, []);

    expect(row('automation_pending_executions', 'pend-b')?.status).toBe(
      'pending'
    );
    expect(row('automation_logs', 'log-b')?.status).toBe('partial');
  });
});

describe('stepsChanged — the builder resends every step on every save', () => {
  it('the stored tree, resent as is (other key order), is unchanged', async () => {
    const stored = await loadStepsTree('auto-a');
    const resent = [
      {
        ...stored[0],
        step_config: { operand: 'tag-1', subject: 'tag_presence' },
      },
    ];
    expect(await stepsChanged('auto-a', resent)).toBe(false);
  });

  it('a different config, branch or order is a change', async () => {
    const stored = await loadStepsTree('auto-a');
    const wait = stored[0].branches.yes[0];
    const cond = { ...stored[0], branches: { yes: [], no: [wait] } };
    expect(await stepsChanged('auto-a', [cond])).toBe(true);
    expect(
      await stepsChanged('auto-a', [
        { ...stored[0], step_config: { subject: 'tag_presence' } },
      ])
    ).toBe(true);
    expect(await stepsChanged('auto-a', [wait, stored[0]])).toBe(true);
  });
});
