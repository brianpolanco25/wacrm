# p11.7 `billing-emails`: requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-10-01 por `spec_author`.
Base de lectura: `feat/precios-meta-directo` @ be8ca0f, más la rama `fg/statements` (s10.4, en
curso en `.claude/worktrees/fg-statements` @ afa424b) y la spec de p11.3
(`specs/service-cap-per-number/requirements.md`, migración 080). i18n: `es` (por defecto) y `en`,
sin `ko` (CP6). El humano puso una regla: ninguna conexión de red fuera de la máquina, así que
todo `fetch` al proveedor de correo va mockeado en los tests.

## Dependencias (bloquean el arranque, no la spec)

1. **s10.4 `statements` integrada en `feat/precios-meta-directo`.** La tabla `statements` (078),
   `sweepStatements` (`src/lib/billing/statement-cron.ts`) y `GET /api/billing/cron`
   (`src/app/api/billing/cron/route.ts`) solo existen hoy en `fg/statements`. Hay que mergear
   `feat/facturacion-gestionada` (con s10.3 y s10.4) en `feat/precios-meta-directo` antes de lanzar
   esta feature. El líder lo hace y no forma parte de esta spec.
2. **p11.3 `service-cap-per-number` integrada.** Esta feature reutiliza su conteo: la RPC
   `service_quota_usage(p_account_id, p_since)` (080, R2 de p11.3) y la regla de «agotado» de
   `serviceCapState()` (R4 de p11.3: `used >= 1000` o `billable > 0`, mes natural UTC). No se
   define un segundo conteo. Si al implementar el nombre o la firma difieren de la spec de p11.3,
   manda lo que se haya integrado y el implementer lo anota en el informe.

## Contexto

La spec de la fase 10 deja el correo como opcional: «Correo opcional (si hay proveedor
configurado): al emitir y al vencer. Si no hay proveedor, solo banner» (§s10.4). s10.5 avisa al
80 % y al 100 % de la cuota gratis en el panel. Esta feature manda esos mismos avisos por correo.

**El repo no tiene proveedor de correo.** Un `grep` de `resend|sendgrid|nodemailer|smtp|sendEmail|
mailgun|postmark` en `src`, `docs` y `package.json` no encuentra ninguna integración. Los correos
de invitación y recuperación los manda Supabase Auth y no sirven para correos arbitrarios. Por eso
el diseño es una interfaz `EmailProvider` que por defecto está **apagada**, una implementación de
consola para desarrollo y una implementación HTTP genérica con `fetch` nativo, configurada por
variables de entorno y **sin dependencias nuevas** (CP5). El formato HTTP es un supuesto (S-B1).

## Criterios de aceptación de partida (nota de la feature y encargo del líder)

- **B1** Correo cuando un número de una cuenta `direct` llega al 80 % y al 100 % de la cuota gratis
  de servicio del mes.
- **B2** Correo cuando se emite un estado de cuenta (`statements.status = 'issued'`) y cuando vence
  (`due_at` pasado sin pagar).
- **B3** Un barrido dentro de un cron que ya existe, sin cron nuevo, que registra los envíos en la
  tabla `notification_emails` (migración **083**: `account_id`, `kind`, `ref`, `sent_at` y UNIQUE
  para no repetir).
- **B4** Destinatarios: el propietario y los admins de la cuenta (`profiles.email`).
- **B5** Plantillas de texto plano en es y en.
- **B6** Proveedor: interfaz con no-op por defecto, implementación HTTP genérica por variables
  (`EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM`) y ninguna dependencia nueva.
- **B7** Nunca bloquea nada si falla (CP11). Fuga A↔B (CP3).

## Requisitos (EARS)

### Almacenamiento

- **R1** (B3) El sistema debe tener la tabla `notification_emails` (`id uuid`, `account_id uuid NOT
  NULL` → `accounts`, `kind text NOT NULL`, `ref text NOT NULL`, `status text NOT NULL DEFAULT
  'pending'`, `attempts int NOT NULL DEFAULT 0`, `recipients int`, `last_error text`, `sent_at
  timestamptz`, `created_at`, `updated_at`) con `UNIQUE (account_id, kind, ref)`, creada por
  `supabase/migrations/083_notification_emails.sql` de forma idempotente.
  *Verificación:* `scripts/replay-migrations.sh` sale 0 con la 083 aplicada dos veces; aserciones
  en `supabase/ci/verify-schema.sql`; en `progress/checks_billing-emails.sql`, un segundo INSERT
  con la misma terna falla con `23505`.
