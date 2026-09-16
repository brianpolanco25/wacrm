// ============================================================
// PATCH  /api/account/webhooks/{id} — url, eventos, activar/desactivar.
// DELETE /api/account/webhooks/{id} — borrar el endpoint.
//
// Admin+, con el cliente RLS. Acotadas por `account_id` además de por
// id: un id de otra cuenta no toca nada y devuelve 404.
//
// Borrar el endpoint se lleva por delante su bitácora de entregas
// (ON DELETE CASCADE de la 062): son payloads del cliente final y no
// quedaría forma de consultarlos ni de borrarlos.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { normalizeEvents } from '@/lib/webhooks/events';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  normalizeWebhookUrl,
  serializeWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

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

    const updates: Record<string, unknown> = {};

    if ('url' in body) {
      const url = normalizeWebhookUrl(body.url);
      if (!url) {
        return NextResponse.json(
          { error: "'url' must be a valid https:// URL" },
          { status: 400 }
        );
      }
      updates.url = url;
    }

    if ('events' in body) {
      const events = normalizeEvents(body.events);
      if (!events) {
        return NextResponse.json(
          { error: "'events' must be a non-empty list of known events" },
          { status: 400 }
        );
      }
      updates.events = events;
    }

    if ('is_active' in body) {
      if (typeof body.is_active !== 'boolean') {
        return NextResponse.json(
          { error: "'is_active' must be a boolean" },
          { status: 400 }
        );
      }
      updates.is_active = body.is_active;
      // Reactivar limpia la racha de fallos: si no, el primer fallo
      // volvería a cruzar el umbral y lo desactivaría en el acto.
      if (body.is_active === true) updates.failure_count = 0;
    }

    if (Object.keys(updates).length === 0) {
      return NextResponse.json(
        { error: 'No updatable fields provided' },
        { status: 400 }
      );
    }

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(WEBHOOK_PUBLIC_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[PATCH /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to update webhook' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({
      webhook: serializeWebhookEndpoint(data as Record<string, unknown>),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireRole('admin');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('webhook_endpoints')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[DELETE /api/account/webhooks/[id]] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete webhook' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Webhook not found' }, { status: 404 });
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
