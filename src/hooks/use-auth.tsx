"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  useCallback,
  useMemo,
  useRef,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { createClient, endSupportSession } from "@/lib/supabase/client";
import {
  supportAccountFromFlag,
  supportFlagValue,
} from "@/lib/auth/support-cookie";
import type { SupabaseClient, User } from "@supabase/supabase-js";
import { DEFAULT_CURRENCY } from "@/lib/currency";
import {
  canEditSettings as canEditSettingsFor,
  canManageMembers as canManageMembersFor,
  canSendMessages as canSendMessagesFor,
  isAccountRole,
  type AccountRole,
} from "@/lib/auth/roles";

interface Profile {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  /**
   * Opted-in beta feature keys for this account. No current feature
   * reads this — Flows was the last user and went to soft-GA in PR
   * #134 — but the column survives for future beta gates.
   */
  beta_features: string[];
  account_id: string | null;
  account_role: AccountRole | null;
}

interface AccountSummary {
  id: string;
  name: string;
  /** Default deal currency (ISO-4217). NOT NULL DEFAULT 'USD' in the
   *  DB (migration 021); narrowed to DEFAULT_CURRENCY when absent. */
  default_currency: string;
}

/**
 * Whether we managed to establish what this user may do.
 *
 * `unlinked` and `error` are the states worth surfacing: every RLS
 * policy checks `is_account_member(account_id, …)` and every `useCan`
 * gate returns false without a role, so in both the app silently
 * becomes read-only — the whole UI renders, and nothing saves. That is
 * indistinguishable from a bug unless we say so (issue #471).
 */
export type AccountStatus =
  /** Profile row still in flight. */
  | "loading"
  /** Account + role resolved; normal operation. */
  | "ready"
  /** Signed in, but no profile row / no account / no role on it. */
  | "unlinked"
  /** The profile lookup itself failed after retrying. */
  | "error";

interface AuthContextValue {
  user: User | null;
  profile: Profile | null;
  /**
   * Session-level loading. Flips to false as soon as we know whether
   * a user is signed in, *without* waiting for the profile row. Use
   * this for chrome (sidebar / header) that can render with just the
   * user object.
   */
  loading: boolean;
  /**
   * Profile-row loading. Stays true until `fetchProfile` settles
   * (success, missing row, or error). Code that branches on
   * `profile.beta_features` MUST gate on this — otherwise it sees the
   * `{ loading: false, profile: null }` window during initial load
   * and may take the "not opted in" branch incorrectly.
   */
  profileLoading: boolean;
  signOut: () => Promise<void>;
  /** Re-fetch the current user's profile row — call after a save from
   *  the settings form so header/sidebar reflect the change without a
   *  full page reload. */
  refreshProfile: () => Promise<void>;

  // ----------------------------------------------------------
  // Account-scoped context (added by the account-sharing series)
  //
  // All of these are nullable until `profileLoading` is false.
  // After the profile resolves they're guaranteed to be set,
  // because migration 017 made `account_id` / `account_role`
  // NOT NULL on `profiles`.
  // ----------------------------------------------------------

