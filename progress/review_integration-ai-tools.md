# Review — n13.3 integration-ai-tools

**Veredicto:** CHANGES_REQUESTED

Rama `feat/integration-ai-tools`, 14 commits `fd4ce95..4fd75f0` (97a09d8 spec + los 13 del informe). Nota: `main`
ya avanzó a 69d67dd (n13.5 fusionada); los diffs se leyeron contra la base `fd4ce95` / `main...HEAD`.

## Compuerta (ejecutada por el reviewer en el worktree)
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde, 359 archivos / 5386 tests
- build (variables dummy): verde
- replay-migrations: verde (`094_integration_ai_tools.sql` ok, `verify-schema.sql: OK`)
- 094 reaplicada sobre base migrada: sin error (NOTICE «already exists, skipping»)
- `progress/checks_integration-ai-tools.sql`: `NOTICE: n13.3 checks passed` (ROLLBACK)
- Fusión de prueba con `main` actual (69d67dd, n13.5 dentro) en worktree temporal desechado: único conflicto
  `CHANGELOG.md` (previsto); tras él `tsc` verde y vitest 363 archivos / 5557 tests verdes. `remoteError` de
  n13.5 (`{code, message, field, requestId}`) lo lee bien `result.ts`; `in:'header'` queda fuera del esquema.

