import { describe, it, expect, beforeEach, vi } from 'vitest';

// Shared mock state for the service-role client. Lives in a hoisted block
// so the vi.mock factory below can close over it.
const h = vi.hoisted(() => ({
  state: {
    owned: null as { id: string } | null,
    ownedCustomField: null as { id: string } | null,
    automations: [] as Record<string, unknown>[],
    steps: [] as Record<string, unknown>[],
    fromCalls: [] as string[],
    updateCalls: [] as {
      table: string;
      filters: [string, string, unknown][];
    }[],
    upsertCalls: [] as { table: string; payload: unknown }[],
    logInserts: [] as Record<string, unknown>[],
    logUpdates: [] as Record<string, unknown>[],
    rpcCalls: [] as { name: string; args: unknown }[],
    /** What `pick_available_agent` returns (null = nobody online). */
    pick: null as string | null,
    conversationUpdates: [] as Record<string, unknown>[],
    /** `inbound_auto_replies` (migration 051), keyed by message id the
     *  way its primary key is. */
    autoReplyClaims: new Map<string, Record<string, unknown>>(),
    claimUpserts: [] as Record<string, unknown>[],
    /** Holder reads of `inbound_auto_replies` (message + account filter),
     *  so the tenancy of the follow-up lookup is assertable. */
    claimReads: [] as { messageId: unknown; accountId: unknown }[],
    /** Rows the engine parked in `automation_pending_executions`. */
    pendingInserts: [] as Record<string, unknown>[],
  },
}));

