# Review — n13.12 ai-reply-cut

**Veredicto (ronda 2):** APPROVED

## Ronda 2

Commit `d51aa95` sobre `2911833`. Solo toca `trimDanglingFragment` (`src/lib/ai/providers/gemini.ts:80-86`) y sus casos en `gemini.cut.test.ts`.

### Compuerta (dirigida, en el worktree)
- typecheck: verde · `npx eslint src/lib/ai`: verde · `TZ=UTC npx vitest run src/lib/ai`: verde (62 archivos, 820 tests).

### Hallazgos 1 y 2: resueltos
Regex nuevo: `/(?<!^[ \t]*\d+|\b(?:Dra?|Sra?))[.!?…][)"'»”*_]*(?=\s|$)/gm`. Lo probé yo (copia literal) con la tabla de la ronda 1 y con casos nuevos:

| entrada (cortada) | salida | |
|---|---|---|
| `Tenemos:\n1. Fisioterapia\n2. Masaje terap` | `Tenemos:\n1. Fisioterapia` | ok |
| `Tenemos:\n1. Fisioterapia\n2.` (marcador solo al final) | `Tenemos:\n1. Fisioterapia` | ok |
| `Tenemos:\n1.` / `1.` | `Tenemos:` / `''` | ok |
| `1. Fisioterapia\n2. Masa` (solo lista) | `1. Fisioterapia` | ok |
| `  10. Item diez\n  11. Ite` | `10. Item diez` | ok |
| `Opciones:\n- Fisioterapia\n- Masa` / `Opciones:\n- Fisio\n-` / `Opciones:\n•` | se queda en la última línea completa | ok |
| `• Lunes\n• Mar` / `✅ Evaluación\n✅ Terap` / `1️⃣ Evaluación\n2️⃣` | `• Lunes` / `✅ Evaluación` / `1️⃣ Evaluación` | ok |
| `1) Evaluación\n2) Tera` | `1) Evaluación` | ok |
| `Te atiende la Dra. Pérez el lun` / `Hola. Te atiende el Sr. Gómez y` | `''` / `Hola.` | ok |
| `*Gracias por escribir.* Te cuen` / `_Listo._ Y lue` | `*Gracias por escribir.*` / `_Listo._` | ok |
| `RD$ 4,000.00 por ses` / `cuesta RD$ 4,000.00. Incluye eval` | `''` / `…RD$ 4,000.00.` | ok |
| `Son 3. Te esp` / `Cuesta 2500. Te esp` (número a mitad de línea) | `Son 3.` / `Cuesta 2500.` | ok |
| `Te espero a las 2:00 p.m. para la eval` | `Te espero a las 2:00 p.m.` | aceptable |
| `¡Claro! 🙏 Te esp` / `Gracias 🙏. Te esp` / `Perfecto 😊\n\n¿Te` | `¡Claro!` / `Gracias 🙏.` / `Perfecto 😊` | ok |
| `*1.* Evaluación\n*2.* Tera` | `*1.* Evaluación\n*2.*` | colgante (menor) |
| `Hola. Atiende la Lic. Gómez y` | `Hola. Atiende la Lic.` | colgante (menor, declarado) |

Los tests añadidos (`gemini.cut.test.ts › trimDanglingFragment`, 19 casos) cubren lista numerada, marcador final, Dra./Sr., negrita/cursiva, precios, horas, viñeta `-` y emoji; los leí y comprueban la salida exacta.

### Residuales (no bloqueantes)
1. `gemini.ts:82` — un número de lista en negrita (`*2.*`) al inicio de línea sigue contando como final de frase: el lookbehind exige dígito justo tras el inicio de línea. Si aparece en logs, excluir también `^[ \t]*[*_]\d+`.
2. `gemini.ts:82` — abreviaturas fuera de `Dr/Dra/Sr/Sra` (`Lic.`, `Ing.`, `Lcda.`) cortan mal; aceptado como fallback.
3. Hallazgos 3–5 de la ronda 1 siguen informativos: vuelta intermedia cortada en el bucle de herramientas (comportamiento previo), coste peor caso ≈9× por llamada y riesgo de `timeout` con razonamiento largo dentro del `after()` del webhook (`maxDuration = 60`). El guion manual (repetir los dos mensajes en el playground con gemini-3.5-flash y mirar el warn y la latencia) sigue pendiente de Brian.

