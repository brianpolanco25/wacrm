import { describe, expect, it, vi } from 'vitest';

import {
  activateAndTest,
  cardStatus,
  credentialLabel,
  runConnectionTest,
  visibleActions,
} from './integration-card-state';

// n13.1 (R19): estado × rol → acciones, y la secuencia PUT → POST test.

const view = (over: Partial<{ retired: boolean; enabled: boolean }> = {}) => ({
  retired: false,
  enabled: false,
  ...over,
});

describe('cardStatus', () => {
  it.each([
    [view(), true, 'inactive'],
    [view({ enabled: true }), true, 'active'],
    [view(), false, 'planRequired'],
    [view({ enabled: true }), false, 'planRequired'],
    [view({ retired: true, enabled: true }), true, 'retired'],
    [view({ retired: true, enabled: true }), false, 'retired'],
  ])('%o with planAllows=%s → %s', (v, planAllows, expected) => {
    expect(cardStatus(v, planAllows)).toBe(expected);
  });
});

describe('visibleActions', () => {
  const manage = { planAllows: true, canManage: true };

  it('admin: activate when not enabled; test, change, deactivate when enabled', () => {
    expect(visibleActions(view(), manage)).toEqual(['activate']);
    expect(visibleActions(view({ enabled: true }), manage)).toEqual([
      'test',
      'change',
      'deactivate',
    ]);
  });

  it('agent / viewer / support session (canManage false): read only', () => {
    for (const v of [
      view(),
      view({ enabled: true }),
      view({ retired: true, enabled: true }),
    ]) {
      expect(visibleActions(v, { planAllows: true, canManage: false })).toEqual(
        []
      );
    }
  });

  it('without the plan or retired: only deactivate, and only if enabled', () => {
    expect(
      visibleActions(view(), { planAllows: false, canManage: true })
    ).toEqual([]);
    expect(
      visibleActions(view({ enabled: true }), {
        planAllows: false,
        canManage: true,
      })
    ).toEqual(['deactivate']);
    expect(
      visibleActions(view({ retired: true, enabled: true }), manage)
    ).toEqual(['deactivate']);
  });
});

describe('credentialLabel', () => {
  it('Token for bearer, the header name otherwise', () => {
    expect(
      credentialLabel({ authScheme: 'bearer', authHeaderName: null })
    ).toEqual({
      key: 'credentialLabelBearer',
    });
    expect(
      credentialLabel({ authScheme: 'header', authHeaderName: 'X-Api-Key' })
    ).toEqual({
      key: 'credentialLabelHeader',
      header: 'X-Api-Key',
    });
  });
});

const ID = '9a000000-0000-4000-8000-000000000001';
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });

describe('activateAndTest', () => {
  it('PUTs the credential and then POSTs the test', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ integration: { id: ID, enabled: true } }))
      .mockResolvedValueOnce(
        json({ result: 'ok', status: 200, testedAt: 'now' })
      );
    const r = await activateAndTest(ID, 'secret-token', fetcher);
    expect(fetcher.mock.calls.map((c) => [c[0], c[1].method])).toEqual([
      [`/api/account/integrations/${ID}`, 'PUT'],
      [`/api/account/integrations/${ID}/test`, 'POST'],
    ]);
    expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({
      credential: 'secret-token',
    });
    expect(r).toEqual({
      ok: true,
      integration: { id: ID, enabled: true },
      test: { result: 'ok', status: 200, testedAt: 'now' },
    });
  });

  it('a failed PUT does not launch the test', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(json({ error: 'bad' }, 400));
    expect(await activateAndTest(ID, 'x', fetcher)).toEqual({
      ok: false,
      status: 400,
      error: 'bad',
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('a network error on the PUT is a failure, not a throw', async () => {
    const fetcher = vi.fn().mockRejectedValueOnce(new TypeError('offline'));
    expect(await activateAndTest(ID, 'x', fetcher)).toEqual({
      ok: false,
      status: 0,
      error: null,
    });
  });

  it('a test that cannot run (429) keeps the activation and reports no result', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ integration: null }))
      .mockResolvedValueOnce(json({ error: 'Rate limit exceeded' }, 429));
    expect(await activateAndTest(ID, 'x', fetcher)).toEqual({
      ok: true,
      integration: null,
      test: null,
    });
  });
});

describe('runConnectionTest', () => {
  it('returns the result or null', async () => {
    expect(
      await runConnectionTest(ID, async () =>
        json({ result: 'auth_failed', status: 401, testedAt: 't' })
      )
    ).toEqual({ result: 'auth_failed', status: 401, testedAt: 't' });
    expect(await runConnectionTest(ID, async () => json({}, 404))).toBeNull();
  });
});
