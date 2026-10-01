# Review — s10.4 statements

**Veredicto:** APPROVED (tercera ronda, HEAD 576a5e0; la segunda ronda, HEAD 827a032, fue CHANGES_REQUESTED)

Rama `fg/statements`, worktree `.claude/worktrees/fg-statements`, rango `bfe366f..827a032` (9 commits). El diff coincide con lo que dice `progress/impl_statements.md` (43 archivos, sin `package.json`).

## Compuerta
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde, 271 archivos y 3876 tests (una pasada completa)
- build: no se corrió (lo corre el líder sobre la rama integrada, por orden de esta sesión)
- replay-migrations: n/a (Docker apagado por orden del humano)

### Revisión manual del SQL (sustituye a replay)
- `078_statements.sql` es idempotente: `CREATE TABLE/INDEX IF NOT EXISTS`, `DROP POLICY IF EXISTS` y luego `CREATE`, `DROP CONSTRAINT IF EXISTS` y luego `ADD`, `ADD COLUMN IF NOT EXISTS`, y un backfill que solo toca filas con `statement_period_end IS NULL` (si se vuelve a correr, no mueve anclas ya puestas).
- Backfill del ancla: `COALESCE(current_period_end, now() + 1 month)` y solo en filas `managed`. Es lo que pide la spec.
- CASCADE: `statements.account_id ... ON DELETE CASCADE` sigue el precedente de 075 (`message_charges`). Ninguna migración borra filas. Borrar una cuenta ya lo impide `subscriptions`, que no tiene CASCADE. Aceptado, con una observación: los estados de cuenta son registros financieros.
- **lock_timeout: falta** (cambio requerido 1).
- `verify-schema.sql` bloque `-- 078`: comprueba la tabla, las 23 columnas, el UNIQUE, los 5 CHECKs, el índice, RLS, la política solo SELECT `admin`, que no haya escritura para anon ni authenticated, los privilegios por columna, el CHECK de `action` y el ancla (nullable, y ninguna `managed` sin ella). Cubre todos los objetos nuevos.
- `checks_statements.sql` cubre lo que la spec exige de base real: §1 UNIQUE e idempotencia, con 3 upserts que dejan 1 fila, incluido el mismo instante escrito en otra zona horaria; §2 CHECKs; §3 bitácora; §4 RLS y privilegios por columna para owner de A y B, agent y anon; §5 FK; §6 backfill del ancla e idempotencia. Los §1 a §5 se ejecutaron en la primera ronda. **El §6 no se ha ejecutado** (el informe lo dice): queda para el líder junto con el replay, y necesita `docker cp` de la 078 al contenedor.