vi.mock('./admin-client', () => {
  const { state } = h;

  function resolve(ops: {
    table: string;
    type: string;
    payload?: unknown;
    filters: [string, string, unknown][];
  }) {
    const { table, type } = ops;
    if (table === 'contacts') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        return { data: null, error: null };
      }
      // ownership guard / condition read
      return { data: state.owned, error: null };
    }
    if (table === 'custom_fields') {
      // account-scoped ownership lookup for a custom field definition
      return { data: state.ownedCustomField, error: null };
    }
    if (table === 'contact_custom_values') {
      if (type === 'upsert') {
        state.upsertCalls.push({ table, payload: ops.payload });
        return { data: null, error: null };
      }
      return { data: null, error: null };
    }
    if (table === 'conversations') {
      if (type === 'update') {
        state.updateCalls.push({ table, filters: ops.filters });
        state.conversationUpdates.push(ops.payload as Record<string, unknown>);
      }
      return { data: null, error: null };
    }
    if (table === 'automations') {
      // `resumePendingExecution` reads ONE automation by id; the dispatch
      // path reads the account's list.
      const byId = ops.filters.find(([op, k]) => op === 'eq' && k === 'id');
      if (byId) {
        return {
          data: state.automations.find((a) => a.id === byId[2]) ?? null,
          error: null,
        };
      }
      return { data: state.automations, error: null };
    }
    if (table === 'automation_pending_executions') {
      if (type === 'insert') {
        state.pendingInserts.push(ops.payload as Record<string, unknown>);
      }
      return { data: null, error: null };
    }
    if (table === 'automation_logs') {
      if (type === 'insert') {
        state.logInserts.push(ops.payload as Record<string, unknown>);
        return { data: { id: 'log1' }, error: null };
      }
      if (type === 'update') {
        state.logUpdates.push(ops.payload as Record<string, unknown>);
        return { data: null, error: null };
      }
      return { data: { steps_executed: [], status: 'success' }, error: null };
    }
    if (table === 'automation_steps') {
      // `executeStepsFrom` reads from `startPosition` onwards; a resumed
      // run MUST NOT see the wait step it already served.
      const from = ops.filters.find(
        ([op, k]) => op === 'gte' && k === 'position'
      );
      const steps = from
        ? state.steps.filter((st) => (st.position as number) >= Number(from[2]))
        : state.steps;
      return { data: steps, error: null };
    }
    if (table === 'inbound_auto_replies') {
      if (type === 'upsert') {
        const payload = ops.payload as Record<string, unknown>;
        state.claimUpserts.push(payload);
        const key = payload.message_id as string;
        // ON CONFLICT DO NOTHING on the message-id primary key.
        if (state.autoReplyClaims.has(key)) return { data: [], error: null };
        state.autoReplyClaims.set(key, payload);
        return { data: [{ message_id: key }], error: null };
      }
      // Who holds the reservation? Read by message id AND account, the
      // way the service-role helper does it.
      const messageId = ops.filters.find(
        ([op, k]) => op === 'eq' && k === 'message_id'
      )?.[2];
      const accountId = ops.filters.find(
        ([op, k]) => op === 'eq' && k === 'account_id'
      )?.[2];
      state.claimReads.push({ messageId, accountId });
      const row = state.autoReplyClaims.get(messageId as string);
      return {
        data: row && row.account_id === accountId ? row : null,
        error: null,
      };
    }
    return { data: null, error: null };
  }

  function builder(table: string) {
    const ops = {
      table,
      type: 'select',
      payload: undefined as unknown,
      filters: [] as [string, string, unknown][],
    };
    const b: Record<string, unknown> = {
      select: () => b,
      insert: (p: unknown) => ((ops.type = 'insert'), (ops.payload = p), b),
      update: (p: unknown) => ((ops.type = 'update'), (ops.payload = p), b),
      delete: () => ((ops.type = 'delete'), b),
      upsert: (p: unknown) => ((ops.type = 'upsert'), (ops.payload = p), b),
      eq: (k: string, v: unknown) => (ops.filters.push(['eq', k, v]), b),
      gte: (k: string, v: unknown) => (ops.filters.push(['gte', k, v]), b),
      is: () => b,
      order: () => b,
      limit: () => b,
      single: () => Promise.resolve(resolve(ops)),
      maybeSingle: () => Promise.resolve(resolve(ops)),
      then: (onF: (v: unknown) => unknown, onR?: (e: unknown) => unknown) =>
        Promise.resolve(resolve(ops)).then(onF, onR),
    };
    return b;
  }

  return {
    supabaseAdmin: () => ({
      from: (t: string) => {
        state.fromCalls.push(t);
        return builder(t);
      },
      rpc: (name: string, args: unknown) => {
        state.rpcCalls.push({ name, args });
        if (name === 'pick_available_agent') {
          return Promise.resolve({ data: state.pick, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      },
    }),
  };
});

vi.mock('./meta-send', () => ({
  engineSendText: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendTemplate: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
  engineSendInteractive: vi.fn(async () => ({ whatsapp_message_id: 'm1' })),
}));

import { AccountLockedError } from '@/lib/billing/enforce';
import {
  resumePendingExecution,
  runAutomationsForTrigger,
  triggerMatches,
} from './engine';
import { engineSendText } from './meta-send';
import type { Automation, KeywordMatchTriggerConfig } from '@/types';

const ACCOUNT = 'acct-1';

beforeEach(() => {
  h.state.owned = null;
  h.state.ownedCustomField = null;
  h.state.automations = [];
  h.state.steps = [];
  h.state.fromCalls = [];
  h.state.updateCalls = [];
  h.state.upsertCalls = [];
  h.state.logInserts = [];
  h.state.logUpdates = [];
  h.state.rpcCalls = [];
  h.state.pick = null;
  h.state.conversationUpdates = [];
  h.state.autoReplyClaims = new Map();
  h.state.claimUpserts = [];
  h.state.claimReads = [];
  h.state.pendingInserts = [];
});

describe('assign_conversation — round_robin picks the available agent (fase 1)', () => {
  it('assigns to whoever pick_available_agent returns, scoped to the account + contact', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'round_robin' })];
    h.state.pick = 'agent-least-loaded';

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.rpcCalls).toContainEqual({
      name: 'pick_available_agent',
      args: { p_account_id: ACCOUNT },
    });
    // The old implementation did `.limit(1)` over profiles and always
    // returned the same person — it must not touch profiles at all now.
    expect(h.state.fromCalls).not.toContain('profiles');
    expect(h.state.conversationUpdates).toEqual([
      { assigned_agent_id: 'agent-least-loaded' },
    ]);
    const convUpdate = h.state.updateCalls.find(
      (u) => u.table === 'conversations'
    );
    expect(convUpdate?.filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
    expect(convUpdate?.filters).toContainEqual(['eq', 'contact_id', 'c1']);
  });

  it('leaves the conversation unassigned (no write, no failure) when nobody is online', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'round_robin' })];
    h.state.pick = null;

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.conversationUpdates).toEqual([]);
    // NULL is a valid answer, not an error: the run still succeeds.
    const withStatus = h.state.logUpdates.filter((u) => 'status' in u);
    expect(withStatus.at(-1)).toMatchObject({ status: 'success' });
  });

  it('specific mode still assigns the configured agent without consulting presence', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [assignStep({ mode: 'specific', agent_id: 'agent-7' })];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.rpcCalls.map((c) => c.name)).not.toContain(
      'pick_available_agent'
    );
    expect(h.state.conversationUpdates).toEqual([
      { assigned_agent_id: 'agent-7' },
    ]);
  });
});

