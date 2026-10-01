# Spec fase 10 — Facturación gestionada de Meta: plan oculto, pago manual o PayPal, corte a 3 días

**Estado: APROBADA por el humano el 2026-09-30 (noche).** Base real: `feat/superadmin` @ 4ad530f (fase 9 completa + s9.11–s9.13), equivalente a main tras el merge pendiente. **i18n: solo `es` (defecto) y `en`**: el coreano se retiró en s9.9; donde esta spec dice «es/en/ko» léase «es/en». Regla del humano: ningún agente hace conexiones de red fuera de la máquina (Docker con imagen presente, fetch mockeado; lo que exija Meta o PayPal reales queda como guion manual). Numeración de fase y de
migraciones provisional: la fase 9 usó 069–074 (074 = plan ilimitado), así que esta arranca en la 075.
Pedido por el humano el 2026-09-30, a raíz del cambio de precios de Meta del 2026-10-01
(los mensajes de servicio dejan de ser gratis: 1.000 entregados gratis por número y mes, después a
tarifa de utilidad; RD cae en «Resto de Latinoamérica»: 0,0113 servicio/utilidad, 0,0740 marketing).

## Contexto y decisiones del humano

Un cliente no quiere pagarle a Meta: quiere pagarle a Cabbity por el uso y que Cabbity pague a Meta.
Decisiones tomadas en la conversación del 2026-09-30:

1. **Opción A**: el WABA del cliente vive en el portafolio de Meta de Cabbity, con la tarjeta de
   Cabbity como método de pago. Se salta el Embedded Signup y se usa la configuración manual que el
   CRM ya tiene (token de usuario de sistema, permanente). La propiedad del WABA y qué pasa al
   terminar van por contrato; no es tarea de código.
2. **Plan oculto** (`is_public = false`), asignado a mano desde el superadmin. Nunca aparece en
   `/billing` ni en el onboarding.
3. **Paquete fijo de 7.000 mensajes + excedente, pagado al corte del mes.**
   - Cuota fija mensual = 7.000 × tarifa de marketing de Meta en RD × 2 = **1.036 USD**, se consuma
     o no. Incluye 7.000 mensajes entregados de cualquier categoría, sumando todos los números.
   - Del mensaje 7.001 en adelante, cada uno a **2,5 × la tarifa de Meta de su categoría**.
   - Se cuentan **todos los mensajes entregados**, también los que a Meta no le cuestan (los 1.000
     de servicio gratis por número y mes y los de la ventana de 72 h). La marca `billable` de Meta
     se guarda igual: separa el costo real del margen. Sin categoría de Meta (reacciones, estados
     sin `pricing`) no se cuenta ni se cobra.
   - **Todo se paga al corte del mes**, no por adelantado: así el estado de cuenta ya dice si
     consumió más o menos que el paquete.
   - Sin ITBIS en el estado de cuenta (se factura fuera, con el ERP). Solo USD.
   - **Sin tope de envíos** para este plan.
   - La cuota, los mensajes incluidos y el **precio por mensaje** (por categoría, como
     multiplicador o como importe fijo en USD) se pueden modificar por cuenta desde el superadmin.
     Ejemplos con marketing en RD (0,0740): 4.000 envíos → 1.036; 9.000 envíos → 1.036 + 2.000 ×
     0,0740 × 2,5 = 1.406 (Meta cobró 666).
   **Perfil de este cliente: volumen alto de plantillas de marketing.** Marketing es la categoría
   cara (0,0740 en RD, sin cuota gratis ni descuento por volumen), así que el grueso del costo real
   y del adelanto en la tarjeta de Cabbity es marketing: 10.000 envíos = 740 USD que Cabbity paga
   antes de cobrar al corte. El humano lo acepta sin depósito ni tope.
4. **Método de pago elegible por cuenta: `manual` o `paypal`.**
   - `manual`: el estado de cuenta del corte lleva cuota + excedente; el superadmin confirma con un
     botón que recibió el pago.
   - `paypal`: la cuota fija (1.036) va por la suscripción de PayPal; el excedente es un estado de
     cuenta al corte que se confirma a mano (PayPal no cobra importes variables en una
     suscripción). **Confirmado:** el excedente impago corta igual a los 3 días aunque PayPal haya
     cobrado la cuota.
