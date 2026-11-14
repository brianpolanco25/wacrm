# impl n13.7 `ai-grounded-availability`

Estado: **ronda 2 implementada, compuerta en verde, pendiente de reviewer.** No marcada `done`.

- Rama: `feat/ai-grounded-availability` (worktree `.claude/worktrees/ai-grounded-availability`), base `main @ 2799b6b` (n13.8 ya fusionada).
- Commits:
  - `188e756` feat: migración 095 para la IA con disponibilidad fundamentada (n13.7)
  - `e274d0b` feat: la IA solo ofrece días y horas que salen de la integración (n13.7)
- Spec: `specs/ai-grounded-availability/{requirements,design,tasks}.md` (D1–D8 aprobadas el 2026-11-11).

## Plan (de tasks.md)

T1 migración 095 + verify-schema + checks SQL → T2 plantillas/validación → T3 tipos, ejecutor, evidencia, política → T4 caché de lecturas → T5 render + prompt → T6 política en catálogo/validación/bootstrap → T7 carga y esquema → T8 detector de agenda → T9 bucle (guardias) → T10 llamadores → T11 Ajustes (vista, PATCH, diálogo, i18n) → T12 guion manual (pendiente, humano) → T13 compuerta + CHANGELOG + docs.

## Qué se hizo

- **Migración** `supabase/migrations/095_ai_grounding.sql` (idempotente, `lock_timeout 5s`): `account_integrations.ai_live_reads jsonb NOT NULL DEFAULT '[]'` + CHECK (array ≤ 3); `integration_operations.ai_policy jsonb` + CHECK (objeto o NULL); `integration_calls.conversation_id uuid REFERENCES conversations ON DELETE SET NULL` y `ai_preload boolean NOT NULL DEFAULT false`; índice parcial `integration_calls_conversation_idx`. Bloque `-- 095` en `supabase/ci/verify-schema.sql` (columnas, defaults, los 2 CHECK, FK `confdeltype='n'`, índice).
- **Nuevos módulos** (`src/lib/ai/tools/`): `live-templates.ts` (plantillas y `validateLiveReads`), `live.ts` (ejecución en paralelo + caché de proceso 500 entradas, 60 s ok / 10 s fallo, `invalidateLiveCache`), `live-render.ts` (bloque por día local, ≤ 6000 bytes, sección «Live data»), `evidence.ts` (`loadPriorEvidence`, filtra `account_id`), `policy.ts` (`policyProblem`, `sanitizePolicy`, `checkRequiresPrior`), `grounding.ts` (`mentionsSchedule`, `GROUNDING_RETRY_NOTE`).
- **Bucle** (`loop.ts`): evidencia previa una vez por turno; bloqueo `policy_requires_prior` sin ejecutar ni registrar fila; invalidación de caché tras escritura ok; guardia del texto final (una vuelta correctiva fuera de `AI_TOOL_MAX_ROUNDS`, luego `[[HANDOFF]]` + `console.warn('[ai grounding]', cuenta, modo, 'handoff')`). `toolChoice` sigue `'auto' | 'none'` (adaptadores sin tocar, D3).
- **Llamadores**: `auto-reply.ts` (lecturas tras `claimInboundAutoReply` y el límite por cuenta), `/api/ai/playground` (`trail` del cuerpo → evidencia; devuelve `grounding`), `/api/ai/draft` (`mode: 'draft'`, sin guardia de texto).
- **Catálogo Health**: `grounds: ['schedule']` en las 6 operaciones de R24; `cancel_appointment.requires_prior = [['list_appointments','get_appointment'],['find_availability']]` y frase añadida a su descripción. `validateOperationInput` valida `ai_policy`; el bootstrap sincroniza `ai_policy` (`OPERATION_SYNCED`), con `null` cuando la definición no la trae.
- **Ajustes**: la vista devuelve `aiLiveReads` y `aiReadOperations`; el PATCH acepta `aiLiveReads` y lo valida contra las operaciones de ESA integración con la zona del cuerpo o de la fila de ESTA cuenta (400 `field:'aiLiveReads'`). Componente nuevo `src/components/settings/integration-live-reads.tsx` dentro del diálogo «Instrucciones para la IA». Playground acumula el `trail` de los `toolsUsed` previos; `ToolsUsedLine` marca las bloqueadas.
- **i18n** (`messages/es.json`, `messages/en.json`, misma clave y placeholders): `Settings.integrations.aiLive{Title,Hint,TemplatesHelp,Operation,Add,Remove,Max,Empty,Invalid}` y `AiTools.toolBlocked`.
- `CHANGELOG.md` (Unreleased, con «Migration required: 095» y el bootstrap); `docs/docker.md` (`AI_LIVE_DATA_TTL_MS`).

