// ============================================================
// Modelo de formulario del catálogo de integraciones (n13.1): lo que
// guardan los inputs (texto, una fila por parámetro / salida) y cómo se
// convierte en el cuerpo de POST/PATCH de /api/platform/integrations.
//
// Fuera del componente para probarlo sin DOM (el repo no tiene jsdom),
// como `plan-form.ts`. El servidor vuelve a validar todo, estricto; aquí
// solo se monta el JSON correcto y se atrapa lo obvio (campos vacíos,
// orden no numérico) antes de un viaje de ida y vuelta.
// ============================================================

import type {
  AuthScheme,
  HttpMethod,
  IntegrationRow,
  OperationRow,
  OutputType,
  ParamAuto,
  ParamLocation,
  ParamType,
} from '@/lib/integrations/types';

export interface IntegrationForm {
  slug: string;
  name: string;
  description: string;
  logoUrl: string;
  baseUrl: string;
  authScheme: AuthScheme;
  headerName: string;
  credentialHelp: string;
  testPath: string;
  isActive: boolean;
  sortOrder: string;
}

export interface ParamRowForm {
  name: string;
  in: ParamLocation;
  type: ParamType;
  required: boolean;
  description: string;
  /** Valores permitidos separados por comas; vacío = sin `enum`. */
  enumText: string;
  /** n13.5: `uuid` en una cabecera autogenerada; `null` en el resto. */
  auto: ParamAuto | null;
}

export interface OutputRowForm {
  name: string;
  path: string;
  type: OutputType;
  description: string;
}

export interface OperationForm {
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  params: ParamRowForm[];
  outputs: OutputRowForm[];
  responseDescription: string;
  isActive: boolean;
  sortOrder: string;
}

/** Campo con el error, en la misma nomenclatura que el `field` del servidor. */
export type FormResult =
  { ok: true; body: Record<string, unknown> } | { ok: false; field: string };

export function emptyIntegrationForm(sortOrder = 0): IntegrationForm {
  return {
    slug: '',
    name: '',
    description: '',
    logoUrl: '',
    baseUrl: '',
    authScheme: 'bearer',
    headerName: '',
    credentialHelp: '',
    testPath: '/',
    isActive: false,
    sortOrder: String(sortOrder),
  };
}

export function integrationToForm(row: IntegrationRow): IntegrationForm {
  return {
    slug: row.slug,
    name: row.name,
    description: row.description ?? '',
    logoUrl: row.logo_url ?? '',
    baseUrl: row.base_url,
    authScheme: row.auth_scheme,
    headerName: row.auth_header_name ?? '',
    credentialHelp: row.credential_help ?? '',
    testPath: row.test_path,
    isActive: row.is_active,
    sortOrder: String(row.sort_order),
  };
}

const INT_RE = /^-?\d+$/;

/**
 * Cuerpo de `POST /api/platform/integrations` (`create`, con `slug`) o
 * de `PATCH /api/platform/integrations/[id]` (`edit`, sin `slug`: es
 * inmutable, R6).
 */
export function integrationFormToBody(
  form: IntegrationForm,
  mode: 'create' | 'edit'
): FormResult {
  const body: Record<string, unknown> = {};
  if (mode === 'create') {
    const slug = form.slug.trim();
    if (!slug) return { ok: false, field: 'slug' };
    body.slug = slug;
  }
  const name = form.name.trim();
  if (!name) return { ok: false, field: 'name' };
  body.name = name;
  body.description = form.description.trim() || null;
  body.logo_url = form.logoUrl.trim() || null;
  const baseUrl = form.baseUrl.trim();
  if (!baseUrl) return { ok: false, field: 'base_url' };
  body.base_url = baseUrl;
  body.auth_scheme = form.authScheme;
  if (form.authScheme === 'header') {
    const header = form.headerName.trim();
    if (!header) return { ok: false, field: 'auth_header_name' };
    body.auth_header_name = header;
  } else {
    body.auth_header_name = null;
  }
  body.credential_help = form.credentialHelp.trim() || null;
  const testPath = form.testPath.trim();
  if (!testPath) return { ok: false, field: 'test_path' };
  body.test_path = testPath;
  // Nace en borrador (R5): el estado solo se manda al editar.
  if (mode === 'edit') body.is_active = form.isActive;
  const order = form.sortOrder.trim();
  if (!INT_RE.test(order)) return { ok: false, field: 'sort_order' };
  body.sort_order = Number(order);
  return { ok: true, body };
}