describe('runAutomationsForTrigger — tenant isolation', () => {
  it('refuses to dispatch when the contact is not in the account (GHSA-63cv-2c49-m5v3)', async () => {
    // Ownership lookup returns nothing — the contact belongs to another tenant.
    h.state.owned = null;
    // If the guard failed, this automation would run an update_contact_field step.
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'victim-contact-uuid',
      context: { message_text: 'manual trigger' },
    });

    // Bailed at the guard: never fetched automations, never wrote a contact.
    expect(h.state.fromCalls).toContain('contacts');
    expect(h.state.fromCalls).not.toContain('automations');
    expect(h.state.updateCalls).toHaveLength(0);
  });

  it('proceeds past the guard when the contact belongs to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = []; // no matching automations; just prove we got past the guard

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.fromCalls).toContain('automations');
  });

  it("scopes the update_contact_field write to the automation's account", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.updateCalls).toHaveLength(1);
    const filters = h.state.updateCalls[0].filters;
    expect(filters).toContainEqual(['eq', 'id', 'c1']);
    expect(filters).toContainEqual(['eq', 'account_id', ACCOUNT]);
  });
});

describe('automation_logs — status is seeded pessimistically (issue #409)', () => {
  it("writes the log row as 'failed' before any step runs", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The insert happens before execution, so a run killed mid-flight must
    // not leave behind a row that claims it succeeded.
    expect(h.state.logInserts).toHaveLength(1);
    expect(h.state.logInserts[0]).toMatchObject({
      status: 'failed',
      steps_executed: [],
    });
  });

  it("still promotes the log to 'success' once the steps complete", async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [updateStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The seed is only a floor — the outermost scope still writes the real
    // verdict, so a completed run reports success as it always did.
    const withStatus = h.state.logUpdates.filter((u) => 'status' in u);
    expect(withStatus.at(-1)).toMatchObject({ status: 'success' });
  });
});

describe('update_contact_field — custom fields', () => {
  it('upserts contact_custom_values when the field is account-owned', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', 'Premium')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // No direct contacts column write for a custom field.
    expect(h.state.updateCalls).toHaveLength(0);
    expect(h.state.upsertCalls).toHaveLength(1);
    expect(h.state.upsertCalls[0].payload).toEqual({
      contact_id: 'c1',
      custom_field_id: 'cf1',
      value: 'Premium',
    });
  });

  it('interpolates {{ vars.* }} into the custom value', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = { id: 'cf1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:cf1', '{{ vars.source }}')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: { vars: { source: 'WhatsApp Ad' } },
    });

    expect(h.state.upsertCalls).toHaveLength(1);
    expect((h.state.upsertCalls[0].payload as { value: string }).value).toBe(
      'WhatsApp Ad'
    );
  });

  it('refuses to write a custom field from another account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.ownedCustomField = null; // account-scoped lookup finds nothing
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [customStep('custom:foreign-cf', 'x')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    expect(h.state.upsertCalls).toHaveLength(0);
    expect(h.state.updateCalls).toHaveLength(0);
  });
});

describe('send_webhook — SSRF guard (GHSA-8jqh-598v-rfxc)', () => {
  it('refuses a private / link-local destination and never calls fetch', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    // Aimed at the cloud metadata endpoint — the classic SSRF target.
    h.state.steps = [webhookStep('http://169.254.169.254/latest/meta-data/')];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      context: {},
    });

    // The automation matched and its steps were loaded (so we genuinely
    // reached the send_webhook case)...
    expect(h.state.fromCalls).toContain('automation_steps');
    // ...yet the guard blocked it before any outbound request left the box.
    expect(fetchSpy).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });
});

function webhookStep(url: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'send_webhook',
    position: 0,
    parent_step_id: null,
    step_config: {
      url,
      headers: { 'Metadata-Flavor': 'Google' },
      body_template: '{}',
    },
  };
}