## Trazabilidad criterio ↔ test
- C1 «078: tabla, UNIQUE, columnas resumen, RLS admin+ y escritura solo service_role, actions nuevas»: [x] `verify-schema.sql` -- 078 + `checks_statements.sql` §1 a §5
- C2 «buildStatement solo cuenta `delivered` en el periodo, por número y categoría, con la tarifa vigente en `delivered_at`»: [x] `src/lib/billing/statements.test.ts` › "counts [start, end)…", "never counts a row of another account…"
- C3 «Broadcast con rechazados o sin `delivered_at` no se cobra»: [x] › "a broadcast of 1.000 marketing with 900 delivered and 100 failed adds 900 to the package"
- C4 «Excedente por orden de entrega»: [x] › "the package runs out halfway through a broadcast…" (entrada desordenada)
- C5 «PayPal: `plan_fee_usd = 0`; manual: cuota + excedente»: [x] › "with PayPal the fee is PayPal’s…", "with PayPal the total is the overage alone…", "the spec example: 9.000 marketing → 1.406"
- C6 «MetaRateMissingError tumba el estado entero (contrato s10.2)»: [x] › "a missing rate fails the WHOLE statement…"; `cron/route.test.ts` › "a missing Meta rate skips THAT account…"
- C7 «Cron: secreto, 503 sin variable, 401»: [x] `src/app/api/billing/cron/route.test.ts` › "503s while BILLING_CRON_SECRET is unset…", "401s a missing or wrong secret…" (`h.db.log` vacío)
- C8 «Cron: `issued`, `due_at = +3 d`, `past_due`, `grace_until = due_at`, sin tocar el periodo»: [x] › "issues the statement of a manual account…"
- C9 «Idempotente: 3 pasadas → 1 estado»: [x] › "is idempotent: three runs the same day…" (también comprueba que el ancla de B avanza una sola vez)
- C10 «Ancla propia: cortar por `statement_period_end` y no por `current_period_end`, más la carrera con PayPal»: [x] › "a PayPal renewal processed BEFORE the sweep…", "a managed account with no anchor is not swept"; asignación: `provisioning.test.ts` › manualPlanRow y `plan/managed.test.ts`
- C11 «PayPal sin excedente: no se emite y el periodo se extiende»: [x] › "PayPal with no overage: no statement, no cut-off, the anchor moves a month…"; manual con total 0: › "manual with nothing to bill…"
- C12 «Confirmar: `paid`, `active`, `grace_until = NULL`, +1 mes, bitácora antes»: [x] `src/app/api/platform/accounts/[id]/statements/route.test.ts` › "on time: …trail first"; 409, 500 sin escribir y 400 de validación
- C13 «Confirmar tarde no desplaza el corte»: [x] › "late: paying on the 20th does not move the cut-off…"; "a retry after a half-done confirmation does not move the anchor twice"
- C14 «Anular con motivo ≥10, misma extensión, bitácora»: [x] › "400s a missing or short reason…", "void, the account back to active…"
- C15 «Superadmin: acciones con rol de servicio filtradas por `account_id`, con test de fuga»: [x] `afterEach` de route.test.ts exige que B quede igual byte a byte; "404s B's statement addressed through A"; `tenant-isolation.test.ts` › "statements (s10.4, service role)" (6 casos más la auditoría automática de consultas)
- C16 «`GET /api/billing/statements` admin+, filtrado por cuenta, sin `billable` ni costo de Meta; fuga A↔B»: [x] `tenant-isolation.test.ts` › "GET /api/billing/statements: A's statements only, without what is internal", "403s an agent of A…"; `statements.test.ts` › "never carries billable, the Meta rate…"
- C17 «/billing: desglose y total»: [x] `src/components/billing/statements-section.test.tsx`
- C18 «Banner `statement_due` antes y después de `due_at`, enlace a /billing, botón "Ya pagué"»: [x] `billing-status-alert.test.tsx` › "before the due date…", "past the due date…", "a viewer is told the dates…", "the due-today wording"
- C19 «"Ya pagué" deja la nota y no cambia el estado»: [x] `tenant-isolation.test.ts` › "«Ya pagué» on A's statement leaves the note and changes nothing else"; `statements/route.test.ts`
- C20 «Un mensaje sin `pricing` no se factura y el estado lista cuántos hubo»: [x] `statements.test.ts` › "a delivered message without a Meta category is never billed…"
- C21 «8.200 entregados → 1.036 + 1.200 × 2,5 × 0,0113, costo real solo de lo billable»: [x] › "8.200 delivered…" (total 1.069,90, costo 520,26; leído)
- C22 «4.000 entregados = cuota exacta»: [x] › "a month with 4.000 delivered bills exactly the fee"
- C23 «Ninguna tarifa a 0 por mercado desconocido»: [x] › "no rate resolves to 0 for an unknown market…"
- C24 «CP11: entrante con la cuenta en solo lectura por estado de cuenta»: [x] `src/app/api/whatsapp/webhook/route.test.ts` › "stores it for a managed account read-only over an overdue statement (s10.4)"; `webhook/route.ts` no se toca y no consulta billing
- C25 «Correo opcional»: n/a. No hay proveedor en el repo y la spec dice que no bloquea la feature.
- Guion manual: está en el informe, pasos 1 a 7.

## Checkpoints
- CP1: [x] lint, typecheck y test ejecutados por mí, en verde. Build delegado al líder por orden de la sesión.
- CP2: [ ] Es idempotente y tiene aserciones, pero le falta `lock_timeout` (cambio 1). Replay n/a y §6 de checks sin ejecutar.
- CP3: [x] Todas las consultas con `supabaseAdmin()` filtran por `account_id`. El listado del cron es entre cuentas a propósito, con waiver en `tenant-isolation.test.ts`. Hay tests de fuga A↔B en las rutas del cliente, del superadmin y en el cron.
- CP4: [x] Cada criterio tiene un test leído, el SQL está en checks y el guion manual existe.
- CP5: [x] `package.json` no cambia.
- CP6: [x] Las claves nuevas existen en `es` y `en` con los mismos placeholders ICU (comprobado `Billing.statementAlert.*`). No hay `ko`.
- CP7: [x] `params: Promise<…>` en las rutas, como en `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`. `settle.ts` dentro de `app/` no es un archivo de ruta.
- CP8: [x] Lo que se toca fuera del núcleo (`provisioning.ts`, `managed-plan.ts`, ficha, `/billing`, status) está justificado por la spec y por la decisión del ancla.
- CP9: [x] CHANGELOG y `docs/docker.md` con `BILLING_CRON_SECRET`. Falta `.env.local.example`: estaba bloqueado por permisos y el informe lo anota para el humano.
- CP10: [x] 9 commits en español, con prefijo y `Co-Authored-By`; árbol limpio y nada pusheado.
- CP11: [x] El webhook no se toca, el cron solo escribe `statements` y `subscriptions` (hay test) y el entrante con bloqueo por estado de cuenta tiene test.

