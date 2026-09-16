import {
  HTTP_METHODS,
  isReference,
  type ExampleObject,
  type HttpMethod,
  type JsonValue,
  type MaybeRef,
  type MediaTypeObject,
  type OpenApiDocument,
  type OperationObject,
  type ParameterLocation,
  type ParameterObject,
  type PathItemObject,
  type RequestBodyObject,
  type ResponseObject,
  type SchemaObject,
} from './types';

// ============================================================
// De documento OpenAPI 3.1 a modelo de presentación.
//
// Todo lo que decide qué se enseña vive aquí, en funciones puras, y no
// en el JSX: así el test puede afirmar "la referencia contiene las 37
// operaciones del documento" sin renderizar nada, y el renderizador se
// queda con la parte que solo sabe de clases de CSS.
// ============================================================

export interface FieldRow {
  /** Ruta del campo, con puntos para lo anidado: `template.name`. */
  name: string;
  type: string;
  required: boolean;
  description?: string;
}

export interface ParamRow extends FieldRow {
  in: ParameterLocation;
}

export interface BodyModel {
  required: boolean;
  description?: string;
  contentType: string;
  fields: FieldRow[];
  example?: string;
}

export interface ResponseRow {
  status: string;
  description: string;
  contentType?: string;
  fields: FieldRow[];
  example?: string;
}

export interface ReferenceOperation {
  /** Ancla estable: `post-api-v1-messages`. */
  id: string;
  method: HttpMethod;
  path: string;
  summary: string;
  description?: string;
  scopes: string[];
  idempotent: boolean;
  deprecated: boolean;
  parameters: ParamRow[];
  requestBody?: BodyModel;
  responses: ResponseRow[];
  curl: string;
}

export interface ReferenceSection {
  id: string;
  name: string;
  description?: string;
  operations: ReferenceOperation[];
}

export interface WebhookEntry {
  id: string;
  event: string;
  summary?: string;
  description?: string;
  fields: FieldRow[];
  example?: string;
}

export interface ReferenceModel {
  title: string;
  version: string;
  description?: string;
  server?: string;
  sections: ReferenceSection[];
  webhooks: WebhookEntry[];
  /** Todas las operaciones, en el orden en que se pintan. */
  operations: ReferenceOperation[];
}

/** Sección a la que van las operaciones que no declaran `tags`. */
const UNTAGGED = 'API';

/** Profundidad máxima al aplanar un esquema en filas de tabla. */
const MAX_DEPTH = 2;

// ------------------------------------------------------------
// Referencias
// ------------------------------------------------------------

/**
 * Resuelve un `$ref` local (`#/components/schemas/Contact`). Un `$ref`
 * remoto o roto devuelve `undefined` en vez de lanzar: la referencia se
 * dibuja con lo que hay, y una sección incompleta es mejor página que un
 * 500.
 */
export function resolveRef<T>(
  doc: OpenApiDocument,
  node: MaybeRef<T> | undefined
): T | undefined {
  if (node === undefined) return undefined;
  if (!isReference(node)) return node;
  if (!node.$ref.startsWith('#/')) return undefined;
  let current: unknown = doc;
  for (const rawSegment of node.$ref.slice(2).split('/')) {
    const segment = rawSegment.replace(/~1/g, '/').replace(/~0/g, '~');
    if (typeof current !== 'object' || current === null) return undefined;
    current = (current as Record<string, unknown>)[segment];
  }
  return current === undefined ? undefined : (current as T);
}

/** Nombre del esquema al que apunta un `$ref`, para etiquetar el tipo. */
function refName(node: unknown): string | undefined {
  return isReference(node) ? node.$ref.split('/').pop() : undefined;
}

// ------------------------------------------------------------
// Esquemas
// ------------------------------------------------------------

/** Etiqueta legible del tipo de un esquema (`string`, `array<Contact>`…). */
export function typeLabel(
  doc: OpenApiDocument,
  node: MaybeRef<SchemaObject> | undefined
): string {
  const named = refName(node);
  const schema = resolveRef<SchemaObject>(doc, node);
  if (!schema) return named ?? 'any';
  if (named) return named;

  const composed = schema.oneOf ?? schema.anyOf;
  if (composed && composed.length > 0) {
    return composed.map((member) => typeLabel(doc, member)).join(' | ');
  }
  if (schema.allOf && schema.allOf.length > 0) {
    return schema.allOf.map((member) => typeLabel(doc, member)).join(' + ');
  }

  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.includes('array')) {
    const item = typeLabel(doc, schema.items);
    const rest = types.filter((t) => t !== 'array');
    return [`array<${item}>`, ...rest].join(' | ');
  }
  if (schema.enum && schema.enum.length > 0) {
    return `enum: ${schema.enum.map((value) => String(value)).join(' | ')}`;
  }
  if (types.length > 0) {
    return schema.format
      ? `${types.join(' | ')} (${schema.format})`
      : types.join(' | ');
  }
  if (schema.properties) return 'object';
  return 'any';
}

