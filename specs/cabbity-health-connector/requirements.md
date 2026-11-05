# n13.5 `cabbity-health-connector` — requisitos

Fase 13, depende de n13.1 (`integrations-catalog`, en `main`). Rama `feat/cabbity-health-connector`,
worktree `.claude/worktrees/cabbity-health-connector`, base `main @ fd4ce95`.

## Contexto

- Encargo del humano (2026-11-05): conector de **Cabbity Health**, API de terceros documentada en
  `docs/integrations/cabbity-health-openapi.json` (OpenAPI 3, servidor
  `https://api.health.cabbity.com/api/integrations/v1`, `Authorization: Bearer chk_live_…`).
  Comprobado en vivo el 2026-11-05: `GET /me` → centro Rehactive (id 2, `America/Santo_Domingo`),
  cinco scopes; `GET /practitioners` → una profesional (`membership_id` 10, fisiatría,
  `location_ids` [3]).
- n13.1 dejó el modelo declarativo (`integrations`, `integration_operations.params` como
  `OperationParam[]` en jsonb), el ejecutor común (`src/lib/integrations/execute.ts`) y el núcleo de
  red (`src/lib/integrations/http.ts`), y anotó como deuda en su «Fuera de alcance»: importar desde
  OpenAPI, cuerpos anidados, paginación y campos no secretos por cuenta.
- Health exige tres cosas que el modelo de n13.1 no expresa: la cabecera `Idempotency-Key`
  (obligatoria en `POST /appointments`), el cuerpo anidado `consent{…}` de `POST /patients` y una
  query `status` de tipo array en `GET /appointments`. Además n13.1 **descarta** el cuerpo de toda
  respuesta no-2xx (`http.ts`, `cancelBody`), así que el `error.code` de Health se pierde.
- Features hermanas en paralelo: n13.2 (`integration-flow-call`, `spec_ready`, añade
  `paramProblem?` a `IntegrationCallResult` y migración 092) y n13.3 (`integration-ai-tools`,
  genera el esquema de cada herramienta desde `params`, solo `path|query|body`, nombres con punto →
  propiedades anidadas). Esta spec amplía el modelo de forma aditiva para encajar con las dos.
- La clave real la tiene Brian. **Nunca** va al repo, a un test, a un log ni a un informe: el cliente
  la pega en Ajustes → Integraciones (n13.1) y los guiones la leen de `$CABBITY_HEALTH_KEY`.

## Criterios de aceptación de partida (feature_list.json)

- **A1** Definición versionada de la integración `cabbity-health` y de sus operaciones a partir del
  OpenAPI, con `description`/`response_description` pensadas para una IA; carga idempotente con un
  script de rol de servicio al estilo `scripts/paypal-bootstrap-catalog.ts`.
- **A2** `Idempotency-Key` generada por el ejecutor (UUID por llamada), nunca pedida al modelo ni al
  flow; cuerpo anidado `consent{accepted,accepted_at,reference}`; `status[]` (o por qué se omite).
- **A3** Errores `{error:{code,message,…}}` conservados en el resultado del ejecutor (code y
  message); la prueba de conexión reporta `auth_failed` en 401.
- **A4** Guion manual contra el servicio real (`/me`, `/practitioners`, `/availability`) y tests
  vitest con fetch simulado (ruta, query, cuerpo anidado, cabecera de idempotencia).
- **A5** Migración solo si hace falta; `docs/integrations/cabbity-health.md`; compuerta en verde.

## Decisiones para el humano (resumen; detalle en design.md §1)

