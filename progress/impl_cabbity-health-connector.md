# impl n13.5 cabbity-health-connector

## Plan (de specs/cabbity-health-connector/tasks.md)

1. T1 tipos (`header`, `auto`, `RemoteError`, `INTEGRATION_MAX_ERROR_BYTES`).
2. T2 `catalog-validate.ts`: cabeceras auto uuid, nombres con punto en body, hoja/prefijo.
3. T3 `request.ts`: `callerParams`, aplanado, cuerpo anidado, cabeceras auto, `withAuthHeader`.
4. T4 `remote-error.ts` + rama no-2xx de `http.ts`.
5. T5 `execute.ts`: `remoteError?`, `deps.uuid`, `withAuthHeader`.
6. T6 panel (`integration-form.ts`, editor, i18n).
7. T7 catálogo `catalogs/{definition,cabbity-health,index}.ts`.
8. T8 test con fetch simulado de las operaciones del catálogo.
9. T9 `scripts/integrations-bootstrap-catalog.ts` + `bootstrap.test.ts`.
10. T10 test vivo opcional.
11. T11 `docs/integrations/cabbity-health.md`.
12. T12 guion §M1 (pendiente de Brian).
13. T13 coordinación n13.2/n13.3.
14. T14 compuerta + CHANGELOG + informe.

## Estado

**done** (pendiente de reviewer). §M1 de solo lectura ejecutado por el coordinador el 2026-11-05; dos correcciones aplicadas en `69d67dd` (ver «Resultado de §M1»).

## Rama y commits

Rama `feat/cabbity-health-connector`, worktree `.claude/worktrees/cabbity-health-connector`, base `34c3fd2`.

| Commit | Contenido |
|---|---|
| `254316a` feat: cabeceras autogeneradas, cuerpos anidados y error remoto | types, catalog-validate, request, remote-error (nuevo), http, execute + tests |
| `ea868d7` feat: el editor de operaciones ofrece cabeceras generadas | integration-form, platform-integration-editor, i18n es/en + tests |
| `5b33da6` feat: catálogo versionado de Cabbity Health y script de carga | `catalogs/{definition,cabbity-health,index}.ts`, script, doc, CHANGELOG + tests |
| `80942a2` docs: tareas de n13.5 hechas | tasks.md (T12 sin marcar) |
| `69d67dd` fix: list_appointments sin filtro status y aviso de documento mal formado | correcciones tras §M1 |

`git diff main --stat -- supabase/` vacío (R25, D7).

## Compuerta (en el worktree)

- `npm run lint`: 0 errores (35 avisos, todos previos y fuera de los archivos tocados; eslint sobre lo tocado: limpio).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 349 archivos pasan, 1 saltado (el vivo); 5421 tests pasan, 7 saltados (tras `69d67dd`).
- `npm run build` con las variables dummy: exit 0.
- `prettier --check` sobre lo tocado: limpio.
- Sin SQL: no aplica `replay-migrations.sh`.

## Criterio ↔ test