- **R2** (B3) Cuando se escriba un `kind` fuera de `service_quota_80`, `service_quota_100`,
  `statement_issued` y `statement_due`, o un `status` fuera de `pending`, `sent`, `failed` y
  `skipped`, el sistema debe rechazarlo con una violación de CHECK.
  *Verificación:* `checks_…sql`, dos casos que esperan `23514`.
- **R3** (CP3) Mientras la sesión sea `anon` o `authenticated`, el sistema no debe dejar leer ni
  escribir `notification_emails` (RLS activa y sin políticas). Solo `service_role` accede.
  *Verificación:* `checks_…sql` con `SET ROLE authenticated` y los claims de un admin de la cuenta
  A: el `SELECT` devuelve 0 filas aunque existan filas de A, y el `INSERT` falla.

### Proveedor de correo

- **R4** (B6) Cuando `EMAIL_API_URL`, `EMAIL_API_KEY` y `EMAIL_FROM` estén definidas y no vacías,
  el sistema debe usar el proveedor HTTP. Si no lo están y `EMAIL_PROVIDER === 'console'`, debe
  usar el de consola. En cualquier otro caso no hay proveedor (`null`) y debe dar `reason` igual a
  `'not_configured'`, o `'misconfigured'` cuando falte alguna de las tres variables HTTP pero haya
  otra definida.
  *Verificación:* vitest de `resolveEmailProvider(env)` con cada combinación.
- **R5** (B6, S-B1) Cuando el proveedor HTTP envíe un correo, el sistema debe hacer una sola
  llamada `POST EMAIL_API_URL` con `Authorization: Bearer EMAIL_API_KEY`,
  `Content-Type: application/json` y el cuerpo `{ "from": EMAIL_FROM, "to": [..], "subject": "..",
  "text": ".." }`, con un timeout de 10 s. Una respuesta 2xx es `{ ok: true }`. Un código no 2xx,
  un error de red, un timeout o una URL que no sea `https:` (salvo `http://localhost` y
  `http://127.0.0.1`) es `{ ok: false, error }`, y nunca lanza.
  *Verificación:* vitest con `fetch` mockeado: URL, método, cabeceras, cuerpo, 202 → ok, 500 →
  error, rechazo de `fetch` → error, `AbortError` → error, `http://ejemplo.com` → error sin
  llamar a `fetch`.
- **R6** (secretos) Cuando el sistema registre un error de envío, debe guardar y loguear solo un
  mensaje de hasta 300 caracteres con el código HTTP o el nombre del error. Nunca el
  `EMAIL_API_KEY`, el cuerpo del correo ni las direcciones de los destinatarios.
  *Verificación:* vitest que espía `console.*` y la escritura en BD y comprueba que la clave de
  prueba y la dirección de prueba no aparecen.
- **R7** (B6) Cuando el proveedor sea el de consola, el sistema debe escribir una línea
  `console.info` con el `kind`, el número de destinatarios y el asunto (sin direcciones) y dar el
  envío por hecho.
  *Verificación:* vitest del proveedor de consola.

### Eventos

- **R8** (B1, dependencia 2) Cuando el barrido evalúe un número de una cuenta `direct` en el mes
  natural UTC en curso, debe generar `service_quota_100` si el número está agotado según la regla
  de p11.3, y `service_quota_80` si no lo está pero `used >= 800`. Usa
  `ref = '<whatsapp_config_id>:<YYYY-MM>'`.
  *Verificación:* vitest de `quotaEventFor(usage, monthKey)` (puro): 799/0 → ninguno; 800/0 →
  80; 999/0 → 80; 1000/0 → 100; 10/1 → 100; y `monthKey` del 31-dic 23:59 UTC y del 1-ene
  00:00 UTC.
- **R9** (B1) Cuando un número ya haya generado `service_quota_100` en un mes, el sistema no debe
  mandar después `service_quota_80` de ese mes. Cuando haya generado `service_quota_80`, el
  sistema debe mandar igualmente `service_quota_100` al agotarse.
  *Verificación:* vitest de `sweepBillingEmails` con un cliente falso: pasada 1 con 850 → un
  correo 80; pasada 2 con 1.000 → un correo 100; pasada 3 → ninguno.
- **R10** (B1, decisión) Cuando la cuenta sea `managed` (`metaBillingOf` de
  `src/lib/whatsapp/payment-method.ts`), el sistema no debe evaluar la cuota gratis ni llamar a
  `service_quota_usage` para esa cuenta. Motivo: la spec de la fase 10 (§s10.5) dice que la
  cuota gratis de Meta «no es dato de este cliente».
  *Verificación:* vitest: la cuenta `managed` con un número a 1.000 no genera correo ni llamada a
  la RPC.
