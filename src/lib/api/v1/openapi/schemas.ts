// ============================================================
// Esquemas compartidos del contrato OpenAPI.
//
// Un recurso se describe UNA vez aquí y las operaciones lo referencian
// con `ref('Contact')`. Los nombres coinciden con los serializadores
// de `src/lib/api/v1/*` y `src/lib/webhooks/*`: si una forma cambia
// allí, este archivo es el sitio donde se refleja.
//
// Convenciones:
//   - 3.1 es JSON Schema 2020-12: lo nulable es `type: ['x','null']`.
//   - Los esquemas de RESPUESTA cierran con `additionalProperties:
//     false` (describen todo lo que sale); los de PETICIÓN lo dejan
//     abierto, porque la API ignora campos desconocidos a propósito.
// ============================================================

import { API_SCOPES } from '@/lib/api-keys/scopes';
import { WEBHOOK_EVENTS } from '@/lib/webhooks/events';
import type { SchemaObject } from './types';

/** Referencia a un esquema de `components.schemas`. */
export function ref(name: string): SchemaObject {
  return { $ref: `#/components/schemas/${name}` };
}

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const nullableUuid: SchemaObject = { type: ['string', 'null'], format: 'uuid' };
const timestamp: SchemaObject = { type: 'string', format: 'date-time' };
const nullableTimestamp: SchemaObject = {
  type: ['string', 'null'],
  format: 'date-time',
};
const nullableString: SchemaObject = { type: ['string', 'null'] };

// ------------------------------------------------------------------
// Sobre de error
// ------------------------------------------------------------------

/**
 * Los códigos de `ApiErrorCode` (`src/lib/api/v1/respond.ts`) MÁS los
 * de dominio que `fail()` puede emitir con una cadena libre. El enum
 * no se cierra con `enum:` en el esquema del sobre porque el contrato
 * permite códigos nuevos; se publica como lista documentada aparte
 * (`ApiErrorCode`) para que un cliente sepa contra qué ramificar.
 */
export const API_ERROR_CODES = [
  'unauthorized',
  'forbidden',
  'rate_limited',
  'bad_request',
  'not_found',
  'account_read_only',
  'feature_unavailable',
  'quota_exceeded',
  'plan_limit_reached',
  'conflict',
  'idempotency_mismatch',
  'payload_too_large',
  'unsupported_media_type',
  'internal',
] as const;

/** Códigos de dominio fuera de `ApiErrorCode`, con su significado. */
export const DOMAIN_ERROR_CODES = [
  'whatsapp_not_configured',
  'meta_error',
  'template_malformed',
] as const;

// ------------------------------------------------------------------
// Recursos
// ------------------------------------------------------------------

const tagSchema: SchemaObject = {
  title: 'Tag',
  description: 'Una etiqueta de la cuenta.',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'color', 'created_at'],
  properties: {
    id: uuid,
    name: { type: 'string', description: 'Nombre, 1–64 caracteres.' },
    color: {
      type: 'string',
      description: 'Color hexadecimal en minúsculas (`#rrggbb`).',
    },
    created_at: timestamp,
  },
};

/** La etiqueta tal como va embebida en un contacto (sin `created_at`). */
const embeddedTagSchema: SchemaObject = {
  title: 'EmbeddedTag',
  type: 'object',
  additionalProperties: false,
  required: ['id', 'name', 'color'],
  properties: { id: uuid, name: { type: 'string' }, color: { type: 'string' } },
};

const contactSchema: SchemaObject = {
  title: 'Contact',
  description:
    'Un contacto. `phone` es null cuando la persona solo se identifica por su nombre de usuario de WhatsApp; entonces `wa_user_id` lleva el BSUID con el que se le puede escribir.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'phone',
    'name',
    'wa_username',
    'wa_user_id',
    'email',
    'company',
    'avatar_url',
    'tags',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: uuid,
    phone: {
      type: ['string', 'null'],
      description: 'Número en E.164, o null si solo hay BSUID.',
    },
    name: nullableString,
    wa_username: {
      type: ['string', 'null'],
      description: 'Nombre de usuario de WhatsApp, sin la `@`.',
    },
    wa_user_id: {
      type: ['string', 'null'],
      description: 'BSUID (`CC.<alfanuméricos>`), el valor de `to_user_id`.',
    },
    email: nullableString,
    company: nullableString,
    avatar_url: nullableString,
    tags: { type: 'array', items: ref('EmbeddedTag') },
    created_at: timestamp,
    updated_at: timestamp,
  },
};