## Hallazgos (archivo:línea)
1. `supabase/migrations/078_statements.sql:136-165` — Falta `SET lock_timeout`. La 078 toma ACCESS EXCLUSIVE en `subscriptions` (`ADD COLUMN`, y el backfill `UPDATE` bloquea filas) y en `impersonation_log` (`ADD CONSTRAINT` valida la tabla entera). `subscriptions` se lee en cada escritura (`getEntitlements`). Si el ALTER espera detrás de una transacción larga, todas las lecturas se encolan detrás de él. La 075 ya resolvió esto con `SET lock_timeout = '5s'` / `RESET`.
2. `src/lib/billing/statement-cron.ts:125-128` (`applyLock`) — Escribe `status/grace_until` a partir de la foto de la suscripción tomada al listar, y filtra solo por `account_id`. Puede cruzarse con `settleStatement` (`src/lib/platform/statements.ts:281-305`), que escribe primero la suscripción y después el estado de cuenta. Secuencia: el barrido lista la cuenta con `status = 'active'` (PayPal la revivió, o es el caso de autorreparación). El operador confirma: la suscripción pasa a `active` y el ancla a +1 mes, pero el estado de cuenta sigue `issued`. El barrido lee `issued` y `applyLock` escribe `past_due` con el `grace_until` antiguo, que ya está vencido. Después el estado de cuenta pasa a `paid`. Resultado: una cuenta pagada queda en solo lectura y ningún barrido posterior la repara, porque el ancla ya está en el futuro.
3. `src/components/billing/billing-status-alert.tsx:76-83` — Si hay `status.statement`, se muestra `StatementDueAlert` con `locked = status.readOnly` sin mirar `readOnlyReason`. Si el bloqueo viene de la suscripción (cuota PayPal fallida con la gracia vencida, `expired`, etc.) y el estado de cuenta aún no vence, el cliente lee «Cuenta en solo lectura por estado de cuenta pendiente» y pierde el CTA del banner de la suscripción.

### No bloqueantes (para el líder o como deuda)
4. `src/lib/platform/provisioning.ts:334` y `src/lib/platform/managed-plan.ts:332` — Reasignar el plan gestionado a una cuenta que ya lo tiene reinicia el ancla en `now() + 1 mes`. Lo entregado entre el último corte (o el inicio) y la reasignación no cae en ningún estado de cuenta, porque `statementPeriodStart` retrocede como mucho un mes. Es lo que dice la spec («lo fija la asignación») y antes pasaba lo mismo con `current_period_end`, pero es ingreso perdido. Conviene conservar el ancla si la cuenta ya era `managed`.
5. `src/lib/billing/statement-cron.ts:250-265` — Con `limit 200` por ancla ascendente, las cuentas con un estado `issued` sin pagar, las que fallan siempre (tarifa ausente) y las `incomplete` (se filtran después del LIMIT) ocupan el lote en cada pasada. Con más de 200, las cuentas que acaban de cortar no se procesan nunca. Hoy no aplica por volumen.
6. `src/lib/billing/statement-cron.ts:263-265` — Solo se salta `incomplete`. Una cuenta manual `cancelled` o `expired` recibe al corte un estado de cuenta con la cuota completa. El humano debe decidir si es lo que quiere.
7. `src/lib/billing/enforce.ts:234` (no tocado, la spec lo veda) — Con `readOnlyReason = 'statement'` y `status = 'active'`, el 403 dice «read-only while its subscription is 'active'». Es deuda de texto.
8. El botón «Ya pagué» del banner solo se oculta con estado local: `/api/billing/status` no devuelve `claimedPaidAt`. Además aparece en sesión de soporte, donde la ruta responde 403.
9. Deriva por recorte de mes en `addCycle` (31 → 28 y se queda ahí). El informe ya lo declara.

## Cambios requeridos
1. `078_statements.sql`: poner `SET lock_timeout = '5s';` antes del primer `ALTER TABLE` (o al inicio) y `RESET lock_timeout;` al final, como en la 075.
2. `statement-cron.ts` `applyLock`: condicionar el UPDATE al ancla leída, añadiendo `.eq('statement_period_end', sub.statement_period_end)` (el settle la mueve antes de cerrar el estado de cuenta, así que la escritura atrasada no casa con ninguna fila). Añadir un test que simule la confirmación entre el listado y `applyLock` y compruebe que la cuenta queda `active`.
3. `billing-status-alert.tsx`: mostrar la variante bloqueada de `StatementDueAlert` solo si `readOnlyReason === 'statement'`. Con otro motivo de bloqueo, usar el banner de la suscripción (o los dos). Añadir un test con `readOnlyReason: 'subscription'` y un estado de cuenta todavía no vencido.
4. Tras los cambios, el líder corre en serie el replay y el §6 de `checks_statements.sql` (Docker) y el build.

