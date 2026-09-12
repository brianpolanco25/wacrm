// ============================================================
// GET /api/platform/me — "am I an operator of this service?"
//
// One bit, for the browser bundle. The panel's own pages are guarded on
// the server (`requirePlatformAdmin()` inside the server component), so
// this route decides nothing about access: it only lets the sidebar
// avoid rendering a link that would 404 for everyone else.
//
// A user who is not in `platform_admins` gets the same 403 as on every
// other route of this prefix, and learns nothing beyond that.
// ============================================================

import { NextResponse } from 'next/server';

import { toErrorResponse } from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';

export async function GET() {
  try {
    const ctx = await requirePlatformAdmin();
    return NextResponse.json({
      platformAdmin: true,
      grantedAt: ctx.admin.grantedAt,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
