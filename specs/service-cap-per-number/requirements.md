# p11.3 `service-cap-per-number` — requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-10-01 por `spec_author`.
Base de lectura: `feat/precios-meta-directo` @ be8ca0f (fase 9 + s10.1 + s10.2 + p11.1; **sin** 077
ni 078). i18n: `es` (defecto) y `en`; sin `ko` (s9.9, CP6). Regla del humano: ninguna conexión de
red fuera de la máquina. Nada de esta feature llama a Meta: todo sale de `message_charges` (075).

## Contexto

Desde el 2026-10-01 los mensajes de servicio (texto libre dentro de la ventana de 24 h) dejan de
ser gratis sin límite: Meta regala **1.000 entregados por número y mes** y cobra los siguientes a
tarifa de utilidad (`progress/spec_facturacion-gestionada.md`, encabezado; dato del líder, ver
supuestos S-C1…S-C6 en `design.md`). La IA del CRM responde sola a cada entrante, así que un número
con mucho tráfico puede agotar la cuota sin que nadie lo note. El cliente quiere elegir, por
cuenta: **solo avisar** (por defecto) o **pausar la IA** de ese número hasta el mes siguiente.

Las cuentas `managed` (`subscriptions.meta_billing = 'managed'`, 076) pagan a Meta a través de
Cabbity con un paquete propio (s10.3): no tienen cuota gratis que cuidar y no ven nada de esto.

## Criterios de aceptación de partida (nota de la feature + encargo del líder)

- **A1** Ajuste por cuenta `service_cap_action` ∈ `warn` | `pause_ai`, por defecto `warn`
  (migración 080).
- **A2** Conteo del mes por número desde `message_charges`, con la regla elegida y justificada.
- **A3** Al llegar al 100 %: aviso en la bandeja y en Ajustes → WhatsApp.
- **A4** Con `pause_ai`, `auto-reply.ts` no responde automáticamente desde ese número hasta el mes
  siguiente; los agentes humanos siguen escribiendo.
- **A5** Nunca bloquea lo entrante ni los envíos manuales (CP11).
- **A6** Omitido en cuentas `managed`.
- **A7** UI del ajuste en Ajustes → WhatsApp.
- **A8** Tests, fuga A↔B (CP3), CP11, i18n es/en.

## Requisitos (EARS)

### Almacenamiento y conteo

- **R1** (A1) El sistema debe guardar en `accounts.service_cap_action` (texto, `NOT NULL DEFAULT
  'warn'`, CHECK `IN ('warn','pause_ai')`) la acción de cada cuenta, en la migración
  `080_service_cap.sql`, idempotente.
  *Verificación:* `scripts/replay-migrations.sh` sale 0 con 001–076 + 079 + 080, y aplicando la 080
  dos veces; aserción en `supabase/ci/verify-schema.sql` (bloque `-- 080`); SQL en
  `progress/checks_service-cap-per-number.sql`: una cuenta existente queda en `warn`, `UPDATE …
  SET service_cap_action = 'foo'` viola el CHECK.
- **R2** (A2) Cuando se llame a `service_quota_usage(p_account_id, p_since)`, el sistema debe
  devolver una fila por `whatsapp_config_id` no nulo de esa cuenta con `used` = número de filas de
  `message_charges` con `pricing_category = 'service'`, `status IN ('delivered','read')`,
  `delivered_at >= p_since` y `pricing_type IS DISTINCT FROM 'free_entry_point'`, y `billable` =
  cuántas de ellas tienen `pricing_billable = true`. Las filas de otras cuentas, de otras
  categorías, `sent`/`failed`, anteriores a `p_since` o con `whatsapp_config_id` NULL no cuentan.
  *Verificación:* SQL en `checks_…sql` con filas sintéticas de dos cuentas (una por cada caso de
  exclusión) y resultado exacto esperado.
- **R3** (CP3) Mientras la sesión sea `anon` o `authenticated`, el sistema debe negar la ejecución
  de `service_quota_usage`; solo `service_role` la ejecuta.
  *Verificación:* SQL en `checks_…sql`: `SET ROLE authenticated` → `insufficient_privilege`;
  aserción de privilegios en `verify-schema.sql`.
- **R4** (A2, A3) Cuando el sistema calcule el estado de un número, debe considerarlo **agotado**
  si `used >= 1000` **o** `billable > 0` en el mes en curso, con el mes como mes natural en UTC
  (`monthStart` = día 1 a las 00:00 UTC; `resetsAt` = día 1 del mes siguiente).
  *Verificación:* vitest de `serviceCapState()` (puro, reloj inyectado): 999/0 → no agotado;
  1000/0 → agotado; 10/1 → agotado; 31-dic 23:59 UTC → `resetsAt` = 1-ene; 29-feb de año bisiesto.

### API

