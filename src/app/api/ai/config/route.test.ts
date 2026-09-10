import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Supuesto S1 (la IA la paga el servicio): the config route must accept a
// save with NO api_key when the deployment has a platform key for the chosen
// provider, validate against that key, and store api_key = null. On a
// deployment without platform keys the behaviour is unchanged: the key is
// required.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  getCurrentAccount: vi.fn(),
  validateAiCredentials: vi.fn(),
  embedTexts: vi.fn(),
  state: {
    existing: null as Record<string, unknown> | null,
    /** Row the `profiles` membership lookup returns (null = not a member). */
    member: null as Record<string, unknown> | null,
    inserts: [] as Record<string, unknown>[],
    updates: [] as Record<string, unknown>[],
    filters: [] as [string, unknown][],
  },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  getCurrentAccount: mocks.getCurrentAccount,
  toErrorResponse: vi.fn(() =>
    Response.json({ error: 'auth failed' }, { status: 403 })
  ),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => Response.json({ error: 'rl' }, { status: 429 }),
  RATE_LIMITS: { adminAction: {} },
}));
vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('@/lib/ai/validate', () => ({
  validateAiCredentials: mocks.validateAiCredentials,
}));
vi.mock('@/lib/ai/embeddings', () => ({ embedTexts: mocks.embedTexts }));

import { GET, POST } from './route';

function supabaseMock() {
  return {
    from: (table: string) => {
      const chain = {
        select: () => chain,
        eq: (col: string, val: unknown) => {
          mocks.state.filters.push([col, val]);
          return chain;
        },
        maybeSingle: () =>
          Promise.resolve({
            data:
              table === 'ai_configs'
                ? mocks.state.existing
                : table === 'profiles'
                  ? mocks.state.member
                  : null,
            error: null,
          }),
        insert: (row: Record<string, unknown>) => {
          mocks.state.inserts.push(row);
          return Promise.resolve({ error: null });
        },
        update: (row: Record<string, unknown>) => {
          mocks.state.updates.push(row);
          return { eq: () => Promise.resolve({ error: null }) };
        },
      };
      return chain;
    },
  };
}

const ctx = () => ({
  supabase: supabaseMock(),
  accountId: 'acct-1',
  userId: 'user-1',
  role: 'admin',
  account: { id: 'acct-1', name: 'Acme' },
});

function post(body: unknown) {
  return new Request('http://localhost/api/ai/config', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const BASE_BODY = { provider: 'openai', model: 'gpt-x', is_active: true };

beforeEach(() => {
  mocks.state.existing = null;
  mocks.state.member = null;
  mocks.state.inserts = [];
  mocks.state.updates = [];
  mocks.state.filters = [];
  mocks.requireRole.mockResolvedValue(ctx());
  mocks.getCurrentAccount.mockResolvedValue(ctx());
  mocks.validateAiCredentials.mockResolvedValue(undefined);
  vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
  vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/ai/config — key resolution', () => {
  it('still requires api_key on a first save when there is no platform key (pre-S1 behaviour)', async () => {
    const res = await POST(post(BASE_BODY));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'api_key is required' });
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled();
    expect(mocks.state.inserts).toEqual([]);
  });

  it('accepts a first save without api_key when the platform key exists: validates with it and stores api_key = null', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const res = await POST(post(BASE_BODY));
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials).toHaveBeenCalledTimes(1);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-x',
      apiKey: 'sk-platform',
    });
    expect(mocks.state.inserts).toHaveLength(1);
    expect(mocks.state.inserts[0]).toMatchObject({
      account_id: 'acct-1',
      created_by: 'user-1',
      api_key: null,
      provider: 'openai',
    });
  });

  it("does not fall back to another provider's platform key", async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const res = await POST(post({ ...BASE_BODY, provider: 'anthropic' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'api_key is required' });
  });

  it('prefers a typed key over the platform key and stores it encrypted', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const res = await POST(post({ ...BASE_BODY, api_key: 'sk-own' }));
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-own',
    });
    expect(mocks.state.inserts[0]).toMatchObject({ api_key: 'enc:sk-own' });
  });

  it('prefers the stored key over the platform key on update', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-old',
      api_key: 'enc:sk-stored',
    };
    const res = await POST(post(BASE_BODY)); // model changed → re-validate
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-stored',
    });
    expect(mocks.state.updates).toHaveLength(1);
    expect(mocks.state.updates[0]).not.toHaveProperty('api_key');
  });

  it('updates a platform-backed row (stored api_key null) using the platform key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = {
      id: 'cfg-1',
      provider: 'openai',
      model: 'gpt-old',
      api_key: null,
    };
    const res = await POST(post(BASE_BODY));
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-platform',
    });
    expect(mocks.state.updates[0]).not.toHaveProperty('api_key');
  });

  it('scopes every ai_configs query to the caller account', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    await POST(post(BASE_BODY));
    expect(mocks.state.filters).toContainEqual(['account_id', 'acct-1']);
  });
});

