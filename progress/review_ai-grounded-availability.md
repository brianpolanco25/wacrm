# Review — n13.7 ai-grounded-availability

**Veredicto:** CHANGES_REQUESTED

Rama `feat/ai-grounded-availability` (base `main @ 2799b6b`, commits `188e756`, `e274d0b`), worktree
`.claude/worktrees/ai-grounded-availability`. 58 archivos, el diff coincide con el informe
(`progress/impl_ai-grounded-availability.md`) y con la lista de design §15.

## Compuerta (ejecutada por el reviewer desde el worktree)
- lint: verde (0 errores, 34 warnings; ninguno en archivos del diff)
- typecheck: verde
- `TZ=UTC npm test`: verde — 377 archivos ok / 1 skipped; 5927 tests ok / 7 skipped
- build (vars dummy de `docs/harness.md`): verde
- replay-migrations (`scripts/replay-migrations.sh <worktree>`): verde, `095_ai_grounding.sql ok`, `verify-schema.sql: OK`
- 095 reaplicada sobre la base ya migrada: todo `already exists, skipping` + `verify-schema` OK (idempotente)
- `progress/checks_ai-grounded-availability.sql` contra el contenedor: 8/8 `ok` (R1 ×4, R22 ×2, R27 ×2), ROLLBACK

## Desviaciones declaradas
1. **`GenerateArgs.grounding` en vez de dentro de `tools`** (`src/lib/ai/generate.ts:30-37,58`): ACEPTADA.
   Mismos campos (`mode`, `liveData`, `priorEvidence`, `conversationId`), mismo destino (`runToolLoop`),
   solo cambia el contenedor. Permite que los `toEqual({toolset, db, accountId})` existentes de los tres
   llamadores sigan sin tocar (R42). Sin `tools`, `grounding` se ignora (camino plano intacto, R14 de n13.3).
2. **Ampliación de `src/app/api/account/integrations/route.test.ts` › «returns the exact shape»**: ACEPTADA.
   Diff solo aditivo (+17, 0 líneas borradas): añade `aiLiveReads: []` y `aiReadOperations`. Es el
   mismo caso que R42 contempla (test de forma exacta que se amplía, no se reescribe) y el precedente
   de n13.3. Único otro test existente tocado: `tools-used.test.ts` (solo el `import`).

