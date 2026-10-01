# p11.7 `billing-emails`: diseño

## Rama y orden

`pmd/billing-emails` desde `feat/precios-meta-directo` **después** de dos integraciones que hace el
líder (ver Dependencias en `requirements.md`):

1. `feat/facturacion-gestionada` con s10.3 y s10.4 (`fg/statements`) mergeada en
   `feat/precios-meta-directo`. Así existen `statements` (078), `sweepStatements` y
   `GET /api/billing/cron`.
2. p11.3 (`pmd/service-cap-per-number`) integrada. Así existen `service_quota_usage` (080) y
   `serviceCapState`.

```bash
git worktree add .claude/worktrees/pmd-billing-emails -b pmd/billing-emails feat/precios-meta-directo
```

Si al lanzarla falta alguna de las dos, el implementer **para** con `blocked` y no reimplementa ni
`statements` ni el conteo. La migración es la **083** (082 = p11.6). El replay debe aplicar
001–083 en orden.

## Supuestos sin verificar, que debe confirmar el humano

| Id | Supuesto | Si es falso |
|---|---|---|
| S-B1 | Existe un proveedor de correo con API HTTP que acepta `POST` JSON `{from, to[], subject, text}` con `Authorization: Bearer <clave>`. Es la forma de varios proveedores comerciales, pero en el repo no hay documentación de ninguno. | Se adapta solo `createHttpEmailProvider` (un archivo) o se pone un relé. La interfaz y el resto no cambian. |
| S-B2 | El conteo y la regla de «agotado» de p11.3 (S-C1…S-C4 de esa spec: 1.000 por número y mes natural UTC, sin `free_entry_point`, `billable = true` = agotado) son los de Meta. | Se corrigen en p11.3 y esta feature los hereda. |
| S-B3 | El idioma del correo es el del despliegue (`NEXT_PUBLIC_APP_LOCALE`), porque no hay idioma por usuario en la base (`src/i18n/request.ts`: el idioma es de despliegue). | Si algún día hay idioma por perfil, `renderBillingEmail` ya recibe `locale` por argumento. |
| S-B4 | Un correo transaccional de facturación al owner y a los admins no necesita enlace de baja. | Se añade una preferencia por perfil en otra feature. |

## Por qué en `GET /api/billing/cron` y no en `/api/webhooks/cron`

- `/api/webhooks/cron` corre **cada minuto** (`docs/docker.md`). El conteo de cuota es una
  agregación sobre `message_charges` del mes por cuenta, y hacerla 1.440 veces al día para un
  aviso que puede llegar con una hora de retraso es caro sin ganar nada.
- `/api/billing/cron` corre **cada hora** (doc de s10.4: «Run it at least hourly»), es el cron de
  facturación y emite los estados de cuenta en la misma pasada. Si los correos van justo después
  de `sweepStatements`, el aviso de emisión sale en esa misma ejecución.
- Coste: en despliegues sin cuentas `managed` hay que programar este cron también, si se quieren
  avisos de cuota. Se documenta (R25). Sin `BILLING_CRON_SECRET` la ruta sigue dando 503 y no hay
  correos. Es el comportamiento seguro.

## Migración `supabase/migrations/083_notification_emails.sql` (nuevo)

```sql
-- cabecera: qué registra, por qué UNIQUE (account_id, kind, ref), protocolo de reserva
-- (pending → sent | failed | skipped), por qué sin políticas RLS, y por qué el CASCADE desde
-- accounts es aceptable (es una bitácora de avisos, no dato del cliente).
CREATE TABLE IF NOT EXISTS notification_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  ref         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  recipients  integer,
  last_error  text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_emails_key UNIQUE (account_id, kind, ref),
  CONSTRAINT notification_emails_kind_check CHECK (kind IN
    ('service_quota_80','service_quota_100','statement_issued','statement_due')),
  CONSTRAINT notification_emails_status_check CHECK (status IN
    ('pending','sent','failed','skipped')),
  CONSTRAINT notification_emails_attempts_check CHECK (attempts >= 0),
  CONSTRAINT notification_emails_ref_check CHECK (length(ref) BETWEEN 1 AND 200)
);
ALTER TABLE notification_emails ENABLE ROW LEVEL SECURITY;
-- Sin políticas: authenticated/anon no ven ni escriben nada (R3). service_role se salta la RLS.
REVOKE ALL ON notification_emails FROM anon, authenticated;
```

- Con `CREATE TABLE IF NOT EXISTS` y las restricciones dentro del `CREATE`, la migración se puede
  aplicar dos veces. `ENABLE ROW LEVEL SECURITY` y `REVOKE` también se pueden repetir.