| # | Decisión | Elegido | Alternativa descartada |
|---|---|---|---|
| D1 | Subconjunto de operaciones | 16 de 19: todas menos `PATCH /patients/{id}`, `DELETE /patients/{id}` y `DELETE /appointments/{id}` (alias de `cancel`). `list_patients` y `get_patient` se cargan **apagadas** (`is_active=false`) por minimización de datos; `list_appointments` exige `patient_id` | Cargar las 19; o las 16 todas encendidas (una IA expuesta a cualquier contacto de WhatsApp podría listar pacientes por nombre o la agenda entera del centro) |
| D2 | Cabecera autogenerada | `OperationParam` con `in: 'header'` + `auto: 'uuid'`; el validador de llamada la trata como desconocida si alguien la manda | Columna `idempotency` en `integration_operations` (migración para un booleano; no escala a otras cabeceras) |
| D3 | Cuerpo anidado | Nombres con punto en `in: 'body'` (`consent.accepted`), hasta 3 niveles; el constructor arma el objeto | Tipo `object` con subesquema (rompe el editor del panel y el validador de tipos escalares) |
| D4 | `status[]` | Parámetro escalar `status` con `enum` de los 7 estados: un solo valor, serializado `status=x` (estilo `form, explode` por defecto de OpenAPI = array de un elemento). Multi-valor queda como deuda | Tipo array en `params` (toca n13.2 y n13.3 para un filtro que la IA puede hacer sobre el resultado) |
| D5 | Error remoto | Campo opcional `remoteError {code,message,field,requestId}` en `ok:false` (aditivo, compatible con `paramProblem` de n13.2); se lee como mucho 8 KiB del cuerpo de error JSON; **no** se guarda en `integration_calls` | Nuevo `outcome` por cada código (rompe el CHECK de `integration_calls.outcome` y los `it.each` de n13.2) |
| D6 | Dónde vive la definición | `src/lib/integrations/catalogs/cabbity-health.ts` (TS tipado, solo `import type`), registrado en `catalogs/index.ts`; script genérico `scripts/integrations-bootstrap-catalog.ts <slug>` | JSON suelto en `scripts/` (sin tipos ni contrato testeable) |
| D7 | Migración | **Ninguna**: `params` ya es jsonb sin CHECK de forma; `header`/`auto` y nombres con punto caben | Columna nueva (no hace falta; 092 reservada por n13.2, 093 existe) |

## Requisitos (EARS)

### Definición y carga (A1)

- **R1** (A1) El sistema debe exportar desde `src/lib/integrations/catalogs/cabbity-health.ts` una
  constante `CABBITY_HEALTH_CATALOG` cuya parte `integration` tenga `slug: 'cabbity-health'`,
  `base_url: 'https://api.health.cabbity.com/api/integrations/v1'`, `auth_scheme: 'bearer'`,
  `test_path: '/me'` y un `credential_help` no vacío, y que pase `validateIntegrationInput(…,
  'create')` sin cambios de valor.
  *Verificación:* `src/lib/integrations/catalogs/cabbity-health.test.ts`.

- **R2** (A1) El sistema debe declarar exactamente las 16 operaciones de design.md §3 (claves,
  método y ruta), cada una válida con `validateOperationInput(…, 'create')`, y **ninguna** de
  `PATCH /patients/{id}`, `DELETE /patients/{id}` ni `DELETE /appointments/{id}`.
  *Verificación:* `cabbity-health.test.ts` (lista exacta de claves; validación una a una; ausencia
  de los tres excluidos por método+ruta).

- **R3** (A1) El sistema debe mantener la definición fiel al OpenAPI: cada `método + ruta` existe en
  `docs/integrations/cabbity-health-openapi.json`; cada parámetro `path|query` existe en los
  `parameters` de esa operación y cada parámetro `body` (con puntos → propiedades anidadas) existe
  en el esquema del `requestBody`; cada `required` coincide con el OpenAPI salvo las desviaciones
  listadas en design.md §3 (`list_appointments.patient_id` obligatorio); cada `enum` declarado es
  subconjunto del `enum` del OpenAPI; y toda operación cuyo OpenAPI declare `Idempotency-Key`
  lleva el parámetro `Idempotency-Key` `in: 'header'`, `auto: 'uuid'`.
  *Verificación:* `cabbity-health.test.ts` (test de contrato que lee el JSON del OpenAPI).

- **R4** (A1) El sistema debe dar a cada operación una `description` (≤ 1000) y una
  `response_description` no nula (≤ 1000) que digan cuándo usarla y qué devuelve; en particular:
  `create_patient` exige pedir consentimiento expreso y buscar antes con `lookup_patient`;
  `create_appointment` exige un `starts_at` devuelto por `find_availability` con el offset de la
  zona del centro; `find_availability` limita el rango a 13 días; las listas paginadas explican
  `meta.next_cursor` → `cursor`.
  *Verificación:* `cabbity-health.test.ts` (no vacías; aserciones de contenido mínimo por
  operación: `consentimiento` y `lookup_patient` en `create_patient`; `find_availability` y
  `offset` en `create_appointment`; `13` en `find_availability`; `next_cursor` en las paginadas).

- **R5** (A1) Cuando se ejecute `bootstrapIntegrationCatalog` contra un almacén sin la integración,
  el sistema debe crearla con `is_active = false` y crear sus 16 operaciones con el `is_active` de
  la definición (`false` para `list_patients` y `get_patient`, `true` para el resto).
  *Verificación:* `src/lib/integrations/catalogs/bootstrap.test.ts` (almacén en memoria).