## Trazabilidad criterio ↔ test (leídos)
- A1/R1 «ai_live_reads jsonb ≤3»: [x] [SQL] checks R1 ×4 (ejecutado) + `verify-schema.sql` bloque 095
- R2/R3 «400 field aiLiveReads»: [x] `[integrationId]/route.test.ts` › «400 field aiLiveReads for %s, nothing stored» (11 casos: no lista, 4, sin operation, desconocida, inactiva, POST, param no declarado, requerido ausente, tipo, `{{now}}`, `+61d`); `live-templates.test.ts`
- R4 «plantillas en la zona»: [x] `live-templates.test.ts` (zona, UTC con null, fin de mes, DST, embebida)
- R5: [x] route › «R5: null and [] store []»
- R6: [x] route › «stores a valid list unresolved and answers aiLiveReads and aiReadOperations» (incluye enum) + test de forma ampliado
- R7: [x] `integration-live-reads.test.tsx` (3 → Añadir deshabilitado, tipos de campo, error 400 en línea, cuerpo del PATCH)
- R8/CP6: [x] claves `aiLive*` y `AiTools.toolBlocked` en es y en; test de paridad existente las cubre
- R9: [x] `live.test.ts` › «R9: runs with source ai, preload, the conversation and the templates resolved in the zone» (`source:'ai'`, `preload:true`, fechas resueltas en America/Santo_Domingo); llamadores en `auto-reply.live.test.ts`, `playground/route.live.test.ts`, `draft/route.live.test.ts`
- R10: [x] `auto-reply.live.test.ts` › «R10: a lost claim → no live reads», «R10: over the per-account limit → no live reads» (orden confirmado en `auto-reply.ts:193,217,239,249`)
- R11/R12 «caché 60 s / 10 s»: [x] `live.test.ts` › «R11: … at 60 001 ms → another», «AI_LIVE_DATA_TTL_MS overrides», «R12: a failure is remembered 10 s and retried after»
- R13: [x] `live.test.ts` › invalidación solo de esa cuenta+integración; `loop.grounding.test.ts` › «R13: a write ok invalidates…»
- R14 «sin cruce entre cuentas, tope 500»: [x] `live.test.ts` › «R14: account A never reuses the entry of B», «past 500 entries the oldest is evicted». Clave `account\0slug\0op\0stableJson(params)` (`live.ts:54-61`)
- R15: [x] `live.test.ts` › execute que lanza → bloque fallido; consola sin params ni datos; `load.test.ts` basura → sin lecturas
- R16–R21 (A2) «bloque ≤6000 bytes, ÚNICOS, fallo prohíbe días/horas»: [x] `live-render.test.ts` (prompt idéntico sin liveData, agrupado por día local con 23:30Z, vacío/truncated, corte por días/líneas/puntos de código, regla ONLY, fallo con HANDOFF solo en auto_reply)
- R22: [x] [SQL] checks R22 ×2
- R23: [x] `policy.test.ts`, `catalog-validate.test.ts` › «validateOperationInput: ai_policy»
- R24: [x] `cabbity-health.test.ts` (6 operaciones `schedule`, `cancel_appointment.requires_prior`, todas pasan `validateOperationInput`); comprobado además cargando el catálogo con `node` plano (sin alias)
- R25 «bootstrap sincroniza ai_policy sin romper n13.8»: [x] `bootstrap.test.ts` › fila sin política (pre-095) la gana; política igual → sin cambios; definición sin política → `null`. Las descripciones/`normalize` de n13.8 no se tocan salvo la frase de `cancel_appointment` prevista en design §11
- R26: [x] `schema.test.ts` (política fuera del JSON schema, frase final, corte antes de la frase)
- R27: [x] [SQL] FK SET NULL + default; `execute.test.ts` › «records conversation_id and ai_preload when given», «without them the row is the one of before»
- R28 «evidencia una vez, solo turnos previos, 24 h, sin preload»: [x] `evidence.test.ts` › «only ok AI calls of this account and conversation in 24 h, not live reads, in order» (afirma los 6 filtros); `loop.grounding.test.ts` › «evidence is loaded once per turn and calls of THIS turn never count»
- R29: [x] `policy.test.ts` › checkRequiresPrior (orden, alternativas, orden inverso, otra integración)
- R30 «bloqueo sin ejecutar ni registrar»: [x] `loop.grounding.test.ts` › «cancel without prior evidence → policy_requires_prior, no execute, blocked in toolsUsed» (execute no llamado ⇒ no hay fila)
- R31: [x] `evidence.test.ts` › «R31: a database error → []»; loop › «evidence loader that throws → empty evidence (blocked)»
- R32: [x] `tools-used.test.ts` (readTrail/trailFromToolsUsed), `playground/route.live.test.ts` › trail válido / >50; loop › «the playground priorEvidence replaces the database»
- R33: [x] `execute.test.ts` › «R33: a flow runs an operation with ai_policy.requires_prior»
- R34 «fuga entre cuentas»: [x] `evidence.test.ts` › «R34: two accounts sharing a fake conversation_id never mix»
- R35: [~] `grounding.test.ts` positivos/negativos es/en — cubre los formatos que R35 enumera, pero faltan negativos de falsos positivos reales (ver C1)
- R36: [x] loop › «with a live read ok → no extra round», «a failed live read does not ground», «a find_availability ok earlier in the turn grounds the text»
- R37/R38 (D7): [x] loop › «one extra round with the note and toolChoice auto», «extra round calls find_availability ok → its text», «if it insists → [[HANDOFF]] … warn without the text», «through generateReply the handoff is a real handoff» (fetch stubbed), «AI_TOOL_MAX_CALLS reached → straight handoff»
- R39: [x] loop › «R39: draft mode → no guard»
- R40: [x] loop › «R40: a toolset without grounds behaves as before» + `loop.test.ts` existente sin tocar
- R41: [x] loop › «R41: … toolChoice auto or none»; adaptadores de proveedor sin cambios
- R42: [x] suite completa verde; solo la ampliación aceptada arriba
- R43 [M]: [x] guion manual en el informe (pasos 1–6), pendiente de ejecución por el humano

