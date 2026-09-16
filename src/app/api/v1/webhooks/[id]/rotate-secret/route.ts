// ============================================================
// POST /api/v1/webhooks/{id}/rotate-secret — secreto de firma nuevo
// (scope: webhooks:manage).
//
// Devuelve el secreto en claro UNA vez, como el alta. No hay periodo
// de gracia con dos secretos válidos: desde la respuesta, todo lo que
// salga va firmado con el nuevo, así que el receptor tiene que
// actualizarlo antes de que llegue la siguiente entrega. Es lo que hay
// que hacer cuando un secreto se filtra, y el precio de la sencillez
// va dicho en la interfaz.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { checkRateLimit } from '@/lib/rate-limit';
import {
  WEBHOOK_ACTION_RATE_LIMIT,
  rotateWebhookSecret,
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
        'Too many webhook secret rotations for this account',
        429,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
          ),
        }
      );
    }

    const rotated = await rotateWebhookSecret(ctx.supabase, ctx.accountId, id);
    if (!rotated) return fail('not_found', 'Webhook not found', 404);

    return ok({ ...rotated.endpoint, secret: rotated.secret });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