## Trazabilidad requisito ↔ test

| R | Archivo(s) | Test (`it`) |
|---|---|---|
| R1 | 095 | [SQL] `progress/checks_ai-grounded-availability.sql`: default `[]`, objeto rechazado, array de 4 rechazado, 3 aceptado |
| R2 | `live-templates.ts`, `[integrationId]/route.ts` | `live-templates.test.ts` › validateLiveReads (rejects 4, unknown/inactive/POST, undeclared, auto header, missing, wrong type, enum, object); `[integrationId]/route.test.ts` › «400 field aiLiveReads for %s, nothing stored» |
| R3 | `live-templates.ts` | `live-templates.test.ts` › hasUnknownTemplate accepts/rejects `%s`; «rejects the template %s» |
| R4 | `live-templates.ts` | «{{today}} uses the local date…», «without a zone (null) it is UTC», «adds calendar days across the end of the month», «…across a DST change», «replaces a template embedded…» |
| R5 | `account.ts`, `live-templates.ts` | «[] and null → []»; route › «R5: null and [] store []» |
| R6 | `account.ts` | `integrations/route.test.ts` › «returns the exact shape…» (ampliado); `[integrationId]/route.test.ts` › «stores a valid list unresolved and answers aiLiveReads and aiReadOperations» |
| R7 | `integration-live-reads.tsx`, `integrations-settings.tsx` | `integration-live-reads.test.tsx` › «with 3 reads, Add is disabled…», «a numeric input for integer, a select for enum…», «shows the 400 error inline», helpers add/remove/operation/param, «the dialog PATCH carries aiLiveReads…», «a 400 with field aiLiveReads is a dialog error…» |
| R8 | `messages/*.json` | `integrations-settings.test.tsx` › «es and en have the same keys and placeholders» (existente, cubre las claves nuevas); `integration-live-reads.test.tsx` › «is translated in en»; `ai-tools-used.test.tsx` › «marks a blocked call in %s» |
| R9 | `live.ts`, llamadores | `live.test.ts` › «R9: runs with source ai, preload, the conversation and the templates resolved…»; `auto-reply.live.test.ts` › «R9/R16/R27…»; `playground/route.live.test.ts` › «loads live data for the session account…»; `draft/route.live.test.ts` › «puts the live block in the prompt and runs in draft mode» |
| R10 | `auto-reply.ts` | `auto-reply.live.test.ts` › «R10: a lost claim → no live reads», «R10: over the per-account limit → no live reads» |
| R11 | `live.ts` | `live.test.ts` › «R11: two equal reads within 60 s…», «R11: AI_LIVE_DATA_TTL_MS overrides the TTL» |
| R12 | `live.ts` | «R12: a failure is remembered 10 s and retried after» |
| R13 | `live.ts`, `loop.ts` | `live.test.ts` › «R13: invalidateLiveCache…»; `loop.grounding.test.ts` › «R13: a write ok invalidates the live cache…» |
| R14 | `live.ts` | «R14: account A never reuses the entry of B», «R14: past 500 entries the oldest is evicted» |
| R15 | `live.ts`, `load.ts` | «R15: an execute that throws → a failed block…», «R15: the console never carries params or data»; `load.test.ts` › «a garbage ai_live_reads → no live reads» |
| R16 | `defaults.ts`, `live-render.ts` | `live-render.test.ts` › «without liveData or with [] the prompt is byte for byte the same», «with liveData the section goes right after the tools section», «ok: integration, operation, load instant…» |
| R17 | `live-render.ts` | «groups a Health response by local day…», «a slot at 23:30Z lands on the right local day» (02:30Z → 22:30 local), «without an integration zone it uses the offset of the value» |
| R18 | `live-render.ts` | «empty list → no results; meta.truncated → says there are more» |
| R19 | `live-render.ts` | «an object without dates → compact JSON», «2 000 slots → ≤ 6 000 bytes, whole days and a cut note», «if not even the first day fits, cut by lines», «a huge non-list → JSON cut by code points», «strings are cut to 80 characters…» |
| R20 | `live-render.ts` | «ok: … and the ONLY rule» |
| R21 | `live-render.ts` | «failure: forbids stating days or times; HANDOFF only in auto_reply» |
| R22 | 095 | [SQL] `ai_policy` string rechazado; objeto y NULL aceptados |
| R23 | `policy.ts`, `catalog-validate.ts` | `policy.test.ts` › accepts/rejects; `catalog-validate.test.ts` › «validateOperationInput: ai_policy (n13.7, R23)» |
| R24 | `cabbity-health.ts` | `cabbity-health.test.ts` › «the six schedule operations ground…», «cancel_appointment requires…», «every policy passes validateOperationInput» |
| R25 | `scripts/integrations-bootstrap-catalog.ts` | `bootstrap.test.ts` › «a row loaded before n13.7 (ai_policy null) gets the policy», «an equal policy … is unchanged», «an operation without policy … clears a stored one» |
| R26 | `schema.ts` | `schema.test.ts` › «keeps the policy on the tool, never in the JSON schema, and appends the requires_prior sentence», «a long description is cut before the sentence…», «no or invalid policy → no policy field» |
| R27 | 095, `execute.ts`, `loop.ts`, `live.ts` | [SQL] FK SET NULL + `ai_preload` default; `execute.test.ts` › «records conversation_id and ai_preload when given», «without them the row is the one of before»; `loop.grounding.test.ts` › «with ordered prior evidence → executed with the conversation id» |
| R28 | `evidence.ts`, `loop.ts` | `evidence.test.ts` › «only ok AI calls of this account and conversation in 24 h, not live reads, in order»; `loop.grounding.test.ts` › «evidence is loaded once per turn and calls of THIS turn never count» |
| R29 | `policy.ts`, `loop.ts` | `policy.test.ts` › checkRequiresPrior (orden, alternativa, orden inverso, otra integración, sin evidencia) |
| R30 | `loop.ts`, `result.ts` | `loop.grounding.test.ts` › «cancel without prior evidence → policy_requires_prior, no execute, blocked in toolsUsed» |
| R31 | `evidence.ts`, `loop.ts` | `evidence.test.ts` › «R31: a database error → []»; `loop.grounding.test.ts` › «R31: evidence loader that throws → empty evidence (blocked)» |
| R32 | `tools-used.ts`, playground | `tools-used.test.ts` › readTrail/trailFromToolsUsed; `playground/route.live.test.ts` › «R32: a valid trail…», «R32: more than 50 entries…»; `loop.grounding.test.ts` › «R32: the playground priorEvidence replaces the database» |
| R33 | `execute.ts` (sin cambios de política) | `execute.test.ts` › «R33: a flow runs an operation with ai_policy.requires_prior» |
| R34 | `evidence.ts` | `evidence.test.ts` › «R34: two accounts sharing a fake conversation_id never mix» |
| R35 | `grounding.ts` | `grounding.test.ts` › positive/negative `%s` |
| R36 | `loop.ts` | `loop.grounding.test.ts` › «with a live read ok → no extra round», «a failed live read does not ground», «a find_availability ok earlier in the turn grounds the text» |
| R37 | `loop.ts` | «schedule text without data → one extra round with the note and toolChoice auto», «if the extra round calls find_availability ok → its text is returned» |
| R38 | `loop.ts`, `generate.ts` | «if it insists → [[HANDOFF]], grounding handoff, and a warn without the text», «through generateReply the handoff is a real handoff», «AI_TOOL_MAX_CALLS reached → straight handoff, no extra round» |
| R39 | `loop.ts` | «R39: draft mode → no guard» |
| R40 | `loop.ts` | «R40: a toolset without grounds behaves as before» + toda la suite existente de `loop.test.ts` sin tocar |
| R41 | `loop.ts` | «R41: no provider call ever gets a toolChoice other than auto or none» |
| R42 | — | Suite completa en verde (ver compuerta). Única ampliación de test existente: `integrations/route.test.ts` «returns the exact shape» (ver decisiones) |
| R43 | — | [M] pendiente, guion abajo |