## Puntos de insistencia
- D5: lecturas en vivo con `preload:true` → `ai_preload=true` (`live.ts:162-170`, `execute.ts`); la evidencia filtra `.eq('ai_preload', false)` (`evidence.ts:41`); `trailFromToolsUsed` nunca ve lecturas en vivo. OK.
- D6: evidencia = `outcome='ok'`, sin mirar el cuerpo (`evidence.ts:42`). OK.
- D7: la guardia no actúa con lectura en vivo `ok` de una operación `schedule` (`loop.ts` `grounded` inicial). OK.
- `requires_prior` antes de ejecutar y con evidencia estática del inicio del turno (no se añade la del turno actual). OK.
- Ningún test hace red: execute inyectado/mockeado; el único `fetch` está con `vi.stubGlobal`.

## Checkpoints
- CP1: [x] compuerta verde ejecutada por el reviewer
- CP2: [x] 095 idempotente (reaplicada), CHECK con guarda, aserciones en verify-schema, replay 0, FK `ON DELETE SET NULL` (sin CASCADE)
- CP3: [x] `integration_calls` (`evidence.ts:38`), `account_integrations` (`load.ts`, `account.ts` zona/update) filtran `account_id`; catálogo global por id (waiver n13.1). Tests de fuga: R34 y R14
- CP4: [x] todos los R con test leído; SQL ejecutado; guion manual R43
- CP5: [x] `package.json` / lock sin cambios
- CP6: [x] es/en con mismas claves y placeholders (`{max}`, `{error}`; `'{{today}}'` escapado ICU)
- CP7: [x] sin APIs de framework nuevas; firma de Route Handler sin cambios
- CP8: [x] archivos = design §15
- CP9: [x] CHANGELOG (Unreleased, «Migration required: 095»), `AI_LIVE_DATA_TTL_MS` en `docs/docker.md`, informe coincide con el diff
- CP10: [x] 2 commits en español con prefijo y `Co-Authored-By`; nada pusheado
- CP11: [x] no toca la ingesta del webhook

## Hallazgos bloqueantes (verificados por el reviewer)
1. `src/lib/ai/tools/grounding.ts:273` — el patrón de días de la semana casa `domingo` dentro de **«Santo Domingo»**. Comprobado: `mentionsSchedule('Estamos en la Av. Churchill, Santo Domingo.') === true`. El cliente objetivo (Rehactive, zona `America/Santo_Domingo`) da la dirección a menudo: sin lectura en vivo configurada (todo el periodo entre desplegar y configurarla) o con la lectura fallida, cada respuesta con la ciudad → vuelta correctiva → `[[HANDOFF]]`. No es el falso positivo aceptado en D7 (horarios de apertura), es uno nuevo y diario.
2. `src/lib/ai/tools/grounding.ts:269` — la hora `HH.MM` casa precios con prefijo de moneda y espacio: `'La consulta cuesta RD$ 15.00'` y `'Cuesta US$ 2.50'` → `true` (comprobado). El lookbehind solo excluye `$` pegado. Mismo efecto: traspaso de respuestas de precio.
3. `src/lib/ai/tools/live.ts:117-170` (y `load.ts:143`) — la regla «solo `GET`» de las lecturas en vivo se comprueba únicamente al guardar (`validateLiveReads` en el PATCH). En tiempo de ejecución `readStoredLiveReads` + `loadLiveData` ejecutan la operación guardada con el método que tenga HOY. Si el catálogo cambia esa operación a `POST`/`DELETE` (panel de plataforma n13.1 o bootstrap) o la desactiva, el sistema dispara una escritura contra el sistema del cliente **antes de cada mensaje entrante**, sin que el modelo lo decida.

