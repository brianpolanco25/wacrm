// ============================================================
// Generador del documento OpenAPI 3.1 de `/api/v1`.
//
// Toma el registro (un archivo por recurso) y lo expande al documento
// completo: sobres, errores, cabeceras, paginación, idempotencia,
// cubos de rate limit y la sección `webhooks`. Nada de esto se escribe
// a mano en los archivos de recurso — se declara una vez aquí, así que
// una operación nueva hereda el contrato entero sin poder olvidárselo.
//
// Sin dependencias (S-A3): esto es construcción de objetos planos.
// ============================================================

import { API_SCOPES, SCOPE_DESCRIPTIONS } from '@/lib/api-keys/scopes';
import { RATE_LIMITS } from '@/lib/rate-limit';
import { BROADCASTS_OPERATIONS } from './broadcasts';
import { CONTACTS_OPERATIONS } from './contacts';
import { CONVERSATIONS_OPERATIONS } from './conversations';
import { EXPORTS_OPERATIONS } from './exports';
import { ME_OPERATIONS } from './me';
import { MESSAGES_OPERATIONS } from './messages';
import { COMPONENT_SCHEMAS, ref } from './schemas';
import { TAGS_OPERATIONS } from './tags';
import { TEMPLATES_OPERATIONS } from './templates';
import { buildWebhookEntries } from './webhook-events';
import { WEBHOOKS_OPERATIONS } from './webhooks';
import type {
  ErrorResponseDef,
  HeaderObject,
  OpenApiDocument,
  OperationDef,
  OperationObject,
  ParameterObject,
  ResponseObject,
  SchemaObject,
} from './types';

/** Versión del CONTRATO, no de la aplicación: `/api/v1` es la v1. */
export const OPENAPI_API_VERSION = '1.0.0';

/** Prefijo bajo el que viven todas las rutas del registro. */
export const API_BASE_PATH = '/api/v1';

/** El esquema de seguridad, uno solo: `Authorization: Bearer <clave>`. */
export const SECURITY_SCHEME_NAME = 'bearer';

/**
 * El registro completo, en el orden en que se leen los recursos. Un
 * archivo por recurso; aquí solo se concatenan.
 */
export const ALL_OPERATIONS: OperationDef[] = [
  ...ME_OPERATIONS,
  ...CONTACTS_OPERATIONS,
  ...TAGS_OPERATIONS,
  ...CONVERSATIONS_OPERATIONS,
  ...MESSAGES_OPERATIONS,
  ...BROADCASTS_OPERATIONS,
  ...TEMPLATES_OPERATIONS,
  ...EXPORTS_OPERATIONS,
  ...WEBHOOKS_OPERATIONS,
];

const TAG_DESCRIPTIONS: Record<string, string> = {
  me: 'Identidad de la clave.',
  contacts: 'Contactos.',
  tags: 'Etiquetas y su asignación a contactos.',
  conversations: 'Conversaciones y la descarga directa de una de ellas.',
  messages: 'Enviar mensajes y leer el hilo de una conversación.',
  broadcasts: 'Campañas por plantilla.',
  templates: 'Plantillas de mensaje y su sincronización con Meta.',
  exports: 'Exportaciones por trabajo, con archivo en almacenamiento privado.',
  webhooks: 'Receptores de eventos salientes.',
  'webhook-events': 'Los eventos que este servidor entrega a tu receptor.',
};

// ------------------------------------------------------------------
// Cabeceras
// ------------------------------------------------------------------

/** En TODA respuesta de `/api/v1`, éxito o error. */
const UNIVERSAL_RESPONSE_HEADERS: Record<string, HeaderObject> = {
  'X-Request-Id': {
    description:
      'Identificador de correlación que acuña el servidor para esta llamada, y que se repite como `request_id` dentro de todo sobre de error. Lo que mandes tú con este nombre se ignora.',
    required: true,
    schema: { type: 'string', format: 'uuid' },
  },
  'Cache-Control': {
    description:
      'Siempre `no-store`: son datos de una cuenta detrás de una credencial portadora y no deben quedar en ninguna caché.',
    required: true,
    schema: { type: 'string' },
  },
};

const IDEMPOTENT_REPLAYED_HEADER: Record<string, HeaderObject> = {
  'Idempotent-Replayed': {
    description:
      '`true` cuando la respuesta se reprodujo del almacén de idempotencia y NADA volvió a ejecutarse. Ausente en la primera llamada.',
    schema: { type: 'string', enum: ['true'] },
  },
};