- **R5** (A3, A6) Cuando cualquier miembro de la cuenta llame a `GET /api/whatsapp/service-cap`, el
  sistema debe responder `{ metaBilling, action, freeTier: 1000, monthStart, resetsAt, numbers:
  [{ id, label, displayPhoneNumber, used, billable, exhausted }] }`, con un elemento por fila de
  `whatsapp_config` de la cuenta (0 usados si no hay cargos), calculado con
  `service_quota_usage` vía rol de servicio con el `account_id` de la sesión, sin llamar a Meta.
  Si la cuenta es `managed`, debe responder `numbers: []` sin llamar a la función.
  *Verificación:* `src/app/api/whatsapp/service-cap/route.test.ts`: sesión de agente → 200 con la
  forma exacta; `fetch` global espiado y nunca llamado; `rpc` llamada con `p_account_id` de la
  sesión; `managed` → `numbers: []` y `rpc` no llamada; sin sesión → 401.
- **R6** (CP3) Cuando la cuenta A llame a `GET /api/whatsapp/service-cap`, el sistema no debe
  devolver números ni conteos de la cuenta B.
  *Verificación:* test de fuga A↔B en `route.test.ts` y caso en
  `src/lib/security/tenant-isolation.test.ts` (B con un número agotado, A con uno a 0 → A ve solo
  el suyo, `exhausted: false`); la auditoría de `service-role-audit` cubre la ruta.
- **R7** (A1, A7) Cuando un administrador (`requireRole('admin')`) llame a `PATCH
  /api/whatsapp/service-cap` con `{ action: 'warn' | 'pause_ai' }`, el sistema debe actualizar solo
  `accounts.service_cap_action` de la cuenta de la sesión (cliente con RLS y `.eq('id',
  accountId)`) y devolver `{ action }`; con otro valor, 400 sin escribir; por debajo de `admin`,
  403 sin escribir.
  *Verificación:* `route.test.ts`: 200 y UPDATE con el filtro de la cuenta; 400 (`'foo'`, ausente,
  no string); 401/403; fuga: el UPDATE nunca lleva el id de B.
- **R8** Si la lectura de conteos falla (error de la RPC o de `whatsapp_config`), el sistema debe
  responder 500 `{ error }` sin detalle interno, y el cliente debe tratarlo como «sin dato» (no
  pinta aviso).
  *Verificación:* `route.test.ts` con la RPC devolviendo `{ error }`; test del hook/componente con
  respuesta 500 → render vacío.

### IA

- **R9** (A4) Cuando llegue un entrante a una conversación cuyo número esté agotado (R4), la cuenta
  tenga `service_cap_action = 'pause_ai'` y sea `direct`, `dispatchInboundToAiReply` debe terminar
  sin reservar la respuesta (`claimInboundAutoReply`), sin llamar al modelo, sin mandar nada (ni
  respuesta ni aviso de traspaso) y sin tocar `ai_replies`, dejando una línea `console.info` con la
  cuenta y el número.
  *Verificación:* `src/lib/ai/auto-reply.test.ts`: con `pause_ai` + agotado → `generateReply`,
  `engineSendText`, `claimInboundAutoReply` y `recordUsage` sin llamar.
- **R10** (A4, A6) Cuando la cuenta esté en `warn`, sea `managed`, el número no esté agotado o no se
  pueda resolver el número de la conversación, la IA debe responder igual que hoy.
  *Verificación:* `auto-reply.test.ts`, un caso por condición; en `warn` no se llama a la RPC.
- **R11** (A4) Si la comprobación de R9 falla (error al leer la cuenta, la suscripción o la RPC), el
  sistema debe responder con la IA como si no hubiera pausa y registrar un `console.warn` (falla
  abierta: no silencia la IA por un error nuestro).
  *Verificación:* `src/lib/billing/service-cap.test.ts` y caso en `auto-reply.test.ts` con la RPC
  fallando → la respuesta sale.
- **R12** (A4) Cuando el sistema determine el número de una conversación para R9, debe usar
  `conversations.whatsapp_config_id` y, si es NULL o ya no existe, el número que usaría el envío
  (`resolveWhatsAppConfig` sin token: por defecto, luego el más antiguo), siempre filtrando por
  `account_id`.
  *Verificación:* `service-cap.test.ts`: conversación sellada con el número 2 agotado → pausa;
  sellada con NULL y número por defecto agotado → pausa; número de otra cuenta → no resuelve, no
  pausa.
- **R13** (A4) Cuando empiece un mes nuevo (UTC), el sistema debe volver a responder con la IA desde
  ese número sin intervención humana.
  *Verificación:* `service-cap.test.ts` con reloj en el día 1 a las 00:00:01 UTC: `p_since` es el
  nuevo mes y, sin filas en él, no pausa.

### Lo que no cambia