5. **Corte = solo lectura, como hoy.** Si el estado de cuenta no está confirmado 3 días después de
   la fecha de corte, la cuenta pasa a solo lectura: no envía ni escribe, sigue viendo la bandeja y
   **lo entrante nunca se bloquea** (CP11). Al confirmar el pago vuelve todo.
6. **Banner al cliente** desde la fecha de corte: importe, periodo y días que le quedan.

## Lo que ya existe y se reutiliza

- `subscriptions` (041/056/058): `provider` (`'manual'` ya previsto en s9.4 para cuentas comped),
  `status` con `past_due`, `grace_until`, `current_period_end`, `cycle`, `manual_hold_at`.
  `getEntitlements()` en `src/lib/billing/entitlements.ts` ya deriva `readOnly` de
  `past_due` + `grace_until` vencido. **El corte a 3 días no necesita un estado nuevo**: es
  `past_due` con `grace_until = corte + 72 h`.
- `BillingStatusAlert` (`src/components/billing/billing-status-alert.tsx`) ya muestra aviso en
  `past_due` con fecha y bloqueo en solo lectura. Gana una variante para el estado de cuenta.
- `enforce.ts` bloquea el envío (composer, IA, broadcasts, API) cuando `readOnly`; no se toca.
- Superadmin (fase 9): `/platform/[id]` con ficha, historial y suspender/reactivar; s9.3 edita
  `plans` con `is_public`; s9.4 asigna plan a mano con motivo y bitácora
  (`impersonation_log.action = 'plan_override'`). Esta fase extiende ambos.
- Crons con secreto en cabecera `x-cron-secret` (`/api/automations/cron`, `/api/flows/cron`,
  `/api/webhooks/cron`; ver `docs/docker.md`). Se añade uno más con el mismo patrón.
- `message_charges` (075, s10.1) guarda por `wamid` cuenta, número, categoría y si Meta cobró: es la fuente del corte. `usage_counters` sigue contando
  el consumo del plan; el consumo de Meta se cuenta aparte, desde lo que Meta dice que cobró.
- Configuración manual de WhatsApp (`whatsapp-config.tsx`, modo self-hosted) y
  `token-renewal.ts` (067), que debe ignorar configs sin caducidad.

## Features

### s10.1 `meta-pricing-capture` — guardar lo que Meta cobra por cada mensaje

**Revisión del líder (2026-09-30, tras el bloqueo del implementer):** `messages` no tiene `delivered_at` ni
`whatsapp_config_id` (la 053 los puso en `conversations` y `broadcasts`), y las difusiones no escriben en
`messages` sino en `broadcast_recipients`. Guardar el `pricing` en `messages` dejaría fuera las plantillas
de marketing masivas, que son el grueso de este cliente. **Decisión: opción B, tabla propia.**

- Migración `075_message_charges.sql`: tabla `message_charges` (`id uuid`, `account_id uuid NOT NULL`,
  `whatsapp_config_id uuid` (del número que envió; FK `ON DELETE SET NULL`), `wamid text NOT NULL UNIQUE`,
  `message_id uuid` nullable → `messages`, `broadcast_recipient_id uuid` nullable → `broadcast_recipients`
  (ambas `ON DELETE SET NULL`; la fila de cobro sobrevive al borrado del mensaje, como `billing_events`),
  `recipient_phone text` (para resolver el mercado), `pricing_category text NOT NULL` (texto libre: Meta puede
  mandar `marketing_lite`, `referral_conversion`, variantes con guion; la lista conocida vive en código),
  `pricing_billable boolean`, `pricing_type text`, `pricing_model text`, `status text` (`sent|delivered|
  read|failed`), `sent_at timestamptz`, `delivered_at timestamptz`, `created_at`). Índices: `(account_id,
  delivered_at)`, `(whatsapp_config_id, delivered_at)`. RLS: SELECT `admin+` de la cuenta vía
  `can_read_account`; escritura solo `service_role`. Sin tocar `messages` (CP11: ningún lock sobre la
  tabla del entrante).
