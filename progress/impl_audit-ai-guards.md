# impl p16.4 `audit-ai-guards` — D1 y D2 hechos (ronda 2 tras revisión)

Rama `fix/audit-ai-guards` (worktree `.claude/worktrees/audit-ai-guards`, desde `main` 63f581e).
Spec: `progress/audit-2026-11-20/fixes.md` §D; detalle `audit-ai.md` hallazgos 1 y 2. Para D1, decisión
del líder: opción C (sin migración, caché en proceso).

## Plan

1. D1: comprobar dónde vive la evidencia entre turnos → no guarda resultados (ver «Contexto D1»);
   el líder eligió la opción C.
2. D1: guardia de ids en `loop.ts` + caché por conversación, marca `ai_policy.hidden`, prompt.
3. D2: releer puertas antes de `claim_ai_reply_slot`; `.is('assigned_agent_id', null)` en el traspaso.
4. Tests que fallen sin el arreglo, compuerta, CHANGELOG, commits.

## Commits

- `cbd2e78` fix: la IA no responde si un humano toma la conversación durante la generación (p16.4 D2)
- `9242368` fix: la IA solo usa ids devueltos por una herramienta de la conversación (p16.4 D1)
- `5081e68` fix: evidencia de ids tipada por origen y traspaso que respeta hilos cerrados (p16.4, revisión)

## Ronda 2 (review_audit-ai-guards.md, CHANGES_REQUESTED)

- **Hallazgo 1 (bloqueante), evidencia tipada.** Forma pedida por el líder, sin simplificar (no vi una
  más pequeña que cierre los mismos casos):
  - Evidencia = (integración, operación de origen, campo, valor). Registros = `data` si es objeto,
    `data[]`, y `data.<lista>[]` (sin envoltorio `data`, la raíz). De cada registro: `id` (id de
    registro) y claves `*_id` de nivel superior. Nada de sub-objetos (`practitioner`, `location`,
    `center`) ni de listas dentro de un registro.
  - `ai_policy.ids`: parámetro → orígenes, `op` (id de registro de `op`) u `op.campo`. Validado en
    `policyProblem` (1–4 parámetros, 1–8 orígenes, formato `op` / `op.campo`), conservado en
    `sanitizePolicy`; `catalog-validate.ts` ya llama a `policyProblem` (test «every policy passes
    validateOperationInput» lo cubre).
  - Declarado en el catálogo de Cabbity Health para TODAS las operaciones con parámetro protegido:
    `{id}` de `get_appointment`/`reschedule_appointment`/`confirm_appointment`/`cancel_appointment` ←
    `list_appointments`, `create_appointment`, `get_appointment`, `reschedule_appointment` (añadí
    reschedule porque devuelve la cita; si cambia su id, confirmar sigue funcionando);
    `patient_id` de `list_appointments`/`create_appointment` y `{id}` de `get_patient` ← `lookup_patient`,
    `create_patient`, `get_patient`, `list_appointments.patient_id`, `get_appointment.patient_id`,
    `create_appointment.patient_id`; `{id}` de `get_practitioner` ← `list_practitioners.membership_id`,
    `find_availability.membership_id`, `get_practitioner.membership_id`. Un test recorre el catálogo y
    exige declaración para cada parámetro protegido y que cada origen sea una operación existente.
  - **Valor por defecto** (operación con parámetro protegido sin `ai_policy.ids`: otras integraciones, o
    producción antes de recargar el catálogo): vale solo un id de registro de nivel superior de cualquier
    operación de esa integración, nunca claves `*_id` ni anidados. **No distingue entidades** (un
    `matches[].id` de paciente valdría como id de cita); documentado en la cabecera de `ids.ts`.
  - El `get_practitioner` con el `membership_id` anidado en `practitioner` de una cita ya no vale (la
    descripción del catálogo dice «o de una cita»); el modelo pasa por `list_practitioners`. Coste: una
    llamada.
- **Hallazgo 2**: `.neq('status', 'closed')` en el UPDATE del traspaso.
- **Hallazgo 3**: si la relectura corta el envío y alguna herramienta corrió con `ok`, `console.info`
  con cuenta, conversación y keys de operación (sin argumentos ni resultados). `toolsUsed` no trae el
  método, así que se registra con cualquier herramienta `ok`, no solo escrituras. La ventana
  check-then-act entre relectura y claim sigue (cerrarla exige migración de la RPC): anotado.
- **Hallazgo 4**: `buildAiTools` mira `aiPolicy.hidden === true` crudo, sin sanear.
- El test «a refused call does not spend the execution budget» ahora sí lo prueba: 9 negativas y luego
  un `lookup_patient` que se ejecuta (con el contador, la vuelta siguiente sería final).
- Tests existentes cambiados porque fijaban la forma vieja de la política: `cabbity-health.test.ts`
  «cancel_appointment requires the appointment…» (ahora incluye `ids`) y `bootstrap.test.ts` «a row
  loaded before n13.7…» (`toMatchObject`).
- `loop.ids.test.ts` usa ahora el toolset construido con `buildAiTools` desde el catálogo real
  (nombres de parámetro reales, `{id}` de ruta, y sus `ai_policy`).

