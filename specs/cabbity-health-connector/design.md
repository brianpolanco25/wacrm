# n13.5 `cabbity-health-connector` — diseño

Lee antes `specs/integrations-catalog/design.md` (n13.1). Todo lo que aquí no se menciona de n13.1
queda **intacto**: allowlist de origen y prefijo (R21 de n13.1), SSRF y `isDeliverableUrl`, plazo de
10 s, 256 KiB, cubo `integrationCall` de 60/min, `decrypt` único en `execute.ts`, nada de cuerpos,
cabeceras ni params en `integration_calls`.

No hay API de framework nueva (ni rutas, ni `proxy`, ni Server Actions): CP7 no aplica más allá de
no romper `src/app/api/platform/integrations/**`, que no cambian.

## 1. Decisiones (detalle de la tabla de requirements.md)

### D1 — Subconjunto de operaciones

19 operaciones en el OpenAPI → **16 en el catálogo**.

| Fuera | Por qué |
|---|---|
| `PATCH /patients/{id}` | Editar datos administrativos desde un chat abre la puerta a que un contacto cambie el teléfono o documento de otro paciente. Sin caso de uso pedido. |
| `DELETE /patients/{id}` | Desactivar pacientes no es tarea de un bot ni de un flow. |
| `DELETE /appointments/{id}` | Alias de `cancel` sin motivo; duplicarlo confunde a la IA al elegir herramienta. |

Dentro pero **apagadas** al cargar (`is_active: false`; el operador las enciende en `/platform` si
un cliente lo necesita, y el script no vuelve a tocarlo):

| Clave | Por qué |
|---|---|
| `list_patients` | Busca por nombre y devuelve `IntegrationPatient` completo (documento, teléfono, email, dirección). Una IA expuesta a cualquier contacto de WhatsApp podría enumerar pacientes. `lookup_patient` cubre el caso real con `PatientSummary` (`document_hint`, no el número). |
| `get_patient` | Devuelve el `IntegrationPatient` completo de cualquier id. Mismo riesgo. |

Desviación deliberada del OpenAPI: `list_appointments` declara `patient_id` **obligatorio**. El
OpenAPI acepta `patient_id` o un rango `from/to` (agenda entera del centro, con nombres de
pacientes); el caso de uso del CRM es «mis citas». La agenda completa queda fuera.

### D2 — Cabecera autogenerada: `in: 'header'` + `auto: 'uuid'`

`OperationParam` gana una ubicación `header` y un campo opcional `auto?: 'uuid'`. Reglas: una
cabecera **siempre** es `auto` (no hay cabeceras con valor del llamador en esta feature: evita
inyección de cabeceras y choques con la de autenticación). El ejecutor la rellena; el validador de
llamada no la conoce (→ `unknown` si alguien la manda); `callerParams()` la oculta a n13.2 y n13.3.
n13.3 ya genera el esquema solo con `path|query|body`, así que encaja sin cambios.

Descartada: columna `integration_operations.idempotency text` — exige migración, solo sirve para
una cabecera concreta y el editor del panel tendría otro control aparte.

### D3 — Cuerpo anidado: nombres con punto

`consent.accepted`, `consent.accepted_at`, `consent.reference` como tres parámetros `body`
escalares. El constructor arma `{"consent":{…}}`. Es lo que n13.3 ya prevé («nombres con punto →
propiedades anidadas») y el editor del panel no cambia (un nombre más largo). Hasta 3 segmentos;
un nombre no puede ser hoja y prefijo a la vez.

Descartada: `type: 'object'` con subesquema — rompe `coerce` (solo escalares), el editor y el
validador de literales de n13.2.

### D4 — `status` de `GET /appointments`

El OpenAPI lo declara `type: array` sin `style`/`explode`, o sea el valor por defecto de OpenAPI 3
para query: `form` + `explode: true` → `status=a&status=b`, y un array de un elemento es
`status=a`. Un parámetro escalar `status` con `enum` de los 7 estados produce exactamente eso. El
guion §M1 paso 6 lo confirma contra el servicio real; si respondiera 422, el implementer quita el
parámetro de la definición y lo anota en el informe (R16). Multi-valor: deuda (la IA puede filtrar
el resultado, que trae `status` por cita).

### D5 — Error remoto conservado

Hoy `http.ts` cancela el cuerpo de todo no-2xx. Se cambia a: si el no-2xx no es 3xx, su
`content-type` contiene `json` y `content-length` (si viene) ≤ 8 KiB, se leen como mucho 8 KiB con
el mismo `readCapped` y se pasa a `parseRemoteError`. El resultado viaja como campo **opcional**
`remoteError` en `HttpResult` y en la rama `ok: false` de `IntegrationCallResult`. Es aditivo y
convive con `paramProblem?` de n13.2 (quien fusione segundo rebasa dos líneas del tipo).

