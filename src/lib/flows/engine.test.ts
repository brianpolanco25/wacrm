import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================
// p11.4 — stateful double of the service-role client, so the runner's
// conditional UPDATEs race against one shared `flow_runs` row the way
// they would in Postgres. The pure-helper suites below do not touch it.
// ============================================================
type Filter = [col: string, op: 'eq' | 'is' | 'in' | 'filter', val: unknown];

const db = vi.hoisted(() => ({
  state: {
    run: null as Record<string, unknown> | null,
    /** When set, `loadActiveRunForContact` returns copies of THIS row —
     *  a read taken before a concurrent dispatch moved the run. */
    staleRead: null as Record<string, unknown> | null,
    nodes: [] as Record<string, unknown>[],
    flow: null as Record<string, unknown> | null,
    events: [] as Record<string, unknown>[],
    /** Every UPDATE on flow_runs: payload, and whether it matched. */
    runUpdates: [] as { payload: Record<string, unknown>; matched: boolean }[],
    /** Make the Nth (0-based) flow_runs UPDATE throw, to simulate an
     *  exception after a send. */
    throwOnRunUpdate: null as number | null,
    /** Make `loadActiveRunForContact`'s read throw. */
    throwOnLoad: false,
  },
}));

function matches(row: Record<string, unknown>, filters: Filter[]): boolean {
  return filters.every(([col, op, val]) => {
    if (op === 'eq') return row[col] === val;
    if (op === 'is') return row[col] === val;
    return true;
  });
}

vi.mock('./admin-client', () => {
  function builder(table: string) {
    const filters: Filter[] = [];
    let op: 'select' | 'update' | 'insert' = 'select';
    let payload: Record<string, unknown> = {};

    function exec(): { data: unknown; error: null; count?: number } {
      const st = db.state;
      if (table === 'flow_runs') {
        if (op === 'update') {
          const n = st.runUpdates.length;
          if (st.throwOnRunUpdate === n) {
            st.runUpdates.push({ payload, matched: false });
            throw new Error('simulated failure after send');
          }
          const ok = !!st.run && matches(st.run, filters);
          st.runUpdates.push({ payload, matched: ok });
          if (ok) st.run = { ...st.run!, ...payload };
          return { data: ok ? [{ id: st.run!.id }] : [], error: null };
        }
        if (st.throwOnLoad) throw new Error('load exploded');
        // select: active-run lookup ('*') or the dupe check's id list.
        const source = st.staleRead ?? st.run;
        if (!source) return { data: [], error: null };
        const wantsActive = filters.some(([c]) => c === 'status');
        if (wantsActive && source.status !== 'active') {
          return { data: [], error: null };
        }
        return {
          data: [JSON.parse(JSON.stringify(source))],
          error: null,
        };
      }
      if (table === 'flow_run_events') {
        if (op === 'insert') {
          st.events.push(payload);
          return { data: null, error: null };
        }
        // dupe check: count reply_received with this meta_message_id
        const wanted = filters.find(([c]) => c === 'payload->>meta_message_id');
        const count = st.events.filter(
          (e) =>
            e.event_type === 'reply_received' &&
            (e.payload as Record<string, unknown>)?.meta_message_id ===
              wanted?.[2]
        ).length;
        return { data: null, error: null, count };
      }
      if (table === 'flow_nodes') return { data: st.nodes, error: null };
      if (table === 'flows') return { data: st.flow, error: null };
      if (table === 'messages') return { data: { id: 'msg-x' }, error: null };
      return { data: null, error: null };
    }

    const b: Record<string, unknown> = {
      select: () => b,
      update: (p: Record<string, unknown>) => {
        op = 'update';
        payload = p;
        return b;
      },
      insert: (p: Record<string, unknown>) => {
        op = 'insert';
        payload = p;
        return b;
      },
      eq: (c: string, v: unknown) => (filters.push([c, 'eq', v]), b),
      is: (c: string, v: unknown) => (filters.push([c, 'is', v]), b),
      in: (c: string, v: unknown) => (filters.push([c, 'in', v]), b),
      filter: (c: string, _o: string, v: unknown) => (
        filters.push([c, 'filter', v]),
        b
      ),
      order: () => b,
      limit: () => b,
      maybeSingle: async () => exec(),
      then: (
        resolve: (r: unknown) => unknown,
        reject: (e: unknown) => unknown
      ) => {
        try {
          return Promise.resolve(exec()).then(resolve, reject);
        } catch (err) {
          return Promise.reject(err).then(resolve, reject);
        }
      },
    };
    return b;
  }
  return {
    supabaseAdmin: () => ({
      from: (t: string) => builder(t),
      rpc: () => Promise.resolve({ data: null, error: null }),
    }),
  };
});

