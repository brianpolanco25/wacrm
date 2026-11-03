// ============================================================
// What /join/<token> does on load (i12.1). No "Accept" button:
//
//   signed in  → ONE `POST /api/invitations/<t>/redeem`
//                  200 → /dashboard (joined, or already a member: the
//                        person who signed up through the link was born
//                        inside the company, migration 090)
//                  409 → conflict modal (their account has data, or
//                        they already belong to a shared one)
//                  400 → failure card with the RPC's `reason`
//                  401 → carry on as signed out
//                  5xx / network → server_error, with "Try again"
//   signed out → `GET /api/invitations/<t>/peek` → the company and the
//                role, with "Create account & join" / "I already have
//                an account" — or the failure card.
//
// A plain function over an injected `fetch` so every branch is tested
// without a browser; the page only renders the state it returns.
// ============================================================

export type JoinFailReason =
  'not_found' | 'used' | 'expired' | 'no_seats' | 'server_error';

export const JOIN_FAIL_REASONS: readonly JoinFailReason[] = [
  'not_found',
  'used',
  'expired',
  'no_seats',
  'server_error',
];

export type InviteRole = 'admin' | 'agent' | 'viewer';

export interface InvitePeek {
  account_name: string;
  role: InviteRole;
  expires_at: string;
}

export type JoinState =
  | { kind: 'redirect'; to: '/dashboard' }
  | { kind: 'conflict'; message: string; peek: InvitePeek | null }
  | { kind: 'fail'; reason: JoinFailReason }
  | { kind: 'signedOut'; peek: InvitePeek };

/** What the conflict modal says when the route sent no message. */
export const CONFLICT_FALLBACK = 'fallback';

function isRole(value: unknown): value is InviteRole {
  return value === 'admin' || value === 'agent' || value === 'viewer';
}

/** A reason from the server, or `fallback` for anything unknown. */
export function toFailReason(
  value: unknown,
  fallback: JoinFailReason = 'not_found'
): JoinFailReason {
  return typeof value === 'string' &&
    (JOIN_FAIL_REASONS as readonly string[]).includes(value)
    ? (value as JoinFailReason)
    : fallback;
}

export type PeekOutcome =
  { ok: true; peek: InvitePeek } | { ok: false; reason: JoinFailReason };

/** Read a peek body (any status: 404 and 500 also carry `{ ok, reason }`). */
export function parsePeek(body: unknown): PeekOutcome {
  const b = (body ?? {}) as Record<string, unknown>;
  if (
    b.ok === true &&
    typeof b.account_name === 'string' &&
    isRole(b.role) &&
    typeof b.expires_at === 'string'
  ) {
    return {
      ok: true,
      peek: {
        account_name: b.account_name,
        role: b.role,
        expires_at: b.expires_at,
      },
    };
  }
  return { ok: false, reason: toFailReason(b.reason, 'server_error') };
}

/** `GET …/peek`. A network error or a body that is not JSON is server_error. */
export async function fetchPeek(
  token: string,
  fetchImpl: typeof fetch = fetch
): Promise<PeekOutcome> {
  try {
    const res = await fetchImpl(
      `/api/invitations/${encodeURIComponent(token)}/peek`,
      { cache: 'no-store' }
    );
    return parsePeek(await res.json());
  } catch {
    return { ok: false, reason: 'server_error' };
  }
}

async function signedOutState(
  token: string,
  fetchImpl: typeof fetch
): Promise<JoinState> {
  const peek = await fetchPeek(token, fetchImpl);
  return peek.ok
    ? { kind: 'signedOut', peek: peek.peek }
    : { kind: 'fail', reason: peek.reason };
}

export async function resolveJoin(opts: {
  token: string;
  isSignedIn: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<JoinState> {
  const fetchImpl = opts.fetchImpl ?? fetch;
  const { token } = opts;

  let signedIn = false;
  try {
    signedIn = await opts.isSignedIn();
  } catch {
    signedIn = false;
  }
  if (!signedIn) return signedOutState(token, fetchImpl);

  let res: Response;
  try {
    res = await fetchImpl(
      `/api/invitations/${encodeURIComponent(token)}/redeem`,
      { method: 'POST' }
    );
  } catch {
    return { kind: 'fail', reason: 'server_error' };
  }

  if (res.ok) return { kind: 'redirect', to: '/dashboard' };

  const body = (await res.json().catch(() => ({}))) as {
    error?: unknown;
    reason?: unknown;
  };

  if (res.status === 401) return signedOutState(token, fetchImpl);

  if (res.status === 409) {
    const peek = await fetchPeek(token, fetchImpl);
    return {
      kind: 'conflict',
      message:
        typeof body.error === 'string' && body.error
          ? body.error
          : CONFLICT_FALLBACK,
      peek: peek.ok ? peek.peek : null,
    };
  }

  if (res.status === 400) {
    return { kind: 'fail', reason: toFailReason(body.reason) };
  }

  return { kind: 'fail', reason: 'server_error' };
}