No se guarda en `integration_calls` (exigiría columna; y `message` es texto de un tercero). No se
escribe en consola. `details` se descarta siempre (objeto arbitrario).

Descartada: un `outcome` por código (`remote_conflict`, …) — rompe el CHECK
`integration_calls_outcome_check` de 091 y los `it.each` de outcomes de n13.2.

Un 429 de Health queda como `outcome: 'http_error'`, `status: 429`, `remoteError.code:
'rate_limited'`; distinto del `outcome: 'rate_limited'` local (cubo de 60/min del CRM, que salta
antes que el de 120/min de Health en una sola cuenta).

### D6 — Dónde vive la definición

`src/lib/integrations/catalogs/cabbity-health.ts`, tipado contra `IntegrationWrite`/`OperationWrite`,
con solo `import type` y extensiones `.ts` para que Node 24 lo ejecute sin alias (como
`src/lib/billing/paypal-catalog.ts` para `scripts/paypal-bootstrap-catalog.ts`). Registro
`catalogs/index.ts` (`slug → definición`) y script genérico, para que el siguiente conector solo
añada un archivo.

### D7 — Sin migración

`integration_operations.params` es `jsonb NOT NULL` con un único CHECK (`jsonb_typeof = 'array'`,
091). `in: 'header'`, `auto` y nombres con punto caben sin tocar el esquema. Ni `verify-schema.sql`
ni `progress/checks_*.sql` (no hay objeto nuevo que asertar). 092 sigue reservada por n13.2.

## 2. Cambios en el modelo y el ejecutor

### 2.1 `src/lib/integrations/types.ts`

```ts
export type ParamLocation = 'path' | 'query' | 'body' | 'header';
export const PARAM_LOCATIONS: readonly ParamLocation[] = ['path', 'query', 'body', 'header'];
export type ParamAuto = 'uuid';
export const PARAM_AUTOS: readonly ParamAuto[] = ['uuid'];

export interface OperationParam {
  name: string; in: ParamLocation; type: ParamType; required: boolean;
  description: string; enum?: string[];
  /** Solo con `in: 'header'`: el ejecutor genera el valor; nadie lo manda. */
  auto?: ParamAuto;
}

/** Cuerpo de error `{error:{code,message,field,request_id}}` ya saneado. */
export interface RemoteError {
  code: string; message: string | null; field: string | null; requestId: string | null;
}

/** D5: cuánto cuerpo de error se lee como mucho. */
export const INTEGRATION_MAX_ERROR_BYTES = 8_192;
```

### 2.2 `src/lib/integrations/catalog-validate.ts` (R9, R13)

- Nuevas constantes: `PARAM_SEGMENT_RE = /^[a-z][a-zA-Z0-9_]{0,63}$/`, `MAX_PARAM_DEPTH = 3`.
  `PARAM_NAME_RE` no cambia (la usan también los `outputs`).
- `validateParams`: claves permitidas + `'auto'`; mensaje de `in` → «path, query, body or header».
  - `in === 'header'`: `auto === 'uuid'`, `type === 'string'`, `required === true`, sin `enum`,
    `HEADER_NAME_RE.test(name)`, `name.toLowerCase()` ∉ `FORBIDDEN_AUTH_HEADERS` ∪
    `{'authorization'}`; unicidad case-insensitive entre cabeceras.
  - `in !== 'header'` y `'auto' in item` (no `undefined`) → error «auto is only allowed with in:
    'header'».
  - Nombre: cabecera → regla anterior; `body` → `name.split('.')` con 1–3 segmentos que cumplan
    `PARAM_SEGMENT_RE`; `path`/`query` → `PARAM_NAME_RE` (sin punto, como hoy).
  - Tras el bucle: ningún nombre `body` es prefijo `n + '.'` de otro → error «'consent' cannot be
    both a value and an object».
  - `param.auto` se copia a la salida solo si existe (la forma de los params de n13.1 no cambia,
    R18).
- `validateOperationInput`: la regla cruzada «GET/DELETE sin `body`» sigue; una cabecera en GET es
  válida (no hay caso, pero no estorba). `pathPlaceholders` ↔ params `path` sin cambios.

### 2.3 `src/lib/integrations/request.ts` (R10, R11, R12, R14, R15)

```ts
/** Los parámetros que puede mandar quien llama (sin los `auto`). n13.2 y n13.3 los usan. */
export function callerParams(params: OperationParam[]): OperationParam[];

export interface BuildOptions { /** Tests: por defecto `globalThis.crypto.randomUUID`. */ uuid?: () => string }

export function buildIntegrationRequest(
  integration: { base_url: string },
  operation: { method: HttpMethod; path: string; params: OperationParam[] },
  values: Record<string, ParamValue>,
  options?: BuildOptions
): BuiltRequest | { blocked: true };

/** Copia `headers` sin ninguna clave igual a `name` (sin mayúsculas) y añade `[name, value]`. */
export function withAuthHeader(
  headers: Record<string, string>, name: string, value: string
): Record<string, string>;
```