const send = vi.hoisted(() => ({
  text: vi.fn(async () => ({ whatsapp_message_id: 'wamid.t' })),
  media: vi.fn(async () => ({ whatsapp_message_id: 'wamid.m' })),
  buttons: vi.fn(async () => ({ whatsapp_message_id: 'wamid.b' })),
  list: vi.fn(async () => ({ whatsapp_message_id: 'wamid.l' })),
}));
vi.mock('./meta-send', () => ({
  engineSendText: send.text,
  engineSendMedia: send.media,
  engineSendInteractiveButtons: send.buttons,
  engineSendInteractiveList: send.list,
}));
vi.mock('@/lib/contacts/tag-events', () => ({
  addContactTagAndDispatch: vi.fn(async () => ({})),
}));
vi.mock('@/lib/contacts/tag-write', () => ({
  removeContactTag: vi.fn(async () => ({})),
}));

import {
  dispatchInboundToFlows,
  matchReplyId,
  matchesKeywordTrigger,
  isAutoAdvancing,
  isSuspending,
  isTerminal,
  evaluateConditionPredicate,
} from './engine';

describe('matchReplyId', () => {
  it('returns null for nodes without options', () => {
    expect(
      matchReplyId({ node_type: 'start', config: { next_node_key: 'x' } }, 'y')
    ).toBeNull();
    expect(
      matchReplyId({ node_type: 'send_message', config: {} }, 'y')
    ).toBeNull();
    expect(matchReplyId({ node_type: 'end', config: {} }, 'y')).toBeNull();
  });

  it('matches the buttons array on a send_buttons node', () => {
    const node = {
      node_type: 'send_buttons',
      config: {
        text: 'Pick one',
        buttons: [
          { reply_id: 'yes', title: 'Yes', next_node_key: 'confirmed' },
          { reply_id: 'no', title: 'No', next_node_key: 'declined' },
        ],
      },
    };
    expect(matchReplyId(node, 'yes')).toBe('confirmed');
    expect(matchReplyId(node, 'no')).toBe('declined');
  });

  it('returns null when no button reply_id matches', () => {
    const node = {
      node_type: 'send_buttons',
      config: {
        text: 'Pick',
        buttons: [
          { reply_id: 'a', title: 'A', next_node_key: 'to_a' },
          { reply_id: 'b', title: 'B', next_node_key: 'to_b' },
        ],
      },
    };
    expect(matchReplyId(node, 'c')).toBeNull();
    expect(matchReplyId(node, '')).toBeNull();
  });

  it('searches across all sections in a send_list node', () => {
    const node = {
      node_type: 'send_list',
      config: {
        text: 'Pick an order',
        button_label: 'View',
        sections: [
          {
            title: 'Recent',
            rows: [
              { reply_id: 'o1', title: 'Order 1', next_node_key: 'ord_1' },
            ],
          },
          {
            title: 'Older',
            rows: [
              { reply_id: 'o2', title: 'Order 2', next_node_key: 'ord_2' },
              { reply_id: 'o3', title: 'Order 3', next_node_key: 'ord_3' },
            ],
          },
        ],
      },
    };
    expect(matchReplyId(node, 'o1')).toBe('ord_1');
    expect(matchReplyId(node, 'o2')).toBe('ord_2');
    expect(matchReplyId(node, 'o3')).toBe('ord_3');
    expect(matchReplyId(node, 'o99')).toBeNull();
  });

  it('returns null when send_list has no sections / empty sections', () => {
    expect(
      matchReplyId(
        { node_type: 'send_list', config: { text: 'x', sections: [] } },
        'x'
      )
    ).toBeNull();
    expect(
      matchReplyId(
        {
          node_type: 'send_list',
          config: { text: 'x', sections: [{ rows: [] }] },
        },
        'x'
      )
    ).toBeNull();
  });
});

