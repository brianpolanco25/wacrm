# Review — n13.9 ai-tool-dates-weekday

**Veredicto:** APPROVED

Rama `feat/ai-tool-dates-weekday`, base `main @ 4257fcc`, commit `ac6bc6e`. Sin SDD: el spec es la `note` de la feature.

## Compuerta (dirigida, ejecutada por el reviewer en el worktree)
- typecheck: verde
- `npx eslint src/lib/ai/tools/`: verde
- `TZ=UTC npx vitest run src/lib/ai`: verde (47 archivos, 623 tests); `src/lib/ai/tools` sin TZ=UTC también verde (273)
- `prettier --check` sobre lo tocado: verde
- `npm run lint` / `npm run build`: no corridos por instrucción del líder (lint barre `.next` de otros worktrees; build fuera del gate dirigido)
- replay-migrations: n/a (sin SQL)

## Trazabilidad criterio ↔ test
- C1 «Current date and time» lleva weekday UTC: [x] `prompt.test.ts` › "states UTC and the local time…" (`Thursday 2026-11-05T14:31:00Z (UTC).`) y "n13.9: the weekday is the local one…" (`Saturday 2026-11-14T02:30:00Z`)
- C2 Líneas locales por integración con weekday local (día distinto a UTC): [x] `prompt.test.ts` › "n13.9: the weekday is the local one when the zone is on another day" (UTC sábado / Santo Domingo viernes 22:30)
- C3 `<clave>_local` sin alterar el ISO original: [x] `result.test.ts` › "adds <key>_local next to an ISO date, leaving the value intact" (toEqual exacto con `starts_at` intacto)
- C4 No mutar `data` de entrada: [x] `result.test.ts` › "walks nested arrays and objects; leaves … the input alone" (`JSON.stringify(data)` antes/después). Código: `walk` construye `out` nuevo y nunca escribe en `value` (`result.ts:80-111`)
- C5 2026-11-13 → Friday: [x] `local-time.test.ts` › "Friday 13 in Santo Domingo (the production bug)", `weekdayOf(2026,11,13)`
- C6 Cruce de medianoche por zona: [x] `local-time.test.ts` › "crosses midnight…" (Madrid → Saturday 04:30 +01:00); `result.test.ts` › "uses the integration zone, crossing midnight"
- C7 Zona = la de la integración del tool (slug correcto) en `loop.ts`: [x] `loop.test.ts` › "annotates tool results in the time zone of the integration" (extremo a extremo; Madrid cambia el día, así que una zona equivocada o null daría Friday y fallaría)
- C8 Call sites antiguos compilan y se comportan igual: [x] 4º parámetro opcional `= null` (`result.ts:176`); único call site es `loop.ts:319`; `result.test.ts` › "without a zone, uses the offset of the value (old call sites)"; tests R23/R24 previos sin tocar y verdes. Los re-exports de `prompt.ts` mantienen `load.ts`, `live-templates.ts` y `integrations/account.ts` (importan `isValidTimeZone` de `./prompt`) compilando
- C9 No sobrescribir `<clave>_local` existente: [x] `result.test.ts` › "never overwrites an existing <key>_local"
- C10 Topes profundidad/elementos: [x] `result.test.ts` › "stops at the depth cap" (11 niveles > 6), "stops at the item cap" (2000 elementos, el último sin anotar, ≤500 anotados)
- C11 Anotar antes de truncar y caber en 8192: [x] `result.test.ts` › "annotates before truncating, and still fits in 8192 bytes" (`truncated: true`, `bytes ≤ 8192`, `data_text` contiene el par starts_at/starts_at_local)
- C12 Regla nueva en el prompt tras la de ISO: [x] `prompt.test.ts` › "n13.9: tells the model to use the given weekday names, right after the ISO rule"
- C13 live-render sin cambio de comportamiento: [x] `live-render.test.ts` no está en el diff y pasa; `local-time.test.ts` › "localTime keeps the shape live-render relies on". La lógica movida es idéntica (diff línea a línea de `localTime`, sólo cambia `WEEKDAYS[...]` por `weekdayOf`, equivalente)
- C14 Sin import circular: [x] `local-time.ts` sólo importa `AI_TIMEZONE_MAX` de `./types`; `types.ts` sólo tiene `import type`; `prompt.ts` y `live-render.ts` importan de `local-time`, nunca al revés
- Verificación manual (playground Rehactive, 13-nov → «viernes 13», `create_appointment` recibe el `starts_at` original): guion presente en el informe; pendiente del humano

## Checkpoints
- CP1: [x] gate dirigido verde (lint/build completos no corridos por instrucción explícita del líder)
- CP2: n/a (sin SQL)
- CP3: n/a (sin consultas con `supabaseAdmin()`)
- CP4: [x] cada criterio con test leído
- CP5: [x] `package.json` sin cambios
- CP6: n/a (sin texto de UI)
- CP7: n/a (sin API de framework)
- CP8: [x] sólo `src/lib/ai/tools/*` y `CHANGELOG.md`, todos justificados por la nota
- CP9: [x] CHANGELOG (Unreleased) con entrada; sin variables de entorno nuevas; informe coincide con el diff
- CP10: [x] un commit en español con prefijo `fix:` y `Co-Authored-By`; no pusheado; `main` intacto en 4257fcc
- CP11: n/a

## Hallazgos (no bloqueantes)
1. `src/lib/ai/tools/result.ts:97` — `out[key] = …` sobre un objeto literal: si el remoto devuelve una clave propia `"__proto__"` (posible vía `JSON.parse`), la asignación cambia el prototipo de `out` en vez de crear la propiedad, y la clave desaparece del JSON que ve el modelo (comprobado con node). Antes de n13.9 `data` pasaba tal cual. Sin contaminación global (sólo el prototipo de `out`), pero es pérdida silenciosa de datos. Arreglo trivial: `const out: Record<string, unknown> = Object.create(null)` o `Object.defineProperty`. Recomendado en una ronda posterior.
2. `src/lib/ai/tools/result.ts:66` — el presupuesto de 500 cuenta elementos de array **y** claves de objeto; con slots de ~5 campos se anotan ~80 slots. En la práctica el truncado a 8192 bytes corta antes (~50 slots), así que no hay slots visibles sin `_local`. Ya anotado como deuda (tamaño) en el informe.
3. Contraste con `code-review` (high), llegado tras el veredicto; nada cambia el APPROVED porque todo cae dentro de lo que la nota pide o fuera de su alcance:
   - `src/lib/ai/tools/local-time.ts:131` — convierte a la zona de la integración aunque el valor traiga otro offset (p. ej. `-05:00`): es lo que pide la nota («en la zona de la integración»). Conviene vigilarlo si alguna integración devuelve horas de sedes en otra zona.
   - `src/lib/ai/tools/prompt.ts:44` — la regla dice que `_local` va «already in the local time of the integration», pero sin `ai_timezone` cae al offset del valor; si el remoto manda `Z`, el weekday será el UTC. Recomendado: o exigir zona, o matizar la regla. No bloqueante (Rehactive tiene zona).
   - `src/lib/ai/tools/result.ts:103` — fechas solas `YYYY-MM-DD` y strings ISO sueltos en arrays no se anotan, y la regla dice «come with every date». La nota sólo pide ISO con offset; recomendado matizar la regla en una ronda posterior.
   - `live-render.ts` fallback `compactJson` sin `_local`: fuera del alcance de n13.9 (camino Live data), deuda.
   - Duplicados menores (`isPlainObject` vs `isRecord`, doble `wallClockInZone` en el prompt, re-exports de compatibilidad): limpieza opcional.