## Compuerta (desde el worktree)

| Comando | Resultado |
|---|---|
| `npm run lint` | 0 errores, 34 warnings (todos preexistentes; `eslint` sobre los archivos tocados: 0 problemas) |
| `npm run typecheck` | OK |
| `TZ=UTC npm test` (suite completa, una vez) | 377 archivos ok / 1 skipped; 5927 tests ok / 7 skipped |
| `npm run build` (vars dummy de CI) | OK |
| `scripts/replay-migrations.sh <worktree>` | exit 0, `095_ai_grounding.sql` ok, `verify-schema.sql: OK` |
| 095 aplicada dos veces + verify | OK (todo `already exists, skipping`) |
| `progress/checks_ai-grounded-availability.sql` contra el contenedor (`KEEP=1`) | 8 NOTICE `ok …`, ROLLBACK |

## Verificación contra base real

`/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/checks_ai-grounded-availability.sql` (transacción con ROLLBACK; crea usuario, cuenta, contacto, conversación, integración y activación):
- R1: default `[]`; objeto → `check_violation`; array de 4 → `check_violation`; array de 3 aceptado.
- R22: `ai_policy` string → `check_violation`; objeto y NULL aceptados.
- R27: `ai_preload` default `false`; borrar la conversación deja la fila de `integration_calls` con `conversation_id = NULL`.

