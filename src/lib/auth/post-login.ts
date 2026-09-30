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
// Fails toward /dashboard: a network error or any non-2xx answer is "not
// an operator". That is the safe direction — the panel's pages 404 on the
// server regardless, and an operator can still reach /platform from the
// CRM sidebar.
// ============================================================

export async function postLoginDestination(
  inviteToken: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  if (inviteToken) return `/join/${encodeURIComponent(inviteToken)}`;
  try {
    const res = await fetchImpl('/api/platform/me', { cache: 'no-store' });
    return res.ok ? '/platform' : '/dashboard';
  } catch {
    return '/dashboard';
  }
}
