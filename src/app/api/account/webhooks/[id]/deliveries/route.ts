// ============================================================
// GET /api/account/webhooks/{id}/deliveries — últimas entregas.
//
// Vista de diagnóstico del panel: cualquier miembro la ve (misma
// política de lectura que la 062) y el `payload` nunca sale.
// Paginada por cursor como su gemela de `/api/v1`.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { parseListParams } from '@/lib/api/v1/pagination';
import { DELIVERY_STATUSES, listDeliveries } from '@/lib/webhooks/manage';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await getCurrentAccount();
    const { id } = await params;

    const { limit, cursor } = parseListParams(request);
    const status = new URL(request.url).searchParams.get('status');
    if (status && !(DELIVERY_STATUSES as string[]).includes(status)) {
      return NextResponse.json(
        { error: `'status' must be one of ${DELIVERY_STATUSES.join(', ')}` },
        { status: 400 }
      );
    }

    const page = await listDeliveries(ctx.supabase, ctx.accountId, id, {
      limit,
      cursor,
      status,
    });
    if (!page) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      deliveries: page.items,
      next_cursor: page.nextCursor,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