| R | Archivo | `it` |
|---|---|---|
| R1 | `src/lib/integrations/catalogs/cabbity-health.test.ts` | `has the Health slug, origin, scheme and test path`; `passes validateIntegrationInput unchanged`; `is registered under its slug` |
| R2 | idem | `declares exactly the 16 operations of design §3`; `%s passes validateOperationInput unchanged` (×16); `leaves out %s %s` (×3) |
| R3 | idem | `CABBITY_HEALTH_CATALOG matches the OpenAPI (R3) > %s` (×16: params path/query/body con punto, required salvo `list_appointments.patient_id`, tipos, enum ⊆ OpenAPI, `Idempotency-Key` ⇔ declarada); `every OpenAPI path is either in the catalog or left out on purpose` |
| R4 | idem | `%s has a description and a response description ≤ 1000`; `create_patient asks for consent and lookup_patient first`; `create_appointment wants a find_availability starts_at with offset`; `find_availability caps the range at 13 days`; `%s explains next_cursor → cursor` |
| R5 | `src/lib/integrations/catalogs/bootstrap.test.ts` | `creates the integration inactive and the 16 operations with their is_active` |
| R6 | idem | `a second identical run writes nothing and reports unchanged`; `keeps the is_active the operator chose`; `patches only the field that changed`; `creates a missing operation and warns about an orphan without writing it`; `stableStringify > ignores key order` |
| R7 | idem | `resolveCatalog (R7) > %s → an error listing the valid slugs`; variables: comprobado a mano (abajo) |
| R8 | idem | `catalog files are runnable by Node and carry no key (R8) > %s`; `the bootstrap script imports no alias and no key`; `docs/… > carries no key` |
| R9 | `src/lib/integrations/catalog-validate.test.ts` | `header params (n13.5, R9)` (válida, sin auto, auto desconocido, integer, opcional, enum, Authorization, content-type, Cookie, nombre malo, repetida sin mayúsculas, auto en query/body/path, cabecera en GET) |
| R10 | `src/lib/integrations/request.test.ts` | `callerParams … hides the auto headers`; `Idempotency-Key from the caller is unknown`; `the auto header is never missing` |
| R10 | `src/lib/integrations/execute.test.ts` | `Idempotency-Key from the caller → invalid_params, no request` |
| R11 | `request.test.ts` | `uses the injected generator and ignores values[name]`; `two calls without a generator carry two different UUID v4` |
| R11 | `execute.test.ts` | `two executions carry two different UUID v4 keys`; `the injected generator is used` |
| R12 | `request.test.ts` / `execute.test.ts` | `withAuthHeader … drops any header with the same name in another case`; `a header named like the credential never travels twice` |
| R13 | `catalog-validate.test.ts` | `dotted body names (n13.5, R13)` (body ok, query/path ko, 4 partes, segmentos inválidos, hoja+prefijo, hermanos) |
| R14 | `request.test.ts` | `builds {"consent":{…}} from dotted names`; `omits the parent when none of its leaves travel`; `constructor.x is an own property, nothing written to the prototype` |
| R15 | `request.test.ts` | `an object input is the same as the dotted one`; `the same leaf by both ways is unknown, with the dotted name`; `an unknown nested leaf is unknown` |
| R16 | `cabbity-health.test.ts` | Contingencia aplicada: `list_appointments has no status filter (R16, §M1) > does not declare status; the URL carries only what was sent` y `tells the AI to filter by status on the result`. En `cabbity-health.live.test.ts`: `list_appointments with a scalar status is refused by Health` (422, `field` = `status`) |
| §M1 doc | `cabbity-health.test.ts` | `a malformed document is a 422 the AI should ask again for (§M1) > lookup_patient / create_patient` |
| R17 | `src/components/platform/integration-form.test.ts` | `round-trips auto: uuid unchanged`; `a header row is always a required string with auto uuid and no enum` |
| R17 | `src/components/platform/platform-integration-editor.test.tsx` | `a header param shows the auto-UUID help and locks type, required and enum (n13.5, R17)`; `a plain param has no auto-UUID help` |
| R18 | tests previos de `catalog-validate`, `request`, `execute`, `http` | sin tocar sus expectativas; todos verdes |
| R19 | `src/lib/integrations/remote-error.test.ts` | forma completa, `details` fuera, códigos inválidos, JSON roto/otras formas, control + corte a 300, field/requestId > 100 |
| R19 | `src/lib/integrations/http.test.ts` | `remote errors (n13.5)`: 422 JSON → remoteError; 500 text/html → sin; content-length 9000 → cancelado sin leer; stream > 8 KiB → sin; 302 JSON → sin; 2xx sin cambios |
| R20 | `execute.test.ts` | `HTTP %i %s → remoteError, the n13.1 row` (409 idempotency_mismatch, 422 validation_failed, 401 api_key_expired, 401 api_key_revoked, 429 rate_limited; fila con las mismas claves; código/mensaje fuera de la fila y de consola) |
| R21 | `execute.test.ts` | `api_key_revoked → auth_failed, same result shape` |
| R22 | `src/lib/integrations/catalogs/cabbity-health.execute.test.ts` | find_availability, get_practitioner, lookup_patient, create_patient (consent anidado), create_appointment, list_appointments, confirm_appointment, cancel_appointment con y sin motivo; list_appointments sin patient_id → invalid_params |
| R23 | `src/lib/integrations/catalogs/cabbity-health.live.test.ts` | `describe.skipIf(!CABBITY_HEALTH_KEY)`: 6 its; en la compuerta sale `skipped` |
| R24 | manual §M1 | hecho (solo lecturas), ver «Resultado de §M1» |
| R25 | `git diff main --stat -- supabase/` | vacío |
| R26 | `bootstrap.test.ts` | `has the load command, the limits and the error codes` |
| R27 | compuerta + CHANGELOG | arriba |

## Verificaciones contra base real

Ninguna: sin migración ni SQL nuevo (D7). No hay `progress/checks_cabbity-health-connector.sql`.