describe('matchesKeywordTrigger', () => {
  it('returns false for empty text', () => {
    expect(matchesKeywordTrigger('', { keywords: ['hi'] })).toBe(false);
  });

  it('returns false when keywords array is empty', () => {
    expect(matchesKeywordTrigger('anything', { keywords: [] })).toBe(false);
  });

  it("default match_type='contains' does case-insensitive substring", () => {
    const cfg = { keywords: ['support'] };
    expect(matchesKeywordTrigger('I need SUPPORT please', cfg)).toBe(true);
    expect(matchesKeywordTrigger('Support is great', cfg)).toBe(true);
    expect(matchesKeywordTrigger('Help me', cfg)).toBe(false);
  });

  it("match_type='exact' compares the whole string case-insensitively", () => {
    const cfg = { keywords: ['help'], match_type: 'exact' as const };
    expect(matchesKeywordTrigger('help', cfg)).toBe(true);
    expect(matchesKeywordTrigger('HELP', cfg)).toBe(true);
    expect(matchesKeywordTrigger('help me', cfg)).toBe(false);
  });

  it('case_sensitive=true preserves case', () => {
    const cfg = {
      keywords: ['Support'],
      case_sensitive: true,
    };
    expect(matchesKeywordTrigger('I need Support', cfg)).toBe(true);
    expect(matchesKeywordTrigger('I need support', cfg)).toBe(false);
  });

  it('matches any one of multiple keywords', () => {
    const cfg = { keywords: ['help', 'support', 'issue'] };
    expect(matchesKeywordTrigger('I have an issue', cfg)).toBe(true);
    expect(matchesKeywordTrigger('I need Help!', cfg)).toBe(true);
    expect(matchesKeywordTrigger('nothing to see here', cfg)).toBe(false);
  });

  it('skips empty strings in the keywords array', () => {
    const cfg = { keywords: ['', 'support', ''] };
    expect(matchesKeywordTrigger('support center', cfg)).toBe(true);
    expect(matchesKeywordTrigger('nope', cfg)).toBe(false);
  });
});

describe('node classification helpers', () => {
  it('isAutoAdvancing covers start + send_message + send_media + condition + set_tag', () => {
    expect(isAutoAdvancing('start')).toBe(true);
    expect(isAutoAdvancing('send_message')).toBe(true);
    expect(isAutoAdvancing('send_media')).toBe(true);
    expect(isAutoAdvancing('condition')).toBe(true);
    expect(isAutoAdvancing('set_tag')).toBe(true);
    expect(isAutoAdvancing('send_buttons')).toBe(false);
    expect(isAutoAdvancing('send_list')).toBe(false);
    expect(isAutoAdvancing('collect_input')).toBe(false);
    expect(isAutoAdvancing('handoff')).toBe(false);
    expect(isAutoAdvancing('end')).toBe(false);
  });

  it('isSuspending covers the input-requiring nodes', () => {
    expect(isSuspending('send_buttons')).toBe(true);
    expect(isSuspending('send_list')).toBe(true);
    expect(isSuspending('collect_input')).toBe(true);
    expect(isSuspending('start')).toBe(false);
    expect(isSuspending('send_message')).toBe(false);
    expect(isSuspending('condition')).toBe(false);
    expect(isSuspending('set_tag')).toBe(false);
    expect(isSuspending('handoff')).toBe(false);
    expect(isSuspending('end')).toBe(false);
  });

  it('isTerminal covers handoff + end', () => {
    expect(isTerminal('handoff')).toBe(true);
    expect(isTerminal('end')).toBe(true);
    expect(isTerminal('start')).toBe(false);
    expect(isTerminal('send_buttons')).toBe(false);
    expect(isTerminal('condition')).toBe(false);
  });

  it('the three classifications are mutually exclusive for known node types', () => {
    const types = [
      'start',
      'send_message',
      'send_buttons',
      'send_list',
      'send_media',
      'collect_input',
      'condition',
      'set_tag',
      'handoff',
      'end',
    ];
    for (const t of types) {
      const flags = [isAutoAdvancing(t), isSuspending(t), isTerminal(t)];
      // Exactly one of the three should be true for every known node.
      expect(flags.filter(Boolean).length).toBe(1);
    }
  });
});

