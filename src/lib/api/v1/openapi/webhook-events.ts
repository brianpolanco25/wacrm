// ============================================================
// Sección `webhooks` del documento OpenAPI 3.1.
//
// En 3.1 `webhooks` describe las peticiones que el servidor HACE al
// cliente: una entrada por evento, cada una con el sobre de entrega y
// las cabeceras `X-Wacrm-*`. No es lo mismo que `/api/v1/webhooks`,
// que es el CRUD de receptores (ver `webhooks.ts`).
//
// El mapa de `data` está tipado como `Record<WebhookEvent, …>`, así
// que **añadir un evento a `src/lib/webhooks/events.ts` sin describir
// su `data` aquí no compila**. Es la misma disciplina que el test de
// cobertura de rutas, aplicada al vocabulario de eventos.
// ============================================================

import {
  WEBHOOK_EVENTS,
  WEBHOOK_EVENT_DESCRIPTIONS,
  type WebhookEvent,
} from '@/lib/webhooks/events';
import type {
  HeaderObject,
  OperationObject,
  ParameterObject,
  PathItemObject,
  SchemaObject,
} from './types';

const uuid: SchemaObject = { type: 'string', format: 'uuid' };
const nullableString: SchemaObject = { type: ['string', 'null'] };

/** Cabeceras que lleva toda entrega. */
export const WEBHOOK_DELIVERY_HEADERS: Record<string, HeaderObject> = {
  'X-Wacrm-Event': {
    description:
      'Nombre del evento. `ping` solo viaja desde `POST /webhooks/{id}/test`.',
    required: true,
    schema: { type: 'string' },
  },
  'X-Wacrm-Webhook-Id': {
    description: 'Id del receptor al que va dirigida.',
    required: true,
    schema: uuid,
  },
  'X-Wacrm-Delivery-Id': {
    description:
      'Id de la entrega. Estable entre reintentos: es contra lo que se deduplica.',
    required: true,
    schema: uuid,
  },
  'X-Wacrm-Attempt': {
    description: 'Número de intento; `1` en el primero.',
    required: true,
    schema: { type: 'string' },
  },
  'X-Wacrm-Signature': {
    description:
      'Firma: `t=<segundos unix>,v1=<hex>` donde `v1 = HMAC-SHA256(secret, "${t}.${rawBody}")`. Recalcúlala sobre el cuerpo CRUDO, compara en tiempo constante y rechaza una `t` de hace más de unos minutos.',
    required: true,
    schema: { type: 'string' },
  },
};

/** Las mismas cabeceras, como parámetros de la petición entrante. */
const DELIVERY_HEADER_PARAMS: ParameterObject[] = Object.entries(
  WEBHOOK_DELIVERY_HEADERS
).map(([name, header]) => ({
  name,
  in: 'header' as const,
  description: header.description,
  required: true,
  schema: header.schema,
}));

// ------------------------------------------------------------------
// `data` por evento
// ------------------------------------------------------------------

function dataObject(
  properties: Record<string, SchemaObject>,
  description: string
): SchemaObject {
  return {
    type: 'object',
    description,
    additionalProperties: false,
    required: Object.keys(properties),
    properties,
  };
}

const conversationAndContact = {
  conversation_id: uuid,
  contact_id: uuid,
};

/**
 * Un esquema por evento. El tipo `Record<WebhookEvent, …>` es la
 * guarda: un evento nuevo sin entrada aquí rompe el typecheck.
 */
export const WEBHOOK_EVENT_DATA_SCHEMAS: Record<WebhookEvent, SchemaObject> = {
  'message.received': dataObject(
    {
      conversation_id: uuid,
      contact_id: uuid,
      whatsapp_message_id: { type: 'string' },
      content_type: { type: 'string' },
      text: nullableString,
    },
    'Un mensaje entrante de un contacto.'
  ),
  'message.status_updated': dataObject(
    {
      whatsapp_message_id: { type: 'string' },
      conversation_id: uuid,
      status: {
        type: 'string',
        description: 'sent / delivered / read / failed.',
      },
    },
    'Un mensaje que enviaste cambió de estado de entrega. Cubre los mensajes que el CRM guarda (bandeja y envíos por API), no los de difusión, y los proveedores reenvían y reordenan sus avisos.'
  ),
  'conversation.created': dataObject(
    conversationAndContact,
    'Se abrió una conversación nueva para un contacto.'
  ),
  'conversation.closed': dataObject(
    conversationAndContact,
    'Se cerró una conversación (panel o automatización).'
  ),
  'conversation.assigned': dataObject(
    {
      ...conversationAndContact,
      assigned_agent_id: {
        type: ['string', 'null'],
        format: 'uuid',
        description: 'null cuando queda sin asignar.',
      },
    },
    'Una conversación cambió de manos.'
  ),
  'contact.created': dataObject(
    {
      contact_id: uuid,
      phone: nullableString,
      wa_user_id: nullableString,
      name: nullableString,
    },
    'Se creó un contacto (API, panel o un WhatsApp entrante).'
  ),
  'contact.updated': dataObject(
    {
      contact_id: uuid,
      phone: nullableString,
      wa_user_id: nullableString,
      name: nullableString,
      fields: {
        type: 'array',
        items: { type: 'string' },
        description: 'Los campos que cambiaron.',
      },
    },
    'Cambiaron los campos de un contacto.'
  ),
  'contact.tag_added': dataObject(
    { contact_id: uuid, tag_id: uuid },
    'Se le puso una etiqueta a un contacto.'
  ),
  'contact.tag_removed': dataObject(
    { contact_id: uuid, tag_id: uuid },
    'Se le quitó una etiqueta a un contacto. Solo viaja cuando la etiqueta estaba puesta de verdad.'
  ),
  'template.status_updated': dataObject(
    {
      template_id: uuid,
      name: { type: 'string' },
      language: { type: 'string' },
      status: { type: 'string' },
      previous_status: nullableString,
    },
    'Meta movió el estado de revisión de una plantilla (lo destapa la sincronización).'
  ),
  'broadcast.completed': dataObject(
    {
      broadcast_id: uuid,
      status: { type: 'string' },
      total: { type: 'integer', minimum: 0 },
      sent: { type: 'integer', minimum: 0 },
      failed: { type: 'integer', minimum: 0 },
    },
    'Una campaña terminó de repartirse.'
  ),
};

