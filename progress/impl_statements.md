# impl s10.4 `statements`

## Plan
1. Migración `078_statements.sql`: tabla `statements` (UNIQUE `(account_id, period_end)`, columnas resumen, CHECKs), RLS SELECT `admin+` vía `can_read_account` con privilegio de columna (sin `usage`, `meta_cost_usd`, datos del pago), escritura solo `service_role`; CHECK de `impersonation_log.action` con `payment_confirmed` y `statement_void`. Bloque `-- 078` en verify-schema.
2. `src/lib/billing/statements.ts`: `buildStatement` puro (excedente por orden de entrega, costo real solo `billable`, sin categoría listado y no cobrado, PayPal sin cuota, `MetaRateMissingError` sin estado parcial), vista del cliente, cargador paginado desde `message_charges`.
3. `src/lib/billing/statement-cron.ts` + `GET /api/billing/cron` (`BILLING_CRON_SECRET`).
4. `getEntitlements()`: estado de cuenta abierto (`openStatement`) y solo lectura cuando vence, para que el webhook de PayPal no levante el corte.
5. Superadmin: lib `src/lib/platform/statements.ts`, rutas `GET …/statements`, `POST …/[sid]/confirm`, `POST …/[sid]/void`; tarjeta «Estados de cuenta» en la ficha.
6. Cliente: `GET /api/billing/statements`, `POST /api/billing/statements/[sid]/claim-paid`, sección en `/billing`, variante `statement_due` de `BillingStatusAlert`, `/api/billing/status` con el estado abierto.
7. i18n es/en; `docs/docker.md`; CHANGELOG.
8. Tests (checkpoints uno a uno, cron idempotente, confirmar tarde, CP11, 401/403, fuga A↔B), réplica + `progress/checks_statements.sql`, compuerta, commits por hito.

## Estado: done (pendiente de reviewer)

Rama `fg/statements` (worktree `.claude/worktrees/fg-statements`), base `feat/facturacion-gestionada` @ bfe366f. HEAD `352cd18`. Sin push.

| Commit | Qué |
|---|---|
| `3ac6cb8` | feat: migración 078 + bloque `-- 078` de `verify-schema.sql` |
| `4d7c126` | feat: `buildStatement` puro + tests de los checkpoints |
| `325c5c5` | feat: `sweepStatements` + `GET /api/billing/cron` |
| `a7ae136` | feat: `getEntitlements()` con `openStatement` y bloqueo `statement` |
| `fad1de2` | feat: lib y rutas del superadmin (lista, confirmar, anular) |
| `afa424b` | feat: `GET /api/billing/statements`, `claim-paid`, `/api/billing/status` con el estado abierto; fuga A↔B y CP11 |
| `4611013` | feat: UI (`/billing`, `BillingStatusAlert` `statement_due`, tarjeta de la ficha), i18n es/en |
| `352cd18` | docs: CHANGELOG y `docs/docker.md` |

