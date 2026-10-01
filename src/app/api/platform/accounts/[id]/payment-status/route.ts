// ============================================================
// POST /api/platform/accounts/[id]/payment-status — «Comprobar de nuevo»
// desde la ficha del superadmin (p11.1, R21).
//
// Body `{ config_id }`. Pregunta a Meta si el WABA de ese número de la
// cuenta `[id]` tiene método de pago y guarda la respuesta (migración
// 079). También en cuentas `managed`: ahí el WABA es de Cabbity y el
// operador es quien debe verlo.
//
//   200  { status, checked_at, error }
//   400  sin config_id
//   401/403  sin sesión o sin fila en `platform_admins`
//   404  la cuenta o el número no existen, o el número no es de ESA
//        cuenta (la lectura y la escritura van con `id` + `account_id`)
//   409  `META_PAYMENT_CHECK_DISABLED=1`
//   429  límite de acciones de operador
//
// Sin entrada en la bitácora: no cambia nada del cliente (ni plan, ni
// acceso, ni datos), solo refresca una columna de diagnóstico que el
// propio barrido del cron reescribe cada pocas horas.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
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

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (err instanceof UnauthorizedError || err instanceof ForbiddenError) {
      return toErrorResponse(err);
    }
    throw err;
  }

  const limit = checkRateLimit(
    `platform:payment-check:${ctx.userId}`,
    RATE_LIMITS.adminAction
  );
  if (!limit.success) return rateLimitResponse(limit);

  const { id } = await context.params;
  if (!UUID_RE.test(id)) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  if (isPaymentCheckDisabled()) {
    return NextResponse.json(
      { error: 'payment_check_disabled' },
      { status: 409 }
    );
  }

  const body = (await request.json().catch(() => null)) as {
    config_id?: unknown;
  } | null;
  const configId =
    typeof body?.config_id === 'string' ? body.config_id.trim() : '';
  if (!configId) {
    return NextResponse.json(
      { error: 'config_id is required' },
      { status: 400 }
    );
  }

  const result = await checkAndRecordPaymentStatus(supabaseAdmin(), {
    accountId: id,
    configId,
  });
  if (!result) {
    return NextResponse.json({ error: 'Not found' }, { status: 404 });
  }

  return NextResponse.json({
    status: result.status,
    checked_at: result.checkedAt,
    error: result.error,
  });
}
