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
import {
  deleteMessageTemplate,
  editMessageTemplate,
} from '@/lib/whatsapp/meta-api';
import { validateTemplatePayload } from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';
import type { SupabaseClient } from '@supabase/supabase-js';

/** Meta solo deja editar estas tres. */
const EDITABLE_STATUSES = new Set(['APPROVED', 'REJECTED', 'PAUSED']);

// Un id que ni siquiera es un UUID no puede ser una fila de esta
// cuenta: se responde 404 sin preguntarle a Postgres (que además
// contestaría con un error de sintaxis 22P02 convertido en 500).
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

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
    if (!EDITABLE_STATUSES.has(String(existing.status))) {
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

    if (!isDryRun()) {
      const configId = await resolveRequestedConfigId(
        ctx.supabase,
        ctx.accountId,
        body
      );
      const target = await resolveTemplateWaba(
        ctx.supabase,
        ctx.accountId,
        configId
      );

      // Meta reemplaza los componentes, así que una cabecera de imagen
      // necesita handle nuevo en cada edición.
      try {
        await ensureImageHeaderHandle(payload, target.accessToken, {
          accountId: ctx.accountId,
          storage: supabaseAdmin().storage,
          db: supabaseAdmin(),
        });
      } catch (e) {
        return fail(
          'bad_request',
          e instanceof Error ? e.message : 'Header image upload failed',
          400
        );
      }

      try {
        await editMessageTemplate({
          metaTemplateId: String(existing.meta_template_id),
          accessToken: target.accessToken,
          components: buildMetaTemplatePayload(payload).components,
        });
      } catch (e) {
        // Se anota el fallo en la fila (igual que el panel) para que el
        // motivo quede visible en la siguiente lectura.
        await ctx.supabase
          .from('message_templates')
          .update({
            submission_error:
              e instanceof Error ? e.message : 'Meta edit failed',
            last_submitted_at: new Date().toISOString(),
          })
          .eq('id', id)
          .eq('account_id', ctx.accountId);
        return metaErrorResponse(e);
      }
    }

    // Meta aceptó la edición: la revisión vuelve a empezar.
    const { data: row, error: updErr } = await ctx.supabase
      .from('message_templates')
      .update({
        category: payload.category,
        header_type: payload.header_type ?? null,
        header_content: payload.header_content ?? null,
        header_media_url: payload.header_media_url ?? null,
        header_handle: payload.header_handle ?? null,
        body_text: payload.body_text,
        footer_text: payload.footer_text ?? null,
        buttons: payload.buttons ?? null,
        sample_values: payload.sample_values ?? null,
        status: 'PENDING',
        submission_error: null,
        rejection_reason: null,
        last_submitted_at: new Date().toISOString(),
      })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(TEMPLATE_SELECT)
      .maybeSingle();

    if (updErr || !row) {
      console.error('[api/v1/templates] update error:', updErr);
      return fail(
        'internal',
        'Edited on Meta but failed to save locally. Run POST /api/v1/templates/sync to recover.',
        500
      );
    }

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

    if (existing.meta_template_id && !isDryRun()) {
      // `DELETE` no lleva cuerpo, así que el número se elige por query
      // (`?from=<phone_number_id>`); sin él, el predeterminado.
      const configId = await resolveRequestedConfigId(
        ctx.supabase,
        ctx.accountId,
        Object.fromEntries(new URL(request.url).searchParams)
      );
      const target = await resolveTemplateWaba(
        ctx.supabase,
        ctx.accountId,
        configId
      );
      try {
        await deleteMessageTemplate({
          wabaId: target.wabaId,
          accessToken: target.accessToken,
          name: String(existing.name),
          // Sin `hsm_id` Meta borraría TODAS las traducciones que
          // comparten el nombre, no solo esta.
          metaTemplateId: String(existing.meta_template_id),
        });
      } catch (e) {
        return metaErrorResponse(e);
      }
    }

    const { data, error } = await ctx.supabase
      .from('message_templates')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[api/v1/templates] delete error:', error);
      return fail(
        'internal',
        'Deleted on Meta but failed to delete locally',
        500
      );
    }
    if (!data) return fail('not_found', 'Template not found', 404);

    return ok({ id: data.id, deleted: true });
  } catch (err) {
    if (err instanceof WhatsAppConfigError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
