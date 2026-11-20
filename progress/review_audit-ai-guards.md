# Review — p16.4 audit-ai-guards (ronda 2)

**Veredicto:** APPROVED

Rama `fix/audit-ai-guards`: 9242368, cbd2e78 y **5081e68** (ronda 2). La ronda 1 se rechazó porque la evidencia de ids no tenía tipo: un `location_id`, un `membership_id` o un id anidado servían como id de paciente o de cita. Esa ronda está resumida al final.

## Compuerta
- `npx eslint . --ignore-pattern '.claude/**'`: 0 errores (34 warnings ya existentes). typecheck, `TZ=UTC npm test` (418 archivos, 6405 passed, 7 skipped) y build con las variables dummy: **verde**. El `middleware.test.ts` no falló esta vez.
- replay-migrations: n/a (sin SQL). La única restricción de la columna `ai_policy` es `jsonb_typeof = 'object'` (095), así que las claves nuevas `ids` y `hidden` entran sin migración.
- Comprobé que los tests fallan sin el arreglo: en un worktree aparte devolví `ids.ts`, `loop.ts`, `policy.ts`, `schema.ts`, `cabbity-health.ts` y `auto-reply.ts` a 9242368 y corrí los tests de la ronda 2. **Fallan 9**: los 3 de colisión, la declaración del catálogo, el caso por defecto, `hidden` con política inválida y los 3 de D2 (cerrado + traspaso, log y filtros). En la ronda 1 había hecho lo mismo contra `main`: 13 fallaban.

## Trazabilidad criterio ↔ test
- D1 «un id tecleado no se ejecuta»: [x] `loop.ids.test.ts` › "an id the customer typed…" y "an unverified patient_id…". Ahora corre sobre el **catálogo real** (`buildAiTools(CABBITY_HEALTH_CATALOG…)`, con el `{id}` de ruta real).
- D1 «el id que devuelve una herramienta sí se ejecuta»: [x] tests "…in this turn…" (lookup → list → cancel con `'1234'` en texto), "…earlier turn…" y "after a restart…".
- D1 «sin compartir entre conversaciones ni cuentas»: [x] "another conversation or another account…".
- D1 «una entidad no habilita a otra» (ronda 1, hallazgo 1): [x] "a location_id from find_availability opens neither…", "nested practitioner/location ids…" (incluye el `patient_id` propio usado como id de cita), "a nested center id from get_center…".
- D1 «el flujo de profesionales sigue pasando»: [x] "list_practitioners → get_practitioner…".
- D1 «toda operación con un id protegido lo declara»: [x] "every protected parameter of the catalog declares its origins".
- D1 «comportamiento por defecto»: [x] "only a top-level record id of the integration counts…".
- D1 «list_patients oculta»: [x] `schema.test.ts` (los 2 de la ronda 1 más "hidden holds even when another key… is invalid").
- D1 prompt: [x] `prompt.test.ts` › "carries the rules".
- D1 «una negativa no gasta el presupuesto»: [x] el test ya prueba algo: después de 9 negativas, el `lookup` se sigue ejecutando.
- D2 «no envía si asignan, toman o cierran durante la generación»: [x] `auto-reply.test.ts` › "sends nothing when %s…" (3 casos).
- D2 «el traspaso no pisa una asignación»: [x] "does not stomp an agent…".
- D2 «el traspaso no toca un hilo cerrado» (ronda 1, hallazgo 2): [x] "does not hand off a thread closed while the model was generating", más el filtro `neq:status` en "scopes the service-role…".
- D2 «queda log si se descarta la respuesta tras una escritura» (ronda 1, hallazgo 3): [x] "logs (ids only) when the reply is dropped after a tool ran". Solo registra cuenta, conversación y nombres de operación; ningún dato del paciente.

## El ataque, repetido (catálogo real, con las declaraciones)
Todas estas variantes se niegan. Lo leí en `ids.ts` (`collectResultIds` solo toma `data`, `data[]` y `data.<lista>[]`, sin bajar a sub-objetos; `isKnownId` exige (operación, campo)) y lo cubren tests:
- `location_id`/`membership_id` de find_availability usados como `patient_id` o como id de cita → no, el origen es `find_availability.location_id`, que ninguna declaración acepta (test).
- `data.center.id` de get_center → no se recoge, porque `center` es un sub-objeto (test).
- `practitioner.id`/`location.id` anidados en una cita → no se recogen (test).
- El `patient_id` propio usado como id de cita → no. `lookup_patient`/`list_appointments.patient_id` no están en `APPOINTMENT_ID` (test, `cancel(88)`).
- Un id de cita usado como `patient_id` → no. `PATIENT_ID` solo acepta `list_appointments.patient_id`/`get_appointment.patient_id`/`create_appointment.patient_id`, y nunca el `id` de registro de una operación de citas. Lo leí en el código; no hay un test específico (ver «Menores»).

