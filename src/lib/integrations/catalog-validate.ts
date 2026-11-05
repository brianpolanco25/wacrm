// ============================================================
// Validación del catálogo de integraciones (n13.1, R5–R9).
//
// Pura salvo por `isPrivateOrReservedIp` (sin red): la comprobación con
// DNS (`isDeliverableUrl`) la hace la ruta de plataforma antes de
// escribir. Devuelve `{ ok, value }` o `{ ok: false, error, field }`
// como `validatePlanInput`; el mensaje va en inglés (API interna) y la
// UI traduce por `field`.
//
// Las reglas de ruta (R8) son la mitad de la defensa SSRF: la plantilla
// la escribe el operador, pero los valores de los marcadores llegan del
// cliente (flows, IA). Una plantilla que ya traiga `..`, `//`, query o
// esquema podría sacar la petición del origen permitido.
// ============================================================

import { isIP } from 'node:net';

import { isPrivateOrReservedIp } from '@/lib/webhooks/ssrf';

import {
  AUTH_SCHEMES,
  HTTP_METHODS,
  OUTPUT_TYPES,
  PARAM_AUTOS,
  PARAM_LOCATIONS,
  PARAM_TYPES,
  type AuthScheme,
  type HttpMethod,
  type IntegrationWrite,
  type OperationOutput,
  type OperationParam,
  type OperationWrite,
  type OutputType,
  type ParamAuto,
  type ParamLocation,
  type ParamType,
  type Validation,
} from './types';

export type {
  AuthScheme,
  HttpMethod,
  IntegrationWrite,
  OperationOutput,
  OperationParam,
  OperationWrite,
  OutputType,
  ParamLocation,
  ParamType,
  Validation,
} from './types';

export const INTEGRATION_SLUG_RE = /^[a-z][a-z0-9-]{1,39}$/;
export const OPERATION_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const PARAM_NAME_RE = /^[a-z][a-zA-Z0-9_]{0,63}$/;
export const HEADER_NAME_RE = /^[A-Za-z0-9-]{1,64}$/;
/** n13.5 (D3): cada parte de un nombre `body` con punto (`consent.accepted`). */
export const PARAM_SEGMENT_RE = /^[a-z][a-zA-Z0-9_]{0,63}$/;
export const MAX_PARAM_DEPTH = 3;
const OUTPUT_PATH_RE = /^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/;
/** Caracteres de una plantilla de ruta: los de segmento de RFC 3986 sin `%`. */
const PATH_CHARS_RE = /^[A-Za-z0-9\-._~!$&'()*+,;=:@/{}]+$/;
const PLACEHOLDER_RE = /\{([a-z][a-zA-Z0-9_]{0,63})\}/g;

/** Cabeceras que el esquema `header` no puede usar (design §4). */
export const FORBIDDEN_AUTH_HEADERS = [
  'host',
  'content-length',
  'content-type',
  'transfer-encoding',
  'connection',
  'keep-alive',
  'upgrade',
  'cookie',
  'set-cookie',
  'user-agent',
  'accept',
  'proxy-authorization',
  'te',
  'trailer',
] as const;

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const URL_MAX = 2048;
const PATH_MAX = 500;
const OPERATION_DESCRIPTION_MAX = 1000;
const MAX_PARAMS = 30;
const MAX_OUTPUTS = 30;
const ENUM_MAX = 50;
const ENUM_VALUE_MAX = 200;
const INT4_MAX = 2_147_483_647;

const INTEGRATION_FIELDS = [
  'slug',
  'name',
  'description',
  'logo_url',
  'base_url',
  'auth_scheme',
  'auth_header_name',
  'credential_help',
  'test_path',
  'is_active',
  'sort_order',
] as const;

const OPERATION_FIELDS = [
  'key',
  'name',
  'description',
  'method',
  'path',
  'params',
  'outputs',
  'response_description',
  'is_active',
  'sort_order',
] as const;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

function fail<T>(field: string, error: string): Validation<T> {
  return { ok: false, error, field };
}

/** Host que nunca puede ser destino: literal privado o nombre interno. */
export function isForbiddenHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host) return true;
  if (isIP(host)) return isPrivateOrReservedIp(host);
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal')
  );
}

