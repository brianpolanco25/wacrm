// ============================================================
// Plantillas de mensaje en la API pública (fase 7 §3).
//
// Lo que vive aquí es SOLO lo que las tres rutas de `/api/v1/templates`
// comparten: cómo se lee una plantilla del cuerpo de la petición, cómo
// se serializa hacia fuera y cómo se traduce un fallo de Meta al sobre
// de error. Nada de esto reimplementa la integración con Meta: la
// validación es `template-validators.ts`, el cuerpo que se le manda a
// Meta lo arma `template-components.ts`, las llamadas son las de
// `meta-api.ts` y la sincronización es `template-sync.ts` —los mismos
// módulos que usa el panel.
//
// La forma pública de una plantilla añade una cosa que la fila no
// tiene: `variables`, la lista ordenada de `{{1}}…{{n}}` del cuerpo.
// Sin ella un integrador no sabe cuántos `params` pasarle a
// `POST /api/v1/messages` con `type=template` y lo descubre por
// ensayo y error contra Meta.
// ============================================================

import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';

import { badRequest, v1Headers } from '@/lib/api/v1/respond';
import { readJsonBody, type JsonBody } from '@/lib/api/v1/body';
import { MetaApiError } from '@/lib/whatsapp/meta-api';
import {
  extractVariableIndices,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import {
  configIdForPhoneNumberId,
  resolveWhatsAppConfig,
} from '@/lib/whatsapp/resolve-config';
import type {
  MessageTemplateStatus,
  TemplateButton,
  TemplateSampleValues,
} from '@/types';

/** Columnas que necesita el serializador (y el cursor de paginación). */
export const TEMPLATE_SELECT =
  'id, name, category, language, header_type, header_content, header_media_url, header_handle, body_text, footer_text, buttons, sample_values, status, meta_template_id, rejection_reason, quality_score, submission_error, last_submitted_at, created_at, updated_at';

/** Los ocho estados de revisión de Meta que admite la tabla (014). */
export const TEMPLATE_STATUSES: readonly MessageTemplateStatus[] = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
];

const CATEGORIES = ['Marketing', 'Utility', 'Authentication'] as const;
type TemplateCategory = (typeof CATEGORIES)[number];

const HEADER_TYPES = ['text', 'image', 'video', 'document'] as const;
const BUTTON_TYPES = [
  'QUICK_REPLY',
  'URL',
  'PHONE_NUMBER',
  'COPY_CODE',
] as const;

// ------------------------------------------------------------------
// Salida
// ------------------------------------------------------------------

export interface TemplateVariable {
  /** 1-indexado, como lo escribe Meta. */
  index: number;
  /** El literal tal cual aparece en el cuerpo: `{{1}}`. */
  placeholder: string;
  /** El valor de ejemplo con el que se aprobó, si lo hay. */
  example: string | null;
}

/**
 * Las variables del CUERPO, en orden. `validateBody` ya obliga a que
 * sean contiguas desde `{{1}}`, así que el índice del array y el número
 * del marcador coinciden para toda plantilla creada por aquí; para una
 * sincronizada desde Meta se devuelve lo que haya, ordenado.
 */
export function templateBodyVariables(
  bodyText: string | null | undefined,
  sampleValues: unknown
): TemplateVariable[] {
  const samples =
    sampleValues && typeof sampleValues === 'object'
      ? ((sampleValues as TemplateSampleValues).body ?? [])
      : [];
  return extractVariableIndices(bodyText ?? '').map((index, position) => ({
    index,
    placeholder: `{{${index}}}`,
    example: typeof samples[position] === 'string' ? samples[position] : null,
  }));
}

/**
 * Forma pública de una plantilla. Deliberadamente NO incluye
 * `account_id` ni `user_id`: la cuenta ya la fija la clave y el
 * `user_id` es una columna de auditoría interna que identificaría a una
 * persona ante un integrador externo.
 */
export function serializeTemplate(row: Record<string, unknown>) {
  const bodyText = (row.body_text as string | null) ?? '';
  return {
    id: row.id as string,
    name: row.name as string,
    language: (row.language as string | null) ?? null,
    category: (row.category as string | null) ?? null,
    status: (row.status as string | null) ?? null,
    meta_template_id: (row.meta_template_id as string | null) ?? null,
    quality_score: (row.quality_score as string | null) ?? null,
    rejection_reason: (row.rejection_reason as string | null) ?? null,
    submission_error: (row.submission_error as string | null) ?? null,
    components: {
      header: row.header_type
        ? {
            format: row.header_type as string,
            text: (row.header_content as string | null) ?? null,
            media_url: (row.header_media_url as string | null) ?? null,
          }
        : null,
      body: { text: bodyText },
      footer: row.footer_text ? { text: row.footer_text as string } : null,
      buttons: (row.buttons as TemplateButton[] | null) ?? [],
    },
    variables: templateBodyVariables(bodyText, row.sample_values),
    sample_values: (row.sample_values as TemplateSampleValues | null) ?? null,
    last_submitted_at: (row.last_submitted_at as string | null) ?? null,
    created_at: row.created_at as string,
    updated_at: (row.updated_at as string | null) ?? null,
  };
}

