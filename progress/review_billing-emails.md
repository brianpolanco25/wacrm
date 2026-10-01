# Review — p11.7 billing-emails

**Veredicto:** APPROVED

Rama `pmd/billing-emails` @ b37e168, base 74a5daa (3 commits: ae3f4cd, 0c74b33, b37e168). 15 archivos, coinciden con el informe.

## Compuerta
- lint: verde (0 errores, 34 warnings preexistentes, ninguno en archivos tocados)
- typecheck: verde
- test (`TZ=UTC npm test`, una pasada): verde, 296 archivos / 4.395 tests
- build: no ejecutado (orden del humano: no saturar la máquina)
- replay-migrations: n/a (Docker apagado por orden del humano)

### Migración 083, revisada a mano (no ejecutada)
- Idempotente: `CREATE TABLE IF NOT EXISTS` con todas las restricciones dentro; `ENABLE RLS`, `REVOKE` y `COMMENT` se pueden repetir.
- `UNIQUE notification_emails_key (account_id, kind, ref)`: sí.
- CHECK de `kind` (4 valores), `status` (4 valores), `attempts >= 0` y `length(ref) 1..200`: sí.
- R3: RLS activa, sin políticas, `REVOKE ALL … FROM anon, authenticated`: sí.
- CASCADE: solo `account_id → accounts ON DELETE CASCADE` (bitácora propia). No borra datos de clientes y nada referencia la tabla.
- `lock_timeout`: no lo hay. Solo hay ALTER sobre la tabla nueva (ENABLE RLS), así que no hace falta. El FK sí toma un lock SHARE ROW EXCLUSIVE breve sobre `accounts` (ver hallazgo 9).
- `verify-schema.sql`: bloque `-- 083 --` con tabla, 11 columnas, UNIQUE, 3 CHECK, RLS, ninguna política y ningún privilegio de cliente.
- **Sin verificar contra base real:** que aplicar la 083 dos veces salga 0, que `verify-schema.sql` pase, los 23505/23514 y la denegación a `authenticated`/`anon` de `progress/checks_billing-emails.sql` (escrito y leído, no ejecutado), que el `UPDATE profiles … account_role='admin'` del SQL no lo bloquee algún trigger, y que PostgREST devuelva una lista vacía en `upsert(ignoreDuplicates)+select` cuando hay conflicto (el fake lo simula). Hay que correrlo con `KEEP=1 scripts/replay-migrations.sh` antes del merge a la rama de fase.