describe('GET /api/ai/config — platform key availability', () => {
  it('reports per-provider availability without exposing the keys (unconfigured)', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const res = await GET();
    const body = await res.json();
    expect(body).toEqual({
      configured: false,
      platform_key_available: { openai: true, anthropic: false },
    });
    expect(JSON.stringify(body)).not.toContain('sk-platform');
  });

  it('reports availability alongside a configured row and never returns the stored key', async () => {
    vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', 'sk-ant-platform');
    mocks.state.existing = {
      provider: 'openai',
      model: 'gpt-x',
      system_prompt: null,
      is_active: true,
      auto_reply_enabled: false,
      auto_reply_max_per_conversation: 3,
      handoff_agent_id: null,
      api_key: 'enc:sk-stored',
      embeddings_api_key: null,
    };
    const res = await GET();
    const body = await res.json();
    expect(body.configured).toBe(true);
    expect(body.has_key).toBe(true);
    expect(body.platform_key_available).toEqual({
      openai: false,
      anthropic: true,
    });
    expect(body).not.toHaveProperty('api_key');
    expect(JSON.stringify(body)).not.toContain('sk-');
  });
});

describe('POST /api/ai/config — handoff mode (fase 1)', () => {
  beforeEach(() => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
  });

  it('rejects an unknown handoff_mode', async () => {
    const res = await POST(post({ ...BASE_BODY, handoff_mode: 'roulette' }));
    expect(res.status).toBe(400);
    expect(mocks.state.inserts).toEqual([]);
  });

  it('stores auto mode with no fixed agent', async () => {
    const res = await POST(
      post({ ...BASE_BODY, handoff_mode: 'auto', handoff_agent_id: null })
    );
    expect(res.status).toBe(200);
    expect(mocks.state.inserts[0]).toMatchObject({
      handoff_mode: 'auto',
      handoff_agent_id: null,
    });
  });

  it('requires a member agent when handoff_mode is fixed', async () => {
    const res = await POST(post({ ...BASE_BODY, handoff_mode: 'fixed' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'handoff_agent_id is required when handoff_mode is "fixed"',
    });
  });

  it('rejects a fixed agent who is not a member of the account', async () => {
    mocks.state.member = null;
    const res = await POST(
      post({
        ...BASE_BODY,
        handoff_mode: 'fixed',
        handoff_agent_id: 'stranger',
      })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'handoff_agent_id must be a member of this account',
    });
  });

  it('stores fixed mode with a member agent', async () => {
    mocks.state.member = { user_id: 'agent-7' };
    const res = await POST(
      post({ ...BASE_BODY, handoff_mode: 'fixed', handoff_agent_id: 'agent-7' })
    );
    expect(res.status).toBe(200);
    expect(mocks.state.inserts[0]).toMatchObject({
      handoff_mode: 'fixed',
      handoff_agent_id: 'agent-7',
    });
  });

  it('leaves handoff_mode untouched on a partial update that omits it', async () => {
    mocks.state.existing = {
      id: 'cfg',
      provider: 'openai',
      model: 'gpt-x',
      api_key: null,
    };
    const res = await POST(post(BASE_BODY));
    expect(res.status).toBe(200);
    expect(mocks.state.updates[0]).not.toHaveProperty('handoff_mode');
  });
});
