// ============================================================
// POST /api/account/webhooks/{id}/test — entrega un `ping` firmado.
//
// El botón «Probar» del panel. Admin+, rol de servicio (escribe en la
// cola) y acotado por el `accountId` de la sesión.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertNotSupportSession,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { sendTestDelivery } from '@/lib/webhooks/manage';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    // s9.5: an outbound webhook outlives the support session.
    await assertNotSupportSession(ctx);
    await assertPlanFeature(ctx.accountId, 'webhooks');
    const { id } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      RATE_LIMITS.webhookAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const outcome = await sendTestDelivery(supabaseAdmin(), ctx.accountId, id);
    if (!outcome) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      delivery: outcome.delivery,
      result: outcome.status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
