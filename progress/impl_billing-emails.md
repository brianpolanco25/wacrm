# p11.7 `billing-emails` — informe del implementer

Estado: **listo para revisión** (no marcado `done`).

## Plan (de `specs/billing-emails/tasks.md`)

- [x] T0 Precondiciones.
- [x] T1 Migración 083 + bloque `-- 083 --` en verify-schema + `progress/checks_billing-emails.sql` (escrito, **no ejecutado**: Docker apagado).
- [x] T2 `src/lib/email/provider.ts` + tests (R4–R7).
- [x] T3 `src/lib/email/billing-templates.ts` + claves `Emails.billing` es/en + tests (R22–R24).
- [x] T4 Lógica pura en `src/lib/billing/billing-emails.ts` (R8, R11–R13, R18).
- [x] T5 `sweepBillingEmails` (R9, R10, R15–R20).
- [x] T6 Enganche en `GET /api/billing/cron` (R14).
- [x] T7 Caso A↔B en tenant-isolation + waivers (R21).
- [x] T8 `docs/docker.md` (R25).
- [x] T9 Alcance.
- [x] T10 lint + typecheck + test en verde, CHANGELOG, commits. `npm run build` y `scripts/replay-migrations.sh` **no se ejecutaron**: las condiciones de la sesión los prohíben.

## Rama y commits

Rama `pmd/billing-emails` (worktree `.claude/worktrees/pmd-billing-emails`), base `feat/precios-meta-directo` @ 74a5daa.

- `ae3f4cd` feat: migración 083, bitácora de correos de facturación (p11.7)
- `0c74b33` feat: correos de cuota gratis y de estados de cuenta desde el cron de facturación (p11.7)
- `b37e168` docs: variables de correo y avisos del cron de facturación (p11.7)

## T0: precondiciones (todas presentes en la base)

```
supabase/migrations/078_statements.sql            existe
src/lib/billing/statement-cron.ts                 existe (sweepStatements, StatementSweep)
src/app/api/billing/cron/route.ts                 existe (+ route.test.ts)
supabase/migrations/080_service_cap.sql:58        CREATE OR REPLACE FUNCTION public.service_quota_usage(p_account_id uuid, p_since timestamptz)
src/lib/billing/service-cap.ts                    SERVICE_FREE_TIER_PER_NUMBER, serviceMonthWindow, serviceCapState, loadServiceUsage
```

**Diferencias con la spec, manda el código integrado:**
- La constante de p11.3 se llama `SERVICE_FREE_TIER_PER_NUMBER` (no `SERVICE_FREE_TIER`). Se importa, no se duplica.
- p11.3 ya exporta `loadServiceUsage(db, accountId, now)`, que llama a la RPC con `p_since` = día 1 UTC y aplica `serviceCapState`. Se reutiliza en vez de llamar a `rpc()` a mano. La firma de la RPC coincide con la de la spec.
- No existe la migración 081 en la base (082 sí). No afecta.

## Criterio ↔ test