function schemaOf(
  doc: OpenApiDocument,
  node: MaybeRef<SchemaObject> | undefined
): SchemaObject | undefined {
  const resolved = resolveRef<SchemaObject>(doc, node);
  if (!resolved) return undefined;
  // `allOf` se aplana en un solo objeto para poder listar sus campos:
  // es la forma normal de expresar "esto más aquello" en un esquema.
  if (resolved.allOf && resolved.allOf.length > 0) {
    const merged: SchemaObject = {
      type: 'object',
      properties: {},
      required: [],
    };
    for (const member of resolved.allOf) {
      const part = schemaOf(doc, member);
      if (!part) continue;
      Object.assign(merged.properties!, part.properties ?? {});
      merged.required!.push(...(part.required ?? []));
    }
    Object.assign(merged.properties!, resolved.properties ?? {});
    merged.required!.push(...(resolved.required ?? []));
    merged.description = resolved.description;
    return merged;
  }
  return resolved;
}

/**
 * Aplana un esquema en filas de tabla. Baja hasta `MAX_DEPTH` niveles y
 * corta al volver a ver el mismo `$ref`: un esquema recursivo (una
 * respuesta que se contiene a sí misma) dejaría el render colgado.
 */
export function flattenSchema(
  doc: OpenApiDocument,
  node: MaybeRef<SchemaObject> | undefined,
  options: { prefix?: string; depth?: number; seen?: ReadonlySet<string> } = {}
): FieldRow[] {
  const { prefix = '', depth = 0, seen = new Set<string>() } = options;
  const named = refName(node);
  if (named && seen.has(named)) return [];
  const schema = schemaOf(doc, node);
  if (!schema) return [];
  const nextSeen = named ? new Set([...seen, named]) : seen;

  // Una lista se describe por su elemento: `data[]` y sus campos.
  const types = Array.isArray(schema.type)
    ? schema.type
    : schema.type
      ? [schema.type]
      : [];
  if (types.includes('array') && schema.items) {
    return flattenSchema(doc, schema.items, {
      prefix: `${prefix}[]`,
      depth,
      seen: nextSeen,
    });
  }

  if (!schema.properties) return [];
  const required = new Set(schema.required ?? []);
  const rows: FieldRow[] = [];
  for (const [name, raw] of Object.entries(schema.properties)) {
    const full = prefix ? `${prefix}.${name}` : name;
    const child = schemaOf(doc, raw);
    rows.push({
      name: full,
      type: typeLabel(doc, raw),
      required: required.has(name),
      description: child?.description,
    });
    if (depth < MAX_DEPTH) {
      rows.push(
        ...flattenSchema(doc, raw, {
          prefix: full,
          depth: depth + 1,
          seen: nextSeen,
        })
      );
    }
  }
  return rows;
}

// ------------------------------------------------------------
// Ejemplos
// ------------------------------------------------------------

function pretty(value: JsonValue | undefined): string | undefined {
  return value === undefined ? undefined : JSON.stringify(value, null, 2);
}

/** El ejemplo de un `content`: `example` suelto o el primero de `examples`. */
export function exampleOf(
  doc: OpenApiDocument,
  media: MediaTypeObject | undefined
): JsonValue | undefined {
  if (!media) return undefined;
  if (media.example !== undefined) return media.example;
  for (const candidate of Object.values(media.examples ?? {})) {
    const resolved = resolveRef<ExampleObject>(doc, candidate);
    if (resolved?.value !== undefined) return resolved.value;
  }
  const schema = schemaOf(doc, media.schema);
  return schema?.example;
}

function firstContent(
  content: Record<string, MediaTypeObject> | undefined
): [string, MediaTypeObject] | undefined {
  const entries = Object.entries(content ?? {});
  if (entries.length === 0) return undefined;
  return entries.find(([type]) => type.includes('json')) ?? entries[0];
}

// ------------------------------------------------------------
// Operaciones
// ------------------------------------------------------------

