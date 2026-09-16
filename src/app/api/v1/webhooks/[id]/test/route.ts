// ============================================================
// POST /api/v1/webhooks/{id}/test — entrega un `ping` firmado
// (scope: webhooks:manage).
//
// Sirve para comprobar de una vez la URL, el certificado, la firma y el
// código que devuelve el receptor, sin esperar a que pase algo real.
// `ping` no es un evento suscribible (no está en `WEBHOOK_EVENTS`): solo
// viaja cuando alguien lo pide por aquí.
//
// La entrega queda en la bitácora como cualquier otra, con su código y
// su error si lo hubo. Cubo propio por cuenta.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  WEBHOOK_ACTION_RATE_LIMIT,
  sendTestDelivery,
} from '@/lib/webhooks/manage';

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    await assertPlanFeature(ctx.accountId, 'webhooks');
    const { id } = await params;

    const limit = checkRateLimit(
      `webhookAction:${ctx.accountId}`,
      WEBHOOK_ACTION_RATE_LIMIT
    );
    if (!limit.success) {
      return fail(
        'rate_limited',
        'Too many webhook test deliveries for this account',
        429,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
          ),
        }
      );
    }

    const outcome = await sendTestDelivery(ctx.supabase, ctx.accountId, id);
    if (!outcome) return fail('not_found', 'Webhook not found', 404);

    return ok({ ...outcome.delivery, result: outcome.status });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
