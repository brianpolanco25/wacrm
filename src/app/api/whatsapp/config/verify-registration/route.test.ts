import { beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// #1650 R15–R18 — GET /api/whatsapp/config/verify-registration with
// coexistence.
//
//   R15 always probes is_on_biz_app + platform_type; returns them and
//       the config_id of the row checked
//   R16 true + CLOUD_API → live without registered_at, coexistence_active
//   R17 true + other platform → live false + biz_app_without_coexistence
//   R18 otherwise → the legacy rule, no code; ?detail=1 unchanged
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
  config: null as Record<string, unknown> | null,
  filters: [] as [string, unknown][],
  probes: {} as Record<
    string,
    { ok: true; value: unknown } | { ok: false; error: string }
  >,
  probeCalls: [] as string[],
  verifyPhoneNumber: vi.fn(),
  getSubscribedApps: vi.fn(),
  getSubscribedAppsRaw: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: async () => ({
    auth: {
      getUser: async () => ({ data: { user: { id: 'user-1' } }, error: null }),
    },
    from: () => {
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          h.filters.push([col, val]);
          return chain;
        },
        then: (resolve: (v: unknown) => unknown) =>
          resolve({ data: h.config ? [h.config] : [], error: null }),
      };
      return chain;
    },
  }),
}));

vi.mock('@/lib/auth/account', () => ({
  resolveEffectiveAccountId: async () => 'acct-1',
}));

vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (v: string) => String(v).replace(/^enc:/, ''),
}));

vi.mock('@/lib/whatsapp/meta-api', () => ({
  verifyPhoneNumber: h.verifyPhoneNumber,
  getSubscribedApps: h.getSubscribedApps,
  getSubscribedAppsRaw: h.getSubscribedAppsRaw,
  probeGraphField: async ({ field }: { field: string }) => {
    h.probeCalls.push(field);
    return h.probes[field] ?? { ok: false, error: 'no mock' };
  },
}));

import { GET } from './route';

function get(query = '?config_id=cfg-1') {
  return GET(
    new Request(
      `https://crm.example.com/api/whatsapp/config/verify-registration${query}`
    )
  );
}

beforeEach(() => {
  h.config = {
    id: 'cfg-1',
    account_id: 'acct-1',
    phone_number_id: 'pn-1',
    waba_id: 'waba-1',
    access_token: 'enc:tok',
    registered_at: null,
    coexistence_onboarded_at: '2026-11-02T00:00:00.000Z',
  };
  h.filters = [];
  h.probeCalls = [];
  h.probes = {
    is_on_biz_app: { ok: true, value: true },
    platform_type: { ok: true, value: 'CLOUD_API' },
  };
  h.verifyPhoneNumber.mockReset();
  h.verifyPhoneNumber.mockResolvedValue({ id: 'pn-1' });
  h.getSubscribedApps.mockReset();
  h.getSubscribedApps.mockResolvedValue([{ id: 'app-1' }]);
  h.getSubscribedAppsRaw.mockReset();
  h.getSubscribedAppsRaw.mockResolvedValue({ data: [] });
});

describe('GET /api/whatsapp/config/verify-registration — coexistence', () => {
  it('R15: always probes is_on_biz_app and platform_type and returns them with config_id', async () => {
    const res = await get();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(h.probeCalls.sort()).toEqual(['is_on_biz_app', 'platform_type']);
    expect(body.coexistence).toEqual({
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    });
    expect(body.config_id).toBe('cfg-1');
    expect(h.filters).toContainEqual(['account_id', 'acct-1']);
  });

  it('R15: a failed probe leaves its field null', async () => {
    h.probes.platform_type = { ok: false, error: 'boom' };
    const body = await (await get()).json();
    expect(body.coexistence).toEqual({
      is_on_biz_app: true,
      platform_type: null,
    });
  });

  it('R16: coexistence is live without registered_at', async () => {
    const body = await (await get()).json();
    expect(body.live).toBe(true);
    expect(body.checks.coexistence_active).toBe(true);
    expect(body.checks.locally_marked_registered).toBe(false);
    expect(body.code).toBeUndefined();
  });

  it('R16: coexistence still needs metadata and the WABA subscription', async () => {
    h.getSubscribedApps.mockResolvedValue([]);
    const body = await (await get()).json();
    expect(body.live).toBe(false);
    expect(body.checks.coexistence_active).toBe(true);
  });

  it('R17: on the business app without coexistence → live false + code', async () => {
    h.probes.platform_type = { ok: true, value: 'ON_PREMISE' };
    h.config!.registered_at = '2026-10-01T00:00:00.000Z';
    const body = await (await get()).json();
    expect(body.live).toBe(false);
    expect(body.code).toBe('biz_app_without_coexistence');
    expect(body.checks.coexistence_active).toBe(false);
  });

  it('R18: is_on_biz_app false → legacy rule (needs registered_at), no code', async () => {
    h.probes.is_on_biz_app = { ok: true, value: false };
    let body = await (await get()).json();
    expect(body.live).toBe(false);
    expect(body.code).toBeUndefined();

    h.config!.registered_at = '2026-10-01T00:00:00.000Z';
    body = await (await get()).json();
    expect(body.live).toBe(true);
    expect(body.code).toBeUndefined();
    expect(body.checks.coexistence_active).toBe(false);
  });

  it('R18: both probes failing → legacy rule, no code', async () => {
    h.probes = {};
    h.config!.registered_at = '2026-10-01T00:00:00.000Z';
    const body = await (await get()).json();
    expect(body.live).toBe(true);
    expect(body.code).toBeUndefined();
    expect(body.coexistence).toEqual({
      is_on_biz_app: null,
      platform_type: null,
    });
  });

  it('R18: ?detail=1 keeps its block', async () => {
    const body = await (await get('?config_id=cfg-1&detail=1')).json();
    expect(body.detail.phone).toMatchObject({
      is_on_biz_app: true,
      platform_type: 'CLOUD_API',
    });
    expect(Object.keys(body.detail.phone)).toEqual([
      'webhook_configuration',
      'platform_type',
      'is_on_biz_app',
      'account_mode',
      'status',
      'code_verification_status',
    ]);
    expect(body.detail.subscribed_apps).toEqual({ data: [] });
  });

  it('without a config row answers config_exists false and probes nothing', async () => {
    h.config = null;
    const body = await (await get()).json();
    expect(body.live).toBe(false);
    expect(body.checks.config_exists).toBe(false);
    expect(h.probeCalls).toHaveLength(0);
  });
});
