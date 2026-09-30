// ============================================================
// Where a user lands right after signing in (s9.1).
//
//   invite token in the URL  → /join/<token>  (accept first, as before)
//   row in `platform_admins` → /platform      (the operator's panel)
//   anyone else              → /dashboard
//
// Asked in the browser, after `signInWithPassword` has written the
// session cookies, through `/api/platform/me` — the same one-bit route
// the CRM sidebar already uses. Doing it here rather than in the
// middleware keeps a `platform_admins` lookup (service role) out of
// every request of the app: only a sign-in pays for it.
//
// Fails toward /dashboard: a network error, any non-2xx answer or no
// answer within `timeoutMs` is "not an operator". The check runs on EVERY
// sign-in, tenants included, with the session already open — a hung route
// must not leave the button spinning. That is the safe direction — the panel's pages 404 on the
// server regardless, and an operator can still reach /platform from the
// CRM sidebar.
// ============================================================

/** How long a sign-in waits for `/api/platform/me` before giving up. */
export const PLATFORM_CHECK_TIMEOUT_MS = 3000;

export async function postLoginDestination(
  inviteToken: string | null,
  fetchImpl: typeof fetch = fetch,
  timeoutMs: number = PLATFORM_CHECK_TIMEOUT_MS
): Promise<string> {
  if (inviteToken) return `/join/${encodeURIComponent(inviteToken)}`;

  // The signal cancels the request where `fetch` honours it; the race
  // bounds the wait even where it does not.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs);
  });
  try {
    const res = await Promise.race([
      fetchImpl('/api/platform/me', {
        cache: 'no-store',
        signal: AbortSignal.timeout(timeoutMs),
      }),
      timedOut,
    ]);
    if (res === 'timeout') return '/dashboard';
    return res.ok ? '/platform' : '/dashboard';
  } catch {
    return '/dashboard';
  } finally {
    clearTimeout(timer);
  }
}
