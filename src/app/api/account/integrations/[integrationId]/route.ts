// ============================================================
// /api/account/integrations/{integrationId} (n13.1).
//
//   PUT     activa la integración o cambia la credencial (R15). Admin+ y
//           el plan tiene que traer `integrations` (402 si no, R13).
//   DELETE  desactiva y borra la credencial (R17, D5). Admin+; se
//           permite sin el plan, para que una cuenta que bajó de plan
//           pueda limpiar.
//   PATCH   ajustes de IA de la integración activada (n13.3, R32):
//           `aiEnabled`, `aiInstructions`, `aiTimezone`. Admin+ y con el
//           plan.
//
// n13.6 (D3 revertida): en sesión de soporte las tres se permiten (rol
// efectivo `admin`) y cada una deja su fila en `impersonation_actions`
// con la acción y el slug, antes de escribir (`support-trace.ts`).
//
// Rol de servicio acotado por el `accountId` de la sesión (en soporte, el
// de la cuenta impersonada).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { readJsonBody } from '@/lib/api/v1/body';
import { assertPlanFeature } from '@/lib/billing/enforce';
import {
  disableAccountIntegration,
  enableAccountIntegration,
  findActiveIntegration,
  loadAccountIntegrations,
  updateAccountIntegrationAi,
  validateAiSettings,
  validateCredential,
} from '@/lib/integrations/account';
import { traceIntegrationSupportAction } from '@/lib/integrations/support-trace';
import { UUID_RE } from '@/lib/platform/integrations';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

type Context = { params: Promise<{ integrationId: string }> };

const notFound = () =>
  NextResponse.json({ error: 'Integration not found' }, { status: 404 });

export async function PUT(request: Request, { params }: Context) {
  try {
    const ctx = await requireRole('admin');
    await assertPlanFeature(ctx.accountId, 'integrations');

    const limit = checkRateLimit(
      `admin:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { integrationId } = await params;
    if (!UUID_RE.test(integrationId)) return notFound();

    const db = supabaseAdmin();
    const integration = await findActiveIntegration(db, integrationId);
    if (!integration) return notFound();

    const { data: body } = (await readJsonBody(request, {
      allowEmpty: true,
    })) as { data: { credential?: unknown } | null };
    const credential = validateCredential(body?.credential);
    if (credential === null) {
      return NextResponse.json(
        {
          error:
            "'credential' must be 1–4096 printable ASCII characters, without surrounding spaces",
          field: 'credential',
        },
        { status: 400 }
      );
    }

    await traceIntegrationSupportAction(ctx, db, {
      integrationId,
      action: 'integration.enable',
      method: 'PUT',
      path: `/api/account/integrations/${integrationId}`,
      slug: integration.slug,
    });
    await enableAccountIntegration(db, {
      accountId: ctx.accountId,
      integrationId,
      userId: ctx.userId,
      credential,
    });
    const views = await loadAccountIntegrations(db, ctx.accountId);
    return NextResponse.json({
      integration: views.find((v) => v.id === integrationId) ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(_request: Request, { params }: Context) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(
      `admin:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { integrationId } = await params;
    if (!UUID_RE.test(integrationId)) return notFound();

    const db = supabaseAdmin();
    const traced = await traceIntegrationSupportAction(ctx, db, {
      integrationId,
      action: 'integration.disable',
      method: 'DELETE',
      path: `/api/account/integrations/${integrationId}`,
    });
    if (!traced) return notFound();
    const found = await disableAccountIntegration(
      db,
      ctx.accountId,
      integrationId
    );
    if (!found) return notFound();
    return NextResponse.json({ integrationId, enabled: false });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request, { params }: Context) {
  try {
    const ctx = await requireRole('admin');
    await assertPlanFeature(ctx.accountId, 'integrations');

    const limit = checkRateLimit(
      `admin:integrations:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const { integrationId } = await params;
    if (!UUID_RE.test(integrationId)) return notFound();

    const { data: body } = await readJsonBody(request, { allowEmpty: true });
    const check = validateAiSettings(body);
    if (!check.ok) {
      return NextResponse.json(
        { error: check.error, field: check.field },
        { status: 400 }
      );
    }

    const db = supabaseAdmin();
    const traced = await traceIntegrationSupportAction(ctx, db, {
      integrationId,
      action: 'integration.ai_settings',
      method: 'PATCH',
      path: `/api/account/integrations/${integrationId}`,
    });
    if (!traced) return notFound();
    const found = await updateAccountIntegrationAi(
      db,
      ctx.accountId,
      integrationId,
      check.value
    );
    if (!found) return notFound();
    const views = await loadAccountIntegrations(db, ctx.accountId);
    return NextResponse.json({
      integration: views.find((v) => v.id === integrationId) ?? null,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
