# impl p16.2 `audit-billing` — B1–B3 de la auditoría del 2026-11-20

## Plan

1. B1: `getEntitlements` lee `current_period_end`, `cancel_at_period_end`; bloquea `(cancelled || cancel_at_period_end) && período terminado o sin fecha`. Comentario de `isReadOnly`. Revisar /billing y checkout para cuentas bloqueadas así.
2. B2: 409 en `change_plan` y en checkout POST cuando `meta_billing = 'managed'`.
3. B3: `due_at` desde `max(period_end, now)` en `processOne`.
4. Tests que fallan sin cada arreglo; compuerta; CHANGELOG; commit.

## Rama y commits

- Worktree `/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/audit-billing`, rama `fix/audit-billing` (desde `63f581e`).
- Commit: `3907ef0` fix: cobro — la cancelación vence, las gestionadas no cambian de plan, el estado de cuenta tardío no nace vencido.

- Commit `14159f4` docs: textos tras la revisión (comentario de `due_at` en `statement-cron.ts`, CHANGELOG de B1/B3, mensaje del 409 de gestionadas: «A managed account's plan is changed by Cabbity support; contact them to change it»). Sin cambios de lógica; ningún test compara ese texto. Compuerta dirigida: eslint de los 3 archivos, typecheck, vitest `src/lib/billing` + `src/app/api/billing` (33 archivos, 718 tests) en verde.

## Compuerta

`npx eslint . --ignore-pattern '.claude/**' && npm run typecheck && TZ=UTC npm test && npm run build` con las variables dummy: salida 0. Lint 0 errores (34 warnings ya existentes, ninguno en archivos tocados); vitest 417 archivos / 6385 tests verdes; build OK.

## Criterio ↔ test

| Criterio | Archivo | `it` |
|---|---|---|
| B1 cancelada con período vigente → escribe | `src/lib/billing/entitlements.test.ts` | `cancelled with the period still running → writable` |
| B1 cancelada con período vencido → solo lectura | idem | `cancelled with the period over → read-only for the subscription` |
| B1 `active` + `cancel_at_period_end` vencido → solo lectura | idem | `active + cancel_at_period_end with the period over → read-only` |
| B1 `active` + `cancel_at_period_end` vigente → escribe | idem | `active + cancel_at_period_end inside the period → writable` |
| B1 plan manual → sin cambios | idem | `a manual plan past its period end is unchanged (writable)` |
| B1 columnas en la misma consulta (sin consulta extra) | idem | `reads both columns off the same subscription query` |
| B1 cuenta bloqueada así puede volver a contratar | `src/app/api/billing/checkout/route.test.ts` | `lets a direct account whose cancelled period ran out contract again (p16.2/B1)` |
| B2 `change_plan` gestionada → 409 | `src/app/api/billing/subscription/route.test.ts` | `409s a managed account: its plan carries the Meta package (p16.2/B2)` |
| B2 checkout gestionada → 409 | `src/app/api/billing/checkout/route.test.ts` | `409s a managed account: a public plan would keep its Meta package (p16.2/B2)` |
| B3 emisión una semana tarde → due = emisión + 3 días | `src/app/api/billing/cron/route.test.ts` | `a statement issued a week late is due three days after the issue, not born overdue (p16.2/B3)` |

Comprobado: con los archivos de producción revertidos (`git stash`), fallan los tests de B1 (4), B2 (2) y B3 (3); con el arreglo pasan.

## Tests existentes cambiados (fijaban el comportamiento anterior)

- `entitlements.test.ts` `status cancelled → readOnly`: pasa de `false` a `true`. La fila de prueba no tiene `current_period_end`, y «sin fecha» ahora bloquea, como pide el spec. El caso «cancelada con período vigente → escribe» queda cubierto por el test nuevo.
- `entitlements.test.ts:444` (`isReadOnly('cancelled', null)` → false) **no cambia**: `isReadOnly` sigue siendo la regla de solo estado (el spec pone el arreglo en `getEntitlements`); se corrigió su comentario, que decía que la pasarela pasa la fila a `expired` (no existe ese job).
- `cron/route.test.ts`: `due_at`/`grace_until` de `2026-11-04T00:00Z` a `2026-11-04T06:00Z` en los dos tests que emiten en `NOW = 2026-11-01T06:00Z`. Es consecuencia directa de `max(period_end, now)`: emitir 6 h después del corte vence 6 h después. Los demás `2026-11-04T00:00Z` del archivo son filas sembradas, no cambian.

## Revisión B1: una cuenta bloqueada por período vencido puede pagar

- `POST /api/billing/checkout` y `/api/billing/subscription` usan `requireRole('admin', { allowReadOnly: true })`.
- `alreadyContracted` devuelve false con `cancel_at_period_end` y con `cancelled` (no está en `CONTRACTED_STATUSES`) → el checkout abre.
- `availableActions` (`subscription-view.ts`) da `reactivate: 'checkout'` y `changePlan: 'checkout'` para esas filas → el panel de /billing ofrece volver a contratar.
- `BillingStatusAlert` muestra `lockedTitle` con botón a `/billing`; `onboarding/state.ts` da `done` (no la atrapa en onboarding).
- WhatsApp entrante: el webhook no llama a `assertWritable`; nada de este cambio lo toca. La auto-respuesta de IA ya respetaba `readOnly` antes (sin cambio de regla).

## Verificaciones contra base real

No aplica: sin SQL ni migraciones. `due_at >= period_end` (CHECK de 078) se sigue cumpliendo porque `max(period_end, now) + 3 días >= period_end`.

## Verificaciones manuales pendientes

- PayPal no se ejercita (B2 corta antes de llamar a PayPal; no hace falta guion).

## Decisiones donde el spec era ambiguo

- B1: «período terminó o no hay fecha» se implementa como `!(Date.parse(current_period_end) >= now)`, así una fecha no parseable también bloquea (falla cerrado).
- B1: la razón del bloqueo es `readOnlyReason = 'subscription'` (el banner existente con «Arreglar» → /billing). No se añadió una razón nueva.
- B2: la comprobación de gestionada va antes de la de «suscripción viva» en `change_plan`, para que una gestionada nunca reciba `mode: 'checkout'` (que la mandaría a un checkout que también 409). En checkout va tras la guarda de doble cobro.
- B2: mensaje de error en inglés como el resto de errores de esas rutas (no son textos de UI de `messages/*.json`).
- B3: `issued_at` sigue siendo `new Date()`; solo `due_at` usa el `now` del sweep (que se pasa ahora a `processOne`).

## Variables de entorno nuevas

Ninguna.

## Deuda fuera de alcance

- El panel de /billing (`subscription-panel.tsx`) no oculta «Cambiar plan» a una cuenta gestionada: el botón llevará a un 409. Conviene ocultarlo o mostrar «lo cambia Cabbity» (UI, no pedido).
- Hallazgos 4–8 del informe de cobro siguen abiertos (no son de esta fase).