const RATE_LIMIT_HEADERS: Record<string, HeaderObject> = {
  'Retry-After': {
    description: 'Segundos hasta que la ventana se reinicia.',
    required: true,
    schema: { type: 'string' },
  },
  'X-RateLimit-Limit': {
    description: 'Peticiones permitidas en la ventana.',
    schema: { type: 'string' },
  },
  'X-RateLimit-Remaining': {
    description: 'Peticiones que quedan en la ventana.',
    schema: { type: 'string' },
  },
  'X-RateLimit-Reset': {
    description: 'Momento del reinicio, en segundos unix.',
    schema: { type: 'string' },
  },
};

// ------------------------------------------------------------------
// Parámetros comunes
// ------------------------------------------------------------------

const PAGINATION_PARAMS: ParameterObject[] = [
  {
    name: 'limit',
    in: 'query',
    description: 'Tamaño de página. Se recorta a [1, 100].',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 50 },
  },
  {
    name: 'cursor',
    in: 'query',
    description:
      'Cursor opaco de `meta.next_cursor` de la página anterior. Se pasa tal cual, no se interpreta. Un cursor mal formado se trata como ausente: se vuelve a la primera página, nunca se ejecuta una consulta con su forma.',
    required: false,
    schema: { type: 'string' },
  },
];

const IDEMPOTENCY_KEY_PARAM: ParameterObject = {
  name: 'Idempotency-Key',
  in: 'header',
  description:
    'Clave de idempotencia de 1–255 caracteres, elegida por ti y derivada de LO QUE HACES (un id de pedido, un id de trabajo), no aleatoria por intento: la gracia está en que el reintento mande la misma. Misma clave y mismo cuerpo devuelven la respuesta guardada con `Idempotent-Replayed: true`; misma clave y cuerpo distinto es `409 idempotency_mismatch`; con la primera llamada aún en vuelo es `409 conflict` (reintenta en un momento: una reserva sin respuesta a los dos minutos se da por abandonada). Solo se guardan las respuestas 2xx, así que un 400 o un 500 liberan la clave. La clave es de TU clave de API, y la misma contra otra ruta o con otra query es `idempotency_mismatch`. A las 24 h se trata como nueva.',
  required: false,
  schema: { type: 'string', minLength: 1, maxLength: 255 },
};

// ------------------------------------------------------------------
// Errores
// ------------------------------------------------------------------

/** Los que puede devolver CUALQUIER operación (los pone `requireApiKey`). */
function universalErrors(op: OperationDef): ErrorResponseDef[] {
  const out: ErrorResponseDef[] = [
    {
      status: 401,
      code: 'unauthorized',
      description:
        'Clave ausente, mal formada, desconocida, revocada o caducada. Los cuatro casos responden igual a propósito: una sonda no debe poder averiguar si una clave existió.',
    },
    {
      status: 402,
      code: 'feature_unavailable',
      description:
        'El plan de la cuenta no incluye la API. La clave sigue siendo válida: subir de plan devuelve el acceso sin tocar nada.',
    },
    {
      status: 429,
      code: 'rate_limited',
      description:
        'Presupuesto agotado. Las cabeceras dicen cuándo reintentar.',
    },
    {
      status: 500,
      code: 'internal',
      description:
        'Error del servidor. El mensaje es genérico a propósito; `request_id` es lo que lleva al registro.',
    },
  ];
  if (op.scopes.length > 0) {
    out.push({
      status: 403,
      code: 'forbidden',
      description: `La clave es válida pero le falta el scope \`${op.scopes.join('`, `')}\`.`,
    });
  }
  if (op.method !== 'get') {
    out.push({
      status: 403,
      code: 'account_read_only',
      description:
        'La cuenta está en solo lectura (suscripción suspendida o vencida, o retención manual del operador): sus claves siguen LEYENDO y dejan de escribir.',
    });
  }
  if (op.requestBody) {
    out.push(
      {
        status: 400,
        code: 'bad_request',
        description:
          'El cuerpo no es un objeto JSON, o un campo tiene el tipo equivocado (el mensaje lo nombra). Los campos desconocidos se ignoran, no fallan.',
      },
      {
        status: 413,
        code: 'payload_too_large',
        description: 'El cuerpo pasa del tope de 1 MiB.',
      },
      {
        status: 415,
        code: 'unsupported_media_type',
        description: 'Falta `Content-Type: application/json`.',
      }
    );
  }
  if (op.idempotent) {
    out.push(
      {
        status: 409,
        code: 'conflict',
        description:
          'Otra llamada con esa `Idempotency-Key` está en vuelo. Reintenta en un momento.',
      },
      {
        status: 409,
        code: 'idempotency_mismatch',
        description:
          'Esa `Idempotency-Key` se usó para una petición distinta (otro cuerpo, otra ruta u otra query).',
      }
    );
  }
  return out;
}

