// ============================================================
// Integraciones declarativas (n13.1 `integrations-catalog`).
//
// Una integración es una fila del catálogo global con un origen HTTPS
// fijado por el operador de plataforma y un esquema de autenticación;
// sus operaciones son filas que describen una petición. Este archivo
// solo tiene tipos y constantes: lo importan tanto el servidor (validación,
// ejecutor) como los componentes del panel, así que no puede tirar de
// nada de Node.
// ============================================================

export type AuthScheme = 'bearer' | 'header';
export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
export type ParamLocation = 'path' | 'query' | 'body' | 'header';
/** n13.5 (D2): cómo genera el ejecutor el valor de una cabecera. */
export type ParamAuto = 'uuid';
export type ParamType = 'string' | 'integer' | 'number' | 'boolean';
export type OutputType = ParamType | 'object' | 'array';

export const AUTH_SCHEMES: readonly AuthScheme[] = ['bearer', 'header'];
export const HTTP_METHODS: readonly HttpMethod[] = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
];
export const PARAM_LOCATIONS: readonly ParamLocation[] = [
  'path',
  'query',
  'body',
  'header',
];
export const PARAM_AUTOS: readonly ParamAuto[] = ['uuid'];
export const PARAM_TYPES: readonly ParamType[] = [
  'string',
  'integer',
  'number',
  'boolean',
];
export const OUTPUT_TYPES: readonly OutputType[] = [
  ...PARAM_TYPES,
  'object',
  'array',
];

export interface OperationParam {
  name: string;
  in: ParamLocation;
  type: ParamType;
  required: boolean;
  description: string;
  enum?: string[];
  /**
   * Solo con `in: 'header'` (n13.5, D2): el ejecutor genera el valor en
   * cada llamada; nadie (flow, IA, automatización) lo manda.
   */
  auto?: ParamAuto;
}

/**
 * Cuerpo de error `{error:{code,message,field,request_id}}` de la API
 * remota, ya saneado (n13.5, D5). Texto de un tercero: es dato, nunca
 * instrucción.
 */
export interface RemoteError {
  code: string;
  message: string | null;
  field: string | null;
  requestId: string | null;
}

export interface OperationOutput {
  name: string;
  path: string;
  type: OutputType;
  description: string;
}

/** Columnas de `integrations` que escribe el panel. */
export interface IntegrationWrite {
  slug?: string;
  name?: string;
  description?: string | null;
  logo_url?: string | null;
  base_url?: string;
  auth_scheme?: AuthScheme;
  auth_header_name?: string | null;
  credential_help?: string | null;
  test_path?: string;
  is_active?: boolean;
  sort_order?: number;
}

/** Columnas de `integration_operations` que escribe el panel. */
export interface OperationWrite {
  key?: string;
  name?: string;
  description?: string;
  method?: HttpMethod;
  path?: string;
  params?: OperationParam[];
  outputs?: OperationOutput[];
  response_description?: string | null;
  is_active?: boolean;
  sort_order?: number;
}

export type Validation<T> =
  { ok: true; value: T } | { ok: false; error: string; field: string };

/** Fila de `integrations` tal como la leen el panel y el ejecutor. */
export interface IntegrationRow {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logo_url: string | null;
  base_url: string;
  auth_scheme: AuthScheme;
  auth_header_name: string | null;
  credential_help: string | null;
  test_path: string;
  is_active: boolean;
  sort_order: number;
  created_at?: string;
  updated_at?: string;
}

/** Fila de `integration_operations`. */
export interface OperationRow {
  id: string;
  integration_id: string;
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  params: OperationParam[];
  outputs: OperationOutput[];
  response_description: string | null;
  is_active: boolean;
  sort_order: number;
}

/** D6: una llamada que tarde más se aborta (`timeout`). */
export const INTEGRATION_TIMEOUT_MS = 10_000;
/** D6: 256 KiB; más se corta y devuelve `too_large`. */
export const INTEGRATION_MAX_RESPONSE_BYTES = 262_144;
/** n13.5 (D5): cuánto cuerpo de un error se lee como mucho (8 KiB). */
export const INTEGRATION_MAX_ERROR_BYTES = 8_192;
export const INTEGRATION_USER_AGENT = 'Cabbity-CRM-Integrations/1';

/** Resultado de la prueba de conexión guardado en `account_integrations`. */
export type IntegrationTestStatus =
  'ok' | 'auth_failed' | 'unreachable' | 'error';

/** Estado de una integración para una cuenta, tal como lo ve el cliente. */
export interface AccountIntegrationView {
  id: string;
  slug: string;
  name: string;
  description: string | null;
  logoUrl: string | null;
  authScheme: AuthScheme;
  authHeaderName: string | null;
  credentialHelp: string | null;
  retired: boolean;
  operations: {
    key: string;
    name: string;
    description: string;
    method: HttpMethod;
  }[];
  enabled: boolean;
  credentialLast4: string | null;
  enabledAt: string | null;
  lastTestedAt: string | null;
  lastTestStatus: IntegrationTestStatus | null;
}