- `validateCallParams(declared, given)`:
  1. Aplana `given`: una clave cuyo valor es objeto plano (`Object.getPrototypeOf === Object.prototype`)
     y que es prefijo de algún parámetro declarado con punto se expande a `prefijo.hija` (recursivo
     hasta 3 niveles). Si la hoja ya venía con punto → `{ ok:false, problem:'unknown', param:
     'consent.accepted' }`. Lectura con `hasOwnProperty`, como hoy.
  2. Valida contra `callerParams(declared)`: cualquier clave de un `auto` cae en `unknown`.
  3. Resto idéntico.
- `buildIntegrationRequest`:
  - Ruta y query sin cambios (los `header` no tocan la URL → la allowlist R21 de n13.1 no cambia).
  - Cuerpo: para cada `body` presente, `setNested(body, name.split('.'), value)` creando
    intermedios con `Object.prototype.hasOwnProperty` + asignación (nunca lectura heredada); el
    padre solo existe si alguna hoja viaja.
  - Cabeceras: tras `Accept`/`User-Agent`/`Content-Type`, para cada `in: 'header'` con `auto:
    'uuid'` → `headers[name] = (options.uuid ?? (() => globalThis.crypto.randomUUID()))()`. Se
    ignora cualquier `values[name]`.
- `withAuthHeader`: lo usan las dos llamadas de `execute.ts` en lugar de `{ ...built.headers,
  [name]: value }`.

### 2.4 `src/lib/integrations/remote-error.ts` (nuevo, puro) (R19)

```ts
export function parseRemoteError(text: string): RemoteError | null;
```

`JSON.parse` en `try`; exige objeto con `error` objeto y `error.code` string que cumpla
`/^[A-Za-z0-9_.-]{1,64}$/`. `message`: string → quitar `[\u0000-\u001f\u007f]`, `trim`, cortar a 300
(si queda vacío → `null`); `field`: string ≤ 100 o `null`; `requestId` desde `error.request_id`
string ≤ 100 o `null`. Cualquier otra forma → `null`.

### 2.5 `src/lib/integrations/http.ts` (R19)

```ts
export interface HttpResult { outcome; status; data; latencyMs; remoteError?: RemoteError }
```

Rama `res.status < 200 || res.status >= 300`:
- 3xx → igual que hoy (`cancelBody`, `http_error`).
- Si `content-type` no contiene `json`, o `content-length` declarado > `INTEGRATION_MAX_ERROR_BYTES`
  → `cancelBody`, `http_error` sin `remoteError`.
- Si no: `readCapped(res, INTEGRATION_MAX_ERROR_BYTES)`; `TooLarge` o fallo de lectura →
  `http_error` sin `remoteError` (si el plazo saltó, sigue siendo `http_error` con el `status`: la
  respuesta ya llegó). Con texto → `parseRemoteError`; si no es `null`, `done('http_error', status,
  null)` + `remoteError`.
- El plazo de 10 s y el `clearTimeout` del `finally` cubren también esta lectura.

### 2.6 `src/lib/integrations/execute.ts` (R10–R12, R20, R21)

```ts
export type IntegrationCallResult =
  | { ok: true; status: number; data: unknown; latencyMs: number }
  | { ok: false; outcome: …; status: number | null; latencyMs: number;
      /** Solo con outcome 'http_error' y cuerpo de error reconocible (D5). */
      remoteError?: RemoteError };

export type ExecuteDeps = IntegrationHttpDeps & {
  entitlements?: …;
  /** Tests: generador de las cabeceras `auto: 'uuid'`. */
  uuid?: () => string;
};
```

- `finish(outcome, status, latencyMs, data, remoteError?)` añade `remoteError` solo en `ok:false`
  y solo si viene; `recordIntegrationCall` **no** cambia (mismas siete columnas).
- `buildIntegrationRequest(…, check.values, { uuid: deps.uuid })`.
- `performIntegrationRequest(accountId, { ...built, headers: withAuthHeader(built.headers, name,
  value) }, deps)` en `executeIntegrationOperation` y en `testIntegrationConnection`.
- `testIntegrationConnection`: sin cambios de contrato; `testStatusFor` ya da `auth_failed` en
  401/403 (R21 solo añade el test con el cuerpo real de Health).

### 2.7 Panel de plataforma (R17)

- `src/components/platform/integration-form.ts`: `ParamRowForm` gana `auto: ParamAuto | null`;
  `emptyParamRow()` → `auto: null`; `operationToForm` copia `p.auto ?? null`;
  `operationFormToBody`: fila `in === 'header'` → `{ name, in: 'header', type: 'string',
  required: true, description, auto: 'uuid' }` (sin `enum`); el resto como hoy, sin `auto`.