const conversationContactSchema: SchemaObject = {
  title: 'ConversationContact',
  type: ['object', 'null'],
  additionalProperties: false,
  required: ['id', 'phone', 'name', 'email', 'company', 'tags'],
  properties: {
    id: uuid,
    phone: nullableString,
    name: nullableString,
    email: nullableString,
    company: nullableString,
    tags: { type: 'array', items: ref('EmbeddedTag') },
  },
};

const conversationSchema: SchemaObject = {
  title: 'Conversation',
  description: 'Un hilo con un contacto, con el contacto embebido.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'contact_id',
    'status',
    'assigned_agent_id',
    'last_message_text',
    'last_message_at',
    'unread_count',
    'created_at',
    'updated_at',
    'contact',
  ],
  properties: {
    id: uuid,
    contact_id: uuid,
    status: { type: 'string', enum: ['open', 'pending', 'closed'] },
    assigned_agent_id: nullableUuid,
    last_message_text: nullableString,
    last_message_at: nullableTimestamp,
    unread_count: { type: 'integer', minimum: 0 },
    created_at: timestamp,
    updated_at: timestamp,
    contact: ref('ConversationContact'),
  },
};

const messageSchema: SchemaObject = {
  title: 'Message',
  description: 'Un mensaje de una conversación.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'conversation_id',
    'direction',
    'sender_type',
    'content_type',
    'content_text',
    'media_url',
    'template_name',
    'whatsapp_message_id',
    'status',
    'reply_to_message_id',
    'interactive_reply_id',
    'created_at',
  ],
  properties: {
    id: uuid,
    conversation_id: uuid,
    direction: { type: 'string', enum: ['inbound', 'outbound'] },
    sender_type: { type: 'string' },
    content_type: { type: 'string' },
    content_text: nullableString,
    media_url: nullableString,
    template_name: nullableString,
    whatsapp_message_id: nullableString,
    status: { type: 'string' },
    reply_to_message_id: nullableUuid,
    interactive_reply_id: nullableString,
    created_at: timestamp,
  },
};

const broadcastSchema: SchemaObject = {
  title: 'Broadcast',
  description: 'Estado y contadores de una campaña.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'template_name',
    'template_language',
    'status',
    'total_recipients',
    'sent_count',
    'delivered_count',
    'read_count',
    'replied_count',
    'failed_count',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: uuid,
    name: { type: 'string' },
    template_name: nullableString,
    template_language: nullableString,
    status: { type: 'string', description: 'Avanza de `sending` a `sent`.' },
    total_recipients: { type: 'integer', minimum: 0 },
    sent_count: { type: 'integer', minimum: 0 },
    delivered_count: { type: 'integer', minimum: 0 },
    read_count: { type: 'integer', minimum: 0 },
    replied_count: { type: 'integer', minimum: 0 },
    failed_count: { type: 'integer', minimum: 0 },
    created_at: timestamp,
    updated_at: nullableTimestamp,
  },
};

export const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
] as const;

export const TEMPLATE_CATEGORIES = [
  'Marketing',
  'Utility',
  'Authentication',
] as const;

const templateButtonSchema: SchemaObject = {
  title: 'TemplateButton',
  type: 'object',
  required: ['type', 'text'],
  properties: {
    type: {
      type: 'string',
      enum: ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'],
    },
    text: { type: 'string' },
    url: { type: 'string' },
    phone_number: { type: 'string' },
  },
};

const templateSchema: SchemaObject = {
  title: 'Template',
  description:
    'Una plantilla de mensaje. `status` es el enum de Meta, guardado tal cual.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'name',
    'language',
    'category',
    'status',
    'meta_template_id',
    'quality_score',
    'rejection_reason',
    'submission_error',
    'components',
    'variables',
    'sample_values',
    'last_submitted_at',
    'created_at',
    'updated_at',
  ],
  properties: {
    id: uuid,
    name: { type: 'string' },
    language: nullableString,
    category: { type: ['string', 'null'] },
    status: { type: ['string', 'null'], enum: [...TEMPLATE_STATUSES, null] },
    meta_template_id: nullableString,
    quality_score: nullableString,
    rejection_reason: nullableString,
    submission_error: nullableString,
    components: {
      type: 'object',
      additionalProperties: false,
      required: ['header', 'body', 'footer', 'buttons'],
      properties: {
        header: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['format', 'text', 'media_url'],
          properties: {
            format: {
              type: 'string',
              enum: ['text', 'image', 'video', 'document'],
            },
            text: nullableString,
            media_url: nullableString,
          },
        },
        body: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        footer: {
          type: ['object', 'null'],
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        buttons: { type: 'array', items: ref('TemplateButton') },
      },
    },
    variables: { type: 'array', items: ref('TemplateVariable') },
    sample_values: {
      type: ['object', 'null'],
      description:
        'Valores de ejemplo con los que se aprobó, por componente (`body`).',
      properties: { body: { type: 'array', items: { type: 'string' } } },
    },
    last_submitted_at: nullableTimestamp,
    created_at: timestamp,
    updated_at: nullableTimestamp,
  },
};