## Contexto D1 (por qué no hay migración)

`loadPriorEvidence` (`evidence.ts`) lee de `integration_calls` solo `operation_key`; la tabla no tiene
columna de resultado y los resultados no se persisten en ningún sitio. El líder eligió la opción C.

## D1 — guardia de ids

- `src/lib/ai/tools/ids.ts` (nuevo):
  - **Id protegido** (`isProtectedParam`, declarativo): todo parámetro `in: 'path'`, más `patient_id`
    (último segmento del nombre) en `query` o `body`.
  - **Evidencia**: tipada por origen (ver «Ronda 2»). Números y textos se comparan como texto
    (`1234` == `"1234"`).
  - **Caché** por `(cuenta, conversación)`, 24 h (`AI_EVIDENCE_WINDOW_MS`) renovadas en cada escritura,
    500 conversaciones y 1000 ids por conversación, las más viejas salen primero (como la caché de
    lecturas en vivo). Lleva el comentario `shortcut: in-process, se pierde al reiniciar o desplegar…`.
- `loop.ts`: al empezar el turno carga los ids conocidos de la conversación; antes de ejecutar, si algún
  id protegido de los argumentos no está, devuelve al modelo `outcome: 'unverified_id'` con la pista
  «búscalo primero con una herramienta…», no llama al ejecutor, **no suma a `executed`** (no gasta el
  tope de 8) y registra `toolsUsed` con `ok: false, blocked: 'policy'`. Tras un `ok`, añade sus ids al
  turno y a la caché. El orden de las guardias: herramienta desconocida → JSON inválido → tope →
  `requires_prior` → id.
- `result.ts`: código `unverified_id` y su pista.
- `prompt.ts`: «Use only ids returned by a tool in this conversation; if the customer gives you an id or
  number, confirm it with a lookup first and use the id from the result.»
- `ai_policy.hidden` (`types.ts`, `policy.ts` `policyProblem`/`sanitizePolicy`, filtro en
  `buildAiTools` de `schema.ts`, en todos los modos). `list_patients` del catálogo de Cabbity Health
  lleva `ai_policy: { hidden: true }` (ya estaba `is_active: false` en el repo; la marca impide que
  un admin que la active la exponga al bot).

### Decisiones

- **Playground y borrador pasan por el mismo guardia.** Borrador manda `conversationId` → comparte la
  caché de la conversación. Playground no tiene conversación (`conversationId: null`) → solo ids del
  propio turno; un id de un turno anterior del playground se niega y el modelo vuelve a buscar. No rompe
  su uso (solo cuesta una búsqueda) y así el playground prueba lo mismo que hará el bot.
- `get_practitioner` y otras operaciones de dato público con id de ruta no se excluyen: el modelo lista
  antes (`list_practitioners` / `find_availability` devuelven `membership_id`). **Ningún test
  existente del flujo de agenda se rompió.**
- Un id en el argumento con valor vacío o no escalar no se comprueba: el ejecutor ya lo rechaza por tipo.

### Acción en producción

Las filas de `integration_operations` de producción hay que **recargarlas con el bootstrap del
catálogo** (`scripts/integrations-bootstrap-catalog.ts`) para que lleguen `ai_policy.hidden` de
`list_patients` y las declaraciones `ai_policy.ids`. Hasta entonces: `list_patients` la protege su
`is_active = false` si así está en producción, y los ids van por el valor por defecto (solo id de
registro de nivel superior, sin distinguir entidad).

## D2 — puertas antes de enviar

`src/lib/ai/auto-reply.ts`: tras generar y antes de `claim_ai_reply_slot` se relee `status,
assigned_agent_id, ai_autoreply_disabled` (con `.eq('id')` + `.eq('account_id')`); sale sin enviar si
error, cerrada, asignada o bot apagado. El UPDATE del traspaso lleva `.is('assigned_agent_id', null)`
siempre (el gate inicial ya exige que sea nulo, así que cubre también el modo cola: si un humano tomó el
hilo durante la generación, no hay traspaso ni aviso).

Cambios del mock de `auto-reply.test.ts` (no fijaban comportamiento malo): el UPDATE acepta `.is()` y lo
modela contra la fila; `conversationSelectColumns` guarda la primera lectura (la de las puertas).

## Criterio ↔ test