- Sin índice extra: el UNIQUE `(account_id, kind, ref)` sirve las búsquedas por cuenta del
  barrido.
- `ref` no tiene FK a `statements` ni a `whatsapp_config`: la bitácora sobrevive a un estado de
  cuenta anulado o a un número borrado. Así no se reenvía.
- `supabase/ci/verify-schema.sql`: bloque `-- 083 -- … -- /083 --` con la tabla, el UNIQUE, los
  tres CHECK y `relrowsecurity = true`.

## Proveedor: `src/lib/email/provider.ts` (nuevo)

```ts
export interface EmailMessage { to: string[]; subject: string; text: string; kind: string }
export type EmailSendResult = { ok: true } | { ok: false; error: string };
export interface EmailProvider {
  readonly name: 'http' | 'console';
  send(message: EmailMessage): Promise<EmailSendResult>; // nunca lanza
}
export type EmailProviderResolution =
  | { provider: EmailProvider; reason: null }
  | { provider: null; reason: 'not_configured' | 'misconfigured' };

export function resolveEmailProvider(env?: NodeJS.ProcessEnv): EmailProviderResolution; // R4
export function createHttpEmailProvider(cfg: { url: string; apiKey: string; from: string },
  fetchImpl?: typeof fetch): EmailProvider;                                       // R5, R6
export const consoleEmailProvider: EmailProvider;                                 // R7
export const EMAIL_SEND_TIMEOUT_MS = 10_000;
```

- HTTP: `fetchImpl(url, { method: 'POST', headers: { Authorization: \`Bearer ${apiKey}\`,
  'Content-Type': 'application/json' }, body: JSON.stringify({ from, to, subject, text }), signal:
  AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS) })`. Se valida la URL con `new URL()`: protocolo
  `https:`, o `http:` solo con host `localhost` o `127.0.0.1` (para un relé local). Si no, el
  resultado es `{ ok: false, error: 'invalid EMAIL_API_URL' }` sin `fetch`. No se lee el cuerpo
  de la respuesta salvo para descartarlo.
- Error: `` `HTTP ${status}` `` o `err.name` (`AbortError`, `TypeError`), recortado a 300
  caracteres. No incluye la clave, las direcciones ni el cuerpo (R6).
- `resolveEmailProvider` lee `process.env` cuando se llama, no al importar, para que
  `vi.stubEnv` funcione en los tests.

## Plantillas: `src/lib/email/billing-templates.ts` (nuevo)

```ts
export type BillingEmailKind = 'service_quota_80' | 'service_quota_100' | 'statement_issued' | 'statement_due';
export type BillingEmailParams =
  | { kind: 'service_quota_80' | 'service_quota_100'; number: string; used: number; limit: number; monthStart: string }
  | { kind: 'statement_issued' | 'statement_due'; periodStart: string; periodEnd: string; totalUsd: number; dueAt: string };
export function renderBillingEmail(params: BillingEmailParams, locale: Locale,
  siteUrl?: string | null): { subject: string; text: string };   // R22–R24
```

- `createTranslator({ locale, messages, namespace: 'Emails.billing' })` de `next-intl`. Lo
  reexporta `use-intl/core` tanto en `react-client` como en `react-server`, comprobado en
  `node_modules/next-intl/dist/types/*/index.d.ts`. Los catálogos `messages/en.json` y
  `messages/es.json` se importan estáticos (igual que en los tests de componentes).
- Formato, en el código y no en ICU, para no depender del parser de fechas: números con
  `Intl.NumberFormat(locale)`, US$ con `Intl.NumberFormat(locale, { minimumFractionDigits: 2,
  maximumFractionDigits: 2 })`, fechas con `Intl.DateTimeFormat(locale, { dateStyle: 'long',
  timeZone: 'UTC' })` (y `timeStyle: 'short'` para `dueAt`), y el mes con `{ month: 'long', year:
  'numeric', timeZone: 'UTC' }`. Los valores entran ya formateados como cadenas en el
  placeholder.
- Enlace (R23): si `siteUrl` no está vacío, se añade `\n\n` + `t('link', { url })` con
  `url = siteUrl.replace(/\/+$/, '') + '/billing'`.
- `Locale` y `resolveLocale` vienen de `src/i18n/request.ts`. Quien llama (el barrido) resuelve
  el idioma una vez por pasada.

## Barrido: `src/lib/billing/billing-emails.ts` (nuevo)