- Webhook `src/app/api/whatsapp/webhook/route.ts`: `WhatsAppStatus` declara `pricing`; en el primer estado
  con `pricing` se hace `INSERT … ON CONFLICT (wamid) DO UPDATE` que solo rellena lo que falta (nunca pisa
  con NULL) y actualiza `status`/`delivered_at` cuando llega `delivered`. El `wamid` se resuelve contra
  `messages.wa_message_id` **y** contra `broadcast_recipients` (mira cómo guarda cada uno el id de Meta y el
  número); `account_id` y `whatsapp_config_id` salen de ahí (de la conversación/difusión en el momento del
  envío: queda fijo aunque la conversación cambie de número después). Un estado sin `pricing` no crea fila.
  Cualquier error en este camino se registra y **nunca** hace fallar el webhook.
- Lo anterior a la migración no se reconstruye: no hay dato.
- Tests: payload con `pricing` para mensaje de conversación y para destinatario de difusión; sin `pricing`;
  estado repetido que no sobreescribe; `delivered` tardío tras `read` que no retrocede `status`; categoría
  desconocida (`marketing_lite`) que se guarda tal cual; CP11 (entrante y estados se guardan con la cuenta
  `incomplete`/solo lectura). SQL de base real: RLS (A no lee cargos de B), UNIQUE de `wamid`.
- Deuda detectada, fuera de alcance: `messages.status` admite retroceder (`delivered` tardío pisa `read`).
- **Para s10.4/s10.5:** `buildStatement` y el panel leen de `message_charges`, no de `messages`; el
  checkpoint «difusión de 1.000 con 900 entregados suma 900» se cumple con las filas `delivered`.

### s10.2 `meta-rate-card` — tarifario de Meta y multiplicador por cuenta
- Migración `076_meta_rates.sql`: tabla `meta_rates (market text, category text, usd_per_message
  numeric(8,5), effective_from date, PRIMARY KEY (market, category, effective_from))` y
  `meta_market_countries (country_code text PRIMARY KEY, market text)`. Semilla con la tarjeta del
  2026-10-01 para Resto de Latinoamérica (RD y vecinos), México, Colombia, Brasil, Norteamérica y
  España; el resto se carga desde el superadmin. RLS: lectura para autenticados, escritura solo
  `service_role`.
- `src/lib/billing/meta-rates.ts`: `rateFor(countryCode, category, at)` (país del destinatario con
  `phone-utils`; mercado desconocido → `'rest_of_world'` si existe, si no error visible, nunca 0).
- `subscriptions.meta_billing text NOT NULL DEFAULT 'direct' CHECK IN ('direct','managed')` y
  `subscriptions.meta_pricing jsonb NOT NULL DEFAULT '{}'` (misma migración) con la política de
  precio de la cuenta; la del plan `gestionado` es `{"included_messages": 7000, "fee_usd": 1036,
  "overage": {"service": {"multiplier": 2.5}, "utility": {"multiplier": 2.5}, "marketing":
  {"multiplier": 2.5}, "authentication": {"multiplier": 2.5}, "authentication_international":
  {"multiplier": 2.5}}}`. Cada categoría admite `multiplier` **o** `usd_per_message` (importe
  fijo, gana sobre el multiplicador): es lo que permite «modificar el precio por mensaje» sin
  migración. `{}` = cuenta `direct`, sin precio. Validador con zod en
  `src/lib/billing/meta-pricing.ts`. Tramos de volumen de utilidad/autenticación: no se modelan;
  el costo real se corrige en la conciliación (s10.7).
- Superadmin `/platform/rates`: tabla editable con fecha de vigencia (nunca se edita una vigente:
  se inserta una fila nueva), importador CSV con el formato de la tarjeta de Meta. i18n es/en/ko.

### s10.3 `managed-plan` — plan oculto y alta con método de pago
- Migración `077_plan_gestionado.sql`: plan `gestionado` (`is_public = false`,
  `price_usd_month = 1036`, `price_usd_year = NULL`, `limits` = los de `negocio` con
  `messages_out` y `broadcast_recipients` a `null` (sin tope: el precio es el tope), `features` =
  todas, `numbers` = 3). Solo ciclo mensual: la fecha de corte mensual es la que hace legible el
  consumo. La política de precio por defecto del plan vive en `plans.limits.meta_pricing` y se
  copia a `subscriptions.meta_pricing` al asignar, donde el superadmin la puede editar.
