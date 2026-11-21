# n13.12 ai-reply-cut — informe del implementador

Rama `fix/ai-reply-cut` (worktree `.claude/worktrees/ai-reply-cut`), commit `2911833`.

## Plan
1. Confirmar la hipótesis en la doc oficial de Gemini.
2. Presupuesto propio para Gemini en los dos call sites.
3. Helper puro `trimDanglingFragment` aplicado en MAX_TOKENS.
4. `console.warn` cuando finishReason != STOP.
5. Filtrar `thought === true` en el camino sin tools.
6. Tests y CHANGELOG.

## Hipótesis: CONFIRMADA por la doc
- https://ai.google.dev/gemini-api/docs/thinking#token-limits : «`max_output_tokens` sets the maximum number of tokens a response can generate, **including thought tokens** … If the model hits this limit while reasoning, it stops … and returns truncated or empty output». La nota de Pricing repite: «`max_output_tokens` applies to the combined total of thinking tokens and output tokens, setting a low limit can truncate responses».
- https://ai.google.dev/api/generate-content : `maxOutputTokens` en `GenerationConfig`; `usageMetadata.thoughtsTokenCount` («Number of tokens of thoughts for thinking models»); `FinishReason.MAX_TOKENS`.
- Tabla de modelos de la misma página: la familia 3.x flash tiene el razonamiento activado por defecto (`medium`/`high`, y `minimal` en flash-lite). `gemini-3.5-flash` no aparece literalmente en la tabla (sí `3.5-flash-lite`, `3.6-flash`); no lo pude cotejar contra la API real.
- La doc recomienda bajar `thinking_level` en vez de un `max_output_tokens` pequeño, pero ese parámetro varía por familia (`thinkingBudget` en 2.5, `thinkingLevel` con valores distintos por modelo, error si el modelo no piensa). Se descartó, tal como pediste, a favor de un presupuesto propio.
- Sin confirmar en producción: no tengo acceso a la respuesta real. El nuevo `console.warn` lo confirma en los logs (`finishReason: 'MAX_TOKENS'` con `thoughtsTokenCount` alto).

## Cambios
- `src/lib/ai/defaults.ts`: `GEMINI_MAX_OUTPUT_TOKENS = MAX_OUTPUT_TOKENS + 8192` (9216). `MAX_OUTPUT_TOKENS` no cambia (OpenAI/Anthropic intactos).
- `src/lib/ai/providers/gemini.ts`:
  - `generateGemini` y `generateGeminiWithTools` envían `GEMINI_MAX_OUTPUT_TOKENS`.
  - `trimDanglingFragment(text)` exportado: corta hasta el último `\n` o final de frase (`.!?…` seguido opcionalmente de `)"'»”` y luego espacio/fin). Sin ninguno → `''` → `empty_response` como antes.
  - `finalText(...)` privado, usado en los dos call sites: avisa y recorta solo en MAX_TOKENS.
  - `console.warn('[ai] gemini did not finish with STOP', { model, finishReason, thoughtsTokenCount })` si finishReason existe y no es STOP (accountId no está disponible aquí).
  - Camino sin tools: filtra `thought === true` como el de tools.
- Tests ajustados: `gemini.images.test.ts` y `generate.test.ts` esperaban 1024 en el body de Gemini; `gemini.tools.test.ts` (MAX_TOKENS sin tools) usaba el texto `'part'` que ahora se recorta a vacío → `'part.'`.
- `CHANGELOG.md` Unreleased: una entrada.

Consumidores revisados (grep): `MAX_OUTPUT_TOKENS` se usa en openai.ts, anthropic.ts y sus tests (sin tocar); `transcribe-gemini.ts` tiene su propio límite (2048) y no se tocó; `generateGemini*` no cambian de firma.

## Criterio ↔ test (`src/lib/ai/providers/gemini.cut.test.ts`)
| Criterio | Test |
|---|---|
| Presupuesto Gemini en los 2 call sites | `%s > sends the Gemini budget, not the shared one` (×2) |
| Helper puro, «…sesiones.\n\n¿» → «…sesiones.» y demás casos | `trimDanglingFragment > %j -> %j` (8 casos) |
| MAX_TOKENS con fragmento → recorte + warn con modelo/finishReason/thoughtsTokenCount | `cuts a MAX_TOKENS reply back to the last whole sentence and warns` (×2) |
| MAX_TOKENS con texto completo intacto | `keeps a MAX_TOKENS reply that already ends on a sentence` (×2) |
| MAX_TOKENS sin frase completa → empty_response | `maps a MAX_TOKENS fragment with no whole sentence to empty_response` (×2) |
| STOP intacto, sin parts `thought`, sin warn (camino sin tools incluido) | `keeps a STOP reply whole, without thought parts, and does not warn` (×2) |

## Compuerta dirigida (en el worktree)
- `npm run typecheck`: OK.
- `npx eslint src/lib/ai`: sin errores ni warnings.
- `TZ=UTC npx vitest run src/lib/ai`: 62 archivos, 809 tests, todos en verde.
- No se corrió la compuerta completa ni build (por instrucción).

## No verificado / pendiente manual
- Llamada real a `gemini-3.5-flash` con la clave de Rehactive: repetir en el playground los dos mensajes del reporte y comprobar que llegan completos; si en logs aparece el warn con MAX_TOKENS aun con 9216, subir el margen.
- Coste: el razonamiento se factura igual; el tope solo limita el peor caso (hasta 9216 tokens de salida por llamada en vez de 1024).
- Los tests existentes de SAFETY en `generate.test.ts` ahora imprimen el warn en la salida de vitest (ruido, no fallo).

## Decisiones
- Margen de 8192: holgado para `medium`/`high` en una respuesta de WhatsApp; la longitud visible sigue acotada por el prompt («concise»). Ajustable si los logs muestran otra cosa.
- El recorte solo actúa en MAX_TOKENS; SAFETY/RECITATION etc. mantienen el comportamiento previo (solo se añade el warn).
- Heurística de frase: un «Dr. » intermedio cuenta como final de frase; aceptable para un fallback.

Sin variables de entorno nuevas, sin migración, sin dependencias.

## Ronda 2 (review_ai-reply-cut.md)

Commit `d51aa95`.

- Hallazgo 1 (bloqueante): el regex de `trimDanglingFragment` lleva un lookbehind negativo `(?<!^[ \t]*\d+|…)` con flag `m`: un número al inicio de línea seguido de punto (marcador de lista) ya no es final de frase. `Tenemos:\n1. Fisioterapia\n2. Masaje terap` → `Tenemos:\n1. Fisioterapia`; `Tenemos:\n1.` → `Tenemos:`.
- Hallazgo 2: mismo lookbehind excluye `Dr.`, `Dra.`, `Sr.`, `Sra.` (palabra completa, sensible a mayúsculas); `*` y `_` añadidos a los cierres tras el signo. `*Gracias por escribir.* Te cuen` → `*Gracias por escribir.*`. Otras abreviaturas (`Lic.`, `Ing.`) siguen sin cubrir: lista corta a propósito.
- Hallazgos 3, 4 y 5: sin tocar (informativos).
- Casos fijos añadidos en `gemini.cut.test.ts › trimDanglingFragment`: los 8 de la tabla del review más `Tenemos:\n1.`, `Sr. Gómez` y `_Listo._` (11 nuevos; 19 en total).

Compuerta dirigida: `npm run typecheck` OK; `npx eslint src/lib/ai` sin salida; `TZ=UTC npx vitest run src/lib/ai` 62 archivos, 820 tests en verde.