const templateVariableSchema: SchemaObject = {
  title: 'TemplateVariable',
  description:
    'Una variable del cuerpo. El orden del array es el orden de `params` al enviar.',
  type: 'object',
  additionalProperties: false,
  required: ['index', 'placeholder', 'example'],
  properties: {
    index: { type: 'integer', minimum: 1 },
    placeholder: { type: 'string', description: 'El literal `{{n}}`.' },
    example: nullableString,
  },
};

export const EXPORT_JOB_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
] as const;

const exportJobSchema: SchemaObject = {
  title: 'ExportJob',
  description:
    'Un trabajo de exportación. `download_url` solo viene de `GET /exports/{id}` y solo con `status: done`.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'kind',
    'format',
    'status',
    'filters',
    'row_count',
    'error',
    'created_at',
    'finished_at',
    'expires_at',
  ],
  properties: {
    id: uuid,
    kind: { type: 'string', enum: ['conversations'] },
    format: { type: 'string', enum: ['json', 'csv'] },
    status: { type: 'string', enum: [...EXPORT_JOB_STATUSES] },
    filters: {
      type: 'object',
      description: 'Los filtros aceptados, ya normalizados.',
      additionalProperties: { type: 'string' },
    },
    row_count: { type: ['integer', 'null'], minimum: 0 },
    error: nullableString,
    created_at: timestamp,
    finished_at: nullableTimestamp,
    expires_at: timestamp,
  },
};

const webhookEndpointSchema: SchemaObject = {
  title: 'WebhookEndpoint',
  description:
    'Un receptor registrado. El secreto NO sale aquí: solo al crear y al rotar.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'url',
    'events',
    'is_active',
    'last_delivery_at',
    'failure_count',
    'created_at',
  ],
  properties: {
    id: uuid,
    url: { type: 'string', format: 'uri' },
    events: { type: 'array', items: ref('WebhookEventName') },
    is_active: { type: 'boolean' },
    last_delivery_at: nullableTimestamp,
    failure_count: { type: 'integer', minimum: 0 },
    created_at: timestamp,
  },
};

const webhookDeliverySchema: SchemaObject = {
  title: 'WebhookDelivery',
  description:
    'Una entrega de la cola. `payload` nunca sale: puede llevar el texto de un cliente final.',
  type: 'object',
  additionalProperties: false,
  required: [
    'id',
    'endpoint_id',
    'event',
    'attempt',
    'status',
    'next_attempt_at',
    'last_status_code',
    'last_error',
    'created_at',
    'delivered_at',
  ],
  properties: {
    id: uuid,
    endpoint_id: uuid,
    event: { type: 'string' },
    attempt: { type: 'integer', minimum: 0 },
    status: {
      type: 'string',
      enum: ['pending', 'delivered', 'failed', 'dead'],
    },
    next_attempt_at: nullableTimestamp,
    last_status_code: { type: ['integer', 'null'] },
    last_error: nullableString,
    created_at: timestamp,
    delivered_at: nullableTimestamp,
  },
};

// ------------------------------------------------------------------
// Catálogo
// ------------------------------------------------------------------

/**
 * Extiende un esquema de objeto CERRADO con propiedades nuevas.
 *
 * No se usa `allOf` para esto a propósito: `allOf: [<cerrado>, {…}]`
 * es inválido en JSON Schema —cada rama se evalúa por separado, así
 * que la propiedad añadida viola el `additionalProperties: false` de
 * la base— y ningún validador lo daría por bueno. Fusionar produce un
 * esquema que dice de verdad lo que sale por el cable.
 */
export function extendSchema(
  base: SchemaObject,
  extra: {
    title: string;
    description?: string;
    properties: Record<string, SchemaObject>;
    required?: string[];
  }
): SchemaObject {
  return {
    ...base,
    title: extra.title,
    description: extra.description ?? base.description,
    properties: { ...(base.properties ?? {}), ...extra.properties },
    required: [...(base.required ?? []), ...(extra.required ?? [])],
  };
}

