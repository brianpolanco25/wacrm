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
  const input = given ?? {};
  const names = new Set(declared.map((p) => p.name));
  for (const key of Object.keys(input)) {
    if (!names.has(key)) return { ok: false, problem: 'unknown', param: key };
  }
  const values: Record<string, ParamValue> = {};
  for (const param of declared) {
    const raw = Object.prototype.hasOwnProperty.call(input, param.name)
      ? input[param.name]
      : undefined;
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
  values: Record<string, ParamValue>
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
  const body: Record<string, ParamValue> = {};
  let hasBody = false;
  for (const param of operation.params) {
    const value = ownValue(values, param.name);
    if (value === undefined) continue;
    if (param.in === 'query') query.append(param.name, String(value));
    if (param.in === 'body') {
      body[param.name] = value;
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