## Cambios requeridos
1. `grounding.ts`: no contar `domingo` en «Santo Domingo» (p. ej. lookbehind `(?<!sant[oa]\s)` sobre los días, que cubre también «Santo Domingo Este/Norte»), y no tratar como hora un `N.NN` precedido de símbolo/código de moneda con o sin espacio (`RD$ 15.00`, `US$ 2.50`, `$ 3.50`). Añadir esos casos a los negativos de `grounding.test.ts` (y uno de loop: dirección con «Santo Domingo» sin datos → sin vuelta extra).
2. Ejecutar en vivo solo lecturas cuya operación siga **activa y `GET`** en el momento del turno: filtrar en `load.ts` contra las operaciones que ya carga (método e `is_active`) o comprobarlo en `loadLiveData`; si no cumple, se omite (o bloque fallido) sin llamar a `execute`. Test: lectura guardada sobre una operación hoy `POST` → `execute` no se llama.

## Hallazgos no bloqueantes (del code-review `high` contrastado y de la revisión manual)
4. `grounding.ts` — R35 no detecta la forma española más común sin minutos: «a las 4», «a las 10 de la mañana», «3 de la tarde» (comprobado: `'Le agendo mañana a las 4 de la tarde'` → `false`). Cumple R35 tal como está escrito, pero deja pasar el caso que motivó la feature. Recomendado añadirlo ahora junto a C1; si no, que el líder lo eleve al humano como ampliación de spec.
5. `src/lib/ai/tools/evidence.ts:42` — la evidencia es cualquier llamada `ok` de turnos anteriores, aunque ese turno terminase en traspaso o fallo de envío y el cliente nunca viera las alternativas. La premisa de D4 («hubo al menos un mensaje al cliente») no se garantiza en ese caso. Riesgo acotado (tras traspaso suele atender un humano); a valorar por el humano.
6. `src/lib/ai/tools/loop.ts:190` — si una key de `requires_prior` no está en el toolset (desactivada o fuera del tope de 20), la herramienta protegida queda bloqueada siempre y la pista nombra una key no invocable. Fallo seguro; anotar.
7. `src/app/api/ai/playground/route.ts:149` — el `trail` del playground es falsificable por el cliente; aceptado explícitamente en design §12 (solo afecta al playground de la propia cuenta). Sin acción.
8. `src/app/api/account/integrations/[integrationId]/route.test.ts:597` — el test de «zona de ESTA cuenta» solo afirma filtros; no siembra una fila de la cuenta B con otra zona. El código es correcto.
9. `src/components/agents/ai-playground.tsx:56` — el envío del `trail` sin test de componente (lógica cubierta por `trailFromToolsUsed` y la ruta).
10. `src/lib/ai/tools/live.ts:154-176` — sin deduplicación en vuelo: turnos simultáneos con caché fría llaman todos a la integración. No lo pide el spec.
11. `src/components/settings/integrations-settings.tsx:87` — el diálogo siempre envía `aiLiveReads`; una lectura obsoleta (operación desactivada) impide guardar solo instrucciones/zona hasta quitarla. Con C2 conviene que la vista marque o descarte esas lecturas.
12. `src/lib/ai/tools/policy.ts:101` — `POLICY_KEY_RE` duplica `OPERATION_KEY_RE` (deuda declarada).

## Pendiente del humano
- R43: guion manual (informe, sección «Verificación manual pendiente»).
- Tras desplegar: aplicar 095 en remoto ANTES de correr el bootstrap (el bootstrap escribe `ai_policy`).

---

## Ronda 2 — commit `6c1c185`

**Veredicto:** APPROVED

### Compuerta (worktree `.claude/worktrees/ai-grounded-availability`, ejecutada por el revisor)
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde — 377 archivos / 5968 tests ok (1 archivo y 7 tests skipped)
- build (vars dummy): verde
- replay-migrations: n/a (la ronda 2 no toca SQL; la 095 ya se validó en la ronda 1)

