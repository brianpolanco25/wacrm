// ============================================================
// Registro: difusiones.
//
// Dos operaciones, y las dos con el MISMO scope: `broadcasts:send`.
// No existe `broadcasts:read` — leer el estado de una campaña exige
// el permiso de lanzarlas. Es deliberado (inventario de a7.5, §6) y
// se documenta aquí para que nadie pida un scope que no existe.
// ============================================================

import { ERR_BAD_REQUEST, ERR_NOT_FOUND, pathParam } from './common';
import { ref } from './schemas';
import type { OperationDef } from './types';

const BROADCAST_ID = '3d4e5f60-7182-4930-a4b5-c6d7e8f90a1b';

export const BROADCASTS_OPERATIONS: OperationDef[] = [
  {
    method: 'post',
    path: '/broadcasts',
    operationId: 'createBroadcast',
    summary: 'Lanzar una difusión por plantilla',
    description:
      'La campaña y sus destinatarios se guardan de inmediato y los envíos salen en segundo plano, así que la llamada vuelve rápido: el progreso se consulta con `GET /broadcasts/{id}`. Tope de **1000 destinatarios por petición**. Cada uno lleva `to` (E.164) o `to_user_id` (BSUID); con ambos gana `to`. Los que no tengan ninguno válido se descartan y se cuentan en `rejected`.',
    tag: 'broadcasts',
    scopes: ['broadcasts:send'],
    idempotent: true,
    requestBody: {
      required: true,
      description: 'Plantilla y lista de destinatarios.',
      schema: {
        type: 'object',
        required: ['name', 'template_name', 'template_language', 'recipients'],
        properties: {
          name: { type: 'string', description: 'Nombre de la campaña.' },
          template_name: { type: 'string' },
          template_language: { type: 'string' },
          recipients: {
            type: 'array',
            minItems: 1,
            maxItems: 1000,
            items: {
              type: 'object',
              properties: {
                to: { type: 'string', description: 'Número en E.164.' },
                to_user_id: { type: 'string', description: 'BSUID.' },
                params: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      example: {
        name: 'Promo de julio',
        template_name: 'promo_july',
        template_language: 'en_US',
        recipients: [
          { to: '+14155550123', params: ['Jane'] },
          { to: '+14155550124' },
        ],
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 202,
        description:
          'Aceptada. Los envíos salen en segundo plano; consulta el progreso.',
        schema: {
          type: 'object',
          additionalProperties: false,
          required: [
            'broadcast_id',
            'status',
            'total_recipients',
            'accepted',
            'rejected',
          ],
          properties: {
            broadcast_id: { type: 'string', format: 'uuid' },
            status: { type: 'string' },
            total_recipients: { type: 'integer', minimum: 0 },
            accepted: { type: 'integer', minimum: 0 },
            rejected: { type: 'integer', minimum: 0 },
          },
        },
        example: {
          broadcast_id: BROADCAST_ID,
          status: 'sending',
          total_recipients: 2,
          accepted: 2,
          rejected: 0,
        },
      },
    ],
    errors: [
      ERR_BAD_REQUEST,
      {
        status: 402,
        code: 'quota_exceeded',
        description:
          'La campaña no cabe en el cupo mensual de destinatarios de difusión que da el plan. No se guarda ni un destinatario.',
      },
    ],
  },
  {
    method: 'get',
    path: '/broadcasts/{id}',
    operationId: 'getBroadcast',
    summary: 'Estado de una difusión',
    description:
      'Estado y contadores. `status` va de `sending` a `sent`; `delivered_count` y `read_count` siguen subiendo a medida que llegan los webhooks de entrega de Meta. Exige `broadcasts:send`: no hay scope de solo lectura para difusiones.',
    tag: 'broadcasts',
    scopes: ['broadcasts:send'],
    parameters: [pathParam('id', 'Id de la difusión.')],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'La difusión.',
        schema: ref('Broadcast'),
        example: {
          id: BROADCAST_ID,
          name: 'Promo de julio',
          template_name: 'promo_july',
          template_language: 'en_US',
          status: 'sent',
          total_recipients: 2,
          sent_count: 2,
          delivered_count: 2,
          read_count: 1,
          replied_count: 0,
          failed_count: 0,
          created_at: '2026-09-16T11:00:00.000Z',
          updated_at: '2026-09-16T11:02:00.000Z',
        },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
];
