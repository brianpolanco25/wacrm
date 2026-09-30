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
  // `path` is already a checked same-origin path; checked again here so
  // no future branch of resolveCallback can turn this into a way off
  // the site.
  const safe = isSameOriginPath(path) ? path : '/dashboard';
  // RELATIVE `Location`, built by hand. In a Route Handler
  // `request.nextUrl` carries the host the server LISTENS on (the
  // standalone server binds `HOSTNAME`), not the one the browser used,
  // so an absolute URL built from it sent every email link to
  // `localhost` behind the proxy — and the cookies just written, which
  // belong to the real domain, with it. `NextResponse.redirect` only
  // takes an absolute URL. A relative one trusts no Host or
  // X-Forwarded-* header: the browser resolves it against the address
  // it is on, keeping the fragment (Fetch standard). The session
  // cookies written through `cookies()` are merged into this response
  // by Next all the same.
  const response = new NextResponse(null, {
    status: 307,
    headers: {
      Location: safe,
      // Fresh session cookies ride on this response: no shared cache
      // may keep it (next.config.ts sets the same for /auth/*).
      'Cache-Control': 'private, no-store',
    },
  });
  return response;
}
