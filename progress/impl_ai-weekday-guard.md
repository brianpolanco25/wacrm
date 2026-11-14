# impl n13.11 `ai-weekday-guard`

- Rama: `feat/ai-weekday-guard` (worktree `.claude/worktrees/ai-weekday-guard`, desde `main @ 57a98e6`)
- Commit: `533a7d2` fix: la IA ya no dice «mañana jueves 13» cuando mañana es viernes (n13.11)
- Sin spec (especificación en `note` de n13.11). Sin migración, sin dependencias, sin variables de entorno nuevas.

## Plan

1. local-time.ts: helpers de fecha de calendario (`CalendarDate`, `formatDate`, `addDays`, `daysBetween`, `todayInZone`, `relativeDayLabel`) y `localLabel(value, tz, now?)` con día relativo.
2. prompt.ts: líneas locales antes de la UTC, con hoy/mañana/pasado; regla de días relativos.
3. result.ts: `annotateLocalDates` / `toolResultPayload` reciben `now` opcional.
4. weekday-fix.ts nuevo y puro: `fixWeekdays(text, today)`.
5. loop.ts: `now` a `toolResultPayload`; `fixWeekdays` sobre el texto final + `console.warn('[ai weekday-fix]', accountId, fixes)`.
6. Tests y CHANGELOG.

## Cambios por archivo

- `src/lib/ai/tools/local-time.ts`: helpers anteriores; `localLabel` con `now` inserta `(today|tomorrow|in N days)` tras la fecha si 0 ≤ diff ≤ 30. Diff en días de calendario: «hoy» en la zona de la integración; sin zona válida, «hoy» en el offset del propio valor.
- `src/lib/ai/tools/prompt.ts`: por integración con zona: `- <name>: local time is <Weekday> <iso> (<tz>). Today is …; tomorrow is …; the day after tomorrow is ….`; luego la línea `Current date and time … (UTC)`. Regla nueva (solo si hay alguna línea local), justo tras la de weekday: `today/tomorrow/the day after tomorrow (hoy/mañana/pasado mañana) refer to those local dates of the integration, never to the UTC date. Tool results also mark them, e.g. "(tomorrow)" in a _local field.`
- `src/lib/ai/tools/result.ts`: parámetro `now?: Date` en `annotateLocalDates` y `toolResultPayload` (5º); sin él, comportamiento n13.9.
- `src/lib/ai/tools/weekday-fix.ts` (nuevo): patrones es (`<wd>[,] [el] <d> de <mes> [de|del <año>]`), en (`<wd>[,] [the] <d>[ord] [of] <month>[, <año>]` y `<wd>[,] <month> <d>[ord][, <año>]`), relativos (`pasado mañana|mañana|hoy|today|tomorrow` + `[,:]` + `[el]` + wd). Detección sobre copia normalizada (minúsculas, sin diacríticos) con mapa de índices al original; sustituye solo el weekday, en su idioma (es con tildes: miércoles, sábado), conservando Mayúscula inicial o TODO MAYÚSCULAS.
- `src/lib/ai/tools/loop.ts`: `guardWeekdays` (zona de la primera integración con `timezone` válida, si no UTC) aplicado en el `return` de texto final; el `return` de traspaso por grounding devuelve `HANDOFF_SENTINEL` sin tocar, y un texto que contiene `HANDOFF_SENTINEL` tampoco se toca. `toolResultPayload(..., new Date(now()))`.
- Tests: `weekday-fix.test.ts` (nuevo), `result.test.ts`, `prompt.test.ts`, `loop.test.ts`.
- `CHANGELOG.md`: entrada en Unreleased.

## Criterio ↔ test

