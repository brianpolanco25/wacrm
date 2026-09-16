// ============================================================
// POST /api/account/webhooks/{id}/test — entrega un `ping` firmado.
//
// El botón «Probar» del panel. Admin+, rol de servicio (escribe en la
// cola) y acotado por el `accountId` de la sesión.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  WEBHOOK_ACTION_RATE_LIMIT,
  sendTestDelivery,
} from '@/lib/webhooks/manage';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    await assertPlanFeature(ctx.accountId, 'webhooks');
    const { id } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      WEBHOOK_ACTION_RATE_LIMIT
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
