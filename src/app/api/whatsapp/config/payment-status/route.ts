// ============================================================
// POST /api/whatsapp/config/payment-status — «Comprobar de nuevo» (p11.1).
//
// El botón de la tarjeta de número en Ajustes → WhatsApp. Pregunta a
// Meta si el WABA de ESE número tiene método de pago y guarda la
// respuesta (migración 079), para que el banner del CRM se apague en
// cuanto el cliente añade la tarjeta sin esperar al barrido del cron.
//
//   body { config_id }
//   200  { status: 'ok'|'missing'|'unknown', checked_at }
//   400  sin config_id
//   401/403  sin sesión o por debajo de `admin`
//   404  el número no es de la cuenta del llamante (R12: sin llamar a
//        Meta ni escribir) o no tiene WABA
//   409  `META_PAYMENT_CHECK_DISABLED=1`
//   429  más de 6 por minuto y usuario
//
// La escritura va con rol de servicio (el disparador de la 079 anula la
// del cliente) y filtrada por `id` + `account_id` de la sesión.
// Route Handler POST: Next 16 no cachea métodos distintos de GET.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  checkAndRecordPaymentStatus,
  isPaymentCheckDisabled,
} from '@/lib/whatsapp/payment-method';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `meta-payment-check:${ctx.userId}`,
      RATE_LIMITS.metaPaymentCheck
    );
    if (!limit.success) return rateLimitResponse(limit);

    if (isPaymentCheckDisabled()) {
      return NextResponse.json(
        { error: 'payment_check_disabled' },
        { status: 409 }
      );
    }

    let body: { config_id?: unknown };
    try {
      body = (await request.json()) as { config_id?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const configId =
      typeof body?.config_id === 'string' ? body.config_id.trim() : '';
    if (!configId) {
      return NextResponse.json(
        { error: 'config_id is required' },
        { status: 400 }
      );
    }

    const result = await checkAndRecordPaymentStatus(supabaseAdmin(), {
      accountId: ctx.accountId,
      configId,
    });
    if (!result) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }

    return NextResponse.json({
      status: result.status,
      checked_at: result.checkedAt,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
