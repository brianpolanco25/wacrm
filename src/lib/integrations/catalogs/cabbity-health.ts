// ============================================================
// Catálogo de Cabbity Health (n13.5): la integración y sus 16
// operaciones, a partir de `docs/integrations/cabbity-health-openapi.json`.
//
// Lo carga `scripts/integrations-bootstrap-catalog.ts cabbity-health` en
// `integrations` / `integration_operations`. Las `description` y
// `response_description` son lo que lee la IA (n13.3) para elegir
// herramienta: dicen cuándo usarla, qué pedir antes al cliente y qué
// devuelve.
//
// Fuera (D1): `PATCH`/`DELETE /patients/{id}` y `DELETE /appointments/{id}`
// (alias de `cancel`). `list_patients` y `get_patient` nacen apagadas
// (devuelven datos personales completos). `list_appointments` exige
// `patient_id` aunque el OpenAPI acepte un rango (agenda entera). Sin
// filtro `status`: Health lo exige como lista estilo PHP (`status[]=`) y
// el modelo no tiene arrays; la IA filtra sobre el resultado (§M1, D4).
//
// Ejecutable por Node 24 sin alias: solo `import type` y rutas `.ts`.
// La clave de Health nunca aparece aquí: la pega cada cliente en Ajustes.
// ============================================================

import type {
  OperationAiPolicy,
  OperationOutput,
  OperationParam,
} from '../types.ts';
import type {
  CatalogOperation,
  IntegrationCatalogDefinition,
} from './definition.ts';

type Loc = OperationParam['in'];
type Typ = OperationParam['type'];

function param(
  name: string,
  where: Loc,
  type: Typ,
  required: boolean,
  description: string,
  values?: string[]
): OperationParam {
  return {
    name,
    in: where,
    type,
    required,
    description,
    ...(values ? { enum: values } : {}),
  };
}

function out(
  name: string,
  path: string,
  type: OperationOutput['type'],
  description: string
): OperationOutput {
  return { name, path, type, description };
}

/** D2: la genera el CRM en cada llamada; nadie la manda. */
const IDEMPOTENCY_KEY: OperationParam = {
  name: 'Idempotency-Key',
  in: 'header',
  type: 'string',
  required: true,
  auto: 'uuid',
  description: 'Clave de idempotencia; la genera el CRM en cada llamada.',
};

const DOCUMENT_TYPES = ['cedula', 'passport'];

/**
 * n13.8: el ejecutor quita guiones, espacios y puntos antes de enviarlo
 * (Health exige la cédula en 11 dígitos y responde 422 si no); la IA no
 * tiene que pedirlo «sin guiones».
 */
const DOCUMENT_NUMBER = (where: Loc, required: boolean): OperationParam => ({
  ...param(
    'document_number',
    where,
    'string',
    required,
    'Número de documento. El cliente puede darlo con o sin guiones o espacios: el sistema lo limpia antes de enviarlo; no le pidas que lo repita sin guiones.'
  ),
  normalize: 'compact',
});
const SEXES = ['male', 'female', 'other'];
const ORIGINS = ['integration', 'staff', 'mine'];

const ID_PATH = (what: string) =>
  param('id', 'path', 'integer', true, `Id de ${what} en Cabbity Health.`);
const DATE = (what: string) =>
  `${what} en formato YYYY-MM-DD (fecha local del centro).`;
const STARTS_AT =
  'Inicio de la cita en ISO 8601 con el offset de la zona del centro (p. ej. 2026-11-12T10:30:00-04:00). Debe ser un starts_at devuelto por find_availability.';
const CURSOR =
  'Cursor de paginación: el meta.next_cursor de la página anterior. Omítelo en la primera página.';

/** n13.7 R24: operaciones que fundamentan afirmaciones de agenda. */
const SCHEDULE: OperationAiPolicy = { grounds: ['schedule'] };

