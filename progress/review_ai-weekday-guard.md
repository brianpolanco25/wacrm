# Review — n13.11 ai-weekday-guard

**Veredicto:** APPROVED (ronda 2, commit `9af3d5c`; ronda 1: CHANGES_REQUESTED)

Rama `feat/ai-weekday-guard`, commit `533a7d2`, base `main @ 57a98e6`. Spec = `note` de n13.11.

## Compuerta (dirigida, ejecutada por el reviewer)
- `npm run typecheck`: verde
- `npx eslint src/lib/ai/tools/`: verde
- `TZ=UTC npx vitest run src/lib/ai`: verde (48 archivos, 664 tests)
- `TZ=America/Santo_Domingo npx vitest run src/lib/ai`: verde (664)
- build / suite entera: no corridos (instrucción del líder)
- replay-migrations: n/a (sin SQL)

## Trazabilidad criterio ↔ test (tests leídos)
- C1 prompt: línea local con today/tomorrow/day after tomorrow, ANTES de la UTC: [x] `prompt.test.ts` › "n13.11: the local line carries…" (aserción literal de ambas líneas e índice local < utc, a 21:05 SD = viernes UTC)
- C2 regla «never to the UTC date»: [x] `prompt.test.ts` › "n13.11: relative days refer…"; sin zona no aparece: "without any zone…"
- C3 sin zona, prompt idéntico a n13.9: [x] por construcción (`prompt.ts:44-61`: sin líneas locales el orden queda cabecera + UTC, sin regla nueva) y los tests previos de prompt pasan sin cambios
- C4 `_local` (today)/(tomorrow)/(in 5 days)/tope 30/pasada sin etiqueta/sin now: [x] `result.test.ts` › describe "relative day of dates (n13.11)"
- C5 cruce de medianoche por zona: [x] `result.test.ts` › "counts calendar days in the zone, not UTC" (21:30 SD → «(today)»); `daysBetween` es por fecha de calendario (`local-time.ts:134`)
- C6 caso producción «Mañana jueves 13 de noviembre» → viernes: [x] `weekday-fix.test.ts` › "production case"
- C7 mayúscula, intacto, con/sin acento, año explícito, vuelta de año, inglés, «mañana jueves», «hoy jueves», fecha inválida, precios/horas, sin fechas: [x] `weekday-fix.test.ts` (un `it` por caso)
- C8 loop e2e auto_reply + warn, draft, HANDOFF intacto: [x] `loop.test.ts` › describe "weekday guard (n13.11)"
- C9 CHANGELOG Unreleased: [x]

## Checkpoints
- CP1 Compuerta: [x] dirigida (ver arriba); completa no corrida por instrucción
- CP2 Migraciones: [x] n/a
- CP3 Aislamiento: [x] n/a (sin consultas nuevas)
- CP4 Tests: [x] todos los criterios de la nota cubiertos; [ ] faltan casos negativos que hoy fallan (hallazgos 1-3)
- CP5 Sin dependencias: [x]
- CP6 i18n: [x] n/a (sin UI)
- CP7 Next 16: [x] n/a
- CP8 Alcance: [x] solo `src/lib/ai/tools/` + CHANGELOG
- CP9 Documentación: [x] CHANGELOG + informe coherente con el diff
- CP10 Git: [x] un commit en la rama, español, `Co-Authored-By` presente (dice «Claude Fable 5.1»; el líder decide)
- CP11 Entrante: [x] no afecta

