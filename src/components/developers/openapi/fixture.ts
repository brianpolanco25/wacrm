import type {
  JsonValue,
  MaybeRef,
  OpenApiDocument,
  OperationObject,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from './types';

// ============================================================
// Documento OpenAPI 3.1 de prueba.
//
// Describe las 37 operaciones que `progress/impl_integracion-api-3.md`
// §6 inventaría en `/api/v1`, con sus scopes, sus cubos y qué escrituras
// aceptan `Idempotency-Key`. Es lo que sirve `source.ts` mientras a7.6
// (el generador real) no está fusionado, y es lo que los tests usan para
// afirmar que el renderizador pinta TODAS las operaciones de un
// documento, sea cual sea.
//
// No se escribe a mano cada operación entera: los ayudantes de abajo
// montan el sobre `{data}`, la paginación y los errores comunes, que en
// esta API son iguales en todas partes.
// ============================================================

const ref = (name: string): SchemaObject =>
  ({ $ref: `#/components/schemas/${name}` }) as SchemaObject;

const json = (schema: SchemaObject, example?: JsonValue) => ({
  'application/json': example === undefined ? { schema } : { schema, example },
});

/** Sobre de éxito de un recurso: `{ "data": … }`. */
const envelope = (schema: SchemaObject): SchemaObject => ({
  type: 'object',
  properties: { data: schema },
  required: ['data'],
});

/** Sobre de lista con cursor: `{ "data": [...], "meta": { … } }`. */
const listEnvelope = (item: SchemaObject): SchemaObject => ({
  type: 'object',
  properties: {
    data: { type: 'array', items: item },
    meta: {
      type: 'object',
      properties: {
        next_cursor: {
          type: ['string', 'null'],
          description: 'Cursor de la página siguiente; null en la última.',
        },
      },
      required: ['next_cursor'],
    },
  },
  required: ['data', 'meta'],
});

const errorResponse = (description: string): ResponseObject => ({
  description,
  content: json(ref('Error')),
});

/** Los tres errores que puede devolver cualquier operación. */
const COMMON_ERRORS: Record<string, ResponseObject> = {
  '401': errorResponse('Clave ausente, desconocida, revocada o caducada.'),
  '403': errorResponse('La clave no lleva el scope que la ruta exige.'),
  '429': errorResponse('Cupo agotado. Reintenta pasado `Retry-After`.'),
};

const pathId = (name: string, description: string): ParameterObject => ({
  name,
  in: 'path',
  required: true,
  description,
  schema: { type: 'string', format: 'uuid' },
});

const PAGINATION: ParameterObject[] = [
  {
    name: 'limit',
    in: 'query',
    description: 'Tamaño de página, de 1 a 100.',
    schema: { type: 'integer', default: 50, minimum: 1, maximum: 100 },
  },
  {
    name: 'cursor',
    in: 'query',
    description: 'Cursor opaco devuelto en `meta.next_cursor`.',
    schema: { type: 'string' },
  },
];

interface OpConfig {
  summary: string;
  description?: string;
  tags: string[];
  scopes: string[];
  idempotent?: boolean;
  parameters?: MaybeRef<ParameterObject>[];
  requestBody?: OperationObject['requestBody'];
  responses: Record<string, ResponseObject>;
}

function op({
  summary,
  description,
  tags,
  scopes,
  idempotent,
  parameters,
  requestBody,
  responses,
}: OpConfig): OperationObject {
  return {
    summary,
    description,
    tags,
    security: [{ bearerAuth: scopes }],
    'x-scopes': scopes,
    ...(idempotent ? { 'x-idempotent': true } : {}),
    ...(parameters ? { parameters } : {}),
    ...(requestBody ? { requestBody } : {}),
    responses: { ...responses, ...COMMON_ERRORS },
  };
}

const body = (
  schema: SchemaObject,
  example: JsonValue,
  description?: string
): OperationObject['requestBody'] => ({
  required: true,
  description,
  content: json(schema, example),
});

// ------------------------------------------------------------
// Esquemas
// ------------------------------------------------------------

const SCHEMAS: Record<string, SchemaObject> = {
  Error: {
    type: 'object',
    description: 'Sobre de error de toda la API.',
    properties: {
      error: {
        type: 'object',
        properties: {
          code: {
            type: 'string',
            description: 'Código estable. Ramifica por aquí.',
          },
          message: {
            type: 'string',
            description: 'Frase para una persona; puede reescribirse.',
          },
          request_id: {
            type: 'string',
            description: 'El mismo valor que la cabecera `X-Request-Id`.',
          },
        },
        required: ['code', 'message', 'request_id'],
      },
    },
    required: ['error'],
  },
  Tag: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: {
        type: 'string',
        description: 'Único por cuenta, sin distinguir mayúsculas.',
      },
      color: { type: 'string', description: 'Hexadecimal, `#rrggbb`.' },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'name', 'color', 'created_at'],
  },
  Contact: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      phone: {
        type: ['string', 'null'],
        description:
          'E.164. Null si el contacto solo escribió con nombre de usuario.',
      },
      name: { type: ['string', 'null'] },
      wa_username: {
        type: ['string', 'null'],
        description: 'Nombre de usuario de WhatsApp, sin la arroba.',
      },
      wa_user_id: {
        type: ['string', 'null'],
        description:
          'BSUID (`CC.<alfanuméricos>`); es lo que se pasa como `to_user_id`.',
      },
      email: { type: ['string', 'null'] },
      company: { type: ['string', 'null'] },
      avatar_url: { type: ['string', 'null'] },
      tags: { type: 'array', items: ref('Tag') },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'phone', 'name', 'tags', 'created_at', 'updated_at'],
  },
  Conversation: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['open', 'pending', 'closed'] },
      contact: ref('Contact'),
      assigned_agent_id: { type: ['string', 'null'] },
      last_message_at: { type: ['string', 'null'], format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'status', 'contact', 'created_at'],
  },
  Message: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      conversation_id: { type: 'string', format: 'uuid' },
      direction: { type: 'string', enum: ['inbound', 'outbound'] },
      sender_type: {
        type: 'string',
        enum: ['contact', 'agent', 'ai', 'system'],
      },
      content_type: {
        type: 'string',
        enum: ['text', 'image', 'video', 'audio', 'document', 'template'],
      },
      text: { type: ['string', 'null'] },
      media_url: {
        type: ['string', 'null'],
        description: 'Referencia `storage://` cuando el medio es privado.',
      },
      template_name: { type: ['string', 'null'] },
      status: {
        type: ['string', 'null'],
        enum: ['sent', 'delivered', 'read', 'failed', null],
      },
      whatsapp_message_id: { type: ['string', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: [
      'id',
      'conversation_id',
      'direction',
      'content_type',
      'created_at',
    ],
  },
  TemplateVariable: {
    type: 'object',
    properties: {
      index: { type: 'integer' },
      placeholder: {
        type: 'string',
        description: 'El literal `{{n}}` tal y como aparece en el cuerpo.',
      },
      example: {
        type: ['string', 'null'],
        description: 'Valor con el que se aprobó; nunca se envía solo.',
      },
    },
    required: ['index', 'placeholder'],
  },
  Template: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      name: { type: 'string' },
      language: {
        type: 'string',
        description: 'Código de idioma de Meta (`es_ES`, `en_US`).',
      },
      category: {
        type: 'string',
        enum: ['Marketing', 'Utility', 'Authentication'],
      },
      status: {
        type: 'string',
        enum: [
          'DRAFT',
          'PENDING',
          'APPROVED',
          'REJECTED',
          'PAUSED',
          'DISABLED',
          'IN_APPEAL',
          'PENDING_DELETION',
        ],
      },
      meta_template_id: { type: ['string', 'null'] },
      quality_score: { type: ['string', 'null'] },
      rejection_reason: { type: ['string', 'null'] },
      components: {
        type: 'object',
        description:
          'Cabecera, cuerpo, pie y botones tal y como los guarda Meta.',
      },
      variables: { type: 'array', items: ref('TemplateVariable') },
      created_at: { type: 'string', format: 'date-time' },
      updated_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'name', 'language', 'category', 'status', 'variables'],
  },
  ExportJob: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      kind: { type: 'string', enum: ['conversations'] },
      format: { type: 'string', enum: ['json', 'csv'] },
      status: { type: 'string', enum: ['queued', 'running', 'done', 'failed'] },
      filters: {
        type: 'object',
        description: 'Los filtros con los que se encargó, ya normalizados.',
      },
      row_count: { type: ['integer', 'null'] },
      error: { type: ['string', 'null'] },
      download_url: {
        type: ['string', 'null'],
        description: 'Se acuña en cada GET y vale 15 minutos. No se guarda.',
      },
      download_expires_at: { type: ['string', 'null'], format: 'date-time' },
      created_at: { type: 'string', format: 'date-time' },
      finished_at: { type: ['string', 'null'], format: 'date-time' },
      expires_at: {
        type: 'string',
        format: 'date-time',
        description: 'El archivo y esta fila se borran aquí (7 días).',
      },
    },
    required: ['id', 'kind', 'format', 'status', 'created_at', 'expires_at'],
  },
  WebhookEndpoint: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      url: {
        type: 'string',
        description: 'Siempre `https://` y a una dirección pública.',
      },
      events: { type: 'array', items: { type: 'string' } },
      is_active: { type: 'boolean' },
      failure_count: { type: 'integer' },
      secret: {
        type: ['string', 'null'],
        description: 'Solo al crear o al rotar; nunca al leer.',
      },
      created_at: { type: 'string', format: 'date-time' },
    },
    required: ['id', 'url', 'events', 'is_active', 'created_at'],
  },
  WebhookDelivery: {
    type: 'object',
    properties: {
      id: { type: 'string', format: 'uuid' },
      event: { type: 'string' },
      status: {
        type: 'string',
        enum: ['pending', 'delivered', 'failed', 'dead'],
      },
      attempt: { type: 'integer' },
      next_attempt_at: { type: ['string', 'null'], format: 'date-time' },
      last_status_code: { type: ['integer', 'null'] },
      last_error: { type: ['string', 'null'] },
      created_at: { type: 'string', format: 'date-time' },
      delivered_at: { type: ['string', 'null'], format: 'date-time' },
    },
    required: ['id', 'event', 'status', 'attempt', 'created_at'],
  },
  Broadcast: {
    type: 'object',
    properties: {
      broadcast_id: { type: 'string', format: 'uuid' },
      status: { type: 'string', enum: ['sending', 'sent', 'failed'] },
      total_recipients: { type: 'integer' },
      sent_count: { type: 'integer' },
      delivered_count: { type: 'integer' },
      read_count: { type: 'integer' },
      failed_count: { type: 'integer' },
    },
    required: ['broadcast_id', 'status', 'total_recipients'],
  },
  WebhookEventEnvelope: {
    type: 'object',
    description: 'Lo que llega a tu servidor en cada entrega.',
    properties: {
      id: {
        type: 'string',
        format: 'uuid',
        description:
          'Único por entrega y estable entre reintentos: descarta por aquí.',
      },
      event: { type: 'string' },
      occurred_at: { type: 'string', format: 'date-time' },
      account_id: { type: 'string', format: 'uuid' },
      data: { type: 'object' },
    },
    required: ['id', 'event', 'occurred_at', 'account_id', 'data'],
  },
};