Comprobado a mano el script bajo Node 24 (sin red ni base):
- sin variables → `Missing env NEXT_PUBLIC_SUPABASE_URL. Usage: …`, exit 1;
- con variables y slug `nope` o sin slug → `Unknown or missing catalogue slug. Valid slugs: cabbity-health. …`, exit 1; el valor de `SUPABASE_SERVICE_ROLE_KEY` no aparece en la salida.
- Node imprime `MODULE_TYPELESS_PACKAGE_JSON` (warning, no error) al cargar `src/lib/integrations/catalogs/index.ts` como ESM, porque el `package.json` raíz no declara `"type"`. Le pasa igual a `scripts/paypal-bootstrap-catalog.ts` con `src/lib/billing/paypal-catalog.ts`. No se toca.

## Resultado de §M1 (2026-11-05, solo lecturas, sin la clave)

Lo ejecutó el coordinador contra `https://api.health.cabbity.com/api/integrations/v1`:

- `GET /me` → Rehactive, id 2, 5 scopes.
- `GET /practitioners` → `membership_id` 10, `location_ids` [3].
- `GET /availability` (sede 3, 7 días) → 200, 38 huecos.
- Test vivo: 5 de 6 en verde en la primera pasada. Falló `lookup_patient`: `{document_type:'passport', document_number:'ZZ-NOEXISTE-000000'}` → 422 `validation_failed`, `field` `document_number` («El formato del campo document number no es válido»). Con `{phone:'+18090000000'}` → 200 `{source:'not_found', matches:[], padron:null}`. El OpenAPI no declara `pattern` para `document_number`.
- `GET /appointments?…&status=confirmed` → 422 `validation_failed`, `field` `status` («El campo estado debe ser una lista»). Con `status%5B%5D=confirmed` → 200.

Correcciones (`69d67dd`):
1. **D4, contingencia aplicada**: `status` quitado de `list_appointments`. Su descripción dice que no filtra por estado y que la IA filtre el resultado. Deuda anotada en el doc: filtros de lista estilo PHP `status[]=`. No se añadió soporte de arrays.
2. Las descripciones de `lookup_patient` y `create_patient` avisan de que un documento mal formado da 422 `validation_failed` con `field` = `document_number`, y piden volver a pedir el dato al cliente.
3. El test vivo busca por teléfono (`+18090000000`) y tiene un caso nuevo que vigila que Health siga rechazando el `status=` escalar (se arma a mano, fuera del catálogo). El test vivo pasa a 7 casos. Hay que volver a correrlo: tras el cambio no se ha ejecutado contra el servicio real.

## Guion §M1 (referencia)

La clave la teclea Brian; no se copia a ningún archivo. Anotar aquí el resultado SIN la clave.

1. Supabase local con migraciones aplicadas. `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health` → `Integration cabbity-health: created (inactive …)` y 16 `created`. Repetir → todo `unchanged`. Sin argumento → exit 1 listando `cabbity-health`.
2. `/platform` → Integraciones → Cabbity Health: 16 operaciones, `list_patients` y `get_patient` inactivas. Abrir `create_appointment`, guardar sin cambios y en SQL `select params from integration_operations where key = 'create_appointment'` → `Idempotency-Key` conserva `"auto": "uuid"`. Activar la integración.
3. La cuenta de prueba tiene un plan con `integrations` (`select features->'integrations' from plans …`).
4. Como cliente: Ajustes → Integraciones → Cabbity Health → pegar la clave → «Probar conexión» → `ok`. `select outcome, status_code from integration_calls order by created_at desc limit 1` → `ok`, `200`.
5. `read -rs CABBITY_HEALTH_KEY && export CABBITY_HEALTH_KEY` y `npx vitest run src/lib/integrations/catalogs/cabbity-health.live.test.ts` → 7 verdes (R23).
6. `curl` de contraste en el mismo shell:
   - `curl -sS -H "Authorization: Bearer $CABBITY_HEALTH_KEY" https://api.health.cabbity.com/api/integrations/v1/me | jq '.data.center, .data.integration.scopes'` → Rehactive, id 2, `America/Santo_Domingo`, 5 scopes.
   - `…/practitioners | jq '.data[] | {membership_id, location_ids}'` → `10`, `[3]`.
   - `…/availability?location_id=3&from=$(date +%F)&to=$(date -d '+6 day' +%F)` → HTTP 200, `.data | length` ≥ 0.
   - `…/appointments?from=…&to=…&status=confirmed` → dio 422 (contingencia D4 aplicada, arriba).
7. `unset CABBITY_HEALTH_KEY`.

