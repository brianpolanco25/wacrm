import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

// --- Scenario knobs the mock reads -----------------------------------------
// `mockUser`         — what getUser() resolves to (a refreshed session ⇒ user,
//                      or null for the logged-out path).
// `refreshedCookies` — cookies Supabase writes via setAll() during getUser(),
//                      i.e. the freshly *rotated* auth token. The whole point
//                      of the test is that these must survive onto whatever
//                      response the middleware returns — including redirects.
let mockUser: { id: string } | null = null;
let refreshedCookies: Array<{
  name: string;
  value: string;
  options: Record<string, unknown>;
}> = [];

vi.mock("@supabase/ssr", () => ({
  createServerClient: (
    _url: string,
    _key: string,
    opts: {
      cookies: { setAll: (c: typeof refreshedCookies) => void };
    },
  ) => ({
    auth: {
      // Mirrors real auth-js: an expired access token is transparently
      // refreshed inside getUser(), which rotates the refresh token and
      // pushes the new cookies through setAll() before resolving.
      getUser: async () => {
        if (refreshedCookies.length) opts.cookies.setAll(refreshedCookies);
        return { data: { user: mockUser } };
      },
    },
  }),
}));

// Imported after the mock is registered.
const { middleware } = await import("./middleware");

beforeEach(() => {
  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://test.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-key";
  mockUser = null;
  refreshedCookies = [];
});

afterEach(() => vi.clearAllMocks());

const ROTATED = {
  name: "sb-test-auth-token",
  value: "rotated-refresh-token",
  options: { path: "/", httpOnly: true },
};

describe("middleware — refreshed auth cookies survive redirects", () => {
  it("carries the rotated token when redirecting a signed-in user off /login", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login"),
    );

    // Redirect to /dashboard…
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/dashboard");
    // …and the rotated cookie MUST ride along, otherwise the browser keeps
    // replaying the now-consumed refresh token and the session wedges until
    // the user manually clears cookies.
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("carries the rotated token when redirecting an unauth user to /login", async () => {
    mockUser = null;
    // Even on the logged-out path getUser() may emit cookie writes (e.g.
    // clearing a dead session); those must not be dropped on the redirect.
    refreshedCookies = [{ ...ROTATED, value: "cleared" }];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toContain("/login");
    expect(res.cookies.get(ROTATED.name)?.value).toBe("cleared");
  });

  it("redirects a signed-in user with an invite token to /join/<token>", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/login?invite=abc123"),
    );

    expect(res.headers.get("location")).toContain("/join/abc123");
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });

  it("passes through (no redirect) for a signed-in user on a protected page", async () => {
    mockUser = { id: "user-1" };
    refreshedCookies = [ROTATED];

    const res = await middleware(
      new NextRequest("https://app.test/dashboard"),
    );

    // No redirect — the normal NextResponse.next() already carries cookies.
    expect(res.headers.get("location")).toBeNull();
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});

// ============================================================
// A support session is read-only, everywhere.
//
// The effective `viewer` role from `getCurrentAccount()` already stops
// every route that asks `requireRole('agent')` or above. This block is the
// layer under it: a route that never consults the role and writes through
// the operator's OWN session client would land the change in the
// operator's company while they believe they are looking at a customer's.
// Refusing the request outright is the only version that does not depend
// on every present and future route remembering.
// ============================================================

describe("middleware — support sessions cannot write", () => {
  const SUPPORT = "wacrm_support_session";

  function request(
    url: string,
    {
      method = "POST",
      support = true,
    }: { method?: string; support?: boolean } = {},
  ) {
    return new NextRequest(url, {
      method,
      headers: support ? { cookie: `${SUPPORT}=signed.token` } : undefined,
    });
  }

  beforeEach(() => {
    mockUser = { id: "operator-1" };
  });

  it("refuses a mutating API request while the support cookie is present", async () => {
    const res = await middleware(request("https://app.test/api/quick-replies"));
    expect(res.status).toBe(403);
    await expect(res.json()).resolves.toMatchObject({
      error: expect.stringContaining("read-only"),
    });
  });

  it.each(["POST", "PUT", "PATCH", "DELETE"])(
    "refuses %s, not just POST",
    async (method) => {
      const res = await middleware(
        request("https://app.test/api/contacts/abc", { method }),
      );
      expect(res.status).toBe(403);
    },
  );

  it("refuses a mutating page request too, not only /api", async () => {
    // Server actions POST to the page route; they must not slip through.
    const res = await middleware(request("https://app.test/contacts"));
    expect(res.status).toBe(403);
  });

  it("leaves reads alone — looking is the entire point of a support session", async () => {
    const res = await middleware(
      request("https://app.test/api/quick-replies", { method: "GET" }),
    );
    expect(res.status).not.toBe(403);
  });

  it("leaves ordinary users alone when no support cookie is present", async () => {
    const res = await middleware(
      request("https://app.test/api/quick-replies", { support: false }),
    );
    expect(res.status).not.toBe(403);
  });

  it("NEVER blocks the WhatsApp webhook", async () => {
    // Nothing about billing, suspension or support may stop an inbound
    // message from being stored. Meta sends no browser cookie, so this is
    // unreachable in practice — asserted anyway so a refactor cannot make
    // it reachable by accident.
    const res = await middleware(
      request("https://app.test/api/whatsapp/webhook"),
    );
    expect(res.status).not.toBe(403);
  });

  it("does not block the public API or the cron sweeps", async () => {
    for (const path of [
      "/api/v1/messages",
      "/api/automations/cron",
      "/api/flows/cron",
    ]) {
      const res = await middleware(request(`https://app.test${path}`));
      expect(res.status, path).not.toBe(403);
    }
  });

  it("does not block the operator's own way out", async () => {
    // Blocking /api/platform would trap an operator inside the session
    // they are trying to leave.
    const res = await middleware(
      request("https://app.test/api/platform/impersonate/stop"),
    );
    expect(res.status).not.toBe(403);
  });

  it("still carries the rotated auth cookies on the 403", async () => {
    refreshedCookies = [ROTATED];
    const res = await middleware(request("https://app.test/api/quick-replies"));
    expect(res.status).toBe(403);
    expect(res.cookies.get(ROTATED.name)?.value).toBe(ROTATED.value);
  });
});