/**
 * `https://host[:port]/prefijo` sin usuario, contraseña, query, fragmento
 * ni `/` final; `null` si no cumple. No mira el host (eso lo hace
 * `isForbiddenHost` y, con DNS, `isDeliverableUrl`).
 */
export function normalizeBaseUrl(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const raw = input.trim();
  if (!raw || raw.length > URL_MAX) return null;
  if (raw.includes('?') || raw.includes('#') || /\s/.test(raw)) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password) return null;
  if (url.search || url.hash) return null;
  if (!url.hostname) return null;
  const path = url.pathname.replace(/\/+$/, '');
  // Un prefijo con `//`, `%` o `..` complicaría la comprobación de prefijo
  // del ejecutor; ninguna API real lo necesita.
  if (path && (!PATH_CHARS_RE.test(path) || path.includes('//'))) return null;
  if (path.includes('{') || path.includes('}')) return null;
  return `${url.origin}${path}`;
}

/** Marcadores `{nombre}` de una plantilla, en orden y sin repetir. */
export function pathPlaceholders(path: string): string[] {
  const out: string[] = [];
  for (const m of path.matchAll(PLACEHOLDER_RE)) {
    if (!out.includes(m[1])) out.push(m[1]);
  }
  return out;
}

/**
 * R8: ruta relativa segura. Empieza por `/`; sin `..`, `//`, `?`, `#`,
 * `\`, `%`, espacios ni esquema; llaves solo como marcadores `{nombre}`.
 */
export function validateRelativePath(path: unknown): boolean {
  if (typeof path !== 'string') return false;
  if (!path.startsWith('/') || path.length > PATH_MAX) return false;
  if (path.includes('..') || path.includes('//')) return false;
  if (!PATH_CHARS_RE.test(path)) return false;
  // Lo que queda tras quitar los marcadores válidos no puede tener llaves.
  const rest = path.replace(PLACEHOLDER_RE, 'x');
  if (rest.includes('{') || rest.includes('}')) return false;
  // Ningún segmento puede ser `.` (`..` ya está fuera).
  return !path.split('/').some((seg) => seg === '.');
}

function optionalText(
  body: Record<string, unknown>,
  field: string,
  max: number
): Validation<string | null> | undefined {
  if (!(field in body)) return undefined;
  const v = body[field];
  if (v === null) return { ok: true, value: null };
  if (typeof v !== 'string')
    return fail(field, `'${field}' must be a string or null`);
  const t = v.trim();
  if (t.length > max)
    return fail(field, `'${field}' is at most ${max} characters`);
  return { ok: true, value: t || null };
}

function requiredText(
  body: Record<string, unknown>,
  field: string,
  max: number
): Validation<string> {
  const v = body[field];
  const t = typeof v === 'string' ? v.trim() : '';
  if (!t || t.length > max) {
    return fail(field, `'${field}' is required, at most ${max} characters`);
  }
  return { ok: true, value: t };
}

function sortOrder(
  body: Record<string, unknown>
): Validation<number> | undefined {
  if (!('sort_order' in body)) return undefined;
  const o = body.sort_order;
  if (typeof o !== 'number' || !Number.isInteger(o) || Math.abs(o) > INT4_MAX) {
    return fail('sort_order', "'sort_order' must be an integer");
  }
  return { ok: true, value: o };
}

/**
 * Valida el cuerpo de un alta (`create`) o una edición (`update`) de
 * integración. En `update` el `slug` no se puede tocar (R6) y `existing`
 * permite comprobar `auth_scheme` ↔ `auth_header_name` con lo guardado.
 */
