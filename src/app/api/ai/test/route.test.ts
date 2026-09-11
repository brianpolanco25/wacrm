import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// "Test key" with no typed and no stored key: on a deployment with a
// platform key for the provider it tests THAT key (what the account would
// really call the provider with); otherwise it asks for a key, as before.

const mocks = vi.hoisted(() => ({
  requireRole: vi.fn(),
  validateAiCredentials: vi.fn(),
  from: vi.fn(),
  state: { existing: null as Record<string, unknown> | null },
}));

vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
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
  decrypt: (v: string) => v.replace(/^enc:/, ''),
}));
vi.mock('@/lib/ai/validate', () => ({
  validateAiCredentials: mocks.validateAiCredentials,
}));

import { POST } from './route';

const supabase = {
  from: (...args: unknown[]) => {
    mocks.from(...args);
    const chain = {
      select: () => chain,
      eq: () => chain,
      maybeSingle: () =>
        Promise.resolve({ data: mocks.state.existing, error: null }),
    };
    return chain;
  },
};

function post(body: unknown) {
  return new Request('http://localhost/api/ai/test', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  mocks.state.existing = null;
  mocks.requireRole.mockResolvedValue({
    supabase,
    accountId: 'acct-1',
    userId: 'user-1',
    role: 'admin',
    account: { id: 'acct-1', name: 'Acme' },
  });
  mocks.validateAiCredentials.mockResolvedValue(undefined);
  vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', '');
  vi.stubEnv('AI_PLATFORM_ANTHROPIC_API_KEY', '');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('POST /api/ai/test', () => {
  it('asks for a key when nothing is typed, stored or provided by the platform', async () => {
    const res = await POST(post({ provider: 'openai', model: 'gpt-x' }));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter an API key to test.' });
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled();
  });

  it('tests the platform key when nothing is typed or stored', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    const res = await POST(post({ provider: 'openai', model: 'gpt-x' }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      provider: 'openai',
      model: 'gpt-x',
      apiKey: 'sk-platform',
    });
  });

  it('prefers the stored key over the platform key', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = { api_key: 'enc:sk-stored' };
    await POST(post({ provider: 'openai', model: 'gpt-x' }));
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-stored',
    });
  });

  it('prefers a typed key over everything', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = { api_key: 'enc:sk-stored' };
    await POST(
      post({ provider: 'openai', model: 'gpt-x', api_key: 'sk-typed' })
    );
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-typed',
    });
  });

  // The form sends `api_key: null` when the admin has asked to go back
  // to the platform key. Testing the stored key there would report
  // "your key works" about the very key the next save deletes.
  it('tests the platform key on an explicit api_key: null, not the stored one', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = { api_key: 'enc:sk-stored' };
    const res = await POST(
      post({ provider: 'openai', model: 'gpt-x', api_key: null })
    );
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-platform',
      keySource: 'platform',
    });
    // It does not even read the stored key it is about to orphan.
    expect(mocks.from).not.toHaveBeenCalled();
  });

  it('tests the stored key when api_key is absent, even with a platform key around', async () => {
    vi.stubEnv('AI_PLATFORM_OPENAI_API_KEY', 'sk-platform');
    mocks.state.existing = { api_key: 'enc:sk-stored' };
    const res = await POST(post({ provider: 'openai', model: 'gpt-x' }));
    expect(res.status).toBe(200);
    expect(mocks.validateAiCredentials.mock.calls[0][0]).toMatchObject({
      apiKey: 'sk-stored',
      keySource: 'account',
    });
    expect(mocks.from).toHaveBeenCalledWith('ai_configs');
  });

  it('refuses an api_key: null when the provider has no platform key', async () => {
    mocks.state.existing = { api_key: 'enc:sk-stored' };
    const res = await POST(
      post({ provider: 'openai', model: 'gpt-x', api_key: null })
    );
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'Enter an API key to test.' });
    expect(mocks.validateAiCredentials).not.toHaveBeenCalled();
  });
});
