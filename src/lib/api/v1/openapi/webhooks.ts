// ============================================================
// Registro: webhooks salientes (gestión de receptores).
//
// Nueve operaciones, todas bajo `webhooks:manage`. Las tres caras
// —probar, reintentar, rotar— llevan el cubo `webhookAction` POR
// CUENTA además del general: cada llamada abre una conexión saliente
// a una URL que eligió el cliente o acuña una credencial nueva.
//
// El catálogo de EVENTOS y su `data` no está aquí: eso es la sección
// `webhooks` de OpenAPI y la genera `webhook-events.ts`.
// ============================================================

import {
  ERR_BAD_REQUEST,
  ERR_CONFLICT,
  ERR_NOT_FOUND,
  pathParam,
  queryParam,
} from './common';
import {
  EXAMPLE_WEBHOOK_DELIVERY,
  EXAMPLE_WEBHOOK_ENDPOINT,
  ref,
} from './schemas';
import type { OperationDef } from './types';

const ENDPOINT_ID = pathParam('id', 'Id del receptor.');

export const WEBHOOKS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/webhooks',
    operationId: 'listWebhooks',
    summary: 'Listar receptores',
    description: 'Tus receptores registrados. Nunca devuelve el secreto.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    paginated: true,
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de receptores.',
        schema: ref('WebhookEndpoint'),
        example: [EXAMPLE_WEBHOOK_ENDPOINT],
      },
    ],
    errors: [],
  },
  {
    method: 'post',
    path: '/webhooks',
    operationId: 'createWebhook',
    summary: 'Registrar un receptor',
    description:
      'La `url` debe ser `https://` y resolver a una dirección pública: `localhost`, los rangos privados y el link-local (incluida la metadata de nube `169.254.169.254`) se rechazan, y se vuelve a comprobar en el momento de entregar, no solo al registrar. **La respuesta trae `secret` exactamente una vez** — guárdalo para verificar firmas; aquí solo queda una copia cifrada.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    requestBody: {
      required: true,
      description: 'URL de destino y eventos a los que suscribirse.',
      schema: {
        type: 'object',
        required: ['url', 'events'],
        properties: {
          url: { type: 'string', format: 'uri' },
          events: {
            type: 'array',
            minItems: 1,
            items: ref('WebhookEventName'),
          },
        },
      },
      example: {
        url: 'https://example.com/hooks/wacrm',
        events: ['message.received', 'message.status_updated'],
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 201,
        description: 'Receptor creado, con el secreto en claro.',
        schema: ref('WebhookEndpointWithSecret'),
        example: {
          ...EXAMPLE_WEBHOOK_ENDPOINT,
          events: ['message.received', 'message.status_updated'],
          secret: 'whsec_Zm9vYmFyYmF6cXV1eA',
        },
      },
    ],
    errors: [ERR_BAD_REQUEST],
  },
  {
    method: 'get',
    path: '/webhooks/{id}',
    operationId: 'getWebhook',
    summary: 'Leer un receptor',
    description: 'Un receptor por su id. Sin el secreto.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    parameters: [ENDPOINT_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El receptor.',
        schema: ref('WebhookEndpoint'),
        example: EXAMPLE_WEBHOOK_ENDPOINT,
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'patch',
    path: '/webhooks/{id}',
    operationId: 'updateWebhook',
    summary: 'Actualizar un receptor',
    description:
      'Cambia `url`, `events` o `is_active`. Volver a activarlo pone el contador de fallos a cero — que es como se rescata un receptor autodesactivado tras 15 fallos seguidos.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    parameters: [ENDPOINT_ID],
    requestBody: {
      required: true,
      description: 'Al menos un campo.',
      schema: {
        type: 'object',
        properties: {
          url: { type: 'string', format: 'uri' },
          events: {
            type: 'array',
            minItems: 1,
            items: ref('WebhookEventName'),
          },
          is_active: { type: 'boolean' },
        },
      },
      example: { is_active: true },
    },
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El receptor ya actualizado.',
        schema: ref('WebhookEndpoint'),
        example: EXAMPLE_WEBHOOK_ENDPOINT,
      },
    ],
    errors: [ERR_BAD_REQUEST, ERR_NOT_FOUND],
  },
  {
    method: 'delete',
    path: '/webhooks/{id}',
    operationId: 'deleteWebhook',
    summary: 'Borrar un receptor',
    description: 'Lo borra junto con su registro de entregas.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    parameters: [ENDPOINT_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Borrado.',
        schema: ref('DeletedResource'),
        example: { id: EXAMPLE_WEBHOOK_ENDPOINT.id, deleted: true },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'get',
    path: '/webhooks/{id}/deliveries',
    operationId: 'listWebhookDeliveries',
    summary: 'Registro de entregas',
    description:
      'Las entregas de un receptor, de la más nueva a la más vieja. **Nunca incluye `payload`**: puede llevar el texto de un cliente final. El historial se guarda 30 días.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    paginated: true,
    parameters: [
      ENDPOINT_ID,
      queryParam('status', 'Filtra por estado de la entrega.', {
        schema: {
          type: 'string',
          enum: ['pending', 'delivered', 'failed', 'dead'],
        },
      }),
    ],
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de entregas.',
        schema: ref('WebhookDelivery'),
        example: [EXAMPLE_WEBHOOK_DELIVERY],
      },
    ],
    errors: [ERR_BAD_REQUEST, ERR_NOT_FOUND],
  },
  {
    method: 'post',
    path: '/webhooks/{id}/deliveries/{deliveryId}/retry',
    operationId: 'retryWebhookDelivery',
    summary: 'Reintentar una entrega ahora',
    description:
      'Vuelve a intentar una entrega en este momento, desde el primer peldaño de la escalera de esperas. `409` si ya está encolada para otro intento.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    extraRateLimits: ['webhookAction'],
    parameters: [ENDPOINT_ID, pathParam('deliveryId', 'Id de la entrega.')],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Intentada; el resultado va en `result`.',
        schema: ref('WebhookDeliveryWithResult'),
        example: {
          ...EXAMPLE_WEBHOOK_DELIVERY,
          attempt: 2,
          status: 'delivered',
          last_status_code: 200,
          delivered_at: '2026-09-16T11:02:00.000Z',
          result: 'delivered',
        },
      },
    ],
    errors: [
      ERR_NOT_FOUND,
      {
        ...ERR_CONFLICT,
        description: 'La entrega ya está encolada para otro intento.',
      },
    ],
  },
  {
    method: 'post',
    path: '/webhooks/{id}/test',
    operationId: 'testWebhook',
    summary: 'Enviar un `ping` firmado',
    description:
      'Entrega un evento `ping` firmado al receptor. `ping` no es suscribible: solo viaja cuando lo pides.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    extraRateLimits: ['webhookAction'],
    parameters: [ENDPOINT_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'Entrega de prueba hecha; el resultado va en `result`.',
        schema: ref('WebhookDeliveryWithResult'),
        example: {
          ...EXAMPLE_WEBHOOK_DELIVERY,
          event: 'ping',
          status: 'delivered',
          last_status_code: 200,
          delivered_at: '2026-09-16T11:00:05.000Z',
          result: 'delivered',
        },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
  {
    method: 'post',
    path: '/webhooks/{id}/rotate-secret',
    operationId: 'rotateWebhookSecret',
    summary: 'Rotar el secreto de firma',
    description:
      'Acuña un secreto nuevo y lo devuelve en claro una sola vez. **Todo lo que salga después de esta respuesta va firmado con él**: actualiza tu verificador antes de la siguiente entrega.',
    tag: 'webhooks',
    scopes: ['webhooks:manage'],
    extraRateLimits: ['webhookAction'],
    parameters: [ENDPOINT_ID],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El receptor con el secreto nuevo.',
        schema: ref('WebhookEndpointWithSecret'),
        example: {
          ...EXAMPLE_WEBHOOK_ENDPOINT,
          secret: 'whsec_bmV3c2VjcmV0dmFsdWU',
        },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
];
