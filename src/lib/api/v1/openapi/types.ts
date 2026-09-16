// ============================================================
// Tipos del documento OpenAPI 3.1 y del registro que lo genera.
//
// Sin dependencias (S-A3): no hay `openapi-types` ni generador de
// terceros. Lo que hay aquí es el subconjunto de OpenAPI 3.1 que este
// contrato usa de verdad, escrito a mano y tipado, más el tipo de
// entrada del registro (`OperationDef`) del que sale el documento.
//
// Estos tipos son el contrato PÚBLICO del módulo: el renderizador de
// `/developers` (a7.7) importa desde aquí — `OpenApiDocument`,
// `OperationObject`, `SchemaObject`, `HttpMethod`, `RateLimitInfo` — en
// vez de re-declararlos o de tratar el documento como `unknown`.
// ============================================================

import type { ApiScope } from '@/lib/api-keys/scopes';
import type { ApiErrorCode } from '@/lib/api/v1/respond';

// ------------------------------------------------------------------
// JSON Schema (el dialecto que usa OpenAPI 3.1)
// ------------------------------------------------------------------

/** Los tipos JSON que aparecen en este contrato. */
export type JsonSchemaType =
  'string' | 'number' | 'integer' | 'boolean' | 'object' | 'array' | 'null';

/**
 * Esquema JSON. OpenAPI 3.1 ES JSON Schema 2020-12, así que la
 * nulabilidad se expresa con `type: ['string', 'null']` y no con el
 * `nullable: true` de 3.0 (que ya no existe).
 *
 * `additionalProperties: false` se usa a propósito solo donde el
 * cuerpo es cerrado de verdad. La API ignora campos desconocidos en
 * las entradas, así que los esquemas de petición lo dejan abierto;
 * los de respuesta, que sí describen todo lo que sale, lo cierran.
 */
export interface SchemaObject {
  $ref?: string;
  type?: JsonSchemaType | JsonSchemaType[];
  format?: string;
  title?: string;
  description?: string;
  enum?: readonly (string | number | boolean | null)[];
  const?: string | number | boolean | null;
  properties?: Record<string, SchemaObject>;
  required?: readonly string[];
  additionalProperties?: boolean | SchemaObject;
  items?: SchemaObject;
  oneOf?: SchemaObject[];
  anyOf?: SchemaObject[];
  allOf?: SchemaObject[];
  minimum?: number;
  maximum?: number;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  default?: unknown;
  example?: unknown;
  examples?: unknown[];
  deprecated?: boolean;
}

// ------------------------------------------------------------------
// Objetos del documento
// ------------------------------------------------------------------

export interface MediaTypeObject {
  schema: SchemaObject;
  example?: unknown;
}

export interface HeaderObject {
  description: string;
  schema: SchemaObject;
  required?: boolean;
}

export interface ParameterObject {
  name: string;
  in: 'query' | 'path' | 'header';
  description: string;
  required?: boolean;
  schema: SchemaObject;
  example?: unknown;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, HeaderObject>;
  content?: Record<string, MediaTypeObject>;
}

/** Cubo de rate limit que se aplica a una operación. */
export interface RateLimitInfo {
  /** Clave de `RATE_LIMITS` en `src/lib/rate-limit.ts`. */
  bucket: string;
  limit: number;
  window_seconds: number;
  /** `key` = por clave de API; `account` = compartido por la cuenta. */
  per: 'key' | 'account';
}

export interface OperationObject {
  operationId: string;
  summary: string;
  description?: string;
  tags: string[];
  parameters?: ParameterObject[];
  requestBody?: RequestBodyObject;
  responses: Record<string, ResponseObject>;
  security?: Record<string, string[]>[];
  /**
   * Extensión propia: los scopes que la operación exige. El esquema de
   * seguridad es `http`/`bearer`, y en 3.1 una exigencia de seguridad
   * de tipo `http` debe llevar la lista de scopes VACÍA (los nombres
   * solo son legales en `oauth2` / `openIdConnect`). Poner los scopes
   * en `security` haría un documento inválido; por eso van aquí.
   * Lista vacía = basta con una clave válida (`GET /me`).
   */
  'x-scopes': ApiScope[];
  /** Extensión propia: cubos de rate limit aplicables, en orden. */
  'x-rate-limits': RateLimitInfo[];
  /** Extensión propia: la operación acepta `Idempotency-Key`. */
  'x-idempotent'?: boolean;
}

