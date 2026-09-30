// ============================================================
// GET /auth/callback — where every Supabase Auth email lands (s9.8).
//
// Exchanges a PKCE `code` or verifies a `token_hash` with the SSR
// client, which writes the session cookies through `cookies()` — a
// Route Handler is one of the two places Next 16 lets that happen
// (the other is a Server Function; a Server Component cannot). Then it
// redirects: to `/reset-password` after an invite or a recovery, to
// `/join/<token>` with an `?invite=`, to a safe `?next=`, or to the
// dashboard. A link it cannot finish — an error, or the implicit flow
// whose tokens ride in the fragment the server never sees — goes on to
// `/auth/callback/complete`, the browser half. See
// `src/lib/auth/callback.ts` for the formats.
// ============================================================

import { NextResponse, type NextRequest } from 'next/server';

import { resolveCallback } from '@/lib/auth/callback';
import { isSameOriginPath } from '@/lib/auth/redirects';
import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest) {
  const supabase = await createClient();
  const path = await resolveCallback(
    request.nextUrl.searchParams,
    supabase.auth
  );
  // Same host the request came in on — as the middleware's own
  // redirects do — because the cookies just written belong to it.
  // `path` is already a checked same-origin path; checked again here so
  // no future branch of resolveCallback can turn this into a way off
  // the site.
  const safe = isSameOriginPath(path) ? path : '/dashboard';
  const target = new URL(safe, request.nextUrl.origin);
  const url = request.nextUrl.clone();
  url.pathname = target.pathname;
  url.search = target.search;
  const response = NextResponse.redirect(url);
  // The response carries fresh session cookies: no shared cache may
  // keep it, whatever the catch-all rule in next.config.ts says.
  response.headers.set('Cache-Control', 'private, no-store');
  return response;
}
