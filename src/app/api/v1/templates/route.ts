// ============================================================
// GET  /api/v1/templates — list message templates (templates:read)
// POST /api/v1/templates — create one and submit it to Meta
//                          (templates:write)
//
// La lista es keyset-paginada como el resto de `/api/v1` y filtra por
// `?status=`, `?language=`, `?category=` y `?search=` (nombre o
// cuerpo). Cada elemento trae `variables`: los `{{1}}…{{n}}` que espera
// el cuerpo, que es lo que hay que pasarle luego a
// `POST /api/v1/messages` con `type=template`.
//
// Crear es un viaje a Meta: se valida en local con los MISMOS
// validadores del panel, se arma el cuerpo con `template-components.ts`
// y se envía con `submitMessageTemplate`. Si Meta la rechaza no se
// escribe nada (a diferencia del panel, que deja un borrador visible en
// la interfaz para que el usuario lo corrija: un cliente de API no
// tiene dónde verlo y se le quedaría una fila fantasma ocupando el
// nombre).
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { withIdempotency } from '@/lib/api/v1/idempotency';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  TEMPLATE_SELECT,
  TEMPLATE_STATUSES,
  normalizeCategoryInput,
  parseTemplateInput,
  resolveRequestedConfigId,
  resolveTemplateWaba,
  serializeTemplate,
  metaErrorResponse,
} from '@/lib/api/v1/templates';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { WhatsAppConfigError } from '@/lib/whatsapp/resolve-config';
import { submitMessageTemplate } from '@/lib/whatsapp/meta-api';
import { validateTemplatePayload } from '@/lib/whatsapp/template-validators';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import { supabaseAdmin } from '@/lib/flows/admin-client';

/** Igual que en `/api/v1/contacts`: nada que rompa la gramática de `.or()`. */
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} _+@.\-{}]/gu, '').trim();
}

function isDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);

    let query = ctx.supabase
      .from('message_templates')
      .select(TEMPLATE_SELECT)
      .eq('account_id', ctx.accountId);

    const status = url.searchParams.get('status');
    if (status) {
      const upper = status.toUpperCase();
      if (!(TEMPLATE_STATUSES as readonly string[]).includes(upper)) {
        return fail(
          'bad_request',
          `'status' must be one of ${TEMPLATE_STATUSES.join(', ')}`,
          400
        );
      }
      query = query.eq('status', upper);
    }

    const language = url.searchParams.get('language');
    if (language) query = query.eq('language', language);

    const category = url.searchParams.get('category');
    if (category) {
      // Se normaliza a la forma que guarda la columna (`Marketing`),
      // así que `?category=marketing` también encuentra algo.
      query = query.eq('category', normalizeCategoryInput(category));
    }

    const search = sanitizeSearch(url.searchParams.get('search') ?? '');
    if (search) {
      query = query.or(`name.ilike.*${search}*,body_text.ilike.*${search}*`);
    }

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/templates] list error:', error);
      return fail('internal', 'Failed to list templates', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeTemplate(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');

    // Fase 7 §1: la escritura va envuelta en `withIdempotency`, que lee
    // el cuerpo por `readJsonBody` (Content-Type, tope de 1 MiB, objeto
    // JSON) y reproduce la respuesta si el cliente reintenta con la
    // misma `Idempotency-Key`. Crear una plantilla dos veces sería un
    // 409 de Meta y, peor, gastaría una de las 100 creaciones por hora
    // que permite la WABA.
    return await withIdempotency(ctx, request, async (body) => {
      const payload = parseTemplateInput(body);

      if (!payload.name) return fail('bad_request', "'name' is required", 400);
      if (!payload.language) {
        return fail('bad_request', "'language' is required", 400);
      }

      if (payload.category === 'Authentication') {
        return fail(
          'bad_request',
          'AUTHENTICATION templates cannot be created through this API — create them in Meta WhatsApp Manager and run POST /api/v1/templates/sync',
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

      // Meta rechaza un (name, language) repetido y la tabla lo tiene
      // como único por cuenta: mejor decirlo antes de gastar el viaje.
      const { data: clash } = await ctx.supabase
        .from('message_templates')
        .select('id')
        .eq('account_id', ctx.accountId)
        .eq('name', payload.name)
        .eq('language', payload.language)
        .maybeSingle();
      if (clash?.id) {
        return fail(
          'conflict',
          `A template named '${payload.name}' already exists in '${payload.language}' — edit it with PATCH /api/v1/templates/${clash.id}`,
          409
        );
      }

      let metaTemplateId: string;
      let metaStatus: string;

      if (isDryRun()) {
        metaTemplateId = `dry-run-${crypto.randomUUID()}`;
        metaStatus = 'PENDING';
      } else {
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

        // Una cabecera de imagen necesita un handle de Resumable Upload
        // (Meta rechaza una URL suelta al crear). Mismo helper que el
        // panel, incluida la comprobación de que el objeto del bucket
        // es de esta cuenta.
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
          const meta = await submitMessageTemplate({
            wabaId: target.wabaId,
            accessToken: target.accessToken,
            payload: buildMetaTemplatePayload(payload),
          });
          metaTemplateId = meta.id;
          metaStatus = meta.status;
        } catch (e) {
          return metaErrorResponse(e);
        }
      }

      const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

      const { data: row, error: insertErr } = await ctx.supabase
        .from('message_templates')
        .insert({
          account_id: ctx.accountId,
          user_id: auditUserId,
          name: payload.name,
          category: payload.category,
          language: payload.language,
          header_type: payload.header_type ?? null,
          header_content: payload.header_content ?? null,
          header_media_url: payload.header_media_url ?? null,
          header_handle: payload.header_handle ?? null,
          body_text: payload.body_text,
          footer_text: payload.footer_text ?? null,
          buttons: payload.buttons ?? null,
          sample_values: payload.sample_values ?? null,
          status: normalizeStatus(metaStatus),
          meta_template_id: metaTemplateId,
          submission_error: null,
          rejection_reason: null,
          last_submitted_at: new Date().toISOString(),
        })
        .select(TEMPLATE_SELECT)
        .single();

      if (insertErr || !row) {
        // Meta ya la aceptó: se devuelve su id para que el cliente pueda
        // recuperar la fila con POST /api/v1/templates/sync en vez de
        // quedarse con una plantilla que existe en Meta y no aquí.
        console.error('[api/v1/templates] insert error:', insertErr);
        return fail(
          'internal',
          `Submitted to Meta (${metaTemplateId}) but failed to save locally. Run POST /api/v1/templates/sync to recover.`,
          500
        );
      }

      return ok(serializeTemplate(row as Record<string, unknown>), 201);
    });
  } catch (err) {
    if (err instanceof WhatsAppConfigError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
