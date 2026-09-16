// ============================================================
// Subconjunto tipado de OpenAPI 3.1 — solo lo que la referencia de
// /developers sabe pintar.
//
// No es un validador ni pretende cubrir la especificación entera: es el
// contrato que este renderizador consume, escrito a mano porque S-A3 no
// admite dependencias nuevas. Lo que no esté aquí, el documento lo puede
// traer igual (los campos desconocidos se ignoran), simplemente no se
// dibuja.
// ============================================================

export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

export interface ReferenceObject {
  $ref: string;
}

export type MaybeRef<T> = T | ReferenceObject;

export function isReference(node: unknown): node is ReferenceObject {
  return (
    typeof node === 'object' &&
    node !== null &&
    typeof (node as ReferenceObject).$ref === 'string'
  );
}

export interface SchemaObject {
  /** En 3.1 el tipo puede ser una lista: `["string", "null"]`. */
  type?: string | string[];
  format?: string;
  title?: string;
  description?: string;
  enum?: JsonValue[];
  const?: JsonValue;
  default?: JsonValue;
  example?: JsonValue;
  examples?: JsonValue[];
  items?: MaybeRef<SchemaObject>;
  properties?: Record<string, MaybeRef<SchemaObject>>;
  required?: string[];
  additionalProperties?: boolean | MaybeRef<SchemaObject>;
  oneOf?: MaybeRef<SchemaObject>[];
  anyOf?: MaybeRef<SchemaObject>[];
  allOf?: MaybeRef<SchemaObject>[];
  nullable?: boolean;
  deprecated?: boolean;
  minimum?: number;
  maximum?: number;
  maxLength?: number;
  minLength?: number;
}

export interface ExampleObject {
  summary?: string;
  description?: string;
  value?: JsonValue;
}

export interface MediaTypeObject {
  schema?: MaybeRef<SchemaObject>;
  example?: JsonValue;
  examples?: Record<string, MaybeRef<ExampleObject>>;
}

export type ParameterLocation = 'query' | 'path' | 'header' | 'cookie';

export interface ParameterObject {
  name: string;
  in: ParameterLocation;
  description?: string;
  required?: boolean;
  deprecated?: boolean;
  schema?: MaybeRef<SchemaObject>;
  example?: JsonValue;
}

export interface RequestBodyObject {
  description?: string;
  required?: boolean;
  content: Record<string, MediaTypeObject>;
}

export interface HeaderObject {
  description?: string;
  schema?: MaybeRef<SchemaObject>;
}

export interface ResponseObject {
  description: string;
  headers?: Record<string, MaybeRef<HeaderObject>>;
  content?: Record<string, MediaTypeObject>;
}

/** `{ bearerAuth: ['messages:send'] }` — esquema → scopes exigidos. */
export type SecurityRequirementObject = Record<string, string[]>;

export interface OperationObject {
  operationId?: string;
  summary?: string;
  description?: string;
  tags?: string[];
  deprecated?: boolean;
  parameters?: MaybeRef<ParameterObject>[];
  requestBody?: MaybeRef<RequestBodyObject>;
  responses: Record<string, MaybeRef<ResponseObject>>;
  security?: SecurityRequirementObject[];
  /**
   * Extensiones propias del documento de esta API. `x-scopes` repite en
   * claro los scopes de `security` (que van dentro del esquema `bearer`)
   * y `x-idempotent` marca las escrituras que aceptan `Idempotency-Key`.
   */
  'x-scopes'?: string[];
  'x-idempotent'?: boolean;
}

export const HTTP_METHODS = [
  'get',
  'put',
  'post',
  'delete',
  'patch',
  'head',
  'options',
  'trace',
] as const;

export type HttpMethod = (typeof HTTP_METHODS)[number];

export type PathItemObject = {
  summary?: string;
  description?: string;
  parameters?: MaybeRef<ParameterObject>[];
} & Partial<Record<HttpMethod, OperationObject>>;

export interface TagObject {
  name: string;
  description?: string;
}

export interface ServerObject {
  url: string;
  description?: string;
}

export interface ComponentsObject {
  schemas?: Record<string, SchemaObject>;
  parameters?: Record<string, ParameterObject>;
  responses?: Record<string, ResponseObject>;
  requestBodies?: Record<string, RequestBodyObject>;
  /**
   * La referencia NO pinta los esquemas de seguridad —los scopes salen
   * de `x-scopes`—, así que aquí solo se declara que existen. Tiparlos
   * a fondo obligaría a copiar la forma del generador sin ganar nada.
   */
  securitySchemes?: Record<string, unknown>;
}

export interface OpenApiDocument {
  openapi: string;
  info: {
    title: string;
    version: string;
    summary?: string;
    description?: string;
  };
  servers?: ServerObject[];
  tags?: TagObject[];
  security?: SecurityRequirementObject[];
  paths: Record<string, PathItemObject>;
  /** Eventos salientes, sección propia de OpenAPI 3.1. */
  webhooks?: Record<string, PathItemObject>;
  components?: ComponentsObject;
}
