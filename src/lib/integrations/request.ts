// ============================================================
// Construcción de la petición de una operación (n13.1, R21, R27, R29).
//
// Puro: valida los parámetros contra la declaración, los convierte (los
// valores de un flow llegan como texto) y monta URL, cabeceras y cuerpo.
// La credencial NO entra aquí: la añade execute.ts con `authHeader`, así
// que nada de lo que devuelve este módulo es secreto.
//
// Allowlist (R21): la URL final tiene que quedarse en el origen de
// `base_url` y bajo su prefijo, tal cual se montó. Los valores de
// marcador se codifican con `encodeURIComponent` y además el `.`, para
// que `../admin` no sea un segmento de punto; y si aun así el parser de
// URL normaliza la ruta (p. ej. un valor que codificado sea `%2E%2E`),
// la petición se bloquea.
//
// n13.5: cabeceras autogeneradas (`in: 'header'`, `auto: 'uuid'`, p. ej.
// `Idempotency-Key`), que nadie manda y el constructor rellena con un
// UUID nuevo por llamada; y nombres `body` con punto (`consent.accepted`)
// que viajan como objetos anidados.
//
// n13.8: un parámetro con `normalize: 'compact'` (p. ej. el número de
// documento) se limpia aquí, antes de validar, para cualquier llamador.
// ============================================================

import {
  INTEGRATION_USER_AGENT,
  type AuthScheme,
  type HttpMethod,
  type OperationParam,
} from './types';

export interface BuiltRequest {
  url: string;
  method: HttpMethod;
  /** Sin la credencial: la añade execute.ts. */
  headers: Record<string, string>;
  body: string | undefined;
}

export type ParamValue = string | number | boolean;

export type ParamCheck =
  | { ok: true; values: Record<string, ParamValue> }
  | {
      ok: false;
      problem: 'unknown' | 'missing' | 'type' | 'enum' | 'too_long';
      param: string;
    };

/** Longitud máxima de un parámetro de texto. */
export const PARAM_STRING_MAX = 2000;

/** Profundidad máxima de un nombre con punto (igual que catalog-validate). */
const MAX_DEPTH = 3;

/**
 * Los parámetros que puede mandar quien llama: todos menos los `auto`
 * (n13.5, D2). El formulario del nodo de flow (n13.2) y el esquema de las
 * herramientas de la IA (n13.3) listan estos, nunca `params` a pelo.
 */
export function callerParams(params: OperationParam[]): OperationParam[] {
  return params.filter((p) => p.auto === undefined && p.in !== 'header');
}

