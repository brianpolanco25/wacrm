// ============================================================
// /api/platform/integrations — catálogo de integraciones (n13.1).
//
//   GET   todas las integraciones, activas o no, con el número de
//         operaciones activas y de cuentas que la tienen activada (R11).
//   POST  crea una integración; nace en borrador (`is_active = false`).
//
// Ambas empiezan por `requirePlatformAdmin()`: ser owner de una empresa
// no da nada aquí (403). Escribe con el rol de servicio porque las
// tablas del catálogo no tienen políticas (091). Sin DELETE (R10).
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
  createIntegration,
  IntegrationExistsError,
  loadPlatformIntegrations,
} from '@/lib/platform/integrations';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { isDeliverableUrl } from '@/lib/webhooks/ssrf';

function isAuthError(err: unknown): boolean {
  return err instanceof UnauthorizedError || err instanceof ForbiddenError;
}

export async function GET() {
  try {
    await requirePlatformAdmin();
    const integrations = await loadPlatformIntegrations();
    return NextResponse.json({ integrations });
  } catch (err) {
    if (isAuthError(err)) return toErrorResponse(err);
    console.error('[GET /api/platform/integrations] failed:', err);
    return NextResponse.json(
      { error: 'Failed to load the integrations' },
      { status: 500 }
    );
  }
}

export async function POST(request: Request) {
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

    const body = await request.json().catch(() => null);
    const input = validateIntegrationInput(body, 'create');
    if (!input.ok) {
      return NextResponse.json(
        { error: input.error, field: input.field },
        { status: 400 }
      );
    }
    // R5: además de los literales, el nombre tiene que resolver a una IP
    // pública ahora (el ejecutor lo vuelve a comprobar en cada llamada).
    if (!(await isDeliverableUrl(input.value.base_url!))) {
      return NextResponse.json(
        {
          error: "'base_url' must resolve to a public address",
          field: 'base_url',
        },
        { status: 400 }
      );
    }

    const integration = await createIntegration(input.value, ctx.userId);
    return NextResponse.json({ integration }, { status: 201 });
  } catch (err) {
    if (err instanceof IntegrationExistsError) {
      return NextResponse.json(
        { error: err.message, field: 'slug' },
        { status: 409 }
      );
    }
    console.error('[POST /api/platform/integrations] failed:', err);
    return NextResponse.json(
      { error: 'Failed to create the integration' },
      { status: 500 }
    );
  }
}
