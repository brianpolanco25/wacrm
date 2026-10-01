// ============================================================
// Shared by `POST …/statements/[sid]/confirm` and `…/void` (s10.4):
// the guard, the ids, and the answer for each outcome of
// `settleStatement`. Not a route file: Next only takes handlers there.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { loadAccountSummary } from '@/lib/platform/accounts';
import { settleStatement, type SettleRequest } from '@/lib/platform/statements';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function readJsonObject(
  request: Request
): Promise<Record<string, unknown> | null> {
  const raw = await request.json().catch(() => null);
  return raw && typeof raw === 'object' && !Array.isArray(raw)
    ? (raw as Record<string, unknown>)
    : null;
}

export function badRequest(error: string) {
  return NextResponse.json({ error }, { status: 400 });
}

/**
 * Guard → ids → `parse(body)` (a 400 response or the request) → settle.
 */
export async function handleSettle(
  request: Request,
  context: { params: Promise<{ id: string; sid: string }> },
  label: string,
  parse: (body: Record<string, unknown>) => SettleRequest | NextResponse
): Promise<NextResponse> {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    throw err;
  }

  try {
    const limit = checkRateLimit(
      `platform:statement:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id, sid } = await context.params;
    if (!UUID_RE.test(id) || !UUID_RE.test(sid)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await readJsonObject(request);
    if (!body) return badRequest('body must be a JSON object');
    const parsed = parse(body);
    if (parsed instanceof NextResponse) return parsed;

    const account = await loadAccountSummary(id);
    if (!account) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const outcome = await settleStatement({
      accountId: id,
      accountName: account.name,
      statementId: sid,
      actorUserId: ctx.userId,
      request: parsed,
    });

    if (!outcome.ok) {
      switch (outcome.reason) {
        case 'not_found':
          return NextResponse.json({ error: 'Not found' }, { status: 404 });
        case 'not_open':
          return NextResponse.json(
            {
              error: 'This statement is no longer open (already paid or void)',
              code: 'not_open',
            },
            { status: 409 }
          );
        case 'audit_failed':
          return NextResponse.json(
            { error: 'Could not record the action; nothing was changed' },
            { status: 500 }
          );
      }
    }

    return NextResponse.json({
      accountId: id,
      statement: outcome.statement,
      currentPeriodEnd: outcome.currentPeriodEnd,
      subscriptionStatus: outcome.subscriptionStatus,
    });
  } catch (err) {
    console.error(`[POST ${label}] failed:`, err);
    return NextResponse.json(
      { error: 'Failed to settle the statement' },
      { status: 500 }
    );
  }
}

// ---- the body of «Confirmar pago» ----

export const MAX_REFERENCE = 200;
export const MAX_NOTE = 1000;
/** A payment dated slightly ahead (time zones) is fine; days ahead is not. */
const FUTURE_SLACK_MS = 24 * 3600 * 1000;

export function optionalText(
  value: unknown,
  max: number,
  field: string
): string | null | NextResponse {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') return badRequest(`'${field}' must be text`);
  const text = value.trim();
  if (text.length > max) {
    return badRequest(`'${field}' must be at most ${max} characters`);
  }
  return text || null;
}

/** `YYYY-MM-DD` (noon UTC, so it stays that day everywhere) or ISO. */
export function parsePaidAt(
  value: unknown,
  now: Date = new Date()
): string | NextResponse {
  if (value === undefined || value === null || value === '') {
    return now.toISOString();
  }
  if (typeof value !== 'string') return badRequest("'paidAt' must be a date");
  const at = /^\d{4}-\d{2}-\d{2}$/.test(value)
    ? Date.parse(`${value}T12:00:00.000Z`)
    : Date.parse(value);
  if (!Number.isFinite(at)) return badRequest("'paidAt' must be a date");
  if (at > now.getTime() + FUTURE_SLACK_MS) {
    return badRequest("'paidAt' cannot be in the future");
  }
  return new Date(at).toISOString();
}