```ts
export const QUOTA_WARN_AT = 800;
export const SERVICE_FREE_TIER = 1000;          // o el que exporte p11.3, si existe: reutilizar
export const STATEMENT_EVENT_WINDOW_MS = 72 * 3600_000;
export const EMAIL_RETRY_AFTER_MS = 3600_000;
export const EMAIL_MAX_ATTEMPTS = 3;
export const EMAIL_SWEEP_ACCOUNT_LIMIT = 500;
export const EMAIL_MAX_RECIPIENTS = 20;

export function monthKeyUtc(nowMs: number): string;                       // 'YYYY-MM'
export function quotaEventFor(u: { used: number; billable: number }): 'service_quota_80' | 'service_quota_100' | null; // R8 (usa serviceCapState de p11.3 para «agotado»)
export function statementEventsFor(rows: StatementRow[], nowMs: number): Array<{ kind; ref; row }>; // R11, R12
export function claimDecision(existing: NotificationRow | undefined, nowMs: number):
  'insert' | 'reclaim' | 'skip';                                            // R16, R18

export interface BillingEmailSweep {
  enabled: boolean; reason?: 'not_configured' | 'misconfigured';
  accounts: number; truncated: boolean;
  sent: number; failed: number; skipped: number; errors: number;
}
export async function sweepBillingEmails(admin: SupabaseClient, opts?: {
  nowMs?: number; resolution?: EmailProviderResolution; locale?: Locale; siteUrl?: string | null;
}): Promise<BillingEmailSweep>;                                            // nunca lanza (R19)
```

Pasos de `sweepBillingEmails`:

1. Sin proveedor: `return { enabled: false, reason, … }` sin consultas (R15).
2. **Cuota (cuentas `direct`).** `whatsapp_config` `select('id, account_id, label,
   verified_name, display_phone_number, phone_number_id')`, `.eq('status','connected')`, orden por
   `account_id`. Es una consulta entre cuentas con *waiver* (R21). Se agrupa por cuenta y se cortan
   500 cuentas (R20). `subscriptions` `select('account_id, meta_billing')`
   `.in('account_id', ids)` y `metaBillingOf` de cada una, y las `managed` se saltan (R10). Para cada
   cuenta `direct`: `rpc('service_quota_usage', { p_account_id, p_since: monthStartIso })` (p11.3),
   y para cada fila `quotaEventFor`. Si el evento es `service_quota_80` y ya existe una fila
   `service_quota_100` del mismo `ref`, se salta (R9).
3. **Estados de cuenta.** `statements` `select('id, account_id, period_start, period_end,
   total_usd, status, issued_at, due_at')` `.eq('status','issued')`
   `.gte('issued_at', now - 72h - 3 días)`, que cubre las dos ventanas porque
   `due_at = period_end + 3 días` (s10.4). Es la segunda consulta entre cuentas con *waiver* (R21).
   Después, `statementEventsFor`.
4. **Bitácora existente.** Por cuenta con eventos: `notification_emails`
   `select('id, kind, ref, status, attempts, updated_at')` `.eq('account_id', a)`
   `.in('ref', refs)`.
5. **Por evento**, en orden y cada uno en su propio `try` (R19):
   - `claimDecision`. Si es `insert`: `upsert({ account_id, kind, ref, status: 'pending',
     attempts: 1, updated_at: now }, { onConflict: 'account_id,kind,ref', ignoreDuplicates: true
     }).select('id')`, y si viene vacío otro barrido ganó, así que se salta. Si es `reclaim`:
     `update({ status: 'pending', attempts: n + 1, updated_at: now }).eq('id').eq('account_id')
     .eq('attempts', n).select('id')`, y si viene vacío se salta. Si es `skip`, no hace nada.
   - Destinatarios (R17), una vez por cuenta y en caché durante la pasada: `profiles`
     `select('email, account_role')` `.eq('account_id', a)` `.in('account_role',
     ['owner','admin'])`, con `trim`, `toLowerCase` para deduplicar y un tope de 20. Sin ninguno:
     `update({ status: 'skipped', updated_at })` y se sigue.
   - `renderBillingEmail` y `provider.send({ to, subject, text, kind })`.
   - Si sale bien: `update({ status: 'sent', sent_at: now, recipients: to.length, last_error:
     null, updated_at })`. Si falla: `update({ status: 'failed', last_error: error, updated_at })`.
     Las dos con `.eq('id').eq('account_id')`.
6. Devuelve el resumen. Hay un `try/catch` externo que, si algo inesperado lanza, devuelve
   `{ enabled: true, errors: +1, … }` con lo que se llevaba.