- `src/components/platform/platform-integration-editor.tsx`: el `select` de ubicación ya itera
  `PARAM_LOCATIONS` → aparece `header` con `t('params.in_header')`. Al elegir `header`,
  `setParam(i, { in: 'header', type: 'string', required: true, auto: 'uuid', enumText: '' })`; al
  salir de `header`, `auto: null`. Con `header`, `type`, `required` y `enum` `disabled` y, bajo la
  fila, `<p className="text-xs text-muted-foreground">{t('params.autoUuid')}</p>`.
- i18n (CP6), `Platform.integrations.params`:

| Clave | en | es |
|---|---|---|
| `in_header` | `Header (generated)` | `Cabecera (generada)` |
| `autoUuid` | `The CRM generates a new UUID for every call. Flows and the AI never see or send it.` | `El CRM genera un UUID nuevo en cada llamada. Ni los flows ni la IA lo ven ni lo mandan.` |

### 2.8 Coordinación con n13.2 y n13.3 (anotar en el informe)

- n13.2 (formulario del nodo y validación de literales) y n13.3 (esquema de herramientas) deben
  listar parámetros con `callerParams(op.params)`. n13.3 ya filtra por ubicación; n13.2 no: si
  n13.2 se fusiona antes, el implementer de n13.5 cambia su lista a `callerParams` en el mismo PR
  (una línea en `integration-call-form.tsx` y en su validador) y lo anota; si n13.5 va antes, se
  avisa en `progress/current.md` para n13.2.
- `remoteError?` y `paramProblem?` son campos hermanos opcionales de la rama `ok:false`.
- n13.3 manda los anidados con punto o como objeto: los dos valen (R15).

## 3. Definición `src/lib/integrations/catalogs/cabbity-health.ts`

### 3.1 Tipos `src/lib/integrations/catalogs/definition.ts` (nuevo, solo tipos)

```ts
import type { OperationParam, OperationOutput, HttpMethod } from '../types.ts';

export interface CatalogIntegration {
  slug: string; name: string; description: string; logo_url: null;
  base_url: string; auth_scheme: 'bearer' | 'header'; auth_header_name: string | null;
  credential_help: string; test_path: string; sort_order: number;
}
export interface CatalogOperation {
  key: string; name: string; description: string; method: HttpMethod; path: string;
  params: OperationParam[]; outputs: OperationOutput[]; response_description: string;
  /** Solo al crear la fila; el script no lo toca después. */
  is_active: boolean; sort_order: number;
}
export interface IntegrationCatalogDefinition {
  integration: CatalogIntegration; operations: CatalogOperation[];
}
```

`catalogs/index.ts`: `export const INTEGRATION_CATALOGS: Record<string, IntegrationCatalogDefinition>
= { 'cabbity-health': CABBITY_HEALTH_CATALOG }` (import de valor relativo con `.ts`, permitido:
es un archivo del mismo directorio sin alias).

### 3.2 Integración

| Campo | Valor |
|---|---|
| `slug` | `cabbity-health` |
| `name` | `Cabbity Health` |
| `description` | `Agenda de un centro de salud en Cabbity Health: profesionales, disponibilidad, pacientes y citas. Nunca devuelve datos clínicos.` |
| `base_url` | `https://api.health.cabbity.com/api/integrations/v1` |
| `auth_scheme` / `auth_header_name` | `bearer` / `null` |
| `test_path` | `/me` |
| `credential_help` | `Pide al administrador de Cabbity Health una clave de integración del centro (empieza por chk_live_) con los permisos availability:read, patients:read, patients:write, appointments:read y appointments:write. Pégala tal cual; si caduca o se revoca, la prueba de conexión dirá que falló la autenticación.` |
| `logo_url` | `null` |
| `sort_order` | `0` |

### 3.3 Operaciones

`ID` = `id` entero de Health. Cabecera `IK` = `{ name: 'Idempotency-Key', in: 'header', type:
'string', required: true, auto: 'uuid', description: 'Clave de idempotencia; la genera el CRM en
cada llamada.' }`. `*` = obligatorio. `sort_order` = orden de la tabla × 10.