Salida obtenida: `ok R1 default []`, `ok R1 object rejected`, `ok R1 array of 4 rejected`, `ok R1 array of 3 accepted`, `ok R22 string rejected`, `ok R22 object and NULL accepted`, `ok R27 ai_preload default false`, `ok R27 delete conversation keeps call with conversation_id NULL`.

## Verificación manual pendiente (R43, design §14) — la hace el humano

Cuenta de pruebas con Health real y proveedor real (nunca Rehactive en producción sin permiso). Antes: aplicar 095 y correr `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health`.
1. Ajustes → Integraciones → Cabbity Health → «Instrucciones para la IA»: zona `America/Santo_Domingo`; «Añadir lectura» `find_availability` con `location_id` y `membership_id` fijos, `from={{today}}`, `to={{today+13d}}`; guardar. Probar a guardar `{{now}}` → error en línea, el diálogo no se cierra.
2. Playground: «¿qué días tienen libres?» → solo días/horas del bloque (comparar con `GET /availability` a mano). Repetir en < 60 s: `integration_calls` no gana fila (caché); la primera fila tiene `ai_preload = true`.
3. Invalidar la clave de Health → «¿tienen algo el jueves?» → no afirma horas; ofrece consultar o traspasa (`grounding: 'handoff'` en la respuesta del playground si insiste).
4. Con cita existente: «quiero cancelar mi cita» → (motivo) «no puedo ir ese día» → la IA ofrece huecos y NO cancela en ese mensaje; «no, cancélala» + «sí» → cancela. Si en el primer mensaje intenta `cancel_appointment`, la línea «Usó» muestra la llamada «bloqueada por la política».
5. Auto-reply por WhatsApp real: repetir 4 y comprobar en `integration_calls` que las llamadas de IA llevan `conversation_id`.
6. Repetir 2–4 con OpenAI, Anthropic y Gemini.

## Decisiones donde el spec era ambiguo

- **R42 vs campos nuevos en objetos con `toEqual` exacto.** Para no reescribir tests existentes: (a) los campos nuevos del bucle no van en `GenerateArgs.tools` (los tres llamadores tienen tests con `toEqual({toolset, db, accountId})`) sino en un argumento hermano `GenerateArgs.grounding = { mode, liveData?, priorEvidence?, conversationId? }` que `generateReply` esparce en `runToolLoop`; el design los ponía dentro de `tools`. (b) `AiTool.policy` y `AiToolIntegration.liveReads` son opcionales y solo aparecen si hay política/lecturas. (c) `ToolUseRecord.slug` solo se añade cuando el toolset tiene alguna herramienta con `requires_prior` (es cuando el playground necesita el trail). (d) `conversationId` solo se pasa al ejecutor si existe; `conversation_id` / `ai_preload` solo se escriben en la fila si vienen.
- **Única ampliación de un test existente:** `src/app/api/account/integrations/route.test.ts` «returns the exact shape…» afirma la forma exacta de la vista, y R6 exige `aiLiveReads` y `aiReadOperations`: se añadieron esas dos claves a la expectativa (ampliar, no reescribir), igual que hizo n13.3 con los campos de 094.
- `ToolLoopArgs.mode` es opcional y por defecto `auto_reply`; solo cambia algo con herramientas que declaran `ai_policy`.
- `required` del payload `policy_requires_prior`: un texto por paso que falta, con las alternativas unidas por « or » (`"cabbity_health__list_appointments or cabbity_health__get_appointment"`); la pista dice «First call: A or B, then C…».
- Frase de R26: `" Requires a previous call (in an earlier message) to: <a> or <b>, then <c>."`; si la descripción no cabe en 1024, se corta la parte anterior y la frase se conserva.
- Trail de > 50 entradas: se quedan las 50 válidas más recientes (no se descarta el trail entero).
- Guardia de texto: un texto que ya contiene `[[HANDOFF]]` no se evalúa (ya es traspaso).
- Texto vacío en un parámetro de lectura en vivo = sin valor (no se guarda la clave).
- `mentionsSchedule`: «1.50» se detecta como hora (indistinguible de `10.30`, que R35 pide detectar); precios con separador de miles (`RD$1,500.00`), cédulas y teléfonos no.
- PATCH: la validación de `aiLiveReads` va antes de la traza de soporte (un 400 no deja fila en `impersonation_actions`). Si la integración no existe, una lista no vacía da 400 (no hay operaciones) antes del 404.
- El diálogo de IA gana `max-h-[90vh] overflow-y-auto` para que 3 lecturas con sus campos no se salgan de pantalla.