/**
 * Todo `components.schemas`. El generador lo copia tal cual; las
 * operaciones referencian por nombre con `ref()`.
 */
export const COMPONENT_SCHEMAS: Record<string, SchemaObject> = {
  ApiScope: {
    title: 'ApiScope',
    description: 'Permiso que puede llevar una clave de API.',
    type: 'string',
    enum: [...API_SCOPES],
  },
  ApiErrorCode: {
    title: 'ApiErrorCode',
    description:
      'Códigos estables del sobre de error. Los tres últimos son de dominio y solo aparecen en los envíos y las plantillas.',
    type: 'string',
    enum: [...API_ERROR_CODES, ...DOMAIN_ERROR_CODES],
  },
  Error: {
    title: 'Error',
    description:
      'Sobre de fallo. `code` es estable y es contra lo que se ramifica; `message` es para personas y puede reescribirse.',
    type: 'object',
    required: ['error'],
    properties: {
      error: {
        type: 'object',
        required: ['code', 'message', 'request_id'],
        properties: {
          code: { type: 'string' },
          message: { type: 'string' },
          request_id: {
            type: 'string',
            format: 'uuid',
            description: 'El mismo valor que la cabecera `X-Request-Id`.',
          },
        },
      },
    },
  },
  PaginationMeta: {
    title: 'PaginationMeta',
    type: 'object',
    additionalProperties: false,
    required: ['next_cursor'],
    properties: {
      next_cursor: {
        type: ['string', 'null'],
        description:
          'Cursor opaco para la página siguiente; null en la última.',
      },
    },
  },
  WebhookEventName: {
    title: 'WebhookEventName',
    description: 'Evento al que se puede suscribir un receptor.',
    type: 'string',
    enum: [...WEBHOOK_EVENTS],
  },
  EmbeddedTag: embeddedTagSchema,
  Tag: tagSchema,
  Contact: contactSchema,
  ConversationContact: conversationContactSchema,
  Conversation: conversationSchema,
  Message: messageSchema,
  Broadcast: broadcastSchema,
  TemplateButton: templateButtonSchema,
  TemplateVariable: templateVariableSchema,
  Template: templateSchema,
  ExportJob: exportJobSchema,
  WebhookEndpoint: webhookEndpointSchema,
  WebhookDelivery: webhookDeliverySchema,
  DeletedResource: {
    title: 'DeletedResource',
    type: 'object',
    additionalProperties: false,
    required: ['id', 'deleted'],
    properties: { id: uuid, deleted: { type: 'boolean', const: true } },
  },

  // --- Variantes: la misma forma con un campo que solo sale en una
  // operación concreta. Fusionadas, no `allOf` (ver `extendSchema`).

  WebhookEndpointWithSecret: extendSchema(webhookEndpointSchema, {
    title: 'WebhookEndpointWithSecret',
    description:
      'El receptor con su secreto de firma EN CLARO. Solo sale al crearlo y al rotarlo, una vez cada vez.',
    properties: {
      secret: {
        type: 'string',
        description: 'Guárdalo: aquí solo queda una copia cifrada.',
      },
    },
    required: ['secret'],
  }),

  WebhookDeliveryWithResult: extendSchema(webhookDeliverySchema, {
    title: 'WebhookDeliveryWithResult',
    description:
      'Una entrega más el desenlace del intento que acaba de dispararse.',
    properties: {
      result: {
        type: 'string',
        enum: ['pending', 'delivered', 'failed', 'dead'],
        description: 'Cómo quedó el intento que provocó esta llamada.',
      },
    },
    required: ['result'],
  }),

  ExportJobWithDownload: extendSchema(exportJobSchema, {
    title: 'ExportJobWithDownload',
    description:
      'El trabajo con su enlace de descarga. `download_url` se acuña en CADA llamada, vale 15 minutos y no se guarda en ningún sitio: pídelo cuando lo vayas a usar y no lo caches.',
    properties: {
      download_url: { type: ['string', 'null'] },
      download_expires_at: {
        type: ['string', 'null'],
        format: 'date-time',
      },
    },
    required: ['download_url', 'download_expires_at'],
  }),
};

// Ejemplos reutilizables (los usa más de una operación).

export const EXAMPLE_TAG = {
  id: '5b2b2e9c-0c4a-4f1e-8c5a-3f5b1f6b8d21',
  name: 'vip',
  color: '#3b82f6',
  created_at: '2026-09-01T10:00:00.000Z',
};