// ------------------------------------------------------------
// Documento
// ------------------------------------------------------------

export const OPENAPI_FIXTURE: OpenApiDocument = {
  openapi: '3.1.0',
  info: {
    title: 'Cabbity CRM — API pública',
    version: '1.2.0',
    description:
      'Contrato de `/api/v1`. Todas las rutas se autentican con una clave de API y responden el mismo sobre.',
  },
  servers: [
    { url: 'https://tu-dominio.example.com', description: 'Tu instancia' },
  ],
  security: [{ bearerAuth: [] }],
  tags: [
    {
      name: 'Cuenta',
      description: 'Comprobar la clave y a qué cuenta pertenece.',
    },
    {
      name: 'Mensajes',
      description: 'Enviar mensajes y leer los de una conversación.',
    },
    {
      name: 'Contactos',
      description: 'Alta, lectura y actualización de contactos.',
    },
    {
      name: 'Etiquetas',
      description: 'Etiquetas de la cuenta y su asignación a contactos.',
    },
    {
      name: 'Conversaciones',
      description: 'Listar, leer y exportar conversaciones.',
    },
    {
      name: 'Plantillas',
      description: 'Plantillas de WhatsApp y su sincronización con Meta.',
    },
    {
      name: 'Difusiones',
      description: 'Campañas por plantilla a muchos destinatarios.',
    },
    {
      name: 'Exportaciones',
      description: 'Encargos de exportación y sus archivos.',
    },
    {
      name: 'Webhooks',
      description: 'Destinos salientes, entregas y secretos de firma.',
    },
  ],
  paths: {
    '/api/v1/me': {
      get: op({
        summary: 'Comprobar la clave',
        description:
          'La única operación sin scope: autentica y devuelve la cuenta y los permisos de la clave. Úsala para verificar una credencial recién creada.',
        tags: ['Cuenta'],
        scopes: [],
        responses: {
          '200': {
            description: 'La cuenta y los scopes de la clave.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  account: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      name: { type: 'string' },
                    },
                    required: ['id', 'name'],
                  },
                  key: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      scopes: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['id', 'scopes'],
                  },
                },
                required: ['account', 'key'],
              }),
              {
                data: {
                  account: { id: '9f1c…', name: 'Acme S.L.' },
                  key: {
                    id: '3a20…',
                    scopes: ['messages:send', 'contacts:read'],
                  },
                },
              }
            ),
          },
        },
      }),
    },
    '/api/v1/messages': {
      post: op({
        summary: 'Enviar un mensaje',
        description:
          'Texto, plantilla o multimedia. El contacto y la conversación se buscan o se crean a partir de `to` (E.164) o de `to_user_id` (BSUID). Con varios números conectados, `from` elige el `phone_number_id` de salida.',
        tags: ['Mensajes'],
        scopes: ['messages:send'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              to: {
                type: 'string',
                description: 'Número en E.164. Uno de `to` o `to_user_id`.',
              },
              to_user_id: {
                type: 'string',
                description: 'BSUID del contacto (`CC.<alfanuméricos>`).',
              },
              type: {
                type: 'string',
                enum: [
                  'text',
                  'template',
                  'image',
                  'video',
                  'document',
                  'audio',
                ],
                default: 'text',
              },
              text: {
                type: 'string',
                description: 'Texto del mensaje o pie del multimedia.',
              },
              media_url: { type: 'string' },
              filename: { type: 'string' },
              from: {
                type: 'string',
                description: '`phone_number_id` de uno de TUS números.',
              },
              reply_to_message_id: { type: 'string', format: 'uuid' },
              template: {
                type: 'object',
                properties: {
                  name: { type: 'string' },
                  language: { type: 'string' },
                  params: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Variables del cuerpo, en orden.',
                  },
                },
                required: ['name', 'language'],
              },
            },
          },
          {
            to: '+34600111222',
            type: 'template',
            template: {
              name: 'aviso_pedido',
              language: 'es_ES',
              params: ['Ada', 'A-123'],
            },
          }
        ),
        responses: {
          '201': {
            description: 'Meta aceptó el envío.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  message_id: { type: 'string' },
                  whatsapp_message_id: { type: 'string' },
                  conversation_id: { type: 'string' },
                  contact_id: { type: 'string' },
                  contact_created: { type: 'boolean' },
                },
                required: ['message_id', 'conversation_id', 'contact_id'],
              }),
              {
                data: {
                  message_id: '0b9e…',
                  whatsapp_message_id: 'wamid.…',
                  conversation_id: '77ac…',
                  contact_id: '1d4f…',
                  contact_created: true,
                },
              }
            ),
          },
          '409': errorResponse(
            '`Idempotency-Key` repetida con otro cuerpo, o primera llamada en curso.'
          ),
          '502': errorResponse(
            '`meta_error`: la petición llegó a Meta y Meta la rechazó.'
          ),
        },
      }),
    },
    '/api/v1/contacts': {
      get: op({
        summary: 'Listar contactos',
        description: 'Los más recientes primero.',
        tags: ['Contactos'],
        scopes: ['contacts:read'],
        parameters: [
          ...PAGINATION,
          {
            name: 'search',
            in: 'query',
            description: 'Coincide con el nombre o el teléfono.',
            schema: { type: 'string' },
          },
          {
            name: 'tag',
            in: 'query',
            description: 'Id de una etiqueta.',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Una página de contactos.',
            content: json(listEnvelope(ref('Contact'))),
          },
        },
      }),
      post: op({
        summary: 'Crear un contacto',
        description:
          'Buscar-o-crear por teléfono: un número que ya existe devuelve `200` con el contacto de siempre; uno nuevo, `201`. El campo `tags` toma nombres y **reemplaza** el conjunto.',
        tags: ['Contactos'],
        scopes: ['contacts:write'],
        requestBody: body(
          {
            type: 'object',
            properties: {
              phone: { type: 'string', description: 'E.164. Obligatorio.' },
              name: { type: 'string' },
              email: { type: 'string' },
              company: { type: 'string' },
              tags: {
                type: 'array',
                items: { type: 'string' },
                description: 'Nombres; los que no existan se crean.',
              },
            },
            required: ['phone'],
          },
          { phone: '+34600111222', name: 'Ada Lovelace', tags: ['vip'] }
        ),
        responses: {
          '200': {
            description: 'Ya existía.',
            content: json(envelope(ref('Contact'))),
          },
          '201': {
            description: 'Creado.',
            content: json(envelope(ref('Contact'))),
          },
        },
      }),
    },
    '/api/v1/contacts/{id}': {
      parameters: [pathId('id', 'Id del contacto.')],
      get: op({
        summary: 'Leer un contacto',
        tags: ['Contactos'],
        scopes: ['contacts:read'],
        responses: {
          '200': {
            description: 'El contacto.',
            content: json(envelope(ref('Contact'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      patch: op({
        summary: 'Actualizar un contacto',
        description:
          'Solo los campos que mandes. `tags` reemplaza el conjunto entero por nombres.',
        tags: ['Contactos'],
        scopes: ['contacts:write'],
        requestBody: body(
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              email: { type: 'string' },
              company: { type: 'string' },
              tags: { type: 'array', items: { type: 'string' } },
            },
          },
          { name: 'Ada L.', tags: ['vip', 'beta'] }
        ),
        responses: {
          '200': {
            description: 'El contacto actualizado.',
            content: json(envelope(ref('Contact'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/contacts/{id}/tags': {
      parameters: [pathId('id', 'Id del contacto.')],
      post: op({
        summary: 'Añadir etiquetas por id',
        description:
          'Puerta aditiva: añade sin tocar las que el contacto ya tenía. Todo o nada — un id desconocido o ajeno no asigna ninguna y no dispara eventos.',
        tags: ['Etiquetas'],
        scopes: ['tags:write'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              tag_ids: {
                type: 'array',
                items: { type: 'string', format: 'uuid' },
                description: '50 como máximo.',
              },
            },
            required: ['tag_ids'],
          },
          { tag_ids: ['6f0c…', 'a91b…'] }
        ),
        responses: {
          '200': {
            description: 'El contacto con sus etiquetas.',
            content: json(envelope(ref('Contact'))),
          },
          '404': errorResponse(
            'El contacto o alguna etiqueta no son de esta cuenta.'
          ),
        },
      }),
    },
    '/api/v1/contacts/{id}/tags/{tagId}': {
      parameters: [
        pathId('id', 'Id del contacto.'),
        pathId('tagId', 'Id de la etiqueta.'),
      ],
      delete: op({
        summary: 'Quitar una etiqueta de un contacto',
        description:
          'Idempotente: quitar una que no llevaba es `200` sin cambios y **sin** webhook `contact.tag_removed`.',
        tags: ['Etiquetas'],
        scopes: ['tags:write'],
        responses: {
          '200': {
            description: 'El contacto actualizado.',
            content: json(envelope(ref('Contact'))),
          },
          '404': errorResponse(
            'El contacto o la etiqueta no son de esta cuenta.'
          ),
        },
      }),
    },
    '/api/v1/tags': {
      get: op({
        summary: 'Listar etiquetas',
        tags: ['Etiquetas'],
        scopes: ['tags:read'],
        parameters: [
          ...PAGINATION,
          {
            name: 'search',
            in: 'query',
            description: 'Coincide con el nombre, sin distinguir mayúsculas.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Una página de etiquetas.',
            content: json(listEnvelope(ref('Tag'))),
          },
        },
      }),
      post: op({
        summary: 'Crear una etiqueta',
        description:
          'Buscar-o-crear por nombre sin distinguir mayúsculas. Un nombre que ya existe devuelve `200` y no cambia el color.',
        tags: ['Etiquetas'],
        scopes: ['tags:write'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              name: { type: 'string', description: 'De 1 a 64 caracteres.' },
              color: {
                type: 'string',
                description: '`#rgb` o `#rrggbb`. Por omisión `#3b82f6`.',
              },
            },
            required: ['name'],
          },
          { name: 'vip', color: '#3b82f6' }
        ),
        responses: {
          '200': {
            description: 'Ya existía.',
            content: json(envelope(ref('Tag'))),
          },
          '201': {
            description: 'Creada.',
            content: json(envelope(ref('Tag'))),
          },
        },
      }),
    },
    '/api/v1/tags/{id}': {
      parameters: [pathId('id', 'Id de la etiqueta.')],
      get: op({
        summary: 'Leer una etiqueta',
        tags: ['Etiquetas'],
        scopes: ['tags:read'],
        responses: {
          '200': {
            description: 'La etiqueta.',
            content: json(envelope(ref('Tag'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      patch: op({
        summary: 'Renombrar o recolorear una etiqueta',
        tags: ['Etiquetas'],
        scopes: ['tags:write'],
        requestBody: body(
          {
            type: 'object',
            properties: { name: { type: 'string' }, color: { type: 'string' } },
          },
          { name: 'VIP' }
        ),
        responses: {
          '200': {
            description: 'La etiqueta actualizada.',
            content: json(envelope(ref('Tag'))),
          },
          '409': errorResponse(
            'Ese nombre ya lo usa otra etiqueta de la cuenta.'
          ),
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      delete: op({
        summary: 'Borrar una etiqueta',
        description:
          'La borra y la despega de todos los contactos que la llevaban.',
        tags: ['Etiquetas'],
        scopes: ['tags:write'],
        responses: {
          '200': {
            description: 'Borrada.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  deleted: { type: 'boolean' },
                },
                required: ['id', 'deleted'],
              }),
              { data: { id: '6f0c…', deleted: true } }
            ),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/conversations': {
      get: op({
        summary: 'Listar conversaciones',
        tags: ['Conversaciones'],
        scopes: ['conversations:read'],
        parameters: [
          ...PAGINATION,
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', enum: ['open', 'pending', 'closed'] },
          },
          {
            name: 'contact_id',
            in: 'query',
            schema: { type: 'string', format: 'uuid' },
          },
        ],
        responses: {
          '200': {
            description: 'Una página de conversaciones.',
            content: json(listEnvelope(ref('Conversation'))),
          },
        },
      }),
    },
    '/api/v1/conversations/{id}': {
      parameters: [pathId('id', 'Id de la conversación.')],
      get: op({
        summary: 'Leer una conversación',
        tags: ['Conversaciones'],
        scopes: ['conversations:read'],
        responses: {
          '200': {
            description: 'La conversación con su contacto.',
            content: json(envelope(ref('Conversation'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/conversations/{id}/messages': {
      parameters: [pathId('id', 'Id de la conversación.')],
      get: op({
        summary: 'Listar los mensajes de una conversación',
        description:
          'Los más recientes primero. La conversación se comprueba antes contra tu cuenta.',
        tags: ['Mensajes'],
        scopes: ['messages:read'],
        parameters: PAGINATION,
        responses: {
          '200': {
            description: 'Una página de mensajes.',
            content: json(listEnvelope(ref('Message'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/conversations/{id}/export': {
      parameters: [pathId('id', 'Id de la conversación.')],
      get: op({
        summary: 'Descargar una conversación',
        description:
          'La única operación cuyo cuerpo **no** es el sobre `{data}`: el cuerpo es el archivo, con `Content-Disposition`. Cubo propio de 10 por hora y cuenta. Por encima de 10 000 mensajes, `409`.',
        tags: ['Conversaciones'],
        scopes: ['conversations:export'],
        parameters: [
          {
            name: 'format',
            in: 'query',
            schema: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          },
        ],
        responses: {
          '200': {
            description: 'El archivo.',
            content: {
              'application/json': { schema: { type: 'object' } },
              'text/csv': { schema: { type: 'string' } },
            },
          },
          '409': errorResponse(
            'Demasiados mensajes: usa `POST /api/v1/exports`.'
          ),
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/templates': {
      get: op({
        summary: 'Listar plantillas',
        description:
          'Cada plantilla trae `variables`, que es lo que necesitas para enviarla.',
        tags: ['Plantillas'],
        scopes: ['templates:read'],
        parameters: [
          ...PAGINATION,
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string' },
            description: 'Un valor desconocido es `400`, no una lista vacía.',
          },
          { name: 'language', in: 'query', schema: { type: 'string' } },
          { name: 'category', in: 'query', schema: { type: 'string' } },
          {
            name: 'search',
            in: 'query',
            schema: { type: 'string' },
            description: 'Parte del nombre o del cuerpo.',
          },
        ],
        responses: {
          '200': {
            description: 'Una página de plantillas.',
            content: json(listEnvelope(ref('Template'))),
          },
        },
      }),
      post: op({
        summary: 'Crear una plantilla y enviarla a revisión',
        description:
          'Las variables del cuerpo van contiguas desde `{{1}}` y necesitan un valor de ejemplo cada una. `Authentication` se rechaza: créala en WhatsApp Manager y sincroniza.',
        tags: ['Plantillas'],
        scopes: ['templates:write'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              name: {
                type: 'string',
                description: 'Minúsculas, dígitos y guiones bajos.',
              },
              language: { type: 'string' },
              category: { type: 'string', enum: ['Marketing', 'Utility'] },
              body_text: { type: 'string' },
              sample_values: {
                type: 'object',
                description: 'Un valor por variable, en `body`.',
              },
              header_type: {
                type: 'string',
                enum: ['text', 'image', 'video', 'document'],
              },
              header_media_url: { type: 'string' },
              footer_text: { type: 'string' },
              buttons: { type: 'array', items: { type: 'object' } },
              from: {
                type: 'string',
                description: '`phone_number_id` con varios números conectados.',
              },
            },
            required: ['name', 'language', 'category', 'body_text'],
          },
          {
            name: 'aviso_pedido',
            language: 'es_ES',
            category: 'Utility',
            body_text: 'Hola {{1}}, tu pedido {{2}} ya va en camino.',
            sample_values: { body: ['Ada', 'A-123'] },
          }
        ),
        responses: {
          '201': {
            description: 'Creada y en revisión (`PENDING`).',
            content: json(envelope(ref('Template'))),
          },
          '409': errorResponse(
            'Ese par (nombre, idioma) ya existe en tu cuenta.'
          ),
          '502': errorResponse(
            '`meta_error`: Meta rechazó el alta y no se guardó nada.'
          ),
        },
      }),
    },
    '/api/v1/templates/{id}': {
      parameters: [pathId('id', 'Id de la plantilla.')],
      get: op({
        summary: 'Leer una plantilla',
        tags: ['Plantillas'],
        scopes: ['templates:read'],
        responses: {
          '200': {
            description: 'La plantilla con sus variables.',
            content: json(envelope(ref('Template'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      patch: op({
        summary: 'Editar una plantilla y reenviarla',
        description:
          'Meta sustituye los componentes: lo que omitas se hereda. Manda `null` para quitar de verdad. `name` y `language` son inmutables.',
        tags: ['Plantillas'],
        scopes: ['templates:write'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              body_text: { type: 'string' },
              sample_values: { type: 'object' },
              footer_text: { type: ['string', 'null'] },
              header_type: { type: ['string', 'null'] },
              buttons: { type: ['array', 'null'], items: { type: 'object' } },
            },
          },
          {
            body_text: 'Hola {{1}}, tu pedido {{2}} sale hoy.',
            sample_values: { body: ['Ada', 'A-123'] },
          }
        ),
        responses: {
          '200': {
            description: 'Editada y de vuelta a `PENDING`.',
            content: json(envelope(ref('Template'))),
          },
          '409': errorResponse(
            'Estado no editable, o plantilla que nunca llegó a Meta.'
          ),
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      delete: op({
        summary: 'Borrar una plantilla',
        description:
          'Borra esta variante de idioma en Meta y en local, no todas las traducciones del mismo nombre.',
        tags: ['Plantillas'],
        scopes: ['templates:write'],
        parameters: [
          {
            name: 'from',
            in: 'query',
            description: '`phone_number_id` con varios números.',
            schema: { type: 'string' },
          },
        ],
        responses: {
          '200': {
            description: 'Borrada.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  deleted: { type: 'boolean' },
                },
                required: ['id', 'deleted'],
              }),
              { data: { id: 'b71e…', deleted: true } }
            ),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/templates/sync': {
      post: op({
        summary: 'Sincronizar el catálogo desde Meta',
        description:
          'Lo que dice Meta gana. Cubo propio de 6 por minuto y cuenta. Cada cambio de estado emite además `template.status_updated`.',
        tags: ['Plantillas'],
        scopes: ['templates:write'],
        requestBody: {
          required: false,
          description: 'Opcional: solo sirve para elegir el número.',
          content: json(
            {
              type: 'object',
              properties: {
                from: { type: 'string' },
                whatsapp_config_id: { type: 'string', format: 'uuid' },
              },
            },
            {}
          ),
        },
        responses: {
          '200': {
            description: 'Resumen de la sincronización.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  synced: { type: 'integer' },
                  created: { type: 'integer' },
                  updated: { type: 'integer' },
                  status_changes: { type: 'array', items: { type: 'object' } },
                  truncated: {
                    type: 'boolean',
                    description: 'Meta tenía más de 20 páginas.',
                  },
                },
                required: ['synced', 'created', 'updated'],
              }),
              {
                data: {
                  synced: 12,
                  created: 2,
                  updated: 10,
                  status_changes: [],
                  truncated: false,
                },
              }
            ),
          },
          '502': errorResponse('`meta_error`: Meta no respondió al catálogo.'),
        },
      }),
    },
    '/api/v1/broadcasts': {
      post: op({
        summary: 'Lanzar una difusión',
        description:
          'Los destinatarios se guardan al momento y los envíos salen en segundo plano: la llamada vuelve rápido. Máximo 1 000 por petición.',
        tags: ['Difusiones'],
        scopes: ['broadcasts:send'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              name: { type: 'string' },
              template_name: { type: 'string' },
              template_language: { type: 'string' },
              recipients: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    to: { type: 'string' },
                    to_user_id: { type: 'string' },
                    params: { type: 'array', items: { type: 'string' } },
                  },
                },
              },
            },
            required: [
              'name',
              'template_name',
              'template_language',
              'recipients',
            ],
          },
          {
            name: 'Promo julio',
            template_name: 'promo_julio',
            template_language: 'es_ES',
            recipients: [{ to: '+34600111222', params: ['Ada'] }],
          }
        ),
        responses: {
          '202': {
            description: 'Aceptada; consulta el avance con el `GET`.',
            content: json(envelope(ref('Broadcast'))),
          },
          '402': errorResponse(
            '`quota_exceeded`: la campaña no cabe en el plan.'
          ),
        },
      }),
    },
    '/api/v1/broadcasts/{id}': {
      parameters: [pathId('id', 'Id de la difusión.')],
      get: op({
        summary: 'Consultar una difusión',
        description: 'Mismo scope que lanzarla: no existe `broadcasts:read`.',
        tags: ['Difusiones'],
        scopes: ['broadcasts:send'],
        responses: {
          '200': {
            description: 'Estado y recuentos.',
            content: json(envelope(ref('Broadcast'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/exports': {
      get: op({
        summary: 'Listar encargos de exportación',
        tags: ['Exportaciones'],
        scopes: ['conversations:export'],
        parameters: PAGINATION,
        responses: {
          '200': {
            description: 'Una página de encargos.',
            content: json(listEnvelope(ref('ExportJob'))),
          },
        },
      }),
      post: op({
        summary: 'Encargar una exportación',
        description:
          'Cubo propio de 10 por hora y cuenta. Nada de `filters` puede ampliar la exportación fuera de tu cuenta.',
        tags: ['Exportaciones'],
        scopes: ['conversations:export'],
        idempotent: true,
        requestBody: body(
          {
            type: 'object',
            properties: {
              kind: {
                type: 'string',
                enum: ['conversations'],
                default: 'conversations',
              },
              format: {
                type: 'string',
                enum: ['json', 'csv'],
                default: 'json',
              },
              filters: {
                type: 'object',
                properties: {
                  status: {
                    type: 'string',
                    enum: ['open', 'pending', 'closed'],
                  },
                  contact_id: { type: 'string', format: 'uuid' },
                  from: { type: 'string', format: 'date-time' },
                  to: { type: 'string', format: 'date-time' },
                },
              },
            },
          },
          {
            kind: 'conversations',
            format: 'csv',
            filters: { status: 'closed' },
          }
        ),
        responses: {
          '202': {
            description: 'Encargo aceptado, en `queued`.',
            content: json(envelope(ref('ExportJob'))),
          },
        },
      }),
    },
    '/api/v1/exports/{id}': {
      parameters: [pathId('id', 'Id del encargo.')],
      get: op({
        summary: 'Consultar un encargo y recoger el archivo',
        description:
          '`download_url` se acuña en cada llamada, vale 15 minutos y no se guarda. El archivo se borra a los 7 días.',
        tags: ['Exportaciones'],
        scopes: ['conversations:export'],
        responses: {
          '200': {
            description: 'Estado del encargo.',
            content: json(envelope(ref('ExportJob'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/webhooks': {
      get: op({
        summary: 'Listar destinos',
        description: 'Nunca devuelve el secreto.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        parameters: PAGINATION,
        responses: {
          '200': {
            description: 'Una página de destinos.',
            content: json(listEnvelope(ref('WebhookEndpoint'))),
          },
        },
      }),
      post: op({
        summary: 'Registrar un destino',
        description:
          'La respuesta trae `secret` **una sola vez**. La URL debe ser `https://` y pública.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        requestBody: body(
          {
            type: 'object',
            properties: {
              url: { type: 'string' },
              events: { type: 'array', items: { type: 'string' } },
            },
            required: ['url', 'events'],
          },
          {
            url: 'https://tu-servidor.example.com/hooks/cabbity',
            events: ['message.received'],
          }
        ),
        responses: {
          '201': {
            description: 'Registrado, con el secreto.',
            content: json(envelope(ref('WebhookEndpoint'))),
          },
          '400': errorResponse(
            'URL no `https://`, o a una dirección no pública.'
          ),
        },
      }),
    },
    '/api/v1/webhooks/{id}': {
      parameters: [pathId('id', 'Id del destino.')],
      get: op({
        summary: 'Leer un destino',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        responses: {
          '200': {
            description: 'El destino, sin secreto.',
            content: json(envelope(ref('WebhookEndpoint'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      patch: op({
        summary: 'Editar un destino',
        description:
          'Reactivarlo (`is_active: true`) pone a cero el contador de fallos.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        requestBody: body(
          {
            type: 'object',
            properties: {
              url: { type: 'string' },
              events: { type: 'array', items: { type: 'string' } },
              is_active: { type: 'boolean' },
            },
          },
          { is_active: true }
        ),
        responses: {
          '200': {
            description: 'El destino actualizado.',
            content: json(envelope(ref('WebhookEndpoint'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
      delete: op({
        summary: 'Borrar un destino',
        description: 'Su registro de entregas se va con él.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        responses: {
          '200': {
            description: 'Borrado.',
            content: json(
              envelope({
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  deleted: { type: 'boolean' },
                },
                required: ['id', 'deleted'],
              }),
              { data: { id: 'c40a…', deleted: true } }
            ),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/webhooks/{id}/deliveries': {
      parameters: [pathId('id', 'Id del destino.')],
      get: op({
        summary: 'Registro de entregas',
        description: 'Nunca incluye el `payload`.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        parameters: [
          ...PAGINATION,
          {
            name: 'status',
            in: 'query',
            schema: {
              type: 'string',
              enum: ['pending', 'delivered', 'failed', 'dead'],
            },
          },
        ],
        responses: {
          '200': {
            description: 'Una página de entregas.',
            content: json(listEnvelope(ref('WebhookDelivery'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/webhooks/{id}/deliveries/{deliveryId}/retry': {
      parameters: [
        pathId('id', 'Id del destino.'),
        pathId('deliveryId', 'Id de la entrega.'),
      ],
      post: op({
        summary: 'Reintentar una entrega',
        description:
          'Desde el primer peldaño de la escalera. Cubo propio de 20 por minuto y cuenta.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        responses: {
          '200': {
            description: 'Reintentada.',
            content: json(envelope(ref('WebhookDelivery'))),
          },
          '409': errorResponse('Ya estaba encolada para otro intento.'),
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/webhooks/{id}/test': {
      parameters: [pathId('id', 'Id del destino.')],
      post: op({
        summary: 'Enviar un ping firmado',
        description:
          '`ping` no es un evento suscribible: solo viaja cuando lo pides. Cubo propio de 20 por minuto y cuenta.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        responses: {
          '200': {
            description: 'Entregado (o el error de tu servidor).',
            content: json(envelope(ref('WebhookDelivery'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
    '/api/v1/webhooks/{id}/rotate-secret': {
      parameters: [pathId('id', 'Id del destino.')],
      post: op({
        summary: 'Rotar el secreto de firma',
        description:
          'Devuelve el secreto nuevo una vez. Todo lo que salga después va firmado con él: actualiza tu verificador antes de la siguiente entrega.',
        tags: ['Webhooks'],
        scopes: ['webhooks:manage'],
        responses: {
          '200': {
            description: 'El destino con el secreto nuevo.',
            content: json(envelope(ref('WebhookEndpoint'))),
          },
          '404': errorResponse('No existe, o es de otra cuenta.'),
        },
      }),
    },
  },
  webhooks: {
    'message.received': {
      post: {
        summary: 'Llega un mensaje entrante de un contacto.',
        requestBody: {
          required: true,
          content: json(ref('WebhookEventEnvelope'), {
            id: '8f3c…',
            event: 'message.received',
            occurred_at: '2026-07-01T12:00:00.000Z',
            account_id: '9f1c…',
            data: {
              conversation_id: '77ac…',
              contact_id: '1d4f…',
              whatsapp_message_id: 'wamid.…',
              content_type: 'text',
              text: 'Hola 👋',
            },
          }),
        },
        responses: { '200': { description: 'Tu servidor aceptó la entrega.' } },
      },
    },
    'message.status_updated': {
      post: {
        summary: 'Un mensaje que enviaste cambia de estado de entrega.',
        requestBody: {
          required: true,
          content: json(ref('WebhookEventEnvelope'), {
            id: '2b71…',
            event: 'message.status_updated',
            occurred_at: '2026-07-01T12:00:05.000Z',
            account_id: '9f1c…',
            data: {
              whatsapp_message_id: 'wamid.…',
              conversation_id: '77ac…',
              status: 'delivered',
            },
          }),
        },
        responses: { '200': { description: 'Tu servidor aceptó la entrega.' } },
      },
    },
    'contact.tag_added': {
      post: {
        summary:
          'Se pega una etiqueta a un contacto (por API o desde el panel).',
        requestBody: {
          required: true,
          content: json(ref('WebhookEventEnvelope'), {
            id: 'a0d2…',
            event: 'contact.tag_added',
            occurred_at: '2026-07-01T12:01:00.000Z',
            account_id: '9f1c…',
            data: { contact_id: '1d4f…', tag_id: '6f0c…' },
          }),
        },
        responses: { '200': { description: 'Tu servidor aceptó la entrega.' } },
      },
    },
    'template.status_updated': {
      post: {
        summary: 'Meta movió el estado de revisión de una plantilla.',
        requestBody: {
          required: true,
          content: json(ref('WebhookEventEnvelope'), {
            id: 'e91b…',
            event: 'template.status_updated',
            occurred_at: '2026-07-01T13:00:00.000Z',
            account_id: '9f1c…',
            data: {
              template_id: 'b71e…',
              name: 'aviso_pedido',
              language: 'es_ES',
              status: 'APPROVED',
              previous_status: 'PENDING',
            },
          }),
        },
        responses: { '200': { description: 'Tu servidor aceptó la entrega.' } },
      },
    },
    'broadcast.completed': {
      post: {
        summary: 'Una difusión terminó de repartirse.',
        requestBody: {
          required: true,
          content: json(ref('WebhookEventEnvelope'), {
            id: '77f0…',
            event: 'broadcast.completed',
            occurred_at: '2026-07-01T14:00:00.000Z',
            account_id: '9f1c…',
            data: {
              broadcast_id: '5c1a…',
              status: 'sent',
              total: 1000,
              sent: 987,
              failed: 13,
            },
          }),
        },
        responses: { '200': { description: 'Tu servidor aceptó la entrega.' } },
      },
    },
  },
  components: {
    schemas: SCHEMAS,
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        description: 'Clave de API de la cuenta, creada en Ajustes → API.',
      },
    },
  },
};