function automationWithUpdateStep() {
  return {
    id: 'a1',
    account_id: ACCOUNT,
    user_id: 'u1',
    trigger_type: 'new_message_received',
    trigger_config: {},
    is_active: true,
  };
}

function updateStep() {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field: 'company', value: 'pwned-by-automation' },
  };
}

function assignStep(config: {
  mode: 'specific' | 'round_robin';
  agent_id?: string;
}) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'assign_conversation',
    position: 0,
    parent_step_id: null,
    step_config: config,
  };
}

function customStep(field: string, value: string) {
  return {
    id: 's1',
    automation_id: 'a1',
    step_type: 'update_contact_field',
    position: 0,
    parent_step_id: null,
    step_config: { field, value },
  };
}

describe('triggerMatches — interactive_reply', () => {
  function automation(reply_ids: string[]): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'menu step',
      trigger_type: 'interactive_reply',
      trigger_config: { reply_ids },
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches when the tapped id is in reply_ids (exact)', () => {
    expect(
      triggerMatches(automation(['yes', 'no']), { interactive_reply_id: 'yes' })
    ).toBe(true);
  });

  it('does not match a different id', () => {
    expect(
      triggerMatches(automation(['yes']), { interactive_reply_id: 'maybe' })
    ).toBe(false);
  });

  it('does not match on a substring (exact only)', () => {
    expect(
      triggerMatches(automation(['yes']), {
        interactive_reply_id: 'yes_please',
      })
    ).toBe(false);
  });

  it('does not match when no reply id is present or config is empty', () => {
    expect(triggerMatches(automation(['yes']), {})).toBe(false);
    expect(
      triggerMatches(automation([]), { interactive_reply_id: 'yes' })
    ).toBe(false);
  });
});

describe('triggerMatches — tag_added', () => {
  function automation(tagId?: string): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'tag follow-up',
      trigger_type: 'tag_added',
      trigger_config: tagId ? { tag_id: tagId } : {},
      is_active: true,
      execution_count: 0,
      created_at: '',
      updated_at: '',
    };
  }

  it('matches only the exact tag id', () => {
    expect(triggerMatches(automation('tag-a'), { tag_id: 'tag-a' })).toBe(true);
    expect(triggerMatches(automation('tag-a'), { tag_id: 'tag-ab' })).toBe(
      false
    );
  });

  it('fails closed when the config or event tag is missing', () => {
    expect(triggerMatches(automation(), { tag_id: 'tag-a' })).toBe(false);
    expect(triggerMatches(automation('tag-a'), {})).toBe(false);
    expect(triggerMatches(automation('tag-a'), undefined)).toBe(false);
  });
});

describe('tag_added — conversation policy', () => {
  it('records a clear failed step when the contact has no conversation', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        name: 'tag outreach',
        trigger_type: 'tag_added',
        trigger_config: { tag_id: 'tag-a' },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 0,
        parent_step_id: null,
        step_config: { text: 'Hello' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 'tag-a' },
    });

    expect(h.state.logUpdates).toContainEqual(
      expect.objectContaining({
        status: 'failed',
        error_message:
          'tag_added automation cannot send: contact has no existing conversation',
      })
    );
  });
});

