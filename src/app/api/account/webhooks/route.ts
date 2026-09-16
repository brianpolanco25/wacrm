// ============================================================
// /api/account/webhooks
//
//   GET  — lista los endpoints de la cuenta (sin el secreto).
//   POST — registra uno nuevo y devuelve el secreto UNA vez.
//
// Son las rutas del PANEL, así que autentican con la sesión de cookie
// y trabajan con el cliente RLS: leer es de cualquier miembro (la
// política de la 028 lo permite) y escribir es de admin+, exigido a la
// vez aquí (`requireRole`) y por la política de la tabla.
//
// El secreto se enseña exactamente una vez, en la respuesta del POST.
// Guardamos solo la copia cifrada, así que ni esta ruta ni ninguna
// futura puede volver a mostrarlo: se rota.
// ============================================================

import { NextResponse } from 'next/server';

import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { assertPlanFeature } from '@/lib/billing/enforce';
import { encrypt } from '@/lib/whatsapp/encryption';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: false });

    if (error) {
      console.error('[GET /api/account/webhooks] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load webhooks' },
        { status: 500 }
      );
    }

    return NextResponse.json({
      webhooks: (data ?? []).map((r) =>
        serializeWebhookEndpoint(r as Record<string, unknown>)
      ),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');
    await assertPlanFeature(ctx.accountId, 'webhooks');

    const limit = checkRateLimit(
      `admin:webhookCreate:${ctx.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const url = normalizeWebhookUrl(body.url);
    if (!url) {
      return NextResponse.json(
        { error: "'url' must be a valid https:// URL" },
        { status: 400 }
      );
    }

    const events = normalizeEvents(body.events);
    if (!events) {
      return NextResponse.json(
        { error: "'events' must be a non-empty list of known events" },
        { status: 400 }
      );
    }

    const secret = generateWebhookSecret();

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        url,
        secret: encrypt(secret),
        events,
      })
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .single();

    if (error || !data) {
      console.error('[POST /api/account/webhooks] insert error:', error);
      return NextResponse.json(
        { error: 'Failed to create webhook' },
        { status: 500 }
      );
    }

    return NextResponse.json(
      {
        webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
        secret,
      },
      { status: 201 }
    );
  } catch (err) {
    return toErrorResponse(err);
  }
}