/** Los códigos 402 viajan con los campos extra del sobre de facturación. */
const BILLING_STATUSES = new Set([402]);

function errorSchemaFor(status: number): SchemaObject {
  return BILLING_STATUSES.has(status) ? ref('BillingError') : ref('Error');
}

const EXAMPLE_REQUEST_ID = 'c0ffee00-1111-4222-8333-444455556666';

/**
 * El `message` del ejemplo se saca de la primera frase de la
 * descripción, sin el marcado: un ejemplo tiene que parecerse a una
 * respuesta real, y una respuesta real no lleva backticks ni tres
 * párrafos de contrato.
 */
function exampleMessage(description: string): string {
  const firstSentence = description.split(/(?<=\.)\s/)[0] ?? description;
  return firstSentence.replace(/[`*]/g, '').trim();
}

function errorExample(def: ErrorResponseDef): unknown {
  return {
    error: {
      code: def.code,
      message: exampleMessage(def.description),
      request_id: EXAMPLE_REQUEST_ID,
    },
  };
}

function billingExample(def: ErrorResponseDef): unknown {
  return {
    error: {
      code: def.code,
      message: exampleMessage(def.description),
      upgradeUrl: '/billing',
      request_id: EXAMPLE_REQUEST_ID,
    },
  };
}

/**
 * Un status HTTP = UNA respuesta en OpenAPI. Cuando varios códigos
 * comparten status (403 `forbidden` y `account_read_only`, 409
 * `conflict` e `idempotency_mismatch`, 402 `feature_unavailable` y
 * `quota_exceeded`) se funden en una sola entrada que los enumera, en
 * vez de perder uno por el camino.
 */
function buildErrorResponses(
  defs: ErrorResponseDef[]
): Record<string, ResponseObject> {
  const byStatus = new Map<number, ErrorResponseDef[]>();
  for (const def of defs) {
    const list = byStatus.get(def.status) ?? [];
    // Un código repetido (declarado por la operación y por el generador)
    // se queda con la redacción de la operación, que es la específica.
    if (!list.some((d) => d.code === def.code)) list.push(def);
    byStatus.set(def.status, list);
  }

  const out: Record<string, ResponseObject> = {};
  for (const [status, list] of [...byStatus.entries()].sort(
    (a, b) => a[0] - b[0]
  )) {
    const description = list
      .map((d) => `\`${d.code}\` — ${d.description}`)
      .join('\n\n');
    const first = list[0];
    out[String(status)] = {
      description,
      headers: {
        ...UNIVERSAL_RESPONSE_HEADERS,
        ...(status === 429 ? RATE_LIMIT_HEADERS : {}),
      },
      content: {
        'application/json': {
          schema: errorSchemaFor(status),
          example: BILLING_STATUSES.has(status)
            ? billingExample(first)
            : errorExample(first),
        },
      },
    };
  }
  return out;
}

// ------------------------------------------------------------------
// Sobres
// ------------------------------------------------------------------

function wrapSchema(op: OperationDef, payload: SchemaObject): SchemaObject {
  if (op.envelope === 'raw') return payload;
  if (op.envelope === 'list') {
    return {
      type: 'object',
      additionalProperties: false,
      required: ['data', 'meta'],
      properties: {
        data: { type: 'array', items: payload },
        meta: ref('PaginationMeta'),
      },
    };
  }
  return {
    type: 'object',
    additionalProperties: false,
    required: ['data'],
    properties: { data: payload },
  };
}

function wrapExample(op: OperationDef, example: unknown): unknown {
  if (op.envelope === 'raw') return example;
  if (op.envelope === 'list') {
    return { data: example, meta: { next_cursor: null } };
  }
  return { data: example };
}

// ------------------------------------------------------------------
// Rate limits
// ------------------------------------------------------------------

