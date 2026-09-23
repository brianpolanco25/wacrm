# Implementación p8.3 — Google Gemini como proveedor de IA

## Plan

1. Tipo `AiProvider` + default `gemini-3.5-flash-lite` + fila de `config.ts`; seguir los errores de `tsc`.
2. Adaptador `providers/gemini.ts` (`generateContent`, `x-goog-api-key`), `generate.ts` case `gemini`,
   `providerHttpError` con 400 + `API_KEY_INVALID` → `invalid_key`.
3. Clave de plataforma `AI_PLATFORM_GEMINI_API_KEY`.
4. Migración 066 (tras confirmar nombres reales de las constraints con el replay), aserción en
   `verify-schema.sql`, `progress/checks_gemini-provider.sql`.
5. UI (`ai-config.tsx`) + ruta `api/ai/config`.
6. Docs, legal, README, CHANGELOG (Migration required: 066).
7. Tests (generate, platform-key, route) y compuerta.

## Estado: implementado, compuerta en verde (pendiente de reviewer)

Rama `feat/proveedor-gemini` (worktree `.claude/worktrees/gemini`), sobre 2bad31e:

| SHA       | Commit |
| --------- | ------ |
| `8080295` | feat: admitir gemini en los CHECK de proveedor de IA (migración 066) |
| `99ab0d7` | feat: añadir Google Gemini como proveedor del asistente de IA |
| `d26ae50` | docs: nombrar Google Gemini junto a OpenAI y Anthropic |
| `351254b` | docs: anotar Gemini en el CHANGELOG con la migración 066 |

Los hitos «tipos+adaptador+generate» y «UI+route» van en un solo commit (`99ab0d7`): el tercer miembro de
`AiProvider` rompe `tsc` en `route.ts` y `ai-config.tsx` hasta que se actualizan, y no quise dejar un commit
intermedio que no compila.

## Por punto de la spec

1. **Tipo y defaults.** `src/lib/ai/types.ts`: `AiProvider = 'openai' | 'anthropic' | 'gemini'`, más
   `AI_PROVIDERS` e `isAiProvider(value): value is AiProvider` para validar cuerpos de petición.
   `defaults.ts`: `gemini: 'gemini-3.5-flash-lite'`. `config.ts`: la fila usa `provider: AiProvider`.
   Errores de `tsc` seguidos: `api/ai/config/route.ts` (`platformKeyAvailability` con `gemini`, validación con
   `isAiProvider`, mensaje `provider must be "openai", "anthropic" or "gemini"`), `ai-config.tsx`
   (`PROVIDER_LABEL.gemini = 'Google Gemini'`, `KEY_PLACEHOLDER.gemini = 'AIza...'`, estado inicial y `fetchConfig`
   con `gemini`, `handleProviderChange` con `Object.values(AI_PROVIDER_DEFAULT_MODEL).includes(model)`, `SelectItem`
   `gemini`).
2. **Adaptador** `src/lib/ai/providers/gemini.ts` → `generateGemini(args)`. `POST
   https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent` (modelo con
   `encodeURIComponent`), cabecera `x-goog-api-key`, nada en la query. Cuerpo `systemInstruction.parts[].text`,
   `contents` (merge + `assistant→model` + descarta turnos `model` iniciales + relleno `user` si queda vacío),
   `generationConfig.maxOutputTokens = MAX_OUTPUT_TOKENS`. `AbortSignal.timeout`, `toNetworkError`,
   `providerHttpError('Gemini', res)`, `normalizeUsage` con `promptTokenCount/candidatesTokenCount/totalTokenCount`.
   Sin texto → `empty_response`; si `promptFeedback.blockReason` o `finishReason === 'SAFETY'`, mensaje
   «Gemini's safety filter blocked the response.»; si no, «Gemini returned an empty response.».
   **`providerHttpError` solo miraba el status** (401/403 → `invalid_key`, 429 → `rate_limited`), así que añadí en
   `providers/shared.ts` `isGoogleInvalidKey(body)`: 400 con algún `error.details[].reason === 'API_KEY_INVALID'` →
   `invalid_key` (status 401). Un 400 de OpenAI/Anthropic sigue siendo `provider_error` (test).