- `subscriptions.payment_method text CHECK IN ('paypal','manual')`, nullable (NULL = lo que diga
  `provider`, para no tocar filas viejas).
- Ficha del superadmin (extiende s9.4 «asignar plan a mano»): al elegir `gestionado` aparecen
  «Método de pago» (`manual` | `paypal`), «Precio»: mensajes incluidos (7.000), cuota (1.036) y precio por mensaje del excedente por
  categoría (multiplicador 2,5 o importe fijo), precargados desde el plan y editables y «Meta lo paga
  Cabbity» (fija `meta_billing = 'managed'`). Con `manual`: `provider = 'manual'`, `status =
  'active'`, `current_period_end = ahora + 1 mes`, `cycle = 'month'`. Con `paypal`: se crea el plan
  en PayPal si falta (s9.3) y se manda al propietario el enlace de checkout existente; hasta que
  PayPal confirme, la cuenta queda `incomplete` (s9.6). Motivo y bitácora como en s9.4.
- El plan gestionado nunca sale en `PlanPicker`, `/billing` ni en el onboarding (ya lo garantiza
  `is_public`, se cubre con test).
- `getEntitlements()` expone `metaBilling` y `paymentMethod`; el aviso «añade método de pago en
  Meta» (fase de precios, pendiente) no se muestra a cuentas `managed`.

### s10.4 `statements` — estado de cuenta al corte, confirmación de pago y corte a 3 días
- Migración `078_statements.sql`: tabla `statements (id uuid, account_id uuid, period_start
  timestamptz, period_end timestamptz, plan_fee_usd numeric(10,2), usage jsonb, meta_cost_usd
  numeric(10,2), usage_charge_usd numeric(10,2), total_usd numeric(10,2), status text CHECK IN
  ('issued','paid','void'), issued_at, due_at, paid_at, paid_by uuid, paid_reference text,
  paid_note text, UNIQUE (account_id, period_end))`. `usage` guarda: mensajes incluidos y consumidos del paquete, y el excedente por número y
  categoría (entregados, de ellos cuántos le costaron a Meta (`billable`), tarifa de Meta, precio
  aplicado, costo real, importe cobrado); columnas `included_messages int`, `messages_total int`,
  `overage_messages int` para listar sin abrir el jsonb. `meta_cost_usd` sale solo de los
  `billable`; `usage_charge_usd` de todos los entregados: la diferencia es el margen y la ficha
  del superadmin la muestra. RLS: el inquilino lee
  las suyas (`admin+`), escribe solo `service_role`. `impersonation_log.action` admite
  `'payment_confirmed'` y `'statement_void'`.
- `src/lib/billing/statements.ts`: `buildStatement(accountId, periodStart, periodEnd)` suma las filas de
  `message_charges` con `status = 'delivered'` y `delivered_at` en el periodo (decisión del líder en s10.1), por
  `whatsapp_config_id` y `pricing_category`, con la tarifa vigente en `delivered_at` y el
  multiplicador de esa categoría; cuenta aparte los `pricing_billable` para el costo real. Un
  envío de broadcast que Meta rechaza o que no llega (sin `delivered_at`) no se cobra. La cuota es `fee_usd`; el excedente son los mensajes entregados con categoría por encima de
  `included_messages` en el periodo, ordenados por `delivered_at`, cada uno a su precio de categoría.
  Con `payment_method = 'paypal'`, `plan_fee_usd = 0` (lo cobra PayPal) y el total es solo
  excedente; con `manual`, cuota + excedente.
  Puro y testeable con filas sintéticas.
  **Contrato con s10.2:** ante `MetaRateMissingError` `buildStatement` falla entero (no emite estado parcial ni salta mensajes sin tarifa); así una tarifa retroactiva de s10.2 solo rellena huecos y nunca reprecia cargos con tarifa ya resuelta.