---

## Ronda 1 (histórico)

**Veredicto (ronda 1):** CHANGES_REQUESTED


Rama `fix/ai-reply-cut`, commit `2911833` sobre main @ 5ca5af3. Diff: 7 archivos, todos en `src/lib/ai/` + CHANGELOG (dentro del alcance de la nota).

## Compuerta (dirigida, en el worktree)
- typecheck: verde
- `npx eslint src/lib/ai`: verde
- `TZ=UTC npx vitest run src/lib/ai`: verde (62 archivos, 809 tests)
- replay-migrations: n/a (sin SQL). Build y compuerta completa no corridos (por instrucción).

## Trazabilidad encargo ↔ test (`src/lib/ai/providers/gemini.cut.test.ts`)
- (1) Presupuesto propio de Gemini en los dos call sites, OpenAI/Anthropic intactos: [x] "sends the Gemini budget, not the shared one" (×2, generateGemini y generateGeminiWithTools). `MAX_OUTPUT_TOKENS` sigue en 1024 en openai/anthropic (grep).
- (2) Recorte en MAX_TOKENS, «…sesiones.\n\n¿» → «…sesiones.»: [x] "cuts a MAX_TOKENS reply back to the last whole sentence and warns" (×2) + `trimDanglingFragment` (8 casos). Texto completo intacto: [x] "keeps a MAX_TOKENS reply that already ends on a sentence". Vacío → empty_response: [x] "maps a MAX_TOKENS fragment with no whole sentence to empty_response". **Pero ver hallazgo 1: el helper deja pasar un fragmento colgante en listas numeradas.**
- (3) warn con modelo, finishReason y thoughtsTokenCount si != STOP: [x] mismo test, `toHaveBeenCalledWith(..., {model, finishReason, thoughtsTokenCount: 900})`; sin warn en STOP: [x].
- (4) Camino sin tools filtra `thought === true`: [x] "keeps a STOP reply whole, without thought parts, and does not warn" corre también contra `generateGemini` con un part `thought: true`.
- CHANGELOG bajo Unreleased: [x].
- Verificación real con gemini-3.5-flash: [ ] pendiente manual, declarado en el informe (repetir los dos mensajes del reporte en el playground y mirar el warn en logs). Aceptable como guion; no bloquea.

## Checkpoints
- Aislamiento `account_id`: [x] n/a (no hay consultas a BD).
- Migraciones: [x] n/a.
- Sin dependencias nuevas: [x].
- i18n: [x] n/a (sin claves).
- Convenciones Next 16: [x] n/a (sin código de framework).
- Alcance: [x] solo gemini.ts, defaults.ts, sus tests y CHANGELOG.
- Tests leídos y prueban lo que dicen: [x], salvo el hueco de casos del hallazgo 1.

## Hallazgos (archivo:línea)
Probé el helper (copia literal) con casos reales de WhatsApp en español:

| entrada (cortada) | salida |
|---|---|
| `Tenemos:\n1. Fisioterapia\n2. Masaje terap` | `Tenemos:\n1. Fisioterapia\n2.` ← colgante |
| `Te atiende la Dra. Pérez el lun` | `Te atiende la Dra.` ← colgante |
| `*Gracias por escribir.* Te cuen` | `''` → empty_response (se pierde una frase completa) |
| `Precio: RD$ 4,000.00 por ses` | `''` (correcto: no hay frase completa) |
| `La sesión cuesta RD$ 4,000.00. Incluye eval` | `La sesión cuesta RD$ 4,000.00.` (ok) |
| `Te espero a las 2:00 p.m. para la eval` | `Te espero a las 2:00 p.m.` (aceptable) |
| `- Lunes 9:00 a.m.\n- Martes 10:0` | `- Lunes 9:00 a.m.` (ok) |
| `Perfecto 😊\n\n¿Te` | `Perfecto 😊` (ok) |

