# Review — p16.2 audit-billing

**Veredicto:** APPROVED

Rama `fix/audit-billing`, commit `3907ef0` (diff `main...HEAD`: 9 archivos, coincide con el informe).

## Compuerta
- lint (`npx eslint . --ignore-pattern '.claude/**'`): verde (0 errores, 34 warnings preexistentes, ninguno en archivos tocados).
- typecheck: verde. build (vars dummy): verde.
- test (`TZ=UTC`): 6384 verdes, **1 rojo preexistente y ajeno**: `src/middleware.test.ts` › "lets the coexistence cron through without a session… (#1651)" cae por timeout de 5 s en la suite completa. Falla igual en `main` (corrido en el checkout principal: 1 failed | 6387 passed) y pasa aislado (84/84). La rama no toca `middleware*`. No bloquea esta feature; conviene abrirlo aparte (timeout del test o import en frío del handler).
- replay-migrations: n/a (sin SQL).
- Tests fallan sin el arreglo: comprobado en un worktree temporal con los 4 archivos de producción en la base y los tests de la rama → 9 rojos (B1: 4, B2: 2, B3: 3), los mismos que declara el informe.

## Trazabilidad criterio ↔ test
- B1 «cancelada con período vigente → escribe»: [x] `src/lib/billing/entitlements.test.ts` › "cancelled with the period still running → writable" (además `readOnlyReason` null).
- B1 «cancelada con período vencido → solo lectura»: [x] idem › "cancelled with the period over → read-only for the subscription" (razón `subscription`). Falla sin el arreglo.
- B1 «`active` + `cancel_at_period_end` vencido → solo lectura»: [x] idem › "active + cancel_at_period_end with the period over → read-only". Falla sin el arreglo.
- B1 «plan manual → sin cambios»: [x] idem › "a manual plan past its period end is unchanged (writable)".
- B1 «sin fecha bloquea»: [x] tabla `status cancelled → readOnly true` (fila sin `current_period_end`); cambio de test existente declarado en el informe.
- B1 «una cuenta bloqueada así puede volver a contratar»: [x] `src/app/api/billing/checkout/route.test.ts` › "lets a direct account whose cancelled period ran out contract again" (201). Es guarda de regresión (pasa también sin el arreglo, como corresponde).
- B2 `change_plan` gestionada → 409: [x] `src/app/api/billing/subscription/route.test.ts` › "409s a managed account…" (no llama `reviseSubscription`, no escribe). Falla sin el arreglo.
- B2 checkout gestionada → 409: [x] `checkout/route.test.ts` › "409s a managed account…" (fila `cancelled` para que `alreadyContracted` no la frene; no llama PayPal ni crea intent). Falla sin el arreglo.
- B3 «emisión una semana tarde → due = emisión + 3 días»: [x] `src/app/api/billing/cron/route.test.ts` › "a statement issued a week late…" (`due_at` y `grace_until` = 11-nov 12:00, > emisión). Falla sin el arreglo.

## Recorrido de escritores de `status` / `cancel_at_period_end` / `current_period_end` (B1)
- Webhook PayPal `ACTIVATED` / `SALE.COMPLETED` (incl. adopción tras cancelar): ponen `cancel_at_period_end=false` y `status='active'` → re-contratar levanta el bloqueo en cuanto llega el evento. `SALE.COMPLETED` de renovación no toca el flag (PayPal no cobra tras cancelar).
- Webhook `CANCELLED`: con período pagado solo pone el flag → escribe hasta `current_period_end`; sin período, `cancelled` → bloquea (antes quedaba escribible para siempre: es el hallazgo).
- `UPDATED` con estado CANCELLED: `status='cancelled'` con período futuro → escribe hasta el fin. Correcto.
- Planes manuales/ilimitados del operador (`manualPlanRow`, migración 074): `status='active'`, `cancel_at_period_end=false` siempre → nunca entran en la regla, aunque `current_period_end` sea NULL (ilimitado) o vencido (gestionado manual, que lo mueve `settlePatch`). Reasignar plan manual a una cuenta cancelada resetea el flag.
- Cuenta gestionada PayPal (`managed-plan.ts`): escribe `incomplete` + flag false → bloqueada por `incomplete` como antes; `ACTIVATED` la libera.
- Trial: `trialing` sin flag → sin cambio.
- `past_due` con gracia: sin flag, sin cambio. Con cancelación durante la gracia queda bloqueada ya (período vencido, no pagó el ciclo); antes el `CANCELLED` la pasaba a `cancelled` y quedaba escribible indefinidamente. Aceptable.
- `isReadOnly()` no tiene otros llamadores; panel de plataforma (`platform/accounts.ts`), `/api/billing/status`, onboarding y `enforce` derivan de `getEntitlements` → coherentes.
- Salida para el bloqueado: `checkout` POST y `subscription` usan `requireRole('admin', { allowReadOnly: true })`; `alreadyContracted` = false con flag o `cancelled`; `availableActions` da `reactivate: 'checkout'`; onboarding da `done` (no atrapa). 
- CP11: `src/app/api/whatsapp/webhook/route.ts` no lee `getEntitlements`/`readOnly`; el guardado entrante no depende del cambio. (Auto-respuesta IA, flujos y automatizaciones ya respetaban `readOnly` antes; ahora alcanzan también a canceladas vencidas, que es lo buscado.)