| Req | Archivo | `it` |
|---|---|---|
| R1 | `progress/checks_billing-emails.sql` §1, `supabase/ci/verify-schema.sql` bloque 083 | (SQL, no ejecutado) |
| R2 | `progress/checks_billing-emails.sql` §2 | (SQL, no ejecutado) |
| R3 | `progress/checks_billing-emails.sql` §3 | (SQL, no ejecutado) |
| R4 | `src/lib/email/provider.test.ts` | `resolveEmailProvider (R4)`: `no variables → …not_configured`, `the three HTTP variables → the HTTP provider`, `the HTTP variables win over EMAIL_PROVIDER=console`, `EMAIL_PROVIDER=console without the HTTP variables → console`, `%s → no provider, misconfigured` (5 casos), `an unknown EMAIL_PROVIDER…`, `reads process.env when called…` |
| R5 | `src/lib/email/provider.test.ts` | `one POST with the bearer key, JSON content type, the body and a 10 s timeout; 202 → ok`, `500 → error…`, `a rejected fetch → error…`, `a timeout (AbortError) → error`, `%s → error without calling fetch` (http externo, ftp, no-URL), `%s (a local relay) is allowed` |
| R6 | `src/lib/email/provider.test.ts` / `src/lib/billing/billing-emails.test.ts` | `neither the key nor an address reaches the error or the console`, `an absurdly long error name is cut to 300 characters` / `a failed send leaves the row failed with a clean error, and secrets stay out of the log and the base` |
| R7 | `src/lib/email/provider.test.ts` | `logs one info line with the kind, the recipient count and the subject, no addresses; counts as sent` |
| R8 | `src/lib/billing/billing-emails.test.ts` | `quotaEventFor (R8)` (799/800/999/1000/10-1), `monthKeyUtc (R8)` (31-dic 23:59, 1-ene 00:00), `the RPC gets the account and the first day of the month (UTC)` |
| R9 | `billing-emails.test.ts` | `850 → one 80 % email; 1.000 → one 100 % email; a third run → nothing`, `once the 100 % went out, no 80 % of that month follows` |
| R10 | `billing-emails.test.ts` | `a managed account with a number at 1.000: no email and no RPC call (R10)` |
| R11, R12 | `billing-emails.test.ts` | `statementEventsFor (R11, R12, R13)` (1 h, 73 h, paid/void, vencido 2 h, vence en 1 h, vencido 73 h, pagado tras vencer, ambos), `issued 1 h ago → statement_issued…`, `overdue and still issued → statement_due once` |
| R13 | `billing-emails.test.ts` | `a statement issued 10 days ago with an empty log sends nothing (no retroactive emails)` |
| R14 | `src/app/api/billing/cron/route.test.ts` | `200 with the statements block untouched and an emails block…`, `with a provider, the statement issued by this run is emailed…`, `the email sweep throwing → still 200, statements intact, emails.enabled false`, `the statement sweep throwing → the email sweep still runs and the answer stays 500`, `the email sweep runs AFTER the statements` |
| R15 | `billing-emails.test.ts` | `%s → enabled false and not a single query`, `the default resolution reads the environment: nothing set → off` |
| R16 | `billing-emails.test.ts` | `three runs in a row → one email per event`, `two runs at the same time → exactly one send`, `the reservation goes in BEFORE the provider is called` (mutación comprobada: con `ignoreDuplicates: false` el de concurrencia falla) |
| R17 | `billing-emails.test.ts` | `only the owner and the admins, once each, no blanks`, `an account with nobody to write to → skipped, no send`, `no blanks, no duplicates ignoring case, at most 20` |
| R18 | `billing-emails.test.ts` | `claimDecision (R16, R18)` (30 min, 61 min, pending > 1 h, pending 10 min, attempts = 3), `failed 30 min ago → not retried yet`, `failed 61 min ago → retried, attempts = 2, sent`, `attempts = 3 → never retried`, `the optimistic reclaim loses to a run that bumped attempts first` (mutación comprobada sin `.eq('attempts')`) |
| R19 | `billing-emails.test.ts` | `A's quota RPC fails → B still gets its email`, `a provider that throws…`, `the reservation table missing (code before migration 083)…`, `a client that throws on every call…`, `reads only; writes only notification_emails` |
| R20 | `billing-emails.test.ts` | `501 accounts with numbers → 500 treated and truncated`, `exactly 500 → not truncated` |
| R21 | `src/lib/security/tenant-isolation.test.ts` | `billing emails (p11.7, service role, cron)`: `every email carries only its own account's addresses and data, and every log row its account_id`, `A's email goes to A's owner only and names A's data…` (mutación comprobada: quitar `.eq('account_id')` de destinatarios rompe los dos). El `afterEach` del audit (`unscopedServiceRoleQueries`) pasa con dos waivers nuevos con motivo: `whatsapp_config` select `by: ['status']` y `statements` select `by: ['status','issued_at']` |
| R22 | `src/lib/email/billing-templates.test.ts` | `renderBillingEmail in %s (R22)` × es/en × 4 kinds; `src/i18n/*.test.ts` en verde |
| R23 | `billing-templates.test.ts` / `billing-emails.test.ts` | `the link line (R23)` (con barra, sin barra, varias barras, en, sin sitio) / `the link to /billing when NEXT_PUBLIC_SITE_URL is set (R23)` (con `vi.stubEnv`) |
| R24 | `billing-templates.test.ts` | `exact text in es (R24)` (los 4 kinds, texto exacto), `the month and the dates are UTC…` |
| R25 | `docs/docker.md` | revisión del diff |

## Compuerta