| Criterio (note) | Test |
|---|---|
| Línea local con today/tomorrow/day after tomorrow, ANTES de la UTC | prompt.test.ts › `n13.11: the local line carries today, tomorrow and the day after tomorrow, before the UTC line` |
| Regla «refer to those local dates…, never to the UTC date» | prompt.test.ts › `n13.11: relative days refer to the local dates, never UTC`; sin zona no aparece: `n13.11: without any zone, the UTC line alone and no relative rule` |
| `_local` con (today) | result.test.ts › `(today)` |
| (tomorrow) | result.test.ts › `(tomorrow)` |
| (in 5 days), tope 30 | result.test.ts › `(in 5 days) and up to 30` |
| Pasada sin etiqueta | result.test.ts › `a past date has no relative label` |
| Sin `now`, sin etiqueta | result.test.ts › `without now there is no relative label (old call sites)` |
| Cruce de medianoche por zona (21:30 SD = Friday UTC → «(today)») | result.test.ts › `counts calendar days in the zone, not UTC: 21:30 in Santo Domingo is still today` |
| Sin zona: hoy en el offset del valor | result.test.ts › `without a zone, today is the one at the offset of the value` |
| `annotateLocalDates` acepta now | result.test.ts › `annotateLocalDates takes now too` |
| Caso producción «Mañana jueves 13 de noviembre» → viernes | weekday-fix.test.ts › `production case: «Mañana jueves 13 de noviembre» → viernes` |
| «Jueves 13…» → «Viernes 13…» (mayúscula) | › `keeps the capital letter` (+ `keeps all caps`) |
| «viernes 13 de noviembre» intacto | › `a right weekday is left intact` |
| «miércoles 12 de noviembre» con y sin acento | › `detects with and without accent` |
| Año explícito (lunes 15 / martes 16 dic 2025 intactos) | › `uses the explicit year` |
| Vuelta de año (today 2026-12-28, «lunes 4 de enero» intacto, «martes» → «lunes») | › `a date more than 60 days back is next year (year turn)`; ventana: `a date less than 60 days back stays in this year` |
| Inglés «Thursday, November 13» y «Thursday 13 November» | › `«Thursday, November 13» → Friday`, `«Thursday 13 November» and ordinals` |
| «mañana jueves» → «mañana viernes» | › `«mañana jueves» → «mañana viernes»` |
| «hoy jueves» intacto | › `«hoy jueves» is intact` |
| Fecha inválida intacta | › `an invalid date is left intact` |
| «RD$4,000» y «a las 2:00 p.m.» intactos | › `prices and times are intact` |
| Sin fechas → fixes=0, mismo string | › `a text without dates → same string, 0 fixes` |
| Loop e2e: «Mañana jueves 13 de noviembre a las 2:00 p.m.», now 2026-11-12T15:00-04:00, SD → «viernes» + warn | loop.test.ts › `fixes the weekday of the final text and warns, in auto_reply` |
| Aplica también en draft | loop.test.ts › `also in draft` |
| HANDOFF_SENTINEL intacto | loop.test.ts › `the handoff text is never touched` |
| Extras | loop.test.ts › `uses the local date of the zone, not UTC, late at night`, `a right text is returned as is, without a warning`, `tool results carry the relative day of the turn`; weekday-fix.test.ts › pasado mañana, «tomorrow, Thursday», «la/esta mañana», varias fechas, emoji |

## Compuerta dirigida (worktree)

- `npm run typecheck` → OK (sin errores).
- `npx eslint src/lib/ai/tools/` → OK.
- `TZ=UTC npx vitest run src/lib/ai` → 48 archivos, 664 tests, todos verdes. También verde con `TZ=America/Santo_Domingo`.
- `npx prettier --write` sobre los 9 archivos tocados.
- No se corrió build ni la suite entera (instrucción del líder). Sin SQL: no aplica replay-migrations.

## Decisiones (donde la nota era ambigua)

1. **(a) gana sobre (b)**: si un mismo weekday está a la vez junto a una fecha explícita y tras «mañana/hoy», manda la fecha explícita (es lo más específico). En el caso de producción ambas coinciden.
2. **«la mañana» / «esta mañana»** no cuentan como «mañana» (= tomorrow): «por la mañana, viernes» habría corregido mal. Lookbehind `(?<!(la|esta)\s+)`.
3. **Año**: explícito si lo hay; si no, el de hoy salvo que quede >60 días antes de hoy → año siguiente. Si el día no existe en el año de hoy (29 feb) se prueba el siguiente; si tampoco, no se toca.
4. **Forma**: Mayúscula inicial y TODO MAYÚSCULAS se conservan; el reemplazo en español lleva tildes canónicas (miércoles, sábado) aunque el original no las tuviera.
5. **«(in N days)»** se inserta tras la fecha: `Friday 2026-11-13 (tomorrow) 14:00 (-04:00)` (formato literal de la nota).
6. **Sin zona** en la integración, «hoy» para la etiqueta relativa es el del offset del propio valor (coherente con el `_local` de n13.9 sin zona).
7. **Regla del prompt** solo se emite si hay al menos una línea local (sin zona no hay «those local dates»). Texto añade `the day after tomorrow`/`pasado mañana` y la mención a «(tomorrow)» en `_local`.
8. **loop.ts**: la nota habla de «los dos `return` que devuelven texto»; en `runToolLoop` solo hay uno de texto libre más el de traspaso por grounding (que devuelve el sentinel). Se aplica al de texto y además se protege un texto del modelo que contenga `HANDOFF_SENTINEL`.
9. Test n13.9 de loop (`annotates tool results in the time zone of the integration`) ahora inyecta `now` fijo (2027-01-01) para que la etiqueta relativa no dependa del reloj real (hoy es 2026-11-12 y la fecha del test es mañana).