## Variables de entorno nuevas

- `AI_LIVE_DATA_TTL_MS` (por defecto 60000), documentada en `docs/docker.md`. `.env.local.example` está bloqueado por permisos: **no se tocó**; conviene añadirla allí a mano (comentada, opcional).

## Tras desplegar (preguntar antes, remoto)

1. Aplicar `095_ai_grounding.sql` en el Supabase remoto.
2. `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health` para cargar `ai_policy` y la nueva descripción de `cancel_appointment`.
3. Configurar la lectura en vivo de Rehactive (Aura) en Ajustes.

## Deuda / notas fuera de alcance (no arregladas)

- Choque probable con n15.1 (`ai-voice-notes`) en `src/lib/ai/auto-reply.ts` (bloque tras `loadAiToolset`), `src/lib/ai/defaults.ts` (`buildSystemPrompt`: un parámetro y un `if` nuevos), `src/app/api/ai/playground/route.ts`, `src/components/agents/ai-playground.tsx`, `messages/*.json` (claves añadidas tras `aiSaveFailed` y en `AiTools`), `CHANGELOG.md` (entrada al principio de Unreleased) y `verify-schema.sql` (bloque `-- 095` tras `/094`; n15.1 añadirá `-- 096`). Todos los cambios son aditivos.
- `OPERATION_KEY_RE` está duplicado en `src/lib/ai/tools/policy.ts` (`POLICY_KEY_RE`) porque `catalog-validate.ts` importa `node:net` y `policy.ts` lo carga el esquema de herramientas; si se mueve la regex a `types.ts`, unificar.
- La caché de lecturas en vivo es por proceso: con varias réplicas, cada una llama a Health una vez por minuto y lectura (aceptado en D1/D8).
- Falso positivo conocido (D7): una cuenta sin lectura en vivo que responde horarios de apertura desde sus instrucciones recibe una vuelta correctiva y puede traspasar.
- `lint` arrastra 34 warnings preexistentes ajenos a esta feature.

## Ronda 2 (respuesta a `progress/review_ai-grounded-availability.md`)

Commit: `6c1c185` fix: lecturas en vivo solo GET activas y guardia de agenda sin falsos positivos (n13.7) — sobre `e274d0b`, misma rama/worktree.

### Cambio requerido 1 — falsos positivos de la guardia (`src/lib/ai/tools/grounding.ts`)
- Días: lookbehind `(?<!\b(?:sant[oa]|sto\.?)\s+)` sobre todo el grupo de días: «Santo Domingo», «Santo Domingo Este/Norte/Oeste», «Sto. Domingo» ya no cuentan. «el domingo en Santo Domingo» sigue contando (el primer `domingo`).
- Horas `HH.MM`/`HH:MM`: lookbehind `NOT_AFTER_CURRENCY` = símbolo (`$ € £`) o código (`rd us usd dop eur gbp mxn cop pen clp ars`) con o sin espacio delante. `RD$ 15.00`, `US$ 2.50`, `$ 3.50`, `USD 15.00`, `DOP 12.30`, `€ 10.30` → no hora. Un `15.00` suelto sin moneda sigue siendo hora (indistinguible de `10.30`).
- Tests: negativos nuevos en `grounding.test.ts` › «negative: %s» (5 de Santo Domingo, 8 de moneda); `loop.grounding.test.ts` › «ronda 2: no schedule claim without data → no extra round (%s)» (dirección con Santo Domingo + `RD$ 15.00`; Santo Domingo Este + «a las 3 personas»): una sola llamada al proveedor, `grounding` indefinido.