export function validateIntegrationInput(
  body: unknown,
  mode: 'create' | 'update',
  existing?: Pick<IntegrationWrite, 'auth_scheme' | 'auth_header_name'>
): Validation<IntegrationWrite> {
  if (!isPlainObject(body)) return fail('body', 'body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!(INTEGRATION_FIELDS as readonly string[]).includes(key)) {
      return fail(key, `unknown field '${key}'`);
    }
  }
  const value: IntegrationWrite = {};
  const required = (f: string) => mode === 'create' && !(f in body);

  if (mode === 'update' && 'slug' in body) {
    return fail('slug', 'the integration slug cannot be changed');
  }
  if (mode === 'create') {
    if (typeof body.slug !== 'string' || !INTEGRATION_SLUG_RE.test(body.slug)) {
      return fail(
        'slug',
        "'slug' must be a lowercase letter, then 1–39 of a-z, 0-9 or -"
      );
    }
    value.slug = body.slug;
  }

  if ('name' in body || required('name')) {
    const r = requiredText(body, 'name', NAME_MAX);
    if (!r.ok) return r;
    value.name = r.value;
  }

  const description = optionalText(body, 'description', DESCRIPTION_MAX);
  if (description && !description.ok) return description;
  if (description) value.description = description.value;

  if ('logo_url' in body) {
    const v = body.logo_url;
    if (v === null || v === '') {
      value.logo_url = null;
    } else {
      let ok = false;
      if (typeof v === 'string' && v.length <= URL_MAX) {
        try {
          const u = new URL(v.trim());
          ok = u.protocol === 'https:' && !u.username && !u.password;
        } catch {
          ok = false;
        }
      }
      if (!ok)
        return fail('logo_url', "'logo_url' must be null or an https URL");
      value.logo_url = (v as string).trim();
    }
  }

  if ('base_url' in body || required('base_url')) {
    const base = normalizeBaseUrl(body.base_url);
    if (!base) {
      return fail(
        'base_url',
        "'base_url' must be an https URL without credentials, query or fragment"
      );
    }
    if (isForbiddenHost(new URL(base).hostname)) {
      return fail('base_url', "'base_url' must point to a public host");
    }
    value.base_url = base;
  }

  if ('auth_scheme' in body || required('auth_scheme')) {
    if (!AUTH_SCHEMES.includes(body.auth_scheme as AuthScheme)) {
      return fail('auth_scheme', "'auth_scheme' must be 'bearer' or 'header'");
    }
    value.auth_scheme = body.auth_scheme as AuthScheme;
  }

  if ('auth_header_name' in body) {
    const v = body.auth_header_name;
    if (v === null || v === '') {
      value.auth_header_name = null;
    } else if (
      typeof v === 'string' &&
      HEADER_NAME_RE.test(v) &&
      !(FORBIDDEN_AUTH_HEADERS as readonly string[]).includes(v.toLowerCase())
    ) {
      value.auth_header_name = v;
    } else {
      return fail(
        'auth_header_name',
        "'auth_header_name' must be 1–64 of A-Z, a-z, 0-9 or - and not a reserved header"
      );
    }
  }

  const help = optionalText(body, 'credential_help', DESCRIPTION_MAX);
  if (help && !help.ok) return help;
  if (help) value.credential_help = help.value;

  if ('test_path' in body || required('test_path')) {
    const p = body.test_path;
    if (!validateRelativePath(p) || pathPlaceholders(p as string).length > 0) {
      return fail(
        'test_path',
        "'test_path' must be a relative path starting with '/', without placeholders"
      );
    }
    value.test_path = p as string;
  }

  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return fail('is_active', "'is_active' must be a boolean");
    }
    // R5: una integración nace en borrador. Activarla es una edición
    // aparte, cuando ya tiene operaciones que enseñar.
    if (mode === 'create' && body.is_active) {
      return fail(
        'is_active',
        'an integration is created inactive; activate it with an edit'
      );
    }
    if (mode === 'update') value.is_active = body.is_active;
  }

  const order = sortOrder(body);
  if (order && !order.ok) return order;
  if (order) value.sort_order = order.value;

  // Esquema `header` ↔ nombre de cabecera, combinando con lo guardado.
  const scheme = value.auth_scheme ?? existing?.auth_scheme;
  const header =
    'auth_header_name' in value
      ? value.auth_header_name
      : (existing?.auth_header_name ?? null);
  if (scheme === 'header' && !header) {
    return fail(
      'auth_header_name',
      "'auth_header_name' is required when 'auth_scheme' is 'header'"
    );
  }
  if (
    scheme === 'bearer' &&
    'auth_header_name' in value &&
    value.auth_header_name
  ) {
    // Con bearer el nombre no se usa: se guarda NULL para no confundir.
    value.auth_header_name = null;
  }

  if (mode === 'update' && Object.keys(value).length === 0) {
    return fail('body', 'nothing to update');
  }
  return { ok: true, value };
}

