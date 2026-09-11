import { createBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'

import { SUPPORT_ACTIVE_COOKIE } from '@/lib/auth/support-cookie'

// Singleton instance — one client shared across the whole browser session.
// Creating multiple clients causes auth-lock contention ("Lock was released
// because another request stole it") and intermittent fetch failures.
let browserClient: SupabaseClient | undefined

// ------------------------------------------------------------
// Read-only during a support session
//
// Most of this panel talks to Supabase from the browser: `contacts/page.tsx`
// deletes with `supabase.from('contacts').delete()`, the tag manager
// inserts, the deal settings update `accounts`. Those requests go straight
// from the browser to `*.supabase.co` — they never reach Next, so neither
// `middleware.ts` nor the effective `viewer` role that `getCurrentAccount()`
// hands out ever sees them, and RLS runs them with the OPERATOR'S OWN JWT
// against the OPERATOR'S OWN account.
//
// The failure that produces is the exact one this feature exists to
// prevent, only worse than the obvious version: the operator opens a
// support session on company T, goes to Contacts, selects rows, deletes —
// and deletes their own company's contacts while an amber banner says
// "Nothing you do here is saved".
//
// Migration 057 already makes the customer's data unwritable (only SELECT
// policies carry the support predicate). This guard is about the other
// account in the room: the operator's own.
//
// It is a guard rail, not a security boundary. The flag it reads is a
// plain cookie the operator could delete; doing so would let them write to
// their own account, which they can already do by leaving the session. No
// customer data is on the other side of it.
// ------------------------------------------------------------

/** Operations a support session must never perform from the browser. */
const BLOCKED_OPS = new Set([
  'insert',
  'update',
  'upsert',
  'delete',
])

export const SUPPORT_READ_ONLY_ERROR = {
  message: 'A support session is read-only; exit it before making changes',
  code: 'support_session_read_only',
  details: '',
  hint: 'Exit the support session from the banner at the top of the page.',
}

/** True when the server has flagged this browser as inside a support session. */
export function supportSessionActive(): boolean {
  if (typeof document === 'undefined') return false
  return document.cookie
    .split(';')
    .some((c) => c.trim().startsWith(`${SUPPORT_ACTIVE_COOKIE}=`))
}

/**
 * End the support session, if there is one, before signing out.
 *
 * Signing out cannot drop the support cookie by itself — it is `httpOnly`,
 * so no browser code can delete it — and one left behind on a shared
 * machine used to put the next person who signs in into read-only for the
 * rest of the window. Asking the server to stop the session also closes
 * the bitácora row, which is the ending that would otherwise never be
 * recorded: shutting the browser is how support sessions really end.
 *
 * Never throws and never blocks the sign-out. Being unable to reach the
 * network is not a reason to keep somebody logged in.
 */
export async function endSupportSession(): Promise<void> {
  if (!supportSessionActive()) return
  try {
    await fetch('/api/platform/impersonate/stop', { method: 'POST' })
  } catch {
    // Offline, or the session is already gone.
  }
}

/**
 * A stand-in for a PostgREST query builder that resolves to an error
 * instead of doing anything.
 *
 * It has to be chainable AND thenable because that is how every call site
 * in this app is written: `await supabase.from('contacts').delete().in('id',
 * ids)` destructures `{ error }`. Rejecting the promise instead would turn
 * every one of those into an unhandled exception; resolving to an `error`
 * makes the refusal arrive through the path the code already handles.
 */
function refusedQuery(): unknown {
  const result = { data: null, error: SUPPORT_READ_ONLY_ERROR, count: null, status: 403, statusText: 'Forbidden' }
  const target = function () {} as unknown as Record<string | symbol, unknown>
  const proxy: unknown = new Proxy(target, {
    get(_t, prop) {
      if (prop === 'then') {
        return (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
      }
      if (prop === 'catch' || prop === 'finally') {
        return () => proxy
      }
      // Every builder method (`.eq()`, `.in()`, `.select()`, …) keeps the
      // chain going and keeps refusing.
      return () => proxy
    },
    apply() {
      return proxy
    },
  })
  return proxy
}

/**
 * Wrap a browser client so that, while a support session is open, nothing
 * it does can write.
 *
 * `from()` returns a builder whose mutating methods refuse; `rpc()` refuses
 * outright. RPCs are blocked wholesale rather than by name because they are
 * `SECURITY DEFINER` almost without exception in this schema — a "read-only"
 * one would answer for the operator's own account anyway, which is the
 * mislabelled view all over again.
 *
 * The check runs per call, not once at construction: the client is a
 * singleton that outlives the session.
 */
export function guardReadOnly<T extends SupabaseClient>(client: T): T {
  return new Proxy(client, {
    get(target, prop) {
      if (prop === 'from') {
        return (relation: string) => {
          const builder = target.from(relation)
          if (!supportSessionActive()) return builder
          return new Proxy(builder as object, {
            get(b, method, r) {
              if (typeof method === 'string' && BLOCKED_OPS.has(method)) {
                return () => refusedQuery()
              }
              return Reflect.get(b, method, r)
            },
          })
        }
      }
      if (prop === 'rpc') {
        return (...args: unknown[]) => {
          if (!supportSessionActive()) {
            return (target.rpc as (...a: unknown[]) => unknown)(...args)
          }
          return refusedQuery()
        }
      }
      // Read off the real client, not through the proxy: `functions` is a
      // getter and `auth` / `realtime` reach for private state, both of
      // which want the original `this`. Methods are bound for the same
      // reason.
      const value = (target as unknown as Record<string | symbol, unknown>)[prop]
      return typeof value === 'function' ? value.bind(target) : value
    },
  }) as T
}

export function createClient() {
  if (browserClient) return browserClient

  browserClient = guardReadOnly(
    createBrowserClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    )
  )

  return browserClient
}
