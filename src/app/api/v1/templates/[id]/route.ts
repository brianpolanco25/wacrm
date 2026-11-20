// ============================================================
// GET    /api/v1/templates/{id} — read one          (templates:read)
// PATCH  /api/v1/templates/{id} — edit and resubmit  (templates:write)
// DELETE /api/v1/templates/{id} — delete on Meta and locally
//
// Todo acotado por cuenta: un id ajeno es 404, nunca 403 ni la fila.
//
// `PATCH` no es un parcheo ciego: Meta REEMPLAZA los componentes en
// cada edición, así que lo que no venga en el cuerpo se hereda de la
// fila que ya existe en lugar de borrarse. Para quitar un pie de
// página, una cabecera o los botones se manda `null` explícito.
// `name` y `language` son inmutables: Meta trata cada par
// (nombre, idioma) como una plantilla distinta, así que "renombrar"
// sería crear otra.
// ============================================================

import { UUID_RE } from '@/lib/uuid';
import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { readJsonBody } from '@/lib/api/v1/body';
import {
  TEMPLATE_SELECT,
  parseTemplateInput,
  resolveRequestedConfigId,
  resolveTemplateWaba,
  serializeTemplate,
  metaErrorResponse,
} from '@/lib/api/v1/templates';
import { WhatsAppConfigError } from '@/lib/whatsapp/resolve-config';
import { validateTemplatePayload } from '@/lib/whatsapp/template-validators';
import {
  EDITABLE_TEMPLATE_STATUSES,
  deleteTemplate,
  editTemplate,
  isTemplatesDryRun as isDryRun,
} from '@/lib/whatsapp/template-operations';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import type { SupabaseClient } from '@supabase/supabase-js';

/** La fila de esta cuenta, o null. Siempre filtrada por `account_id`. */
async function loadTemplate(
  db: SupabaseClient,
  accountId: string,
  id: string
): Promise<Record<string, unknown> | null> {
  const { data, error } = await db
    .from('message_templates')
    .select(TEMPLATE_SELECT)
    .eq('id', id)
    .eq('account_id', accountId)
    .maybeSingle();
  if (error) {
    console.error('[api/v1/templates] read error:', error);
    return null;
  }
  return (data as Record<string, unknown> | null) ?? null;
}

