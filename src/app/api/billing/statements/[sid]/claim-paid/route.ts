// ============================================================
// POST /api/billing/statements/[sid]/claim-paid — «Ya pagué» (fase 10,
// s10.4).
//
// Leaves a note on the operator's file — when, who and an optional
// note — and changes NOTHING else: the statement stays `issued` and the
// account keeps its lock until an operator confirms the payment. Saying
// you paid is not paying.
//
// `admin+`, reachable while read-only (it is the way out of the lock),
// and never from a support session: it speaks for the customer. Written
// with the service role (tenants cannot write `statements`), filtered by
// the caller's account and by `status = 'issued'`. Repeating it just
// refreshes the note.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertNotSupportSession,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_NOTE = 500;

export async function POST(
  request: Request,
  context: { params: Promise<{ sid: string }> }
) {
  try {
    const ctx = await requireRole('admin', { allowReadOnly: true });
    await assertNotSupportSession(ctx);

    const limit = checkRateLimit(
      `billing:claim-paid:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { sid } = await context.params;
    if (!UUID_RE.test(sid)) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const raw = await request.json().catch(() => ({}));
    const body =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : {};
    if (body.note !== undefined && typeof body.note !== 'string') {
      return NextResponse.json(
        { error: "'note' must be text" },
        { status: 400 }
      );
    }
    const note = typeof body.note === 'string' ? body.note.trim() : '';
    if (note.length > MAX_NOTE) {
      return NextResponse.json(
        { error: `'note' must be at most ${MAX_NOTE} characters` },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const { data: found, error: foundErr } = await db
      .from('statements')
      .select('id, status')
      .eq('id', sid)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (foundErr) throw foundErr;
    if (!found) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }
    if ((found as { status: string }).status !== 'issued') {
      return NextResponse.json(
        { error: 'This statement is not pending', code: 'not_open' },
        { status: 409 }
      );
    }

    const claimedAt = new Date().toISOString();
    const { error } = await db
      .from('statements')
      .update({
        claimed_paid_at: claimedAt,
        claimed_by: ctx.userId,
        claim_note: note || null,
      })
      .eq('id', sid)
      .eq('account_id', ctx.accountId)
      .eq('status', 'issued');
    if (error) throw error;

    return NextResponse.json({ id: sid, claimedPaidAt: claimedAt });
  } catch (err) {
    return toErrorResponse(err);
  }
}
