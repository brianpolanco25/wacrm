// ============================================================
// POST /api/account/webhooks/{id}/deliveries/{deliveryId}/retry
//
// Reintento manual desde el panel. Admin+ porque dispara una petición
// saliente desde nuestros servidores, y con el cliente de rol de
// servicio porque la cola solo tiene política de LECTURA: el navegador
// nunca puede escribir una entrega, ni siquiera el dueño de la cuenta.
// El `accountId` de la sesión es lo que acota cada consulta.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit';
import {
  WEBHOOK_ACTION_RATE_LIMIT,
  retryDelivery,
} from '@/lib/webhooks/manage';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ id: string; deliveryId: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id, deliveryId } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      WEBHOOK_ACTION_RATE_LIMIT
    );
    if (!limit.success) return rateLimitResponse(limit);

    const outcome = await retryDelivery(
      supabaseAdmin(),
      ctx.accountId,
      id,
      deliveryId
    );

    if (outcome.kind === 'not_found') {
      return NextResponse.json(
        { error: 'Delivery not found' },
        { status: 404 }
      );
    }
    if (outcome.kind === 'already_queued') {
      return NextResponse.json(
        { error: 'This delivery is already queued for another attempt' },
        { status: 409 }
      );
    }

    return NextResponse.json({
      delivery: outcome.delivery,
      result: outcome.status,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