## Trazabilidad criterio ↔ test
- R1: [x] `src/lib/ai/tools/load.test.ts` › "loads the active operations…", "nothing when %s", "retired / inactive"
- R2: [x] `load.test.ts` › "a plan without integrations → nothing, without touching the tables (R2)"
- R3: [x] `load.test.ts` › "a database or plan error → nothing and one fixed console line (R3)"
- R4: [x] `src/lib/ai/tools/schema.test.ts` › "orders by integration sort/name then operation sort/key and caps at 20"
- R5: [x] `schema.test.ts` › "draft keeps only GET operations"; `load.test.ts` › "draft keeps only GET"; `draft/route.tools.test.ts` (modo `draft`)
- R6: [x] `schema.test.ts` › "uses <slug>__<key>…", "falls back to op<n>_<key>…", "every generated name matches the provider regex"
- R7: [x] `schema.test.ts` › "maps types, required, string enum and drops non-caller locations" (incl. `Idempotency-Key` `in:'header'`)
- R8: [x] `schema.test.ts` › "dotted names become nested objects…", "a clash between a and a.b…", "constructor or __proto__"
- R9: [x] `schema.test.ts` › "names integration and operation, adds Returns and marks writes", "never passes 1024 characters"
- R10: [x] `src/lib/ai/providers/anthropic.tools.test.ts` › tools/input_schema/tool_choice; tool_use + contenido íntegro (thinking); un único `user` con todos los `tool_result` e `is_error`. Contrastado con el skill `claude-api`: formato correcto; `tool_choice {type:'none'}` válido también en modelos que rechazan `any`/`tool`.
- R11: [x] `openai.tools.test.ts` › `tools[].function`, sin `parallel_tool_calls`, `tool_calls` con JSON inválido → `INVALID_ARGS`, reenvío del mensaje + un `role:'tool'` con `tool_call_id` por llamada
- R12: [x] `gemini.tools.test.ts` › tipos en mayúsculas / enum solo STRING; `functionDeclarations` y `AUTO`/`NONE`; `functionCall` con id o posicional; rol `model` forzado; reenvío con `thoughtSignature` y un único `user` de `functionResponse`
- R13: [x] los tres `*.tools.test.ts` › "stop_reason / finish_reason / finishReason %s runs no tools"
- R14: [x] `src/lib/ai/tools/loop.test.ts` › "an empty toolset takes the plain path (no toolsUsed)" (cuerpo sin `tools`); `generate.test.ts` sin cambios y verde
- R15: [x] `loop.test.ts` › "executes calls in order, one at a time, with source ai and the account" (comprueba concurrencia 1)
- R16: [x] `src/lib/ai/tools/args.test.ts` (5 casos)
- R17: [x] `loop.test.ts` › "unknown tool and invalid arguments answer an error without the executor"
- R18: [x] `loop.test.ts` › "after 5 rounds… 6th is final with toolChoice none", "the 9th call gets limit_reached…"
- R19: [x] `loop.test.ts` › "past the 40 s budget…", "AI_TOOL_BUDGET_MS changes the budget"
- R20: [x] `loop.test.ts` › "only the last round text is the answer", "[[HANDOFF]] in the final round → handoff true"
- R21: [x] `loop.test.ts` › "an executor that throws gives the model an error payload and goes on"
- R22: [x] `loop.test.ts` › "a provider AiError in round 2 propagates (calls already ran)"
- R23: [x] `src/lib/ai/tools/result.test.ts` › paso directo < 8192 y truncado por bytes sin partir surrogates
- R24: [x] `result.test.ts` › invalid_params con problem/param, hints por status, `remoteError`/`error` cortados a 300
- R25: [x] `src/lib/ai/tools/prompt.test.ts` (offset, DST, UTC + local, reglas, handoff solo en auto_reply); `defaults.test.ts` orden de secciones
- R26: [x] `prompt.test.ts` › "labels the business instructions under the integration name (R26)"
- R27: [x] `defaults.test.ts` › "without tools the text is identical…"
- R28: [x] `src/lib/security/tenant-isolation.test.ts` › "(7, n13.3 a)", "(8, n13.3 b)" (fetch ve `Bearer CRED_A`, nunca `CRED_B`), "(9, n13.3 c)" (PATCH de A no toca la fila de B); `auto-reply.tools.test.ts` / `playground/route.tools.test.ts` (cuenta del webhook / sesión, `accountId` del cuerpo ignorado)
- R29: [x] `loop.test.ts` › "console never carries arguments…"; `tenant-isolation.test.ts` (8) revisa log/info/warn/error contra credenciales, argumento, dato y clave del proveedor
- R30: [x] `tenant-isolation.test.ts` (8) fila `integration_calls` `source:'ai'` cuenta A; SQL en `checks_integration-ai-tools.sql` ejecutado por mí
- R31: [x] SQL ejecutado por mí + bloque `-- 094` de `verify-schema.sql`
- R32: [x] `src/app/api/account/integrations/[integrationId]/route.test.ts` › describe "PATCH — AI settings" (200, parcial, 400 por campo y cuerpo vacío, 2000 exactos, 402, 404 x3, 403 agent/viewer/soporte) + "PUT keeps the AI settings"
- R33: [x] `src/app/api/account/integrations/route.test.ts` › "carries the AI settings…", "a deactivated integration reports false/null…"
- R34: [x] `src/components/settings/integration-ai-controls.test.tsx` (es/en, off/on, deshabilitado, no activada, tarjetas de `IntegrationsSettings`)
- R35: [x] `playground/route.tools.test.ts` › "…returns toolsUsed"; `src/components/agents/ai-tools-used.test.tsx` (✓/✗, `aria-label`, aviso)
- R36: [ ] **parcial**. La ruta sí: `draft/route.tools.test.ts` › "…returns toolsUsed". La mitad de UI («el compositor debe indicar con un aviso qué herramientas se consultaron») no tiene test: el filtro + formato + `toast.info` están en línea en `src/components/inbox/message-composer.tsx:284-297` y ningún test lo ejecuta. `tasks.md` T10 declara R36 cubierto por `integration-ai-controls.test.tsx` y `ai-tools-used.test.tsx`, pero ninguno toca el compositor.
- R37: [x] `loop.test.ts` › "sums usage over all rounds; null when none reported"; `auto-reply.tools.test.ts` › "logs ONE ai_usage_log row…"
- R38: [x] `generate.test.ts`, `auto-reply.test.ts`, `playground/route.test.ts` sin cambios (`git diff main...HEAD` vacío) y verdes; casos "without tools… exactly {config, systemPrompt, messages}"
- R39: [x] `src/i18n/messages.test.ts` (paridad) verde; claves nuevas en `es` y `en`
- R40: [x] compuerta arriba; CHANGELOG
- R41: [x] guion manual en el informe (§ «Verificación manual pendiente»), coincide con design §12. Pendiente de ejecutar por el humano.