Notas:
- El barrido **no escribe** en `statements`, `subscriptions`, `messages` ni `conversations` (R19).
- `claimDecision`: no hay fila → `insert`. `sent` o `skipped` → `skip`. `failed` o `pending` con
  `attempts < 3` y `updated_at <= now - 1 h` → `reclaim`. Cualquier otra cosa → `skip`.
- Etiqueta del número: `label || verified_name || display_phone_number || phone_number_id`,
  igual que la 053 y `whatsapp-config.tsx:313`. Es una función local `numberLabel()`, porque no
  hay helper compartido.
- `SERVICE_FREE_TIER`: si p11.3 exporta la constante (por ejemplo desde
  `src/lib/billing/service-cap.ts`), se importa esa en vez de duplicarla.

## Enganche: `src/app/api/billing/cron/route.ts` (de s10.4)

```ts
let statementsResult: StatementSweep | null = null;
let statementsError: unknown = null;
try { statementsResult = await sweepStatements(admin); } catch (err) { statementsError = err; }

let emails: BillingEmailSweep;
try {
  emails = await sweepBillingEmails(admin, {
    locale: resolveLocale(process.env.NEXT_PUBLIC_APP_LOCALE),
    siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? null });
} catch (err) { console.error('[GET /api/billing/cron] email sweep failed:', …);
  emails = { enabled: false, accounts: 0, truncated: false, sent: 0, failed: 0, skipped: 0, errors: 1 }; }

if (statementsError) { console.error(…); return NextResponse.json({ error: 'The statement sweep failed', emails }, { status: 500 }); }
return NextResponse.json({ statements: statementsResult, emails });
```

Así se conserva el contrato actual (200 con `statements` y 500 con `error`) y se añade `emails`
(R14). La cabecera del archivo gana un punto que explica el barrido de correos.

## Claves i18n (`Emails.billing`, es y en, mismos placeholders)

| Clave | en | es |
|---|---|---|
| `service_quota_80.subject` | `Cabbity CRM: {number} has used {used} of its {limit} free service messages` | `Cabbity CRM: {number} lleva {used} de sus {limit} mensajes de servicio gratis` |
| `service_quota_80.body` | `Your WhatsApp number {number} has used {used} of the {limit} service messages Meta delivers free each month ({month}). After {limit}, Meta charges every service message at the utility rate until the month ends.` | `Tu número de WhatsApp {number} ya usó {used} de los {limit} mensajes de servicio que Meta entrega gratis cada mes ({month}). Después de {limit}, Meta cobra cada mensaje de servicio a tarifa de utilidad hasta que acabe el mes.` |
| `service_quota_100.subject` | `Cabbity CRM: {number} used up its free service messages for {month}` | `Cabbity CRM: {number} agotó sus mensajes de servicio gratis de {month}` |
| `service_quota_100.body` | `Your WhatsApp number {number} has used the {limit} free service messages of {month}. From now until the month ends, Meta charges every service message at the utility rate to your payment method.` | `Tu número de WhatsApp {number} ya usó los {limit} mensajes de servicio gratis de {month}. Desde ahora y hasta que acabe el mes, Meta cobra cada mensaje de servicio a tarifa de utilidad en tu método de pago.` |
| `statement_issued.subject` | `Cabbity CRM: your statement for {period} is ready` | `Cabbity CRM: tu estado de cuenta de {period} está listo` |
| `statement_issued.body` | `Your statement for {period} is US$ {total} and is due on {dueDate}. If it is not paid by then, the account becomes read-only: you will keep receiving and reading messages, but you will not be able to send them.` | `Tu estado de cuenta de {period} es de US$ {total} y vence el {dueDate}. Si no está pagado para entonces, la cuenta pasa a solo lectura: seguirás recibiendo y leyendo mensajes, pero no podrás enviarlos.` |
| `statement_due.subject` | `Cabbity CRM: your statement for {period} is overdue` | `Cabbity CRM: tu estado de cuenta de {period} está vencido` |
| `statement_due.body` | `Your statement for {period} for US$ {total} was due on {dueDate} and has not been confirmed as paid. The account is now read-only: incoming messages are still received, but nothing can be sent until the payment is confirmed.` | `Tu estado de cuenta de {period} por US$ {total} venció el {dueDate} y no consta como pagado. La cuenta está en solo lectura: los mensajes entrantes se siguen recibiendo, pero no se puede enviar nada hasta que se confirme el pago.` |
| `link` | `Details: {url}` | `Detalles: {url}` |

`{period}` = «{periodStart} – {periodEnd}», ya formateado. `en` es la fuente de verdad. «Cabbity
CRM» es el nombre de marca que fija `src/i18n/brand.test.ts`. Ningún texto usa `{{…}}` ni HTML
(`icu-safety.test.ts`).