describe('triggerMatches — keyword_match', () => {
  function automation(
    cfg: Partial<KeywordMatchTriggerConfig> & { keywords: string[] }
  ): Automation {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      name: 'kw',
      trigger_type: 'keyword_match',
      trigger_config: { match_type: 'contains', ...cfg },
      is_active: true,
    } as unknown as Automation;
  }

  const on = (a: Automation, text: string) =>
    triggerMatches(a, { message_text: text });

  it('keeps `contains` as a raw substring test', () => {
    // Issue #409 asked for this to become word-boundary matching. It
    // deliberately did NOT change: existing automations relying on
    // substring behaviour ("cat" firing on "category") must keep working,
    // and `contains` is the builder's default. `word` is the opt-in fix.
    expect(on(automation({ keywords: ['k'] }), 'thanks')).toBe(true);
    expect(on(automation({ keywords: ['cat'] }), 'category')).toBe(true);
  });

  it('`word` matches only standalone words', () => {
    const a = automation({ keywords: ['k'], match_type: 'word' });
    expect(on(a, 'thanks')).toBe(false);
    expect(on(a, 'k')).toBe(true);
    expect(on(a, 'press k to continue')).toBe(true);
    expect(on(a, 'press K!')).toBe(true);
  });

  it('`word` respects punctuation and line edges around the keyword', () => {
    const a = automation({ keywords: ['hi'], match_type: 'word' });
    expect(on(a, 'hi')).toBe(true);
    expect(on(a, 'hi!')).toBe(true);
    expect(on(a, '(hi)')).toBe(true);
    expect(on(a, 'say hi.')).toBe(true);
    expect(on(a, 'this')).toBe(false);
    expect(on(a, 'hiya')).toBe(false);
  });

  it('`word` handles a keyword that itself carries punctuation', () => {
    // `\b` can't do this: /\bhi!\b/ demands a word char after the "!",
    // so it never matches. Hence the lookaround implementation.
    const a = automation({ keywords: ['hi!'], match_type: 'word' });
    expect(on(a, 'say hi!')).toBe(true);
    expect(on(a, 'hi! there')).toBe(true);
  });

  it('`word` treats regex metacharacters in a keyword as literal', () => {
    // Account-supplied free text — an unescaped "(" would throw.
    const a = automation({ keywords: ['c++ (beginner)'], match_type: 'word' });
    expect(on(a, 'I want the c++ (beginner) course')).toBe(true);
    expect(on(a, 'I want the cxx beginner course')).toBe(false);
    expect(() =>
      on(automation({ keywords: ['('], match_type: 'word' }), '(')
    ).not.toThrow();
  });

  it('`word` is case-insensitive unless case_sensitive is set', () => {
    expect(on(automation({ keywords: ['Hi'], match_type: 'word' }), 'hi')).toBe(
      true
    );
    expect(
      on(
        automation({
          keywords: ['Hi'],
          match_type: 'word',
          case_sensitive: true,
        }),
        'hi'
      )
    ).toBe(false);
    expect(
      on(
        automation({
          keywords: ['Hi'],
          match_type: 'word',
          case_sensitive: true,
        }),
        'Hi'
      )
    ).toBe(true);
  });

  it('`word` finds a space-delimited keyword in a non-Latin script', () => {
    // ASCII `\b` fails outright here — every character of "안녕" is a
    // non-word character to it, so /\b안녕\b/ matches nothing.
    const a = automation({ keywords: ['안녕'], match_type: 'word' });
    expect(on(a, '안녕')).toBe(true);
    expect(on(a, '저기 안녕 하세요')).toBe(true);
    // Documented limitation, not an accident: a language written without
    // spaces has no word edge inside a run of characters.
    expect(on(a, '안녕하세요')).toBe(false);
  });

  it('`exact` still requires the whole message to be the keyword', () => {
    const a = automation({ keywords: ['hi'], match_type: 'exact' });
    expect(on(a, 'hi')).toBe(true);
    expect(on(a, 'hi there')).toBe(false);
  });

  it('ignores empty keywords and empty messages in `word` mode', () => {
    expect(
      on(automation({ keywords: [''], match_type: 'word' }), 'anything')
    ).toBe(false);
    expect(on(automation({ keywords: ['hi'], match_type: 'word' }), '')).toBe(
      false
    );
  });
});

/**
 * Fase 1, §4 — the automation engine leaves a per-message record so the
 * AI agent can stand down for the one inbound an automation answered,
 * instead of for the whole account.
 */