## Checkpoints
- CP1 Compuerta: [x] verde, ejecutada por mí
- CP2 Migraciones: [x] 094 idempotente (`ADD COLUMN IF NOT EXISTS`, CHECK con guarda), aserciones en `verify-schema.sql`, replay 0, sin CASCADE, RLS intacta
- CP3 Aislamiento: [x] `load.ts` filtra `account_integrations` por `account_id`; `updateAccountIntegrationAi` por `account_id` + `integration_id` + `is_enabled`; catálogo global leído por id (waiver n13.1); tests de fuga (7)(8)(9)
- CP4 Tests: [ ] R36 (UI del compositor) sin test — ver arriba
- CP5 Sin dependencias: [x] `package.json`/lock sin cambios
- CP6 i18n: [x] `Settings.integrations.ai*`, `AiTools.*`, `Inbox.composer.draftUsedTools` en es y en con mismos placeholders
- CP7 Next 16: [x] `PATCH(request, { params })` con `params: Promise` según `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`
- CP8 Alcance: [x] archivos = design §13 (+ `ai-tools-used`, `integration-ai-controls`, `tools-test-support.ts`, `docs/docker.md`); `src/lib/integrations/{types,request,http,execute,catalog-validate}.ts` intactos (coordinación n13.5); el commit 2e78ed2 es solo prettier sobre archivos que la feature toca
- CP9 Documentación: [x] CHANGELOG (Unreleased), `AI_TOOL_BUDGET_MS` en `docs/docker.md`, informe coincide con el diff. `.env.local.example` sin la variable (bloqueado al implementer; añadir a mano)
- CP10 Git: [x] commits en español con prefijo y `Co-Authored-By`; sin push
- CP11 Entrante: [x] la carga de herramientas corre después de guardar el entrante y nunca lanza

## Hallazgos (archivo:línea)
1. `src/components/inbox/message-composer.tsx:284-297` — lógica de R36 (filtro de `toolsUsed`, formato `integración · operación`, `toast.info`) sin test. Duplica además el type-guard de `readToolsUsed` de `src/components/agents/ai-playground.tsx:27`.

Observaciones (no bloquean; riesgos de diseño o del spec aprobado, para el humano):
2. `src/lib/ai/auto-reply.ts:251` vs `:367` — con herramientas de escritura, la ejecución ocurre en `generateReply`, antes de `claim_ai_reply_slot`. Hay chequeo previo del tope (`:145`), así que solo afecta a la carrera entre dos entrantes simultáneos o a un `AiError` en una vuelta posterior (R22, aceptado): la escritura queda hecha y el cliente sin respuesta.
3. `src/lib/ai/auto-reply.ts:192` — la reserva es por mensaje entrante: dos mensajes seguidos («sí» y «confírmalo») lanzan dos bucles sobre el mismo transcript y ambos pueden ejecutar la misma escritura. Antes de n13.3 un doble despacho solo duplicaba texto. Conviene que el humano lo valore (idempotencia en la integración o serializar por conversación) en el guion R41.
4. `src/lib/integrations/account.ts` — desactivar no resetea `ai_enabled`; al reactivar, la IA recupera las herramientas. Es lo que fija el design §8 («`disableAccountIntegration` tampoco las borra») y la UI lo muestra encendido tras reactivar; anotado por si el humano prefiere resetearlo (D1).
5. `src/app/api/ai/playground/route.ts` — el playground es `agent+` y ejecuta escrituras reales con un transcript que manda el cliente (el «sí» del cliente se puede fabricar). Coherente con el spec (R35 + aviso), pero un `agent` puede escribir en la integración sin pasar por admin.
6. `src/lib/ai/tools/loop.ts:126-132` — si una vuelta posterior lanza, el uso de las vueltas previas no se registra en `ai_usage_log` (tokens consumidos sin medir).
7. `src/lib/ai/tools/args.ts:11` vs `schema.ts` — `flattenToolArgs` corta a 4 niveles (R16) y `buildParameterSchema` anida sin límite (R8): un parámetro de 5+ segmentos se ofrece pero nunca valida. Inconsistencia del propio spec; ningún catálogo actual lo usa.
8. `src/lib/ai/tools/schema.ts:41` — `callerSideParams` duplica `callerParams` que n13.5 ya exporta en `src/lib/integrations/request.ts:58`; fue intencional (coordinación), se puede unificar tras fusionar.

