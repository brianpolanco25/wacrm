# impl n13.9 ai-tool-dates-weekday

## Plan
1. Nuevo `src/lib/ai/tools/local-time.ts`: primitivas de zona (isValidTimeZone, offsetLabel, wallClockInZone, formatNowInZone, se re-exportan desde prompt.ts) + WEEKDAYS, ISO_WITH_OFFSET_RE, isIsoWithOffset, localTime, formatLocalLabel.
2. live-render.ts importa localTime/isIsoWithOffset de ahí (sin cambio de comportamiento).
3. prompt.ts: weekday en línea UTC y en líneas locales; regla nueva tras la de ISO 8601.
4. result.ts: anotación `<clave>_local` recursiva (prof. 6, 500 elementos) antes del truncado; parámetro opcional timeZone; loop.ts lo pasa desde la integración del tool.
5. Tests: local-time.test.ts, prompt.test.ts, result.test.ts, loop (si aplica).
6. CHANGELOG.

## Resultado

- Rama `feat/ai-tool-dates-weekday` (worktree `.claude/worktrees/ai-tool-dates-weekday/`), desde `main @ 4257fcc`.
- Commit: `ac6bc6e` fix: el día de la semana de las fechas lo calcula el código, no la IA (n13.9). Sin push ni merge.
- Sin migración, sin dependencias, sin variables de entorno nuevas.

## Cambios

| Archivo | Qué |
|---|---|
| `src/lib/ai/tools/local-time.ts` (nuevo) | `WEEKDAYS`, `ISO_WITH_OFFSET_RE`, `isIsoWithOffset`, `localTime` (sacados de live-render), `isValidTimeZone`/`offsetLabel`/`wallClockInZone`/`formatNowInZone` (movidos desde prompt.ts), y nuevos `weekdayOf`, `weekdayInZone`, `localLabel` (`Friday 2026-11-13 14:00 (-04:00)`). |
| `src/lib/ai/tools/prompt.ts` | Re-exporta las primitivas (los imports existentes desde `./prompt` siguen valiendo; así no hay ciclo prompt↔local-time). Línea `Current date and time: <Weekday> <utc> (UTC).` y `- <int>: local time is <Weekday> <local> (<tz>).` Regla nueva justo tras la de ISO 8601: «Weekday names come with every date: in the current-time lines above and in tool results (fields ending in _local, already in the local time of the integration). Use those names; never work out a weekday yourself.» |
| `src/lib/ai/tools/live-render.ts` | Importa `localTime`/`isIsoWithOffset`/`LocalTime`/`formatNowInZone` de `local-time`; comportamiento idéntico (sus tests, sin tocar, en verde). |
| `src/lib/ai/tools/result.ts` | `annotateLocalDates(data, tz)` exportada: copia recursiva que añade `<clave>_local` por cada valor ISO con offset dentro de objetos; no toca el original ni sobrescribe una `<clave>_local` existente; topes profundidad 6 y 500 elementos visitados (presupuesto compartido: elementos de array + claves de objeto). `toolResultPayload` gana 4º parámetro opcional `timeZone` (default `null` → offset del propio valor); se anota ANTES de medir/truncar a 8192. |
| `src/lib/ai/tools/loop.ts` | Mapa slug→timezone de `args.toolset.integrations`; pasa la zona del `tool.integrationSlug` a `toolResultPayload`. |
| `CHANGELOG.md` | Entrada «Fix: the AI no longer gets the weekday of a date wrong» bajo Unreleased. |

## Criterio ↔ test

| Criterio | Test |
|---|---|
| `2026-11-13T14:00:00-04:00` + Santo Domingo → `Friday 2026-11-13 14:00 (-04:00)` | `local-time.test.ts` «Friday 13 in Santo Domingo (the production bug)»; `result.test.ts` «adds <key>_local next to an ISO date, leaving the value intact» |
| Cruce de medianoche (Madrid → sábado 14) | `local-time.test.ts` «crosses midnight when the zone changes the day»; `result.test.ts` «uses the integration zone, crossing midnight»; `loop.test.ts` «annotates tool results in the time zone of the integration» (extremo a extremo por el bucle) |
| Sin zona válida → offset del valor | `local-time.test.ts` «without a valid zone, uses the offset of the value itself»; `result.test.ts` «without a zone, uses the offset of the value (old call sites)» |
| Valor original intacto / input no mutado | `result.test.ts` «adds <key>_local…», «walks nested arrays and objects; leaves non-ISO strings and the input alone» |
| No sobrescribe `<clave>_local` | `result.test.ts` «never overwrites an existing <key>_local» |
| Arrays anidados | `result.test.ts` «walks nested arrays and objects…» |
| Topes | `result.test.ts` «stops at the depth cap», «stops at the item cap» |
| Truncado ≤ 8192 con anotaciones | `result.test.ts` «annotates before truncating, and still fits in 8192 bytes» (+ el test de truncado previo sigue verde) |
| Línea del prompt con weekday (UTC y local, incl. día distinto) | `prompt.test.ts` «states UTC and the local time of each integration with a zone» (actualizado), «n13.9: the weekday is the local one when the zone is on another day» |
| Regla nueva tras la de ISO | `prompt.test.ts` «n13.9: tells the model to use the given weekday names, right after the ISO rule» |
| live-render sin cambio | `live-render.test.ts` sin modificar, verde |

## Compuerta

- `npm run typecheck` → OK.
- `npx eslint src/lib/ai/tools/` → OK.
- `npx vitest run src/lib/ai` → 47 archivos, 623 tests OK.
- `TZ=UTC npm test` (suite completa, 25 s) → 392 archivos OK (1 skipped), 6133 tests OK.
- `npm run build` no ejecutado (no pedido; cambio puro en `src/lib`, typecheck cubre).
- `npx prettier --write` sobre todo lo tocado.

## Decisiones

- Las primitivas de zona se movieron a `local-time.ts` y `prompt.ts` las re-exporta, para evitar un import circular (prompt necesita el weekday y local-time necesitaba `wallClockInZone`).
- Strings ISO sueltos dentro de un array (sin clave) no se anotan: no hay dónde poner el hermano.
- Solo se anotan payloads de éxito; los errores (`remoteError`) no.
- El weekday UTC de la línea «Current date and time» se calcula con `weekdayInZone(now,'UTC')`.

## Verificación manual pendiente

- En el playground de Rehactive, pedir disponibilidad para el 13-nov-2026: la respuesta debe decir «viernes 13». Y comprobar en el trail que `create_appointment` recibe el `starts_at` original (sin `_local`).

## Deuda fuera de alcance

- El cambio aumenta el tamaño de los resultados (~45 bytes por fecha), así que listas largas de `find_availability` se truncarán antes que hoy; si molesta, considerar compactar el resultado (p. ej. reutilizar el agrupado por día de live-render) en vez de JSON crudo.
- `node_modules` del worktree es un symlink al checkout principal (ignorado por git).
