# impl n13.3 `integration-ai-tools`

Estado: **done, ronda 2** (pendiente de reviewer). Rama `feat/integration-ai-tools`, worktree
`.claude/worktrees/integration-ai-tools`. Sin push.

## Plan (de `specs/integration-ai-tools/tasks.md`)

1. T1 Migración 094 + verify-schema + checks SQL (replay x2).
2. T2 `src/lib/ai/tools/{types,schema}.ts` + test.
3. T3 `args.ts`, `result.ts` + tests.
4. T4 `prompt.ts` + `buildSystemPrompt(tools, now)` + tests.
5. T5 adaptadores `generate<X>WithTools` + `shared.ts` + tests.
6. T6 `loop.ts` + rama de `generateReply` + test.
7. T7 `load.ts` + test.
8. T8 llamadores (auto-reply, playground, draft) + tests nuevos.
9. T9 PATCH ajustes IA + vista + tests.
10. T10 UI (controles IA, línea «Usó», aviso, toast) + i18n + tests.
11. T11 CP3 en tenant-isolation.
12. T12 guion manual. T13 compuerta + CHANGELOG.

Coordinación n13.5: no se tocan `src/lib/integrations/{types,request,http,execute,catalog-validate}.ts`.

## Commits (main..HEAD)

| Commit | Qué |
|---|---|
| 2e78ed2 | chore: prettier en `providers/{anthropic,openai,shared}.ts`, `generate.ts`, rutas playground/draft y `ai-playground.tsx` (solo formato, para que el diff de la feature sea legible) |
| 2f6df67 | feat: migración 094 + bloque `-- 094` en verify-schema |
| 0b61d5c | feat: `tools/{types,schema,args,result,prompt}.ts` + `buildSystemPrompt` |
| f4fe2f1 | feat: `generate{Anthropic,OpenAi,Gemini}WithTools` + tipos en `shared.ts` |
| 1d1daeb | feat: `tools/loop.ts` + rama de herramientas en `generateReply` |
| 26c09f0 | feat: `tools/load.ts` |
| 8397f01 | feat: auto-reply, playground y draft |
| b828b42 | feat: PATCH `/api/account/integrations/{id}` + vista con `aiEnabled/aiInstructions/aiTimezone` |
| 60978b9 | feat: UI de Ajustes, playground, compositor + i18n |
| 7695795 | test: CP3 en `tenant-isolation.test.ts` |
| 6ea70a2 | chore: deshace prettier colado en 3 archivos ajenos (incl. `playground/route.test.ts`, que R38 pide intacto); el diff neto contra main no los toca |
| 15b0852 | docs: CHANGELOG + `AI_TOOL_BUDGET_MS` en `docs/docker.md` |
| 4fd75f0 | docs: tasks.md marcadas |

## Criterio ↔ test