// ------------------------------------------------------------------
// Entrada
// ------------------------------------------------------------------

function asString(
  value: unknown,
  field: string,
  { allowEmpty = false } = {}
): string {
  if (typeof value !== 'string') {
    throw badRequest(`'${field}' must be a string`);
  }
  const trimmed = value.trim();
  if (!allowEmpty && !trimmed) {
    throw badRequest(`'${field}' must not be empty`);
  }
  return value;
}

/** `Marketing` / `marketing` / `MARKETING` → `Marketing`. */
export function normalizeCategoryInput(value: unknown): TemplateCategory {
  if (typeof value !== 'string') {
    throw badRequest("'category' must be a string");
  }
  const match = CATEGORIES.find(
    (c) => c.toLowerCase() === value.trim().toLowerCase()
  );
  if (!match) {
    throw badRequest(
      `'category' must be one of ${CATEGORIES.join(', ')} (got '${value}')`
    );
  }
  return match;
}

function normalizeButtons(value: unknown): TemplateButton[] {
  if (!Array.isArray(value)) {
    throw badRequest("'buttons' must be an array");
  }
  return value.map((entry, i) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw badRequest(`'buttons[${i}]' must be an object`);
    }
    const b = entry as Record<string, unknown>;
    const type = typeof b.type === 'string' ? b.type.toUpperCase() : '';
    if (!(BUTTON_TYPES as readonly string[]).includes(type)) {
      throw badRequest(
        `'buttons[${i}].type' must be one of ${BUTTON_TYPES.join(', ')}`
      );
    }
    // Los campos por tipo (url, phone_number, example, longitudes, orden
    // QUICK_REPLY-vs-CTA) los comprueba `validateButtons`, que es el
    // mismo validador del panel: aquí solo se garantiza que las formas
    // son las que ese validador sabe leer sin reventar.
    for (const key of ['text', 'url', 'phone_number', 'example'] as const) {
      if (key in b && b[key] !== undefined && typeof b[key] !== 'string') {
        throw badRequest(`'buttons[${i}].${key}' must be a string`);
      }
    }
    return { ...b, type } as unknown as TemplateButton;
  });
}

function normalizeSampleValues(value: unknown): TemplateSampleValues {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw badRequest("'sample_values' must be an object");
  }
  const out: TemplateSampleValues = {};
  for (const key of ['body', 'header'] as const) {
    const raw = (value as Record<string, unknown>)[key];
    if (raw === undefined) continue;
    if (!Array.isArray(raw) || raw.some((v) => typeof v !== 'string')) {
      throw badRequest(`'sample_values.${key}' must be an array of strings`);
    }
    out[key] = raw as string[];
  }
  return out;
}

/**
 * Cuerpo entrante → el `TemplatePayload` que entienden el validador y
 * el constructor de componentes. `base` es la plantilla que ya existe
 * (edición): los campos que el cliente no mande se heredan de ella,
 * porque Meta REEMPLAZA los componentes en cada edición y un `PATCH`
 * parcial que borrara el pie de página sin querer sería una trampa.
 *
 * Lanza `ApiError` 400 con el nombre del campo, nunca un `TypeError`
 * desde dentro del validador.
 */
export function parseTemplateInput(
  body: Record<string, unknown>,
  base?: Partial<TemplatePayload>
): TemplatePayload {
  const payload: TemplatePayload = {
    name: base?.name ?? '',
    category: base?.category ?? 'Marketing',
    language: base?.language ?? '',
    body_text: base?.body_text ?? '',
  };
  if (base?.header_type) payload.header_type = base.header_type;
  if (base?.header_content) payload.header_content = base.header_content;
  if (base?.header_media_url) payload.header_media_url = base.header_media_url;
  if (base?.header_handle) payload.header_handle = base.header_handle;
  if (base?.footer_text) payload.footer_text = base.footer_text;
  if (base?.buttons) payload.buttons = base.buttons;
  if (base?.sample_values) payload.sample_values = base.sample_values;

  if ('name' in body) payload.name = asString(body.name, 'name').trim();
  if ('language' in body) {
    payload.language = asString(body.language, 'language').trim();
  }
  if ('category' in body) {
    payload.category = normalizeCategoryInput(body.category);
  }
  if ('body_text' in body) {
    payload.body_text = asString(body.body_text, 'body_text');
  }

  if ('header_type' in body) {
    if (body.header_type === null) {
      delete payload.header_type;
      delete payload.header_content;
      delete payload.header_media_url;
      delete payload.header_handle;
    } else {
      const type = asString(body.header_type, 'header_type').toLowerCase();
      if (!(HEADER_TYPES as readonly string[]).includes(type)) {
        throw badRequest(
          `'header_type' must be one of ${HEADER_TYPES.join(', ')} or null`
        );
      }
      payload.header_type = type as TemplatePayload['header_type'];
    }
  }
  for (const key of [
    'header_content',
    'header_media_url',
    'header_handle',
    'footer_text',
  ] as const) {
    if (!(key in body)) continue;
    if (body[key] === null) {
      delete payload[key];
      continue;
    }
    payload[key] = asString(body[key], key, { allowEmpty: true });
  }

  if ('buttons' in body) {
    if (body.buttons === null) delete payload.buttons;
    else payload.buttons = normalizeButtons(body.buttons);
  }
  if ('sample_values' in body) {
    if (body.sample_values === null) delete payload.sample_values;
    else payload.sample_values = normalizeSampleValues(body.sample_values);
  }

  return payload;
}

