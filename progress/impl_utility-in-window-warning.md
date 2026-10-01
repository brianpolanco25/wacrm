# p11.5 `utility-in-window-warning` — informe del implementer

## Plan

1. `chore:` prettier sobre `automation-builder.tsx` en un commit aparte antes de tocarlo (el archivo no estaba formateado).
2. T1: `src/lib/automations/template-window.ts` (solo `import type`) + `template-window.test.ts`.
3. T2: `src/components/automations/template-window-notice.tsx` (aviso, badge, proveedor y hook) + claves `Automations.builder.templateWindow.*` en es/en + `template-window-notice.test.tsx`.
4. T3: integrar en `automation-builder.tsx` (proveedor bajo `ResourcesProvider`, aviso en `StepEditor`, badge en `StepRenderer`) + test de `toApiSteps`.
5. T4/T5: CHANGELOG, compuerta, commits, informe.

## Rama y commits

- Worktree `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/pmd-template-window`, rama `pmd/template-window`, base `feat/precios-meta-directo` @ be8ca0f.
- `b4d8664` chore: prettier en el builder de automatizaciones antes de tocarlo (solo formato; el archivo no pasaba por prettier).
- `1a2f6bf` feat: aviso de plantilla enviada con la ventana de atención abierta (p11.5).

## Archivos (R12)

`git diff --stat be8ca0f`: solo `src/lib/automations/template-window{,.test}.ts`, `src/components/automations/{automation-builder.tsx, template-window-notice.tsx, template-window-notice.test.tsx}`, `messages/{es,en}.json`, `CHANGELOG.md`. No se tocan `src/lib/automations/validate.ts`, `src/lib/automations/engine.ts`, `src/app/api/automations/`, el webhook, `src/lib/flows/` ni el constructor de flujos (CP8, CP11). Sin migración, sin ruta, sin consulta nueva: las plantillas vienen del `select("*")` que `ResourcesProvider` ya hacía (incluye `category`) y `metaBilling` del caché compartido de `useBillingStatus()`.

El constructor de flujos no cambia: `FlowNodeConfig` (`src/lib/flows/types.ts`) no tiene nodo de plantilla; la función pura queda lista para cuando lo haya.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| R1 disparadores | `src/lib/automations/template-window.test.ts` › `templateWindowWarnings — triggers (R1)` › `%s → warns: %s` (los 8) |
| R2 esperas / umbral 23 h | idem › `waits (R2)` › `wait 22 h`, `wait 23 h`, `wait 1 day`, `two waits of 12 h`, `wait 90 minutes`, `no wait`; `a wait after the template does not matter`; `SAFE_WINDOW_MS is 23 h` |
| R3 condiciones | idem › `conditions (R3)` › `in a branch: parent waits up to the condition + branch waits before it` (21 h + 2 h), `in a branch with little waiting → warns`, `after the condition: the longest branch decides (30 h in no)`, `after the condition with no waits in either branch → warns`, `nested conditions accumulate` |
| R4 categorías | idem › `categories (R4)` › `order_update → utility`, `promo → marketing`, `otp → undefined`, `same name in two languages: the step language wins`, `missing language on step and template both default to en_US`, `unknown template or none picked → nothing`, `no templates loaded yet → empty map`, `only send_template steps are flagged` |
| R5 `WARN_UTILITY_IN_WINDOW` | idem › `WARN_UTILITY_IN_WINDOW (R5)` › `defaults to true`, `warnUtility: false drops utility but keeps marketing` |
| `waitDurationMs` = `waitMs` | idem › `waitDurationMs — same as the engine waitMs` (minutos, horas, días, 0, negativo, sin unidad, sin cantidad) |
| R6 pureza | idem › `purity (R6)` › `imports nothing but types` (todas las líneas `import` son `import type`; sin `fetch(`, `Date.now`, `new Date`, `window.`) |
| R7 aviso | `src/components/automations/template-window-notice.test.tsx` › `TemplateWindowNotice (R7)` › `utility / direct …`, `marketing / direct …`, `utility / managed → no quota note`, `metaBilling unknown is treated as direct`, `is advice, not an error: default Alert variant`, `no kind → renders nothing`, `the English catalogue renders too` |
| R8 badge | idem › `TemplateWindowBadge (R8)` › `amber, with an accessible label and title` |
| R9 no bloqueante | idem › `toApiSteps is unaffected by the notice (R9)` › `same body with and without a warning`; el diff no toca `validate.ts` ni `src/app/api/automations/` |
| R10 recálculo | idem › `TemplateWindowProvider (R10)` › `keyword_match → tag_added removes the notice`, `authentication → utility template adds it`, `outside a provider → no warnings` |
| R11 i18n | idem › `templateWindow i18n (R11)` › `same keys in es and en`, `%s: same ICU placeholders as es`; `src/i18n/messages.test.ts` verde |

## Verificación contra base real

No aplica: sin SQL, sin RLS, sin RPC.

## Compuerta

