import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { generateApiKey } from "@/lib/api-keys/keys";
import type { ApiKeyRow } from "@/lib/api-keys/store";
import { ApiError } from "@/lib/api/v1/respond";
import {
  AccountLockedError,
  FeatureNotAvailableError,
} from "@/lib/billing/enforce";
import { __resetRateLimitForTests, RATE_LIMITS } from "@/lib/rate-limit";

// Mock the service-role client factory — requireApiKey only stashes
// the returned client in the context; tests never call through it.
vi.mock("@/lib/flows/admin-client", () => ({
  supabaseAdmin: () => ({ __isMockAdminClient: true }),
}));

// Fase 3 §4/§5: the enforcement layer. Only the two entry points that
// touch the database are stubbed — `importOriginal` keeps the error
// classes real, so the assertions below are against the genuine
// `FeatureNotAvailableError` / `AccountLockedError`, not a lookalike.
const billing = vi.hoisted(() => {
  const entitlements = {
    planId: "pro",
    status: "active" as const,
    limits: {} as Record<string, number | null>,
    features: ["api", "webhooks"],
    readOnly: false,
    trialEndsAt: null,
  };
  return {
    entitlements,
    assertPlanFeature: vi.fn(async () => entitlements),
    assertWritable: vi.fn(async () => entitlements),
  };
});
vi.mock("@/lib/billing/enforce", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/billing/enforce")>()),
  assertPlanFeature: billing.assertPlanFeature,
  assertWritable: billing.assertWritable,
}));

// Mock the store so we control which row a hash resolves to.
const findActiveKeyByHash = vi.fn<(hash: string) => Promise<ApiKeyRow | null>>();
const touchLastUsed = vi.fn();
vi.mock("@/lib/api-keys/store", () => ({
  findActiveKeyByHash: (hash: string) => findActiveKeyByHash(hash),
  touchLastUsed: (id: string) => touchLastUsed(id),
}));

// Import AFTER the mocks are registered.
const { requireApiKey } = await import("./api-context");

const KEY = generateApiKey().plaintext;

function reqWith(authHeader?: string): Request {
  return new Request("https://crm.example.com/api/v1/me", {
    headers: authHeader ? { authorization: authHeader } : {},
  });
}

function row(overrides: Partial<ApiKeyRow> = {}): ApiKeyRow {
  return {
    id: "key-1",
    account_id: "acct-1",
    created_by: "user-1",
    name: "Test key",
    scopes: ["messages:send"],
    expires_at: null,
    revoked_at: null,
    ...overrides,
  };
}

beforeEach(() => {
  __resetRateLimitForTests();
  findActiveKeyByHash.mockReset();
  touchLastUsed.mockReset();
  billing.assertPlanFeature.mockClear();
  billing.assertPlanFeature.mockResolvedValue(billing.entitlements);
  billing.assertWritable.mockClear();
  billing.assertWritable.mockResolvedValue(billing.entitlements);
});

afterEach(() => {
  __resetRateLimitForTests();
});

async function expectApiError(p: Promise<unknown>, code: string, status: number) {
  await expect(p).rejects.toBeInstanceOf(ApiError);
  await p.catch((e: unknown) => {
    const err = e as ApiError;
    expect(err.code).toBe(code);
    expect(err.status).toBe(status);
  });
}

describe("requireApiKey", () => {
  it("401s when no Authorization header is present", async () => {
    await expectApiError(requireApiKey(reqWith()), "unauthorized", 401);
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s on a token that doesn't look like a wacrm key", async () => {
    await expectApiError(
      requireApiKey(reqWith("Bearer some-invite-token")),
      "unauthorized",
      401,
    );
    expect(findActiveKeyByHash).not.toHaveBeenCalled();
  });

  it("401s when the key is unknown / revoked / expired (store returns null)", async () => {
    findActiveKeyByHash.mockResolvedValue(null);
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "unauthorized",
      401,
    );
  });

  it("returns a context for a valid key with no scope required", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(ctx.authType).toBe("api_key");
    expect(ctx.accountId).toBe("acct-1");
    expect(ctx.keyId).toBe("key-1");
    expect(ctx.scopes).toEqual(["messages:send"]);
    expect(touchLastUsed).toHaveBeenCalledWith("key-1");
  });

  it("accepts a bare key without the 'Bearer ' prefix", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqWith(KEY));
    expect(ctx.accountId).toBe("acct-1");
  });

  it("403s when the key lacks the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["contacts:read"] }));
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send"),
      "forbidden",
      403,
    );
  });

  it("passes when the key has the required scope", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ["messages:send"] }));
    const ctx = await requireApiKey(reqWith(`Bearer ${KEY}`), "messages:send");
    expect(ctx.accountId).toBe("acct-1");
  });

  it("429s once the per-key budget is exhausted", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    // Burn the whole window.
    for (let i = 0; i < RATE_LIMITS.publicApi.limit; i++) {
      await requireApiKey(reqWith(`Bearer ${KEY}`));
    }
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`)),
      "rate_limited",
      429,
    );
  });
});

// ---------------------------------------------------------------------------
// Fase 3 §4: the public API is a plan feature, and §5's read-only ladder
// reaches machine callers too.
// ---------------------------------------------------------------------------
describe('requireApiKey — plan entitlements (fase 3 §4/§5)', () => {
  function reqMethod(method: string): Request {
    return new Request('https://crm.example.com/api/v1/contacts', {
      method,
      headers: { authorization: `Bearer ${KEY}` },
    });
  }

  it("checks the 'api' feature for the key's own account", async () => {
    findActiveKeyByHash.mockResolvedValue(row({ account_id: 'acct-7' }));
    await requireApiKey(reqWith(`Bearer ${KEY}`));
    expect(billing.assertPlanFeature).toHaveBeenCalledWith('acct-7', 'api');
  });

  it("rejects a plan without the 'api' feature, and never touches the key", async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    billing.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('api')
    );
    await expect(
      requireApiKey(reqWith(`Bearer ${KEY}`))
    ).rejects.toBeInstanceOf(FeatureNotAvailableError);
    // The key stays valid: upgrading the plan restores access with no
    // action from the tenant.
    expect(touchLastUsed).not.toHaveBeenCalled();
  });

  it('checks the feature AFTER the scope, so a wrong-scope key still reads as a scope problem', async () => {
    findActiveKeyByHash.mockResolvedValue(row({ scopes: ['contacts:read'] }));
    billing.assertPlanFeature.mockRejectedValue(
      new FeatureNotAvailableError('api')
    );
    await expectApiError(
      requireApiKey(reqWith(`Bearer ${KEY}`), 'messages:send'),
      'forbidden',
      403
    );
    expect(billing.assertPlanFeature).not.toHaveBeenCalled();
  });

  it('lets a read-only account keep READING through its keys', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    const ctx = await requireApiKey(reqMethod('GET'));
    expect(ctx.accountId).toBe('acct-1');
    expect(billing.assertWritable).not.toHaveBeenCalled();
  });

  it('refuses a write from a read-only account', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    billing.assertWritable.mockRejectedValue(
      new AccountLockedError('suspended')
    );
    await expect(requireApiKey(reqMethod('POST'))).rejects.toBeInstanceOf(
      AccountLockedError
    );
    expect(billing.assertWritable).toHaveBeenCalledWith(
      'acct-1',
      billing.entitlements
    );
  });

  it('lets a write through while the subscription is healthy', async () => {
    findActiveKeyByHash.mockResolvedValue(row());
    const ctx = await requireApiKey(reqMethod('POST'));
    expect(ctx.accountId).toBe('acct-1');
  });
});