## Trazabilidad criterio ↔ test
- R1 «tabla + UNIQUE, idempotente»: [x] `checks_billing-emails.sql` §1 + `verify-schema.sql` bloque 083 (sin ejecutar)
- R2 «CHECK kind/status → 23514»: [x] `checks_billing-emails.sql` §2 (sin ejecutar)
- R3 «anon/authenticated sin acceso»: [x] `checks_billing-emails.sql` §3 (acepta 42501 o 0 filas; correcto con REVOKE) (sin ejecutar)
- R4 «resolveEmailProvider»: [x] `src/lib/email/provider.test.ts` › `resolveEmailProvider (R4)` (none, http, http>console, console, 5 misconfigured, desconocido, lectura de env)
- R5 «POST, Bearer, JSON, 10 s, 2xx/500/rechazo/Abort/URL»: [x] `provider.test.ts` › `createHttpEmailProvider (R5)`. Comprueba la URL, el método, las cabeceras, el cuerpo y `AbortSignal.timeout(10000)`, y que con `http://ejemplo.com` no se llama a `fetch`
- R6 «sin clave, direcciones ni cuerpo; ≤300»: [x] `provider.test.ts` › `secrets (R6)`; `billing-emails.test.ts` › "a failed send leaves the row failed…" (consola + BD sin direcciones ni importe). Ver hallazgo 1 sobre la rama del `throw`
- R7 «consola»: [x] `provider.test.ts` › `consoleEmailProvider (R7)` (sin `@`)
- R8 «quotaEventFor, monthKey»: [x] `billing-emails.test.ts` › `quotaEventFor (R8)` (799/800/999/1000/10-1), `monthKeyUtc (R8)` (31-dic 23:59, 1-ene 00:00), "the RPC gets the account and the first day of the month"
- R9 «80 → 100 → nada; 100 tapa 80»: [x] "850 → one 80 %…; 1.000 → one 100 %…; a third run → nothing", "once the 100 % went out, no 80 %…"
- R10 «managed: sin correo ni RPC»: [x] "a managed account with a number at 1.000…" (aserta RPC solo para B)
- R11/R12 «ventanas 72 h»: [x] `statementEventsFor (R11, R12, R13)` (1 h, 73 h, paid/void, vencido 2 h, vence en 1 h, vencido 73 h, pagado tras vencer) + tests de barrido
- R13 «sin retroactivos»: [x] "a statement issued 10 days ago with an empty log sends nothing"
- R14 «cron: después, try propio, bloque emails, 500 intacto»: [x] `src/app/api/billing/cron/route.test.ts` › `billing emails in the same run (p11.7, R14)` (5 casos, incluido el orden y el 500)
- R15 «sin proveedor, 0 consultas»: [x] "%s → enabled false and not a single query" (`db.log` vacío) + resolución por defecto
- R16 «reserva antes de enviar, concurrencia»: [x] "three runs in a row", "two runs at the same time → exactly one send", "the reservation goes in BEFORE the provider is called" (lee la fila `pending` dentro de `send`)
- R17 «owner+admin por profiles.email, dedupe, ≤20, skipped»: [x] "only the owner and the admins…", "an account with nobody to write to → skipped", `recipientsFrom` (≤20). La consulta filtra `.eq('account_id')` + `.in('account_role',['owner','admin'])` (`billing-emails.ts:414-418`)
- R18 «reintento failed/pending viejas, optimista»: [x] `claimDecision` (30/61 min, pending >1 h, pending 10 min, attempts=3) + barrido (61 min → attempts=2 sent; attempts=3 nunca; reclaim concurrente → un envío). El UPDATE filtra `id`, `account_id` y `attempts` (`billing-emails.ts:502-504`)
- R19 «nunca lanza, no toca entrante»: [x] "A's quota RPC fails → B still gets its email", proveedor que lanza, tabla ausente, cliente que lanza en todo, "reads only; writes only notification_emails". En el diff no cambian webhook, `enforce.ts`, `entitlements.ts` ni `statement-cron.ts`
- R20 «tope 500»: [x] "501 accounts… → 500 treated and truncated" (500 RPC), "exactly 500 → not truncated"
- R21 «fuga A↔B»: [x] `src/lib/security/tenant-isolation.test.ts` › `billing emails (p11.7, service role, cron)`, dos tests. El primero va por la ruta real con el audit `unscopedServiceRoleQueries` y waivers con motivo para `whatsapp_config` y `statements`, según el patrón `extraWaivers` del repo. El segundo comprueba destinatario y datos (importe, número, periodo) de cada correo renderizado
- R22 «plantillas es/en»: [x] `src/lib/email/billing-templates.test.ts` › `renderBillingEmail in %s (R22)` ×2×4. `src/i18n/*.test.ts` en verde
- R23 «enlace /billing»: [x] `the link line (R23)` (con barra, sin barra, varias barras, en, sin sitio) + barrido con `vi.stubEnv`
- R24 «texto exacto es»: [x] `exact text in es (R24)` (4 kinds) + mes en UTC
- R25 «docs/docker.md»: [x] revisado el diff (las 4 variables, el cron también sin `managed`, `misconfigured`, S-B1). `.env.local.example` queda para el humano
- Guion manual del proveedor real: [x] en `requirements.md` §Guion manual y en el informe (5 pasos, incluido el de clave errónea → `failed` sin clave en `last_error`)

