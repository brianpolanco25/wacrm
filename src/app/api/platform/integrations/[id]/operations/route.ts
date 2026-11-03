// ============================================================
// POST /api/platform/integrations/[id]/operations — alta de una
// operación declarativa (n13.1, R7–R9). Sin GET propio: el detalle de
// la integración ya trae sus operaciones.
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
  createOperation,
  loadPlatformIntegration,
  OperationExistsError,
  UUID_RE,
} from '@/lib/platform/integrations';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

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

  try {
    const limit = checkRateLimit(
      `platform:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!UUID_RE.test(id) || !(await loadPlatformIntegration(id))) {
      return NextResponse.json({ error: 'Not found' }, { status: 404 });
    }

    const body = await request.json().catch(() => null);
    const input = validateOperationInput(body, 'create');
    if (!input.ok) {
      return NextResponse.json(
        { error: input.error, field: input.field },
        { status: 400 }
      );
    }

    const operation = await createOperation(id, input.value);
    return NextResponse.json({ operation }, { status: 201 });
  } catch (err) {
    if (err instanceof OperationExistsError) {
      return NextResponse.json(
        { error: err.message, field: 'key' },
        { status: 409 }
      );
    }
    console.error(
      '[POST /api/platform/integrations/[id]/operations] failed:',
      err
    );
    return NextResponse.json(
      { error: 'Failed to create the operation' },
      { status: 500 }
    );
  }
}
