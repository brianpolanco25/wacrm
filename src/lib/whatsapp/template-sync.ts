// ============================================================
// Sincronización del catálogo de plantillas desde Meta.
//
// Vivía dentro de `src/app/api/whatsapp/templates/sync/route.ts`. La
// fase 7 §3 expone la misma operación en `POST /api/v1/templates/sync`,
// y dos copias de esto divergirían en lo peor posible: una plantilla
// que el panel marca APPROVED y la API no, o un
// `template.status_updated` que solo sale por un camino. Así que el
// algoritmo vive aquí y las dos rutas son cáscaras: una resuelve el
// número y la identidad por sesión de navegador, la otra por clave de
// API, y las dos llaman a `syncTemplatesFromMeta`.
//
// Lo que hace, sin cambios respecto de la ruta del panel:
//
//   1. Pagina `/{waba_id}/message_templates` hasta 20 páginas (tope
//      duro: una WABA con más plantillas se marca `truncated`).
//   2. Traduce cada plantilla de Meta a nuestra fila
//      (`message_templates`), guardando el enum de estado VERBATIM
//      (APPROVED / PENDING / REJECTED / PAUSED / DISABLED / IN_APPEAL /
//      PENDING_DELETION) para que los flujos de edición y borrado
//      distingan lo recuperable (PAUSED) de lo terminal (DISABLED).
//   3. Inserta o actualiza por (account_id, name, language) y emite
//      `template.status_updated` SOLO cuando Meta movió la revisión.
//
// Las plantillas creadas en local sin contrapartida en Meta NO se
// borran: siguen visibles para que el usuario note la deriva.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { emitWebhookEvent } from '@/lib/webhooks/emit';
import { normalizeStatus } from '@/lib/whatsapp/template-status-normalize';
import type {
  MessageTemplateStatus,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';

const META_API_VERSION = 'v21.0';
const META_API_BASE = `https://graph.facebook.com/${META_API_VERSION}`;

/** Tope de páginas de la Graph API por sincronización. */
export const SYNC_PAGE_CAP = 20;

interface MetaButton {
  type: string;
  text: string;
  url?: string;
  phone_number?: string;
  example?: string[] | string;
}

interface MetaTemplateComponent {
  type: string;
  text?: string;
  format?: string;
  buttons?: MetaButton[];
  example?: {
    header_text?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaTemplate {
  id: string;
  name: string;
  language: string;
  status: string;
  category: string;
  components?: MetaTemplateComponent[];
  quality_score?: { score?: string } | string;
}

/**
 * Fallo que aborta la sincronización entera (a diferencia de un error
 * por plantilla, que se acumula en `errors`). Hoy solo lo lanza una
 * respuesta no-OK de Meta; lleva su propio `status` para que cada
 * llamador lo traduzca a su sobre de error.
 */
export class TemplateSyncError extends Error {
  readonly status: number;

  constructor(message: string, status = 502) {
    super(message);
    this.name = 'TemplateSyncError';
    this.status = status;
  }
}

export interface TemplateStatusChange {
  template_id: string;
  name: string;
  language: string;
  status: MessageTemplateStatus;
  previous_status: string | null;
}

export interface SyncTemplatesResult {
  /** Plantillas que devolvió Meta. */
  total: number;
  inserted: number;
  updated: number;
  /** Fallos por plantilla; el resto de la sincronización continúa. */
  errors: { name: string; language: string; message: string }[];
  /** Meta tenía más páginas de las que admite `SYNC_PAGE_CAP`. */
  truncated: boolean;
  /** Las que cambiaron de estado (las mismas que se emitieron). */
  statusChanges: TemplateStatusChange[];
}

export interface SyncTemplatesArgs {
  accountId: string;
  /** Columna de auditoría `user_id`; NOT NULL en la tabla. */
  userId: string;
  wabaId: string;
  accessToken: string;
}

function normalizeCategory(
  meta: string
): 'Marketing' | 'Utility' | 'Authentication' {
  const upper = meta.toUpperCase();
  if (upper === 'UTILITY') return 'Utility';
  if (upper === 'AUTHENTICATION') return 'Authentication';
  return 'Marketing';
}

function normalizeQualityScore(
  raw: MetaTemplate['quality_score']
): 'GREEN' | 'YELLOW' | 'RED' | null {
  const score =
    typeof raw === 'string' ? raw : raw?.score ? String(raw.score) : null;
  if (!score) return null;
  const upper = score.toUpperCase();
  return upper === 'GREEN' || upper === 'YELLOW' || upper === 'RED'
    ? (upper as 'GREEN' | 'YELLOW' | 'RED')
    : null;
}

function parseButtons(metaButtons: MetaButton[] | undefined): TemplateButton[] {
  if (!metaButtons?.length) return [];
  const out: TemplateButton[] = [];
  for (const b of metaButtons) {
    switch (b.type?.toUpperCase()) {
      case 'QUICK_REPLY':
        out.push({ type: 'QUICK_REPLY', text: b.text });
        break;
      case 'URL':
        out.push({
          type: 'URL',
          text: b.text,
          url: b.url ?? '',
          example: Array.isArray(b.example) ? b.example[0] : b.example,
        });
        break;
      case 'PHONE_NUMBER':
        out.push({
          type: 'PHONE_NUMBER',
          text: b.text,
          phone_number: b.phone_number ?? '',
        });
        break;
      case 'COPY_CODE':
        out.push({
          type: 'COPY_CODE',
          text: b.text,
          example: Array.isArray(b.example)
            ? (b.example[0] ?? '')
            : (b.example ?? ''),
        });
        break;
      // OTP, FLOW, etc — out of scope for v1; drop silently.
    }
  }
  return out;
}

function extractSampleValues(
  body: MetaTemplateComponent | undefined,
  header: MetaTemplateComponent | undefined
): TemplateSampleValues | null {
  // Meta returns body_text as a 2D array — one row per example set.
  // We take the first row (most templates have exactly one).
  const bodySample = body?.example?.body_text?.[0];
  const headerSample = header?.example?.header_text;
  if (!bodySample?.length && !headerSample?.length) return null;
  const sv: TemplateSampleValues = {};
  if (bodySample?.length) sv.body = bodySample;
  if (headerSample?.length) sv.header = headerSample;
  return sv;
}

/** Recorre la Graph API hasta agotar las páginas o el tope. */
async function fetchMetaTemplates(
  wabaId: string,
  accessToken: string
): Promise<{ templates: MetaTemplate[]; truncated: boolean }> {
  const templates: MetaTemplate[] = [];
  let nextUrl: string | null =
    `${META_API_BASE}/${wabaId}/message_templates?limit=100&fields=id,name,language,status,category,components,quality_score`;
  let pageCount = 0;

  while (nextUrl && pageCount < SYNC_PAGE_CAP) {
    pageCount++;
    const metaRes: Response = await fetch(nextUrl, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    if (!metaRes.ok) {
      let metaErr = `Meta API error: ${metaRes.status}`;
      try {
        const body = await metaRes.json();
        if (body?.error?.message) metaErr = body.error.message;
      } catch {
        // response wasn't JSON — keep the fallback
      }
      throw new TemplateSyncError(metaErr, 502);
    }

    const metaBody: {
      data?: MetaTemplate[];
      paging?: { next?: string };
    } = await metaRes.json();
    if (metaBody.data) templates.push(...metaBody.data);
    nextUrl = metaBody.paging?.next ?? null;
  }

  return {
    templates,
    truncated: pageCount >= SYNC_PAGE_CAP && nextUrl !== null,
  };
}

/**
 * Trae el catálogo de plantillas de una WABA y lo vuelca sobre
 * `message_templates` de una cuenta.
 *
 * `db` puede ser el cliente de sesión (panel, con RLS) o el de rol de
 * servicio (API pública); en los dos casos cada consulta lleva su
 * `account_id` explícito, porque el segundo no tiene RLS que le ate las
 * manos.
 */
export async function syncTemplatesFromMeta(
  db: SupabaseClient,
  args: SyncTemplatesArgs
): Promise<SyncTemplatesResult> {
  const { accountId, userId, wabaId, accessToken } = args;

  const { templates, truncated } = await fetchMetaTemplates(
    wabaId,
    accessToken
  );

  let inserted = 0;
  let updated = 0;
  const errors: { name: string; language: string; message: string }[] = [];
  const statusChanges: TemplateStatusChange[] = [];

  for (const t of templates) {
    const body = (t.components ?? []).find((c) => c.type === 'BODY');
    const header = (t.components ?? []).find((c) => c.type === 'HEADER');
    const footer = (t.components ?? []).find((c) => c.type === 'FOOTER');
    const buttons = (t.components ?? []).find((c) => c.type === 'BUTTONS');

    const parsedButtons = parseButtons(buttons?.buttons);
    const sampleValues = extractSampleValues(body, header);

    const headerFormat = header?.format?.toUpperCase();
    const headerType =
      headerFormat === 'TEXT' ||
      headerFormat === 'IMAGE' ||
      headerFormat === 'VIDEO' ||
      headerFormat === 'DOCUMENT'
        ? headerFormat.toLowerCase()
        : null;

    const row = {
      // Account tenancy + user audit, same split as the submit
      // route. account_id is NOT NULL on message_templates
      // post-017, so an INSERT without it errors.
      account_id: accountId,
      user_id: userId,
      name: t.name,
      category: normalizeCategory(t.category),
      language: t.language,
      header_type: headerType,
      header_content: header?.text ?? null,
      header_handle: header?.example?.header_handle?.[0] ?? null,
      body_text: body?.text ?? '',
      footer_text: footer?.text ?? null,
      buttons: parsedButtons.length ? parsedButtons : null,
      sample_values: sampleValues,
      status: normalizeStatus(t.status),
      meta_template_id: t.id,
      quality_score: normalizeQualityScore(t.quality_score),
      updated_at: new Date().toISOString(),
    };

    // `status` viene en el SELECT para poder comparar: el webhook
    // `template.status_updated` solo tiene sentido cuando Meta MOVIÓ
    // la revisión, no en cada sincronización.
    const { data: existing, error: lookupErr } = await db
      .from('message_templates')
      .select('id, status')
      .eq('account_id', accountId)
      .eq('name', t.name)
      .eq('language', t.language)
      .maybeSingle();

    if (lookupErr) {
      errors.push({
        name: t.name,
        language: t.language,
        message: lookupErr.message,
      });
      continue;
    }

    if (existing?.id) {
      const { error: updErr } = await db
        .from('message_templates')
        .update(row)
        .eq('id', existing.id);
      if (updErr) {
        errors.push({
          name: t.name,
          language: t.language,
          message: updErr.message,
        });
      } else {
        updated++;
        if (existing.status !== row.status) {
          const change: TemplateStatusChange = {
            template_id: existing.id,
            name: t.name,
            language: t.language,
            status: row.status,
            previous_status: (existing.status as string | null) ?? null,
          };
          statusChanges.push(change);
          await emitWebhookEvent(accountId, 'template.status_updated', change);
        }
      }
    } else {
      const { error: insErr } = await db.from('message_templates').insert(row);
      if (insErr) {
        errors.push({
          name: t.name,
          language: t.language,
          message: insErr.message,
        });
      } else {
        inserted++;
      }
    }
  }

  return {
    total: templates.length,
    inserted,
    updated,
    errors,
    truncated,
    statusChanges,
  };
}