## Verificado sin problema (puntos pedidos por el líder)
Probado con un test temporal (borrado) contra `fixWeekdays`, today = 2026-11-12:
- Intactos: «por la mañana jueves», «esta mañana jueves», «en la mañana jueves», «Santo Domingo», «mañana le confirmo», «Horario: lunes a viernes de 7:00 a.m. a 5:00 p.m.», «De lunes a viernes 8 de la mañana», «el sábado 14», «RD$3,000», «2:30 p.m.», «13 de noviembre», «jueves 29 de febrero», «Hoy:jueves», «jueves13 de noviembre».
- Mapa de índices: correcto con emojis fuera del BMP («🗓️ Jueves 13 de noviembre 👍» → «🗓️ Viernes …»; `normalize` itera unidades UTF-16 y un surrogate suelto mapea 1:1), con tildes descompuestas («Miércoles 13 de noviembre» → «Viernes 13 de noviembre», sin dejar la marca combinante colgando) y con «İ» (que crece al pasar a minúscula).
- Año: 60 días y fecha inválida según la nota (31-nov intacto; 29-feb solo si vale el año siguiente).
- loop.ts: el `return` de HANDOFF_SENTINEL (`loop.ts:287`) no pasa por el guard; un texto que contiene el sentinel tampoco (`loop.ts:131`). Aplica en auto_reply y draft (mismo `return`, `loop.ts:294`).
- prompt.ts: locales antes de UTC; sin zona, byte a byte n13.9.

## Hallazgos (archivo:línea)
1. `src/lib/ai/tools/weekday-fix.ts:103` (RELATIVE_RE) — `[,:]?\s+` toma como aposición la primera palabra de una lista o rango de días y la reescribe. Falsos positivos reales, today = jueves 2026-11-12:
   - «A partir de mañana, lunes a viernes, atendemos de 8:00 a.m. a 5:00 p.m.» → «…mañana, viernes a viernes…» (comprobado con «mañana lunes a viernes atendemos» → «mañana viernes a viernes atendemos»).
   - «Tenemos espacio hoy, lunes y sábado» → «hoy, jueves y sábado» (el lunes desaparece).
   Es un horario/lista, no una fecha: no se debe tocar.
2. `src/lib/ai/tools/loop.ts:132-135` — sin integración con `timezone` válida, el guard usa la fecha UTC para hoy/mañana. `ai_timezone` es nullable. De 20:00 a 24:00 en Santo Domingo, un correcto «mañana viernes» (jueves 21:00 local) se reescribe a «mañana sábado». El guard introduce el error que n13.11 quiere quitar. La nota dice «si ninguna, UTC», pero el resultado contradice el objetivo de la feature: sin zona conocida, el patrón (b) relativo no debe aplicarse (el (a) con fecha explícita no depende de la zona salvo en la inferencia de año, y puede quedarse).
3. `src/lib/ai/tools/weekday-fix.ts:218-267` (decisión 1 del informe: «(a) gana sobre (b)») — cuando el relativo y la fecha explícita no concuerdan, se ajusta el weekday a un número de día equivocado: «mañana viernes 14 de noviembre» (weekday correcto, número mal) → «mañana sábado 14 de noviembre». Un error de un dígito se vuelve una fecha errónea pero coherente, y el cliente va el sábado. Si (a) y (b) dan días distintos para el mismo weekday, no tocar (y registrar el warn).
4. `src/lib/ai/tools/weekday-fix.ts:91` — año explícito sin rango: «viernes 13 de noviembre de 1500 pesos» → «martes 13 de noviembre de 1500 pesos». Limitar el año explícito a, p. ej., today.year-1 … today.year+2; fuera de ese rango, no tocar.
5. `src/lib/ai/tools/weekday-fix.ts:98` (menor) — EN_MONTH_DAY_RE acepta el verbo «may» como mes: «Friday may 3 people join?» → «Monday may 3 people join?». Exigir «May» con mayúscula en el original o excluir `may` seguido de no-número.
6. `src/lib/ai/tools/weekday-fix.ts:245` (menor) — `re.lastIndex = 0` no hace nada con `matchAll`; quitarlo.