export interface BuildOptions {
  /** Generador de las cabeceras `auto: 'uuid'`. Tests: inyectado. */
  uuid?: () => string;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * R15: `{consent:{accepted:true}}` → `{'consent.accepted': true}` cuando
 * `consent` es prefijo de algún parámetro declarado con punto. Devuelve el
 * nombre con punto repetido si la misma hoja llega por las dos vías.
 */
function flattenGiven(
  declared: OperationParam[],
  input: Record<string, unknown>
): { ok: true; flat: Record<string, unknown> } | { ok: false; param: string } {
  const prefixes = new Set<string>();
  for (const p of declared) {
    const parts = p.name.split('.');
    for (let i = 1; i < parts.length; i++) {
      prefixes.add(parts.slice(0, i).join('.'));
    }
  }
  if (prefixes.size === 0) return { ok: true, flat: input };

  const flat: Record<string, unknown> = {};
  const walk = (
    prefix: string,
    obj: Record<string, unknown>,
    depth: number
  ): void => {
    for (const key of Object.keys(obj)) {
      const name = `${prefix}.${key}`;
      const v = obj[key];
      if (isPlainRecord(v) && prefixes.has(name) && depth < MAX_DEPTH) {
        walk(name, v, depth + 1);
      } else {
        defineOwn(flat, name, v);
      }
    }
  };
  for (const key of Object.keys(input)) {
    const v = input[key];
    if (isPlainRecord(v) && prefixes.has(key)) {
      walk(key, v, 2);
    }
  }
  for (const key of Object.keys(input)) {
    const v = input[key];
    if (isPlainRecord(v) && prefixes.has(key)) continue;
    if (Object.prototype.hasOwnProperty.call(flat, key)) {
      return { ok: false, param: key };
    }
    defineOwn(flat, key, v);
  }
  return { ok: true, flat };
}

/**
 * n13.8: guiones (ASCII y los Unicode que mete un teclado de móvil o un
 * autocorrector), espacios de cualquier tipo y puntos.
 */
const COMPACT_STRIP_RE = /[\s.\-\u2010-\u2015\u2212]/g;

/** Aplica la normalización declarada; solo toca valores de texto. */
export function normalizeParamValue(
  param: Pick<OperationParam, 'normalize'>,
  raw: unknown
): unknown {
  if (param.normalize === 'compact' && typeof raw === 'string') {
    return raw.replace(COMPACT_STRIP_RE, '');
  }
  return raw;
}

function isAbsent(v: unknown): boolean {
  return v === null || v === undefined || v === '';
}

function coerce(
  param: OperationParam,
  raw: unknown
):
  | { ok: true; value: ParamValue }
  | { ok: false; problem: 'type' | 'too_long' } {
  switch (param.type) {
    case 'string': {
      let s: string;
      if (typeof raw === 'string') s = raw;
      else if (typeof raw === 'number' && Number.isFinite(raw)) s = String(raw);
      else return { ok: false, problem: 'type' };
      if (s.length > PARAM_STRING_MAX)
        return { ok: false, problem: 'too_long' };
      return { ok: true, value: s };
    }
    case 'integer': {
      if (typeof raw === 'number' && Number.isSafeInteger(raw)) {
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && /^-?\d+$/.test(raw.trim())) {
        const n = Number(raw.trim());
        if (Number.isSafeInteger(n)) return { ok: true, value: n };
      }
      return { ok: false, problem: 'type' };
    }
    case 'number': {
      if (typeof raw === 'number' && Number.isFinite(raw)) {
        return { ok: true, value: raw };
      }
      if (typeof raw === 'string' && raw.trim() !== '') {
        const n = Number(raw.trim());
        if (Number.isFinite(n)) return { ok: true, value: n };
      }
      return { ok: false, problem: 'type' };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      if (raw === 'true') return { ok: true, value: true };
      if (raw === 'false') return { ok: true, value: false };
      return { ok: false, problem: 'type' };
    }
  }
}

/**
 * Valida `given` contra los parámetros declarados (R27): desconocidos,
 * requeridos ausentes, tipo y `enum`. `null`/`undefined`/`''` en un
 * opcional = ausente (no viaja).
 */
export function validateCallParams(
  declared: OperationParam[],
  given: Record<string, unknown> | null | undefined
): ParamCheck {
  const flattened = flattenGiven(declared, given ?? {});
  if (!flattened.ok) {
    return { ok: false, problem: 'unknown', param: flattened.param };
  }
  const input = flattened.flat;
  // Un parámetro `auto` lo rellena el ejecutor: si alguien lo manda, es
  // desconocido (R10).
  const accepted = callerParams(declared);
  const names = new Set(accepted.map((p) => p.name));
  for (const key of Object.keys(input)) {
    if (!names.has(key)) return { ok: false, problem: 'unknown', param: key };
  }
  const values: Record<string, ParamValue> = {};
  for (const param of accepted) {
    // n13.8: limpiar antes de mirar si falta (`' - '` queda vacío = ausente).
    const raw = normalizeParamValue(
      param,
      Object.prototype.hasOwnProperty.call(input, param.name)
        ? input[param.name]
        : undefined
    );
    if (isAbsent(raw)) {
      if (param.required)
        return { ok: false, problem: 'missing', param: param.name };
      continue;
    }
    const c = coerce(param, raw);
    if (!c.ok) return { ok: false, problem: c.problem, param: param.name };
    if (param.enum && !param.enum.includes(String(c.value))) {
      return { ok: false, problem: 'enum', param: param.name };
    }
    values[param.name] = c.value;
  }
  return { ok: true, values };
}

/**
 * El valor PROPIO de un parámetro. `values` es un objeto normal y un
 * nombre válido de parámetro puede ser `constructor` o `toString`: leerlo
 * a pelo devolvería la función heredada de `Object.prototype` y la
 * mandaría como query o como cuerpo.
 */
function ownValue(
  values: Record<string, ParamValue>,
  name: string
): ParamValue | undefined {
  return Object.prototype.hasOwnProperty.call(values, name)
    ? values[name]
    : undefined;
}

/** Asigna una propiedad PROPIA (nunca un setter heredado como `__proto__`). */
function defineOwn(
  target: Record<string, unknown>,
  key: string,
  value: unknown
): void {
  Object.defineProperty(target, key, {
    value,
    enumerable: true,
    writable: true,
    configurable: true,
  });
}

/**
 * R14: `['consent', 'accepted']` → `body.consent.accepted = value`,
 * creando los intermedios como propiedades propias. El padre solo existe
 * si alguna hoja viaja (se crea aquí, al poner la primera).
 */
function setNested(
  body: Record<string, unknown>,
  parts: string[],
  value: ParamValue
): void {
  let node = body;
  for (const part of parts.slice(0, -1)) {
    const own = Object.prototype.hasOwnProperty.call(node, part)
      ? node[part]
      : undefined;
    if (isPlainRecord(own)) {
      node = own;
    } else {
      const child: Record<string, unknown> = {};
      defineOwn(node, part, child);
      node = child;
    }
  }
  defineOwn(node, parts[parts.length - 1], value);
}

/** `encodeURIComponent` más el punto: ningún valor forma un segmento `.`/`..`. */
export function encodePathValue(value: ParamValue): string {
  return encodeURIComponent(String(value)).replace(/\./g, '%2E');
}

/**
 * Monta la petición. `{ blocked: true }` si la URL resultante saldría del
 * origen o del prefijo de `base_url`, o si el parser la normalizaría.
 */
export function buildIntegrationRequest(
  integration: { base_url: string },
  operation: { method: HttpMethod; path: string; params: OperationParam[] },
  values: Record<string, ParamValue>,
  options: BuildOptions = {}
): BuiltRequest | { blocked: true } {
  let base: URL;
  try {
    base = new URL(integration.base_url);
  } catch {
    return { blocked: true };
  }

  let path = operation.path;
  for (const param of operation.params) {
    if (param.in !== 'path') continue;
    const value = ownValue(values, param.name);
    if (value === undefined) return { blocked: true };
    path = path.split(`{${param.name}}`).join(encodePathValue(value));
  }
  if (/[{}]/.test(path)) return { blocked: true };

  const query = new URLSearchParams();
  const body: Record<string, unknown> = {};
  let hasBody = false;
  for (const param of operation.params) {
    if (param.in === 'header') continue;
    const value = ownValue(values, param.name);
    if (value === undefined) continue;
    if (param.in === 'query') query.append(param.name, String(value));
    if (param.in === 'body') {
      setNested(body, param.name.split('.'), value);
      hasBody = true;
    }
  }

  const basePath = integration.base_url
    .slice(base.origin.length)
    .replace(/\/+$/, '');
  const builtPath = `${basePath}${path}`;
  const qs = query.toString();
  const url = `${base.origin}${builtPath}${qs ? `?${qs}` : ''}`;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blocked: true };
  }
  if (parsed.origin !== base.origin) return { blocked: true };
  if (parsed.pathname !== builtPath) return { blocked: true };

  const headers: Record<string, string> = {
    Accept: 'application/json',
    'User-Agent': INTEGRATION_USER_AGENT,
  };
  if (hasBody) headers['Content-Type'] = 'application/json';
  // R11: valor nuevo por llamada; cualquier `values[name]` se ignora.
  const uuid = options.uuid ?? (() => globalThis.crypto.randomUUID());
  for (const param of operation.params) {
    if (param.in === 'header' && param.auto === 'uuid') {
      headers[param.name] = uuid();
    }
  }

  return {
    url,
    method: operation.method,
    headers,
    body: hasBody ? JSON.stringify(body) : undefined,
  };
}

/** Cabecera de autenticación de la cuenta: `[nombre, valor]`. */
export function authHeader(
  scheme: AuthScheme,
  headerName: string | null,
  credential: string
): [string, string] {
  if (scheme === 'header' && headerName) return [headerName, credential];
  return ['Authorization', `Bearer ${credential}`];
}

/**
 * Copia `headers` sin ninguna clave igual a `name` (sin distinguir
 * mayúsculas) y añade `[name, value]` (n13.5, R12): la credencial es la
 * única cabecera con ese nombre que sale.
 */
export function withAuthHeader(
  headers: Record<string, string>,
  name: string,
  value: string
): Record<string, string> {
  const lower = name.toLowerCase();
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() !== lower) out[k] = v;
  }
  out[name] = value;
  return out;
}