const OPERATIONS: Omit<CatalogOperation, 'sort_order'>[] = [
  {
    key: 'get_center',
    name: 'Datos del centro',
    description:
      'Datos del centro de salud conectado: nombre, zona horaria y permisos de la clave. Úsala al empezar si necesitas la zona horaria para interpretar o escribir horas (los starts_at van con el offset de esa zona).',
    method: 'GET',
    path: '/me',
    params: [],
    outputs: [
      out('center_name', 'data.center.name', 'string', 'Nombre del centro'),
      out('timezone', 'data.center.timezone', 'string', 'Zona horaria IANA'),
      out('scopes', 'data.integration.scopes', 'array', 'Permisos de la clave'),
    ],
    response_description:
      'data.center {id, name, timezone}; data.integration.scopes (permisos de la clave); data.rate_limit.per_minute.',
    is_active: true,
  },
  {
    key: 'list_locations',
    name: 'Sedes',
    description:
      'Sedes del centro con profesionales agendables. Úsala para saber qué location_id pasar a find_availability o create_appointment, o para responder dónde queda una sede.',
    method: 'GET',
    path: '/locations',
    params: [],
    outputs: [out('locations', 'data', 'array', 'Sedes')],
    response_description:
      'data[] {id, name, address, city, phone, timezone}. Usa id como location_id.',
    is_active: true,
  },
  {
    key: 'list_practitioners',
    name: 'Profesionales',
    description:
      'Profesionales agendables, opcionalmente de una sede o de una especialidad. Úsala para responder qué médicos hay o para obtener el membership_id de un profesional antes de buscar disponibilidad.',
    method: 'GET',
    path: '/practitioners',
    params: [
      param(
        'location_id',
        'query',
        'integer',
        false,
        'Solo los que atienden en esta sede (id de list_locations).'
      ),
      param(
        'specialty',
        'query',
        'string',
        false,
        'Solo los de esta especialidad (key de list_specialties).'
      ),
    ],
    outputs: [out('practitioners', 'data', 'array', 'Profesionales')],
    response_description:
      'data[] {membership_id, name, specialty {key, label}, additional_specialties, location_ids}. Usa membership_id para identificar al profesional en otras operaciones.',
    is_active: true,
  },
  {
    key: 'get_practitioner',
    name: 'Profesional',
    description:
      'Detalle de un profesional por su membership_id (de list_practitioners o de una cita).',
    method: 'GET',
    path: '/practitioners/{id}',
    params: [ID_PATH('el profesional (membership_id)')],
    outputs: [out('practitioner_name', 'data.name', 'string', 'Nombre')],
    response_description:
      'data {membership_id, name, specialty {key, label}, additional_specialties, location_ids}.',
    is_active: true,
  },
  {
    key: 'list_specialties',
    name: 'Especialidades',
    description:
      'Especialidades con profesionales agendables. Úsala si el cliente pregunta qué especialidades hay; pasa key como specialty en list_practitioners o find_availability.',
    method: 'GET',
    path: '/specialties',
    params: [],
    outputs: [out('specialties', 'data', 'array', 'Especialidades')],
    response_description: 'data[] {key, label}. label es el nombre legible.',
    is_active: true,
  },
  {
    key: 'find_availability',
    name: 'Buscar disponibilidad',
    description:
      'Huecos libres para citas en una sede entre dos fechas (YYYY-MM-DD; to como mucho 13 días después de from). Filtra por profesional (membership_id) o especialidad. Úsala SIEMPRE antes de crear o reprogramar una cita y ofrece al cliente solo huecos de esta lista.',
    method: 'GET',
    path: '/availability',
    params: [
      param(
        'location_id',
        'query',
        'integer',
        true,
        'Sede (id de list_locations).'
      ),
      param('from', 'query', 'string', true, DATE('Primer día del rango')),
      param(
        'to',
        'query',
        'string',
        true,
        DATE('Último día del rango, como mucho 13 días después de from')
      ),
      param(
        'membership_id',
        'query',
        'integer',
        false,
        'Solo los huecos de este profesional (de list_practitioners).'
      ),
      param(
        'specialty',
        'query',
        'string',
        false,
        'Solo los huecos de esta especialidad (key de list_specialties).'
      ),
      param(
        'limit',
        'query',
        'integer',
        false,
        'Máximo de huecos a devolver (1–500).'
      ),
    ],
    outputs: [
      out('slots', 'data', 'array', 'Huecos libres'),
      out(
        'truncated',
        'meta.truncated',
        'boolean',
        'Hay más huecos que los devueltos'
      ),
    ],
    response_description:
      'data[] {membership_id, practitioner_name, location_id, starts_at, ends_at}, con las horas en ISO 8601 con offset; meta.truncated es true si hay más huecos de los devueltos (acorta el rango o filtra por profesional). Error 422 validation_failed si el rango pasa de 13 días.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'lookup_patient',
    name: 'Buscar paciente',
    description:
      'Busca si el cliente ya es paciente del centro por documento (document_type + document_number) o por teléfono. Úsala SIEMPRE antes de create_patient para no duplicar pacientes. Pide el documento al cliente si no lo tienes; acéptalo con o sin guiones o espacios (el sistema lo limpia), no le pidas que lo repita sin guiones. Si aun así el documento está mal formado (p. ej. una cédula que no tiene 11 dígitos), Health responde 422 validation_failed con field = document_number: vuelve a pedirle el dato al cliente.',
    method: 'POST',
    path: '/patients/lookup',
    params: [
      param(
        'document_type',
        'body',
        'string',
        false,
        'Tipo de documento: cedula o passport. Va junto con document_number.',
        DOCUMENT_TYPES
      ),
      DOCUMENT_NUMBER('body', false),
      param(
        'phone',
        'body',
        'string',
        false,
        'Teléfono del cliente, con código de país (p. ej. +18095551234).'
      ),
    ],
    outputs: [
      out('source', 'data.source', 'string', 'center o not_found'),
      out('matches', 'data.matches', 'array', 'Pacientes que coinciden'),
      out(
        'patient_id',
        'data.matches.0.id',
        'integer',
        'Id del primer paciente que coincide'
      ),
    ],
    response_description:
      'data.source es center (encontrado) o not_found; data.matches[] {id, first_name, last_name, document_type, document_hint} (document_hint son solo los últimos dígitos). Usa matches[].id como patient_id.',
    is_active: true,
  },
  {
    key: 'list_patients',
    name: 'Listar pacientes',
    description:
      'Lista pacientes activos filtrando por documento, teléfono o nombre. Solo para procesos internos: para identificar a quien escribe usa lookup_patient.',
    method: 'GET',
    path: '/patients',
    params: [
      param(
        'document_type',
        'query',
        'string',
        false,
        'Tipo de documento: cedula o passport.',
        DOCUMENT_TYPES
      ),
      DOCUMENT_NUMBER('query', false),
      param('phone', 'query', 'string', false, 'Teléfono, con código de país.'),
      param(
        'name',
        'query',
        'string',
        false,
        'Nombre o apellido (al menos 2 caracteres).'
      ),
      param('limit', 'query', 'integer', false, 'Tamaño de página (1–100).'),
      param('cursor', 'query', 'string', false, CURSOR),
    ],
    outputs: [
      out('patients', 'data', 'array', 'Pacientes'),
      out(
        'next_cursor',
        'meta.next_cursor',
        'string',
        'Cursor de la página siguiente'
      ),
    ],
    response_description:
      'data[] pacientes con sus datos administrativos; meta.next_cursor: pásalo como cursor para pedir la página siguiente hasta que sea null.',
    is_active: false,
  },
  {
    key: 'create_patient',
    name: 'Registrar paciente',
    description:
      'Registra un paciente nuevo en el centro. Antes: busca con lookup_patient (si existe, no lo crees). No pidas autorización ni consentimiento al cliente: al dar sus datos para la cita por WhatsApp ya consiente el registro. Envía siempre consent.accepted = true, consent.accepted_at = fecha y hora actual ISO 8601 con offset, consent.reference = canal y fecha (p. ej. «WhatsApp, conversación del 2026-11-10»). Nombre, apellido, documento y teléfono son obligatorios; el documento puede venir con o sin guiones o espacios (el sistema lo limpia).',
    method: 'POST',
    path: '/patients',
    params: [
      IDEMPOTENCY_KEY,
      param('first_name', 'body', 'string', true, 'Nombre del paciente.'),
      param('last_name', 'body', 'string', true, 'Apellidos del paciente.'),
      param(
        'document_type',
        'body',
        'string',
        true,
        'Tipo de documento: cedula o passport.',
        DOCUMENT_TYPES
      ),
      DOCUMENT_NUMBER('body', true),
      param('birth_date', 'body', 'string', false, DATE('Fecha de nacimiento')),
      param(
        'sex',
        'body',
        'string',
        false,
        'Sexo: male, female u other.',
        SEXES
      ),
      param(
        'phone',
        'body',
        'string',
        true,
        'Teléfono, con código de país (p. ej. +18095551234).'
      ),
      param('email', 'body', 'string', false, 'Correo electrónico, si lo da.'),
      param(
        'consent.accepted',
        'body',
        'boolean',
        true,
        'true siempre: al dar sus datos por WhatsApp el cliente consiente el registro; no le preguntes.'
      ),
      param(
        'consent.accepted_at',
        'body',
        'string',
        true,
        'Fecha y hora actual, ISO 8601 con offset (p. ej. 2026-11-10T10:15:00-04:00).'
      ),
      param(
        'consent.reference',
        'body',
        'string',
        true,
        'Canal y fecha (p. ej. «WhatsApp, conversación del 2026-11-10»). Máximo 191 caracteres.'
      ),
    ],
    outputs: [
      out('patient_id', 'data.id', 'integer', 'Id del paciente creado'),
    ],
    response_description:
      'data {id, first_name, last_name, document_type, document_hint}. data.id es el patient_id. Error 409 patient_exists: ya existía, búscalo con lookup_patient. Error 422 consent_required si falta el objeto consent: reenvía con consent.accepted = true, sin preguntar al cliente. Error 422 validation_failed con field = document_number si el documento está mal formado: vuelve a pedirle el dato al cliente.',
    is_active: true,
  },
  {
    key: 'get_patient',
    name: 'Paciente',
    description:
      'Datos administrativos de un paciente por id (nunca clínicos). Solo para procesos internos.',
    method: 'GET',
    path: '/patients/{id}',
    params: [ID_PATH('el paciente')],
    outputs: [out('patient', 'data', 'object', 'Paciente')],
    response_description:
      'data {id, first_name, last_name, document_type, document_number, birth_date, sex, phone, email, address, …}.',
    is_active: false,
  },
  {
    key: 'list_appointments',
    name: 'Citas del paciente',
    description:
      'Citas de un paciente (patient_id de lookup_patient), opcionalmente entre dos fechas (como mucho 31 días). No filtra por estado: si el cliente pregunta por citas confirmadas o canceladas, filtra tú el resultado por status. Úsala cuando el cliente pregunte por sus citas, o antes de reprogramar o cancelar para obtener el id de la cita.',
    method: 'GET',
    path: '/appointments',
    params: [
      param(
        'patient_id',
        'query',
        'integer',
        true,
        'Paciente (id de lookup_patient).'
      ),
      param('from', 'query', 'string', false, DATE('Primer día del rango')),
      param(
        'to',
        'query',
        'string',
        false,
        DATE('Último día del rango, como mucho 31 días después de from')
      ),
      param('location_id', 'query', 'integer', false, 'Solo las de esta sede.'),
      param(
        'membership_id',
        'query',
        'integer',
        false,
        'Solo las de este profesional.'
      ),
      param(
        'origin',
        'query',
        'string',
        false,
        'Quién creó la cita: integration (integraciones), staff (el centro) o mine (esta clave).',
        ORIGINS
      ),
      param('limit', 'query', 'integer', false, 'Tamaño de página (1–100).'),
      param('cursor', 'query', 'string', false, CURSOR),
    ],
    outputs: [
      out('appointments', 'data', 'array', 'Citas'),
      out(
        'next_cursor',
        'meta.next_cursor',
        'string',
        'Cursor de la página siguiente'
      ),
    ],
    response_description:
      'data[] {id, status, status_label, starts_at, ends_at, practitioner, location, …}; meta.next_cursor: pásalo como cursor para la página siguiente hasta que sea null.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'create_appointment',
    name: 'Crear cita',
    description:
      'Crea una cita. starts_at debe ser exactamente un starts_at devuelto por find_availability para ese membership_id y location_id, en ISO 8601 con el offset de la zona del centro (p. ej. 2026-11-12T10:30:00-04:00; ver get_center). Confirma con el cliente fecha, hora y profesional antes de crearla. Un paciente puede tener como mucho 3 citas futuras creadas por integraciones.',
    method: 'POST',
    path: '/appointments',
    params: [
      IDEMPOTENCY_KEY,
      param(
        'patient_id',
        'body',
        'integer',
        true,
        'Paciente (id de lookup_patient o create_patient).'
      ),
      param(
        'membership_id',
        'body',
        'integer',
        true,
        'Profesional (membership_id del hueco elegido).'
      ),
      param(
        'location_id',
        'body',
        'integer',
        true,
        'Sede (location_id del hueco elegido).'
      ),
      param('starts_at', 'body', 'string', true, STARTS_AT),
      param(
        'reason',
        'body',
        'string',
        false,
        'Motivo breve de la cita, sin datos clínicos (máximo 255).'
      ),
      param(
        'external_reference',
        'body',
        'string',
        false,
        'Referencia propia del CRM (máximo 64).'
      ),
    ],
    outputs: [
      out('appointment_id', 'data.id', 'integer', 'Id de la cita creada'),
      out('starts_at', 'data.starts_at', 'string', 'Inicio'),
      out('status', 'data.status', 'string', 'Estado'),
    ],
    response_description:
      'data: la cita creada {id, status, starts_at, ends_at, practitioner, location}. Errores: 409 slot_unavailable (el hueco se ocupó: vuelve a find_availability), 409 too_many_upcoming_appointments (ya tiene 3 citas futuras), 422 validation_failed.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'get_appointment',
    name: 'Cita',
    description: 'Estado y detalle de una cita por id.',
    method: 'GET',
    path: '/appointments/{id}',
    params: [ID_PATH('la cita')],
    outputs: [
      out('status', 'data.status', 'string', 'Estado'),
      out('starts_at', 'data.starts_at', 'string', 'Inicio'),
    ],
    response_description:
      'data {id, status, status_label, starts_at, ends_at, practitioner, location}.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'reschedule_appointment',
    name: 'Reprogramar cita',
    description:
      'Mueve una cita a otro hueco. starts_at debe salir de find_availability, en ISO 8601 con offset. Confirma con el cliente la nueva fecha y hora antes.',
    method: 'POST',
    path: '/appointments/{id}/reschedule',
    params: [
      IDEMPOTENCY_KEY,
      ID_PATH('la cita'),
      param('starts_at', 'body', 'string', true, STARTS_AT),
      param(
        'membership_id',
        'body',
        'integer',
        false,
        'Otro profesional, si cambia (membership_id del hueco).'
      ),
      param(
        'location_id',
        'body',
        'integer',
        false,
        'Otra sede, si cambia (location_id del hueco).'
      ),
    ],
    outputs: [
      out('starts_at', 'data.starts_at', 'string', 'Nuevo inicio'),
      out('status', 'data.status', 'string', 'Estado'),
    ],
    response_description:
      'data: la cita con el nuevo horario. 409 appointment_not_changeable si ya no se puede mover (pasada, atendida o cancelada); 409 slot_unavailable si el hueco se ocupó.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'confirm_appointment',
    name: 'Confirmar cita',
    description:
      'Marca una cita como confirmada cuando el cliente confirma que asistirá.',
    method: 'POST',
    path: '/appointments/{id}/confirm',
    params: [IDEMPOTENCY_KEY, ID_PATH('la cita')],
    outputs: [out('status', 'data.status', 'string', 'Estado')],
    response_description:
      'data: la cita con status confirmed. 409 appointment_not_changeable si ya no se puede confirmar.',
    is_active: true,
    ai_policy: SCHEDULE,
  },
  {
    key: 'cancel_appointment',
    name: 'Cancelar cita',
    description:
      'Cancela una cita cuando el cliente lo pide expresamente. reason es opcional (motivo breve). Antes, en un mensaje anterior, localiza la cita y consulta find_availability para ofrecer otra fecha; el sistema bloquea la cancelación si no.',
    method: 'POST',
    path: '/appointments/{id}/cancel',
    params: [
      IDEMPOTENCY_KEY,
      ID_PATH('la cita'),
      param(
        'reason',
        'body',
        'string',
        false,
        'Motivo breve de la cancelación (máximo 255).'
      ),
    ],
    outputs: [out('status', 'data.status', 'string', 'Estado')],
    response_description:
      'data: la cita con status cancelled. 409 appointment_not_changeable si ya no se puede cancelar.',
    is_active: true,
    ai_policy: {
      requires_prior: [
        ['list_appointments', 'get_appointment'],
        ['find_availability'],
      ],
    },
  },
];

export const CABBITY_HEALTH_CATALOG: IntegrationCatalogDefinition = {
  integration: {
    slug: 'cabbity-health',
    name: 'Cabbity Health',
    description:
      'Agenda de un centro de salud en Cabbity Health: profesionales, disponibilidad, pacientes y citas. Nunca devuelve datos clínicos.',
    logo_url: null,
    base_url: 'https://api.health.cabbity.com/api/integrations/v1',
    auth_scheme: 'bearer',
    auth_header_name: null,
    credential_help:
      'Pide al administrador de Cabbity Health una clave de integración del centro (empieza por chk_live_) con los permisos availability:read, patients:read, patients:write, appointments:read y appointments:write. Pégala tal cual; si caduca o se revoca, la prueba de conexión dirá que falló la autenticación.',
    test_path: '/me',
    sort_order: 0,
  },
  operations: OPERATIONS.map((op, i) => ({ ...op, sort_order: (i + 1) * 10 })),
};
