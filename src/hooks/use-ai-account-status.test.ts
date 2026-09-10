import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  fetchAiAccountStatus,
  __resetAiAccountStatusCache,
} from './use-ai-account-status';

/**
 * The inbox list renders the "AI is replying" state on every row, so
 * the account-wide flag behind it must cost ONE request per account,
 * not one per conversation (fase 1 §3: "No añade consultas por
 * conversación"). These pin that, plus the two rules the cache had
 * when it lived inside ai-thread-banner.tsx.
 */
function jsonResponse(body: unknown, ok = true) {
  return {
    ok,
    json: async () => body,
  } as unknown as Response;
}

describe('fetchAiAccountStatus', () => {
  beforeEach(() => {
    __resetAiAccountStatusCache();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('is live only when configured + active + auto-reply enabled', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: true,
    });
  });

  it.each([
    [
      'not configured',
      { configured: false, is_active: true, auto_reply_enabled: true },
    ],
    [
      'master switch off',
      { configured: true, is_active: false, auto_reply_enabled: true },
    ],
    [
      'inbound bot off',
      { configured: true, is_active: true, auto_reply_enabled: false },
    ],
  ])('is off when %s', async (_label, body) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse(body)));
    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: false,
    });
  });

  it('hits the endpoint once per account, however many rows ask', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(
        jsonResponse({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    // Two callers at once (banner + list on mount) share the in-flight
    // promise; every later row reads the cache.
    const results = await Promise.all([
      fetchAiAccountStatus('acct-1'),
      fetchAiAccountStatus('acct-1'),
    ]);
    await fetchAiAccountStatus('acct-1');

    expect(results.every((r) => r.autoReplyOn)).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keys the cache by account so a workspace switch re-reads', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
        })
      )
      .mockResolvedValueOnce(
        jsonResponse({
          configured: false,
          is_active: false,
          auto_reply_enabled: false,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: true,
    });
    await expect(fetchAiAccountStatus('acct-2')).resolves.toEqual({
      autoReplyOn: false,
    });
  });

  it('does not cache a failed response — it retries next time', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, false))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: false,
    });
    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: true,
    });
  });

  it('does not cache a network error either', async () => {
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        jsonResponse({
          configured: true,
          is_active: true,
          auto_reply_enabled: true,
        })
      );
    vi.stubGlobal('fetch', fetchMock);

    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: false,
    });
    await expect(fetchAiAccountStatus('acct-1')).resolves.toEqual({
      autoReplyOn: true,
    });
  });
});