## Recorrido (que siga funcionando)
Las declaraciones están leídas en `cabbity-health.ts`:
- lookup_patient `matches[].id` / create_patient `data.id` → `patient_id` de list_appointments y create_appointment: OK (las dos fuentes están en `PATIENT_ID`).
- list_appointments `data[].id` / create_appointment `data.id` / get_appointment / reschedule → get, reschedule, confirm y cancel: OK (`APPOINTMENT_ID`).
- list_practitioners / find_availability `membership_id` → get_practitioner `{id}`: OK (test).
- Número frente a texto: OK. Turno anterior: OK (caché). Ninguna operación activa queda inutilizable.

## Caso por defecto (sin `ai_policy.ids`: producción hasta que se recargue el catálogo)
Solo vale un `id` de **registro de nivel superior** de cualquier operación de la misma integración. Nunca valen claves `*_id` ni ids anidados. En Cabbity Health eso deja pasar:
- **los `data[].id` de list_locations (sedes), de pacientes (lookup/create) y de citas, intercambiables entre sí**. Ejemplo: list_locations → `id 3` → `list_appointments(patient_id=3)` pasa. El `patient_id` propio (88) también pasa como id de cita: el test "default" lo fija.
- sigue negando todo lo tecleado, los `location_id`/`membership_id` de las franjas, `center.id` y los ids anidados.
- es demasiado estricto con get_practitioner: list_practitioners devuelve `membership_id`, no `id`, así que se niega hasta la recarga. Molesta poco, porque list_practitioners ya da los datos.

Aun así, es estrictamente mejor que `main` (que no negaba nada). **Condición de despliegue:** recargar el catálogo de Cabbity Health con `scripts/integrations-bootstrap-catalog.ts` en el mismo despliegue; si no, la protección de la ronda 2 no está activa en producción. El CHANGELOG lo dice. El líder y el humano deben ejecutarlo, no basta con leerlo.

## Qué NO cierra (fuera de §D, para el líder)
- **Suplantación por documento o teléfono:** lookup_patient acepta la cédula o el teléfono de otra persona, y su `matches[].id` es evidencia legítima, que abre las citas de esa persona y su cancelación. Hay que atar el paciente al teléfono del contacto de WhatsApp en el servidor. Pide una feature propia.
- Ventana de check-then-act entre la relectura y `claim_ai_reply_slot`. Cerrarla exige meter las puertas en el WHERE de la RPC, y eso es una migración.
- La caché es por proceso: tras desplegar o reiniciar, o con varias instancias, el modelo vuelve a buscar (decisión del líder, marcada con `shortcut:`).

## Checkpoints
- CP1 Compuerta: [x]
- CP2 Migraciones: [x] n/a
- CP3 Aislamiento: [x] la relectura y el traspaso filtran por `id` + `account_id`; la clave de la caché lleva la cuenta.
- CP4 Tests: [x] cada criterio tiene un test que falla sin el arreglo.
- CP5 Sin dependencias: [x]
- CP6 i18n: [x] n/a
- CP7 Next 16: [x] n/a
- CP8 Alcance: [x] solo §D y los hallazgos de la ronda 1. Se tocaron `bootstrap.test.ts` y `cabbity-health.test.ts` porque la política de cancel ahora lleva `ids`: es justificado.
- CP9 Documentación: [x] CHANGELOG, con la recarga del catálogo.
- CP10 Git: [x] commits `fix:` en español con Co-Authored-By.
- CP11 Lo entrante no se bloquea: [x]
- Caché acotada: [x] 500 conversaciones × 1000 claves, 24 h; registros por resultado ≤ 500.

## Menores (no bloquean)
1. `src/lib/ai/tools/ids.ts` (`collectResultIds`): cuando `data` es un objeto, cualquier lista de primer nivel (`data.<lista>[]`) cuenta como registros de esa operación. Si Health añadiera a get_appointment un array con `id` (historial, recordatorios), esos ids valdrían como id de cita. Hoy la respuesta documentada no tiene ninguno.
2. Faltan tests positivos de create_patient → create_appointment y de create_appointment → confirm/reschedule, y el negativo «id de cita como `patient_id`». Las declaraciones los cubren al leerlas.
3. `src/lib/ai/tools/loop.ts:363`: `flattenToolArgs` se calcula dos veces por llamada.

## Ronda 1 (resumen)
CHANGES_REQUESTED: la evidencia era (slug, valor) sin tipo (`ids.ts:41/72`), y el traspaso no miraba `status`, no quedaba log al descartar y `hidden` fallaba abierto. Las cuatro cosas están resueltas en 5081e68.