## Tercera ronda (HEAD 576a5e0, sobre 827a032)

Commits: `b9f3e01` (lock_timeout y bloqueo condicionado al ancla), `425c51e` (banner), `576a5e0` (el ancla se conserva al reasignar). Árbol limpio, nada pusheado y con `Co-Authored-By`.

### Compuerta
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npx vitest run` sobre los archivos tocados y los vecinos (`cron/route.test.ts`, `plan/managed.test.ts`, `billing-status-alert.test.tsx`, `provisioning.test.ts`, `tenant-isolation.test.ts`, `platform/…/statements/route.test.ts`): 6 archivos y 241 tests en verde.
- Ni suite completa ni build, por orden del líder.
- replay-migrations: n/a (Docker apagado por orden del humano)

### Cambios requeridos de la segunda ronda
1. [x] `078_statements.sql` lleva `SET lock_timeout = '5s'` antes del primer DDL y `RESET lock_timeout` al final, con el porqué en la cabecera. Sigue siendo idempotente: el backfill y el resto no cambian. `checks_statements.sql` §6e comprueba que tras la 078 `lock_timeout` vuelve a `'0'`, aunque eso depende del valor por defecto de la sesión del contenedor. Queda sin ejecutar, con el §6.
2. [x] `statement-cron.ts:133-137`: `applyLock` filtra además por `.eq('statement_period_end', sub.statement_period_end)`. Test: `cron/route.test.ts` › "a payment confirmed between the listing and the lock leaves the account active". El test intercepta la primera lectura de `statements` y aplica en ese momento el patch del settle (`active`, ancla y periodo +1 mes), con el estado de cuenta aún `issued`. Comprueba que la cuenta queda `active` y sin gracia. Sin el filtro, `lockPatch(active)` escribiría `past_due` y el test fallaría: prueba exactamente la carrera.
3. [x] `billing-status-alert.tsx:84-97`: el texto de bloqueo del estado de cuenta solo sale con `readOnlyReason === 'statement'`. Si el bloqueo viene de otra causa, se muestra el banner de la suscripción con su CTA y debajo el estado de cuenta como aviso. Test: › "locked by the subscription with a statement not yet due…". Exige `lockedTitle` y `fixNow`, `data-statement-alert="due"`, «te quedan 2 días», y la ausencia de la variante `locked`.

### Hallazgos no bloqueantes atendidos
- 4 [x] `provisioning.ts` `managedStatementAnchor(previous, now)`: conserva el ancla solo si la cuenta ya era `managed` y tenía ancla. En cualquier otro caso (`direct` con un ancla vieja, `managed` sin ancla o sin fila) usa `now() + 1 mes`. En manual, `current_period_end` sigue al ancla. `loadCurrentSubscription` ahora lee `statement_period_end`, y la llamada de `assignManagedPlanViaPayPal` pasa `current`. Tests: `provisioning.test.ts` › `managedStatementAnchor` (los 4 casos), `overridePlan` › "…already managed keeps its cut-off anchor…" y "…becomes managed now (it was direct) gets a new anchor…"; `plan/managed.test.ts` › manual y PayPal "re-assigning it to a company already managed keeps its cut-off anchor" (sobre la ruta real con la base en memoria).
- 8 [x] (parcial) El botón «Ya pagué» se oculta en sesión de soporte (`useAuth().supportSession`). Test: › "no «Ya pagué» during a support session…". Sigue pendiente que `/api/billing/status` devuelva `claimedPaidAt`: es menor y queda como deuda.

### Sigue como deuda (sin cambio)
Hallazgos 5 (lote de 200), 6 (se factura a cuentas `cancelled`/`expired`; decide el humano), 7 (texto de `AccountLockedError`) y 9 (recorte del mes).

### Checkpoints que cambian
- CP2: [x] Idempotente, con `lock_timeout` y aserciones. Replay n/a y §6 sin ejecutar: queda pendiente del líder.

### Pendiente del líder antes del merge
Con Docker: `scripts/replay-migrations.sh` sobre el worktree, `checks_statements.sql` completo con `KEEP=1` (incluidos §6 y §6e; hace falta `docker cp` de la 078 a `/tmp`) y `npm run build` sobre la rama integrada. Al humano: añadir `BILLING_CRON_SECRET` a `.env.local.example`.