## Checkpoints
- CP1: [ ] parcial. lint, typecheck y test en verde, ejecutados por mí; build no ejecutado por orden del humano
- CP2: [x] revisado a mano (idempotente, aserciones, sin CASCADE sobre datos de clientes); [ ] replay sin ejecutar (Docker apagado)
- CP3: [x] todas las consultas por cuenta filtran `account_id` (profiles, notification_emails select/update, RPC `p_account_id`, subscriptions `.in('account_id')`, upsert con `account_id`); los dos listados entre cuentas llevan waiver; test A↔B leído
- CP4: [x] cada R tiene test leído o SQL; guion manual presente
- CP5: [x] `package.json` sin cambios; `fetch` nativo
- CP6: [x] `Emails.billing.*` con las mismas claves y placeholders en `es.json` y `en.json`; sin `ko`
- CP7: [x] no se usa ninguna API de Next nueva (Route Handler `GET` + `NextResponse`, igual que antes); `createTranslator` de next-intl ya se usa en el repo
- CP8: [x] alcance ajustado al spec. El CHANGELOG añade una línea en blanco de más en la sección p11.3 (cosmético)
- CP9: [x] CHANGELOG (Unreleased), `docs/docker.md` e informe coinciden con el diff
- CP10: [x] 3 commits en español con prefijo y `Co-Authored-By`; sin push
- CP11: [x] el barrido de correos va en su propio `try` después de `sweepStatements`; nunca lanza; no toca el webhook ni lo entrante

## Hallazgos (archivo:línea), ninguno bloqueante
1. `src/lib/billing/billing-emails.ts:556-558`: en la rama del `catch`, `logError` registra `err.message`. Si un proveedor rompe su contrato y lanza con la dirección en el mensaje, la dirección llega al log (la BD guarda solo `err.name`, bien). Los dos proveedores reales no lanzan. Para cumplir R6 al pie de la letra, loguear `err.name` también aquí.
2. `billing-emails.ts:536-558`: si `send` dio ok y falla el `finish('sent')`, el `catch` pone la fila en `failed` y al cabo de 1 h se reenvía (hasta 3 veces), sin sumar `sent`. Es el riesgo de duplicado que el informe declara como deuda; con `failed` en lugar de `pending` pasa lo mismo. Conviene recordar que el envío salió y no rebajar la fila.
3. `src/lib/email/provider.ts:74-77`: una `EMAIL_API_URL` no permitida (p. ej. `http://mail.internal`) da `enabled: true` y gasta los 3 intentos de cada aviso con «invalid EMAIL_API_URL». Cumple R5 tal como está escrito. Sería mejor que `resolveEmailProvider` lo reportara como `misconfigured`.
4. `billing-emails.ts:375-378`: `order('issued_at')` ascendente con `limit(1000)`. Si hubiera más de 1.000 estados `issued` en la ventana de 6 días, se descartan los más nuevos sin `truncated`. Hoy no ocurre por volumen; dejarlo anotado.
5. `billing-emails.ts:133-140`: un estado emitido tarde (cron caído, `due_at` ya pasado) manda `statement_issued` con una fecha de vencimiento pasada, junto al `statement_due` o en su lugar si `due_at` tiene más de 72 h. Caso límite de la combinación con s10.4.
6. `billing-emails.ts:175-186`: `numberLabel` mete la etiqueta editable del número en el asunto con solo `trim()`. Un CR/LF llegaría al campo `subject` del proveedor. Riesgo bajo (el destinatario es la misma cuenta y el cuerpo va en JSON), pero conviene quitar los caracteres de control.
7. `supabase/ci/verify-schema.sql:2353-2359`: no se aserta `notification_emails_ref_check` (cuenta 3 de las 4 CHECK).
8. `src/lib/email/billing-templates.ts:18-19`: importa los dos catálogos completos en el bundle del cron para cuatro cadenas. Además duplica `formatDay`/`formatUsd`/`formatPeriod` de `src/components/billing/statement-claim.ts`, sin su guarda de fecha inválida (una fecha inválida lanza `RangeError`; queda recogida en el `catch` y la fila acaba `failed`).
9. `supabase/migrations/083_notification_emails.sql:39-41`: el `REFERENCES accounts` toma un lock breve sobre `accounts`. 075/078/080/082 usan `SET lock_timeout = '5s'`. Por consistencia, se puede añadir.
10. `src/app/api/billing/cron/route.ts:60`: `supabaseAdmin()` sale del `try`. Si `createClient` lanza por falta de variables, la ruta da el 500 genérico de Next en vez del JSON anterior. Menor.

## Cambios requeridos
Ninguno bloqueante. Antes de integrar en la rama de fase: ejecutar `KEEP=1 scripts/replay-migrations.sh` con la 083 aplicada dos veces, más `progress/checks_billing-emails.sql`, y `npm run build`. Los hallazgos 1, 6 y 7 son baratos y se recomiendan.