type RateLimitKey = keyof typeof RATE_LIMITS;

/**
 * El cubo general `publicApi` va POR CLAVE y lo aplica `requireApiKey`
 * a toda operación; los propios (`exports`, `templatesSync`,
 * `webhookAction`) van POR CUENTA y se SUMAN, no sustituyen. Dos
 * claves de la misma empresa comparten los propios y no el general.
 */
function rateLimitsFor(op: OperationDef) {
  const describe = (bucket: string, per: 'key' | 'account') => {
    const config = RATE_LIMITS[bucket as RateLimitKey];
    return {
      bucket,
      limit: config.limit,
      window_seconds: Math.round(config.windowMs / 1000),
      per,
    };
  };
  return [
    describe('publicApi', 'key'),
    ...(op.extraRateLimits ?? []).map((bucket) => describe(bucket, 'account')),
  ];
}

// ------------------------------------------------------------------
// Operación
// ------------------------------------------------------------------

function buildOperation(op: OperationDef): OperationObject {
  const parameters: ParameterObject[] = [
    ...(op.parameters ?? []),
    ...(op.paginated ? PAGINATION_PARAMS : []),
    ...(op.idempotent ? [IDEMPOTENCY_KEY_PARAM] : []),
  ];

  const responses: Record<string, ResponseObject> = {};
  for (const success of op.responses) {
    const mediaTypes = success.mediaTypes ?? ['application/json'];
    const schema = wrapSchema(op, success.schema);
    const example =
      success.example === undefined
        ? undefined
        : wrapExample(op, success.example);
    responses[String(success.status)] = {
      description: success.description,
      headers: {
        ...UNIVERSAL_RESPONSE_HEADERS,
        ...(op.idempotent ? IDEMPOTENT_REPLAYED_HEADER : {}),
        ...(success.headers ?? {}),
      },
      content: Object.fromEntries(
        mediaTypes.map((mediaType) => [
          mediaType,
          // Un CSV no se describe con un esquema JSON: se declara como
          // cadena. El esquema real es el del cuerpo JSON.
          mediaType === 'text/csv'
            ? {
                schema: {
                  type: 'string' as const,
                  description:
                    'Una fila por mensaje, con `conversation_id` como primera columna. Las celdas que empiezan por `=`, `+`, `-` o `@` llevan una comilla simple delante.',
                },
              }
            : { schema, ...(example === undefined ? {} : { example }) },
        ])
      ),
    };
  }

  Object.assign(
    responses,
    buildErrorResponses([...op.errors, ...universalErrors(op)])
  );

  return {
    operationId: op.operationId,
    summary: op.summary,
    description: op.description,
    tags: [op.tag],
    ...(parameters.length > 0 ? { parameters } : {}),
    ...(op.requestBody
      ? {
          requestBody: {
            description: op.requestBody.description,
            required: op.requestBody.required ?? true,
            content: {
              'application/json': {
                schema: op.requestBody.schema,
                ...(op.requestBody.example === undefined
                  ? {}
                  : { example: op.requestBody.example }),
              },
            },
          },
        }
      : {}),
    responses,
    'x-scopes': op.scopes,
    'x-rate-limits': rateLimitsFor(op),
    ...(op.idempotent ? { 'x-idempotent': true } : {}),
  };
}

// ------------------------------------------------------------------
// Documento
// ------------------------------------------------------------------

const INFO_DESCRIPTION = `
API pública de Cabbity CRM. Se autentica con una clave por cuenta
(\`Authorization: Bearer wacrm_live_…\`) creada desde **Ajustes → API** del
panel: una clave nunca puede fabricar otra clave.

**Sobre.** El éxito es \`{ "data": … }\` y el fallo
\`{ "error": { "code", "message", "request_id" } }\`. Se ramifica sobre
\`code\`, que es estable; \`message\` es para personas y puede reescribirse.
La única excepción es \`GET /conversations/{id}/export\`, donde el cuerpo ES
el archivo — sus errores sí vuelven en el sobre.

**Cabeceras.** Toda respuesta lleva \`X-Request-Id\` (el mismo valor que
\`request_id\` en el sobre de error) y \`Cache-Control: no-store\`.

**Escrituras.** Exigen \`Content-Type: application/json\` y un objeto JSON,
con tope de 1 MiB. Los campos desconocidos se ignoran.

**Paginación.** Las listas son de cursor: \`?limit=\` (por defecto 50, máximo
100) y \`?cursor=\` con el \`meta.next_cursor\` de la respuesta anterior. El
cursor es opaco: se devuelve tal cual, no se interpreta. \`next_cursor: null\`
es la última página.

**Límites.** 120 peticiones por minuto y por CLAVE. Las operaciones caras
llevan además un cubo propio POR CUENTA, que se suma: exportaciones (10/hora),
sincronización de plantillas (6/min) y las tres acciones de webhook —probar,
reintentar, rotar— (20/min). El limitador es en memoria y por proceso: un
despliegue de varias instancias necesita cambiarlo por un almacén compartido.

**Idempotencia.** Las creaciones aceptan \`Idempotency-Key\`; ver el parámetro
en cada operación.

**Webhooks.** La sección \`webhooks\` de este documento describe lo que ESTE
servidor envía a tu receptor: un sobre por evento y las cabeceras \`X-Wacrm-*\`,
con \`X-Wacrm-Signature\` para verificar la firma.

Sin CORS: la API es de servidor a servidor.
`.trim();

