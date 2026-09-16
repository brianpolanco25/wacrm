// ============================================================
// GET /api/v1/webhooks/{id}/deliveries — bitácora de entregas
// (scope: webhooks:manage).
//
// Paginada igual que el resto de listas de v1 (`?limit`, `?cursor`) y
// con filtro `?status=pending|delivered|failed|dead`. El `payload` no
// sale: contiene datos del cliente final y esto es una vista de
// diagnóstico, no un archivo de eventos.
//
// Acotada por cuenta: un endpoint ajeno responde 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { parseListParams } from '@/lib/api/v1/pagination';
import { DELIVERY_STATUSES, listDeliveries } from '@/lib/webhooks/manage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'webhooks:manage');
    await assertPlanFeature(ctx.accountId, 'webhooks');
    const { id } = await params;

    const { limit, cursor } = parseListParams(request);
    const status = new URL(request.url).searchParams.get('status');
    if (status && !(DELIVERY_STATUSES as string[]).includes(status)) {
      return fail(
        'bad_request',
        `'status' must be one of ${DELIVERY_STATUSES.join(', ')}`,
        400
      );
    }

    const page = await listDeliveries(ctx.supabase, ctx.accountId, id, {
      limit,
      cursor,
      status,
    });
    if (!page) return fail('not_found', 'Webhook not found', 404);

    return okList(page.items, page.nextCursor);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