  /**
   * Outcome of resolving this user's account + role. Anything other
   * than `ready` means writes will be rejected — render
   * `<AccountAccessAlert />` (already mounted in the dashboard shell)
   * rather than letting the user discover it one failed save at a time.
   */
  accountStatus: AccountStatus;
  /** Underlying message when `accountStatus` is 'error' / 'unlinked'. */
  accountStatusDetail: string | null;
  /**
   * Account the panel is looking at. The current user's own, except
   * during a support session, when it is the impersonated one — every
   * browser query filters by this, because since migration 057 RLS no
   * longer narrows to a single account for an operator. Null while
   * loading, and null (fail closed) if a support session is flagged but
   * does not name a readable account.
   */
  accountId: string | null;
  /** Role within that account. Null while loading. */
  accountRole: AccountRole | null;
  /** Lightweight account meta — id + name + default_currency. Null while loading. */
  account: AccountSummary | null;
  /** Account default deal currency. Falls back to DEFAULT_CURRENCY
   *  while loading or when no account is resolved, so callers can use
   *  it unconditionally. */
  defaultCurrency: string;
  /** True if `accountRole === 'owner'`. */
  isOwner: boolean;
  /** True if `accountRole === 'admin'` (does NOT include owner — use canManageMembers for "admin or above"). */
  isAdmin: boolean;
  /** True if `accountRole === 'agent'`. */
  isAgent: boolean;
  /** True if `accountRole === 'viewer'`. */
  isViewer: boolean;
  /** True if the caller can manage members (admin+). */
  canManageMembers: boolean;
  /** True if the caller can edit account-wide settings (admin+). */
  canEditSettings: boolean;
  /** True if the caller can send messages and edit operational data (agent+). */
  canSendMessages: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** Attempts at the profile lookup, including the first. */
const PROFILE_FETCH_ATTEMPTS = 2;
const PROFILE_FETCH_RETRY_MS = 1500;

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Shape of the `profiles` select below. */
interface ProfileRow {
  id: string;
  full_name: string | null;
  email: string;
  avatar_url: string | null;
  role: string | null;
  beta_features: string[] | null;
  account_id: string | null;
  account_role: string | null;
}

// ------------------------------------------------------------
// The account this browser is actually looking at
//
// Everything in this panel that talks to Supabase from the browser used
// to be able to assume one thing: "whatever RLS lets me see belongs to my
// account". Migration 057 ended that. A platform operator with an open
// support session now passes `is_account_member(acc) OR
// has_open_support_session(acc)`, so an unfiltered `select()` comes back
// with BOTH companies' rows — interleaved, indistinguishable, under a
// banner naming only one of them — and a query filtered by the operator's
// own `accountId` comes back with the wrong company's rows entirely.
//
// So the browser has to know which account it is showing. The server tells
// it in the support flag cookie, whose value is the impersonated
// `account_id`; `accountId` below is that one while the session lasts and
// the operator's own the rest of the time, and every list filters by it.
// ------------------------------------------------------------

/** The raw support flag, or null outside a browser / outside a session. */
function readSupportFlag(): string | null {
  if (typeof document === "undefined") return null;
  return supportFlagValue(document.cookie);
}

/**
 * Cookies fire no events, so there is nothing to subscribe to that would
 * be honest. Re-read when the tab comes back to the foreground: that is
 * when a session started or stopped somewhere else (the exit button, a
 * second tab, the 30-minute expiry) becomes visible here.
 */
function subscribeSupportFlag(onChange: () => void): () => void {
  if (typeof document === "undefined") return () => {};
  document.addEventListener("visibilitychange", onChange);
  window.addEventListener("focus", onChange);
  return () => {
    document.removeEventListener("visibilitychange", onChange);
    window.removeEventListener("focus", onChange);
  };
}

/**
 * `ownAccountId` normally; the impersonated account while a support
 * session is open; `null` when the flag is present but does not name an
 * account.
 *
 * That last case fails CLOSED on purpose. Falling back to the operator's
 * own account would put their company's rows under the customer's banner,
 * which is exactly the failure this exists to prevent; `null` makes the
 * lists fetch nothing and the shell show the account-access alert.
 */
export function effectiveAccountId(
  ownAccountId: string | null,
  supportFlag: string | null,
): string | null {
  if (supportFlag === null) return ownAccountId;
  return supportAccountFromFlag(supportFlag);
}

/**
 * `effectiveAccountId` as a hook. `useSyncExternalStore` rather than
 * state+effect because the cookie is exactly that: state outside React,
 * read during render, with a server snapshot (`null` — there is no
 * `document` there) that the client corrects on hydration.
 */
export function useEffectiveAccountId(
  ownAccountId: string | null,
): string | null {
  const flag = useSyncExternalStore(
    subscribeSupportFlag,
    readSupportFlag,
    readSupportFlag,
  );
  return effectiveAccountId(ownAccountId, flag);
}

/**
 * The `accounts` row the panel labels itself with (header name, default
 * currency).
 *
 * A plain lookup by id rather than an embedded FK join: the embed
 * (`account:accounts!inner(...)`) forces PostgREST to resolve the
 * profiles.account_id → accounts.id relationship from its schema cache,
 * and a stale cache (common right after a migration adds the FK) fails
 * hard with PGRST200 and blanks the whole profile (issue #294). A point
 * lookup needs no relationship inference.
 */
export async function fetchAccountSummary(
  supabase: SupabaseClient,
  accountId: string,
): Promise<AccountSummary | null> {
  const { data, error } = await supabase
    .from("accounts")
    // default_currency added in migration 021; narrowed to the USD
    // fallback here for older schemas where it reads null.
    .select("id, name, default_currency")
    .eq("id", accountId)
    .maybeSingle();
  if (error) {
    console.error("[AuthProvider] fetchAccount error:", {
      message: error.message,
      details: error.details,
      hint: error.hint,
      code: error.code,
    });
    return null;
  }
  if (!data) return null;
  return {
    id: data.id,
    name: data.name,
    default_currency: data.default_currency ?? DEFAULT_CURRENCY,
  };
}

/**
 * The summary may only be shown while it is about the account the lists
 * are querying.
 *
 * The two move on different clocks: `accountId` is re-read from the
 * support flag cookie every time the tab regains focus, while the summary
 * crosses the network. Whenever they disagree — a session that expired
 * with the tab open, one started or stopped in a second tab — the honest
 * answer is "we don't know yet", not the previous account's name. Showing
 * it is the mislabelled view this whole round exists to prevent: the
 * customer's name over the operator's rows, or the reverse.
 */
export function accountSummaryFor(
  summary: AccountSummary | null,
  effectiveAccountId: string | null,
): AccountSummary | null {
  if (!summary || !effectiveAccountId) return null;
  return summary.id === effectiveAccountId ? summary : null;
}

/**
 * AuthProvider — wrap this around the dashboard layout.
 * Makes ONE getSession() call for the whole tree instead of one per
 * component, avoiding internal lock contention in the Supabase client.
 */
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [account, setAccount] = useState<AccountSummary | null>(null);
  // Bumped by refreshProfile() so a rename or a currency change made in
  // Settings shows up without a reload (deals-settings.tsx saves, then
  // refreshes). The account summary no longer rides along with the
  // profile fetch, so it needs its own nudge.
  const [accountRefreshTick, setAccountRefreshTick] = useState(0);
  const [loading, setLoading] = useState(true);
  // Why the account/role couldn't be established, when it couldn't.
  // Null on the happy path.
  const [statusDetail, setStatusDetail] = useState<string | null>(null);
  // Tracked separately from `loading`. The session settles fast (one
  // local cookie read); the profile fetch crosses the network and
  // settles later. Callers that gate on `profile.*` need to know which
  // window they're in — see the type doc above.
  const [profileLoading, setProfileLoading] = useState(true);