- **R11** (B2) Cuando un estado de cuenta tenga `status = 'issued'` e `issued_at` en las últimas
  72 h, el sistema debe generar `statement_issued` con `ref = statements.id`.
  *Verificación:* vitest de `statementEventsFor(rows, nowMs)` (puro): emitido hace 1 h → sí; hace
  73 h → no; `paid` o `void` → no.
- **R12** (B2) Cuando un estado de cuenta siga en `issued` con `due_at <= now` y `due_at` en las
  últimas 72 h, el sistema debe generar `statement_due` con `ref = statements.id`.
  *Verificación:* el mismo test puro: vencido hace 2 h → sí; vence dentro de 1 h → no; vencido
  hace 73 h → no; pagado después de vencer → no.
- **R13** (B3, sin retroactivos) Cuando se configure un proveedor por primera vez, el sistema no
  debe mandar avisos de meses anteriores ni de estados de cuenta fuera de las ventanas de 72 h de
  R11 y R12.
  *Verificación:* implícito en R8, R11 y R12. Un caso de `sweepBillingEmails` con un estado de
  cuenta emitido hace 10 días y la tabla vacía no envía nada.

### Barrido

- **R14** (B3) Cuando se llame a `GET /api/billing/cron` con el secreto correcto, el sistema debe
  ejecutar `sweepBillingEmails` **después** de `sweepStatements`, en su propio `try`, y añadir a la
  respuesta un bloque `emails` sin cambiar los campos que ya devolvía. Si `sweepStatements` lanza,
  el barrido de correos se ejecuta igual y la respuesta sigue con su 500 actual.
  *Verificación:* `src/app/api/billing/cron/route.test.ts` con los dos módulos mockeados:
  respuesta 200 con `statements` y `emails`; `sweepBillingEmails` que lanza → 200 con
  `emails.enabled = false` y `statements` intacto; `sweepStatements` que lanza → se llamó a
  `sweepBillingEmails` y el código sigue en 500.
- **R15** (B6) Mientras no haya proveedor (R4 → `null`), el sistema debe devolver
  `{ enabled: false, reason }` sin hacer ninguna consulta a la base.
  *Verificación:* vitest de `sweepBillingEmails` con un cliente falso que cuenta las consultas
  (0).
- **R16** (B3, idempotencia) Cuando el barrido vaya a enviar un evento, debe reservarlo antes con
  un `INSERT … ON CONFLICT (account_id, kind, ref) DO NOTHING` que devuelva la fila. Solo envía si
  la inserción devolvió fila (o si recupera una fila según R18). Tras enviar, guarda `status =
  'sent'`, `sent_at` y `recipients`. Si el envío falla, guarda `status = 'failed'` y
  `last_error`.
  *Verificación:* vitest: dos `sweepBillingEmails` simultáneos sobre el mismo evento producen
  exactamente un `send`. Tres pasadas seguidas producen un solo correo por evento.
- **R17** (B4) Cuando el barrido resuelva los destinatarios de una cuenta, debe usar las
  direcciones de `profiles.email` con `account_id` igual a esa cuenta y `account_role IN
  ('owner','admin')`, sin duplicados, sin vacíos y como mucho 20. Si no queda ninguna, la
  reserva pasa a `status = 'skipped'` sin llamar al proveedor.
  *Verificación:* vitest con `owner`, `admin`, `agent`, `viewer`, un email duplicado y uno vacío
  (solo salen el owner y el admin una vez cada uno), y una cuenta sin admins (`skipped` y sin
  `send`).
- **R18** (fiabilidad) Cuando una reserva esté en `failed`, o en `pending` desde hace más de
  1 h, con `attempts < 3`, el siguiente barrido en que el evento siga siendo aplicable debe
  recuperarla con un `UPDATE` optimista (filtros `id`, `account_id` y el `attempts` leído) y
  reintentar. Con `attempts >= 3` no se reintenta nunca.
  *Verificación:* vitest con reloj inyectado: `failed` hace 30 min → no; hace 61 min → reintenta
  y `attempts = 2`; con `attempts = 3` → no.