export function operationAnchor(method: string, path: string): string {
  return `${method}-${path}`
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * Scopes que exige una operación. `x-scopes` manda porque es explícito;
 * si no está, se leen de `security` (los de la operación, o los del
 * documento si la operación no declara los suyos).
 */
export function scopesOf(
  doc: OpenApiDocument,
  operation: OperationObject
): string[] {
  if (operation['x-scopes']) return operation['x-scopes'];
  const requirements = operation.security ?? doc.security ?? [];
  const scopes = new Set<string>();
  for (const requirement of requirements) {
    for (const list of Object.values(requirement)) {
      for (const scope of list) scopes.add(scope);
    }
  }
  return [...scopes];
}

function buildCurl(
  server: string | undefined,
  method: HttpMethod,
  path: string,
  body: BodyModel | undefined,
  idempotent: boolean
): string {
  const url = `${server ?? ''}${path}`;
  const lines = [
    method === 'get'
      ? `curl "${url}" \\`
      : `curl -X ${method.toUpperCase()} "${url}" \\`,
    `  -H "Authorization: Bearer $CABBITY_API_KEY"`,
  ];
  if (body) {
    lines[lines.length - 1] += ' \\';
    lines.push(`  -H "Content-Type: ${body.contentType}"`);
    if (idempotent) {
      lines[lines.length - 1] += ' \\';
      lines.push(`  -H "Idempotency-Key: $CLAVE"`);
    }
    if (body.example) {
      lines[lines.length - 1] += ' \\';
      lines.push(`  -d '${body.example}'`);
    }
  }
  return lines.join('\n');
}

function buildBody(
  doc: OpenApiDocument,
  node: MaybeRef<RequestBodyObject> | undefined
): BodyModel | undefined {
  const requestBody = resolveRef<RequestBodyObject>(doc, node);
  if (!requestBody) return undefined;
  const content = firstContent(requestBody.content);
  if (!content) return undefined;
  const [contentType, media] = content;
  return {
    required: requestBody.required ?? false,
    description: requestBody.description,
    contentType,
    fields: flattenSchema(doc, media.schema),
    example: pretty(exampleOf(doc, media)),
  };
}

function buildResponses(
  doc: OpenApiDocument,
  operation: OperationObject
): ResponseRow[] {
  return Object.entries(operation.responses ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([status, raw]) => {
      const response = resolveRef<ResponseObject>(doc, raw);
      const content = firstContent(response?.content);
      return {
        status,
        description: response?.description ?? '',
        contentType: content?.[0],
        fields: content ? flattenSchema(doc, content[1].schema) : [],
        example: content ? pretty(exampleOf(doc, content[1])) : undefined,
      };
    });
}

function buildParameters(
  doc: OpenApiDocument,
  pathItem: PathItemObject,
  operation: OperationObject
): ParamRow[] {
  const all = [...(pathItem.parameters ?? []), ...(operation.parameters ?? [])];
  const rows: ParamRow[] = [];
  const seen = new Set<string>();
  for (const raw of all) {
    const parameter = resolveRef<ParameterObject>(doc, raw);
    if (!parameter) continue;
    const key = `${parameter.in}:${parameter.name}`;
    // Un parámetro de la operación pisa al del path item, como manda la
    // especificación.
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      name: parameter.name,
      in: parameter.in,
      type: typeLabel(doc, parameter.schema),
      required: parameter.required ?? parameter.in === 'path',
      description: parameter.description,
    });
  }
  return rows;
}

// ------------------------------------------------------------
// Documento completo
// ------------------------------------------------------------

export function buildReference(doc: OpenApiDocument): ReferenceModel {
  const server = doc.servers?.[0]?.url;
  const byTag = new Map<string, ReferenceOperation[]>();
  const operations: ReferenceOperation[] = [];

  for (const [path, pathItem] of Object.entries(doc.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = pathItem[method];
      if (!operation) continue;
      const body = buildBody(doc, operation.requestBody);
      const idempotent = operation['x-idempotent'] ?? false;
      const built: ReferenceOperation = {
        id: operationAnchor(method, path),
        method,
        path,
        summary: operation.summary ?? `${method.toUpperCase()} ${path}`,
        description: operation.description,
        scopes: scopesOf(doc, operation),
        idempotent,
        deprecated: operation.deprecated ?? false,
        parameters: buildParameters(doc, pathItem, operation),
        requestBody: body,
        responses: buildResponses(doc, operation),
        curl: buildCurl(server, method, path, body, idempotent),
      };
      operations.push(built);
      const tag = operation.tags?.[0] ?? UNTAGGED;
      const bucket = byTag.get(tag);
      if (bucket) bucket.push(built);
      else byTag.set(tag, [built]);
    }
  }

  // El orden de `tags` del documento manda; lo que no esté declarado va
  // detrás, en el orden en que apareció.
  const declared = (doc.tags ?? []).map((tag) => tag.name);
  const tagNames = [
    ...declared.filter((name) => byTag.has(name)),
    ...[...byTag.keys()].filter((name) => !declared.includes(name)),
  ];

  const sections: ReferenceSection[] = tagNames.map((name) => ({
    id: `tag-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    name,
    description: doc.tags?.find((tag) => tag.name === name)?.description,
    operations: byTag.get(name) ?? [],
  }));

  const webhooks: WebhookEntry[] = Object.entries(doc.webhooks ?? {}).map(
    ([event, pathItem]) => {
      const operation = pathItem.post ?? pathItem.get;
      const content = firstContent(
        resolveRef<RequestBodyObject>(doc, operation?.requestBody)?.content
      );
      return {
        id: `webhook-${event.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
        event,
        summary: operation?.summary,
        description: operation?.description,
        fields: content ? flattenSchema(doc, content[1].schema) : [],
        example: content ? pretty(exampleOf(doc, content[1])) : undefined,
      };
    }
  );

  return {
    title: doc.info?.title ?? '',
    version: doc.info?.version ?? '',
    description: doc.info?.description,
    server,
    sections,
    webhooks,
    operations,
  };
}
