// ============================================================
// POST /api/account/integrations/{integrationId}/test — prueba de
// conexión (n13.1, R18).
//
// `GET base_url + test_path` con la credencial de ESTA cuenta por el
// núcleo HTTP común (SSRF, plazo, tamaño, cubo `integrationCall`), y
// responde solo el estado (`ok` | `auth_failed` | `unreachable` |
// `error`) y el código: nunca el cuerpo remoto. Admin+ y con la feature
// `integrations` en el plan (R13). En sesión de soporte se permite y deja
// su fila `integration.test` en `impersonation_actions` (n13.6).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { testIntegrationConnection } from '@/lib/integrations/execute';
import { traceIntegrationSupportAction } from '@/lib/integrations/support-trace';
import { UUID_RE } from '@/lib/platform/integrations';
import { RATE_LIMITS } from '@/lib/rate-limit';

export async function POST(
  _request: Request,
  { params }: { params: Promise<{ integrationId: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    await assertPlanFeature(ctx.accountId, 'integrations');

    const { integrationId } = await params;
    const notFound = NextResponse.json(
      { error: 'Integration not enabled' },
      { status: 404 }
    );
    if (!UUID_RE.test(integrationId)) return notFound;

    const db = supabaseAdmin();
    const traced = await traceIntegrationSupportAction(ctx, db, {
      integrationId,
      action: 'integration.test',
      method: 'POST',
      path: `/api/account/integrations/${integrationId}/test`,
    });
    if (!traced) return notFound;
    const outcome = await testIntegrationConnection(
      db,
      ctx.accountId,
      integrationId
    );
    if (!outcome) return notFound;
    if ('rateLimited' in outcome) {
      const retryAfter = Math.ceil(RATE_LIMITS.integrationCall.windowMs / 1000);
      return NextResponse.json(
        { error: 'Rate limit exceeded', retry_after_seconds: retryAfter },
        { status: 429, headers: { 'Retry-After': String(retryAfter) } }
      );
    }
    return NextResponse.json({
      result: outcome.result,
      status: outcome.status,
      testedAt: outcome.testedAt,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