function validateParams(raw: unknown): Validation<OperationParam[]> {
  if (!Array.isArray(raw) || raw.length > MAX_PARAMS) {
    return fail(
      'params',
      `'params' must be an array of at most ${MAX_PARAMS} items`
    );
  }
  const out: OperationParam[] = [];
  const seen = new Set<string>();
  const headers = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const where = `params[${i}]`;
    if (!isPlainObject(item))
      return fail('params', `${where} must be an object`);
    for (const k of Object.keys(item)) {
      if (
        ![
          'name',
          'in',
          'type',
          'required',
          'description',
          'enum',
          'auto',
        ].includes(k)
      ) {
        return fail('params', `${where}: unknown field '${k}'`);
      }
    }
    if (!PARAM_LOCATIONS.includes(item.in as ParamLocation)) {
      return fail('params', `${where}.in must be path, query, body or header`);
    }
    const location = item.in as ParamLocation;
    const name = item.name;
    if (typeof name !== 'string') {
      return fail('params', `${where}.name must match ${PARAM_NAME_RE}`);
    }
    if (location === 'header') {
      // n13.5 (D2): una cabecera nunca lleva valor del llamador; la
      // genera el ejecutor. Ni la de autenticación ni una reservada.
      if (
        !HEADER_NAME_RE.test(name) ||
        name.toLowerCase() === 'authorization' ||
        (FORBIDDEN_AUTH_HEADERS as readonly string[]).includes(
          name.toLowerCase()
        )
      ) {
        return fail(
          'params',
          `${where}.name must be 1–64 of A-Z, a-z, 0-9 or - and not a reserved header`
        );
      }
      if (headers.has(name.toLowerCase())) {
        return fail('params', `${where}.name '${name}' is repeated`);
      }
      headers.add(name.toLowerCase());
    } else if (location === 'body') {
      // n13.5 (D3): `consent.accepted` viaja como objeto anidado.
      const segments = name.split('.');
      if (
        segments.length > MAX_PARAM_DEPTH ||
        !segments.every((seg) => PARAM_SEGMENT_RE.test(seg))
      ) {
        return fail(
          'params',
          `${where}.name must be up to ${MAX_PARAM_DEPTH} dot-separated parts matching ${PARAM_SEGMENT_RE}`
        );
      }
    } else if (!PARAM_NAME_RE.test(name)) {
      return fail('params', `${where}.name must match ${PARAM_NAME_RE}`);
    }
    if (seen.has(name)) {
      return fail('params', `${where}.name '${name}' is repeated`);
    }
    seen.add(name);
    if (!PARAM_TYPES.includes(item.type as ParamType)) {
      return fail(
        'params',
        `${where}.type must be string, integer, number or boolean`
      );
    }
    if (typeof item.required !== 'boolean') {
      return fail('params', `${where}.required must be a boolean`);
    }
    if (location === 'path' && !item.required) {
      return fail('params', `${where}: a path parameter must be required`);
    }
    const hasAuto = 'auto' in item && item.auto !== undefined;
    if (location === 'header') {
      if (!hasAuto || !PARAM_AUTOS.includes(item.auto as ParamAuto)) {
        return fail(
          'params',
          `${where}: a header parameter needs auto: 'uuid'`
        );
      }
      if (item.type !== 'string' || item.required !== true) {
        return fail(
          'params',
          `${where}: a header parameter is a required string`
        );
      }
      if ('enum' in item && item.enum !== undefined && item.enum !== null) {
        return fail('params', `${where}: a header parameter has no enum`);
      }
    } else if (hasAuto) {
      return fail('params', `${where}: auto is only allowed with in: 'header'`);
    }
    const desc =
      typeof item.description === 'string' ? item.description.trim() : '';
    if (!desc || desc.length > DESCRIPTION_MAX) {
      return fail(
        'params',
        `${where}.description is required, at most ${DESCRIPTION_MAX} characters`
      );
    }
    const param: OperationParam = {
      name,
      in: location,
      type: item.type as ParamType,
      required: item.required,
      description: desc,
    };
    if ('enum' in item && item.enum !== undefined && item.enum !== null) {
      if (item.type !== 'string') {
        return fail(
          'params',
          `${where}.enum is only allowed with type 'string'`
        );
      }
      const values = item.enum;
      if (
        !Array.isArray(values) ||
        values.length < 1 ||
        values.length > ENUM_MAX ||
        !values.every(
          (v) =>
            typeof v === 'string' && v.length > 0 && v.length <= ENUM_VALUE_MAX
        ) ||
        new Set(values).size !== values.length
      ) {
        return fail(
          'params',
          `${where}.enum must hold 1–${ENUM_MAX} distinct non-empty strings`
        );
      }
      param.enum = values as string[];
    }
    // Solo si existe: los params de n13.1 conservan su forma (R18).
    if (location === 'header') param.auto = item.auto as ParamAuto;
    out.push(param);
  }
  // Un nombre no puede ser a la vez valor y objeto (`consent` y
  // `consent.accepted`): el cuerpo no tendría forma posible.
  const bodyNames = out.filter((p) => p.in === 'body').map((p) => p.name);
  for (const n of bodyNames) {
    if (bodyNames.some((other) => other.startsWith(`${n}.`))) {
      return fail('params', `'${n}' cannot be both a value and an object`);
    }
  }
  return { ok: true, value: out };
}