export type PathItemObject = Partial<Record<HttpMethod, OperationObject>>;

export type HttpMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

export const HTTP_METHODS: readonly HttpMethod[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
] as const;

export interface TagObject {
  name: string;
  description: string;
}

export interface SecuritySchemeObject {
  type: 'http';
  scheme: 'bearer';
  description: string;
}

export interface OpenApiDocument {
  openapi: '3.1.0';
  info: {
    title: string;
    version: string;
    summary?: string;
    description: string;
    license?: { name: string; identifier?: string };
  };
  servers: { url: string; description: string }[];
  tags: TagObject[];
  security: Record<string, string[]>[];
  paths: Record<string, PathItemObject>;
  webhooks: Record<string, PathItemObject>;
  /**
   * Solo `securitySchemes` y `schemas`. Las respuestas, los parámetros
   * y las cabeceras van EN LÍNEA en cada operación a propósito: así el
   * único `$ref` que un renderizador (o un generador de SDK) tiene que
   * resolver es `#/components/schemas/…`, y una operación se puede leer
   * entera sin saltar por el documento.
   */
  components: {
    securitySchemes: Record<string, SecuritySchemeObject>;
    schemas: Record<string, SchemaObject>;
  };
  /** Extensión propia: el vocabulario de scopes, con su descripción. */
  'x-scope-descriptions': Record<string, string>;
}

// ------------------------------------------------------------------
// Registro: lo que escribe cada archivo de recurso
// ------------------------------------------------------------------

/** Una respuesta de éxito declarada por una operación. */
export interface SuccessResponseDef {
  status: number;
  description: string;
  /**
   * Esquema del PAYLOAD, no del sobre: `envelope` decide si se
   * envuelve en `{ data }`, en `{ data, meta }` o si va crudo.
   */
  schema: SchemaObject;
  example?: unknown;
  /** Por defecto `application/json`. */
  mediaTypes?: string[];
  headers?: Record<string, HeaderObject>;
}

/**
 * Forma de la respuesta:
 *   - `data`  → `{ "data": <payload> }`
 *   - `list`  → `{ "data": [...], "meta": { "next_cursor": … } }`
 *   - `raw`   → el cuerpo ES el payload (solo el export directo).
 */
export type EnvelopeKind = 'data' | 'list' | 'raw';

/** Una operación del registro, antes de expandirse a OpenAPI. */
export interface OperationDef {
  method: HttpMethod;
  /** Ruta bajo `/api/v1`, con `{id}` para los segmentos dinámicos. */
  path: string;
  operationId: string;
  summary: string;
  description: string;
  tag: string;
  /** `[]` = solo hace falta una clave válida. */
  scopes: ApiScope[];
  /** Cubos propios que se SUMAN al `publicApi` general. */
  extraRateLimits?: string[];
  /** La operación acepta `Idempotency-Key`. */
  idempotent?: boolean;
  /** Añade `limit` y `cursor` y el sobre con `meta.next_cursor`. */
  paginated?: boolean;
  /** Escritura con cuerpo JSON: añade 400/413/415 y el cuerpo. */
  requestBody?: {
    description?: string;
    schema: SchemaObject;
    example?: unknown;
    required?: boolean;
  };
  parameters?: ParameterObject[];
  envelope: EnvelopeKind;
  responses: SuccessResponseDef[];
  /** Códigos de error concretos que esta operación puede devolver. */
  errors: ErrorResponseDef[];
}

/**
 * Un error declarado por una operación. `code` acepta cualquier
 * cadena porque el sobre de error lo permite (`fail()`): los códigos
 * de dominio (`meta_error`, `whatsapp_not_configured`) no están en
 * `ApiErrorCode` y aun así viajan por el mismo sobre.
 */
export interface ErrorResponseDef {
  status: number;
  code: ApiErrorCode | (string & {});
  description: string;
}
