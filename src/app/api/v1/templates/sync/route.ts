// ============================================================
// POST /api/v1/templates/sync — traer el catálogo desde Meta
// (scope: templates:write).
//
// Misma operación que el botón «Sync from Meta» del panel, con el mismo
// código (`src/lib/whatsapp/template-sync.ts`): lo que Meta diga gana,
// las plantillas creadas en local sin contrapartida no se borran, y
// cada plantilla que cambió de estado emite `template.status_updated`
// a los webhooks de la cuenta (fase 7 §4).
//
// Cubo propio, 6/min POR CUENTA (S-A7): una llamada recorre hasta 20
// páginas de la Graph API y reescribe la tabla entera, así que el
// límite general por clave (120/min) no basta y dos claves de la misma
// cuenta no pueden sumar el doble.
//
// El cuerpo es opcional: sirve solo para elegir el número
// (`from` / `whatsapp_config_id`) cuando la cuenta tiene varios.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  readOptionalJsonBody,
  resolveRequestedConfigId,
  resolveTemplateWaba,
  metaErrorResponse,
} from '@/lib/api/v1/templates';
import { resolveAuditUserId } from '@/lib/api/v1/contacts';
import { WhatsAppConfigError } from '@/lib/whatsapp/resolve-config';
import {
  syncTemplatesFromMeta,
  TemplateSyncError,
} from '@/lib/whatsapp/template-sync';

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'templates:write');

    const limit = checkRateLimit(
      `templatesSync:${ctx.accountId}`,
      RATE_LIMITS.templatesSync
    );
    if (!limit.success) {
      return fail(
        'rate_limited',
        'Too many template syncs for this account',
        429,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
          ),
          'X-RateLimit-Limit': String(limit.limit),
          'X-RateLimit-Remaining': String(limit.remaining),
          'X-RateLimit-Reset': String(Math.ceil(limit.reset / 1000)),
        }
      );
    }

    const { data: body } = await readOptionalJsonBody(request);
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

    // `user_id` es NOT NULL en `message_templates` y es solo auditoría:
    // una clave de API no es una persona, así que se atribuye igual que
    // las escrituras de `/api/v1/contacts`.
    const userId = await resolveAuditUserId(ctx.supabase, ctx.accountId);

    const result = await syncTemplatesFromMeta(ctx.supabase, {
      accountId: ctx.accountId,
      userId,
      wabaId: target.wabaId,
      accessToken: target.accessToken,
    });

    return ok({
      synced: result.total,
      created: result.inserted,
      updated: result.updated,
      status_changes: result.statusChanges,
      errors: result.errors,
      truncated: result.truncated,
    });
  } catch (err) {
    if (err instanceof TemplateSyncError) {
      return metaErrorResponse(err);
    }
    if (err instanceof WhatsAppConfigError) {
      return fail(err.code, err.message, err.status);
    }
    return toApiErrorResponse(err);
  }
}