function validateOutputs(raw: unknown): Validation<OperationOutput[]> {
  if (!Array.isArray(raw) || raw.length > MAX_OUTPUTS) {
    return fail(
      'outputs',
      `'outputs' must be an array of at most ${MAX_OUTPUTS} items`
    );
  }
  const out: OperationOutput[] = [];
  const seen = new Set<string>();
  for (const [i, item] of raw.entries()) {
    const where = `outputs[${i}]`;
    if (!isPlainObject(item))
      return fail('outputs', `${where} must be an object`);
    for (const k of Object.keys(item)) {
      if (!['name', 'path', 'type', 'description'].includes(k)) {
        return fail('outputs', `${where}: unknown field '${k}'`);
      }
    }
    if (typeof item.name !== 'string' || !PARAM_NAME_RE.test(item.name)) {
      return fail('outputs', `${where}.name must match ${PARAM_NAME_RE}`);
    }
    if (seen.has(item.name)) {
      return fail('outputs', `${where}.name '${item.name}' is repeated`);
    }
    seen.add(item.name);
    if (
      typeof item.path !== 'string' ||
      item.path.length > PATH_MAX ||
      !OUTPUT_PATH_RE.test(item.path)
    ) {
      return fail(
        'outputs',
        `${where}.path must be dot notation (data.items.0.id)`
      );
    }
    if (!OUTPUT_TYPES.includes(item.type as OutputType)) {
      return fail('outputs', `${where}.type is not a known type`);
    }
    const desc =
      typeof item.description === 'string' ? item.description.trim() : '';
    if (desc.length > DESCRIPTION_MAX) {
      return fail(
        'outputs',
        `${where}.description is at most ${DESCRIPTION_MAX} characters`
      );
    }
    out.push({
      name: item.name,
      path: item.path,
      type: item.type as OutputType,
      description: desc,
    });
  }
  return { ok: true, value: out };
}

