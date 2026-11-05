# n13.3 `integration-ai-tools` — tareas

Orden pensado para que cada paso deje la compuerta dirigida en verde
(`./init.sh feature n13.3 --test <ruta>...`). Los tests van junto al código (`*.test.ts[x]`).
Ninguna task modifica los tests existentes de IA (R38): si uno se rompe, el código está mal.

- [x] **T1 Migración 094 y esquema** — `supabase/migrations/094_integration_ai_tools.sql`
  (design §2) y bloque `-- 094` en `supabase/ci/verify-schema.sql`. Validar con
  `scripts/replay-migrations.sh` (aplicada dos veces) y escribir
  `progress/checks_integration-ai-tools.sql` (checks de CHECK y default).
  Cubre **R31** (y la parte SQL de **R30**). Prueba: replay verde + SQL del harness.

- [x] **T2 Esquema de herramientas (puro)** — `src/lib/ai/tools/types.ts`, `schema.ts`.
  Cubre **R4, R5, R6, R7, R8, R9**. Test `src/lib/ai/tools/schema.test.ts`: orden y tope de 20;
  `draft` deja solo `GET`; nombres `health__search_patient`, colisión y nombre > 64 → `op<n>_…`,
  todos casan con `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`; tipos, `required`, `enum` en string y en
  descripción para integer; parámetro con `in: 'header'` omitido; `consent.accepted` anidado con
  `required` propagado; choque `a`/`a.b` → operación fuera; nombre `constructor` no rompe;
  descripción con «Write operation» para `POST` y ≤ 1024.

- [x] **T3 Argumentos y resultados (puro)** — `src/lib/ai/tools/args.ts`, `result.ts`.
  Cubre **R16, R17, R23, R24** (y los payloads de R18/R21). Tests `args.test.ts`
  (`{a:{b:1}}` → `{'a.b':1}`, arrays hoja, profundidad 4, no-objeto → `{}`, propiedades heredadas
  ignoradas) y `result.test.ts` (ok bajo 8192; ok sobre 8192 → `truncated`, ≤ 8192 bytes, sin
  carácter partido con emojis/acentos en el corte; `invalid_params` con `problem/param`;
  `http_error` 404 con su hint; `error.code/message` opcionales cortados a 300; `unknown_tool`,
  `invalid_arguments`, `limit_reached`, `error`).

- [x] **T4 Sección de prompt** — `src/lib/ai/tools/prompt.ts` y `buildSystemPrompt` en
  `src/lib/ai/defaults.ts` (parámetros opcionales `tools`, `now`).
  Cubre **R25, R26, R27**. Test `prompt.test.ts`: `formatNowInZone(new Date('2026-11-05T14:31:00Z'),
  'America/Santo_Domingo')` → `2026-11-05T10:31:00-04:00`; zona inválida → `null`; la sección
  contiene UTC, la línea por integración, las reglas (confirmar escrituras, no inventar ids, ISO con
  offset, idioma, datos no instrucciones) y las `ai_instructions` rotuladas; en `auto_reply` menciona
  el handoff. En `src/lib/ai/defaults.test.ts` (casos nuevos): sin `tools` el texto es idéntico al
  de antes (comparación con la llamada sin el parámetro).

- [x] **T5 Adaptadores con herramientas** — `src/lib/ai/providers/shared.ts` (`ToolSpec`,
  `ToolStep`, `ProviderToolArgs`, `ProviderToolResult`, `sumUsage`, `parseToolArguments`) y
  `generate<X>WithTools` en `anthropic.ts`, `openai.ts`, `gemini.ts` (design §4).
  Cubre **R10, R11, R12, R13, R14**. Tests con `fetch` simulado (`vi.stubGlobal`):
  `anthropic.tools.test.ts`, `openai.tools.test.ts`, `gemini.tools.test.ts` — cuerpo enviado
  (`tools`, `tool_choice`/`toolConfig`, esquema Gemini en mayúsculas y sin `parameters` si no hay
  props), parseo de llamadas, reenvío del turno nativo sin cambios (incluye bloque `thinking` en
  Anthropic y `thoughtSignature` en Gemini), resultados en un solo mensaje `user` (Anthropic,
  Gemini) / un `role:'tool'` por llamada (OpenAI), `is_error` en Anthropic, argumentos OpenAI no
  JSON → `INVALID_ARGS`, `max_tokens`/`refusal`/`length`/`MAX_TOKENS` → sin llamadas; sin texto ni
  llamadas → `empty_response`. R14: `src/lib/ai/generate.test.ts` existente sin tocar sigue verde.