- Cron `GET /api/billing/cron` (secreto `BILLING_CRON_SECRET`, `x-cron-secret`, 503 sin variable,
  documentado en `docs/docker.md`). Por cada suscripción `meta_billing = 'managed'` con
  `current_period_end <= now()` y sin `statement` para ese `period_end`: emite el estado de cuenta
  (`issued`, `due_at = period_end + 3 días`), pone `status = 'past_due'` y `grace_until = due_at`,
  y no toca `current_period_end` (el periodo siguiente empieza donde terminó este, se pague cuando
  se pague: sin deriva). Idempotente por el UNIQUE. Pasados los 3 días no hace nada más: el solo
  lectura ya lo deriva `isReadOnly()`.
  **Ancla del corte (decisión del líder, 2026-10-01, segunda ronda de s10.4):** el cron no corta por
  `current_period_end` sino por `subscriptions.statement_period_end` (078), que en PayPal lleva el
  webhook de la venta: si la renovación llegaba antes que el cron, el mes no se facturaba. El ancla la
  fija la asignación del plan gestionado (`now() + 1 mes`, manual y PayPal), la rellena la 078 para las
  cuentas `managed` previas (`current_period_end`, o `now() + 1 mes`), y solo la avanzan confirmar/anular
  (+1 mes desde su valor, sin deriva) y el cron cuando no hay nada que cobrar (PayPal sin excedente). En
  cuentas `manual`, `current_period_end` se mueve con ella; en `paypal` lo lleva PayPal y el corte no lo
  toca. El webhook de PayPal no toca el ancla.
  **Reasignar el plan gestionado (decisión del líder, 2026-10-01, tercera ronda de s10.4):** si la
  cuenta ya era `managed` y tiene ancla, reasignarle el plan gestionado (manual o PayPal) conserva el
  ancla que tiene en vez de reiniciarla a `now() + 1 mes`; si no, lo entregado desde el último corte
  no caería en ningún estado de cuenta. Solo una cuenta que pasa a `managed` por primera vez (o sin
  ancla) recibe ancla nueva. En la manual, `current_period_end` sigue al ancla conservada.
- Superadmin, ficha → sección «Estados de cuenta»: lista con periodo, total, estado, vencimiento.
  Botón **Confirmar pago** (modal: fecha de pago, referencia, nota; motivo no hace falta, el pago
  es el motivo) → `statement.paid`, `subscriptions.status = 'active'`, `grace_until = NULL`,
  `current_period_end += 1 mes`, bitácora. Botón **Anular** (motivo obligatorio ≥10) → `void`, y
  la suscripción vuelve a `active` con el periodo extendido igual. Confirmar antes del vencimiento
  es el caso normal y hace lo mismo.
- Cliente, `/billing`: sección «Estados de cuenta» con el desglose (número, categoría, mensajes
  entregados, tarifa, importe) y el total; solo lectura. No se enseña la marca `billable` ni el
  costo de Meta: es dato interno del superadmin. Endpoint `GET /api/billing/statements`
  filtrado por cuenta, `admin+`, test de fuga A↔B (CP3).
- Banner (`BillingStatusAlert`, variante `statement_due`): desde `issued` hasta `due_at`: «Tu
  estado de cuenta de {periodo} por US$ {total} vence el {fecha}: te quedan {n} días». Tras
  `due_at`: el bloqueo actual con texto propio «Cuenta en solo lectura por estado de cuenta
  pendiente» y enlace a `/billing`. Botón «Ya pagué» que deja una nota en la ficha del superadmin
  (no cambia estado). i18n es/en/ko.
- Cuentas `managed` con `payment_method = 'paypal'`: el webhook de PayPal sigue renovando la cuota
  como hoy; el cron solo emite el estado de cuenta de consumo con la misma regla (supuesto 4).
- Correo opcional (si hay proveedor configurado): al emitir y al vencer. Si no hay proveedor, solo
  banner. No bloquea la feature.

### s10.5 `managed-usage-panel` — consumo de Meta en vivo
- Panel de suscripción del cliente: para cuentas `managed`, bloque «Consumo del ciclo»: barra de
  mensajes usados sobre los 7.000 incluidos, excedente por categoría y **estimado a pagar al
  corte** = cuota + excedente, calculado con `buildStatement` sobre el periodo en curso. Aviso al
  80% y al 100% del paquete. Sin barra de cuota gratis de Meta: no es dato de este cliente.
