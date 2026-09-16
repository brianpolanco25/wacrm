// ============================================================
// POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry
// (scope: webhooks:manage)
//
// Vuelve a intentar una entrega AHORA, desde el primer peldaño de la
// escalera. Una entrega que ya está en cola (`pending`) no se toca:
// reintentarla a mano sería mandarla dos veces.
//
// Lleva cubo propio (ver `WEBHOOK_ACTION_RATE_LIMIT`): cada llamada
// dispara una petición saliente desde nuestros servidores.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  WEBHOOK_ACTION_RATE_LIMIT,
  retryDelivery,
} from '@/lib/webhooks/manage';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string; deliveryId: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    await assertPlanFeature(ctx.accountId, 'webhooks');
    const { id, deliveryId } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      WEBHOOK_ACTION_RATE_LIMIT
    );
    if (!limit.success) {
      return fail(
        'rate_limited',
        'Too many webhook retries for this account',
        429,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
          ),
        }
      );
    }

    const outcome = await retryDelivery(
      ctx.supabase,
      ctx.accountId,
      id,
      deliveryId
    );

    if (outcome.kind === 'not_found') {
      return fail('not_found', 'Delivery not found', 404);
    }
    if (outcome.kind === 'already_queued') {
      // `conflict` todavía no está en `ApiErrorCode` (lo añade a7.1 en
      // la otra rama); el sobre admite cualquier código de texto.
      return fail(
        'conflict',
        'This delivery is already queued for another attempt',
        409
      );
    }

    return ok({ ...outcome.delivery, result: outcome.status });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
