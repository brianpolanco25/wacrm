# Review — p11.5 utility-in-window-warning

**Veredicto:** APPROVED

## Compuerta

No ejecutada por mí (instrucción explícita de la tarea: máquina con carga 20+, la corre el
líder). Verificación acotada que sí hice, en el worktree `pmd/template-window` @ `1a2f6bf`:

- `TZ=UTC npx vitest run src/lib/automations/template-window.test.ts` → 39/39 verde.
- `TZ=UTC npx vitest run src/components/automations/template-window-notice.test.tsx` → 15/15 verde.
- `TZ=UTC npx vitest run src/i18n/messages.test.ts` → 8/8 verde (paridad de catálogos).
- `package.json` / `package-lock.json` sin diff respecto a `be8ca0f` (CP5).

El informe (`progress/impl_utility-in-window-warning.md`) reporta lint/typecheck/`npm
test` (269 archivos, 3.870 tests)/`build` en verde; pendiente que el líder corra la compuerta
completa antes de fusionar.

- replay-migrations: n/a (sin SQL, confirmado por `git diff --stat`).

## Trazabilidad criterio ↔ test

- R1 disparadores: [x] `src/lib/automations/template-window.test.ts` › `templateWindowWarnings — triggers (R1)` — leí los 8 casos (`it.each`), los 5 que abren ventana devuelven `'utility'`, los 3 que no, `undefined`; coincide con `OPEN_WINDOW_TRIGGERS` del archivo fuente.
- R2 esperas / 23 h: [x] idem › `waits (R2)` — `wait 22h`→avisa, `23h`→no, `1 day`→no, `12h+12h`→no, `90min`→avisa, `SAFE_WINDOW_MS is 23 h` fija la constante; probé también `waitDurationMs` contra `waitMs` de `src/lib/automations/engine.ts:933-941` línea por línea: misma fórmula (`days 86_400_000`, `hours 3_600_000`, si no `60_000`, `Math.max(1_000, amount*unit)`).
- R3 condición: [x] idem › `conditions (R3)` — leí los 5 casos; tracé a mano «parent 21h + rama 2h → no avisa» (23h, no <23h), «tras condición, rama no con 30h decide → no avisa», «ambas ramas sin espera → avisa», «anidadas: 12h+11h=23h → no avisa». Coincide con el algoritmo de `walk()` en `template-window.ts:109-130` (máximo de las ramas al volver al padre).
- R4 categorías: [x] idem › `categories (R4)` — tres categorías, mismo nombre en dos idiomas (gana el idioma del paso), plantilla sin sincronizar, `template_name` vacío, sin plantillas cargadas, paso que no es `send_template`. Comprobé que `category` se guarda como `'Marketing'|'Utility'|'Authentication'` en `src/lib/whatsapp/template-sync.ts:120-127` (`normalizeCategory`), coincide con la comparación exacta de `categoryOf()`.
- R5 `WARN_UTILITY_IN_WINDOW`: [x] idem › `WARN_UTILITY_IN_WINDOW (R5)` — valor por defecto `true`; `warnUtility: false` quita utilidad y deja marketing.
- R6 pureza: [x] idem › `purity (R6)` — el test lee el archivo fuente y exige que todo `import` sea `import type` y que no haya `fetch(`, `Date.now`, `new Date`, `window.`; confirmé a mano que `template-window.ts` solo importa `import type { AutomationTriggerType, WaitStepConfig } from '@/types'`.
- R7 aviso: [x] `src/components/automations/template-window-notice.test.tsx` › `TemplateWindowNotice (R7)` — `utility/direct` (texto + cuota + estimación), `marketing/direct`, `utility/managed` (sin cuota), `metaBilling` indefinido tratado como `direct`, variante no destructiva (`role="alert"`, sin `text-destructive`), `kind` ausente no renderiza nada, catálogo inglés también renderiza con `1,000` (ICU).
- R8 badge: [x] idem › `TemplateWindowBadge (R8)` — `aria-label` y `title` iguales al texto `badge`, color ámbar.
- R9 no bloqueante: [x] idem › `toApiSteps is unaffected by the notice (R9)` — compara `toApiSteps(tree)` con y sin aviso, mismo cuerpo, sin `cid`/`window`/`warning` en el JSON enviado; confirmé que `toApiSteps` (línea 1770) no se tocó en el diff de la feature.
- R10 recálculo: [x] idem › `TemplateWindowProvider (R10)` — cambia disparador `keyword_match→tag_added` quita el aviso, cambia plantilla `otp→order_update` lo añade, fuera del proveedor no hay avisos (valor por defecto del contexto).
- R11 i18n: [x] idem › `templateWindow i18n (R11)` — mismas 6 claves en es/en (`badge, estimate, marketing, quotaNote, title, utility`), mismos placeholders ICU por clave; `src/i18n/messages.test.ts` verde (8/8).
- R12 alcance: [x] `git diff --stat be8ca0f..HEAD` (worktree) — solo `CHANGELOG.md`, `messages/{es,en}.json`, `src/components/automations/{automation-builder.tsx, template-window-notice.tsx, template-window-notice.test.tsx}`, `src/lib/automations/template-window{,.test}.ts`. No toca `validate.ts`, `engine.ts`, `src/app/api/automations/`, el webhook ni `src/lib/flows/`.

## Checkpoints

- CP1: [ ] pendiente (la corre el líder; ver sección Compuerta).
- CP2: [x] n/a, sin SQL.
- CP3: [x] n/a, sin `supabaseAdmin()` nuevo; la única query (`message_templates` vía `ResourcesProvider`) ya filtraba por `account_id` antes de esta feature y no se tocó.
- CP4: [x] cada R tiene test vitest leído por mí (ver trazabilidad); sin base real ni servicio externo en este camino.
- CP5: [x] `package.json`/`package-lock.json` sin diff.
- CP6: [x] mismas 6 claves y mismos placeholders ICU en es/en; sin `ko` (correcto, retirado en s9.9).
- CP7: [x] sin API de framework nueva; solo Context/hooks de React ya usados en el archivo.
- CP8: [x] diff limitado a lo que justifica el spec (ver R12).
- CP9: [x] `CHANGELOG.md` (Unreleased) actualizado; sin variables de entorno nuevas (no aplica `docs/docker.md`); informe coincide con el diff.
- CP10: [x] dos commits en español, prefijo `chore:`/`feat:`, `Co-Authored-By`, nada pusheado.
- CP11: [x] n/a, no toca el webhook (confirmado por el diff).

## Hallazgos (archivo:línea)

Ninguno bloqueante.

1. `src/lib/automations/template-window.ts:36` — `FREE_SERVICE_MESSAGES_PER_NUMBER = 1000` duplica el valor que tendrá `SERVICE_FREE_TIER_PER_NUMBER` de p11.3 (`src/lib/billing/service-cap.ts`, otra rama aún no integrada aquí). El informe ya lo anota como deuda a unificar cuando las ramas converjan; no bloquea esta feature (es de servidor y arrastraría Supabase a un módulo que debe quedar puro).
2. Commit `b4d8664` verificado como solo formato: normalicé ambas versiones del archivo quitando espacios y comillas — mismo contenido normalizado salvo 104 tramos de reordenamiento de clases Tailwind (mismo multiset de tokens, mismo largo total: 38.914 caracteres antes y después). Sin cambio de comportamiento.
3. La deuda de `executeStepsFrom` (un `wait` dentro de una rama de `condition` no detiene al padre) está anotada en el informe y en `design.md`, y `src/lib/automations/engine.ts` no aparece en el diff: confirmado que no se tocó.

## Cambios requeridos

Ninguno.