  // Tracks the user ID we've successfully initiated/completed fetching
  // a profile for. This prevents redundant re-fetches and toggling
  // profileLoading back to true on window focus events/token refresh.
  const lastFetchedUserIdRef = useRef<string | null>(null);

  // Shared across init, auth-state-change listener, and the exposed
  // refreshProfile() callback. Reads the current session's user id and
  // pulls the matching profile row along with its account summary.
  const fetchProfile = useCallback(async (userId: string) => {
    const supabase = createClient();
    setProfileLoading(true);
    setStatusDetail(null);
    lastFetchedUserIdRef.current = userId;
    try {
      let data: ProfileRow | null = null;
      for (let attempt = 1; ; attempt++) {
        const result = await supabase
          .from("profiles")
          .select(
            "id, full_name, email, avatar_url, role, beta_features, account_id, account_role",
          )
          .eq("user_id", userId)
          .maybeSingle();

        if (!result.error) {
          data = result.data;
          break;
        }

        const error = result.error;
        console.error("[AuthProvider] fetchProfile error:", {
          message: error.message,
          details: error.details,
          hint: error.hint,
          code: error.code,
        });
        // One hiccup here used to lock the session read-only for good:
        // the profile stayed null, so every `useCan` gate answered
        // false and no page offered a way to recover (issue #471).
        // Retry, then hand the reason to the UI.
        if (attempt < PROFILE_FETCH_ATTEMPTS) {
          await sleep(PROFILE_FETCH_RETRY_MS);
          continue;
        }
        lastFetchedUserIdRef.current = null;
        setStatusDetail(error.message);
        return;
      }

      if (data) {
        // Narrow the DB enum into our AccountRole union. The DB
        // constraint should make this unconditional, but a future
        // migration that broadens the enum without updating TS would
        // otherwise crash here — fall back to null and let UI gates
        // treat the caller as least-privileged.
        const accountRole = isAccountRole(data.account_role)
          ? data.account_role
          : null;

        setProfile({
          id: data.id,
          full_name: data.full_name,
          email: data.email,
          avatar_url: data.avatar_url,
          role: data.role,
          // `beta_features` is `NOT NULL DEFAULT ARRAY[]` in the DB, but
          // narrow defensively in case the column hasn't been migrated yet
          // (older deployments running 011 lazily) — `null` reads as no
          // opt-ins, which is the safe default for any future beta gate.
          beta_features: data.beta_features ?? [],
          account_id: data.account_id ?? null,
          account_role: accountRole,
        });
        if (!data.account_id || !accountRole) {
          // The row exists but carries no tenancy. Migration 017 made
          // both columns NOT NULL for new signups, so this is a user
          // whose bootstrap didn't complete (handle_new_user swallows a
          // failure as a WARNING) or one predating that migration.
          // Every insert and update they attempt will be denied by RLS.
          setStatusDetail(
            `profile ${data.id} has no ${!data.account_id ? "account_id" : "account_role"}`,
          );
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setStatusDetail("no profiles row for the signed-in user");
      }
    } catch (err) {
      console.error("[AuthProvider] fetchProfile threw:", err);
      lastFetchedUserIdRef.current = null;
      setStatusDetail(err instanceof Error ? err.message : "profile fetch failed");
    } finally {
      setProfileLoading(false);
    }
  }, []);

  useEffect(() => {
    const supabase = createClient();
    let mounted = true;

    const safetyTimer = setTimeout(() => {
      if (mounted) {
        console.warn("[AuthProvider] getSession() timed out after 3s");
        setLoading(false);
        setProfileLoading(false);
      }
    }, 3000);

    const init = async () => {
      try {
        const {
          data: { session },
          error,
        } = await supabase.auth.getSession();

        if (error) console.error("[AuthProvider] getSession error:", error.message);

        if (!mounted) return;
        const currentUser = session?.user ?? null;
        setUser(currentUser);

        if (currentUser) {
          // Don't block session loading on profile fetch — chrome
          // (header, sidebar) can render from the user object alone,
          // profile enriches async. Callers that need to branch on
          // profile data gate on `profileLoading` instead.
          fetchProfile(currentUser.id);
        } else {
          // No user → no profile to load. Flip profileLoading off so
          // pages that gate on it don't wait forever on the logged-out
          // path (the route guard or redirect should fire instead).
          setProfileLoading(false);
        }
      } catch (err) {
        console.error("[AuthProvider] init threw:", err);
      } finally {
        if (mounted) setLoading(false);
        clearTimeout(safetyTimer);
      }
    };

    init();

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      if (!mounted) return;
      const currentUser = session?.user ?? null;
      setUser(currentUser);

      if (currentUser) {
        if (currentUser.id !== lastFetchedUserIdRef.current) {
          fetchProfile(currentUser.id);
        }
      } else {
        lastFetchedUserIdRef.current = null;
        setProfile(null);
        setAccount(null);
        setProfileLoading(false);
      }

      setLoading(false);
    });

    return () => {
      mounted = false;
      clearTimeout(safetyTimer);
      subscription.unsubscribe();
    };
  }, [fetchProfile]);

  const signOut = useCallback(async () => {
    const supabase = createClient();
    // End the support session BEFORE the Supabase session. Signing out
    // does not touch the support cookie — it is httpOnly, so this code
    // could not delete it even if it tried — and one left behind on a
    // shared machine used to put the next person who signs in into
    // read-only for half an hour, with no banner to explain it and no
    // button to undo it. The stop route closes the bitácora row too, which
    // is the ending that would otherwise never be recorded: closing the
    // browser is how support sessions actually end.
    await endSupportSession();
    await supabase.auth.signOut();
    setUser(null);
    setProfile(null);
    setAccount(null);
    window.location.href = "/login";
  }, []);

  const refreshProfile = useCallback(async () => {
    if (!user?.id) return;
    setAccountRefreshTick((n) => n + 1);
    await fetchProfile(user.id);
  }, [user?.id, fetchProfile]);

  // Derive the role booleans once per profile change rather than on
  // every consumer render. Cheap regardless, but the memo also gives
  // each derived value a stable identity for React.memo / useEffect
  // dependencies downstream.
  // The account this browser is showing. Equal to the profile's own
  // account except inside a support session, where it is the customer's.
  // The effective ROLE stays the operator's own on purpose: support is
  // there to look at what the customer's admin sees (invitations, usage,
  // billing screens), and downgrading the UI to `viewer` would hide the
  // very screens tickets are about. Nothing can be written either way —
  // RLS refuses the customer's account and `guardReadOnly` refuses the
  // operator's own.
  const effectiveAccount = useEffectiveAccountId(profile?.account_id ?? null);

  // Resolve the name and currency of THAT account, and re-resolve it
  // whenever it changes. It used to be read once inside `fetchProfile`,
  // which only re-runs on an auth-state change: the flag moved on its own
  // (expiry with the tab open, a session started or stopped in a second
  // tab) and the header went on naming the previous company while every
  // list had already reloaded with the other one's rows. Same trigger as
  // the flag now, and `accountSummaryFor` below withholds the summary
  // during the window where the fetch has not landed yet.
  const userId = user?.id ?? null;
  useEffect(() => {
    if (!userId || !effectiveAccount) return;
    let cancelled = false;
    (async () => {
      const summary = await fetchAccountSummary(createClient(), effectiveAccount);
      if (!cancelled) setAccount(summary);
    })();
    return () => {
      cancelled = true;
    };
  }, [userId, effectiveAccount, accountRefreshTick]);

  const derived = useMemo(() => {
    const role = profile?.account_role ?? null;
    return {
      accountRole: role,
      accountId: effectiveAccount,
      isOwner: role === "owner",
      isAdmin: role === "admin",
      isAgent: role === "agent",
      isViewer: role === "viewer",
      canManageMembers: role ? canManageMembersFor(role) : false,
      canEditSettings: role ? canEditSettingsFor(role) : false,
      canSendMessages: role ? canSendMessagesFor(role) : false,
    };
  }, [profile?.account_role, effectiveAccount]);

  // Never hand out a summary for an account other than the one the lists
  // are querying — see `accountSummaryFor`.
  const shownAccount = accountSummaryFor(account, derived.accountId);

  // Signed out is not a broken account — the shell redirects to /login
  // before anything reads this.
  const accountStatus: AccountStatus = !user
    ? "loading"
    : profileLoading
      ? "loading"
      : !profile
        ? "error"
        : derived.accountId && derived.accountRole
          ? "ready"
          : "unlinked";

  return (
    <AuthContext.Provider
      value={{
        user,
        profile,
        loading,
        profileLoading,
        signOut,
        refreshProfile,
        account: shownAccount,
        defaultCurrency: shownAccount?.default_currency ?? DEFAULT_CURRENCY,
        accountStatus,
        accountStatusDetail: statusDetail,
        ...derived,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

/**
 * useAuth — read the shared auth state from context.
 * Must be used inside an <AuthProvider>.
 */
export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) {
    // Fallback for components rendered outside the provider (shouldn't
    // happen in normal flow, but don't crash the page). Account state
    // collapses to least-privileged null — every `canX` boolean is
    // false so UI gates fail closed.
    return {
      user: null,
      profile: null,
      loading: false,
      profileLoading: false,
      signOut: async () => {
        window.location.href = "/login";
      },
      refreshProfile: async () => {},
      account: null,
      defaultCurrency: DEFAULT_CURRENCY,
      // Outside the provider there is nothing to resolve yet — 'loading'
      // keeps the access alert from firing on, say, the login page.
      accountStatus: "loading",
      accountStatusDetail: null,
      accountId: null,
      accountRole: null,
      isOwner: false,
      isAdmin: false,
      isAgent: false,
      isViewer: false,
      canManageMembers: false,
      canEditSettings: false,
      canSendMessages: false,
    };
  }
  return ctx;
}
