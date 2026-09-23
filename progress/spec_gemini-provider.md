# Spec p8.3 — Google Gemini como proveedor de IA

Rama `feat/proveedor-gemini`, worktree `.claude/worktrees/gemini`, base `main` @ 7460351. Pedido por el humano el
2026-09-23; migración 066 autorizada por él el mismo día. Modelo por defecto decidido: `gemini-3.5-flash-lite`
(el escalón barato, como `gpt-5.4-mini` y `claude-haiku-4-5-20251001`); editable como texto libre igual que los otros.

## Contexto verificado por el líder (2026-09-23, docs vivas de Google)

- Endpoint estable: `POST https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent`. No está
  marcado como obsoleto. (Existe además una «Interactions API» nueva; **no la uses**: la forma estable y sin estado
  es `generateContent`.)
- Clave: cabecera `x-goog-api-key: <clave>`. **Nunca** `?key=` en la URL (acabaría en logs).
- Cuerpo: `systemInstruction: { parts: [{ text }] }`, `contents: [{ role: 'user' | 'model', parts: [{ text }] }]`,
  `generationConfig: { maxOutputTokens }`. El rol del asistente se llama **`model`**, no `assistant`.
- Respuesta: `candidates[0].content.parts[].text`, `candidates[0].finishReason`, `usageMetadata.promptTokenCount`,
  `usageMetadata.candidatesTokenCount`, `usageMetadata.totalTokenCount`, `promptFeedback.blockReason` (cuando el
  filtro de seguridad bloquea el prompt no hay candidatos).
- Modelos estables hoy: `gemini-3.8-flash`, `gemini-3.7-flash`, `gemini-3.6-flash`, `gemini-3.5-flash`,
  `gemini-3.5-flash-lite`, `gemini-3.1-flash-lite`. Las familias 2.5/2.0 están restringidas o apagadas: no las uses
  en defaults ni en tests como si fueran válidas.

## Alcance

1. **Tipo y defaults.** `AiProvider = 'openai' | 'anthropic' | 'gemini'` (`src/lib/ai/types.ts`);
   `AI_PROVIDER_DEFAULT_MODEL.gemini = 'gemini-3.5-flash-lite'` (`defaults.ts`); `config.ts` L7 (tipo de la fila).
   Sigue cada error de `tsc` que provoque el tercer miembro: `Record<AiProvider, …>` en `platform-key.ts`,
   `api/ai/config/route.ts` (`platformKeyAvailability`, validación L116 → acepta `gemini`, mensaje de error
   actualizado), `ai-config.tsx` (`PROVIDER_LABEL.gemini = 'Google Gemini'`, `KEY_PLACEHOLDER.gemini = 'AIza...'`,
   estado `platformKeyAvailable` con `gemini: false`, L147 y `handleProviderChange` L199 comparando contra los tres
   defaults —mejor: `Object.values(AI_PROVIDER_DEFAULT_MODEL).includes(model)`—, y la opción en el `Select`).
2. **Adaptador** `src/lib/ai/providers/gemini.ts` con `generateGemini(args: ProviderArgs): Promise<ProviderResult>`,
   espejo de `anthropic.ts`: `fetch` con `AbortSignal.timeout(timeoutMs)`, `toNetworkError`, `providerHttpError('Gemini',
   res)`, `normalizeUsage({ prompt: promptTokenCount, completion: candidatesTokenCount, total: totalTokenCount })`.
   Mapeo de mensajes: `mergeConsecutive`, `assistant → model`, y garantiza que `contents` empieza por `user` y no está
   vacío (mismo truco que `normalizeForAnthropic`). Texto = `parts` de tipo texto del primer candidato, unidas y
   `trim()`. Sin texto → si hay `promptFeedback.blockReason` o `finishReason === 'SAFETY'`, `AiError` con
   `code: 'empty_response'` y un mensaje que diga que el filtro de seguridad de Gemini bloqueó la respuesta; si no,
   el `empty_response` genérico. `MAX_OUTPUT_TOKENS` en `generationConfig.maxOutputTokens`. Comprueba en
   `providers/shared.ts` cómo mapea `providerHttpError` los 401/403/429 a `invalid_key`/`rate_limited`: Gemini
   devuelve **400 con `API_KEY_INVALID`** en el cuerpo para una clave mala y 403 para una clave sin permiso; si el
   mapeo solo mira el status, añade el caso 400+`API_KEY_INVALID` → `invalid_key` (sin romper OpenAI/Anthropic).
