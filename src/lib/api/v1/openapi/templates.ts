// ============================================================
// Registro: plantillas de mensaje.
//
// Seis operaciones. Dos notas que el documento tiene que decir bien:
//
//   - `POST /templates` acepta `Idempotency-Key`; `PATCH` NO lo hace
//     (repetir la misma edición ya es idempotente por naturaleza y
//     Meta limita a 10 ediciones por plantilla y 30 días).
//   - `POST /templates/sync` tiene cubo propio por CUENTA (6/min):
//     una llamada recorre hasta 20 páginas de la Graph API.
// ============================================================

import {
  ERR_BAD_REQUEST,
  ERR_CONFLICT,
  ERR_META,
  ERR_NOT_FOUND,
  pathParam,
  queryParam,
} from './common';
import {
  EXAMPLE_TEMPLATE,
  TEMPLATE_CATEGORIES,
  TEMPLATE_STATUSES,
  ref,
} from './schemas';
import type { OperationDef, SchemaObject } from './types';

const TEMPLATE_ID = pathParam('id', 'Id de la plantilla.');

/** Los campos de componentes que comparten crear y editar. */
const COMPONENT_INPUT_PROPERTIES: Record<string, SchemaObject> = {
  header_type: {
    type: ['string', 'null'],
    enum: ['text', 'image', 'video', 'document', null],
  },
  header_content: { type: ['string', 'null'] },
  header_media_url: {
    type: ['string', 'null'],
    description:
      'URL del medio de cabecera; se convierte en el handle de subida que Meta exige.',
  },
  footer_text: { type: ['string', 'null'] },
  buttons: { type: ['array', 'null'], items: ref('TemplateButton') },
  sample_values: {
    type: ['object', 'null'],
    description:
      'Un valor por variable del cuerpo, en orden. Meta rechaza la plantilla si no cuadran.',
    properties: { body: { type: 'array', items: { type: 'string' } } },
  },
  from: {
    type: 'string',
    description:
      '`phone_number_id` de Meta: elige la WABA contra la que trabajar.',
  },
  whatsapp_config_id: {
    type: 'string',
    format: 'uuid',
    description: 'Alternativa a `from`, con el id interno del número.',
  },
};

