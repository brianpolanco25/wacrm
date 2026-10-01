# p11.7 `billing-emails`: tareas

Rama: `pmd/billing-emails` desde `feat/precios-meta-directo` **con s10.4 y p11.3 ya integradas**
(ver `design.md` §Rama y orden). Worktree: `.claude/worktrees/pmd-billing-emails`. Sin red: todo
`fetch` al proveedor de correo va mockeado. Informe en
`/Users/brian/Documents/Dev/projects/wacrm/progress/impl_billing-emails.md`, con el guion manual y
los supuestos S-B1…S-B4.

- [ ] **T0 Precondiciones.** Comprobar en el worktree que existen
  `supabase/migrations/078_statements.sql`, `src/lib/billing/statement-cron.ts`,
  `src/app/api/billing/cron/route.ts`, `supabase/migrations/080_service_cap.sql` (con
  `service_quota_usage`) y `serviceCapState` (p11.3). Si falta alguno, parar con `blocked` en
  `progress/impl_billing-emails.md` sin escribir código. — **dependencias** · Prueba: `ls` y `grep`
  copiados en el informe.
- [ ] **T1 Migración 083.** `supabase/migrations/083_notification_emails.sql` (tabla, UNIQUE,
  tres CHECK, RLS sin políticas, `REVOKE`, cabecera), el bloque `-- 083 --` en
  `supabase/ci/verify-schema.sql` y `progress/checks_billing-emails.sql` (duplicado `23505`,
  `kind` y `status` inválidos `23514`, `authenticated` sin lectura ni escritura). — **R1, R2, R3** ·
  Prueba: `scripts/replay-migrations.sh` sale 0 con 001–083, aplicar la 083 dos veces no falla, y
  el checks SQL con `KEEP=1`.
- [ ] **T2 Proveedor.** `src/lib/email/provider.ts` (`EmailProvider`, `resolveEmailProvider`,
  `createHttpEmailProvider` con `fetch` inyectable, timeout de 10 s, validación de URL,
  `consoleEmailProvider`). — **R4, R5, R6, R7** · Prueba: `src/lib/email/provider.test.ts` (cada
  combinación de variables, URL, método, cabeceras y cuerpo; 202, 500, rechazo, `AbortError`, URL
  `http:` externa sin `fetch`; clave y direcciones ausentes de logs y del error).
- [ ] **T3 Plantillas e i18n.** `src/lib/email/billing-templates.ts` (`renderBillingEmail` con
  `createTranslator` de `next-intl`, formato `Intl` en UTC y línea de enlace) y las claves
  `Emails.billing.*` en `messages/en.json` y `messages/es.json`. — **R22, R23, R24** · Prueba:
  `src/lib/email/billing-templates.test.ts` (los cuatro `kind` en es y en, texto exacto en es, sin
  keypaths ni `{` sueltas, enlace con y sin barra y sin variable), además de
  `src/i18n/messages.test.ts`, `icu-safety.test.ts` y `brand.test.ts` en verde.
- [ ] **T4 Lógica pura de eventos.** En `src/lib/billing/billing-emails.ts`: constantes,
  `monthKeyUtc`, `quotaEventFor` (con la regla de «agotado» de `serviceCapState`),
  `statementEventsFor` y `claimDecision`. — **R8, R11, R12, R13, R18 (decisión)** · Prueba:
  `src/lib/billing/billing-emails.test.ts`, casos puros con reloj inyectado (799/800/999/1000/10-1,
  cambio de año, ventanas de 72 h, `paid`/`void`, `failed` a 30 y a 61 min, `attempts = 3`).
- [ ] **T5 Barrido.** `sweepBillingEmails` en el mismo archivo: sin proveedor no hace consultas,
  cuentas `direct` con tope de 500, `managed` sin RPC, estados de cuenta recientes, bitácora por
  cuenta, reserva con `upsert … ignoreDuplicates` o `update` optimista, destinatarios owner y
  admins (dedup, tope de 20, `skipped`), envío y cierre `sent`/`failed`, un `try` por evento y
  nunca lanza. — **R9, R10, R15, R16, R17, R18, R19, R20** · Prueba: `billing-emails.test.ts`
  con cliente falso y proveedor falso: 80 y luego 100 sin repetir; tres pasadas, un correo; dos
  barridos concurrentes, un `send`; `managed` sin RPC; RPC de A que falla y B recibe; 501
  cuentas → `truncated`; 0 consultas sin proveedor; solo `select` sobre `statements` y
  `subscriptions`.
- [ ] **T6 Enganche en el cron de facturación.** `src/app/api/billing/cron/route.ts`:
  `sweepBillingEmails` después de `sweepStatements`, cada uno en su `try`, el bloque `emails`
  aditivo, se conserva el 500 si falla `sweepStatements`, y cabecera actualizada. — **R14** ·
  Prueba: `src/app/api/billing/cron/route.test.ts` (200 con los dos bloques; correo que lanza → 200
  con `statements` intacto; estados que lanzan → correos ejecutados y 500).
- [ ] **T7 Aislamiento.** Caso en `src/lib/security/tenant-isolation.test.ts` (A y B en el mismo
  umbral y con un estado de cuenta cada una: cada correo lleva solo direcciones y datos de su
  cuenta, y cada fila su `account_id`). *Waivers* con motivo para las dos consultas entre cuentas
  en `src/lib/security/service-role-audit.ts`, si el audit cubre la ruta. — **R21** · Prueba: ese
  test, con `unscopedServiceRoleQueries` sin violaciones nuevas.
- [ ] **T8 Documentación.** `docs/docker.md`: las cuatro variables de correo y, en la sección de
  `GET /api/billing/cron`, que también manda los avisos y que hay que programarlo aunque no haya
  cuentas `managed` si se quieren los de cuota. En el informe, la nota de que
  `.env.local.example` queda para el humano. — **R25** · Prueba: revisión del diff.
- [ ] **T9 Alcance.** El diff no toca `src/app/api/whatsapp/webhook/route.ts`, `enforce.ts`,
  `entitlements.ts`, `statement-cron.ts` (salvo que se importe), `package.json` ni las tablas que
  el barrido solo lee. — **R19, CP5, CP8** · Prueba: `git diff --stat` contra la base de la rama.
- [ ] **T10 Compuerta en verde + CHANGELOG.** `npm run lint && npm run typecheck && TZ=UTC npm
  test && npm run build` (con las variables dummy de `docs/harness.md`) y
  `scripts/replay-migrations.sh` en verde. Entrada en `CHANGELOG.md` (Unreleased): correos de
  facturación opcionales, variables nuevas y «migración 083: aplicar antes del código» (si el
  código va primero, la reserva falla, cuenta como `errors` en el resumen y el cron sigue).
  Informe `progress/impl_billing-emails.md`. Commits en español con prefijo y `Co-Authored-By`,
  sin push. — **todos** · Prueba: la compuerta.