1. `src/lib/ai/providers/gemini.ts:80` — **bloqueante.** El regex `/[.!?…][)"'»”]*(?=\s|$)/` toma el punto de un marcador de lista numerada (`2.` seguido de espacio o fin) como final de frase. Un corte dentro de cualquier ítem de una lista numerada (formato habitual en respuestas de Aura) envía `…\n2.` al paciente: es la misma clase de síntoma que el «¿» suelto que motivó el bug. Precio y horas sí salen bien (el punto decimal no va seguido de espacio).
2. `src/lib/ai/providers/gemini.ts:80` — menor. `*` (negrita de WhatsApp) no está en el conjunto de cierres, así que `*Frase.*` no cuenta como final de frase. Abreviaturas (`Dra.`, `Sr.`) cortan mal; el informe lo acepta como fallback y lo doy por bueno si se corrige lo de la lista.
3. `src/lib/ai/providers/gemini.ts:310` (bucle de herramientas) — informativo, sin cambio requerido. Si una vuelta intermedia acaba en MAX_TOKENS, `cut` vacía `toolCalls`, y `runToolLoop` (`src/lib/ai/tools/loop.ts:283`) toma esa vuelta como la final: envía el preámbulo recortado (p. ej. «Déjame revisar la agenda.») como respuesta sin ejecutar la herramienta, o lanza empty_response si no quedó frase. Esto ya ocurría antes del cambio (con el fragmento sin recortar); el presupuesto mayor lo vuelve raro. El `assistant` sin recortar no se reutiliza porque no se empuja a `steps`. Si se quiere cerrar del todo, hacer traspaso en vez de enviar texto en una vuelta cortada con tools sería otra feature.
4. `src/lib/ai/defaults.ts:37` — informativo. Coste: el tope solo limita el peor caso; el razonamiento se factura como salida igual que antes, pero el máximo por llamada pasa de 1024 a 9216 tokens de salida (≈9× en el peor caso, × hasta 6 vueltas en el bucle), sobre la clave del propio cliente. Latencia: cada llamada sigue acotada por `AI_REQUEST_TIMEOUT_MS` (30 s) y el bucle por `AI_TOOL_BUDGET_MS` (40 s, comprobado solo entre vueltas), dentro de `after()` del webhook con `maxDuration = 60`. Con 1024 el razonamiento largo se cortaba rápido; ahora un razonamiento de miles de tokens puede llevar una vuelta a timeout (error `timeout` en lugar de respuesta cortada) o sumar vueltas largas hasta rozar los 60 s. Es un intercambio razonable para respuestas de WhatsApp; el warn nuevo no lo detecta (un timeout no llega a tener finishReason). Recomendado (no bloqueante): mencionarlo en el guion manual — mirar latencia de la respuesta en el playground con herramientas.
5. `src/lib/ai/generate.test.ts` — informativo. Los tests de SAFETY ahora imprimen el warn en la salida de vitest; silenciarlo con `vi.spyOn(console,'warn')` es opcional.

## Cambios requeridos
1. `trimDanglingFragment` (`gemini.ts:80`): no tratar como final de frase un número seguido de punto al inicio de línea (marcador de lista, `^\s*\d+\.`). Con eso, `Tenemos:\n1. Fisioterapia\n2. Masaje terap` → `Tenemos:\n1. Fisioterapia`.
2. Añadir a `gemini.cut.test.ts` › `trimDanglingFragment` los casos: lista numerada cortada en un ítem (arriba), `La sesión cuesta RD$ 4,000.00. Incluye eval` → `La sesión cuesta RD$ 4,000.00.`, y `Precio: RD$ 4,000.00 por ses` → `''`.
3. (Opcional, mismo cambio) admitir `*` y `_` entre los cierres del regex para que `*Frase.*` cuente como final.

No corrido: skill `code-review` (revisión manual del diff y de los consumidores en `generate.ts` y `tools/loop.ts` en su lugar); build y compuerta completa.
