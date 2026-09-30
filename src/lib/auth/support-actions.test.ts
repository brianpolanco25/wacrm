import { beforeEach, describe, expect, it, vi } from 'vitest';

// The HTTP half of the support-session action log (s9.5): what the
// middleware's tags turn into, and the row written for them.

interface Call {
  table: string;
  op: string;
  payload?: unknown;
  options?: unknown;
  filters: [string, unknown][];
}

const h = vi.hoisted(() => ({
  headers: new Map<string, string>(),
  throwOnHeaders: false,
  calls: [] as Call[],
  error: null as unknown,
}));

vi.mock('next/headers', () => ({
  headers: async () => {
    if (h.throwOnHeaders) throw new Error('called outside a request scope');
    return { get: (name: string) => h.headers.get(name) ?? null };
  },
}));

vi.mock('./admin-client', () => ({
  supabaseAdmin: () => ({
    from(table: string) {
      const call: Call = { table, op: '', filters: [] };
      h.calls.push(call);
      const done = () => Promise.resolve({ data: null, error: h.error });
      const builder = {
        upsert(payload: unknown, options: unknown) {
          call.op = 'upsert';
          call.payload = payload;
          call.options = options;
          return done();
        },
        update(payload: unknown) {
          call.op = 'update';
          call.payload = payload;
          return builder;
        },
        eq(column: string, value: unknown) {
          call.filters.push([column, value]);
          return builder;
        },
        then: (resolve: (v: unknown) => unknown) => done().then(resolve),
      };
      return builder;
    },
  }),
}));

const {
  readSupportWrite,
  recordSupportAction,
  markSupportActionStatus,
  SupportAuditError,
} = await import('./support-actions');

const SESSION = {
  logId: 'log-1',
  actorUserId: '11111111-1111-4111-8111-111111111111',
  accountId: 'aaaaaaaa-0000-4000-8000-000000000001',
};
const REQUEST_ID = '99999999-0000-4000-8000-000000000001';

function tag(method = 'POST', path = '/api/quick-replies') {
  h.headers.set('x-wacrm-support-method', method);
  h.headers.set('x-wacrm-support-path', path);
  h.headers.set('x-wacrm-support-request', REQUEST_ID);
}

beforeEach(() => {
  h.headers = new Map();
  h.throwOnHeaders = false;
  h.calls = [];
  h.error = null;
});

describe('readSupportWrite', () => {
  it('reads the three tags the middleware set', async () => {
    tag('DELETE', '/api/contacts/c-1/tags');
    expect(await readSupportWrite()).toEqual({
      method: 'DELETE',
      path: '/api/contacts/c-1/tags',
      requestId: REQUEST_ID,
    });
  });

  it('is null for an untagged request', async () => {
    expect(await readSupportWrite()).toBeNull();
  });

  it('is null outside a request scope, instead of throwing', async () => {
    h.throwOnHeaders = true;
    expect(await readSupportWrite()).toBeNull();
  });

  it('refuses a method that is not a mutation, or a request id that is not a uuid', async () => {
    tag('GET');
    expect(await readSupportWrite()).toBeNull();
    tag('POST');
    h.headers.set('x-wacrm-support-request', 'not-a-uuid');
    expect(await readSupportWrite()).toBeNull();
  });

  it('truncates a path longer than the column accepts', async () => {
    tag('POST', `/api/${'x'.repeat(5000)}`);
    expect((await readSupportWrite())?.path).toHaveLength(2048);
  });
});

describe('recordSupportAction', () => {
  it('files the row under the signed session, once per request', async () => {
    tag();
    const write = (await readSupportWrite())!;
    expect(await recordSupportAction(SESSION, write)).toBe(true);

    expect(h.calls).toEqual([
      {
        table: 'impersonation_actions',
        op: 'upsert',
        payload: {
          log_id: 'log-1',
          actor_user_id: SESSION.actorUserId,
          account_id: SESSION.accountId,
          method: 'POST',
          path: '/api/quick-replies',
          source: 'http',
          request_id: REQUEST_ID,
        },
        // The UNIQUE request_id is what makes a second resolve of the same
        // request a no-op instead of a second row.
        options: { onConflict: 'request_id', ignoreDuplicates: true },
        filters: [],
      },
    ]);
  });

  it('reports a failure instead of throwing, so the caller can refuse', async () => {
    tag();
    h.error = { message: 'db down' };
    expect(
      await recordSupportAction(SESSION, (await readSupportWrite())!)
    ).toBe(false);
  });
});

describe('markSupportActionStatus', () => {
  it("stamps this request's row, scoped by request, account and session (CP3)", async () => {
    tag();
    await markSupportActionStatus(SESSION, 403);
    expect(h.calls).toEqual([
      {
        table: 'impersonation_actions',
        op: 'update',
        payload: { status: 403 },
        filters: [
          ['request_id', REQUEST_ID],
          ['account_id', SESSION.accountId],
          ['log_id', 'log-1'],
        ],
      },
    ]);
  });

  it('does nothing for an untagged request', async () => {
    await markSupportActionStatus(SESSION, 403);
    expect(h.calls).toEqual([]);
  });
});

describe('SupportAuditError', () => {
  it('is a 503 that says nothing was changed', () => {
    const err = new SupportAuditError();
    expect(err.status).toBe(503);
    expect(err.message).toContain('nothing was changed');
  });
});