3. **`generate.ts`**: `case 'gemini'` → `generateGemini`.
4. **Clave de plataforma**: `AI_PLATFORM_KEY_ENV.gemini = 'AI_PLATFORM_GEMINI_API_KEY'` y cabecera de comentarios.
   `docs/docker.md` «Platform AI keys»: fila nueva, «OpenAI / Anthropic / Gemini», «Both variables» → «These
   variables», y la limitación de embeddings (punto 8).
5. **Migración 066** `supabase/migrations/066_ai_provider_gemini.sql` (DROP IF EXISTS + ADD, idempotente).
   **Nombres reales** confirmados con `KEEP=1` y `pg_constraint` antes de escribirla:
   `ai_configs_provider_check` y `ai_usage_log_provider_check` (los que suponía la spec). Aserción en
   `supabase/ci/verify-schema.sql` (dentro del único DO) de que `pg_get_constraintdef` de ambas contiene
   `'gemini'`. Checks en `progress/checks_gemini-provider.sql`.
6. **Textos**: `README.md`, `src/content/legal/es.ts` y `en.ts` («OpenAI, Anthropic y Google (Gemini): solo si…»),
   `docs/docker.md`. El grep encontró además la descripción del panel de IA en `messages/{es,en,ko}.json`
   (`Settings.aiConfig.description`, «tu propia clave de OpenAI o de Anthropic»): cambié el texto de esa clave
   existente en los tres catálogos; **no hay claves nuevas**.
7. **Tests**: ver tabla.
8. **Fuera de alcance** respetado: embeddings siguen en OpenAI (documentado), sin streaming, sin Interactions API,
   sin `.env.local.example`, sin MCP.

## Criterio ↔ test

| Criterio | Archivo | `it` |
| --- | --- | --- |
| 7a URL con modelo, `x-goog-api-key`, sin `key=`, `systemInstruction`, `user`/`model` empezando por `user`, `maxOutputTokens` | `src/lib/ai/generate.test.ts` | `calls generateContent with the key in a header and a user/model transcript` |
| 7a `contents` nunca vacío | idem | `never sends an empty transcript` |
| 7b texto + usage normalizado | idem | `joins the text parts of the first candidate and normalizes usage` |
| 7c bloqueo de seguridad | idem | `maps a blocked prompt (promptFeedback.blockReason) to empty_response naming the safety filter`, `maps a SAFETY finish with no text to the safety-filter empty_response`, `uses the generic empty_response when there is no text and no block` |
| 7d 400 `API_KEY_INVALID` → `invalid_key` | idem | `maps a 400 API_KEY_INVALID to an invalid_key AiError`, `keeps any other 400 as a provider_error`, `maps a 403 (key without permission) to invalid_key` |
| 7d sin romper OpenAI | idem | `providerHttpError — 400 is not an auth failure for OpenAI/Anthropic` › `keeps an OpenAI 400 as provider_error` |
| 7e sentinel de handoff con Gemini | idem | `detects the handoff sentinel in Gemini output` |
| Clave de plataforma gemini | `src/lib/ai/platform-key.test.ts` | `reads AI_PLATFORM_GEMINI_API_KEY for gemini` |
| Ruta config acepta gemini / rechaza inventado | `src/app/api/ai/config/route.test.ts` | `accepts provider gemini: validates with the Gemini key and stores it`, `accepts gemini without api_key when the Gemini platform key exists`, `rejects an invented provider`; y los dos de `GET` ahora esperan `gemini: false` |
| Ruta test acepta gemini / rechaza inventado | `src/app/api/ai/test/route.test.ts` | `tests a Gemini key (p8.3)`, `rejects an invented provider` |
| CHECK admite gemini (base real) | `supabase/ci/verify-schema.sql` + `progress/checks_gemini-provider.sql` | ver abajo |

## Verificación contra base real

- Replay final (`scripts/replay-migrations.sh "$(pwd)"`): **exit 0**, 66 migraciones `ok` hasta
  `ok  066_ai_provider_gemini.sql`, `verify-schema.sql: OK`.