- **R6** (A1) Cuando se ejecute `bootstrapIntegrationCatalog` contra un almacén que ya tiene la
  integración, el sistema debe actualizar solo los campos que difieren de la definición (nunca
  `slug` ni `is_active` de la integración ni de las operaciones existentes), crear las operaciones
  que falten, no tocar las que sobren (registrando su clave en un aviso) y, en una segunda
  ejecución idéntica, no escribir nada e informar cada fila como `unchanged`.
  *Verificación:* `bootstrap.test.ts` (dos ejecuciones seguidas → cero escrituras en la segunda;
  `is_active` cambiado por el operador se conserva; operación huérfana → aviso, sin escritura).

- **R7** (A1) Cuando se invoque `scripts/integrations-bootstrap-catalog.ts` sin
  `NEXT_PUBLIC_SUPABASE_URL` o `SUPABASE_SERVICE_ROLE_KEY`, o con un slug que no está en el
  registro `src/lib/integrations/catalogs/index.ts`, el sistema debe salir con código 1 y un
  mensaje que no incluya el valor de ninguna variable de entorno.
  *Verificación:* `bootstrap.test.ts` (`resolveCatalog('nope')` → error con la lista de slugs
  válidos); guion manual §M1 paso 1 para las variables.

- **R8** (A1) El sistema debe mantener los archivos de `src/lib/integrations/catalogs/` ejecutables
  por Node 24 sin alias (sin `@/`; imports relativos con extensión `.ts`; hacia fuera de
  `catalogs/` solo `import type`) y sin ningún literal que
  parezca una clave de Health (`/chk_(live|test)_[A-Za-z0-9]{8,}/`), igual que
  `docs/integrations/cabbity-health.md`.
  *Verificación:* `bootstrap.test.ts` (lee los archivos no-test de `catalogs/` como texto: sin
  `@/`, todo `import` que no sea `import type` apunta a `./*.ts`, sin la expresión de clave).

### Modelo: cabecera autogenerada, cuerpo anidado, status (A2)

- **R9** (A2) Cuando el operador guarde un parámetro con `in: 'header'`, el sistema debe exigir
  `auto: 'uuid'`, `type: 'string'`, `required: true`, sin `enum`, y un nombre que cumpla
  `HEADER_NAME_RE`, no esté en `FORBIDDEN_AUTH_HEADERS` ni sea `authorization`, y no repita (sin
  distinguir mayúsculas) otra cabecera de la operación; y debe rechazar `auto` en cualquier otra
  ubicación.
  *Verificación:* `src/lib/integrations/catalog-validate.test.ts`.

- **R10** (A2) Cuando quien llama (flow, IA, automatización) mande un valor para un parámetro con
  `auto`, el sistema debe rechazar la llamada con `invalid_params` (`problem: 'unknown'`) sin
  hacer la petición; y `callerParams(params)` debe devolver los parámetros sin los `auto`, para
  que n13.2 y n13.3 no los enseñen.
  *Verificación:* `src/lib/integrations/request.test.ts` (`validateCallParams` con
  `Idempotency-Key` → `unknown`; `callerParams`); `execute.test.ts` (fetch no llamado,
  `integration_calls.outcome = 'invalid_params'`).

- **R11** (A2) Cuando se construya una petición de una operación con un parámetro `auto: 'uuid'`,
  el sistema debe poner esa cabecera con un UUID v4 nuevo por llamada (inyectable en tests), aunque
  `values` traiga otro valor con ese nombre; dos llamadas seguidas llevan claves distintas.
  *Verificación:* `request.test.ts` (generador inyectado; valor de `values` ignorado);
  `execute.test.ts` (dos ejecuciones → dos `Idempotency-Key` distintos que cumplen el formato
  UUID v4 en el `fetch` simulado).

- **R12** (A2) Cuando el ejecutor añada la credencial, el sistema debe eliminar antes cualquier
  cabecera de la petición con el mismo nombre sin distinguir mayúsculas, de modo que ningún
  parámetro autogenerado comparta nombre con la cabecera de autenticación.
  *Verificación:* `execute.test.ts` (integración `auth_scheme: 'header'`, `X-Api-Key` y una
  operación con cabecera `x-api-key` construida a mano → el `fetch` recibe una sola cabecera, la
  credencial).

- **R13** (A2) Cuando el operador guarde un parámetro con punto en el nombre, el sistema debe
  aceptarlo solo si `in: 'body'`, cada segmento cumple `^[a-z][a-zA-Z0-9_]{0,63}$`, hay como
  mucho 3 segmentos y ningún nombre es a la vez hoja y prefijo de otro (`consent` y
  `consent.accepted`).
  *Verificación:* `catalog-validate.test.ts`.

