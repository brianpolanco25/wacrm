// ============================================================
// GET /api/platform/accounts — the census (fase 4 §2, «Listado de
// cuentas»).
//
// Name, plan, subscription state, members, consumption of the cycle,
// signup date and last activity, for every account of the service.
//
// `requirePlatformAdmin()` first, as on every route of this prefix. A
// company `owner` is exactly as unwelcome here as a `viewer`: owning a
// company is not operating the platform, and the spec forbids conflating
// the two outright. This is THE route the acceptance criterion «un
// administrador de plataforma ve todas las cuentas; un `owner` normal no
// ve más que la suya» is graded on, and its 403 leaks nothing.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  listAccounts,
} from '@/lib/platform/accounts';

function intParam(value: string | null, fallback: number): number {
  if (value === null || value.trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

export async function GET(request: Request) {
  try {
    await requirePlatformAdmin();

    const url = new URL(request.url);
    const limit = Math.min(
      MAX_PAGE_SIZE,
      Math.max(1, intParam(url.searchParams.get('limit'), DEFAULT_PAGE_SIZE))
    );
    const offset = Math.max(0, intParam(url.searchParams.get('offset'), 0));

    return NextResponse.json(
      await listAccounts({
        search: url.searchParams.get('q'),
        limit,
        offset,
      })
    );
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    console.error('[GET /api/platform/accounts] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the account list' },
      { status: 500 }
    );
  }
}