describe('per-message reply marker (fase 1)', () => {
  function keywordAutomation(keywords: string[]) {
    return {
      id: 'a1',
      account_id: ACCOUNT,
      user_id: 'u1',
      trigger_type: 'keyword_match',
      trigger_config: { keywords, match_type: 'contains' },
      is_active: true,
    };
  }

  function sendStep() {
    return {
      id: 's1',
      automation_id: 'a1',
      step_type: 'send_message',
      position: 0,
      parent_step_id: null,
      step_config: { text: 'We open at 9am.' },
    };
  }

  const inbound = {
    message_text: 'what are your opening hours?',
    conversation_id: 'conv-1',
    inbound_message_id: 'msg-1',
  };

  it('reserves the reply for the inbound it is answering, scoped to the account', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [keywordAutomation(['hours'])];
    h.state.steps = [sendStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });

    expect(h.state.claimUpserts).toEqual([
      {
        message_id: 'msg-1',
        account_id: ACCOUNT,
        responder: 'automation',
        automation_id: 'a1',
      },
    ]);
  });

  it('leaves no reservation when the keyword does not match (the AI keeps this message)', async () => {
    // Acceptance criterion 1, from the automation side: the automation
    // exists and is active, but it never ran for this inbound, so nothing
    // is reserved and the AI is free to answer.
    h.state.owned = { id: 'c1' };
    h.state.automations = [keywordAutomation(['refund'])];
    h.state.steps = [sendStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });

    expect(h.state.claimUpserts).toEqual([]);
    expect(h.state.autoReplyClaims.size).toBe(0);
  });

  it('reserves nothing when the run has no inbound behind it (tag event, manual dispatch)', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        ...keywordAutomation([]),
        trigger_type: 'tag_added',
        trigger_config: { tag_id: 't1' },
      },
    ];
    h.state.steps = [sendStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'tag_added',
      contactId: 'c1',
      context: { tag_id: 't1', conversation_id: 'conv-1' },
    });

    expect(h.state.claimUpserts).toEqual([]);
  });

  it('reserves once even when the run sends several messages', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [keywordAutomation(['hours'])];
    h.state.steps = [
      sendStep(),
      {
        ...sendStep(),
        id: 's2',
        position: 1,
        step_config: { text: 'Anything else?' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });

    // Both steps ask; Postgres hands the reservation out once. The second
    // one loses the insert but the holder is this same automation, so the
    // run keeps talking: standing down in front of yourself would swallow
    // every message after the first.
    expect(h.state.claimUpserts).toHaveLength(2);
    expect(h.state.autoReplyClaims.size).toBe(1);
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(2);
    // The holder read is scoped to the account, like every other
    // service-role query in the engine.
    expect(h.state.claimReads).toEqual([
      { messageId: 'msg-1', accountId: ACCOUNT },
    ]);
  });

  it('stands down when another automation already answered this inbound', async () => {
    // Criterion 3 between two automations: both match, the first one
    // reserves, the second one must not pile a second reply on top.
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      keywordAutomation(['hours']),
      { ...keywordAutomation(['hours']), id: 'a2' },
    ];
    h.state.steps = [sendStep()];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });

    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(h.state.autoReplyClaims.get('msg-1')).toMatchObject({
      automation_id: 'a1',
    });
  });

  it('a reservation held by another account is not ours either', async () => {
    // Defensive: the holder read is filtered by account, so a row that
    // somehow belongs to a different tenant reads as "not mine" and the
    // step stays quiet instead of sending on a stranger's reservation.
    h.state.owned = { id: 'c1' };
    h.state.automations = [keywordAutomation(['hours'])];
    h.state.steps = [sendStep()];
    h.state.autoReplyClaims.set('msg-1', {
      message_id: 'msg-1',
      account_id: 'other-account',
      responder: 'automation',
      automation_id: 'a1',
    });

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });

    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
  });
});

/**
 * Fase 1, §4 — the `wait` step was the hole in the guarantee: the run is
 * parked with nothing reserved, the AI answers in the meantime, and the
 * cron resumes the run minutes later. The reservation is honoured on
 * resume too, so the customer still gets exactly one automatic reply.
 */