- Para cuentas `direct` el bloque muestra la cuota gratis de 1.000 por número (barra, aviso al 80%
  y 100%) y el **costo estimado que Meta les cobrará** (solo `billable`, sin multiplicador), que es
  la feature 4/5 de la lista de precios y se resuelve aquí.
- Broadcasts, paso de programación: «{n} destinatarios × tarifa de marketing = US$ {x}»
  (para `managed`: cuántos entran en el paquete y cuántos van a excedente y a qué precio). Para
  este cliente es la cifra que importa: se muestra siempre, con confirmación explícita cuando el
  envío genera excedente.

### s10.6 `managed-number-setup` — número del cliente en el portafolio de Cabbity
- Checklist de la configuración manual (`whatsapp-config.tsx`) con los pasos de la opción A:
  crear WABA en el Business Manager de Cabbity, registrar el número, token de usuario de sistema,
  verificación del nombre visible. Solo se muestra a cuentas `managed`.
- `token-renewal.ts`: las configs sin `token_expires_at` (usuario de sistema) se saltan sin
  warning. Test.
- Ficha del superadmin: WABA id y `phone_number_id` visibles, y enlace directo al Billing Hub de
  Meta del portafolio de Cabbity.

### s10.7 `meta-reconciliation` — conciliación mensual (opcional, después)
- Cron mensual que baja `pricing_analytics` del WABA (COST + VOLUME por `PHONE` y
  `PRICING_CATEGORY`) y lo guarda en `meta_spend_snapshots`; la ficha del superadmin muestra
  la diferencia contra el estado de cuenta. Meta advierte que ese COST es aproximado: la factura
  de Meta es la verdad y las diferencias se ajustan como línea manual en el siguiente estado.

## Orden y ramas

s10.1 → s10.2 → s10.3 → s10.4 (la crítica) → s10.5 y s10.6 en paralelo → s10.7.
Rama `feat/facturacion-gestionada` sobre `main` **después del merge de `feat/superadmin`**
(fase 9 completa @ 68594c2), porque s10.3 y s10.4 extienden su UI y su bitácora. s10.1 y s10.2
no dependen de la fase 9 y pueden empezar antes.

## Checkpoints propios

- El corte nunca bloquea lo entrante ni la lectura (CP11); test que manda un mensaje entrante a
  una cuenta en solo lectura por estado de cuenta.
- El cron es idempotente: correrlo tres veces el mismo día emite un solo estado de cuenta.
- Confirmar un pago tarde no desplaza la fecha de corte: el periodo siguiente arranca en el
  `period_end` anterior.
- Un mensaje sin `pricing` de Meta no se factura nunca; el estado de cuenta lista cuántos
  mensajes entregados quedaron sin categoría, para que el humano lo vea.
- Un mensaje entregado con categoría cuenta aunque Meta lo marque gratis (`billable = false`):
  test con 8.200 entregados (7.000 marketing + 1.200 servicio, 200 `billable` de servicio) que
  factura 1.036 + 1.200 × 2,5 × 0,0113 de excedente, y cuyo costo real es solo lo `billable`.
- Broadcast de 1.000 marketing con 900 entregados y 100 fallidos suma 900 al paquete.
- Mes con 4.000 entregados factura exactamente la cuota; con `paypal` no hay excedente, no se
  emite estado de cuenta y el periodo se extiende sin corte.
- El excedente se resuelve por orden de entrega: cuando el paquete se agota a mitad de un
  broadcast, solo los entregados después cuentan como excedente.
- Ninguna tarifa se resuelve a 0 por mercado desconocido.
- Fuga A↔B en estados de cuenta, tarifas por cuenta y panel de consumo (CP3).

## Decisiones del humano (2026-09-30), antes preguntas abiertas

1. Cuota mensual del plan `gestionado`: 7.000 mensajes × tarifa de marketing en RD × 2 = 1.036 USD.
   Excedente a 2,5 × la tarifa de Meta de cada categoría.
2. Con PayPal, el excedente impago también corta a los 3 días.
3. Sin ITBIS en el estado de cuenta; se factura fuera con el ERP.
4. Solo USD.
5. El multiplicador de marketing se queda; el precio por mensaje debe poder modificarse por cuenta
   (multiplicador o importe fijo por categoría).
6. Sin depósito ni tope de envíos. El cliente paga al corte del mes.