| # | key | método y ruta | params | activa | outputs |
|---|---|---|---|---|---|
| 1 | `get_center` | GET `/me` | — | sí | `center_name` `data.center.name` string; `timezone` `data.center.timezone` string; `scopes` `data.integration.scopes` array |
| 2 | `list_locations` | GET `/locations` | — | sí | `locations` `data` array |
| 3 | `list_practitioners` | GET `/practitioners` | `location_id` query integer; `specialty` query string | sí | `practitioners` `data` array |
| 4 | `get_practitioner` | GET `/practitioners/{id}` | `id`* path integer | sí | `practitioner_name` `data.name` string |
| 5 | `list_specialties` | GET `/specialties` | — | sí | `specialties` `data` array |
| 6 | `find_availability` | GET `/availability` | `location_id`* query integer; `from`* query string; `to`* query string; `membership_id` query integer; `specialty` query string; `limit` query integer | sí | `slots` `data` array; `truncated` `meta.truncated` boolean |
| 7 | `lookup_patient` | POST `/patients/lookup` | `document_type` body string enum `cedula,passport`; `document_number` body string; `phone` body string | sí | `source` `data.source` string; `matches` `data.matches` array; `patient_id` `data.matches.0.id` integer |
| 8 | `list_patients` | GET `/patients` | `document_type` query enum; `document_number`, `phone`, `name` query string; `limit` query integer; `cursor` query string | **no** | `patients` `data` array; `next_cursor` `meta.next_cursor` string |
| 9 | `create_patient` | POST `/patients` | IK; `first_name`*, `last_name`* body string; `document_type`* body enum `cedula,passport`; `document_number`* body string; `birth_date` body string; `sex` body enum `male,female,other`; `phone`* body string; `email` body string; `consent.accepted`* body boolean; `consent.accepted_at`* body string; `consent.reference`* body string | sí | `patient_id` `data.id` integer |
| 10 | `get_patient` | GET `/patients/{id}` | `id`* path integer | **no** | `patient` `data` object |
| 11 | `list_appointments` | GET `/appointments` | `patient_id`* query integer (desviación D1); `from`, `to` query string; `location_id`, `membership_id` query integer; `status` query enum `scheduled,confirmed,arrived,in_consultation,completed,cancelled,no_show`; `origin` query enum `integration,staff,mine`; `limit` query integer; `cursor` query string | sí | `appointments` `data` array; `next_cursor` `meta.next_cursor` string |
| 12 | `create_appointment` | POST `/appointments` | IK; `patient_id`*, `membership_id`*, `location_id`* body integer; `starts_at`* body string; `reason`, `external_reference` body string | sí | `appointment_id` `data.id` integer; `starts_at` `data.starts_at` string; `status` `data.status` string |
| 13 | `get_appointment` | GET `/appointments/{id}` | `id`* path integer | sí | `status` `data.status` string; `starts_at` `data.starts_at` string |
| 14 | `reschedule_appointment` | POST `/appointments/{id}/reschedule` | IK; `id`* path integer; `starts_at`* body string; `membership_id`, `location_id` body integer | sí | `starts_at` `data.starts_at` string; `status` `data.status` string |
| 15 | `confirm_appointment` | POST `/appointments/{id}/confirm` | IK; `id`* path integer | sí | `status` `data.status` string |
| 16 | `cancel_appointment` | POST `/appointments/{id}/cancel` | IK; `id`* path integer; `reason` body string | sí | `status` `data.status` string |

`lookup_patient` es POST de lectura: el OpenAPI no declara `Idempotency-Key` y no la lleva.

### 3.4 Textos para la IA

`description` (≤ 1000) y `response_description` (≤ 1000) que el implementer copia tal cual (puede
pulir redacción sin perder las piezas que asierta R4). Descripciones de params (≤ 500): las del
OpenAPI más el formato (`YYYY-MM-DD` en fechas, ISO con offset en `starts_at`).

1. **get_center** — «Datos del centro de salud conectado: nombre, zona horaria y permisos de la
   clave. Úsala al empezar si necesitas la zona horaria para interpretar o escribir horas.» /
   «`data.center` {id, name, timezone}; `data.integration.scopes`; `data.rate_limit.per_minute`.»
2. **list_locations** — «Sedes del centro con profesionales agendables. Úsala para saber qué
   `location_id` pasar a find_availability o create_appointment.» / «`data[]` {id, name, address,
   city, phone, timezone}.»
3. **list_practitioners** — «Profesionales agendables, opcionalmente de una sede o especialidad.
   Úsala para responder qué médicos hay o para obtener el `membership_id` de un profesional.» /
   «`data[]` {membership_id, name, specialty {key,label}, additional_specialties, location_ids}.»
4. **get_practitioner** — «Detalle de un profesional por su `membership_id`.» / «`data`
   {membership_id, name, specialty, location_ids}.»
5. **list_specialties** — «Especialidades con profesionales agendables. Úsala si el cliente
   pregunta qué especialidades hay; pasa `key` como `specialty` en otras operaciones.» / «`data[]`
   {key, label}.»
6. **find_availability** — «Huecos libres para citas en una sede entre dos fechas (YYYY-MM-DD; `to`
   como mucho 13 días después de `from`). Filtra por profesional (`membership_id`) o especialidad.
   Úsala SIEMPRE antes de crear o reprogramar una cita y ofrece al cliente solo huecos de esta
   lista.» / «`data[]` {membership_id, practitioner_name, location_id, starts_at, ends_at} con
   offset horario; `meta.truncated` true si hay más huecos de los devueltos (acorta el rango).»
