import { afterEach, describe, expect, it, vi } from 'vitest';
import { getSubscribedAppsRaw, probeGraphField } from './meta-api';

afterEach(() => vi.unstubAllGlobals());

function stubFetch(status: number, body: unknown) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('probeGraphField', () => {
  it('returns the value of the one field it asked for', async () => {
    const f = stubFetch(200, {
      id: '1',
      webhook_configuration: { application: 'https://x.test/hook' },
    });
    const r = await probeGraphField({
      nodeId: '1',
      field: 'webhook_configuration',
      accessToken: 'tok',
    });
    expect(r).toEqual({
      ok: true,
      value: { application: 'https://x.test/hook' },
    });
    expect(String(f.mock.calls[0][0])).toContain(
      'fields=webhook_configuration'
    );
  });

  it("reports Meta's message instead of throwing, and never echoes the token", async () => {
    stubFetch(400, { error: { message: 'Tried accessing nonexisting field' } });
    const r = await probeGraphField({
      nodeId: '1',
      field: 'nope',
      accessToken: 'secret-token',
    });
    expect(r).toEqual({
      ok: false,
      error: 'Tried accessing nonexisting field',
    });
    expect(JSON.stringify(r)).not.toContain('secret-token');
  });

  it('turns a network failure into a result', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    expect(
      await probeGraphField({ nodeId: '1', field: 'x', accessToken: 't' })
    ).toEqual({ ok: false, error: 'offline' });
  });
});

describe('getSubscribedAppsRaw', () => {
  it('keeps the override and the fields Meta lists per app', async () => {
    const row = {
      whatsapp_business_api_data: { id: 'app' },
      override_callback_uri: 'https://other.test/hook',
      subscribed_fields: ['messages'],
    };
    stubFetch(200, { data: [row] });
    expect(
      await getSubscribedAppsRaw({ wabaId: 'w', accessToken: 't' })
    ).toEqual({ ok: true, rows: [row] });
  });

  it('reports an error instead of throwing', async () => {
    stubFetch(403, { error: { message: 'no permission' } });
    expect(
      await getSubscribedAppsRaw({ wabaId: 'w', accessToken: 't' })
    ).toEqual({ ok: false, error: 'no permission' });
  });
});