### Cambio requerido 1 — falsos positivos (`src/lib/ai/tools/grounding.ts`): [x] resuelto
Ejecuté `mentionsSchedule` sobre una copia de `grounding.ts` (node con type stripping):
- `false`: «Santo Domingo», «Santo Domingo Este», «Sto. Domingo», «sto domingo», «RD$ 15.00», «RD$15.00», «US$ 2.50», «$ 3.50», «USD 15.00», «€10.30», «Cuesta RD$ 1,500.00».
- `true` todavía: «nos vemos el domingo en Santo Domingo», «santo domingo norte, el lunes», «Domingo».
- Tests: `grounding.test.ts` › «negative: %s» (Santo Domingo ×5, moneda ×8) y `loop.grounding.test.ts` › «ronda 2: no schedule claim without data → no extra round (%s)» (una sola llamada al proveedor, `grounding` indefinido). Leídos.

### Cambio requerido 2 — lecturas en vivo revalidadas en ejecución (`src/lib/ai/tools/load.ts:112-163`): [x] resuelto
- `liveReadable` se construye solo con operaciones `is_active` (filtro en la consulta y en el bucle) y `method === 'GET'`. `readStoredLiveReads(...)` se filtra contra ese conjunto por `integration_id + key`, así que no queda ninguna ruta hacia `execute` desde una lectura obsoleta. La consulta es del catálogo global (waiver n13.1); las activaciones siguen filtradas por cuenta, como en la ronda 1.
- Tests (`load.test.ts`): «a stored live read over %s is skipped and execute is never called» ×3 (hoy `POST`, inactiva, inexistente) con carga real sobre `FakeDatabase` + `loadLiveData` y un espía de `execute`: lo llama 1 vez (solo `list_doctors`), nunca con la `operationKey` obsoleta, y emite el warn. «…only operation is POST today → no live reads at all»: `liveReads` indefinido, bloques `[]`, `execute` sin llamar. Leídos; prueban lo que dicen.
- Extra (no bloqueante 11 de la ronda 1): la fila obsoleta se marca en Ajustes (`integration-live-reads.tsx:237`). La clave `aiLiveStale` existe en `es.json` y `en.json`. Test: `integration-live-reads.test.tsx` › «a stored read whose operation is no longer readable is marked stale».

### Hallazgo 4 (líder) — horas sin minutos: [x] resuelto
- `true`: «a las 4 de la tarde», «a las 10 de la mañana», «a la 1», «a las 4», «a las 4?», «a las 9 y 30», «abrimos a las 8», «a las 12», «a las 16 horas», «la 1 de la tarde», «llegue a las 4 o 5».
- `false` (correcto): «a las 3 personas», «a las 2 mascotas», «a las 3 cuadras», «visita a las 2 sucursales», «2 de 3 citas», «a las 3 de 5», «Plan de 2 a 3 meses», «sesión de 1 hora».
- Las fechas siguen contando: «4 de noviembre» y «el 4 de noviembre» → `true`.
- Tests: `grounding.test.ts` › «positive: %s» (+16) y negativos; `loop.grounding.test.ts` › «ronda 2: «a las 4 de la tarde» without data → one extra round» (`seen` = 2, `grounding` = `'retried'`). Leídos.

### Falsos positivos o negativos residuales de los patrones nuevos (no bloqueantes)
1. `grounding.ts:60` — la moneda solo se reconoce **delante** del importe: «Total: 2.50 USD» y «precio 12.30 dolares» → `true`. Un `15.00` suelto también da `true` (está documentado). El coste es una vuelta correctiva de más, nunca un traspaso indebido.
2. `grounding.ts:87` — exige «a la(s)» o «de la tarde» para detectar la hora: «son las 4» y «a eso de las 4» → `false`. Es un falso negativo de una afirmación de agenda. Es raro en una oferta de cita, y la regla del prompt sigue vigente.
3. «at 4» en inglés sin am/pm → `false`. No se pidió.

### Deuda que sigue abierta (de la ronda 1; decide el humano)
Los puntos 5, 6, 10 y 12 están anotados en `impl_ai-grounded-availability.md` y no bloquean.