export const EXAMPLE_EMBEDDED_TAG = {
  id: EXAMPLE_TAG.id,
  name: EXAMPLE_TAG.name,
  color: EXAMPLE_TAG.color,
};

export const EXAMPLE_CONTACT = {
  id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
  phone: '+14155550123',
  name: 'Jane Doe',
  wa_username: null,
  wa_user_id: null,
  email: null,
  company: 'Acme',
  avatar_url: null,
  tags: [EXAMPLE_EMBEDDED_TAG],
  created_at: '2026-09-01T10:00:00.000Z',
  updated_at: '2026-09-02T08:30:00.000Z',
};

export const EXAMPLE_CONVERSATION = {
  id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
  contact_id: EXAMPLE_CONTACT.id,
  status: 'open',
  assigned_agent_id: null,
  last_message_text: 'Gracias, ya lo recibí',
  last_message_at: '2026-09-02T09:00:00.000Z',
  unread_count: 0,
  created_at: '2026-09-01T10:05:00.000Z',
  updated_at: '2026-09-02T09:00:00.000Z',
  contact: {
    id: EXAMPLE_CONTACT.id,
    phone: EXAMPLE_CONTACT.phone,
    name: EXAMPLE_CONTACT.name,
    email: null,
    company: 'Acme',
    tags: [EXAMPLE_EMBEDDED_TAG],
  },
};

export const EXAMPLE_MESSAGE = {
  id: 'b1c2d3e4-f5a6-4b7c-8d9e-0f1a2b3c4d5e',
  conversation_id: EXAMPLE_CONVERSATION.id,
  direction: 'inbound',
  sender_type: 'contact',
  content_type: 'text',
  content_text: 'Hola 👋',
  media_url: null,
  template_name: null,
  whatsapp_message_id: 'wamid.HBgLMTQxNTU1NTAxMjMVAgARGBI5QTND',
  status: 'delivered',
  reply_to_message_id: null,
  interactive_reply_id: null,
  created_at: '2026-09-02T09:00:00.000Z',
};

export const EXAMPLE_TEMPLATE = {
  id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70',
  name: 'order_update',
  language: 'en_US',
  category: 'Utility',
  status: 'APPROVED',
  meta_template_id: '1234567890',
  quality_score: 'GREEN',
  rejection_reason: null,
  submission_error: null,
  components: {
    header: { format: 'text', text: 'Order {{1}}', media_url: null },
    body: { text: 'Hi {{1}}, your order {{2}} is on its way.' },
    footer: { text: 'Reply STOP to opt out' },
    buttons: [{ type: 'QUICK_REPLY', text: 'Track' }],
  },
  variables: [
    { index: 1, placeholder: '{{1}}', example: 'Ada' },
    { index: 2, placeholder: '{{2}}', example: 'A-123' },
  ],
  sample_values: { body: ['Ada', 'A-123'] },
  last_submitted_at: '2026-09-01T10:00:00.000Z',
  created_at: '2026-08-30T09:00:00.000Z',
  updated_at: '2026-09-01T10:00:00.000Z',
};

export const EXAMPLE_EXPORT_JOB = {
  id: 'a0b1c2d3-e4f5-4061-8273-849506a7b8c9',
  kind: 'conversations',
  format: 'csv',
  status: 'queued',
  filters: { status: 'closed', from: '2026-01-01T00:00:00.000Z' },
  row_count: null,
  error: null,
  created_at: '2026-09-16T11:00:00.000Z',
  finished_at: null,
  expires_at: '2026-09-23T11:00:00.000Z',
};

export const EXAMPLE_WEBHOOK_ENDPOINT = {
  id: 'f1e2d3c4-b5a6-4978-8a9b-0c1d2e3f4a5b',
  url: 'https://example.com/hooks/wacrm',
  events: ['message.received'],
  is_active: true,
  last_delivery_at: null,
  failure_count: 0,
  created_at: '2026-09-16T11:00:00.000Z',
};

export const EXAMPLE_WEBHOOK_DELIVERY = {
  id: '0a1b2c3d-4e5f-4061-8273-8495a6b7c8d9',
  endpoint_id: EXAMPLE_WEBHOOK_ENDPOINT.id,
  event: 'message.received',
  attempt: 1,
  status: 'pending',
  next_attempt_at: '2026-09-16T11:01:00.000Z',
  last_status_code: null,
  last_error: null,
  created_at: '2026-09-16T11:00:00.000Z',
  delivered_at: null,
};