- [x] **T6 Bucle** — `src/lib/ai/tools/loop.ts` y la rama nueva de `generateReply` en
  `src/lib/ai/generate.ts` (`GenerateArgs.tools`, `GenerateResult.toolsUsed?`).
  Cubre **R15, R17, R18, R19, R20, R21, R22, R37** (suma) y **R29** (logs del bucle). Test
  `loop.test.ts` con `callProvider` y `execute` simulados y reloj inyectado: orden secuencial y
  `source:'ai'` con el `accountId` recibido; nombre desconocido y args inválidos sin ejecutor;
  6.ª vuelta con `toolChoice:'none'` tras 5 con llamadas; 9.ª llamada → `limit_reached` y vuelta
  final `none`; reloj > 40 000 ms → vuelta final `none`; `AI_TOOL_BUDGET_MS` lo cambia; texto
  intermedio descartado; `[[HANDOFF]]` final → `handoff:true` vía `generateReply`; ejecutor que
  lanza → payload `error`; proveedor que lanza `AiError` en la 2.ª vuelta → se propaga; uso
  sumado de tres vueltas y `null` si ninguna informa; `console.*` espiado no contiene credencial,
  valores de argumentos ni del `data`.

- [x] **T7 Carga de herramientas** — `src/lib/ai/tools/load.ts`.
  Cubre **R1, R2, R3** y la parte de carga de **R28**. Test `load.test.ts` con base simulada
  (patrón de `src/lib/integrations/integrations.test-support.ts`): solo filas con `is_enabled`,
  `ai_enabled`, credencial, integración y operación activas; plan sin `integrations` → vacío;
  error de base → vacío + un `console.error` fijo; `entitlements` pasados no vuelven a pedirse;
  la consulta a `account_integrations` lleva `.eq('account_id', A)`.

- [x] **T8 Llamadores** — `src/lib/ai/auto-reply.ts`, `src/app/api/ai/playground/route.ts`,
  `src/app/api/ai/draft/route.ts` (design §7).
  Cubre **R5** (draft), **R35** y **R36** (contrato de la respuesta), **R37** (una fila de
  `ai_usage_log` con la suma), **R38**. Tests nuevos `src/lib/ai/auto-reply.tools.test.ts`,
  `src/app/api/ai/playground/route.tools.test.ts`, `src/app/api/ai/draft/route.tools.test.ts`
  (mocks de `loadAiToolset` y `generateReply`): con herramientas, `generateReply` recibe `tools`
  con el `accountId` de la sesión/webhook y la respuesta trae `toolsUsed`; borrador pide
  `mode:'draft'`; sin herramientas, `generateReply` recibe exactamente `{config, systemPrompt,
  messages}`. Los tests existentes (`auto-reply.test.ts`, `playground/route.test.ts`, borrador)
  pasan sin cambios.

- [x] **T9 Ajustes: API** — `src/lib/integrations/{types,account}.ts` (`aiEnabled`,
  `aiInstructions`, `aiTimezone`, `validateAiSettings`, `updateAccountIntegrationAi`) y `PATCH` en
  `src/app/api/account/integrations/[integrationId]/route.ts`.
  Cubre **R32, R33**. Tests en `[integrationId]/route.test.ts` (casos nuevos: 200 y vista
  actualizada, 400 por campo con `field`, cuerpo vacío 400, 402 sin plan, 403 `agent`, 403 sesión
  de soporte, 404 no activada, `''` → `null`, zona `Mars/Base` → 400) y en
  `src/app/api/account/integrations/route.test.ts` (la vista trae los tres campos; `false`/`null`
  si no está activada). `enableAccountIntegration` no pisa `ai_*` (caso en el test de la ruta PUT).

- [x] **T10 Ajustes, playground y compositor: UI + i18n** —
  `src/components/settings/integration-ai-controls.tsx` (usado desde
  `integrations-settings.tsx`), `src/components/agents/ai-tools-used.tsx` (usado desde
  `ai-playground.tsx`), toast en `src/components/inbox/message-composer.tsx`, claves de design §10
  en `messages/es.json` y `messages/en.json`.
  Cubre **R34, R35, R36, R39**. Tests `integration-ai-controls.test.tsx` y `ai-tools-used.test.tsx`
  con `renderToStaticMarkup` en `es` y `en`: interruptor con `aria-checked`, botón de
  instrucciones solo encendido, todo `disabled` en solo lectura; línea «Usó:» con ✓/✗ por
  herramienta; aviso del playground presente. `src/i18n/messages.test.ts` verde. Sin capturas:
  si se abre el navegador, se aserta texto/`disabled`, no se guarda imagen.

- [x] **T11 Aislamiento CP3** — casos nuevos en `src/lib/security/tenant-isolation.test.ts`
  (design §11 a–c).
  Cubre **R28, R30** (fila de `integration_calls` con `source:'ai'` y `account_id` A en la base
  simulada), **R29**. Prueba: los tres casos verdes con dos cuentas y credenciales distintas.

- [x] **T12 Guion manual** — dejar en `progress/impl_integration-ai-tools.md` el guion de design
  §12 listo para el humano (no lo ejecuta el agente: depende de claves reales de los tres
  proveedores y de una integración de pruebas).
  Cubre **R41** [M].

- [x] **T13 Compuerta en verde + CHANGELOG** — `./init.sh feature n13.3 --test <cada test nuevo y
  tocado>... --lint <archivos tocados>`; entrada en `CHANGELOG.md` (formato de `CONTRIBUTING.md`):
  «La IA de respuesta automática puede usar las integraciones activadas como herramientas».
  Cubre **R40** (y confirma **R38**).