- **R14** (A2) Cuando se construya el cuerpo de una operación con parámetros de nombre con punto,
  el sistema debe enviarlos como objetos JSON anidados (`{"consent":{"accepted":true,…}}`), sin
  crear el objeto padre si no viaja ninguna de sus hojas, y sin escribir en el prototipo.
  *Verificación:* `request.test.ts` (cuerpo de `create_patient`; padre ausente cuando todas las
  hojas opcionales faltan; `constructor.x` como nombre → propiedad propia).

- **R15** (A2) Cuando quien llama mande los parámetros anidados como objeto
  (`{consent:{accepted:true}}`) en lugar de con punto, el sistema debe aplanarlos antes de
  validar y producir el mismo resultado; si llega la misma hoja por las dos vías, debe devolver
  `problem: 'unknown'` con el nombre con punto.
  *Verificación:* `request.test.ts`.

- **R16** (A2) El sistema debe declarar en `list_appointments` el filtro `status` como parámetro
  `query` escalar con `enum` de los 7 estados del OpenAPI, serializado `status=<valor>`.
  *Verificación:* `cabbity-health.test.ts` (URL de `list_appointments` con `status=confirmed`);
  guion §M1 paso 6 (200 del servicio real con ese filtro; si respondiera 422, se quita el
  parámetro y se anota en el informe).

- **R17** (A2) Cuando el operador abra en el panel una operación con un parámetro `in: 'header'`
  y la guarde sin tocarlo, el sistema debe conservar `auto: 'uuid'`; al elegir `header` en el
  selector de ubicación, la fila pasa a tipo `string`, obligatoria y con `auto: 'uuid'`, con tipo,
  obligatoriedad y `enum` deshabilitados, y un texto de ayuda en `messages/es.json` y
  `messages/en.json`.
  *Verificación:* `src/components/platform/integration-form.test.ts` (ida y vuelta
  `operationToForm` → `operationFormToBody`); `platform-integration-editor.test.tsx` (seleccionar
  `header` deshabilita los controles; texto de ayuda presente).

- **R18** (A2) El sistema debe seguir aceptando sin cambios las operaciones guardadas por n13.1
  (parámetros sin `auto`, nombres sin punto) y construir para ellas la misma petición que antes.
  *Verificación:* los tests existentes de `catalog-validate.test.ts`, `request.test.ts` y
  `execute.test.ts` pasan sin modificar sus expectativas.

### Errores remotos (A3)

- **R19** (A3) Cuando la respuesta no sea 2xx ni 3xx, tenga `content-type` JSON y no declare más de
  8 KiB, el sistema debe leer como mucho 8 KiB del cuerpo y, si tiene la forma
  `{error:{code:string,…}}`, devolver `remoteError` con `code` (1–64 de `[A-Za-z0-9_.-]`),
  `message` (texto sin caracteres de control, cortado a 300), `field` (≤ 100 o `null`) y
  `requestId` (≤ 100 o `null`), descartando `details`. En cualquier otro caso (no JSON, mayor de
  8 KiB, JSON inválido, otra forma, 3xx) el resultado sigue siendo `http_error` sin `remoteError`.
  *Verificación:* `src/lib/integrations/http.test.ts`.

- **R20** (A3) Cuando una operación falle con error remoto, el sistema debe devolver
  `{ ok: false, outcome: 'http_error', status, remoteError, latencyMs }` sin lanzar, registrar en
  `integration_calls` solo las columnas de n13.1 (sin código ni mensaje remoto) y no escribir el
  mensaje en consola; con los cuerpos reales de Health para `409 idempotency_mismatch`,
  `422 validation_failed`, `401 api_key_expired`, `401 api_key_revoked` y `429 rate_limited`.
  *Verificación:* `execute.test.ts` (`it.each` sobre los cinco; fila insertada con las mismas
  claves que en n13.1; espía de `console.error` sin el mensaje).

- **R21** (A3) Cuando la prueba de conexión de una cuenta reciba 401 de `GET /me` con cuerpo de
  error de Health, el sistema debe guardar y devolver `auth_failed` (comportamiento de n13.1,
  `testStatusFor`), sin cambiar `IntegrationTestResult`.
  *Verificación:* `execute.test.ts` (`testIntegrationConnection` con 401 `api_key_revoked`).

### Prueba real y simulada (A4)