## Cambios requeridos
1. Cubrir R36 (UI): extraer a una función pura exportada (p. ej. `formatToolsUsed(raw: unknown): string` junto a `readToolsUsed`, en `src/components/agents/ai-tools-used.tsx` o `src/lib/ai/tools/`) el filtro y el formato que hoy están en `message-composer.tsx:284-297`; que el compositor la use para `toast.info(t('draftUsedTools', { tools }))` solo si el resultado no está vacío, y que `ai-playground.tsx` reutilice el mismo guard. Test vitest: lista válida → `"Health · search, Health · list"`, entradas mal formadas descartadas, vacío / no-array → `''` (sin toast). Actualizar la fila R36 del informe.

## Ronda 2

**Veredicto:** APPROVED

Commits `4fd75f0..HEAD`: `43cff17` (merge de main 69d67dd), `b323aea`, `9e8bdf6`, `a5c7617`.

### Compuerta (ejecutada por el reviewer en el worktree)
- lint: verde (0 errores) · typecheck: verde · `TZ=UTC npm test`: 364 archivos / 5571 tests verdes (1 archivo / 7 tests skipped, los `live` de n13.5) · build (dummy): verde
- replay-migrations: verde (`094` ok, `verify-schema.sql: OK`)

### Merge con main
- `git merge-base main HEAD` = `69d67dd` = `main`: la rama contiene main entera.
- `git diff main...HEAD -- src/lib/integrations/` solo toca `account.ts` (lo de n13.3, R32/R33); `types/request/http/execute/catalog-validate.ts` iguales a main. `package.json`/lock, `generate.test.ts`, `auto-reply.test.ts`, `playground/route.test.ts` sin cambios.
- `CHANGELOG.md` sin marcadores de conflicto; árbol limpio.

### Cambio requerido de la ronda 1
- R36 UI: [x] `src/lib/ai/tools/tools-used.test.ts` › "formats a valid list", "drops malformed entries", "empty / not an array → \"\" (no toast)". `message-composer.tsx:286-287` solo llama `formatToolsUsed` y lanza el toast si no es vacío; `ai-playground.tsx` reutiliza `readToolsUsed` (guard único).

### Hallazgos atendidos
- 6 (uso perdido): [x] `AiError.usage`; `loop.ts:142-146` suma el uso previo antes de relanzar. Tests: `loop.test.ts` › "a provider AiError after earlier rounds carries their usage"; `auto-reply.tools.test.ts`, `playground/route.tools.test.ts`, `draft/route.tools.test.ts` › "a failed later tool round still logs…". Sin herramientas `usage` queda `null` → el catch no registra nada; R22/R38 intactos.
- 7 (profundidad): [x] `schema.ts` no ofrece parámetros de más de `MAX_ARG_DEPTH` (opcional fuera, requerido → operación fuera), `console.warn` sin datos. Test en `schema.test.ts`.
- 8 (duplicados con n13.5): [x] `schema.ts` usa `callerParams` (excluye `in:'header'` y `auto`), `result.ts` lee `result.remoteError` tipado. Test en `result.test.ts`.

### Pendiente del humano (no exigido)
- Hallazgos 2–5 de la ronda 1 (escritura antes del slot, doble despacho por mensaje, `ai_enabled` tras reactivar, playground `agent+` con escrituras).
- R41: guion manual con los tres proveedores. `AI_TOOL_BUDGET_MS` en `.env.local.example` a mano.