/**
 * `from` (el `phone_number_id` de Meta, que es lo que un cliente
 * externo conoce) o `whatsapp_config_id` (el id interno, que devuelve
 * `GET /api/v1/me` en su día) → el id de fila de `whatsapp_config`.
 *
 * Igual que en `POST /api/v1/messages`: pedir un número que no es tuyo
 * es un error, no una excusa para usar otro. Devuelve `null` cuando el
 * cliente no eligió (se usará el predeterminado de la cuenta).
 */
export async function resolveRequestedConfigId(
  db: SupabaseClient,
  accountId: string,
  body: Record<string, unknown>
): Promise<string | null> {
  if (typeof body.whatsapp_config_id === 'string' && body.whatsapp_config_id) {
    return body.whatsapp_config_id.trim();
  }
  if (typeof body.from === 'string' && body.from.trim()) {
    const id = await configIdForPhoneNumberId(db, accountId, body.from.trim());
    if (!id) {
      throw badRequest("'from' is not a connected number");
    }
    return id;
  }
  return null;
}

export interface TemplateWabaTarget {
  /** Fila de `whatsapp_config` elegida. */
  configId: string;
  wabaId: string;
  accessToken: string;
}

/**
 * El número (y por tanto la WABA y el token) contra el que trabaja una
 * operación de plantillas.
 *
 * Fase 4 §1, deuda deliberada heredada del panel: en Meta las
 * plantillas son POR WABA y aquí son UNIQUE(account_id, name,
 * language), así que una cuenta con números bajo WABA DISTINTAS no
 * puede expresar a cuál pertenece cada plantilla. Por eso `configId`
 * sirve para ELEGIR la WABA, pero la fila local sigue sin guardarla.
 *
 * Lanza `WhatsAppConfigError` (número ajeno → 404, sin configurar →
 * 400) o `ApiError` 400 si el número no tiene WABA asociada.
 */
export async function resolveTemplateWaba(
  db: SupabaseClient,
  accountId: string,
  configId: string | null
): Promise<TemplateWabaTarget> {
  const resolved = await resolveWhatsAppConfig(db, {
    accountId,
    configId,
    withToken: true,
  });
  const wabaId = resolved.row.waba_id;
  if (!wabaId) {
    throw badRequest(
      'The selected WhatsApp number has no WhatsApp Business Account id. Re-connect it in Settings.'
    );
  }
  return {
    configId: resolved.row.id,
    wabaId,
    accessToken: resolved.accessToken,
  };
}

/**
 * Lee el cuerpo solo si el cliente mandó uno. `POST
 * /api/v1/templates/sync` no necesita ninguno: obligar a mandar `{}`
 * con `Content-Type: application/json` para poder sincronizar sería
 * gratuito.
 *
 * Son dos tolerancias, no una. Sin `Content-Type` no hay 415 (nadie
 * declara el tipo de un cuerpo que no existe), y CON `Content-Type` un
 * cuerpo vacío vale `{}` en lugar de 400 —`curl -X POST -H
 * 'Content-Type: application/json'` sin `-d` es la forma natural de
 * llamar a esto—. Lo demás es `readJsonBody` como en toda escritura de
 * `/api/v1` (413 / 400 / objeto en la raíz), nunca `request.json()`.
 */
export async function readOptionalJsonBody(
  request: Request
): Promise<JsonBody> {
  const contentType = request.headers.get('content-type');
  const declared = request.headers.get('content-length');
  const hasBody =
    (contentType !== null && contentType.trim() !== '') ||
    (declared !== null && Number(declared) > 0);
  if (!hasBody) return { data: {}, raw: '' };
  return readJsonBody(request, { allowEmpty: true });
}

// ------------------------------------------------------------------
// Errores de Meta
// ------------------------------------------------------------------

/**
 * Un fallo de la Graph API → `502 meta_error`.
 *
 * El sobre lleva el código público de Meta (`meta_code`) junto al
 * mensaje, igual que el de facturación lleva su métrica: un integrador
 * puede ramificar por `code` y buscar `meta_code` en la documentación
 * de Meta sin analizar la frase. Nunca se filtra la URL llamada, el
 * token ni nada del servidor: solo lo que Meta publica.
 */
export function metaErrorResponse(err: unknown): NextResponse {
  const message =
    err instanceof Error
      ? err.message
      : 'The WhatsApp API rejected the request';
  const { requestId, headers } = v1Headers();
  return NextResponse.json(
    {
      error: {
        code: 'meta_error',
        message,
        ...(err instanceof MetaApiError && err.code !== undefined
          ? { meta_code: err.code }
          : {}),
        request_id: requestId,
      },
    },
    { status: 502, headers }
  );
}