- `npm run lint`: 0 errores (34 warnings preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 269 archivos, 3.870 tests, todos en verde.
- `npm run build` (variables dummy de CI): verde (exit 0).
- `prettier --check` en lo tocado: verde.

## Decisiones donde la spec era ambigua

1. **Texto de estimación.** El líder pidió que el aviso deje claro que es una estimación según la tarifa vigente de Meta; la lista de claves de `design.md` no la tenía. Añadí `templateWindow.estimate` («Es una estimación según la tarifa vigente de Meta; puedes guardar la automatización igual.»), que además cubre A3 (la regla es un supuesto) y deja explícito que no bloquea. Seis claves en vez de cinco; el test de paridad las fija.
2. **Proveedor.** `TemplateWindowProvider` vive en `template-window-notice.tsx` y recibe `templates` y `metaBilling` por props (no lee `useResources`, que es privado del builder). En el builder, `BuilderTemplateWindow` (hijo de `ResourcesProvider`) lee `useResources().templates` y `useBillingStatus()?.metaBilling` y se los pasa. El contexto lleva el mapa y `metaBilling`, así `StepEditor` no necesita su propia llamada a `useBillingStatus`.
3. **R10 sin jsdom.** El repo no tiene jsdom; el recálculo se prueba renderizando el proveedor con el estado antes y después del cambio (`useMemo` sobre disparador, pasos y plantillas). No se renderiza `AutomationBuilder` entero (arrastraría router, auth y Supabase).
4. **Badge solo plegado.** Se muestra cuando el paso no está expandido (R8); expandido se ve el aviso completo.
5. **`waitDurationMs` con cantidad no numérica** devuelve 1 s (el motor daría `NaN`; la validación no lo deja pasar). Lo fija la spec.
6. **Inglés**: «Customer service window open», etc.; mismo sentido que el español, número formateado por ICU (`1,000` en en, `1000` en es).

## Variables de entorno nuevas

Ninguna. El interruptor es la constante `WARN_UTILITY_IN_WINDOW` en código (spec R5), no una variable.

## Verificación manual pendiente (humano) — supuestos S-U1…S-U4

No se consultó ninguna fuente externa (sin red, por regla del humano).

1. **S-U1 (decide antes de desplegar):** confirmar en la documentación de precios de Meta vigente desde 2026-10-01 cómo se cobra una plantilla de **utilidad** entregada dentro de la ventana de atención. Si es gratis, poner `WARN_UTILITY_IN_WINDOW = false` en `src/lib/automations/template-window.ts` y ajustar o retirar `templateWindow.utility` en `messages/es.json` y `messages/en.json`. Riesgo conocido: en el modelo anterior era gratis.
2. **S-U2:** confirmar que una plantilla de **marketing** se cobra a tarifa de marketing también dentro de la ventana. Si no, retirar el aviso de marketing.
3. **S-U3:** ventana de 24 h desde el último mensaje del cliente, abierta solo por un mensaje del cliente (`SAFE_WINDOW_MS`).
4. **S-U4:** el cron `/api/automations/cron` reanuda un `wait` con menos de 1 h de retraso (si no, subir el margen de `SAFE_WINDOW_MS`).
5. Con un número real: mandar una plantilla de utilidad dentro de la ventana y mirar en `message_charges` `pricing_category`, `pricing_type` y `pricing_billable`.
6. En `/automations/new`: disparador «palabra clave», paso «Enviar plantilla» con una plantilla de utilidad sincronizada → aviso ámbar bajo el selector y marca ámbar en la cabecera al plegarlo; guardar funciona igual. Añadir antes un `wait` de 1 día → desaparece. Cambiar el disparador a «etiqueta añadida» → desaparece. En una cuenta `managed`, el aviso no incluye la frase de los 1.000 mensajes gratis.

## Deuda detectada (fuera de alcance, no se toca)

- **Motor de automatizaciones, `wait` dentro de una rama de `condition`:** en `executeStepsFrom` (`src/lib/automations/engine.ts`) un `wait` dentro de una rama suspende solo la rama (encola `automation_pending_executions` con `parent_step_id`/`branch`); el bucle del padre sigue y ejecuta en el acto los pasos posteriores a la condición, sin esperar. Probablemente no es lo que espera el autor de la automatización. El aviso usa el máximo de las dos ramas para lo que sigue a la condición, que es conservador tanto con el comportamiento actual como con el corregido.
- `FREE_SERVICE_MESSAGES_PER_NUMBER` (1.000) duplica `SERVICE_FREE_TIER_PER_NUMBER` de p11.3 (`src/lib/billing/service-cap.ts`, módulo de servidor, otra rama). Unificar cuando ambas ramas estén juntas si se puede exponer sin arrastrar código de servidor.
- Las etiquetas «Condition» / «Wait» / «Action» de la cabecera de paso y los textos de `previewFor` del builder están en inglés fijo, sin i18n (preexistente).
- `.env.local.example`: no se toca (no hay variables nuevas).
