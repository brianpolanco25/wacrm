import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

import {
  SUPPORT_ACTIVE_COOKIE,
  SUPPORT_COOKIE,
  supportCookieActor,
} from '@/lib/auth/support-cookie'
import {
  SUPPORT_WRITE_HEADERS,
  SUPPORT_WRITE_METHOD_HEADER,
  SUPPORT_WRITE_PATH_HEADER,
  SUPPORT_WRITE_REQUEST_HEADER,
  supportWriteVerdict,
} from '@/lib/auth/support-scope'

/**
 * Support sessions WRITE (s9.5), and every write is recorded — but not
 * here. The middleware runs on Edge and cannot verify the cookie's
 * signature (`node:crypto`), so it cannot know whose session this is or
 * whether it is still open. What it can do is decide, by method and path
 * alone (`supportWriteVerdict` in `@/lib/auth/support-scope`):
 *
 *   'block'   the short list a support session never reaches — billing,
 *             ownership, members, invitations, API keys, a nested session —
 *             and every mutation outside /api (nothing there records it).
 *   'record'  let it through, tagged with `x-wacrm-support-*` request
 *             headers. `resolveSupportSession` (server, Node) verifies the
 *             session and writes one `impersonation_actions` row for the
 *             request before the route may touch anything.
 *   'pass'    reads, and the exempt paths (webhook, public API, crons, the
 *             operator's own /api/platform prefix).
 *
 * The tagging headers are stripped from EVERY incoming request first, so
 * they only ever carry the middleware's word. They grant nothing anyway:
 * with no verified session the server records nothing and resolves the
 * caller's own account, exactly as for anyone else.
 */
function supportSessionVerdict(request: NextRequest): 'pass' | 'block' | 'record' {
  if (!request.cookies.has(SUPPORT_COOKIE)) return 'pass'
  return supportWriteVerdict(request.method, request.nextUrl.pathname)
}

export async function middleware(request: NextRequest) {
  // Before anything is forwarded: the support tagging headers are ours
  // alone. `NextResponse.next({ request })` forwards `request.headers`, so
  // this has to happen before the first response object is built.
  for (const name of SUPPORT_WRITE_HEADERS) request.headers.delete(name)
  const supportVerdict = supportSessionVerdict(request)
  if (supportVerdict === 'record') {
    request.headers.set(SUPPORT_WRITE_METHOD_HEADER, request.method)
    request.headers.set(SUPPORT_WRITE_PATH_HEADER, request.nextUrl.pathname)
    request.headers.set(SUPPORT_WRITE_REQUEST_HEADER, crypto.randomUUID())
  }

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

  // A support cookie that does not name the currently authenticated user is
  // nobody's session: `resolveSupportSession` refuses it, so no banner and
  // no exit button ever render for whoever is holding it, and leaving it in
  // place would 403 every save they make until it expires. That is what
  // happens on a shared machine when the operator signs out without
  // stopping the session first. Drop it instead of blocking on it.
  const supportToken = request.cookies.get(SUPPORT_COOKIE)?.value ?? null
  const orphanSupportCookie =
    supportToken !== null && supportCookieActor(supportToken) !== (user?.id ?? null)

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
    if (orphanSupportCookie) {
      response.cookies.delete(SUPPORT_COOKIE)
      response.cookies.delete(SUPPORT_ACTIVE_COOKIE)
    }
    // `next.config.ts` puts `public, s-maxage=300, stale-while-revalidate`
    // on everything outside /api, and that value WINS over the one Next
    // gives a dynamically rendered page (checked against a production
    // build: a ƒ route still comes back `public, s-maxage=300`). During a
    // support session the dashboard shell carries the CUSTOMER'S name and
    // account id in the HTML, so a shared cache in front of this app could
    // hand that page to somebody else for five minutes — and serve it
    // stale for a day. Not on these responses.
    if (supportToken !== null) {
      response.headers.set('Cache-Control', 'private, no-store')
    }
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
  // '/platform' (s9.1): the operator's panel. Its pages 404 on the server
  // for anyone who is not a platform admin; without a session there is no
  // one to ask about, so send them to sign in like every other app page.
  const protectedPaths = ['/dashboard', '/inbox', '/contacts', '/pipelines', '/broadcasts', '/automations', '/settings', '/billing', '/platform']
  if (!user && protectedPaths.some(path => request.nextUrl.pathname.startsWith(path))) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return withRefreshedCookies(NextResponse.redirect(url))
  }

  // The few mutations a support session never makes. See
  // supportSessionVerdict(). An orphan cookie blocks nobody: it is being
  // dropped on this very response, and its holder is not the operator it
  // names.
  if (!orphanSupportCookie && supportVerdict === 'block') {
    return withRefreshedCookies(
      NextResponse.json(
        {
          error:
            'Not available during a support session: billing, ownership, team members and API keys stay with the customer. Exit the session first.',
          code: 'support_session_forbidden',
        },
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

  return withRefreshedCookies(supabaseResponse)
}

export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}