| Req | Archivo | `it` |
|---|---|---|
| R1 | `src/lib/ai/tools/load.test.ts` | «loads the active operations of the ai-enabled integrations of the account»; «nothing when %s» (ai off / deactivated / no credential); «nothing when the integration is retired or the operations inactive» |
| R2 | `load.test.ts` | «a plan without integrations → nothing, without touching the tables (R2)» |
| R3 | `load.test.ts` | «a database or plan error → nothing and one fixed console line (R3)» |
| R4 | `src/lib/ai/tools/schema.test.ts` | «orders by integration sort/name then operation sort/key and caps at 20» |
| R5 | `schema.test.ts` «draft keeps only GET operations»; `load.test.ts` «draft keeps only GET»; `src/app/api/ai/draft/route.tools.test.ts` «asks for draft-mode (GET-only) tools…» |
| R6 | `schema.test.ts` | «uses <slug>__<key>…», «falls back to op<n>_<key> on a collision or a name over 64», «every generated name matches the provider regex» |
| R7 | `schema.test.ts` | «maps types, required, string enum and drops non-caller locations» (incluye `in:'header'` omitido y enum sobre integer en la descripción), «declaredParams keeps only path/query/body» |
| R8 | `schema.test.ts` | «dotted names become nested objects with required propagated», «a clash between a and a.b…», «a param named constructor or __proto__ is just a property» |
| R9 | `schema.test.ts` | «names integration and operation, adds Returns and marks writes», «never passes 1024 characters» |
| R10 | `src/lib/ai/providers/anthropic.tools.test.ts` | «sends tools with input_schema and tool_choice», «parses tool_use blocks and keeps the whole assistant content», «replays the assistant turn untouched and all results in ONE user message» |
| R11 | `openai.tools.test.ts` | «sends function tools and tool_choice, no parallel_tool_calls», «parses tool_calls … invalid JSON arguments», «replays the assistant message as is and one role:tool message per call» |
| R12 | `gemini.tools.test.ts` | «upper-cases types, enum only on STRING…», «sends functionDeclarations (no parameters without props) and AUTO», «parses functionCall parts…», «forces role model…», «replays the model content with thoughtSignature…» |
| R13 | `anthropic.tools.test.ts` «stop_reason %s runs no tools»; `openai.tools.test.ts` «finish_reason %s runs no tools»; `gemini.tools.test.ts` «finishReason %s runs no tools» |
| R14 | `src/lib/ai/generate.test.ts` (existente, sin tocar, verde); `src/lib/ai/tools/loop.test.ts` «an empty toolset takes the plain path (no toolsUsed)» |
| R15 | `loop.test.ts` | «executes calls in order, one at a time, with source ai and the account» |
| R16 | `src/lib/ai/tools/args.test.ts` | los 5 casos (anidado, arrays hoja, 4 niveles, no-objeto, heredadas/`__proto__`) |
| R17 | `loop.test.ts` «unknown tool and invalid arguments answer an error without the executor»; `result.test.ts` «errorPayload %s» |
| R18 | `loop.test.ts` | «after 5 rounds with calls the 6th is final with toolChoice none», «the 9th call gets limit_reached and the next round is final» |
| R19 | `loop.test.ts` | «past the 40 s budget the next round is final», «AI_TOOL_BUDGET_MS changes the budget» |
| R20 | `loop.test.ts` | «only the last round text is the answer», «[[HANDOFF]] in the final round → handoff true, toolsUsed present» |
| R21 | `loop.test.ts` | «an executor that throws gives the model an error payload and goes on» |
| R22 | `loop.test.ts` | «a provider AiError in round 2 propagates (calls already ran)» |
| R23 | `src/lib/ai/tools/result.test.ts` | «passes data through under 8192 bytes», «truncates over 8192 bytes without splitting a character» |
| R24 | `result.test.ts` | «invalid_params adds problem and param…», «http_error hints by status», «%s has a fixed English hint», «carries the remote error of the executor (remoteError), cut to 300» |
| R25 | `src/lib/ai/tools/prompt.test.ts` | «gives local time with its offset», «follows daylight saving», «states UTC and the local time…», «carries the rules», «mentions the handoff only in auto_reply»; `defaults.test.ts` «adds the tools section after the business context and before the knowledge base» |
| R26 | `prompt.test.ts` | «labels the business instructions under the integration name (R26)», «ignores instructions of an integration without tools this turn» |
| R27 | `src/lib/ai/defaults.test.ts` | «without tools the text is identical to the call without the parameter» |
| R28 | `src/lib/security/tenant-isolation.test.ts` «(7, n13.3 a)…», «(8, n13.3 b)…», «(9, n13.3 c)…»; `auto-reply.tools.test.ts` «loads tools for the webhook account…»; `playground/route.tools.test.ts` «loads tools for the session account…» (cuerpo con `accountId: 'acct-B'` ignorado) |
| R29 | `loop.test.ts` «console never carries arguments, response bodies or result text (R29)»; `tenant-isolation.test.ts` (8) (busca CRED_A, CRED_B, argumento, dato y clave del proveedor en `console.log/info/warn/error`) |
| R30 | `tenant-isolation.test.ts` (8): fila de `integration_calls` con `source:'ai'`, `account_id` A; SQL en `progress/checks_integration-ai-tools.sql` |
| R31 | `progress/checks_integration-ai-tools.sql` + `supabase/ci/verify-schema.sql` bloque 094 |
| R32 | `src/app/api/account/integrations/[integrationId]/route.test.ts` describe «PATCH — AI settings (n13.3, R32)» (200 + vista, parcial y `''`→null, 400 por campo, cuerpo vacío, 2000 exactos, 402, 404 no activada/desactivada/solo de otra cuenta, 403 agent/viewer, 403 soporte) y «PUT keeps the AI settings (n13.3)» |
| R33 | `src/app/api/account/integrations/route.test.ts` | «carries the AI settings of this account (n13.3, R33)», «a deactivated integration reports false/null…», y la forma exacta ampliada |
| R34 | `src/components/settings/integration-ai-controls.test.tsx` | «[es/en] off…», «[es/en] on…», «read-only / no plan: everything disabled», «not rendered for an integration that is not activated», y los de `IntegrationsSettings` (solo tarjeta activada; read-only / no plan deshabilitado) |
| R35 | `playground/route.tools.test.ts` «loads tools … returns toolsUsed»; `src/components/agents/ai-tools-used.test.tsx` (✓/✗, `aria-label`, aviso del playground, es y en) |
| R36 | `draft/route.tools.test.ts` «…returns toolsUsed» (ruta); `src/lib/ai/tools/tools-used.test.ts` «formats a valid list», «drops malformed entries», «empty / not an array → "" (no toast)» — `formatToolsUsed` es lo único que decide el `toast.info` de `message-composer.tsx` (solo si no está vacío) |
| R37 | `loop.test.ts` «sums usage over all rounds; null when none reported»; `auto-reply.tools.test.ts` «logs ONE ai_usage_log row with the summed usage»; `playground/route.tools.test.ts` (una llamada a `logAiUsage` con la suma) |
| R38 | `generate.test.ts`, `auto-reply.test.ts`, `playground/route.test.ts` sin cambios contra main y verdes; casos «without tools … exactly {config, systemPrompt, messages}» en los tres `*.tools.test.ts` |
| R39 | `src/i18n/messages.test.ts` (paridad y no-idénticos) verde |
| R40 | compuerta abajo; CHANGELOG |
| R41 | manual, guion abajo |