Escrituras (`create_patient`, `create_appointment`, `reschedule`, `confirm`, `cancel`) no se prueban contra el centro real (crearían datos reales); las cubren R11, R14 y R22 con fetch simulado.

## Decisiones donde el spec era ambiguo

- **D1–D7**: las recomendadas, aprobadas por el humano el 2026-11-05.
- **Orden de validación de params** (`catalog-validate.ts`): ahora se mira `in` antes que el nombre, porque la regla del nombre depende de la ubicación (cabecera, body con punto, path/query). Los mensajes de error de n13.1 no cambian de texto salvo `in` («path, query, body or header», como pide design §2.2). Los 111 tests previos pasan sin tocarlos.
- **`auto: null`** en un param no-cabecera cuenta como presente y se rechaza («auto is only allowed with in: 'header'»). Design dice «`'auto' in item` (no `undefined`)»; se siguió al pie de la letra. El panel nunca manda `auto` fuera de una cabecera.
- **Unicidad**: una cabecera no puede repetir nombre sin distinguir mayúsculas con otra cabecera, y además comparte el control de nombres repetidos con el resto de params.
- **Contenido con `content-length` no numérico** en un error: se trata como «no leer» (cancelado, sin `remoteError`), más prudente.
- **`status`**: quitado tras §M1 (Health exige `status[]=`). El test de contrato ya no tiene el caso especial de `Appointment.status`.
- **`required` de las cabeceras**: Health declara `Idempotency-Key` opcional en todas las escrituras menos `POST /appointments`. Para nosotros siempre es obligatoria y `auto` (D2); el test de contrato no compara `required` en cabeceras y sí exige que la lleve toda operación cuyo OpenAPI la declare.
- **Textos para la IA**: los de design §3.4, pulidos sin perder las piezas que asierta R4. Añadidos: en `create_patient` el 422 `consent_required`; en `find_availability` el 422 si el rango pasa de 13 días; en `confirm_appointment` el 409 `appointment_not_changeable` (lo declara el OpenAPI).
- **R8, imports**: dentro de `catalogs/` hay un import de valor (`index.ts` → `./cabbity-health.ts`), permitido por design §3.1 (mismo directorio, sin alias). El test exige que todo import de valor apunte a `./*.ts` y que todo `import type` termine en `.ts`.
- **T13 / coordinación**: n13.2 sigue `spec_ready` y no está en `main`, así que no se tocó su código. La nota no va en `progress/current.md` (el implementer no lo edita): **el líder debe pasarla** a n13.2 y n13.3:
  - n13.2 (formulario del nodo y validador de literales) y n13.3 (esquema de herramientas) deben listar los parámetros con `callerParams(op.params)` de `src/lib/integrations/request.ts`, nunca `op.params` a pelo: si no, enseñarían `Idempotency-Key` y la llamada fallaría con `invalid_params`/`unknown`.
  - `IntegrationCallResult` (rama `ok:false`) gana `remoteError?: RemoteError`; es hermano de `paramProblem?` de n13.2. Quien fusione segundo rebasa dos líneas del tipo.
  - Los anidados (`consent.accepted`) se aceptan con punto o como objeto `{consent:{accepted}}`.
  - `remoteError.message` es texto de un tercero: n13.3 debe tratarlo como dato, no como instrucción.
  - Firmas sin cambios: `executeIntegrationOperation`, la forma de `ok:true`, `validateCallParams`. `buildIntegrationRequest` gana un 4.º argumento opcional `{ uuid }`.

## Variables de entorno nuevas

Ninguna de la app. `CABBITY_HEALTH_KEY` solo la lee el test vivo opcional; documentada en `docs/integrations/cabbity-health.md`, no en `docs/docker.md` (design §6). `.env.local.example` no se toca.

## Deuda detectada fuera de alcance (no arreglada)

- La de requirements «Fuera de alcance», más los filtros de lista estilo PHP (`status[]=`; hoy no hay filtro de estado): paginación automática, reutilizar `Idempotency-Key` en reintentos, `remoteError.code` en `integration_calls`, PATCH/DELETE de pacientes, campos y `base_url` por cuenta, importador de OpenAPI.
- `MODULE_TYPELESS_PACKAGE_JSON`: Node avisa al cargar módulos de `src/` desde los scripts, porque el `package.json` raíz no tiene `"type": "module"`. Afecta igual al script de PayPal. Es cosmético.
- El ejecutor no reintenta, así que un 409 `idempotency_in_progress` llega tal cual como `remoteError`. Si algún día hay reintentos, deberían reutilizar la clave.