7. **lookup_patient** — «Busca si el cliente ya es paciente del centro por documento
   (`document_type` + `document_number`) o por teléfono. Úsala SIEMPRE antes de create_patient
   para no duplicar pacientes. Pide el documento al cliente si no lo tienes.» / «`data.source`
   `center` o `not_found`; `data.matches[]` {id, first_name, last_name, document_type,
   document_hint}. Usa `matches[].id` como `patient_id`.»
8. **list_patients** — «Lista pacientes activos filtrando por documento, teléfono o nombre. Solo
   para procesos internos; para identificar a quien escribe usa lookup_patient.» / «`data[]`
   pacientes; `meta.next_cursor`: pásalo como `cursor` para la página siguiente hasta que sea
   null.»
9. **create_patient** — «Registra un paciente nuevo en el centro. Antes: busca con lookup_patient
   (si existe, no lo crees) y pide al cliente su consentimiento expreso para registrar sus datos en
   el centro; sin ese sí, no la uses. `consent.accepted` = true, `consent.accepted_at` = fecha y
   hora ISO con offset en que aceptó, `consent.reference` = de dónde sale (p. ej. «WhatsApp,
   conversación del 2026-11-05»). Nombre, apellido, documento y teléfono son obligatorios.» /
   «`data` {id, first_name, last_name, document_type, document_hint}. `data.id` es el
   `patient_id`. Error 409 `patient_exists`: ya existía, búscalo con lookup_patient.»
10. **get_patient** — «Datos administrativos de un paciente por id (nunca clínicos).» / «`data`
    {id, first_name, last_name, document_type, document_number, birth_date, sex, phone, email,
    address, …}.»
11. **list_appointments** — «Citas de un paciente (`patient_id` de lookup_patient), opcionalmente
    entre dos fechas (como mucho 31 días) o con un estado. Úsala cuando el cliente pregunte por sus
    citas o antes de reprogramar o cancelar para obtener el id de la cita.» / «`data[]` {id,
    status, status_label, starts_at, ends_at, practitioner, location, …}; `meta.next_cursor` →
    `cursor` hasta null.»
12. **create_appointment** — «Crea una cita. `starts_at` debe ser exactamente un `starts_at`
    devuelto por find_availability para ese `membership_id` y `location_id`, en ISO 8601 con el
    offset de la zona del centro (p. ej. 2026-11-12T10:30:00-04:00; ver get_center). Confirma
    con el cliente fecha, hora y profesional antes de crearla. Un paciente puede tener como mucho
    3 citas futuras creadas por integraciones.» / «`data` cita creada {id, status, starts_at,
    ends_at, practitioner, location}. Errores: 409 `slot_unavailable` (el hueco se ocupó: vuelve a
    find_availability), 409 `too_many_upcoming_appointments`, 422 `validation_failed`.»
13. **get_appointment** — «Estado y detalle de una cita por id.» / «`data` {id, status,
    status_label, starts_at, ends_at, practitioner, location}.»
14. **reschedule_appointment** — «Mueve una cita a otro hueco. `starts_at` debe salir de
    find_availability, con offset. Confirma con el cliente antes.» / «`data` la cita con el nuevo
    horario. 409 `appointment_not_changeable` si ya no se puede mover (pasada, atendida o
    cancelada); 409 `slot_unavailable`.»
15. **confirm_appointment** — «Marca una cita como confirmada cuando el cliente confirma que
    asistirá.» / «`data` la cita con `status` `confirmed`.»
16. **cancel_appointment** — «Cancela una cita cuando el cliente lo pide expresamente. `reason`
    opcional (motivo breve).» / «`data` la cita con `status` `cancelled`. 409
    `appointment_not_changeable` si ya no se puede cancelar.»

## 4. Script `scripts/integrations-bootstrap-catalog.ts` (R5–R7)

Mismo patrón que `scripts/paypal-bootstrap-catalog.ts`: cabecera con uso, `main()` solo si es el
punto de entrada (`import.meta.url === pathToFileURL(process.argv[1]).href`), lógica exportada y
testeada con un almacén falso.

```
node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health
```

```ts
export interface CatalogStore {
  findIntegration(slug: string): Promise<(CatalogIntegration & { id: string; is_active: boolean }) | null>;
  insertIntegration(row: CatalogIntegration & { is_active: false }): Promise<{ id: string }>;
  updateIntegration(id: string, patch: Partial<CatalogIntegration>): Promise<void>;
  listOperations(integrationId: string): Promise<(CatalogOperation & { id: string })[]>;
  insertOperation(integrationId: string, row: CatalogOperation): Promise<void>;
  updateOperation(id: string, patch: Partial<Omit<CatalogOperation, 'key' | 'is_active'>>): Promise<void>;
}
export type RowResult = 'created' | 'updated' | 'unchanged';
export interface BootstrapReport {
  integration: RowResult; operations: Record<string, RowResult>; orphans: string[];
}
export function resolveCatalog(slug: string | undefined): IntegrationCatalogDefinition; // lanza con la lista de slugs
export async function bootstrapIntegrationCatalog(opts: {
  store: CatalogStore; definition: IntegrationCatalogDefinition; log?: (m: string) => void;
}): Promise<BootstrapReport>;
```