describe('evaluateConditionPredicate', () => {
  it('present: true when subject has a value', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: 'alice@example.com',
        configValue: undefined,
      })
    ).toBe(true);
  });

  it('present: false when subject is undefined or empty', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: undefined,
        configValue: undefined,
      })
    ).toBe(false);
    expect(
      evaluateConditionPredicate({
        operator: 'present',
        subjectValue: '',
        configValue: undefined,
      })
    ).toBe(false);
  });

  it('absent: inverse of present', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'absent',
        subjectValue: undefined,
        configValue: undefined,
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'absent',
        subjectValue: 'x',
        configValue: undefined,
      })
    ).toBe(false);
  });

  it('equals: exact string comparison; case-sensitive', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: 'VIP',
        configValue: 'VIP',
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: 'vip',
        configValue: 'VIP',
      })
    ).toBe(false);
  });

  it('equals: undefined subject never matches (even against empty)', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'equals',
        subjectValue: undefined,
        configValue: '',
      })
    ).toBe(false);
  });

  it('contains: substring match', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: 'support@example.com',
        configValue: '@example.com',
      })
    ).toBe(true);
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: 'support@other.com',
        configValue: '@example.com',
      })
    ).toBe(false);
  });

  it('contains: undefined subject never matches', () => {
    expect(
      evaluateConditionPredicate({
        operator: 'contains',
        subjectValue: undefined,
        configValue: 'anything',
      })
    ).toBe(false);
  });
});

// ============================================================
// p11.4 — one send per step, also under concurrency.
// ============================================================

/** Literal PostgREST format (microseconds), as `select('*')` returns it. */
const READ_AT = '2026-10-01T10:00:00.123456+00:00';

const BUTTONS_NODE = {
  node_key: 'menu',
  node_type: 'send_buttons',
  config: {
    text: '¿Qué necesitas?',
    buttons: [
      { reply_id: 'precio', title: 'Precio', next_node_key: 'info' },
      { reply_id: 'otra', title: 'Otra vez', next_node_key: 'menu' },
    ],
  },
};

/** menu → (precio) info: send_message → ask: send_buttons */
const RACE_NODES = [
  BUTTONS_NODE,
  {
    node_key: 'info',
    node_type: 'send_message',
    config: { text: 'Cuesta 10.', next_node_key: 'ask' },
  },
  {
    node_key: 'ask',
    node_type: 'send_buttons',
    config: {
      text: '¿Algo más?',
      buttons: [{ reply_id: 'no', title: 'No', next_node_key: 'bye' }],
    },
  },
  { node_key: 'bye', node_type: 'end', config: {} },
];

function activeRun(overrides: Record<string, unknown> = {}) {
  return {
    id: 'run-1',
    flow_id: 'flow-1',
    account_id: 'acct-1',
    user_id: 'u-1',
    contact_id: 'ct-1',
    conversation_id: 'cv-1',
    status: 'active',
    current_node_key: 'menu',
    last_prompt_message_id: null,
    vars: {},
    reprompt_count: 0,
    started_at: '2026-10-01T09:00:00.000000+00:00',
    last_advanced_at: READ_AT,
    ended_at: null,
    end_reason: null,
    ...overrides,
  };
}

function tap(replyId: string, metaId: string) {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message: {
      kind: 'interactive_reply',
      reply_id: replyId,
      reply_title: replyId,
      meta_message_id: metaId,
    },
    isFirstInboundMessage: false,
  });
}

function typed(text: string, metaId: string) {
  return dispatchInboundToFlows({
    accountId: 'acct-1',
    userId: 'u-1',
    contactId: 'ct-1',
    conversationId: 'cv-1',
    message: { kind: 'text', text, meta_message_id: metaId },
    isFirstInboundMessage: false,
  });
}

/** Run `first`, then `second` with the run as it was BEFORE `first`
 *  (both read the row before either wrote) — the race of R6/R7. */
async function race<T>(first: () => Promise<T>, second: () => Promise<T>) {
  const before = JSON.parse(JSON.stringify(db.state.run));
  const a = await first();
  db.state.staleRead = before;
  const b = await second();
  db.state.staleRead = null;
  return [a, b] as const;
}

function sendCount() {
  return (
    send.text.mock.calls.length +
    send.media.mock.calls.length +
    send.buttons.mock.calls.length +
    send.list.mock.calls.length
  );
}

function errorReasons() {
  return db.state.events
    .filter((e) => e.event_type === 'error')
    .map((e) => (e.payload as { reason: string }).reason);
}

