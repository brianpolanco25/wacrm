// ============================================================
// /api/platform/integrations/[id] — una integración del catálogo (n13.1).
//
//   GET    la integración con todas sus operaciones (R11).
//   PATCH  edita cualquier subconjunto de campos salvo `slug` (R6).
//          `is_active = false` la retira del catálogo del cliente y el
//          ejecutor la rechaza, sin tocar las activaciones (R10).
//
// Sin DELETE a propósito (R10): una integración se retira, no se borra.
// ============================================================

import { NextResponse } from 'next/server';

import {
  ForbiddenError,
  toErrorResponse,
  UnauthorizedError,
} from '@/lib/auth/account';
import { requirePlatformAdmin } from '@/lib/auth/platform';
import { validateIntegrationInput } from '@/lib/integrations/catalog-validate';
import {
  loadPlatformIntegration,
  updateIntegration,
  UUID_RE,
} from '@/lib/platform/integrations';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

type Context = { params: Promise<{ id: string }> };

function isAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof ForbiddenError;
}

const NOT_FOUND = () =>
  NextResponse.json({ error: 'Not found' }, { status: 404 });

export async function GET(_request: Request, context: Context) {
  try {
    await requirePlatformAdmin();
    const { id } = await context.params;
    if (!UUID_RE.test(id)) return NOT_FOUND();
    const integration = await loadPlatformIntegration(id);
    if (!integration) return NOT_FOUND();
    return NextResponse.json({ integration });
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    console.error('[GET /api/platform/integrations/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the integration' },
      { status: 500 }
    );
  }
}

export async function PATCH(request: Request, context: Context) {
  let ctx;
  try {
    ctx = await requirePlatformAdmin();
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    throw err;
  }

  try {
    const limit = checkRateLimit(
      `platform:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { id } = await context.params;
    if (!UUID_RE.test(id)) return NOT_FOUND();
    const existing = await loadPlatformIntegration(id);
    if (!existing) return NOT_FOUND();

    const body = await request.json().catch(() => null);
    const input = validateIntegrationInput(body, 'update', existing);
    if (!input.ok) {
      return NextResponse.json(
        { error: input.error, field: input.field },
        { status: 400 }
      );
    }
    if (
      input.value.base_url !== undefined &&
      !(await isDeliverableUrl(input.value.base_url))
    ) {
      return NextResponse.json(
        {
          error: "'base_url' must resolve to a public address",
          field: 'base_url',
        },
        { status: 400 }
      );
    }

    const integration = await updateIntegration(id, input.value, ctx.userId);
    if (!integration) return NOT_FOUND();
    return NextResponse.json({ integration });
  } catch (err) {
    console.error('[PATCH /api/platform/integrations/[id]] failed:', err);
    return NextResponse.json(
      { error: 'Failed to update the integration' },
      { status: 500 }
    );
  }
}