/**
 * Valida el alta o la edición de una operación (R7–R9). En `update`
 * combina con `existing` para las reglas cruzadas: marcadores ↔ params
 * `in: 'path'` y `GET`/`DELETE` sin params `body`.
 */
export function validateOperationInput(
  body: unknown,
  mode: 'create' | 'update',
  existing?: OperationWrite
): Validation<OperationWrite> {
  if (!isPlainObject(body)) return fail('body', 'body must be a JSON object');
  for (const key of Object.keys(body)) {
    if (!(OPERATION_FIELDS as readonly string[]).includes(key)) {
      return fail(key, `unknown field '${key}'`);
    }
  }
  const value: OperationWrite = {};
  const required = (f: string) => mode === 'create' && !(f in body);

  if ('key' in body || required('key')) {
    if (typeof body.key !== 'string' || !OPERATION_KEY_RE.test(body.key)) {
      return fail(
        'key',
        "'key' must be a lowercase letter, then 1–63 of a-z, 0-9 or _"
      );
    }
    value.key = body.key;
  }

  if ('name' in body || required('name')) {
    const r = requiredText(body, 'name', NAME_MAX);
    if (!r.ok) return r;
    value.name = r.value;
  }

  if ('description' in body || required('description')) {
    const r = requiredText(body, 'description', OPERATION_DESCRIPTION_MAX);
    if (!r.ok) return r;
    value.description = r.value;
  }

  if ('method' in body || required('method')) {
    if (!HTTP_METHODS.includes(body.method as HttpMethod)) {
      return fail('method', "'method' must be GET, POST, PUT, PATCH or DELETE");
    }
    value.method = body.method as HttpMethod;
  }

  if ('path' in body || required('path')) {
    if (!validateRelativePath(body.path)) {
      return fail(
        'path',
        "'path' must start with '/', without '..', '//', '?', '#', '%', spaces or scheme"
      );
    }
    value.path = body.path as string;
  }

  if ('params' in body || mode === 'create') {
    const p = validateParams('params' in body ? body.params : []);
    if (!p.ok) return p;
    value.params = p.value;
  }

  if ('outputs' in body || mode === 'create') {
    const o = validateOutputs('outputs' in body ? body.outputs : []);
    if (!o.ok) return o;
    value.outputs = o.value;
  }

  const rd = optionalText(
    body,
    'response_description',
    OPERATION_DESCRIPTION_MAX
  );
  if (rd && !rd.ok) return rd;
  if (rd) value.response_description = rd.value;

  if ('is_active' in body) {
    if (typeof body.is_active !== 'boolean') {
      return fail('is_active', "'is_active' must be a boolean");
    }
    value.is_active = body.is_active;
  }

  const order = sortOrder(body);
  if (order && !order.ok) return order;
  if (order) value.sort_order = order.value;

  if (mode === 'update' && Object.keys(value).length === 0) {
    return fail('body', 'nothing to update');
  }

  // Reglas cruzadas sobre el resultado combinado.
  const method = value.method ?? existing?.method;
  const path = value.path ?? existing?.path ?? '';
  const params = value.params ?? existing?.params ?? [];

  const placeholders = pathPlaceholders(path).sort();
  const pathParams = params
    .filter((p) => p.in === 'path')
    .map((p) => p.name)
    .sort();
  if (
    placeholders.length !== pathParams.length ||
    placeholders.some((name, i) => name !== pathParams[i])
  ) {
    return fail(
      'path',
      "the '{placeholders}' in 'path' must match the 'path' parameters exactly"
    );
  }
  if (
    (method === 'GET' || method === 'DELETE') &&
    params.some((p) => p.in === 'body')
  ) {
    return fail(
      'params',
      `a ${method} operation cannot take 'body' parameters`
    );
  }

  return { ok: true, value };
}