export interface BuildOpenApiOptions {
  /**
   * URL base del servidor. Por defecto `/api/v1`, relativa: un cliente
   * que importa este documento desde `https://tu-crm/api/v1/openapi.json`
   * la resuelve contra esa misma instancia, que es siempre la correcta.
   */
  serverUrl?: string;
}

/**
 * Construye el documento completo. Es una función pura: mismas
 * entradas, mismo objeto — de lo que depende el `ETag` de la ruta.
 */
export function buildOpenApiDocument(
  options: BuildOpenApiOptions = {}
): OpenApiDocument {
  const paths: Record<string, OpenApiDocument['paths'][string]> = {};
  for (const op of ALL_OPERATIONS) {
    const fullPath = `${API_BASE_PATH}${op.path}`;
    const item = paths[fullPath] ?? {};
    if (item[op.method]) {
      throw new Error(
        `Operación duplicada en el registro: ${op.method.toUpperCase()} ${fullPath}`
      );
    }
    item[op.method] = buildOperation(op);
    paths[fullPath] = item;
  }

  const usedTags = new Set(ALL_OPERATIONS.map((op) => op.tag));
  usedTags.add('webhook-events');

  return {
    openapi: '3.1.0',
    info: {
      title: 'Cabbity CRM — API pública',
      version: OPENAPI_API_VERSION,
      summary:
        'Mensajes, contactos, etiquetas, conversaciones, difusiones, plantillas, exportaciones y webhooks.',
      description: INFO_DESCRIPTION,
      license: { name: 'MIT', identifier: 'MIT' },
    },
    servers: [
      {
        url: options.serverUrl ?? API_BASE_PATH,
        description: 'Esta instancia.',
      },
    ],
    tags: [...usedTags].map((name) => ({
      name,
      description: TAG_DESCRIPTIONS[name] ?? name,
    })),
    security: [{ [SECURITY_SCHEME_NAME]: [] }],
    paths,
    webhooks: buildWebhookEntries(),
    components: {
      securitySchemes: {
        [SECURITY_SCHEME_NAME]: {
          type: 'http',
          scheme: 'bearer',
          description:
            'Clave de API de la cuenta: `Authorization: Bearer wacrm_live_…`. Se crea en Ajustes → API (solo admin y propietario) y solo se ve entera una vez. Los permisos los fijan sus scopes, que van en la extensión `x-scopes` de cada operación.',
        },
      },
      schemas: {
        ...COMPONENT_SCHEMAS,
        BillingError: {
          title: 'BillingError',
          description:
            'Sobre de fallo de facturación: el de siempre, más los campos que dicen qué límite se tocó y dónde se arregla.',
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['code', 'message', 'request_id', 'upgradeUrl'],
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
                request_id: { type: 'string', format: 'uuid' },
                upgradeUrl: {
                  type: 'string',
                  description: 'Dónde se sube de plan. Siempre `/billing`.',
                },
                metric: { type: 'string' },
                limit: { type: 'integer' },
                used: { type: 'integer' },
                feature: { type: 'string' },
                subscriptionStatus: { type: 'string' },
                manualHold: { type: 'boolean' },
              },
            },
          },
        },
      },
    },
    'x-scope-descriptions': Object.fromEntries(
      API_SCOPES.map((scope) => [scope, SCOPE_DESCRIPTIONS[scope]])
    ),
  };
}