- `progress/checks_gemini-provider.sql` contra el contenedor `KEEP=1`: `NOTICE: checks_gemini-provider: all
  assertions passed`, `ROLLBACK`, exit 0 (inserta y borra fila `gemini` en `ai_configs` y `ai_usage_log`;
  `mistral` sigue rechazado con `check_violation` en ambas). Tras el ROLLBACK, 0 filas en las dos tablas.
- Idempotencia: reaplicar la 066 sobre la base ya migrada → exit 0; definiciones resultantes:
  `CHECK ((provider = ANY (ARRAY['openai'::text, 'anthropic'::text, 'gemini'::text])))` en ambas.
- La aserción muerde: con `ai_usage_log_provider_check` repuesto sin `gemini`, `verify-schema.sql` falla con
  `ai_usage_log_provider_check must allow provider = gemini (migration 066)`.

## Compuerta (en este orden, en primer plano)

- `npm run lint`: 0 errores, 35 warnings, todos preexistentes (el de `ai-config.tsx` L179,
  `useCallback` sin `t`, ya estaba en L176 antes del cambio). Mi código no añade ninguno.
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 204 archivos, **2692 tests** en verde.
- `npm run build` con las variables dummy de `ci.yml`: exit 0, `✓ Compiled successfully`.
- `scripts/replay-migrations.sh`: exit 0, `verify-schema.sql: OK`.

## Verificación manual pendiente (servicio externo)

Con una clave real de Google AI Studio en un entorno de prueba (no producción):
1. Aplicar la 066. Ajustes → IA → proveedor **Google Gemini**; el modelo pasa a `gemini-3.5-flash-lite`.
2. Pegar la clave → **Probar clave** → OK. Pegar `AIza-invalida` → debe decir clave inválida (400
   `API_KEY_INVALID` → 401 en nuestra API).
3. Guardar, abrir el Playground y pedir un borrador en la bandeja: responde y `ai_usage_log` recibe una fila
   `provider = 'gemini'` con tokens.
4. Auto-respuesta con «quiero hablar con una persona» → handoff.
5. Sin clave propia y con `AI_PLATFORM_GEMINI_API_KEY` definida: el campo de clave puede quedar vacío y
   `key_source = 'platform'`.

## Decisiones donde la spec era ambigua

- **`/api/ai/test` también validaba el proveedor a mano** (`openai`/`anthropic`) y la spec no lo nombraba (no es
  un error de `tsc`). Sin tocarlo, **Probar clave** con Gemini devolvía 400. Lo pasé a `isAiProvider` con el mismo
  mensaje que la ruta de config y dos tests.
- **Descripción del panel** en `messages/*`: la spec dice «no hay claves nuevas»; cambié el texto de una clave
  existente que enumeraba los proveedores (sin tocarla, la UI diría «OpenAI o Anthropic» encima de un selector
  con Gemini).
- **Formato**: `defaults.ts`, `generate.ts`, `providers/shared.ts` y `README.md` no estaban formateados con
  prettier (sin `;`); pasarles `prettier --write` reescribía el archivo entero. Los dejé en su estilo y edité
  solo mis líneas para que el diff sea revisable. `gemini.ts` (nuevo) y el resto de archivos tocados sí pasan
  `prettier --check`.
- `isGoogleInvalidKey` mira solo `error.details[].reason`, que es donde Google pone `API_KEY_INVALID`; no
  inspecciona el texto del mensaje.

## Variables de entorno nuevas

- `AI_PLATFORM_GEMINI_API_KEY` (servidor, opcional). Documentada en `docs/docker.md`. **`.env.local.example`
  sin tocar**: lo hace el líder.

## Deuda fuera de alcance (no arreglada)

- `src/lib/ai/embeddings.ts` dice en su cabecera «Anthropic has no embeddings endpoint, so this is always
  OpenAI's»; sigue siendo cierto pero ahora también aplica a Gemini. Solo comentario.
- Warning preexistente `react-hooks/exhaustive-deps` en `ai-config.tsx` (`fetchConfig` sin `t`).
- Varios archivos de `src/lib/ai/` y `README.md` no pasan `prettier --check` desde antes.
