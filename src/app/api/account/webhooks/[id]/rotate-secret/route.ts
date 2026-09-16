// ============================================================
// POST /api/account/webhooks/{id}/rotate-secret
//
// Devuelve un secreto de firma nuevo, en claro, una sola vez. Admin+
// con el cliente RLS (la política de UPDATE de la 028 ya exige admin).
// Desde la respuesta, todo lo que salga va firmado con el nuevo: el
// receptor tiene que cambiarlo antes de la siguiente entrega, y la
// interfaz lo advierte.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { rotateWebhookSecret } from '@/lib/webhooks/manage';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      RATE_LIMITS.webhookAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const rotated = await rotateWebhookSecret(ctx.supabase, ctx.accountId, id);
    if (!rotated) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      webhook: rotated.endpoint,
      secret: rotated.secret,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