## B2
- Solo `meta_billing === 'managed'`; columna por defecto `direct`; directas no afectadas (los tests existentes de re-contratación directa siguen verdes). En `change_plan` la guarda va tras `cancel`/`reactivate`, así una gestionada puede seguir cancelando. GET de checkout (retorno) no se toca.

## B3
- CHECK 078 `due_at >= period_end`: `max(period_end, now) + 3 d >= period_end` siempre. Correcto.

## Checkpoints
- CP1: [x] verde salvo `middleware.test.ts` preexistente en `main` (ver Compuerta).
- CP2: [x] n/a, sin SQL.
- CP3: [x] las consultas nuevas reutilizan las existentes (`.eq('account_id', …)` en `getEntitlements`, `loadSubscription(ctx)`); el sweep sigue filtrando cada escritura por `account_id`.
- CP4: [x] cada criterio con test leído; sin dependencias de base real ni de PayPal en vivo.
- CP5: [x] `package.json` intacto.
- CP6: [x] sin textos de UI nuevos (errores de API en inglés, como el resto de esas rutas).
- CP7: [x] n/a, sin API de framework nueva.
- CP8: [x] solo los 4 archivos de B1–B3, sus tests y CHANGELOG.
- CP9: [x] CHANGELOG actualizado, informe coincide con el diff (ver hallazgos 3–4 sobre su redacción).
- CP10: [x] un commit en español con prefijo y `Co-Authored-By`; sin push.
- CP11: [x] ver arriba.

## Hallazgos (no bloqueantes; contrastados con `code-review high`)
1. `src/app/api/billing/checkout/route.ts:240` + `src/lib/billing/entitlements.ts:309` — una cuenta **gestionada** con PayPal cancelado y período vencido queda ahora en solo lectura y su checkout responde 409: no puede volver a contratar sola; la salida es el operador (`/api/platform/accounts/[id]/plan`). Es la combinación literal de B1+B2 del spec, pero el banner «Arreglar» la manda a `/billing`, donde `PlanPicker` solo mostrará el texto en inglés del 409. Decisión para el humano/leader; la deuda de UI ya está anotada en el informe (ocultar plan/checkout a gestionadas y decir «lo cambia Cabbity").
2. `src/lib/billing/statement-cron.ts:226` — el sweep solo toma `statement_period_end <= now`, así que `Math.max` devuelve siempre `now`: **todas** las facturas, no solo las tardías, vencen a `emisión + 3 d` (por eso los tests existentes pasan de 00:00 a 06:00). Conforme al spec (`max(period_end, ahora)`), pero el comentario del encabezado (`statement-cron.ts:19`, «`due_at = period_end + 3 days`») queda obsoleto y la línea del CHANGELOG («A statement issued late…») subestima el alcance.
3. `CHANGELOG.md` — «`/billing` and checkout stay open so the account can contract again» no vale para gestionadas (hallazgo 1).
4. `src/lib/billing/statement-cron.ts:245` — si la fila ya existía (otra pasada ganó el UNIQUE, o una gestionada PayPal reactivada por la renovación y re-bloqueada en un sweep posterior), `applyLock` usa el `dueAt` recién calculado con `now` y no el `due_at` guardado: `grace_until` puede divergir del `due_at` de la factura. El bloqueo efectivo lo da `openStatement.dueAt` (valor guardado) en `getEntitlements`, así que el acceso se corta en la fecha correcta; solo diverge el dato mostrado. Menor.
5. `src/lib/billing/statement-cron.ts:234` — `issued_at` usa `new Date()` y `due_at` el `now` inyectado; en producción coinciden, en replays no. Cosmético.

## Cambios requeridos
Ninguno bloqueante. Recomendado (en esta rama o en la siguiente de cobro): corregir el comentario de `statement-cron.ts:19` y las dos líneas del CHANGELOG (hallazgos 2–3), y decidir con el humano el camino de salida visible para gestionadas bloqueadas (hallazgo 1).