/** Ejemplos de `data`, uno por evento, para el sobre de cada entrada. */
export const WEBHOOK_EVENT_DATA_EXAMPLES: Record<WebhookEvent, unknown> = {
  'message.received': {
    conversation_id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    whatsapp_message_id: 'wamid.HBgLMTQxNTU1NTAxMjMVAgARGBI5QTND',
    content_type: 'text',
    text: 'Hola 👋',
  },
  'message.status_updated': {
    whatsapp_message_id: 'wamid.HBgLMTQxNTU1NTAxMjMVAgARGBI5QTND',
    conversation_id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
    status: 'delivered',
  },
  'conversation.created': {
    conversation_id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
  },
  'conversation.closed': {
    conversation_id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
  },
  'conversation.assigned': {
    conversation_id: '7f9d1a2b-3c4d-4e5f-8091-a2b3c4d5e6f7',
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    assigned_agent_id: '6b5a4c3d-2e1f-4a09-8b7c-6d5e4f3a2b1c',
  },
  'contact.created': {
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    phone: '14155550123',
    wa_user_id: null,
    name: 'Jane Doe',
  },
  'contact.updated': {
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    phone: '14155550123',
    wa_user_id: null,
    name: 'Jane Doe',
    fields: ['name'],
  },
  'contact.tag_added': {
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    tag_id: '5b2b2e9c-0c4a-4f1e-8c5a-3f5b1f6b8d21',
  },
  'contact.tag_removed': {
    contact_id: '2c8a4a9e-1f3b-4c2d-9a10-6b7c8d9e0f11',
    tag_id: '5b2b2e9c-0c4a-4f1e-8c5a-3f5b1f6b8d21',
  },
  'template.status_updated': {
    template_id: 'd4e5f6a7-b8c9-4d0e-9f1a-2b3c4d5e6f70',
    name: 'order_update',
    language: 'en_US',
    status: 'APPROVED',
    previous_status: 'PENDING',
  },
  'broadcast.completed': {
    broadcast_id: '3d4e5f60-7182-4930-a4b5-c6d7e8f90a1b',
    status: 'sent',
    total: 1000,
    sent: 987,
    failed: 13,
  },
};

/** El sobre de una entrega, con el `data` del evento incrustado. */
function deliveryEnvelope(event: WebhookEvent): SchemaObject {
  return {
    type: 'object',
    additionalProperties: false,
    required: ['id', 'event', 'occurred_at', 'account_id', 'data'],
    properties: {
      id: {
        ...uuid,
        description:
          'Id único de la entrega, estable entre reintentos: deduplica por aquí.',
      },
      event: { type: 'string', const: event },
      occurred_at: {
        type: 'string',
        format: 'date-time',
        description:
          'Cuándo pasó. Es la autoridad: el orden de llegada NO lo es.',
      },
      account_id: uuid,
      data: WEBHOOK_EVENT_DATA_SCHEMAS[event],
    },
  };
}

/**
 * La sección `webhooks` entera: una entrada por evento, cada una un
 * `post` al receptor del cliente.
 */
export function buildWebhookEntries(): Record<string, PathItemObject> {
  const entries: Record<string, PathItemObject> = {};
  for (const event of WEBHOOK_EVENTS) {
    const operation: OperationObject = {
      operationId: `on${event
        .split(/[.\-_]/)
        .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
        .join('')}`,
      summary: WEBHOOK_EVENT_DESCRIPTIONS[event],
      description:
        'Entrega **al menos una vez** y duradera: el evento se persiste en una cola antes del primer intento. Un intento fallido se reintenta cinco veces más —al minuto, a los 5 min, a los 30 min, a las 2 h y a las 12 h— y luego queda `dead` en el registro. Cualquier cosa que no sea un `2xx` (incluido un `3xx`) cuenta como fallo, y los redirects no se siguen. Tras 15 fallos seguidos el receptor se autodesactiva.',
      tags: ['webhook-events'],
      parameters: DELIVERY_HEADER_PARAMS,
      requestBody: {
        required: true,
        content: {
          'application/json': {
            schema: deliveryEnvelope(event),
            example: {
              id: '8f3c1d2e-4b5a-4c6d-8e9f-0a1b2c3d4e5f',
              event,
              occurred_at: '2026-09-16T11:00:00.000Z',
              account_id: '9f8e7d6c-5b4a-4938-8271-605f4e3d2c1b',
              data: WEBHOOK_EVENT_DATA_EXAMPLES[event],
            },
          },
        },
      },
      responses: {
        '2XX': {
          description:
            'Cualquier 2xx se toma por aceptado. Responde rápido y haz el trabajo después.',
        },
      },
      // La entrega la firma el secreto del receptor, no una clave de
      // API: aquí no rige el esquema de seguridad del documento.
      security: [],
      'x-scopes': [],
      'x-rate-limits': [],
    };
    entries[event] = { post: operation };
  }
  return entries;
}