describe('per-message reply marker — a run resumed after a wait (fase 1)', () => {
  const inbound = {
    message_text: 'what are your opening hours?',
    conversation_id: 'conv-1',
    inbound_message_id: 'msg-1',
  };

  function waitThenSend() {
    h.state.owned = { id: 'c1' };
    h.state.automations = [
      {
        id: 'a1',
        account_id: ACCOUNT,
        user_id: 'u1',
        trigger_type: 'keyword_match',
        trigger_config: { keywords: ['hours'], match_type: 'contains' },
        is_active: true,
      },
    ];
    h.state.steps = [
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'wait',
        position: 0,
        parent_step_id: null,
        step_config: { amount: 1, unit: 'minutes' },
      },
      {
        id: 's2',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 1,
        parent_step_id: null,
        step_config: { text: 'We open at 9am.' },
      },
    ];
  }

  async function park() {
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });
    expect(h.state.pendingInserts).toHaveLength(1);
    // Nothing is reserved while the run sleeps — the AI is free to take
    // the message, which is exactly what makes the resume interesting.
    expect(h.state.claimUpserts).toEqual([]);
    const pending = h.state.pendingInserts[0];
    return {
      id: 'pending-1',
      automation_id: pending.automation_id as string,
      user_id: pending.user_id as string,
      account_id: pending.account_id as string,
      contact_id: pending.contact_id as string | null,
      log_id: pending.log_id as string | null,
      parent_step_id: pending.parent_step_id as string | null,
      branch: pending.branch as 'yes' | 'no' | null,
      next_step_position: pending.next_step_position as number,
      context: pending.context as Record<string, unknown>,
    };
  }

  it('does not send when the AI answered while the run was waiting', async () => {
    waitThenSend();
    const pending = await park();

    // The AI got there first and reserved the reply to this inbound.
    h.state.autoReplyClaims.set('msg-1', {
      message_id: 'msg-1',
      account_id: ACCOUNT,
      responder: 'ai',
      automation_id: null,
    });

    await resumePendingExecution(pending);

    // It asked, it lost, it kept quiet: no second automatic reply.
    expect(h.state.claimUpserts).toHaveLength(1);
    expect(vi.mocked(engineSendText)).not.toHaveBeenCalled();
    expect(h.state.autoReplyClaims.get('msg-1')).toMatchObject({
      responder: 'ai',
    });
  });

  it('sends on resume when nobody else answered that inbound', async () => {
    waitThenSend();
    const pending = await park();

    await resumePendingExecution(pending);

    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    expect(h.state.autoReplyClaims.get('msg-1')).toMatchObject({
      responder: 'automation',
      automation_id: 'a1',
    });
  });

  it("sends on resume when the reservation is the run's own, taken before the wait", async () => {
    // send_message → wait → send_message: the tail of the run must not
    // stand down in front of the reservation its own first step took.
    waitThenSend();
    h.state.steps = [
      {
        id: 's0',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 0,
        parent_step_id: null,
        step_config: { text: 'One moment…' },
      },
      {
        id: 's1',
        automation_id: 'a1',
        step_type: 'wait',
        position: 1,
        parent_step_id: null,
        step_config: { amount: 1, unit: 'minutes' },
      },
      {
        id: 's2',
        automation_id: 'a1',
        step_type: 'send_message',
        position: 2,
        parent_step_id: null,
        step_config: { text: 'We open at 9am.' },
      },
    ];

    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'keyword_match',
      contactId: 'c1',
      context: inbound,
    });
    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    const pending = h.state.pendingInserts[0];

    await resumePendingExecution({
      id: 'pending-1',
      automation_id: pending.automation_id as string,
      user_id: pending.user_id as string,
      account_id: pending.account_id as string,
      contact_id: pending.contact_id as string | null,
      log_id: pending.log_id as string | null,
      parent_step_id: pending.parent_step_id as string | null,
      branch: pending.branch as 'yes' | 'no' | null,
      next_step_position: pending.next_step_position as number,
      context: pending.context as Record<string, unknown>,
    });

    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(2);
  });
});

// ============================================================
// Fase 3 §5 + CP11 — a suspended account stops ANSWERING, and that is
// all it stops.
//
// `engineSendText` refuses for a read-only account (see meta-send.ts).
// This is the other half: `runAutomationsForTrigger` runs inside the
// webhook's `after()`, so the refusal has to die here — logged as a
// failed step — instead of escaping into the route and taking down
// everything queued behind it.
// ============================================================
describe('runAutomationsForTrigger — a read-only account (fase 3 §5)', () => {
  function sendStep() {
    return {
      id: 's1',
      automation_id: 'a1',
      step_type: 'send_message',
      position: 0,
      parent_step_id: null,
      step_config: { text: 'Thanks for writing!' },
    };
  }

  it('logs the refused send as a failed step and never throws', async () => {
    h.state.owned = { id: 'c1' };
    h.state.automations = [automationWithUpdateStep()];
    h.state.steps = [sendStep()];
    vi.mocked(engineSendText).mockRejectedValueOnce(
      new AccountLockedError('suspended')
    );

    // Resolves. An exception here would abort the webhook's after()
    // block with the inbound already stored but everything queued
    // behind this dispatch skipped.
    await runAutomationsForTrigger({
      accountId: ACCOUNT,
      triggerType: 'new_message_received',
      contactId: 'c1',
      // Supplied so the step goes straight to the sender.
      context: { conversation_id: 'cv-1' },
    });

    expect(vi.mocked(engineSendText)).toHaveBeenCalledTimes(1);
    const withStatus = h.state.logUpdates.filter((u) => 'status' in u);
    expect(withStatus.at(-1)).toMatchObject({ status: 'failed' });
  });
});