- `npm run lint`: 0 errores (34 warnings preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 296 archivos, 4.395 tests, verde.
- `npm run build`: **no ejecutado** (condición de la sesión).
- `scripts/replay-migrations.sh`: **no ejecutado** (Docker apagado, condición de la sesión).

## Verificaciones contra base real: pendientes

`progress/checks_billing-emails.sql` está escrito y **no se ha ejecutado**. Cubre R1 (23505 y `ON CONFLICT DO NOTHING`), R2 (23514 para kind, status, attempts y ref), R3 (authenticated con claims de un admin de A y anon: ni lectura ni escritura) y la FK (CASCADE solo desde `accounts`, sin otras FKs, nadie referencia la tabla). Hay que correrlo con `KEEP=1 scripts/replay-migrations.sh .claude/worktrees/pmd-billing-emails`, y aplicar la 083 una segunda vez para probar la idempotencia (las instrucciones están en la cabecera del archivo).

Revisé la 083 a mano:
- idempotente: `CREATE TABLE IF NOT EXISTS` con las restricciones dentro; `ENABLE RLS`, `REVOKE` y `COMMENT` se pueden repetir;
- UNIQUE `notification_emails_key (account_id, kind, ref)`;
- RLS activa sin políticas y `REVOKE ALL … FROM anon, authenticated`;
- el único CASCADE es `account_id → accounts ON DELETE CASCADE`, que borra la bitácora de una cuenta que se borra. No borra datos de clientes y nada apunta a esta tabla;
- aserciones en `verify-schema.sql`, en el bloque `-- 083 --` justo después de `-- /082 --` y dentro del único `DO`.

## Verificación manual (requiere un proveedor real; la hace el humano)

Es el guion de `requirements.md` §Guion manual:
1. Elegir un proveedor con API HTTP que acepte `POST {from,to[],subject,text}` con Bearer (S-B1), o poner un relé delante. Definir `EMAIL_API_URL`, `EMAIL_API_KEY` y `EMAIL_FROM` en `.env.local`.
2. Con un estado de cuenta `issued` de prueba (local), llamar a `GET /api/billing/cron` con `x-cron-secret`. Debe llegar el correo al owner y quedar `statement_issued / sent` en `notification_emails`. Al repetir la llamada no llega un segundo correo.
3. Poner a mano `due_at` en el pasado: llega `statement_due` una vez.
4. Insertar 800 filas `service` entregadas en `message_charges` para un número `direct` (local) y llamar al cron: llega el aviso del 80 %. Con 1.000 llega el del 100 %.
5. Con `EMAIL_API_KEY` incorrecta: la fila queda `failed`, `last_error` no contiene la clave y el resto del cron responde igual.

Supuestos por confirmar: S-B1 (formato HTTP), S-B2 (reglas de cuota de p11.3), S-B3 (idioma del despliegue) y S-B4 (sin enlace de baja), todos de `design.md`.

## Decisiones donde la spec era ambigua

1. **R3, «el SELECT devuelve 0 filas».** Con el `REVOKE ALL` que fija el diseño, el `SELECT` de `authenticated` falla con 42501 antes de llegar a la RLS, así que no devuelve 0 filas. El checks SQL acepta las dos cosas (42501 o 0 filas) para no depender de eso. Las dos niegan el acceso.
2. **Firma de `quotaEventFor`.** R8 dice `quotaEventFor(usage, monthKey)` y el diseño `quotaEventFor(u)`. Me quedé con la del diseño (devuelve el `kind`) y añadí `quotaRef(configId, monthKey)` para la `ref`.
3. **Fecha de vencimiento con hora y «UTC».** El diseño pide `dateStyle long + timeStyle short` en UTC. Se añade el sufijo literal ` UTC`, porque `dateStyle` no admite `timeZoneName` y sin él la hora es ambigua para un cliente en RD. Resultado en es: «4 de noviembre de 2026 a las 0:00 UTC».
4. **Periodo.** Se usa `period_start – period_end` tal cual, igual que `formatPeriod` en la UI de estados de cuenta. `period_end` es el instante del corte, así que el último día que se muestra es el del corte.
5. **Cuenta cuyo `meta_billing` no se pudo leer.** No se evalúa su cuota (`errors += 1`). Mejor un aviso de menos que uno a una cuenta `managed`.
6. **Orden de destinatarios.** Primero el owner, para que el tope de 20 no lo deje fuera.
7. **Error dentro de un evento ya reservado** (plantilla, destinatarios o un proveedor que lanza saltándose su contrato). La reserva pasa a `failed` con `last_error` = nombre del error y se reintenta pasada 1 h. Si ni eso se puede escribir, queda `pending` y R18 la recupera.
8. **Lectura de `whatsapp_config`.** Va paginada de 1.000 en 1.000 y se corta al encontrar la cuenta 501 (R20). `subscriptions` se lee en trozos de 100 cuentas por `.in()`. `statements` lleva `limit 1000`, sin tope por cuentas, porque son pocas en la ventana de 6 días.
9. **CHANGELOG.** La entrada va al final de `[Unreleased]`, justo antes de `## [0.8.1]`, para no chocar con la rama paralela `pmd/managed-usage-panel`. Si el líder prefiere el orden cronológico (las fases 10 y 11 van arriba), puede moverla al integrar.

## Variables de entorno nuevas

`EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` y `EMAIL_PROVIDER` (`console`), documentadas en `docs/docker.md`. **`.env.local.example` no se tocó (bloqueado para agentes): lo actualiza el humano.** Se leen además `NEXT_PUBLIC_SITE_URL` y `NEXT_PUBLIC_APP_LOCALE`, que ya existían.

## Alcance (T9)

`git diff --stat 74a5daa..HEAD`: 15 archivos y ninguno fuera de lo previsto. No cambian `src/app/api/whatsapp/webhook/route.ts`, `enforce.ts`, `entitlements.ts`, `statement-cron.ts` ni `package.json`. Sobre `statements`, `subscriptions`, `whatsapp_config` y `profiles` el barrido solo hace `select` (lo comprueba el test `reads only; writes only notification_emails`).

## Deuda detectada (fuera de alcance, sin tocar)

- Si el `UPDATE … status='sent'` falla justo después de un envío correcto, la fila queda `pending` y R18 la reintenta pasada 1 h, así que ese aviso se manda dos veces. Lo acepta el diseño (reservar primero cambia el riesgo de duplicado por el de «reservado y no enviado»). Queda anotado.
- `src/lib/security/tenant-isolation.test.ts` repite en dos tests el waiver de `subscriptions` del corte. Se podría subir a una constante compartida.