## Dudas / deuda fuera de alcance

- Línea de co-autoría: usé `Claude Fable 5.1` como pidió el líder y la definición del agente; el recordatorio del sistema sugería otra (`Claude Opus 5.5`). El líder decide si enmienda.
- `fixWeekdays` no cubre meses abreviados («13 nov», «Nov 13») ni formatos numéricos («13/11»); la nota no los pedía.
- La generación sin herramientas (`generate.ts` sin toolset) no pasa por el guard: la nota acota a loop.ts.
- Verificación manual pendiente (servicio externo): en producción Rehactive, preguntar de noche (después de las 20:00 SD) «¿tienen cita mañana?» y comprobar que Aura nombra bien el día y que, si se equivoca, el log muestra `[ai weekday-fix] <account> N`.

## Ronda 2 (tras `review_ai-weekday-guard.md`, CHANGES_REQUESTED)

Commit `9af3d5c` (nuevo, sin amend) sobre `533a7d2`.

### Cambios

- `weekday-fix.ts`
  - H1: `LIST_AFTER_RE`: el patrón relativo se descarta si tras el weekday viene `, ` y/o un conector (`a|al|hasta|y|o|and|or|to|through`) y otro weekday.
  - H2: `fixWeekdays(text, today, { relative?: boolean })` (por defecto `true`); con `false` solo actúan los patrones de fecha explícita.
  - H3: (a) y (b) se recogen por separado; si cubren el mismo weekday y discrepan, no se toca y se cuenta en `conflicts` (nuevo campo del resultado: `{ text, fixes, conflicts }`). Si coinciden, se aplica (caso de producción).
  - H4: año explícito aceptado solo en `today.year-1 … today.year+2`; fuera, la fecha se ignora.
  - H5: en los patrones en inglés, `may` en minúscula en el original y seguido (tras el match) de una palabra se considera verbo y se ignora. `May` con mayúscula o seguido de puntuación/fin sí es mes.
  - H6: quitado `re.lastIndex = 0`.
- `loop.ts` (`guardWeekdays`): sin integración con zona válida usa UTC y `relative: false`. Warn: `console.warn('[ai weekday-fix]', accountId, fixes)` si fixes>0 (igual que ronda 1) y, aparte, `console.warn('[ai weekday-fix]', accountId, 'conflict', conflicts)` si conflicts>0. Decisión: los conflictos se registran en una línea propia para no mezclarlos con correcciones.

### Tests nuevos

| Hallazgo | Test |
|---|---|
| H1 | weekday-fix.test.ts › `H1: a list or range of days after a relative day is intact` («A partir de mañana, lunes a viernes, atendemos de 8:00 a.m. a 5:00 p.m.», «Tenemos espacio hoy, lunes y sábado», «desde mañana lunes hasta viernes», «mañana, lunes, martes o miércoles», «tomorrow, Monday through Friday», «today Monday or Saturday» intactos; «mañana, lunes» sí se corrige) |
| H2 | weekday-fix.test.ts › `H2: relative: false only fixes explicit dates`; loop.test.ts › `H2: without a valid zone, a relative day is not touched at night` (integración sin zona, 21:00 SD, «mañana viernes» intacto; la fecha explícita de la misma frase sí se corrige) |
| H3 | weekday-fix.test.ts › `H3: explicit date and relative day disagree → intact, counted` («mañana viernes 14 de noviembre» y «mañana jueves 12 de noviembre» intactos, conflicts=1); loop.test.ts › `H3: a disagreement is left as is and warned as conflict` |
| H4 | weekday-fix.test.ts › `H4: an implausible explicit year is not a year` («viernes 13 de noviembre de 1500 pesos» intacto; 2029 fuera de rango; 2028 dentro, se corrige) |
| H5 | weekday-fix.test.ts › `H5: lowercase «may» followed by a word is the verb` |

Tests de ronda 1 ajustados solo para el nuevo campo `conflicts` en los `toEqual`.

### Compuerta dirigida

- `npm run typecheck` → OK.
- `npx eslint src/lib/ai/tools/` → OK.
- `TZ=UTC npx vitest run src/lib/ai` → 671/671 verdes; `TZ=America/Santo_Domingo` → 671/671 verdes.
- `npx prettier --check src/lib/ai/tools CHANGELOG.md` → OK.

### Deuda anotada por el reviewer (fuera de alcance, sin tocar)

- `generate.ts` sin herramientas no pasa por el guard.
- El bloque «Live data» (`live-render.ts`) no marca «(tomorrow)» aunque la regla del prompt menciona la marca en los `_local` (la regla habla de los `_local` de herramientas; puede leerse como extensible).
- Varias integraciones en zonas distintas: el guard usa la primera con zona.