describe('flows — un solo envío por paso (p11.4)', () => {
  beforeEach(() => {
    db.state.run = activeRun();
    db.state.staleRead = null;
    db.state.nodes = RACE_NODES;
    db.state.flow = {
      id: 'flow-1',
      account_id: 'acct-1',
      fallback_policy: {
        on_unknown_reply: 'reprompt',
        max_reprompts: 3,
        on_exhaust: 'handoff',
      },
    };
    db.state.events = [];
    db.state.runUpdates = [];
    db.state.throwOnRunUpdate = null;
    db.state.throwOnLoad = false;
    send.text.mockResolvedValue({ whatsapp_message_id: 'wamid.t' });
    send.buttons.mockResolvedValue({ whatsapp_message_id: 'wamid.b' });
    send.list.mockResolvedValue({ whatsapp_message_id: 'wamid.l' });
  });

  it('R6 two taps on the same step at once: the branch is sent once', async () => {
    const [a, b] = await race(
      () => tap('precio', 'wamid.in1'),
      () => tap('precio', 'wamid.in2')
    );
    expect(a).toMatchObject({ consumed: true, outcome: 'advanced' });
    expect(b).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'lost_race',
    });
    expect(send.text).toHaveBeenCalledTimes(1); // info
    expect(send.buttons).toHaveBeenCalledTimes(1); // ask
    expect(errorReasons()).toContain('lost_race_before_advance');
    expect(db.state.run!.current_node_key).toBe('ask');
  });

  it('R6 the claim moves the pointer and resets reprompt_count in one write', async () => {
    await tap('precio', 'wamid.in1');
    const claim = db.state.runUpdates[0];
    expect(claim.matched).toBe(true);
    expect(claim.payload).toMatchObject({
      current_node_key: 'info',
      reprompt_count: 0,
    });
    expect(db.state.runUpdates.length).toBeGreaterThan(0);
  });

  it('R6 the claim lands before any send of the branch', async () => {
    const pointerAtSend: unknown[] = [];
    send.text.mockImplementation(async () => {
      pointerAtSend.push(db.state.run!.current_node_key);
      return { whatsapp_message_id: 'wamid.t' };
    });
    await tap('precio', 'wamid.in1');
    expect(pointerAtSend).toEqual(['info']);
  });

  it('R6 a button pointing at its own node: old and new key equal, still one send', async () => {
    const [a, b] = await race(
      () => tap('otra', 'wamid.in1'),
      () => tap('otra', 'wamid.in2')
    );
    expect(a.consumed).toBe(true);
    expect(b.outcome).toBe('lost_race');
    expect(send.buttons).toHaveBeenCalledTimes(1);
  });

  it('R6 two texts to a collect_input: the stored var is the winner’s', async () => {
    db.state.nodes = [
      {
        node_key: 'ask_email',
        node_type: 'collect_input',
        config: {
          prompt_text: '¿Tu correo?',
          var_key: 'email',
          next_node_key: 'thanks',
        },
      },
      {
        node_key: 'thanks',
        node_type: 'send_message',
        config: { text: 'Gracias {{vars.email}}', next_node_key: 'bye' },
      },
      { node_key: 'bye', node_type: 'end', config: {} },
    ];
    db.state.run = activeRun({ current_node_key: 'ask_email' });
    const [, b] = await race(
      () => typed('a@x.com', 'wamid.in1'),
      () => typed('b@y.com', 'wamid.in2')
    );
    expect(b.outcome).toBe('lost_race');
    expect(db.state.run!.vars).toEqual({ email: 'a@x.com' });
    expect(send.text).toHaveBeenCalledOnce();
    expect((send.text.mock.calls[0] as unknown[])[0]).toMatchObject({
      text: 'Gracias a@x.com',
    });
    // The loser never wrote `vars`.
    const varWrites = db.state.runUpdates.filter(
      (u) => u.matched && 'vars' in u.payload
    );
    expect(varWrites).toHaveLength(1);
  });

  it('R7 two non-matching replies at once: the prompt is re-sent once', async () => {
    const [a, b] = await race(
      () => typed('hola', 'wamid.in1'),
      () => typed('hola?', 'wamid.in2')
    );
    expect(a).toMatchObject({ consumed: true, outcome: 'fallback_fired' });
    expect(b).toEqual({
      consumed: true,
      flow_run_id: 'run-1',
      outcome: 'lost_race',
    });
    expect(send.buttons).toHaveBeenCalledTimes(1);
    expect(errorReasons()).toContain('lost_race_before_reprompt');
    expect(db.state.run!.reprompt_count).toBe(1);
  });

  it('R8 send_buttons throwing after Meta accepted, on advance: consumed, one call, run failed', async () => {
    send.buttons.mockRejectedValue(
      new Error('sent to Meta but DB insert failed')
    );
    const r = await tap('precio', 'wamid.in1');
    expect(r.consumed).toBe(true);
    expect(send.buttons).toHaveBeenCalledTimes(1);
    expect(errorReasons()).toContain('send_buttons_failed');
    expect(db.state.run!.status).toBe('failed');
    expect(db.state.run!.end_reason).toBe('send_buttons_failed');
  });

  it('R8 send_list throwing on advance: consumed, one call, run failed', async () => {
    db.state.nodes = [
      BUTTONS_NODE,
      {
        node_key: 'info',
        node_type: 'send_list',
        config: {
          text: 'Elige',
          button_label: 'Ver',
          sections: [
            {
              title: 'A',
              rows: [{ reply_id: 'r1', title: 'Uno', next_node_key: 'bye' }],
            },
          ],
        },
      },
      { node_key: 'bye', node_type: 'end', config: {} },
    ];
    send.list.mockRejectedValue(new Error('sent to Meta but DB insert failed'));
    const r = await tap('precio', 'wamid.in1');
    expect(r.consumed).toBe(true);
    expect(send.list).toHaveBeenCalledTimes(1);
    expect(errorReasons()).toContain('send_list_failed');
    expect(db.state.run!.end_reason).toBe('send_list_failed');
  });

  it('R8 send_buttons throwing on reprompt: consumed, one call, reprompt_send_failed', async () => {
    send.buttons.mockRejectedValue(
      new Error('sent to Meta but DB insert failed')
    );
    const r = await typed('hola', 'wamid.in1');
    expect(r).toMatchObject({ consumed: true, outcome: 'fallback_fired' });
    expect(send.buttons).toHaveBeenCalledTimes(1);
    expect(errorReasons()).toContain('reprompt_send_failed');
  });

  it('R10 a chain sends exactly once per sending node', async () => {
    db.state.nodes = [
      {
        node_key: 'menu',
        node_type: 'send_buttons',
        config: {
          text: '¿Seguimos?',
          buttons: [{ reply_id: 'si', title: 'Sí', next_node_key: 'start' }],
        },
      },
      {
        node_key: 'start',
        node_type: 'start',
        config: { next_node_key: 'm1' },
      },
      {
        node_key: 'm1',
        node_type: 'send_message',
        config: { text: 'Uno', next_node_key: 'tag' },
      },
      {
        node_key: 'tag',
        node_type: 'set_tag',
        config: { mode: 'add', tag_id: 'tag-1', next_node_key: 'm2' },
      },
      {
        node_key: 'm2',
        node_type: 'send_message',
        config: { text: 'Dos', next_node_key: 'bye' },
      },
      { node_key: 'bye', node_type: 'end', config: {} },
    ];
    const r = await tap('si', 'wamid.in1');
    expect(r).toMatchObject({ consumed: true, outcome: 'completed' });
    expect(send.text).toHaveBeenCalledTimes(2);
    expect(sendCount()).toBe(2);
  });

  it('R10 the same meta_message_id twice: the second sends nothing', async () => {
    await tap('otra', 'wamid.same');
    const before = sendCount();
    const r = await tap('otra', 'wamid.same');
    expect(r.outcome).toBe('duplicate_inbound_ignored');
    expect(sendCount()).toBe(before);
  });

  it('R9 a throw after the run was engaged keeps the inbound consumed', async () => {
    // Update #0 is the claim, #1 the last_prompt_message_id write after
    // the send_buttons of `ask`, #2 the pointer move to `ask` — outside
    // any per-node try, so it reaches the dispatch's catch.
    db.state.throwOnRunUpdate = 2;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await tap('precio', 'wamid.in1');
    expect(r).toEqual({ consumed: true, outcome: 'completed' });
    expect(send.text).toHaveBeenCalledTimes(1);
    expect(send.buttons).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it('R9 a throw while looking the run up leaves the inbound unconsumed', async () => {
    db.state.throwOnLoad = true;
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const r = await tap('precio', 'wamid.in1');
    expect(r).toEqual({ consumed: false, outcome: 'no_match' });
    expect(sendCount()).toBe(0);
    err.mockRestore();
  });
});