| Criterio | Archivo | `it` |
|---|---|---|
| D1 id tecleado por el cliente → no se ejecuta | `src/lib/ai/tools/loop.ids.test.ts` | `an id the customer typed is not executed; the model is told to look it up` |
| D1 `patient_id` no verificado → no se ejecuta | idem | `an unverified patient_id in the query is refused too` |
| D1 id devuelto en este turno → sí | idem | `an id returned by a tool in this turn is executed` |
| D1 id devuelto en un turno anterior (caché) → sí | idem | `an id returned in an earlier turn of the same conversation is executed` |
| D1 caché vacía (reinicio) → se niega y tras búsqueda pasa | idem | `after a restart (empty cache) it refuses, and passes after a lookup` |
| D1 otra conversación / cuenta / sin conversación no comparte | idem | `another conversation or another account does not share the evidence` |
| D1 la negativa no gasta ejecuciones | idem | `a refused call does not spend the execution budget` |
| D1 `list_patients` fuera del toolset | `src/lib/ai/tools/schema.test.ts` | `a hidden operation never reaches the model, in any mode`; `the Cabbity Health catalog hides list_patients from the bot` |
| D1 marca de política válida | `src/lib/ai/tools/policy.test.ts` | `accepts {"hidden":true}`; `rejects … hidden not a boolean`; `sanitizePolicy: invalid → null, …` |
| D1 prompt sin «or given by the customer» | `src/lib/ai/tools/prompt.test.ts` | `carries the rules` |
| D2 asignación / toma de control / cierre durante la generación → no se envía | `src/lib/ai/auto-reply.test.ts` | `p16.4 D2: sends nothing when %s while the model is generating` (3 casos) |
| D2 traspaso no pisa asignación hecha durante la generación | idem | `p16.4 D2: does not stomp an agent assigned while the model was generating` |
| D2 filtros del UPDATE | idem | `scopes the service-role conversation read and handoff write to its account` (ampliado con `assigned_agent_id` nulo y `neq status closed`) |
| R2 traspaso no toca hilo cerrado durante la generación | idem | `p16.4 D2: does not hand off a thread closed while the model was generating` |
| R2 log al cortar tras herramientas | idem | `p16.4 D2: logs (ids only) when the reply is dropped after a tool ran` |
| R2 `location_id` de `find_availability` no abre `patient_id` ni id de cita | `src/lib/ai/tools/loop.ids.test.ts` | `a location_id from find_availability opens neither patient_id nor an appointment id` |
| R2 ids anidados de una cita (`practitioner.id`, `location.id`) y el `patient_id` propio como id de cita no abren nada | idem | `nested practitioner/location ids of an appointment open nothing` |
| R2 `center.id` de `get_center` no abre nada | idem | `a nested center id from get_center opens nothing` |
| R2 `list_practitioners` → `get_practitioner` sigue pasando | idem | `list_practitioners → get_practitioner by membership_id still passes` |
| R2 lookup → list → cancel sigue pasando (catálogo real) | idem | `an id returned by a tool in this turn is executed` |
| R2 todo parámetro protegido del catálogo declara orígenes | idem | `every protected parameter of the catalog declares its origins` |
| R2 valor por defecto: solo id de registro | idem | `only a top-level record id of the integration counts, never *_id keys` |
| R2 `ai_policy.ids` validado | `src/lib/ai/tools/policy.test.ts` | `accepts {"ids":…}`; `rejects ids not an object / ids empty / ids with no sources / ids with a bad source / ids with a two-dot source` |
| R2 `hidden` sin depender del resto | `src/lib/ai/tools/schema.test.ts` | `hidden holds even when another key of the policy is invalid (review 4)` |

Fallan sin el arreglo (comprobado con `git stash` del fuente): D1 10 tests, D2 5 tests; ronda 2:
7 tests de ids/política sin `ids.ts`/`loop.ts`/`policy.ts`/`schema.ts`/catálogo nuevos, y 3 de
`auto-reply` sin `auto-reply.ts` nuevo. Los dos casos
positivos de D1 («este turno», «turno anterior») pasan también sin el arreglo, como es lógico: prueban
que el guardia no rompe el flujo.

## Verificación

- Sin SQL nuevo, sin base real necesaria. Sin variables de entorno nuevas. `.env.local.example` no tocado.
- Manual pendiente (Meta + Cabbity Health reales), guion: en un WhatsApp de prueba con Aura,
  (1) «cancela la cita 99999» sin haber consultado → Aura debe buscar las citas del paciente y no
  cancelar nada ajeno; (2) «¿qué citas tengo?» → «cancela la del sábado» en el mensaje siguiente →
  se cancela; (3) mismo paso (2) tras un redespliegue entre los dos mensajes → Aura vuelve a consultar
  y cancela; (4) tomar el chat desde la bandeja mientras Aura «escribe» → no llega respuesta del bot.

## Compuerta

Ronda 2: `npx eslint . --ignore-pattern '.claude/**'` (0 errores), typecheck, `TZ=UTC npm test`
(418 archivos, 6405 passed, 7 skipped, todo verde incluido middleware) y build: salida 0. Prettier
limpio en los archivos tocados.

Ronda 1: mismas cuatro verdes. Vitest: 6389 passed, 7 skipped; en dos corridas
completas falló por timeout (5 s) solo `src/middleware.test.ts` › «lets the coexistence cron through…
(#1651)», un `import()` en frío con la máquina a carga 53 (otros cinco implementers en paralelo); pasa
solo (84/84) y en la corrida de D2. No toca código de esta feature. Build: salida 0.

## Deuda fuera de alcance

- Hallazgos 3–8 de `audit-ai.md` (turnos solapados, playground sin cuota, `empty_response` silencioso,
  reindex, TZ, clientes admin duplicados).
- La caché de ids es por proceso: con dos instancias o tras desplegar, cuesta una búsqueda extra.
  Si molesta, columna en `integration_calls` (opción A).