- Integración: ausente → `insertIntegration({ ...def, is_active: false })` y aviso «activate it in
  /platform when ready»; presente → diff campo a campo de `CatalogIntegration` (sin `slug`, sin
  `is_active`) y `updateIntegration` solo con lo distinto.
- Operaciones por `key`: ausente → insert con el `is_active` de la definición; presente → diff de
  `name, description, method, path, params, outputs, response_description, sort_order` (los
  jsonb comparados con un `stableStringify` de claves ordenadas: Postgres reordena las claves de
  un jsonb) y update solo de lo distinto; en BD y no en la definición → `orphans`, `log('WARNING:
  …')`, sin escribir.
- `main()`: `requireEnv('NEXT_PUBLIC_SUPABASE_URL')`, `requireEnv('SUPABASE_SERVICE_ROLE_KEY')`
  (mensaje con el **nombre** de la variable, nunca su valor), `resolveCatalog(process.argv[2])`,
  cliente `createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })`;
  el almacén usa `.from('integrations')` por `slug` y `.from('integration_operations')` por
  `integration_id`. Catálogo global sin `account_id` (n13.1): CP3 no aplica.
- El script no valida con `catalog-validate.ts` (importa `@/lib/webhooks/ssrf` y `node:net`, no
  ejecutable sin alias): la validez la garantiza R1/R2 en la compuerta, y los CHECK de 091 en BD.

## 5. Tests (todos con fetch simulado salvo el vivo)

| Archivo | Cubre |
|---|---|
| `src/lib/integrations/catalog-validate.test.ts` (ampliar) | R9, R13, R18 |
| `src/lib/integrations/request.test.ts` (ampliar) | R10, R11, R14, R15, R18 |
| `src/lib/integrations/remote-error.test.ts` (nuevo) | R19 (parser) |
| `src/lib/integrations/http.test.ts` (ampliar) | R19 (lectura acotada, 3xx, no JSON, >8 KiB) |
| `src/lib/integrations/execute.test.ts` (ampliar; reutiliza `integrations.test-support.ts`) | R10, R11, R12, R20, R21 |
| `src/lib/integrations/catalogs/cabbity-health.test.ts` (nuevo) | R1–R4, R16 |
| `src/lib/integrations/catalogs/cabbity-health.execute.test.ts` (nuevo) | R22 |
| `src/lib/integrations/catalogs/bootstrap.test.ts` (nuevo; importa `../../../../scripts/integrations-bootstrap-catalog.ts`) | R5–R8, R26 |
| `src/lib/integrations/catalogs/cabbity-health.live.test.ts` (nuevo, `describe.skipIf(!process.env.CABBITY_HEALTH_KEY)`) | R23 |
| `src/components/platform/integration-form.test.ts`, `platform-integration-editor.test.tsx` (ampliar) | R17 |

Cuerpos de Health para los simulados (forma exacta del OpenAPI):
`{"error":{"code":"idempotency_mismatch","message":"…","field":null,"details":null,"request_id":"req_x"}}`.
Valores de ejemplo: `membership_id` 10, `location_id` 3 (los del centro de pruebas, no secretos).
La credencial simulada es `test-credential-…`, nunca algo con forma `chk_live_`.

El test vivo: lee la clave solo de `process.env.CABBITY_HEALTH_KEY`, no la incluye en ningún
`expect` con mensaje ni en `console.log`; imprime solo nombre del centro, número de profesionales y
de huecos. La clave inválida es la cadena fija `invalid-key-for-test`.

## 6. Documentación

- `docs/integrations/cabbity-health.md` (nuevo, R26): qué es; cargar el catálogo (comando de §4;
  local primero, remoto con la service role del proyecto remoto — se pregunta antes, como toda
  operación remota); operador: activar la integración en `/platform`, encender `list_patients`/
  `get_patient` solo si un cliente lo justifica, plan con `integrations`; cliente: Ajustes →
  Integraciones, pegar la clave, «Probar conexión»; tabla de las 16 operaciones; límites (120/min
  por clave, 60/min por cuenta en el CRM, 3 citas futuras por paciente, 13 días de disponibilidad,
  31 de citas, sin datos clínicos ni motivos); códigos de error útiles (`slot_unavailable`,
  `too_many_upcoming_appointments`, `patient_exists`, `consent_required`, `idempotency_mismatch`,
  `api_key_expired`, `api_key_revoked`, `rate_limited`) y qué hacer; deuda (requirements «Fuera de
  alcance»).