### Cambio requerido 2 — lecturas en vivo solo sobre operaciones activas y `GET` hoy (`src/lib/ai/tools/load.ts`)
- `loadAiToolset` ya cargaba las operaciones activas (todos los métodos); ahora arma el conjunto `integration_id + key` de las activas con `method === 'GET'` y filtra `readStoredLiveReads(...)` contra él. Una lectura cuya operación hoy es `POST`/otra, está inactiva o ya no existe se omite (ausente del toolset, por tanto `loadLiveData` nunca llama a `execute`) y deja `console.warn('[ai live]', cuenta, slug, operación, 'skipped_not_get_or_inactive')` sin parámetros ni datos. Si no queda ninguna, `liveReads` no aparece (forma de antes).
- Se eligió filtrar en `load.ts` (la fuente de la verdad del método en el turno) en vez de en `loadLiveData`: `AiTool` no siempre existe para la operación leída (modo borrador o tope de 20) y el catálogo ya está en memoria ahí, sin consulta extra.
- Tests (`load.test.ts`, describe «n13.7 live reads and ai_policy»): «a stored live read over %s is skipped and execute is never called» ×3 (operación hoy `POST` = `create_appointment`, inactiva = `old_op`, inexistente) — carga real con `FakeDatabase` + `loadLiveData` con `execute` espía: solo se ejecuta la lectura válida, nunca la obsoleta, y sale el warn; «a stored live read whose only operation is POST today → no live reads at all» — `liveReads` indefinido, `loadLiveData` → `[]`, `execute` no llamado.

### Hallazgo 4 — horas españolas sin minutos (`grounding.ts`)
- Patrón «a la(s) N»: `\ba\s+las?\s+(0–23)` sin otro dígito ni `[.,:/]dígito` detrás, y seguido de: fin, puntuación, `de la mañana/tarde/noche/madrugada`, `del mediodía`, `en punto`, `y media/cuarto/dígito`, `menos`, `horas/hrs/h`, o una palabra de unión frecuente (`o u y a en para el este esta hoy mañana pasado le la lo te nos les me se si sin con por que ok vale`). Un sustantivo detrás («a las 3 personas», «a las 2 mascotas») no cuenta. Se quitó `de` suelto de la lista para no casar «a las 2 de 3».
- Patrón «N de la tarde/mañana/noche/madrugada» y «N del mediodía» sin «a las».
- «4 de noviembre» ya contaba por el patrón día + mes (positivo añadido). «2 de 3 citas», «4 de 10 sesiones» → negativos.
- Tests: `grounding.test.ts` › «positive: %s» (+16: «Le agendo mañana a las 4 de la tarde», «a las 4», «a la 1», «a las 3 y media», «a las 8 o a las 9», «nos vemos a las 4, ¿le parece?», «3 de la tarde», «a las 12 del mediodía», «el 4 de noviembre»…) y negativos «atendemos a las 3 personas», «a las 2 mascotas», «tiene 2 de 3 citas», «le quedan 4 de 10 sesiones»; `loop.grounding.test.ts` › «ronda 2: «a las 4 de la tarde» without data → one extra round».
- Riesgo residual anotado: «a las 4 de ellas» u otras frases con una palabra de unión detrás de un número que no es hora darían falso positivo (vuelta correctiva, no traspaso directo). Inglés «at 4» sin am/pm no se detecta (no pedido).

### No bloqueante 11 — implementado (barato y seguro)
- `src/components/settings/integration-live-reads.tsx`: si la operación de una lectura guardada no está en `aiReadOperations` (la vista ya solo lista activas `GET`), la fila muestra `Settings.integrations.aiLiveStale` (`data-live-stale`, texto en rojo) explicando que la IA la omite y que hay que quitarla para guardar. Claves nuevas en `messages/es.json` y `messages/en.json` (misma clave, sin placeholders; la paridad la cubre el test existente).
- Test: `integration-live-reads.test.tsx` › «a stored read whose operation is no longer readable is marked stale».
- No se descarta la lectura en silencio al abrir el diálogo: el PATCH sigue rechazándola con 400 (comportamiento de R2), ahora con la causa visible en la fila.