export const TEMPLATES_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/templates',
    operationId: 'listTemplates',
    summary: 'Listar plantillas',
    description:
      'Las plantillas de la cuenta, de la más nueva a la más vieja. Cada una lleva `variables`: la lista ordenada de `{{1}}…{{n}}` que espera su cuerpo, que es justo lo que hace falta para llamar a `POST /messages` con `type: "template"`. `status` es el enum de Meta, guardado tal cual: `PAUSED` se recupera editando y reenviando, `DISABLED` es terminal.',
    tag: 'templates',
    scopes: ['templates:read'],
    paginated: true,
    parameters: [
      queryParam('status', 'Estado exacto. Un valor desconocido es `400`.', {
        schema: { type: 'string', enum: [...TEMPLATE_STATUSES] },
      }),
      queryParam('language', 'Código de idioma de Meta (`en_US`, `es_ES`).'),
      queryParam('category', 'Categoría, sin distinguir mayúsculas.', {
        schema: { type: 'string', enum: [...TEMPLATE_CATEGORIES] },
      }),
      queryParam('search', 'Subcadena del nombre o del cuerpo.'),
    ],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de plantillas.',
        schema: ref('Template'),
        example: [EXAMPLE_TEMPLATE],
      },
    ],
    errors: [
      {
        ...ERR_BAD_REQUEST,
        description: 'Un `status` o una `category` fuera del enum.',
      },
    ],
  },
  {
    method: 'post',
    path: '/templates',
    operationId: 'createTemplate',
    summary: 'Crear una plantilla y mandarla a revisión',
    description:
      'Crea la plantilla y la envía a Meta. El nombre sigue la regla de Meta (minúsculas, dígitos y guiones bajos). Las variables del cuerpo deben ser **contiguas desde `{{1}}`** y hay que dar exactamente un `sample_values.body` por variable. `category: "Authentication"` se rechaza con `400`: esas plantillas necesitan el flujo de contraseña de un solo uso de Meta, créalas en WhatsApp Manager y tráelas con `POST /templates/sync`. Vuelve `201` con `status: "PENDING"`. Vale la pena mandar `Idempotency-Key`: Meta limita la creación a 100 por hora y WABA.',
    tag: 'templates',
    scopes: ['templates:write'],
    idempotent: true,
    requestBody: {
      required: true,
      description: 'La plantilla a crear.',
      schema: {
        type: 'object',
        required: ['name', 'language', 'category', 'body_text'],
        properties: {
          name: { type: 'string' },
          language: { type: 'string' },
          category: { type: 'string', enum: ['Marketing', 'Utility'] },
          body_text: { type: 'string' },
          ...COMPONENT_INPUT_PROPERTIES,
        },
      },
      example: {
        name: 'order_update',
        language: 'en_US',
        category: 'Utility',
        body_text: 'Hi {{1}}, your order {{2}} is on its way.',
        sample_values: { body: ['Ada', 'A-123'] },
        footer_text: 'Reply STOP to opt out',
        buttons: [{ type: 'QUICK_REPLY', text: 'Track' }],
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 201,
        description: 'Creada y enviada a revisión.',
        schema: ref('Template'),
        example: { ...EXAMPLE_TEMPLATE, status: 'PENDING' },
      },
    ],
    errors: [
      ERR_BAD_REQUEST,
      {
        ...ERR_CONFLICT,
        description:
          'La cuenta ya tiene ese par `(name, language)`. Se comprueba antes de llamar a Meta.',
      },
      {
        ...ERR_META,
        description:
          'Meta rechazó el alta: llega su mensaje público y `meta_code`, y no se guarda nada en local.',
      },
    ],
  },
  {
    method: 'get',
    path: '/templates/{id}',
    operationId: 'getTemplate',
    summary: 'Leer una plantilla',
    description: 'Una plantilla por su id.',
    tag: 'templates',
    scopes: ['templates:read'],
    parameters: [TEMPLATE_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La plantilla.',
        schema: ref('Template'),
        example: EXAMPLE_TEMPLATE,
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'patch',
    path: '/templates/{id}',
    operationId: 'updateTemplate',
    summary: 'Editar una plantilla y reenviarla a revisión',
    description:
      '**Meta reemplaza los componentes, no los parchea.** Por eso lo que omitas se hereda de la plantilla guardada en vez de borrarse: manda `"footer_text": null` para quitar el pie de verdad (igual con `header_type` y `buttons`). `name` y `language` son inmutables — para Meta cada par es una plantilla distinta. Solo se pueden editar las `APPROVED`, `REJECTED` y `PAUSED` que llegaron a Meta; al aceptarse vuelven a `PENDING`. **No acepta `Idempotency-Key`**: repetir la misma edición deja el mismo conjunto de componentes.',
    tag: 'templates',
    scopes: ['templates:write'],
    parameters: [TEMPLATE_ID],
    requestBody: {
      required: true,
      description: 'Los componentes a reemplazar.',
      schema: {
        type: 'object',
        properties: {
          category: { type: 'string', enum: ['Marketing', 'Utility'] },
          body_text: { type: 'string' },
          ...COMPONENT_INPUT_PROPERTIES,
        },
      },
      example: {
        body_text: 'Hi {{1}}, your order {{2}} shipped today.',
        sample_values: { body: ['Ada', 'A-123'] },
        footer_text: null,
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Editada; vuelve a `PENDING`.',
        schema: ref('Template'),
        example: { ...EXAMPLE_TEMPLATE, status: 'PENDING' },
      },
    ],
    errors: [
      ERR_BAD_REQUEST,
      ERR_NOT_FOUND,
      {
        ...ERR_CONFLICT,
        description:
          'La plantilla está en un estado no editable, o es un borrador local que nunca llegó a Meta (créala en vez de editarla).',
      },
      ERR_META,
    ],
  },
  {
    method: 'delete',
    path: '/templates/{id}',
    operationId: 'deleteTemplate',
    summary: 'Borrar una plantilla',
    description:
      'Borra en Meta y en local. Solo esta variante de idioma, no todas las traducciones que comparten el nombre.',
    tag: 'templates',
    scopes: ['templates:write'],
    parameters: [
      TEMPLATE_ID,
      queryParam(
        'from',
        '`phone_number_id` con el que elegir la WABA (DELETE no lleva cuerpo).'
      ),
    ],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Borrada.',
        schema: ref('DeletedResource'),
        example: { id: EXAMPLE_TEMPLATE.id, deleted: true },
      },
    ],
    errors: [ERR_NOT_FOUND, ERR_META],
  },
  {
    method: 'post',
    path: '/templates/sync',
    operationId: 'syncTemplates',
    summary: 'Traer el catálogo de Meta',
    description:
      'Baja el catálogo de Meta al CRM. Lo que dice Meta gana; las plantillas locales sin contrapartida en Meta **no** se borran, para que se vea la diferencia. El cuerpo es opcional y solo sirve para elegir el número. Cada entrada de `status_changes` dispara además un webhook `template.status_updated`: suscríbete a él en vez de sondear esto. `errors` lista las que no se pudieron guardar —por nombre e idioma, con un mensaje fijo—; el motivo queda en el log del servidor, nunca en la respuesta.',
    tag: 'templates',
    scopes: ['templates:write'],
    extraRateLimits: ['templatesSync'],
    requestBody: {
      required: false,
      description: 'Opcional: solo elige el número.',
      schema: {
        type: 'object',
        properties: {
          from: COMPONENT_INPUT_PROPERTIES.from,
          whatsapp_config_id: COMPONENT_INPUT_PROPERTIES.whatsapp_config_id,
        },
      },
      example: {},
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Resumen de la sincronización.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'synced',
            'created',
            'updated',
            'status_changes',
            'errors',
            'truncated',
          ],
          properties: {
            synced: {
              type: 'integer',
              minimum: 0,
              description: 'Plantillas que devolvió Meta.',
            },
            created: { type: 'integer', minimum: 0 },
            updated: { type: 'integer', minimum: 0 },
            status_changes: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'template_id',
                  'name',
                  'language',
                  'status',
                  'previous_status',
                ],
                properties: {
                  template_id: { type: 'string', format: 'uuid' },
                  name: { type: 'string' },
                  language: { type: 'string' },
                  status: { type: 'string', enum: [...TEMPLATE_STATUSES] },
                  previous_status: { type: ['string', 'null'] },
                },
              },
            },
            errors: {
              type: 'array',
              description:
                'Plantillas que no se pudieron guardar. El mensaje es fijo a propósito.',
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['name', 'language', 'message'],
                properties: {
                  name: { type: 'string' },
                  language: { type: 'string' },
                  message: { type: 'string' },
                },
              },
            },
            truncated: {
              type: 'boolean',
              description: 'Meta tenía más de 20 páginas de plantillas.',
            },
          },
        },
        example: {
          synced: 12,
          created: 2,
          updated: 10,
          status_changes: [
            {
              template_id: EXAMPLE_TEMPLATE.id,
              name: 'order_update',
              language: 'en_US',
              status: 'APPROVED',
              previous_status: 'PENDING',
            },
          ],
          errors: [],
          truncated: false,
        },
      },
    ],
    errors: [ERR_BAD_REQUEST, ERR_META],
  },
];