## Variables de entorno (documentadas en `docs/docker.md`, R25)

| Variable | Obligatoria | Qué es |
|---|---|---|
| `EMAIL_API_URL` | para mandar correos | Endpoint HTTPS del proveedor (S-B1). `http://` solo para `localhost`/`127.0.0.1`. |
| `EMAIL_API_KEY` | para mandar correos | Va en `Authorization: Bearer`. Nunca se loguea. |
| `EMAIL_FROM` | para mandar correos | Remitente, por ejemplo `Cabbity CRM <facturacion@ejemplo.com>`. |
| `EMAIL_PROVIDER` | no | `console` = escribe una línea por correo en el log en vez de enviarlo (desarrollo). Las tres de arriba tienen prioridad. |

Si falta alguna, no hay correo: el cron responde `emails.enabled = false` y solo quedan los
banners. Es el comportamiento por defecto.

## Manejo de errores (resumen)

| Caso | Resultado |
|---|---|
| Sin variables | `enabled: false`, sin consultas (R15) |
| Variables HTTP a medias | `enabled: false, reason: 'misconfigured'` |
| RPC de cuota o lectura de una cuenta falla | `errors += 1` y se sigue con la siguiente cuenta (R19) |
| Proveedor devuelve no 2xx, timeout o red | fila `failed` con `last_error` saneado; reintento ≥ 1 h, máx. 3 (R18) |
| Proceso muere tras reservar | fila `pending`; se recupera pasada 1 h (R18) |
| Sin admins con email | fila `skipped`, sin envío (R17) |
| Dos barridos a la vez | el UNIQUE y la reserva con `ignoreDuplicates` dejan un solo envío (R16) |
| `sweepBillingEmails` lanza (no debería) | la ruta lo captura; `statements` no cambia (R14) |

## Tests (todos sin red)

- `src/lib/email/provider.test.ts`: R4–R7.
- `src/lib/email/billing-templates.test.ts`: R22–R24 (es y en, los cuatro `kind`, enlace con y
  sin `NEXT_PUBLIC_SITE_URL`).
- `src/lib/billing/billing-emails.test.ts`: R8–R13, R15–R20, con `FakeDatabase` de
  `src/lib/security/fake-supabase.ts` (o un cliente falso propio si la RPC
  `service_quota_usage` no está en el fake; en ese caso se añade como en otros RPC del fake),
  proveedor falso y reloj inyectado.
- `src/app/api/billing/cron/route.test.ts` (existe tras s10.4): R14.
- `src/lib/security/tenant-isolation.test.ts`: R21, y los *waivers* de las dos consultas entre
  cuentas en `service-role-audit.ts` con su motivo, si el audit cubre la ruta.
- `progress/checks_billing-emails.sql`: R1–R3.

## Alternativas descartadas

- **SDK de un proveedor (Resend, SendGrid, nodemailer)**: es una dependencia nueva (CP5) y el
  humano no la ha aprobado. Con `fetch` nativo basta.
- **SMTP de Supabase Auth**: solo manda los correos de Auth (invitación, recuperación) y no expone
  API para correos arbitrarios.
- **Barrido en `/api/webhooks/cron`**: cada minuto, así que la agregación de cuota corre 60 veces
  más sin ganar nada (ver arriba).
- **Cron nuevo**: el encargo lo excluye, y una entrada más en el programador es justo lo que se
  olvida.
- **Mandar el correo dentro de `sweepStatements` al emitir**: acopla la emisión (crítica) a un
  proveedor externo. Si el correo fallara a mitad, complicaría la idempotencia de s10.4. Separado,
  un fallo de correo no toca la emisión.
- **Registrar después de enviar (sin reserva previa)**: dos barridos solapados mandarían dos
  correos. Reservar primero cambia ese riesgo por el de «reservado y no enviado», que R18
  recupera.
- **Un correo por destinatario**: N peticiones y estado parcial por evento. Los destinatarios son
  el mismo equipo de la misma cuenta, así que un único `to` no expone nada a terceros.
- **Correos de cuota a cuentas `managed`**: la spec de la fase 10 (§s10.5) excluye la cuota gratis
  de Meta de ese cliente. Su aviso es el del paquete (s10.5) y no entra aquí.

## Next 16 (CP7)

Solo se toca un route handler existente (`GET` en `route.ts`) sin cambiar su firma ni su
configuración de segmento. El implementer comprueba en
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` (existe) que `NextResponse.json` y los handlers `GET` siguen igual, y que
`AbortSignal.timeout` está disponible en el runtime Node 24 (sí lo está desde Node 17.3).