- `CHANGELOG.md` (Unreleased, en inglés como el resto): «Cabbity Health connector» — catálogo,
  script, `header`/`auto`, cuerpos anidados, `remoteError`. Sin migración.
- Sin variables de entorno nuevas de la app (`CABBITY_HEALTH_KEY` solo la usa el test vivo
  opcional; se menciona en el doc, no en `docs/docker.md`).

## 7. Seguridad

- **Cabecera no sobrescribible:** `validateCallParams` rechaza el nombre (R10) y
  `buildIntegrationRequest` ignora `values[name]` (R11): doble barrera.
- **Credencial:** `withAuthHeader` borra duplicados case-insensitive antes de añadirla (R12);
  ninguna cabecera `auto` puede llamarse `authorization` ni una reservada (R9).
- **Allowlist (R21 de n13.1):** las cabeceras no tocan la URL; ruta y query se construyen igual.
- **Prototipo:** el armado anidado usa propiedades propias; los segmentos empiezan por minúscula
  (no hay `__proto__`).
- **Error remoto:** acotado a 8 KiB de lectura y 300 caracteres de mensaje, sin `details`; no se
  persiste ni se registra. Es texto de un tercero: n13.3 debe tratarlo como dato, no instrucción.
- **Minimización:** D1 (dos operaciones apagadas, `patient_id` obligatorio en citas).
- **Clave:** ni en repo, ni en tests, ni en informes (R8 lo comprueba en los archivos nuevos).

## 8. Guion manual §M1 (R7, R16, R23, R24)

Local (`npm run dev` + Supabase local con migraciones aplicadas). La clave la teclea Brian; no se
copia a ningún archivo. Resultado (sin la clave) en `progress/impl_cabbity-health-connector.md`.

1. `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health` → integración
   `created` (inactiva) y 16 operaciones `created`. Repetir → todo `unchanged`. Sin argumento → sale
   1 listando `cabbity-health`.
2. `/platform` → Integraciones → Cabbity Health: 16 operaciones, `list_patients` y `get_patient`
   inactivas. Abrir `create_appointment`, guardar sin cambios y comprobar en SQL que
   `select params from integration_operations where key = 'create_appointment'` conserva
   `"auto": "uuid"` en `Idempotency-Key`. Activar la integración.
3. La cuenta de prueba tiene un plan con `integrations` (`select features->'integrations' from plans
   …`).
4. Como cliente: Ajustes → Integraciones → Cabbity Health → pegar la clave → «Probar conexión» →
   `ok`. `select outcome, status_code from integration_calls order by created_at desc limit 1` →
   `ok`, `200`; la fila no tiene más columnas que las de 091.
5. `read -rs CABBITY_HEALTH_KEY && export CABBITY_HEALTH_KEY` y
   `npx vitest run src/lib/integrations/catalogs/cabbity-health.live.test.ts` → verde (R23).
6. `curl` de contraste (mismo shell):
   - `curl -sS -H "Authorization: Bearer $CABBITY_HEALTH_KEY" https://api.health.cabbity.com/api/integrations/v1/me | jq '.data.center, .data.integration.scopes'`
     → Rehactive, id 2, `America/Santo_Domingo`, 5 scopes.
   - `…/practitioners | jq '.data[] | {membership_id, location_ids}'` → `10`, `[3]`.
   - `…/availability?location_id=3&from=$(date +%F)&to=$(date -d '+6 day' +%F) | jq '.data | length'` → número ≥ 0, HTTP 200.
   - `…/appointments?from=$(date +%F)&to=$(date -d '+6 day' +%F)&status=confirmed -o /dev/null -w '%{http_code}'`
     → `200` (D4: el escalar vale como array de uno; si da 422, quitar `status` de la definición y anotarlo).
7. `unset CABBITY_HEALTH_KEY`. En Ajustes, desactivar y volver a activar no deja la clave en claro
   en `account_integrations` (n13.1, sin cambios).

Las escrituras (`create_patient`, `create_appointment`, `reschedule`, `confirm`, `cancel`) **no** se
prueban contra el servicio real salvo que Rehactive dé un paciente de prueba: crearían datos reales
del centro. Las cubren R11, R14 y R22 con fetch simulado.

## 9. Alternativas descartadas (resumen)

- Conector en código propio para Health: lo descartó n13.1 (D1) y Health cabe en el modelo
  declarativo con tres ampliaciones aditivas.
- Importador genérico de OpenAPI: más trabajo que el catálogo a mano y no decide lo que importa
  (qué excluir, qué apagar, qué texto ve la IA). El test de contrato R3 da la garantía de
  fidelidad.
- Clave de idempotencia derivada de los params (hash) para deduplicar reintentos: con la misma
  clave y otro cuerpo Health responde 409 y un reintento legítimo con un dato corregido fallaría;
  A2 pide UUID por llamada.
