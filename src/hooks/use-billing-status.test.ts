import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BILLING_STATUS_TTL_MS,
  fetchBillingStatus,
  __resetBillingStatusCache,
} from './use-billing-status';

/**
 * p6.2 §2 asks for the trial countdown "sin consulta nueva por página":
 * the header banner and the in-page dunning alert mount together on
 * every dashboard page, and between them they may cost ONE
 * `/api/billing/status` round-trip per account. These pin that, plus
 * the rule that an unreadable status is unknown and never a state.
 */
function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

const BODY = {
  planId: 'inicio',
  status: 'trialing',
  readOnly: false,
  graceUntil: null,
  trialEndsAt: '2026-09-19T00:00:00.000Z',
  currentPeriodEnd: null,
  cancelAtPeriodEnd: false,
};

describe('fetchBillingStatus', () => {
  beforeEach(() => {
    __resetBillingStatusCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('returns the subscription status the server resolved', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(BODY)));
    await expect(fetchBillingStatus('acct-1')).resolves.toMatchObject(BODY);
  });

  it('stamps the snapshot with the clock it was read at', async () => {
    // The trial countdown renders from this instead of calling
    // `Date.now()` during render, which React 19 forbids.
    vi.useFakeTimers();
    vi.setSystemTime(Date.parse('2026-09-14T12:00:00.000Z'));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(BODY)));

    const status = await fetchBillingStatus('acct-1');
    expect(status?.readAt).toBe(Date.parse('2026-09-14T12:00:00.000Z'));
  });

  it('hits the endpoint once per account, however many banners ask', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(BODY));
    vi.stubGlobal('fetch', fetchMock);

    // The header banner and the page alert mount in the same commit.
    await Promise.all([
      fetchBillingStatus('acct-1'),
      fetchBillingStatus('acct-1'),
    ]);
    await fetchBillingStatus('acct-1');

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by account, so a support session never reuses the other company', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(BODY));
    vi.stubGlobal('fetch', fetchMock);

    await fetchBillingStatus('acct-1');
    await fetchBillingStatus('acct-2');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('re-reads after the TTL, so contracting a plan drops the banner on its own', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(BODY));
    vi.stubGlobal('fetch', fetchMock);

    vi.useFakeTimers();
    await fetchBillingStatus('acct-1');
    vi.setSystemTime(Date.now() + BILLING_STATUS_TTL_MS + 1);
    await fetchBillingStatus('acct-1');

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('resolves to unknown — not to a state — when the read fails', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(jsonResponse({ error: 'nope' }, false))
    );
    await expect(fetchBillingStatus('acct-1')).resolves.toBeNull();

    __resetBillingStatusCache();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(fetchBillingStatus('acct-1')).resolves.toBeNull();
  });

  it('does not cache a failure: the next mount retries', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(null, false))
      .mockResolvedValueOnce(jsonResponse(BODY));
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchBillingStatus('acct-1')).resolves.toBeNull();
    await expect(fetchBillingStatus('acct-1')).resolves.toMatchObject(BODY);
  });
});