## Compuerta (worktree, HEAD 352cd18)
- `npm run lint`: 0 errores, 34 warnings (las preexistentes; ninguna en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 271 archivos, **3871 tests** en verde (base: 267 / 3814 tras el commit de entitlements; 3774 en s10.3).
- `npm run build` con variables dummy: verde; aparecen `ƒ /api/billing/cron`, `/api/billing/statements`, `/api/billing/statements/[sid]/claim-paid`, `/api/platform/accounts/[id]/statements`, `…/[sid]/confirm`, `…/[sid]/void`.
- `scripts/replay-migrations.sh <worktree>` (réplica limpia, sin KEEP): salida 0, `ok 078_statements.sql`, `verify-schema.sql: OK`.
- `progress/checks_statements.sql` (con `KEEP=1`): `ok 1` … `ok 5`, `checks_statements: OK`.

## Archivos
- Migración: `supabase/migrations/078_statements.sql`; `supabase/ci/verify-schema.sql` (bloque `-- 078` tras `/077`).
- Lib: `src/lib/billing/statements.ts` (nuevo: `buildStatement`, periodos, vista del cliente, cargador), `src/lib/billing/statement-cron.ts` (nuevo: `sweepStatements`, `lockPatch`), `src/lib/platform/statements.ts` (nuevo: lista, `settlePatch`, `settleStatement`), `src/lib/billing/entitlements.ts` (`openStatement`, `isStatementOverdue`, `readOnlyReason: 'statement'`), `src/lib/platform/audit.ts` (dos acciones nuevas en el tipo).
- Rutas: `src/app/api/billing/cron/route.ts`, `src/app/api/billing/statements/route.ts`, `src/app/api/billing/statements/[sid]/claim-paid/route.ts`, `src/app/api/billing/status/route.ts` (campo `statement`), `src/app/api/platform/accounts/[id]/statements/route.ts`, `…/statements/settle.ts` (compartido, no es ruta), `…/[sid]/confirm/route.ts`, `…/[sid]/void/route.ts`.
- UI: `src/components/billing/billing-status-alert.tsx` (`StatementDueAlert`), `src/components/billing/statements-section.tsx`, `src/components/billing/statement-claim.ts`, `src/components/platform/platform-statements.tsx`, `src/components/platform/platform-account-detail.tsx` (monta la tarjeta si `managed`), `src/app/(dashboard)/billing/page.tsx`, `src/hooks/use-billing-status.ts` (tipo).
- i18n: `Billing.statementAlert`, `Billing.statements`, `Platform.statements` en `messages/es.json` y `messages/en.json`; `src/i18n/messages.test.ts` (una clave idéntica justificada: `Billing.statements.category.marketing`).
- Docs: `CHANGELOG.md` (Unreleased, aviso de migración 078 y de la variable), `docs/docker.md` (el cron y su secreto).

## Checkpoints propios de la spec ↔ test

| Checkpoint | Test |
|---|---|
| El corte nunca bloquea lo entrante ni la lectura (CP11): entrante a una cuenta en solo lectura por estado de cuenta | `src/app/api/whatsapp/webhook/route.test.ts` › «inbound webhook: billing never blocks what comes in (CP11)» › «stores it for a managed account read-only over an overdue statement (s10.4)»; `src/app/api/billing/cron/route.test.ts` › «CP11: the sweep never writes anything to the inbound tables»; la lectura: `GET /api/billing/statements` y `claim-paid` con `allowReadOnly` (`src/app/api/billing/statements/route.test.ts` › «asks for admin+ and stays reachable while the account is read-only») |
| Cron idempotente: tres pasadas el mismo día, un estado | `src/app/api/billing/cron/route.test.ts` › «is idempotent: three runs the same day issue ONE statement per account»; SQL `checks_statements.sql` §1c (ON CONFLICT DO NOTHING ×3 → 1) |
| Confirmar tarde no desplaza el corte | `src/app/api/platform/accounts/[id]/statements/route.test.ts` › «late: paying on the 20th does not move the cut-off…»; `src/lib/billing/statements.test.ts` › «confirming late does not move the cut-off: the next period ends a month after the previous one» |
| Sin `pricing` no se factura; el estado lista los entregados sin categoría | `statements.test.ts` › «a delivered message without a Meta category is never billed, and the statement says how many there were»; UI: `statements-section.test.tsx` › «shows the breakdown…» (`3 mensajes entregados sin categoría`), `platform-statements.test.tsx` › «shows the total, status, … uncategorized…» |
| 8.200 entregados (7.000 marketing + 1.200 servicio, 200 billable) → 1.036 + 1.200 × 2,5 × 0,0113; costo real solo billable | `statements.test.ts` › «8.200 delivered (7.000 marketing + 1.200 service, 200 billable): 1.036 + 1.200 × 2,5 × 0,0113, and the real cost is only the billable» (total 1.069,90; costo 520,26 = 7.000 × 0,0740 + 200 × 0,0113) |
| Difusión de 1.000 marketing con 900 entregados y 100 fallidos suma 900 | `statements.test.ts` › «a broadcast of 1.000 marketing with 900 delivered and 100 failed adds 900 to the package» |
| 4.000 entregados factura exactamente la cuota; con PayPal no hay excedente, no se emite y el periodo se extiende sin corte | `statements.test.ts` › «a month with 4.000 delivered bills exactly the fee», «with PayPal the fee is PayPal’s: 4.000 delivered is a statement of 0»; `cron/route.test.ts` › «PayPal with no overage: no statement, no cut-off, the period moves a month» |
| Excedente por orden de entrega: paquete agotado a mitad de difusión | `statements.test.ts` › «the package runs out halfway through a broadcast: only the deliveries after that point are overage» (entrada desordenada; 500 dentro, 500 fuera; y al revés) |
| Ninguna tarifa a 0 por mercado desconocido | `statements.test.ts` › «no rate resolves to 0 for an unknown market (no rest_of_world rate → error)» |
| Tarifa ausente → `MetaRateMissingError` sin estado parcial (contrato s10.2) | `statements.test.ts` › «a missing rate fails the WHOLE statement with MetaRateMissingError — nothing partial»; `cron/route.test.ts` › «a missing Meta rate skips THAT account with its error; the others are billed» |
| Fuga A↔B en estados de cuenta (CP3) | `src/lib/security/tenant-isolation.test.ts` › «statements (s10.4, service role)» (6 casos, con la auditoría automática de consultas de rol de servicio; comprobado por mutación: quitar `.eq('account_id', ctx.accountId)` de `GET /api/billing/statements` hace fallar el suite); `platform/…/statements/route.test.ts` (`afterEach` exige B byte a byte igual en cada caso; 404 del estado de B pedido por la URL de A); `cron/route.test.ts` › «every write is scoped to the account being billed (A↔B)»; SQL §4 (RLS) |

## Resto de criterios ↔ test

| Criterio | Test |
|---|---|
| 078: tabla, UNIQUE, CHECKs, índice, RLS, privilegios por columna, CHECK de `action` | `verify-schema.sql` bloque `-- 078`; `progress/checks_statements.sql` §1–§5 |
| Cron: `issued`, `due_at = period_end + 3 días`, `past_due`, `grace_until = due_at`, `current_period_end` intacto | `cron/route.test.ts` › «issues the statement of a manual account: issued, due in three days, past_due until then, period end untouched» |
| Cron: PayPal con excedente → estado solo del excedente y mismo corte | `cron/route.test.ts` › «PayPal with overage: a statement of the overage alone, and it cuts off like the manual one»; `statements.test.ts` › «with PayPal the total is the overage alone…» |
| Cron: 503 sin variable, 401 sin/mal secreto | `cron/route.test.ts` › «503s while BILLING_CRON_SECRET is unset, and does nothing», «401s a missing or wrong secret, and does nothing» |
| Cron: no toca `direct`, periodos no vencidos ni `incomplete`; autorreparación; no reemite uno pagado; el periodo empieza en el corte anterior | `cron/route.test.ts` › «leaves alone a direct account…», «heals a run that died between the two writes…», «a settled statement for that cut-off is never re-issued…», «starts the period where the previous statement ended» |
| Pasados los 3 días, solo lectura (también si PayPal devolvió la fila a `active`) | `entitlements.test.ts` › «the open statement of a managed account (s10.4, migration 078)» (5 casos: antes del vencimiento, después, PayPal renovando la cuota, retención manual gana, lectura fallida) |
| Confirmar pago: `paid` con fecha/referencia/nota/quién, `active`, `grace_until = NULL`, `+1 mes`, bitácora `payment_confirmed` ANTES | `platform/…/statements/route.test.ts` › «on time: paid, active, no grace, the cut-off one month after the period — trail first» (orden de escrituras `impersonation_log → subscriptions → statements`) |
| Confirmar: 409 si ya no está abierto, 500 sin escribir si falla la bitácora, 400 de validación | › «409s a statement already paid, with no trail», «500s and changes nothing when the trail cannot be written», «400s %s, and writes nothing» (4 casos) |
| Otro estado abierto mantiene la gracia; una gracia de PayPal previa no la levanta el estado | › «with another statement still open…», «a PayPal failure that came first…» |
| Anular: motivo ≥10, `void`, misma extensión, bitácora `statement_void` con el motivo ANTES | › «400s a missing or short reason, and writes nothing», «void, the account back to active with the period extended the same way — trail with the reason first», «404s B's statement through A» |
| 401/403 de las rutas del superadmin | › «401s without a session on all three, and nothing moves», «403s a company owner on all three, and nothing moves»; `tenant-isolation.test.ts` › «403s the owner of A on the operator routes, and moves nothing» |
| GET de la ficha con costo real y margen | › «lists the statements of A only, with the internal figures» |
| Cliente: `GET /api/billing/statements` `admin+`, sin `billable` ni costo de Meta | `tenant-isolation.test.ts` › «GET /api/billing/statements: A's statements only, without what is internal», «403s an agent of A on both, and writes nothing»; `statements.test.ts` › «customerStatement — what the customer sees» |
| 401/403 de las rutas del cliente; «Ya pagué» no desde sesión de soporte, 400/404/409 | `src/app/api/billing/statements/route.test.ts` (8 casos) |
| «Ya pagué» deja nota y no cambia el estado | `tenant-isolation.test.ts` › ««Ya pagué» on A's statement leaves the note and changes nothing else»; `statements/route.test.ts` › «works without a note, and never changes the status» |
| `/api/billing/status` con el estado abierto (importe solo admin+) | `src/app/api/billing/status/route.test.ts` › «the open statement of a managed account (s10.4)» (2 casos) y la lista de claves actualizada |
| Banner `statement_due`: importe, periodo, días; vencido: texto propio + `/billing`; «Ya pagué» | `src/components/billing/billing-status-alert.test.tsx` › «BillingStatusAlert — statement_due (s10.4)» (5 casos, incluido el viewer sin importe ni botón y «vence hoy») |
| `/billing` → «Estados de cuenta»: desglose y total, solo lectura | `src/components/billing/statements-section.test.tsx` (6 casos de render, helpers, claves) |
| Ficha → «Estados de cuenta» | `src/components/platform/platform-statements.test.tsx` (render, acciones solo en abiertos, helper, claves) |
| i18n es/en (CP6) | `statements-section.test.tsx` › «every key exists in es AND en (CP6)» (dos componentes), `platform-statements.test.tsx` › ídem; `src/i18n/messages.test.ts`, `icu-safety.test.ts`, `brand.test.ts` en verde |

## Verificaciones contra base real
`KEEP=1 scripts/replay-migrations.sh <worktree>`, luego `docker exec -i <c> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < progress/checks_statements.sql` (transacción con ROLLBACK):
```
NOTICE:  ok 1: UNIQUE (account_id, period_end) e idempotencia del cron
NOTICE:  ok 2: CHECKs
NOTICE:  ok 3: CHECK ampliado de impersonation_log.action
NOTICE:  ok 4: RLS y privilegios por columna
NOTICE:  ok 5: ON DELETE CASCADE
NOTICE:  checks_statements: OK
```
- §1 incluye el mismo instante escrito en otra zona (`2026-10-31 20:00-04`): choca con el UNIQUE, así que el formato de fecha que mande PostgREST no rompe la idempotencia.
- §4: owner de A lee sus 2 estados y sus totales, pero `meta_cost_usd`, `usage` y `paid_reference` dan `insufficient_privilege`; INSERT/UPDATE/DELETE de `authenticated`, `insufficient_privilege`; owner de B no ve los de A; agent de A, 0 filas; `anon`, sin privilegio.
- Mutación comprobada: con la política cambiada a `can_read_account(account_id, 'agent')`, el guion falla en `4l`. Reaplicar la 078 la restaura y el guion vuelve a OK (la 078 también es idempotente sobre sí misma).
- La 078 se reaplicó con `psql --single-transaction`, como la corre `db push`, y `verify-schema` siguió en OK.
- Réplica limpia final (sin KEEP): salida 0.

## Verificaciones manuales pendientes (guion)
Nada depende de Meta ni de PayPal en tiempo real; esto es humo en un entorno con la 078:
1. `BILLING_CRON_SECRET=…` en el entorno. Asignar `gestionado` con pago manual a una empresa de prueba y poner `current_period_end` en el pasado (SQL de servicio). Tener al menos una fila de `message_charges` `delivered` en el periodo con categoría y tarifa cargada.
2. `curl -H "x-cron-secret: $BILLING_CRON_SECRET" <host>/api/billing/cron` → `statements.issued = 1`. Repetirlo: `existing = 1`, `issued = 0`.
3. Como owner de esa empresa: el banner dice «Tu estado de cuenta de … por US$ … vence el …: te quedan N días» y `/billing` muestra «Estados de cuenta». Pulsar «Ya pagué» → aviso; en la ficha del superadmin aparece «El cliente avisó que pagó el …».
4. Poner `due_at` y `grace_until` en el pasado: enviar un mensaje desde el inbox → 403 de solo lectura; el banner dice «Cuenta en solo lectura por estado de cuenta pendiente». Mandar un mensaje entrante al número: se guarda.
5. Ficha → «Confirmar pago» con fecha y referencia → la cuenta vuelve a escribir, `current_period_end` = `period_end` + 1 mes; en la bitácora `payment_confirmed`.
6. Repetir con «Anular» (motivo ≥10) en otro estado.
7. Cuenta `gestionado` con PayPal (sandbox): sin excedente el cron no emite y extiende el periodo; con excedente emite el estado solo del excedente.

## Decisiones donde la spec era ambigua
1. **Entregado = `delivered_at` en el periodo con `status IN ('delivered','read')`**, no solo `status = 'delivered'`. La 075 avanza la fila a `read` y conserva `delivered_at` (también lo fija con `read` si `delivered` no llegó); filtrar solo `delivered` dejaría fuera casi todo lo que se lee. Periodo semiabierto `[period_start, period_end)`.
2. **«Sin categoría» = categoría ausente/vacía o fuera de las cinco que Meta tarifa** (`marketing_lite`, etc.), normalizando guiones (`authentication-international`). La 075 no crea fila sin `pricing`, así que en base real el caso es la categoría desconocida; se lista con su valor crudo y no se cobra ni cuenta en el paquete. Cómo facturar `marketing_lite` lo decide el humano (deuda abajo).
3. **Se resuelve la tarifa de TODO entregado con categoría**, también dentro del paquete: el costo real de un `billable` la necesita, y el contrato de s10.2 dice «no salta mensajes sin tarifa». Consecuencia: una tarifa ausente bloquea el estado aunque el mes no tenga excedente.
4. **Total 0 → no se emite y se extiende** (generaliza «PayPal sin excedente»; con manual solo pasa si alguien pone la cuota a 0).
5. **Inicio del periodo** = `period_end` del estado anterior si está a menos de un mes; si no, un mes antes del corte (así un mes PayPal sin estado no estira el siguiente). Meses con recorte como `addCycle` (31 ene → 28 feb).
6. **Bloqueo por estado vencido en `getEntitlements()`** (`openStatement`, `readOnlyReason: 'statement'`), además del `past_due` + `grace_until` que pide la spec. Motivo: `PAYMENT.SALE.COMPLETED` de PayPal devuelve una fila `past_due` a `active` y borra `grace_until` (webhook-events.ts, REVIVABLE); sin esto, el excedente de una cuenta PayPal nunca cortaría, contra la decisión 2 del humano. Solo consulta para cuentas `managed`; si la lectura falla se registra y se usa el bloqueo por estado.
7. **Confirmar/anular** extiende a `max(current_period_end, period_end + 1 mes)` (nunca hacia atrás si PayPal ya lo movió). Solo levanta el `past_due` si es del estado (gracia nula o ≥ su `due_at`); con otro estado abierto, la gracia pasa a su `due_at`. Orden: bitácora → suscripción → estado condicional a `issued` (si falla el último paso, reintentar es seguro).
8. **Motivo en la bitácora de `payment_confirmed`**: la columna exige ≥10 caracteres (055), así que se escribe «payment confirmed: statement AAAA-MM-DD → AAAA-MM-DD, US$ X, ref. Y»; fecha, referencia y nota van en `details`.
9. **«Ya pagué»**: columnas `claimed_paid_at`, `claimed_by`, `claim_note` en `statements` (la spec no dice dónde guardar la nota). `admin+`, no desde sesión de soporte (habla por el cliente; además el middleware ya bloquea mutaciones de `/api/billing/` en soporte).
10. **Privilegios por columna**: la spec pide «el inquilino lee las suyas» y a la vez «no se enseña billable ni el costo de Meta». Con un SELECT de tabla, cualquier admin leería `meta_cost_usd` y `usage` directamente por PostgREST. El SELECT de `authenticated` es por columnas (totales y fechas); el desglose del cliente sale por `GET /api/billing/statements`, que quita lo interno.
11. **Lo que ve el cliente por línea**: número, categoría, entregados, de ellos excedente, precio aplicado por mensaje e importe. No la tarifa de Meta (con el multiplicador revelaría el margen).
12. **Importe del banner solo para admin+** (`/api/billing/status` nunca daba cifras de dinero; un agent/viewer ve periodo y vencimiento).
13. **Confirmar pago sin modal**: formulario desplegable en la tarjeta (el panel no usa modales; s9.4 usa formularios en línea y `window.confirm`). Sin fecha se toma hoy; fecha futura (más de un día) → 400.
14. **Cuentas `incomplete`** no se facturan (PayPal aún no activó nada). Barrido con tope de 200 cuentas por pasada, por `current_period_end` ascendente.
15. **Correo**: no hay proveedor en el repo (sin Resend/SMTP), así que no se envía nada; solo banner.

## Variables de entorno nuevas
- `BILLING_CRON_SECRET`: documentada en `docs/docker.md` (tabla y ejemplo de crontab) y en el CHANGELOG. **`.env.local.example` no se tocó (bloqueado por permisos): hay que añadirla a mano.**

## Riesgos y deuda detectada (fuera de alcance, sin arreglar)
- **Carrera de PayPal con el corte**: el cron corta por `current_period_end`, y en cuentas PayPal ese campo lo mueve el webhook de la venta (`addCycle(eventTime)`, solo hacia delante). Si la venta de renovación llega y procesa ANTES de que corra el cron, `current_period_end` ya está en el futuro y ese periodo no se factura nunca. Mitigación operativa: cron cada hora o más seguido. La solución robusta es un ancla propia del corte (p. ej. `subscriptions.statement_period_end`) independiente de PayPal. Decide el líder.
- **Deriva por recorte de mes**: un corte el 31 pasa a 28/29 de febrero y se queda ahí (28 mar, 28 abr…), igual que `addCycle` en el resto del repo.
- **`marketing_lite` y otras categorías nuevas** se listan sin cobrar: Cabbity paga a Meta y no factura hasta que el humano decida su precio (añadirlas a `META_CATEGORIES` y a `meta_pricing`).
- Los entregados sin `pricing` de Meta (sin fila en `message_charges`) no se pueden contar desde la 075; si el humano quiere verlos habría que cruzar con `broadcast_recipients.delivered_at` / `messages.status`.
- La bitácora de la ficha sigue sin mostrar `details` (deuda de s9.4); referencia y fecha del pago se ven en la tarjeta de estados.
- `docs/docker.md` ya no estaba en formato prettier antes de este cambio; solo se formateó el bloque nuevo.
- Conflictos de merge previsibles: `verify-schema.sql` (bloque tras `/077`), `messages/*.json` (`Billing.*` y `Platform.statements` al final), `tenant-isolation.test.ts` (bloque al final del archivo), `CHANGELOG.md`.

## Segunda ronda (decisión del líder: ancla propia del corte)

Commit `827a032` (fix) sobre `352cd18`. HEAD = `827a032`. Sin push.

El riesgo «carrera de PayPal con el corte» de la primera ronda se resolvió como pidió el líder: `subscriptions.statement_period_end`, un ancla del corte separada de `current_period_end`.

| Cambio | Dónde |
|---|---|
| `statement_period_end timestamptz` nullable en la **misma 078**; la 078 la rellena para las `managed` existentes (`current_period_end`, o `now() + 1 mes` si es NULL), solo donde falta, así que reejecutarla no mueve ninguna. Aserciones en verify-schema: la columna existe y ninguna `managed` queda sin ancla. | `supabase/migrations/078_statements.sql`, `supabase/ci/verify-schema.sql` |
| Asignar el plan gestionado la fija en `now() + 1 mes`, con manual (`manualPlanRow`) y con PayPal (la fila `incomplete`). Un plan sin política la deja en NULL. | `src/lib/platform/provisioning.ts`, `src/lib/platform/managed-plan.ts` (una línea cada uno) |
| El cron corta por `statement_period_end <= now()`. `period_end` = el ancla; `period_start` = `period_end` del estado anterior si existe y está a menos de un mes, si no ancla − 1 mes. Con total 0 avanza el ancla +1 mes (y, en `manual`, también `current_period_end`; en `paypal`, no), filtrando por el ancla leída. Una cuenta `managed` sin ancla no se barre. | `src/lib/billing/statement-cron.ts` |
| Confirmar/anular: ancla = `max(period_end + 1 mes, ancla actual)`, así que pagar tarde no lo desplaza y un reintento no lo avanza dos veces. En `manual`, `current_period_end` = ancla; en `paypal` no se toca. La bitácora (`from_period_end`/`to_period_end`) registra el ancla y la respuesta añade `statementPeriodEnd`. | `src/lib/platform/statements.ts`, `src/app/api/platform/accounts/[id]/statements/settle.ts` |
| El webhook de PayPal no toca el ancla (no se modificó `webhook-events.ts`). | — |
| Spec §s10.4: un párrafo con la decisión del líder (2026-10-01). CHANGELOG y `docs/docker.md` hablan del ancla. | `progress/spec_facturacion-gestionada.md`, `CHANGELOG.md`, `docs/docker.md` |

### Tests nuevos o cambiados
- `src/app/api/billing/cron/route.test.ts` › «a PayPal renewal processed BEFORE the sweep (period end already in the future) still gets its overage billed»: `current_period_end` ya en diciembre y ancla en noviembre. Se emite el estado de noviembre, la cuenta queda `past_due` y `current_period_end` no se toca.
- › «is idempotent: three runs the same day issue ONE statement per account»: ahora comprueba además que el ancla de B avanzó una sola vez.
- › «PayPal with no overage: no statement, no cut-off, the anchor moves a month and the period stays PayPal’s».
- › «manual with nothing to bill (fee 0, no overage): the anchor and the period move together».
- › «a managed account with no anchor is not swept».
- `vi.setConfig({ testTimeout: 30_000 })` en ese archivo: siembra unos 14.000 entregados y, con la máquina a carga ~20, cuatro casos superaron los 5 s por defecto. Con la máquina libre tarda menos de 1 s.
- `src/app/api/platform/accounts/[id]/statements/route.test.ts` › «on time…» (manual: ancla y periodo = `period_end` + 1 mes), «late: paying on the 20th does not move the cut-off…» (el siguiente ancla parte del anterior), «PayPal: confirming moves the anchor and leaves current_period_end to PayPal», «a retry after a half-done confirmation does not move the anchor twice», «void…» (manual: ancla y periodo).
- `src/lib/platform/provisioning.test.ts` › `manualPlanRow` (NULL sin política; con `gestionado`, ancla = periodo; `direct` → NULL).
- `src/app/api/platform/accounts/[id]/plan/managed.test.ts`: manual, `statement_period_end === current_period_end`; PayPal, ancla a un mes y `current_period_end` NULL.
- `src/lib/security/tenant-isolation.test.ts` › cron A↔B con el ancla; el waiver del barrido pasa a `meta_billing` + `statement_period_end`.

### SQL listo, sin ejecutar en esta ronda
`progress/checks_statements.sql` gana el **§6**: dos suscripciones pasan a `managed` sin ancla, una con `current_period_end` y otra sin él. Se ejecuta `\i /tmp/078_statements.sql` y se comprueba el relleno (`= current_period_end` y `≈ now() + 1 mes`), que ninguna `direct` recibe ancla, y que una segunda pasada no mueve un ancla ya puesta. **Antes hay que copiar la migración al contenedor:** `docker cp supabase/migrations/078_statements.sql <c>:/tmp/078_statements.sql`.

### Verificación en esta ronda
- `TZ=UTC npm test` (suite completa, HEAD 827a032, antes del aviso de saturación): 271 archivos, **3876 tests** en verde. Esa pasada incluye todos los archivos tocados arriba.
- `npm run lint` (HEAD 827a032): 0 errores, 34 warnings preexistentes.
- `npm run typecheck`: ver la línea final.
- **No ejecutados, quedan para el líder en serie:** réplica + checks y build. Dos réplicas murieron por la saturación de Docker, no por la 078: una con `043_ai_handoff_mode.sql` y «the database system is in recovery mode», otra con «connection refused» al arrancar, y había contenedores de otros agentes con salida 137. El build se canceló siguiendo la instrucción.

### Límite conocido
Un mes PayPal sin excedente no deja estado, así que el periodo siguiente empieza en «ancla − 1 mes». Si el ancla recortó el mes (un día 31 que pasa a 28 de febrero), ese inicio puede solaparse unos días con el mes anterior, que no tiene estado. Es el mismo recorte de `addCycle` que se usa en el resto del repo. Si se quiere exactitud, habría que guardar también el inicio del periodo (`statement_period_start`).
- `npm run typecheck` (HEAD 827a032): verde.

## Tercera ronda (2026-10-01)

Rama `fg/statements`, worktree `.claude/worktrees/fg-statements`, sobre 827a032. Responde a los
cambios requeridos 1–3 de `progress/review_statements.md`, a la decisión del líder sobre el
hallazgo 4 y al hallazgo 8 (recomendado).

### Commits

- `b9f3e01` fix: lock_timeout en la 078 y bloqueo del corte condicionado al ancla (s10.4)
- `425c51e` fix: el banner del estado de cuenta solo habla del bloqueo si es suyo (s10.4)
- `576a5e0` fix: reasignar el plan gestionado conserva el ancla del corte (s10.4)

### Cambios

1. **078 `lock_timeout`** — `SET lock_timeout = '5s';` antes del `CREATE TABLE` (así cubre el primer
   `ALTER TABLE` y todo lo que sigue) y `RESET lock_timeout;` como última sentencia, igual que la
   075. Párrafo «Locks» en la cabecera. `progress/checks_statements.sql` §6: aserción `6e` nueva,
   tras re-ejecutar la 078, de que `lock_timeout` vuelve a `0` (no se queda puesto en la sesión).
2. **`applyLock` condicionado al ancla** — `src/lib/billing/statement-cron.ts`: el UPDATE añade
   `.eq('statement_period_end', sub.statement_period_end)`. Cubre los dos caminos que llaman a
   `applyLock` (autorreparación de un `issued` existente y emisión nueva).
3. **Banner** — `src/components/billing/billing-status-alert.tsx`: la variante bloqueada de
   `StatementDueAlert` solo con `readOnlyReason === 'statement'`. Con otro motivo de bloqueo se
   muestran **los dos**: el banner de la suscripción (título, cuerpo y «Regularizar» hacia
   `/billing`) y debajo el estado de cuenta en su variante de aviso (importe y días). Como
   `readOnlyReason` prioriza `statement` sobre `subscription` en `getEntitlements`, el motivo
   `subscription` implica que el estado de cuenta todavía no vence. La retención manual sigue
   ganando a todo.
4. **Ancla al reasignar (decisión del líder)** — `managedStatementAnchor(previous, now)` nuevo en
   `src/lib/platform/provisioning.ts`: si la cuenta ya era `managed` y tiene
   `statement_period_end`, se conserva; si no, `now() + 1 mes`. `loadCurrentSubscription` lee
   ahora `statement_period_end`. Lo usan `manualPlanRow` (5.º parámetro opcional `previous`, que
   `overridePlan` rellena con la suscripción actual) y `assignManagedPlanViaPayPal`
   (`src/lib/platform/managed-plan.ts`). Anotado en la spec §s10.4 junto al párrafo del ancla.
5. **«Ya pagué» en sesión de soporte (hallazgo 8)** — `StatementDueAlert` lee
   `useAuth().supportSession` (el mecanismo que ya usa `presence-heartbeat.tsx`, s9.12) y no pinta
   el botón durante la sesión. No toca la otra mitad del hallazgo (`claimedPaidAt` en
   `/api/billing/status`).

### Criterio ↔ test

| Cambio | Archivo | `it` |
|---|---|---|
| 2 | `src/app/api/billing/cron/route.test.ts` | `a payment confirmed between the listing and the lock leaves the account active` (comprobado que falla sin el `.eq`) |
| 3 | `src/components/billing/billing-status-alert.test.tsx` | `locked by the subscription with a statement not yet due: the subscription banner and its way out, the statement as a warning` |
| 8 | `src/components/billing/billing-status-alert.test.tsx` | `no «Ya pagué» during a support session: the route refuses it` |
| 4 | `src/lib/platform/provisioning.test.ts` | `managedStatementAnchor (s10.4)` › `keeps the anchor of an account already managed`; `a new one, a month on, for an account that becomes managed or has no anchor` |
| 4 (manual) | `src/lib/platform/provisioning.test.ts` | `a company that was already managed keeps its cut-off anchor, and the period follows it`; `a company that becomes managed now (it was direct) gets a new anchor, a month from the assignment` |
| 4 (manual, ruta) | `src/app/api/platform/accounts/[id]/plan/managed.test.ts` | `manual` › `re-assigning it to a company already managed keeps its cut-off anchor (and the period follows it)` |
| 4 (PayPal, ruta) | `src/app/api/platform/accounts/[id]/plan/managed.test.ts` | `paypal` › `re-assigning it to a company already managed keeps its cut-off anchor` |
| 4 (ancla nueva) | mismo archivo, ya existían | `manual` › `200: manual, active, monthly, cut-off in a month…`; `paypal` › `200: publishes the hidden plan…` (A era `direct`) |

### Verificación

- `npm run lint`: 0 errores (34 warnings previos, ninguno en archivos tocados).
- `npm run typecheck`: limpio.
- `npx vitest run` sobre `src/app/api/billing/cron/route.test.ts`,
  `src/lib/security/tenant-isolation.test.ts`, `src/components/billing/`,
  `src/lib/platform/provisioning.test.ts`, `src/app/api/platform/` y `src/components/layout`: todo
  verde. Suite completa y build no se repitieron (orden del líder).
- **Sin réplica**: Docker apagado por orden del humano. Ni `scripts/replay-migrations.sh` ni el §6
  de `progress/checks_statements.sql` (con la aserción `6e` nueva) se han corrido; quedan para el
  líder (cambio requerido 4 del reviewer).

### Decisiones

- Banner con motivo `subscription`: «los dos» en vez de solo el de la suscripción, para no esconder
  el importe y la fecha del estado de cuenta abierto.
- Ancla conservada en la manual: `current_period_end` toma el mismo valor que el ancla, porque en
  las cuentas `manual` el periodo sigue al ancla (spec §s10.4); si no, mostraría una renovación
  distinta del corte hasta la primera confirmación. En PayPal `current_period_end` sigue en `null`
  hasta el webhook, como antes.
- Una cuenta `direct` con un `statement_period_end` residual no lo reutiliza: solo cuenta el ancla
  si ya era `managed`.

### Deuda que queda (no tocada, por orden del líder)

- Hallazgo 5: `limit 200` por ancla ascendente; las cuentas atascadas (issued sin pagar, tarifa
  ausente, `incomplete` filtradas tras el LIMIT) pueden ocupar el lote.
- Hallazgo 6: solo se salta `incomplete`; una manual `cancelled`/`expired` recibe estado de cuenta
  con la cuota completa. Decide el humano.
- Hallazgo 7: el 403 de `enforce.ts` dice «subscription is 'active'» con `readOnlyReason =
  'statement'`.
- Hallazgo 8 (mitad): `/api/billing/status` no devuelve `claimedPaidAt`; el botón «Ya pagué» solo
  se oculta tras pulsarlo con estado local.
- Hallazgo 9: deriva del día por recorte de mes en `addCycle` (31 → 28).

Variables de entorno nuevas: ninguna. `.env.local.example` no se toca.