## Compuerta (ejecutada en el worktree)

- `npm run lint`: 0 errores (34 warnings preexistentes; ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 359 archivos, 5386 tests, verde.
- `npm run build` con las variables dummy: verde.
- `scripts/replay-migrations.sh`: todas aplican, `verify-schema.sql: OK`.

## Verificación contra base real

`KEEP=1 scripts/replay-migrations.sh <worktree>` y luego:
- 094 reaplicada sobre la base ya migrada: sin error (NOTICE «already exists, skipping»).
- `progress/checks_integration-ai-tools.sql` → `NOTICE: n13.3 checks passed`: `ai_enabled`
  por defecto false y NOT NULL; 2000 caracteres caben y 2001 violan el CHECK; zona `''` y de 65
  violan; `integration_calls` admite `source='ai'` con el `account_id`; RLS activada y sin
  políticas. Todo en transacción con ROLLBACK.

## Verificación manual pendiente (R41) — guion para el humano

Requisitos: cuenta de prueba con plan que incluya `integrations`; una integración del catálogo
activada con credencial de pruebas, con una operación `GET` (buscar) y una `POST` (crear).
Migración 094 aplicada en el Supabase de destino.

1. Ajustes → Integraciones → en la tarjeta activada, encender «Usar en IA»; «Instrucciones para la
   IA»: zona `America/Santo_Domingo`, texto «Las citas duran 30 minutos». Guardar.
2. Para cada proveedor (Ajustes de IA: `anthropic`, `openai`, `gemini` con su modelo por defecto),
   en el playground: pedir algo que exija la operación `GET` → la respuesta trae el dato real y
   debajo «Usó: <integración> · <key> ✓».
3. Pedir la escritura → la IA resume los datos y pide confirmación **sin** llamar (no aparece
   «Usó» con la `POST`); contestar «sí» → «Usó: … create ✓» y en la integración existe el
   registro con la hora local correcta (offset −04:00).
4. SQL: `SELECT source, outcome FROM integration_calls WHERE account_id = '<cuenta>' ORDER BY
   created_at DESC LIMIT 5` → `source = 'ai'`; `ai_usage_log` tiene una fila por turno del
   playground (`mode = 'playground'`).
5. Bandeja: «Sugerir respuesta» en una conversación que pida un dato de la integración → toast «El
   borrador consultó: …» y nunca una escritura.
6. Apagar «Usar en IA» → la misma pregunta ya no produce «Usó».

## Decisiones donde el spec era ambiguo

- **Vista de Ajustes sin tocar `src/lib/integrations/types.ts`** (orden del líder por n13.5): los
  campos de IA viven en `AccountIntegrationAiFields` (`src/lib/ai/tools/types.ts`);
  `loadAccountIntegrations` devuelve `AccountIntegrationWithAi` (definido en `account.ts`) y la UI
  usa `IntegrationViewWithAi` con los campos opcionales para no romper fixtures existentes.
- **Parámetros del modelo**: tras fusionar n13.5, `callerParams` de `src/lib/integrations/request.ts`
  (sin `in:'header'` ni `auto`); la copia local se borró.
- **Error remoto (R24)**: tras fusionar n13.5 se lee `result.remoteError` ya tipado (`RemoteError`);
  se añade `error: { code?, message? }` al payload, cortados a 300 puntos de código.
  `field`/`requestId` no se pasan (el spec no los pide). El nombre `error` del spec era la
  previsión de n13.5; no hay otra fuente.
- **`invalid_params`**: `problem/param` se calculan con `validateCallParams` sobre los parámetros de
  llamada (path/query/body), igual que hará n13.5 con `callerParams`.
- **Nombres de herramienta**: el tope de 20 se aplica tras descartar operaciones con choque de
  parámetros; el índice `n` del nombre de respaldo es la posición 1-based en la lista final.
- **Descripción (R9)**: formato `[Write operation.] <Integración>: <Nombre>. <descripción> Returns:
  <response_description>`, cortada a 1024 con «…».
- **Instrucciones (R26)** solo se incluyen para integraciones con alguna herramienta en el turno
  (en `draft`, una integración solo de escrituras no aporta instrucciones).
- **Aviso del playground (R35)** siempre visible, como «aviso fijo» del design §9.
- **PATCH**: `aiTimezone: ''` se trata como `null` (el selector «Sin zona» manda `null`, pero así no
  falla un cliente que mande vacío). Se permite sobre una integración retirada que la cuenta aún
  tiene activada (inofensivo: la carga exige `integrations.is_active`).
- **Gemini**: las partes `thought: true` no cuentan como texto; `SAFETY` sin texto ni llamadas da el
  mismo mensaje de filtro que el adaptador actual.
- **Anthropic**: `tool_choice: {type:'none'}` en la vuelta final (el skill `claude-api` confirma que
  `none` sigue aceptado en modelos que rechazan `any`/`tool`). Sin `strict` (D12).
- **`message-composer.tsx`** no se pasó por prettier: el archivo entero está en estilo de comillas
  dobles y sin formatear en main; formatearlo habría reescrito ~900 líneas ajenas. El bloque nuevo
  sigue el estilo del archivo.
- **i18n**: `aiInstructionsCount` es «{count} de 2000» / «{count} of 2000» (el test de paridad no
  admite textos idénticos en es y en).

## Coordinación con n13.5 (`cabbity-health-connector`)

- No se modificó ningún archivo de `src/lib/integrations/{types,request,http,execute,catalog-validate}.ts`.
- n13.3 ya omite `in: 'header'` del esquema (test con `Idempotency-Key`), anida nombres con punto
  y aplana los argumentos de vuelta a `a.b` (lo que espera el ejecutor de n13.5, R15 de su spec).
- `remoteError` se lee por acceso defensivo; cuando n13.5 lo añada al tipo no hace falta cambiar
  nada aquí. Test con un `remoteError` simulado en `result.test.ts`.
- Migración: n13.3 usa **094**. Si n13.5 también necesita migración, quien fusione segundo
  renumera (D9).
- Conflictos previsibles al fusionar: `messages/{es,en}.json` (claves distintas, mismo archivo) y
  `CHANGELOG.md`.

## Variables de entorno nuevas

- `AI_TOOL_BUDGET_MS` (opcional, por defecto 40000), documentada en `docs/docker.md`.
  `.env.local.example` no se tocó (bloqueado por permisos): conviene añadirla allí a mano.

## Deuda detectada (fuera de alcance, no arreglada)

- `src/components/agents/ai-playground.tsx` tiene todos sus textos en inglés fijo (no i18n); solo lo
  nuevo de n13.3 va por `AiTools`.
- `src/components/inbox/message-composer.tsx` y varios archivos de `src/components/settings/` no
  cumplen prettier en main.
- El toast del compositor (R36, parte UI) no tiene test: el compositor es un componente grande con
  estado y fetch, sin jsdom en el repo; el contrato de la ruta sí está probado.
- La tarjeta de Ajustes no muestra el contador de operaciones que la IA verá (la de borrador es
  solo `GET`); podría confundir, pero el spec no lo pide.

## Ronda 2 (review CHANGES_REQUESTED, `progress/review_integration-ai-tools.md`)

Commits: `43cff17` (merge de main 69d67dd con n13.5; único conflicto `CHANGELOG.md`, ambos bloques
conservados), `b323aea`, `9e8bdf6`, `a5c7617`.

1. **Unificación con n13.5 (hallazgo 8)** — `b323aea`: `schema.ts` usa `callerParams` (borrada
   `callerSideParams`); `result.ts` lee `result.remoteError` tipado (quitado el acceso defensivo y
   el respaldo `error`). Test: `result.test.ts` «carries the remote error of the executor
   (remoteError), cut to 300».
2. **R36 (cambio requerido)** — `9e8bdf6`: `src/lib/ai/tools/tools-used.ts` exporta
   `readToolsUsed` (movida desde `ai-playground.tsx`, que ahora la importa) y
   `formatToolsUsed(raw: unknown): string`; `message-composer.tsx` solo hace
   `toast.info(t('draftUsedTools', { tools }))` si el texto no está vacío. Tests en
   `src/lib/ai/tools/tools-used.test.ts` (lista válida → `"Health · search, Health · list"`,
   mal formadas descartadas, vacío / no-array / objeto → `''`). Nota: ahora una entrada sin `ok`
   booleano también se descarta (mismo guard que el playground).
3. **Uso de vueltas previas si falla una posterior (hallazgo 6)** — `a5c7617`: `AiError` gana
   `usage: AiUsage | null` (por defecto `null`); `runToolLoop` le suma el uso acumulado antes de
   propagar. Bot, playground y borrador, en el `.catch` de `generateReply`, escriben esa fila en
   `ai_usage_log` (fire-and-forget como la normal) y relanzan: el comportamiento de error (R22)
   no cambia. Tests: `loop.test.ts` «a provider AiError after earlier rounds carries their usage
   (finding 6)»; `auto-reply.tools.test.ts` «a failed later tool round still logs…» y «a failure
   without earlier usage logs nothing»; `playground/route.tools.test.ts` y
   `draft/route.tools.test.ts` «a failed later tool round still logs the earlier usage».
4. **Profundidad (hallazgo 7)** — `b323aea`: `args.ts` exporta `MAX_ARG_DEPTH = 4` y
   `buildParameterSchema` no ofrece parámetros con más segmentos: opcional → fuera del esquema;
   requerido → la operación entera fuera (no se podría llamar nunca). Una línea
   `console.warn('[ai tools] a parameter is nested too deeply for the AI')` sin datos. El
   validador del catálogo de n13.5 ya limita a 3 niveles, así que hoy no se dispara. Test:
   `schema.test.ts` «never offers a parameter deeper than flattenToolArgs accepts (4)».

No tocados (decisión del humano): hallazgos 2, 3, 4 y 5.

Compuerta tras la ronda 2 (en el worktree): lint 0 errores (34 warnings preexistentes), typecheck
verde, `TZ=UTC npm test` 5571 passed / 7 skipped, build verde con variables dummy,
`replay-migrations.sh` verde (`094` ok, `verify-schema.sql: OK`).