export function emptyParamRow(): ParamRowForm {
  return {
    name: '',
    in: 'query',
    type: 'string',
    required: false,
    description: '',
    enumText: '',
    auto: null,
  };
}

export function emptyOutputRow(): OutputRowForm {
  return { name: '', path: '', type: 'string', description: '' };
}

export function emptyOperationForm(sortOrder = 0): OperationForm {
  return {
    key: '',
    name: '',
    description: '',
    method: 'GET',
    path: '/',
    params: [],
    outputs: [],
    responseDescription: '',
    isActive: true,
    sortOrder: String(sortOrder),
  };
}

export function operationToForm(row: OperationRow): OperationForm {
  return {
    key: row.key,
    name: row.name,
    description: row.description,
    method: row.method,
    path: row.path,
    params: row.params.map((p) => ({
      name: p.name,
      in: p.in,
      type: p.type,
      required: p.required,
      description: p.description,
      enumText: (p.enum ?? []).join(', '),
      auto: p.auto ?? null,
    })),
    outputs: row.outputs.map((o) => ({ ...o })),
    responseDescription: row.response_description ?? '',
    isActive: row.is_active,
    sortOrder: String(row.sort_order),
  };
}

/**
 * Cuerpo de alta o edición de una operación. Siempre manda la operación
 * entera (también en `edit`): las reglas cruzadas del servidor
 * (marcadores ↔ params) se comprueban sobre el conjunto, y mandarlo todo
 * evita que una edición a medias combine con lo guardado de forma
 * inesperada.
 */
export function operationFormToBody(form: OperationForm): FormResult {
  const key = form.key.trim();
  if (!key) return { ok: false, field: 'key' };
  const name = form.name.trim();
  if (!name) return { ok: false, field: 'name' };
  const description = form.description.trim();
  if (!description) return { ok: false, field: 'description' };
  const path = form.path.trim();
  if (!path) return { ok: false, field: 'path' };
  const order = form.sortOrder.trim();
  if (!INT_RE.test(order)) return { ok: false, field: 'sort_order' };

  const params = [];
  for (const row of form.params) {
    if (!row.name.trim() || !row.description.trim()) {
      return { ok: false, field: 'params' };
    }
    if (row.in === 'header') {
      // n13.5 (D2): una cabecera siempre la genera el CRM; nada de tipo,
      // obligatoriedad ni valores que elegir.
      params.push({
        name: row.name.trim(),
        in: 'header' as const,
        type: 'string' as const,
        required: true,
        description: row.description.trim(),
        auto: 'uuid' as const,
      });
      continue;
    }
    const values = row.enumText
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean);
    params.push({
      name: row.name.trim(),
      in: row.in,
      type: row.type,
      // Un parámetro de ruta siempre es obligatorio (R9).
      required: row.in === 'path' ? true : row.required,
      description: row.description.trim(),
      ...(row.type === 'string' && values.length > 0 ? { enum: values } : {}),
    });
  }

  const outputs = [];
  for (const row of form.outputs) {
    if (!row.name.trim() || !row.path.trim()) {
      return { ok: false, field: 'outputs' };
    }
    outputs.push({
      name: row.name.trim(),
      path: row.path.trim(),
      type: row.type,
      description: row.description.trim(),
    });
  }

  return {
    ok: true,
    body: {
      key,
      name,
      description,
      method: form.method,
      path,
      params,
      outputs,
      response_description: form.responseDescription.trim() || null,
      is_active: form.isActive,
      sort_order: Number(order),
    },
  };
}