## Cambios requeridos
1. (H1) No aplicar el patrón relativo si el weekday va seguido de `\s+(a|al|hasta|y|o|and|or|to|through)\s+` + otro weekday (o, más simple, de `a|al|hasta|y|o|,` + weekday). Tests: «A partir de mañana, lunes a viernes, …» y «hoy, lunes y sábado» intactos.
2. (H2) En `guardWeekdays`, sin zona válida no aplicar el patrón (b) (p. ej. `fixWeekdays(text, today, { relative: false })`). Test en loop.test.ts: integración sin zona, 21:00 SD, «mañana viernes» intacto.
3. (H3) Si (a) y (b) cubren el mismo weekday y dan días distintos, no tocar. Test: «mañana viernes 14 de noviembre» intacto con today 2026-11-12.
4. (H4) Rango de año explícito plausible; test con «de 1500 pesos».
5. (H5, H6) opcionales.

## Deuda fuera de alcance (no bloquea; anotar)
- `src/lib/ai/generate.ts:94`: la ruta sin herramientas no pasa por el guard (la nota acota a loop.ts).
- El bloque «Live data» (`live-render.ts`, cabeceras por día) no lleva «(tomorrow)», aunque la regla nueva del prompt dice que los resultados lo marcan; solo los `_local` de herramientas lo llevan.
- Con varias integraciones en zonas distintas, el guard usa la primera con zona (la nota lo fija así).

## Ronda 2 — commit `9af3d5c`

**Veredicto:** APPROVED

### Compuerta (dirigida, ejecutada por el reviewer)
- `npm run typecheck`: verde
- `npx eslint src/lib/ai/tools/`: verde
- `TZ=UTC npx vitest run src/lib/ai`: verde (48 archivos, 671 tests)
- `TZ=America/Santo_Domingo npx vitest run src/lib/ai`: verde (671)

### Hallazgos de ronda 1, verificados con test temporal (borrado) contra `fixWeekdays`, today = 2026-11-12
- H1 [x] `weekday-fix.ts:110` `LIST_AFTER_RE`. Intactos: «A partir de mañana, lunes a viernes, atendemos de 8:00 a.m. a 5:00 p.m.», «Tenemos espacio hoy, lunes y sábado», «mañana lunes a viernes atendemos», «hoy lunes, martes y miércoles», «hoy, lunes al viernes». «mañana, lunes» sí se corrige. Test: `weekday-fix.test.ts` › "H1: a list or range…".
- H2 [x] `loop.ts:133-140`: sin zona válida, `relative: false`. «mañana viernes» con `relative:false` intacto; la fecha explícita sigue corrigiéndose. Test e2e: `loop.test.ts` › "H2: without a valid zone…" (21:00 SD, integración sin zona).
- H3 [x] `weekday-fix.ts:327-338`: «mañana viernes 14 de noviembre» intacto, `conflicts=1`; el caso de producción (ambos concuerdan) se sigue corrigiendo. Warn propio `'[ai weekday-fix]', accountId, 'conflict', n`. Tests: `weekday-fix.test.ts` › "H3…" y `loop.test.ts` › "H3: a disagreement…".
- H4 [x] `weekday-fix.ts:161-166`: «viernes 13 de noviembre de 1500 pesos» intacto; «jueves 13 de noviembre de 2026» → viernes. Test "H4…".
- H5 [x] `weekday-fix.ts:262-268`: «Friday may 3 people join?» intacto; «Friday, May 3» → «Monday, May 3». Test "H5…".
- H6 [x] `re.lastIndex = 0` eliminado.
- Regresión de ronda 1: emoji, tildes descompuestas, «por la mañana, jueves 13 de noviembre», horario sin relativo: igual que en ronda 1 (correcto).

### Observaciones menores (no bloquean)
1. `weekday-fix.ts:110` — el conector seguido de artículo no cuenta como lista: «mañana lunes y el viernes» → «mañana viernes y el viernes». Frase rara; se podría admitir `(?:el\s+|the\s+)?` antes del segundo weekday.
2. `fixWeekdays` en minúscula «friday may 3» (fin de texto) → «monday may 3»: se trata como mes, según la regla elegida. Correcto.
3. Commit con `Co-Authored-By: Claude Fable 5.1`; el líder decide.

### Deuda (sin cambios desde ronda 1)
- `generate.ts` sin herramientas no pasa por el guard; «Live data» sin marca «(tomorrow)»; varias zonas → usa la primera.