- **R14** (A5, CP11) Cuando llegue un mensaje entrante a un número agotado de una cuenta en
  `pause_ai`, el sistema debe guardarlo igual que hoy; esta feature no modifica
  `src/app/api/whatsapp/webhook/route.ts`.
  *Verificación:* test nuevo en `src/app/api/whatsapp/webhook/route.test.ts` (entrante persistido,
  `dispatchInboundToAiReply` invocado y sin envío); `git diff --stat` sin `webhook/route.ts` (CP8).
- **R15** (A5) Mientras un número esté agotado, el sistema no debe bloquear ni condicionar los envíos
  del compositor, la API v1, las difusiones, los flujos ni las automatizaciones: la pausa es solo de
  la respuesta automática de la IA.
  *Verificación:* el diff no toca `src/lib/billing/enforce.ts`, `src/lib/flows/meta-send.ts`,
  `src/lib/automations/meta-send.ts`, `src/app/api/whatsapp/send/route.ts` ni
  `src/lib/whatsapp/broadcast-core.ts` (CP8); `isAiPausedByServiceCap` solo se importa desde
  `src/lib/ai/auto-reply.ts` (comprobado con `grep` en el informe).

### UI

- **R16** (A3, A6) Cuando la cuenta sea `direct` y algún número esté agotado, el sistema debe
  mostrar en la bandeja (`/inbox`) una franja ámbar, sin botón de cerrar, que nombre los números
  agotados (etiqueta o teléfono), diga que Meta cobra desde ahora cada mensaje de servicio de ese
  número este mes y, si la acción es `pause_ai`, que la IA no responde sola desde ese número hasta
  `resetsAt` (fecha formateada); con `warn`, que la IA sigue respondiendo. Para `managed`, sin
  datos o sin números agotados, no debe pintar nada.
  *Verificación:* `src/components/inbox/service-cap-alert.test.tsx`: agotado+`warn`, agotado+
  `pause_ai` (con fecha), dos números, `managed`, `null`, ninguno agotado.
- **R17** (A3, A7) Cuando se muestre una tarjeta de número en Ajustes → WhatsApp de una cuenta
  `direct`, el sistema debe enseñar «Mensajes de servicio este mes: {used} de {freeTier} gratis»
  y, si está agotado, una etiqueta «Cuota gratis agotada»; para `managed` no se muestra.
  *Verificación:* `src/components/settings/service-cap-settings.test.tsx` (fragmento
  `ServiceUsageLine`): 0, 734, agotado por conteo, agotado por `billable`, `managed`.
- **R18** (A1, A7) Cuando se muestre Ajustes → WhatsApp de una cuenta `direct` con al menos un
  número, el sistema debe mostrar una tarjeta «Cuota gratis de Meta» con dos opciones («Solo
  avisar» / «Pausar la IA del número»), la actual marcada, editable solo con `canEditSettings`,
  que guarda con `PATCH /api/whatsapp/service-cap` y revierte con un toast de error si falla.
  *Verificación:* `service-cap-settings.test.tsx` (componente `ServiceCapCard`): selección actual,
  cambio → `fetch` PATCH con el cuerpo exacto, error → revierte y toast, deshabilitado sin permiso,
  oculto en `managed`.
- **R19** (CP6) Cuando se añada un texto de UI, el sistema debe tenerlo en `messages/es.json` y
  `messages/en.json` con la misma clave y los mismos placeholders ICU.
  *Verificación:* `service-cap-alert.test.tsx` recorre las claves nuevas (`Inbox.serviceCap.*`,
  `Settings.whatsapp.serviceCap.*`) y comprueba que existen en los dos catálogos con los mismos
  `{placeholders}`; `src/i18n/messages.test.ts` sigue verde.

## Guion manual (exige Meta real; lo ejecuta el humano)

1. En un número `direct` real, responder desde el inbox dentro de la ventana y consultar
   `select pricing_category, pricing_type, pricing_billable, status from message_charges order by
   created_at desc limit 5;`. Anotar en `progress/impl_service-cap-per-number.md` el
   `pricing_type` literal (S-C2).
2. Cuando un número pase de 1.000 servicio en el mes, comprobar que la fila 1.001 llega con
   `pricing_billable = true` (S-C1, S-C2) y que el aviso aparece en ≤ 60 s.
3. Recibir un mensaje desde un anuncio Click to WhatsApp y responder: comprobar `pricing_type =
   'free_entry_point'` y que ese mensaje no sube `used` (S-C3).
4. Comparar el corte de mes del Business Manager con el de UTC (S-C4).

## Fuera de alcance

- Avisos al 80 % y correos (p11.7; s10.5 pinta la barra de cuota en el panel de suscripción y debe
  reutilizar `service_quota_usage`).
- Pausar flujos o automatizaciones al agotar la cuota.
- Reconstruir el conteo de mensajes anteriores a la 075.