3. **`generate.ts`**: `case 'gemini'` → `generateGemini`.
4. **Clave de plataforma**: `AI_PLATFORM_KEY_ENV.gemini = 'AI_PLATFORM_GEMINI_API_KEY'` (`platform-key.ts`, cabecera de
   comentarios incluida). `docs/docker.md` §«Platform AI keys»: fila nueva en la tabla y «OpenAI / Anthropic» →
   «OpenAI / Anthropic / Gemini» donde toque. **No toques `.env.local.example`** (lo hace el líder).
5. **Migración `supabase/migrations/066_ai_provider_gemini.sql`**, idempotente:
   `ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check; ALTER TABLE ai_configs ADD CONSTRAINT
   ai_configs_provider_check CHECK (provider IN ('openai','anthropic','gemini'));` y lo mismo para `ai_usage_log`
   (`ai_usage_log_provider_check`). Antes **confirma el nombre real** de las constraints con el replay (`KEEP=1` y
   `\d ai_configs` / consulta a `pg_constraint`); si Postgres las nombró distinto, usa el nombre real. Añade a
   `supabase/ci/verify-schema.sql` una aserción de que `pg_get_constraintdef` de ambas contiene `'gemini'`.
   Valida con `scripts/replay-migrations.sh` (salida 0, `verify-schema.sql: OK`) y deja `progress/checks_gemini-provider.sql`
   con un bloque que inserte y borre una fila con `provider = 'gemini'` en ambas tablas dentro de una transacción
   (`ROLLBACK`), como los otros `checks_*.sql`.
6. **Textos**: `README.md` L36 («OpenAI, Anthropic or Google Gemini key»); aviso legal `src/content/legal/es.ts` L56 y
   su gemela en `en.ts` («OpenAI, Anthropic y Google (Gemini): solo si…»; el test `legal.test.ts` debe seguir verde);
   `docs/` donde se enumeren los proveedores (`grep -rn "Anthropic" docs README.md src/content`). `ai-config.tsx` no
   usa i18n para los nombres de proveedor (son marcas): no hay claves nuevas en `messages/*`.
7. **Tests**: `src/lib/ai/generate.test.ts` con el patrón de `fetch` stub que ya usa: (a) petición a Gemini con URL
   correcta (modelo en la ruta), cabecera `x-goog-api-key` y **sin** `key=` en la URL, `systemInstruction`, roles
   `user`/`model` alternados empezando por `user`, `maxOutputTokens`; (b) respuesta feliz con texto y `usage`
   normalizado; (c) bloqueo de seguridad → `AiError` `empty_response`; (d) 400 `API_KEY_INVALID` → `invalid_key`;
   (e) sentinel de handoff sigue funcionando con Gemini (lo parsea `generateReply`). `platform-key.test.ts`: caso
   `gemini`. `api/ai/config/route.test.ts`: `provider: 'gemini'` aceptado y un valor inventado rechazado.
8. **Fuera de alcance**: embeddings con Gemini (la base de conocimiento sigue usando la clave OpenAI de
   `embeddings_api_key`, como con Anthropic; documenta la limitación en `docs/docker.md` junto al párrafo que ya lo
   explica), streaming, la Interactions API, `.env.local.example`, MCP.

## Compuerta y entrega

`npm run lint`, `npm run typecheck`, `TZ=UTC npm test`, `npm run build` (variables dummy de `ci.yml`), y
`scripts/replay-migrations.sh` con salida 0. Commits por hito (tipos+adaptador+generate; migración+verify+checks;
UI+route; docs+legal+README; CHANGELOG con nota **Migration required: 066**). Informe en
`progress/impl_gemini-provider.md` de este worktree. No edites `feature_list.json` ni `progress/current.md`.
