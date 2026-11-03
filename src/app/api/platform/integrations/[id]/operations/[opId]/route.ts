// ============================================================
// PATCH /api/platform/integrations/[id]/operations/[opId] — edita una
// operación (n13.1, R7–R10). Las reglas cruzadas (marcadores ↔ params,
// GET/DELETE sin cuerpo) se comprueban sobre lo guardado + lo nuevo.
//
// Sin DELETE a propósito (R10): una operación se retira con
// `is_active = false`.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { validateOperationInput } from '@/lib/integrations/catalog-validate';
import {
  loadOperation,
  OperationExistsError,
  updateOperation,
  UUID_RE,
} from '@/lib/platform/integrations';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string; opId: string }> }
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

  try {
    const limit = checkRateLimit(
      `platform:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id, opId } = await context.params;
    const notFound = NextResponse.json({ error: 'Not found' }, { status: 404 });
    if (!UUID_RE.test(id) || !UUID_RE.test(opId)) return notFound;
    const existing = await loadOperation(id, opId);
    if (!existing) return notFound;

    const body = await request.json().catch(() => null);
    const input = validateOperationInput(body, 'update', existing);
    if (!input.ok) {
      return NextResponse.json(
        { error: input.error, field: input.field },
        { status: 400 }
      );
    }

    const operation = await updateOperation(id, opId, input.value);
    if (!operation) return notFound;
    return NextResponse.json({ operation });
  } catch (err) {
    if (err instanceof OperationExistsError) {
      return NextResponse.json(
        { error: err.message, field: 'key' },
        { status: 409 }
      );
    }
    console.error(
      '[PATCH /api/platform/integrations/[id]/operations/[opId]] failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to update the operation' },
      { status: 500 }
    );
  }
}