### Deuda anotada (no implementada)
- **5** `evidence.ts:42`: la evidencia previa es cualquier llamada `ok` de turnos anteriores aunque ese turno acabase en traspaso o fallo de envío; la premisa de D4 («el cliente vio las alternativas») no queda garantizada. Riesgo acotado; decisión del humano.
- **6** `loop.ts:190`: si una key de `requires_prior` no está en el toolset (desactivada o fuera del tope de 20), la herramienta protegida queda bloqueada siempre y la pista nombra una key no invocable. Fallo seguro.
- **10** `live.ts`: sin deduplicación en vuelo; turnos simultáneos con caché fría llaman todos a la integración. El spec no lo pide.
- **12** `policy.ts:101`: `POLICY_KEY_RE` duplica `OPERATION_KEY_RE` (ya declarada).

### Compuerta ronda 2 (desde el worktree, `TZ=UTC`)
| Comando | Resultado |
|---|---|
| `npx eslint` sobre los archivos tocados | 0 errores (solo «file ignored» de los JSON) |
| `npm run lint` | 0 errores, 34 warnings preexistentes |
| `npm run typecheck` | OK |
| `vitest run src/lib/ai/tools/ src/components/settings/` (dirigido) | 14 + 10 archivos ok; 255 + 135 tests ok |
| `TZ=UTC npm test` (suite completa, una vez) | 377 archivos ok / 1 skipped; 5968 tests ok / 7 skipped |
| `npm run build` (vars dummy) | OK |
| SQL / migraciones | sin cambios en esta ronda (no se re-ejecutó replay) |

CHANGELOG (Unreleased, bloque n13.7): una línea nueva con los tres cambios visibles. Sin variables de entorno nuevas ni dependencias.

## Integración con n15.1

`git merge main` (main @ 17014ca, n15.1 `ai-voice-notes`) en `feat/ai-grounded-availability` (6c1c185). Commit de merge: `4257fcc`. Sin commit de ajuste.

### Conflictos y resolución

| Archivo | Resolución |
|---|---|
| `CHANGELOG.md` | Ambas secciones en Unreleased: primero n13.7 (095), luego n15.1 (096). |
| `supabase/ci/verify-schema.sql` | Bloque 095 seguido del bloque 096, sin cambios en ninguno. |
| `src/lib/ai/defaults.ts` | `buildSystemPrompt` acepta `liveData?` y `voiceNotes?` (ambos opcionales); sin ellos el prompt es idéntico. El párrafo de voz va tras las pautas; la sección de datos en vivo, tras las herramientas. |
| `src/lib/ai/auto-reply.ts` | Imports de ambas ramas. Orden: reserva → transcripción/`sendVoiceFallback` → contexto (`withVoiceTurn`) → límite por cuenta → conocimiento → toolset → `loadLiveData` → prompt (`now`, `liveData`, `voiceNotes`) → `generateReply` con `grounding`. El contexto se construye antes del límite, como ya hacía main; no se reordenó. |
| `src/app/api/ai/playground/route.ts` | Imports de ambas (`loadLiveData`, `readTrail`, `LiveDataBlock`, `formatVoiceNote`); prompt con `now`, `liveData` y `voiceNotes`; los turnos `voice` se mapean como en n15.1 y `grounding.priorEvidence` sigue leyendo `body.trail`. |
| `src/app/api/ai/draft/route.ts` | Prompt con `now`, `liveData` y `voiceNotes`. |
| `src/components/agents/ai-playground.tsx` | El cuerpo envía `messages: playgroundRequestMessages(next)` (con `voice`) y `trail` de los turnos anteriores. |

Fusionados sin conflicto y revisados: `src/lib/ai/types.ts`, `src/lib/ai/generate.ts` (solo añadidos de n13.7 frente a main), `src/lib/ai/context.ts` (sin cambios frente a main; su aviso de prettier ya existe en main), `messages/{es,en}.json` (sin claves duplicadas; el test de paridad pasa).

### Compuerta (desde el worktree, tras el merge)

- `npm run lint`: 0 errores, 34 avisos (preexistentes).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 391 archivos pasan, 1 omitido; 6115 tests pasan, 7 omitidos, 0 fallos.
- `npm run build` con las variables ficticias: OK.
- `scripts/replay-migrations.sh <worktree>`: salida 0; 095 y 096 aplican y `verify-schema.sql: OK`.