- **R19** (CP11) Cuando cualquier paso del barrido falle (consulta, RPC, plantilla, proveedor), el
  sistema debe registrar una línea y seguir con el siguiente evento o la siguiente cuenta.
  `sweepBillingEmails` nunca lanza, y el barrido no toca `messages`, `conversations`,
  `subscriptions`, `statements` ni el webhook de WhatsApp.
  *Verificación:* vitest con la RPC de la cuenta A fallando: la cuenta B recibe su correo. Revisión
  del diff: `src/app/api/whatsapp/webhook/route.ts`, `enforce.ts` y `entitlements.ts` no cambian, y
  el barrido solo hace `select` sobre `statements` y `subscriptions`.
- **R20** (coste) El barrido debe tratar como mucho 500 cuentas con números conectados por
  pasada y, si hay más, poner `truncated: true` en el resumen.
  *Verificación:* vitest con 501 cuentas sintéticas.

### Aislamiento

- **R21** (CP3) Cuando el barrido mande el correo de un evento de la cuenta A, el sistema no debe
  incluir direcciones de la cuenta B ni datos (número, importe, periodo) de B, y la fila de
  `notification_emails` debe llevar el `account_id` de A. Toda consulta por cuenta con rol de
  servicio filtra por `account_id`. Las dos consultas que recorren todas las cuentas (números
  conectados y estados de cuenta recientes) tienen *waiver* con motivo en
  `src/lib/security/service-role-audit.ts`, si ese archivo cubre la ruta.
  *Verificación:* caso en `src/lib/security/tenant-isolation.test.ts` con A y B en el mismo
  umbral; `unscopedServiceRoleQueries` sin violaciones aparte de las dos con *waiver*.

### Plantillas

- **R22** (B5, CP6) El sistema debe generar asunto y cuerpo en texto plano de los cuatro `kind`
  desde las claves `Emails.billing.<kind>.subject` y `.body` de `messages/en.json` y
  `messages/es.json`, con `createTranslator` de `next-intl` y el idioma de
  `resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE)` (`src/i18n/request.ts`). Las dos versiones
  usan los mismos placeholders.
  *Verificación:* vitest de `renderBillingEmail` en es y en para los cuatro `kind`: sin `{`
  sueltas, sin keypaths crudos y con los valores sustituidos. `src/i18n/messages.test.ts` e
  `icu-safety.test.ts` en verde.
- **R23** (B5) Cuando `NEXT_PUBLIC_SITE_URL` esté definida, el sistema debe terminar el cuerpo con
  la línea `Emails.billing.link` y la URL `<site>/billing`, sin doble barra. Cuando no lo esté, el
  cuerpo no lleva enlace.
  *Verificación:* vitest con `vi.stubEnv` (con y sin barra final, y sin definir).
- **R24** (B1, B2) El correo de cuota debe nombrar el número con la misma cadena de la 053
  (`label` → `verified_name` → `display_phone_number` → `phone_number_id`), los usados, el
  límite de 1.000 y el mes. El de estado de cuenta, el periodo (`period_start`–`period_end`), el
  `total_usd` en US$ con dos decimales y la fecha de `due_at` en UTC.
  *Verificación:* vitest de `renderBillingEmail` con valores conocidos y aserción del texto
  exacto en es.

### Documentación

- **R25** (CP9) `docs/docker.md` debe documentar `EMAIL_API_URL`, `EMAIL_API_KEY`, `EMAIL_FROM` y
  `EMAIL_PROVIDER=console`, y explicar que los correos salen de `GET /api/billing/cron`, que por
  eso hay que programarlo también en despliegues sin cuentas `managed` si se quieren los avisos de
  cuota. `.env.local.example` queda para el humano: la edición está denegada a los agentes, igual
  que en p11.1.
  *Verificación:* revisión del diff de `docs/docker.md` y nota en el informe.

## Guion manual (requiere un proveedor de correo real; lo hace el humano)

1. Elegir un proveedor con API HTTP que acepte el cuerpo de R5 (S-B1) o poner un relé compatible
   delante. Definir las tres variables en `.env.local`.
2. Con un estado de cuenta `issued` de prueba (local), llamar a `GET /api/billing/cron` con
   `x-cron-secret` y comprobar que llega el correo al owner y que en `notification_emails` queda
   `statement_issued / sent`. Repetir la llamada: no llega un segundo correo.
3. Poner a mano `due_at` en el pasado: llega `statement_due` una vez.
4. Insertar 800 filas `service` entregadas en `message_charges` para un número `direct` (local) y
   llamar al cron: llega el 80 %. Con 1.000, llega el 100 %.
5. Con `EMAIL_API_KEY` incorrecta: la fila queda `failed`, `last_error` no tiene la clave, y el
   resto del cron responde igual.
