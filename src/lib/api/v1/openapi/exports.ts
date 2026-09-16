// ============================================================
// Registro: exportaciones por trabajo.
//
// Tres operaciones. La descarga directa de UNA conversación no está
// aquí: vive en `conversations.ts`, porque cuelga de `/conversations`
// y porque es la única cuyo cuerpo no es el sobre.
//
// `POST /exports` comparte con ella el cubo `exports` (10/hora POR
// CUENTA): las dos hacen el mismo trabajo caro.
// ============================================================

import { ERR_BAD_REQUEST, ERR_NOT_FOUND, pathParam } from './common';
import { EXAMPLE_EXPORT_JOB, ref } from './schemas';
import type { OperationDef } from './types';

export const EXPORTS_OPERATIONS: OperationDef[] = [
  {
    method: 'get',
    path: '/exports',
    operationId: 'listExports',
    summary: 'Listar trabajos de exportación',
    description: 'Tus trabajos, del más nuevo al más viejo.',
    tag: 'exports',
    scopes: ['conversations:export'],
    paginated: true,
    envelope: 'list',
    responses: [
      {
        status: 200,
        description: 'Una página de trabajos.',
        schema: ref('ExportJob'),
        example: [EXAMPLE_EXPORT_JOB],
      },
    ],
    errors: [],
  },
  {
    method: 'post',
    path: '/exports',
    operationId: 'createExport',
    summary: 'Encargar una exportación de muchas conversaciones',
    description:
      'El `202` significa aceptado, no terminado: el archivo se construye justo después de responder, y si ese proceso muere el barrido programado retoma el trabajo. Manda `Idempotency-Key` y un POST reintentado devuelve el MISMO trabajo en vez de encolar un segundo. Las claves desconocidas de `filters` se ignoran; nada de lo que pongas ahí puede ampliar la exportación más allá de tu cuenta. Los archivos y las filas se borran a los 7 días.',
    tag: 'exports',
    scopes: ['conversations:export'],
    extraRateLimits: ['exports'],
    idempotent: true,
    requestBody: {
      required: false,
      description: 'Todo tiene valor por defecto: `{}` es un cuerpo válido.',
      schema: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['conversations'],
            default: 'conversations',
          },
          format: { type: 'string', enum: ['json', 'csv'], default: 'json' },
          filters: {
            type: 'object',
            description:
              'Filtros sobre la conversación. Lo no reconocido se ignora.',
            properties: {
              status: {
                type: 'string',
                enum: ['open', 'pending', 'closed'],
              },
              contact_id: { type: 'string', format: 'uuid' },
              from: {
                type: 'string',
                format: 'date-time',
                description: 'Desde, sobre `created_at` de la conversación.',
              },
              to: {
                type: 'string',
                format: 'date-time',
                description: 'Hasta.',
              },
            },
          },
        },
      },
      example: {
        kind: 'conversations',
        format: 'csv',
        filters: { status: 'closed', from: '2026-01-01T00:00:00Z' },
      },
    },
    envelope: 'data',
    responses: [
      {
        status: 202,
        description: 'Trabajo encolado.',
        schema: ref('ExportJob'),
        example: EXAMPLE_EXPORT_JOB,
      },
    ],
    errors: [ERR_BAD_REQUEST],
  },
  {
    method: 'get',
    path: '/exports/{id}',
    operationId: 'getExport',
    summary: 'Estado de un trabajo y su enlace de descarga',
    description:
      '`status` va de `queued` a `running` y acaba en `done` o `failed`; en `failed`, `error` lo cuenta en lenguaje llano. Con `done` viene `download_url`, **firmado en cada llamada y válido 15 minutos**: pídelo de nuevo cuando lo necesites y no lo guardes en ningún sitio, porque quien lo tenga puede descargar el archivo hasta que caduque.',
    tag: 'exports',
    scopes: ['conversations:export'],
    parameters: [pathParam('id', 'Id del trabajo.')],
    envelope: 'data',
    responses: [
      {
        status: 200,
        description: 'El trabajo, con el enlace si ya está listo.',
        schema: ref('ExportJobWithDownload'),
        example: {
          ...EXAMPLE_EXPORT_JOB,
          status: 'done',
          row_count: 18432,
          finished_at: '2026-09-16T11:05:00.000Z',
          download_url:
            'https://ci.example.supabase.co/storage/v1/object/sign/exports/…',
          download_expires_at: '2026-09-16T11:20:00.000Z',
        },
      },
    ],
    errors: [ERR_NOT_FOUND],
  },
];
