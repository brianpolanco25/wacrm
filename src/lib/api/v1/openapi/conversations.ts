// ============================================================
// Registro: conversaciones.
//
// Tres operaciones. La tercera —la descarga directa— es la ÚNICA de
// toda la API cuyo cuerpo NO es el sobre `{data}`: es el archivo. Los
// errores sí vuelven en el sobre, así que una llamada fallida se
// parsea como el resto. El registro lo declara con `envelope: 'raw'`
// para que el documento no mienta.
// ============================================================

import {
  CONVERSATION_STATUS_VALUES,
  ERR_BAD_REQUEST,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  pathParam,
  queryParam,
} from './common';
import { EXAMPLE_CONVERSATION, EXAMPLE_MESSAGE, ref } from './schemas';
import type { OperationDef, SchemaObject } from './types';

const CONVERSATION_ID = pathParam('id', 'Id de la conversación.');

/** Una fila de mensaje tal como sale en una exportación (no es `Message`). */
const EXPORT_MESSAGE_SCHEMA: SchemaObject = {
  type: 'object',
  additionalProperties: false,
  required: [
    'conversation_id',
    'id',
    'direction',
    'sender_type',
    'content_type',
    'text',
    'media_url',
    'template_name',
    'status',
    'whatsapp_message_id',
    'created_at',
  ],
  properties: {
    conversation_id: { type: 'string', format: 'uuid' },
    id: { type: 'string', format: 'uuid' },
    direction: { type: 'string', enum: ['inbound', 'outbound'] },
    sender_type: { type: 'string' },
    content_type: { type: 'string' },
    text: { type: ['string', 'null'] },
    media_url: {
      type: ['string', 'null'],
      description:
        'Referencia `storage://<bucket>/<path>` para lo nuestro; la URL original si nunca fue nuestra. Nunca una URL firmada.',
    },
    template_name: { type: ['string', 'null'] },
    status: { type: 'string' },
    whatsapp_message_id: { type: ['string', 'null'] },
    created_at: { type: 'string', format: 'date-time' },
  },
};

export const CONVERSATIONS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/conversations',
    operationId: 'listConversations',
    summary: 'Listar conversaciones',
    description:
      'Las conversaciones de la cuenta, de la más nueva a la más vieja, con su contacto y las etiquetas de este embebidos.',
    tag: 'conversations',
    scopes: ['conversations:read'],
    paginated: true,
    parameters: [
      queryParam('status', 'Filtra por estado.', {
        schema: { type: 'string', enum: [...CONVERSATION_STATUS_VALUES] },
      }),
      queryParam('contact_id', 'Solo las de este contacto.', {
        schema: { type: 'string', format: 'uuid' },
      }),
    ],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de conversaciones.',
        schema: ref('Conversation'),
        example: [EXAMPLE_CONVERSATION],
      },
    ],
    errors: [],
  },
  {
    method: 'get',
    path: '/conversations/{id}',
    operationId: 'getConversation',
    summary: 'Leer una conversación',
    description: 'Una conversación por su id.',
    tag: 'conversations',
    scopes: ['conversations:read'],
    parameters: [CONVERSATION_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La conversación.',
        schema: ref('Conversation'),
        example: EXAMPLE_CONVERSATION,
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'get',
    path: '/conversations/{id}/export',
    operationId: 'exportConversation',
    summary: 'Descargar una conversación entera',
    description:
      'Descarga una conversación con **todos** sus mensajes, en orden cronológico. A diferencia del resto de la API, el cuerpo ES el archivo, no el sobre `{data}` — los errores sí vuelven en el sobre. Por encima de 10 000 mensajes responde `409` y hay que usar `POST /exports`. Los adjuntos salen como referencia `storage://…`, nunca como enlace firmado, y las celdas del CSV que empiezan por `=`, `+`, `-` o `@` llevan una comilla simple delante contra la inyección de fórmulas.',
    tag: 'conversations',
    scopes: ['conversations:export'],
    extraRateLimits: ['exports'],
    parameters: [
      CONVERSATION_ID,
      queryParam('format', 'Formato del archivo. Por defecto `json`.', {
        schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
      }),
    ],
    envelope: 'raw',
    responses: [
      {
        status: 200,
        description:
          'El archivo. `application/json` con los mensajes anidados bajo su conversación, o `text/csv` con una fila por mensaje y `conversation_id` primero.',
        mediaTypes: ['application/json', 'text/csv'],
        headers: {
          'Content-Disposition': {
            description:
              'Siempre `attachment`, con nombre `conversation-<id>.<ext>`.',
            schema: { type: 'string' },
          },
        },
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'generated_at',
            'conversation_count',
            'message_count',
            'conversations',
          ],
          properties: {
            generated_at: { type: 'string', format: 'date-time' },
            conversation_count: { type: 'integer', minimum: 0 },
            message_count: { type: 'integer', minimum: 0 },
            conversations: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['conversation', 'messages'],
                properties: {
                  conversation: ref('Conversation'),
                  messages: { type: 'array', items: EXPORT_MESSAGE_SCHEMA },
                },
              },
            },
          },
        },
        example: {
          generated_at: '2026-09-16T11:00:00.000Z',
          conversation_count: 1,
          message_count: 1,
          conversations: [
            {
              conversation: EXAMPLE_CONVERSATION,
              messages: [
                {
                  conversation_id: EXAMPLE_CONVERSATION.id,
                  id: EXAMPLE_MESSAGE.id,
                  direction: 'inbound',
                  sender_type: 'customer',
                  content_type: 'text',
                  text: 'Hola 👋',
                  media_url: null,
                  template_name: null,
                  status: 'delivered',
                  whatsapp_message_id: EXAMPLE_MESSAGE.whatsapp_message_id,
                  created_at: EXAMPLE_MESSAGE.created_at,
                },
              ],
            },
          ],
        },
      },
    ],
    errors: [
      { ...ERR_BAD_REQUEST, description: "`format` no es 'json' ni 'csv'." },
      ERR_NOT_FOUND,
      {
        ...ERR_CONFLICT,
        description:
          'La conversación pasa de 10 000 mensajes: encárgala con `POST /exports`.',
      },
    ],
  },
];
