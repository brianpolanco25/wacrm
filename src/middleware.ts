import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import { SUPPORT_COOKIE } from '@/lib/auth/support-cookie'

// Methods that change something. A support session is allowed none of
// them (see `supportSessionBlocks` below).
const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

// Paths a support session must never interfere with, even though the
// cookie is on the request.
//
//   /api/platform/           the operator's own prefix — the exit button
//                            lives here, so blocking it would trap them.
//   /api/whatsapp/webhook    Non-negotiable: NOTHING about billing,
//                            suspension or support may stop an inbound
//                            message from being stored. Meta's request
//                            carries no browser cookie, so this branch is
//                            unreachable in practice; it is spelled out
//                            anyway so a future refactor cannot make it
//                            reachable by accident.
//   /api/v1/                 public API, authenticated by API key. Same
//                            reasoning: no cookies, stated explicitly.
//   /api/automations/cron,
//   /api/flows/cron          scheduled sweeps behind a shared secret.
const SUPPORT_SESSION_EXEMPT = [
  '/api/platform/',
  '/api/whatsapp/webhook',
  '/api/v1/',
  '/api/automations/cron',
  '/api/flows/cron',
]

/**
 * True when this request must be refused because a support session is
 * open. Defence in depth on top of the effective `viewer` role that
 * `getCurrentAccount()` hands out during impersonation: that role stops
 * every route which asks `requireRole('agent')` or above, but a route
 * that talks to Supabase through the operator's own session client
 * without consulting the role at all would write to the OPERATOR'S
 * account while they believe they are looking at a customer's. Refusing
 * the whole request is the only version of this that does not depend on
 * every present and future route remembering.
 *
 * Presence of the cookie is enough — its signature is not checked here.
 * Verifying it would need `node:crypto` in the Edge bundle, and the worst
 * a forged cookie achieves is making its own holder read-only.
 */
function supportSessionBlocks(request: NextRequest): boolean {
  if (!request.cookies.has(SUPPORT_COOKIE)) return false
  if (!MUTATING_METHODS.has(request.method)) return false
  const path = request.nextUrl.pathname
  return !SUPPORT_SESSION_EXEMPT.some((prefix) => path.startsWith(prefix))
}

export async function middleware(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value, options }) => request.cookies.set(name, value))
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // getUser() transparently refreshes an expired access token, which
  // ROTATES the refresh token and writes the new cookies onto
  // `supabaseResponse` via setAll() above. Any response we return in
  // place of `supabaseResponse` (every redirect / JSON branch below)
  // is a fresh object that does NOT carry those Set-Cookie headers, so
  // the rotated token never reaches the browser. The next request then
  // replays the old, now-consumed refresh token, the refresh fails, and
  // the session wedges — the user gets a broken reload after idling and
  // can only recover by manually clearing cookies (issue #288). Copy the
  // refreshed cookies onto whatever response we hand back to fix that.
  const withRefreshedCookies = <T extends NextResponse>(response: T): T => {
    supabaseResponse.cookies.getAll().forEach((cookie) => {
      response.cookies.set(cookie)
    })
    return response
  }

  // Auth pages - redirect to dashboard if already logged in.
  // Exception: when an invite token is in the query string we
  // send the already-signed-in user to /join/<token> instead so
  // they can accept the invitation in one click. Without this,
  // a forwarded invite link to someone who's already signed in
  // would silently drop them on /dashboard.
  if (user && (
    request.nextUrl.pathname === '/login' ||
    request.nextUrl.pathname === '/signup' ||
    request.nextUrl.pathname === '/forgot-password'
  )) {
    const url = request.nextUrl.clone()
    const inviteToken = request.nextUrl.searchParams.get('invite')
    if (
      inviteToken &&
      (request.nextUrl.pathname === '/login' ||
        request.nextUrl.pathname === '/signup')
    ) {
      url.pathname = `/join/${encodeURIComponent(inviteToken)}`
      url.search = ''
    } else {
      url.pathname = '/dashboard'
      url.search = ''
    }
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // Protected pages - redirect to login if not authenticated
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // A support session is read-only, everywhere. See supportSessionBlocks().
  if (supportSessionBlocks(request)) {
    return withRefreshedCookies(
      NextResponse.json(
        { error: 'A support session is read-only; exit it before making changes' },
        { status: 403 }
      )
    )
  }

  // API routes that need auth (not webhooks)
  if (!user && request.nextUrl.pathname.startsWith('/api/whatsapp/') &&
      !request.nextUrl.pathname.includes('/webhook')) {
    return withRefreshedCookies(
      NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    )
  }

  return supabaseResponse
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