/** La fila como `TemplatePayload`, para heredar en una edición. */
function rowAsPayload(row: Record<string, unknown>): Partial<TemplatePayload> {
  return {
    name: row.name as string,
    category: row.category as TemplatePayload['category'],
    language: (row.language as string) ?? '',
    header_type:
      (row.header_type as TemplatePayload['header_type']) ?? undefined,
    header_content: (row.header_content as string | null) ?? undefined,
    header_media_url: (row.header_media_url as string | null) ?? undefined,
    header_handle: (row.header_handle as string | null) ?? undefined,
    body_text: (row.body_text as string) ?? '',
    footer_text: (row.footer_text as string | null) ?? undefined,
    buttons: (row.buttons as TemplatePayload['buttons']) ?? undefined,
    sample_values:
      (row.sample_values as TemplatePayload['sample_values']) ?? undefined,
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { id } = await params;
    if (!UUID_RE.test(id)) return fail('not_found', 'Template not found', 404);

    const row = await loadTemplate(ctx.supabase, ctx.accountId, id);
    if (!row) return fail('not_found', 'Template not found', 404);

    return ok(serializeTemplate(row));
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');
    const { id } = await params;

    // Fase 7 §1: toda escritura de /api/v1 lee su cuerpo por
    // `readJsonBody` (Content-Type, tope de 1 MiB, objeto JSON). Editar
    // no se envuelve en `withIdempotency`: repetir la misma edición es
    // idempotente por naturaleza (el resultado es el mismo conjunto de
    // componentes), y Meta ya limita a 10 ediciones por 30 días.
    const { data: body } = await readJsonBody(request);

    if (!UUID_RE.test(id)) return fail('not_found', 'Template not found', 404);
    const existing = await loadTemplate(ctx.supabase, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Template not found', 404);

    if (!existing.meta_template_id) {
      return fail(
        'conflict',
        'This template was never submitted to Meta — create it with POST /api/v1/templates instead',
        409
      );
    }
    if (!EDITABLE_TEMPLATE_STATUSES.has(String(existing.status))) {
      return fail(
        'conflict',
        `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED`,
        409
      );
    }

    for (const field of ['name', 'language'] as const) {
      if (field in body && body[field] !== existing[field]) {
        return fail(
          'bad_request',
          `'${field}' cannot be changed — Meta treats each (name, language) pair as its own template`,
          400
        );
      }
    }

    const payload = parseTemplateInput(body, rowAsPayload(existing));

    if (payload.category === 'Authentication') {
      return fail(
        'bad_request',
        'AUTHENTICATION templates cannot be edited through this API — manage them in Meta WhatsApp Manager',
        400
      );
    }

    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return fail(
        'bad_request',
        e instanceof Error ? e.message : 'Template validation failed',
        400
      );
    }

    let accessToken: string | null = null;
    if (!isDryRun()) {
      const configId = await resolveRequestedConfigId(
        ctx.supabase,
        ctx.accountId,
        body
      );
      accessToken = (
        await resolveTemplateWaba(ctx.supabase, ctx.accountId, configId)
      ).accessToken;
    }

    // Meta reemplaza los componentes, así que una cabecera de imagen
    // necesita handle nuevo en cada edición; si Meta la rechaza, el
    // motivo queda anotado en la fila (igual que el panel).
    const result = await editTemplate(ctx.supabase, {
      accountId: ctx.accountId,
      id,
      metaTemplateId: String(existing.meta_template_id),
      accessToken,
      payload,
      select: TEMPLATE_SELECT,
    });
    if (!result.ok && result.step === 'header') {
      const e = result.error;
      return fail(
        'bad_request',
        e instanceof Error ? e.message : 'Header image upload failed',
        400
      );
    }
    if (!result.ok && result.step === 'meta') {
      return metaErrorResponse(result.error);
    }
    if (!result.ok) {
      console.error('[api/v1/templates] update error:', result.error);
      return fail(
        'internal',
        'Edited on Meta but failed to save locally. Run POST /api/v1/templates/sync to recover.',
        500
      );
    }
    const row = result.row;

    return ok(serializeTemplate(row as Record<string, unknown>));
  } catch (err) {
    if (err instanceof WhatsAppConfigError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');
    const { id } = await params;
    if (!UUID_RE.test(id)) return fail('not_found', 'Template not found', 404);

    const existing = await loadTemplate(ctx.supabase, ctx.accountId, id);
    if (!existing) return fail('not_found', 'Template not found', 404);

    let target: { wabaId: string; accessToken: string } | null = null;
    if (existing.meta_template_id && !isDryRun()) {
      // `DELETE` no lleva cuerpo, así que el número se elige por query
      // (`?from=<phone_number_id>`); sin él, el predeterminado.
      const configId = await resolveRequestedConfigId(
        ctx.supabase,
        ctx.accountId,
        Object.fromEntries(new URL(request.url).searchParams)
      );
      target = await resolveTemplateWaba(ctx.supabase, ctx.accountId, configId);
    }

    const result = await deleteTemplate(ctx.supabase, {
      accountId: ctx.accountId,
      id,
      name: String(existing.name),
      metaTemplateId: existing.meta_template_id
        ? String(existing.meta_template_id)
        : null,
      target,
    });
    if (!result.ok && result.step === 'meta') {
      return metaErrorResponse(result.error);
    }
    if (!result.ok) {
      console.error('[api/v1/templates] delete error:', result.error);
      return fail(
        'internal',
        'Deleted on Meta but failed to delete locally',
        500
      );
    }
    if (!result.deleted) return fail('not_found', 'Template not found', 404);

    return ok({ id, deleted: true });
  } catch (err) {
    if (err instanceof WhatsAppConfigError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