- **R22** (A4) El sistema debe tener un test con fetch simulado que ejecute por
  `executeIntegrationOperation` las operaciones `find_availability`, `get_practitioner`,
  `create_patient`, `create_appointment`, `list_appointments` y `cancel_appointment` desde las
  filas de `CABBITY_HEALTH_CATALOG` y compruebe en la llamada a `fetch` la URL completa (ruta y
  query), el método, `Authorization: Bearer <credencial de la cuenta>`, `Idempotency-Key` donde
  toque (y su ausencia en las de lectura y en `lookup_patient`) y el cuerpo JSON (anidado en
  `create_patient`; ausente en `confirm_appointment` y en `cancel_appointment` sin motivo).
  *Verificación:* `src/lib/integrations/catalogs/cabbity-health.execute.test.ts`.

- **R23** (A4) Cuando `CABBITY_HEALTH_KEY` esté en el entorno, el sistema debe tener un test
  opcional (`describe.skipIf` sin la variable; se salta en CI y en la compuerta) que construya
  las peticiones desde el catálogo con `buildIntegrationRequest` y las envíe con
  `performIntegrationRequest` al servicio real: `get_center` (centro y 5 scopes),
  `list_practitioners` (≥ 1 con `membership_id` y `location_ids`), `find_availability` (rango de 7
  días en la primera sede → 200, array), `lookup_patient` con un documento inexistente
  (`source: 'not_found'`), `find_availability` con 20 días (→ `remoteError.code =
  'validation_failed'`) y `get_center` con una clave inválida (→ 401 con `remoteError`); sin
  imprimir la clave.
  *Verificación:* `src/lib/integrations/catalogs/cabbity-health.live.test.ts` (guion §M1 paso 5).

- **R24** (A4) El sistema debe documentar y superar el guion manual §M1 de design.md: carga del
  catálogo, activación en `/platform`, clave pegada en Ajustes → Integraciones, prueba de conexión
  `ok`, y `curl` con `$CABBITY_HEALTH_KEY` a `/me`, `/practitioners` y `/availability` que coincide
  con lo que devuelve el test vivo.
  *Verificación:* guion manual §M1 (resultado anotado en `progress/impl_cabbity-health-connector.md`,
  sin la clave).

### Migración, documentación y cierre (A5)

- **R25** (A5) El sistema no debe añadir migraciones ni tocar `supabase/` en esta feature.
  *Verificación:* el reviewer comprueba `git diff main --stat -- supabase/` vacío; R18 prueba que
  las filas existentes siguen valiendo.

- **R26** (A5) El sistema debe incluir `docs/integrations/cabbity-health.md` con: cómo cargar el
  catálogo (comando exacto), cómo se activa (operador: integración activa y plan con
  `integrations`; cliente: clave en Ajustes → Integraciones y prueba de conexión), la tabla de
  operaciones con cuáles nacen apagadas y por qué, límites (120 req/min por clave frente a 60/min
  por cuenta del CRM, 3 citas futuras por paciente, rango de 13 días en disponibilidad y 31 en
  citas, sin datos clínicos), los códigos de error que conviene tratar y la deuda.
  *Verificación:* `bootstrap.test.ts` (el doc existe y contiene el comando, `120`, `3 citas`,
  `13`, `idempotency_mismatch` y `api_key_expired`); revisión del reviewer.

- **R27** (A5) La compuerta (`npm run lint && npm run typecheck && TZ=UTC npm test && npm run
  build`) debe pasar y `CHANGELOG.md` (Unreleased) debe describir el conector y las ampliaciones
  del modelo.
  *Verificación:* gate dirigido `./init.sh feature n13.5 …`; CP1 y CP9 del reviewer.

## Trazabilidad A → R

| A | R |
|---|---|
| A1 | R1–R8 |
| A2 | R9–R18 |
| A3 | R19–R21 |
| A4 | R22–R24 |
| A5 | R25–R27 |

## Fuera de alcance (deuda anotada)

- Filtro `status` multi-valor (array en `params`); paginación automática (el `cursor` se expone
  como parámetro y la IA/flow lo encadena).
- Reutilizar la misma `Idempotency-Key` en reintentos: el ejecutor no reintenta y cada llamada
  (también un reintento del flow o de la IA) lleva clave nueva.
- Guardar `remoteError.code` en `integration_calls` (exigiría columna y migración).
- `PATCH`/`DELETE /patients/{id}` y el alias `DELETE /appointments/{id}`.
- Campos no secretos por cuenta (p. ej. sede por defecto) y `base_url` por cuenta.
- Importador genérico de OpenAPI: el test de contrato R3 es el sustituto mínimo.
