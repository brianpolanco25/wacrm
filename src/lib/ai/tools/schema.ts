// ============================================================
// Del catálogo de integraciones a herramientas del modelo (n13.3, R4–R9).
//
// Puro. Una operación activa → una herramienta con nombre estable, una
// descripción para el modelo y un JSON Schema de entrada derivado de sus
// `params`. Solo entran los parámetros que el modelo puede mandar
// (`callerParams` de n13.5): la cabecera que genera el ejecutor
// (`in: 'header'`, `auto`) se omite.
// ============================================================

import { callerParams } from '@/lib/integrations/request';

import { MAX_ARG_DEPTH } from './args';
import type { HttpMethod, OperationParam } from '@/lib/integrations/types';

import {
  AI_TOOL_MAX_TOOLS,
  type AiTool,
  type AiToolMode,
  type JsonSchema,
} from './types';

export const TOOL_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,63}$/;
const TOOL_NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

/** Una operación del catálogo con su integración, tal como la lee `load.ts`. */
export interface ToolSourceRow {
  integration: { slug: string; name: string; sortOrder: number };
  operation: {
    key: string;
    name: string;
    description: string;
    method: HttpMethod;
    params: OperationParam[] | null;
    responseDescription: string | null;
    sortOrder: number;
  };
}

/**
 * R6: `<slug con - → _>__<key>` si cabe en 64 y no se repite; si no,
 * `op<n>_<key>` cortado a 64 (n = índice 1-based).
 */
export function toolNameFor(
  slug: string,
  key: string,
  index: number,
  taken: Set<string>
): string {
  const preferred = `${slug.replace(/-/g, '_')}__${key}`;
  if (TOOL_NAME_RE.test(preferred) && !taken.has(preferred)) return preferred;
  const safeKey = key.replace(/[^a-zA-Z0-9_]/g, '_');
  return `op${index}_${safeKey}`.slice(0, TOOL_NAME_MAX);
}

type Node =
  | { kind: 'leaf'; param: OperationParam }
  | { kind: 'object'; children: Map<string, Node> };

function leafSchema(param: OperationParam): JsonSchema {
  const schema: JsonSchema = { type: param.type };
  let description = param.description?.trim() ?? '';
  const values = Array.isArray(param.enum) ? param.enum : [];
  if (values.length > 0) {
    if (param.type === 'string') {
      schema.enum = [...values];
    } else {
      description = `${description}${description ? ' ' : ''}Allowed values: ${values.join(', ')}.`;
    }
  }
  if (description) schema.description = description;
  return schema;
}

function hasRequired(node: Node): boolean {
  if (node.kind === 'leaf') return node.param.required === true;
  for (const child of node.children.values()) {
    if (hasRequired(child)) return true;
  }
  return false;
}

function toSchema(node: Node): JsonSchema {
  if (node.kind === 'leaf') return leafSchema(node.param);
  // Sin prototipo: un parámetro llamado `constructor` o `__proto__` es una
  // propiedad más, no la heredada de Object.prototype.
  const properties = Object.create(null) as Record<string, JsonSchema>;
  const required: string[] = [];
  for (const [name, child] of node.children) {
    properties[name] = toSchema(child);
    if (hasRequired(child)) required.push(name);
  }
  const schema: JsonSchema = { type: 'object', properties };
  if (required.length > 0) schema.required = required;
  return schema;
}

/**
 * R7/R8: el esquema de entrada de la herramienta, o `null` si dos
 * parámetros chocan (`a` y `a.b`, o el mismo nombre dos veces) o si un
 * requerido pasa de MAX_ARG_DEPTH segmentos: esa operación no se ofrece.
 */
export function buildParameterSchema(
  params: OperationParam[] | null | undefined
): JsonSchema | null {
  const root: Node = { kind: 'object', children: new Map() };
  for (const param of callerParams(params ?? [])) {
    const segments = param.name.split('.');
    if (segments.some((s) => s === '')) return null;
    // `flattenToolArgs` no baja de MAX_ARG_DEPTH niveles: un parámetro más
    // hondo se ofrecería pero nunca llegaría al ejecutor con su nombre.
    // Opcional → fuera del esquema; requerido → la operación entera fuera.
    if (segments.length > MAX_ARG_DEPTH) {
      console.warn('[ai tools] a parameter is nested too deeply for the AI');
      if (param.required) return null;
      continue;
    }
    let current = root;
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      const last = i === segments.length - 1;
      const existing = current.children.get(segment);
      if (last) {
        if (existing) return null;
        current.children.set(segment, { kind: 'leaf', param });
      } else if (!existing) {
        const next: Node = { kind: 'object', children: new Map() };
        current.children.set(segment, next);
        current = next;
      } else if (existing.kind === 'leaf') {
        return null;
      } else {
        current = existing;
      }
    }
  }
  return toSchema(root);
}

/** R9: integración, operación, qué devuelve; «Write operation» si no es GET. */
export function buildToolDescription(input: {
  integrationName: string;
  name: string;
  description: string;
  responseDescription: string | null;
  method: HttpMethod;
}): string {
  const parts: string[] = [];
  if (input.method !== 'GET') parts.push('Write operation.');
  parts.push(`${input.integrationName}: ${input.name}.`);
  if (input.description?.trim()) parts.push(input.description.trim());
  if (input.responseDescription?.trim()) {
    parts.push(`Returns: ${input.responseDescription.trim()}`);
  }
  const text = parts.join(' ');
  return text.length > DESCRIPTION_MAX
    ? text.slice(0, DESCRIPTION_MAX - 1) + '…'
    : text;
}

function compareRows(a: ToolSourceRow, b: ToolSourceRow): number {
  return (
    a.integration.sortOrder - b.integration.sortOrder ||
    a.integration.name.localeCompare(b.integration.name) ||
    a.integration.slug.localeCompare(b.integration.slug) ||
    a.operation.sortOrder - b.operation.sortOrder ||
    a.operation.key.localeCompare(b.operation.key)
  );
}

/**
 * R4/R5: las herramientas del turno, en orden de catálogo y como mucho
 * 20. En `draft` solo las de lectura (`GET`, D5).
 */
export function buildAiTools(
  rows: ToolSourceRow[],
  opts: { mode: AiToolMode }
): AiTool[] {
  const eligible = rows
    .filter((r) => opts.mode !== 'draft' || r.operation.method === 'GET')
    .sort(compareRows);
  const tools: AiTool[] = [];
  const taken = new Set<string>();
  for (const row of eligible) {
    if (tools.length >= AI_TOOL_MAX_TOOLS) break;
    const parameters = buildParameterSchema(row.operation.params);
    if (!parameters) continue;
    const name = toolNameFor(
      row.integration.slug,
      row.operation.key,
      tools.length + 1,
      taken
    );
    if (taken.has(name) || !TOOL_NAME_RE.test(name)) continue;
    taken.add(name);
    tools.push({
      name,
      integrationSlug: row.integration.slug,
      integrationName: row.integration.name,
      operationKey: row.operation.key,
      method: row.operation.method,
      description: buildToolDescription({
        integrationName: row.integration.name,
        name: row.operation.name,
        description: row.operation.description,
        responseDescription: row.operation.responseDescription,
        method: row.operation.method,
      }),
      parameters,
      declaredParams: callerParams(row.operation.params ?? []),
    });
  }
  return tools;
}
