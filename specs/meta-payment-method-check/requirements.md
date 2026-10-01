# p11.1 `meta-payment-method-check` — requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-09-30 por `spec_author`.
Base de lectura: `feat/superadmin` @ 4ad530f. i18n: `es` (defecto) y `en`; sin `ko` (s9.9, CP6).
Regla del humano: ninguna conexión de red fuera de la máquina. Todo lo que dependa de Meta se
prueba con `fetch` mockeado; lo que exige un WABA real queda en el guion manual (§Guion manual).

## Contexto

Desde el 2026-10-01 Meta deja de entregar mensajes de un WABA sin método de pago (dato aportado
por el líder; ver supuesto S-M6 en `design.md`). Las cuentas que conectan su número por Embedded
Signup pagan a Meta directo, y hoy el CRM no tiene forma de saber si el WABA tiene tarjeta: el
cliente ve «Conectado» y sus mensajes no llegan. Las cuentas `managed` (fase 10, s10.2:
`subscriptions.meta_billing = 'managed'`) pagan a Meta a través de Cabbity y no deben ver aviso.

**Ningún campo de la API de Meta que usa esta feature está documentado en el repo.** El endpoint
y la interpretación del resultado son supuestos sin verificar (S-M1…S-M5 de `design.md`); por eso
el diseño trae un interruptor de apagado (R13) y trata cualquier respuesta dudosa como `unknown`,
nunca como `missing`.

## Criterios de aceptación de partida (de la nota de la feature y del encargo del líder)

- **A1** Tras el Embedded Signup se lee el estado del método de pago del WABA.
- **A2** Banner rojo persistente en el CRM si no hay método de pago, con enlace al Billing Hub de
  Meta y texto que explique qué pasa desde el 01-10.
- **A3** Nada cuando hay método de pago; aviso suave cuando no se pudo comprobar (error de API).
- **A4** Se omite en cuentas `managed`; si `subscriptions.meta_billing` aún no existe, la cuenta es
  `direct`.
- **A5** El resultado se guarda (no se llama a Meta en cada render) y se refresca con un chequeo
  periódico barato.
- **A6** Ficha del superadmin: estado del método de pago por número.
- **A7** Modo self-hosted / token propio: mismo chequeo si el token tiene permiso; si no,
  `unknown` sin ruido.
- **A8** Tests con `fetch` mockeado, CP11 (lo entrante nunca se bloquea), fuga A↔B (CP3), i18n es/en.

## Requisitos (EARS)

### Almacenamiento

- **R1** (A5) El sistema debe guardar por fila de `whatsapp_config` el estado del método de pago
  (`meta_payment_status` ∈ `ok` | `missing` | `unknown`, o NULL = nunca comprobado), la fecha de la
  última comprobación (`meta_payment_checked_at`) y el último mensaje de error de Meta
  (`meta_payment_error`, NULL tras un `ok` o `missing`), en la migración
  `079_meta_payment_status.sql`, idempotente.
  *Verificación:* `scripts/replay-migrations.sh` sale 0 aplicando 001–074 + 079 dos veces;
  aserciones nuevas en `supabase/ci/verify-schema.sql`; SQL en
  `progress/checks_meta-payment-method-check.sql` que intenta `meta_payment_status = 'foo'` y
  espera violación del CHECK.
- **R2** (A5, CP3) Cuando una sesión con rol `authenticated` inserte o actualice una fila de
  `whatsapp_config`, el sistema debe conservar los valores previos de `meta_payment_status`,
  `meta_payment_checked_at` y `meta_payment_error` (NULL en un INSERT); solo el rol de servicio
  puede escribirlos.
  *Verificación:* SQL en `checks_…sql`: `SET ROLE authenticated` + claims de un admin de la cuenta
  A, `UPDATE … SET meta_payment_status = 'ok'` sobre una fila `missing` → sigue `missing`; con
  `SET ROLE service_role` sí cambia.
- **R3** (A5) Cuando una sesión `authenticated` cambie `waba_id` o `access_token` de una fila, el
  sistema debe poner a NULL `meta_payment_status`, `meta_payment_checked_at` y
  `meta_payment_error` de esa fila, para que el siguiente barrido la compruebe primero.
  *Verificación:* SQL en `checks_…sql` (mismo guion que R2 cambiando `waba_id`).

### Comprobación contra Meta

- **R4** (A1, A7) Cuando el sistema compruebe el método de pago de un WABA, debe hacer una sola
  llamada `GET {META_API_BASE}/{waba_id}?fields=primary_funding_id` con el token de esa fila en la
  cabecera `Authorization` (endpoint **sin verificar**, S-M1) y clasificar así:
  respuesta 2xx con `primary_funding_id` cadena no vacía → `ok`;
  respuesta 2xx con `id` igual al `waba_id` pedido y sin `primary_funding_id` (ausente, `null` o
  cadena vacía) → `missing`;
  cualquier otra cosa (HTTP no 2xx, `MetaApiError`, error de red, timeout de 5 s, JSON inválido,
  2xx sin `id` o con otro `id`) → `unknown`.
  *Verificación:* vitest de `classifyFundingResponse` y de `fetchWabaPaymentStatus` con `fetch`
  mockeado, un caso por rama, y aserción de URL, método y cabecera.
- **R5** (A7) Cuando la llamada de R4 falle por permisos (Meta `error.code` 10, 200 o 100, o HTTP
  403), el sistema debe guardar `unknown` con el mensaje de Meta y no debe escribir en consola más
  que una línea `console.warn` por fila y comprobación.
  *Verificación:* vitest con `fetch` mockeado devolviendo `{error:{code:10,…}}`.
- **R6** (CP de secretos) Cuando el sistema registre un error de la comprobación, debe guardar y
  loguear solo `error.message` truncado a 500 caracteres, nunca el token ni la URL con cabeceras.
  *Verificación:* vitest que espía `console.*` y la escritura en BD y comprueba que el token de
  prueba no aparece.
- **R7** (A1) Cuando `POST /api/whatsapp/embedded-signup` haya guardado la fila (paso 9), el
  sistema debe comprobar el método de pago con el token recién emitido, guardar el resultado con
  rol de servicio filtrando por `account_id` e `id`, y devolver `payment_status` en el JSON; si la
  comprobación falla, la respuesta del alta no cambia de código HTTP ni de `success`.
  *Verificación:* `src/app/api/whatsapp/embedded-signup/route.test.ts`: caso `ok`, caso `missing`,
  caso con `fetch` de la comprobación rechazado (respuesta 200 con `payment_status: 'unknown'`), y
  orden de llamadas (la comprobación va después del intercambio del código, nunca antes).
- **R8** (A7) Cuando `POST /api/whatsapp/config` (configuración manual, token propio) haya guardado
  la fila, el sistema debe hacer la misma comprobación y guardado que R7, sin alterar la respuesta
  existente salvo el campo nuevo `payment_status`.
  *Verificación:* `src/app/api/whatsapp/config/route.test.ts`, mismos tres casos.
- **R9** (A5) Cuando corra `GET /api/webhooks/cron`, el sistema debe comprobar como máximo 25 filas
  `status = 'connected'` con `waba_id` no nulo cuya comprobación esté vencida — nunca comprobadas,
  `missing` hace ≥ 1 h, `unknown` hace ≥ 6 h, `ok` hace ≥ 24 h —, empezando por las más antiguas
  (NULL primero), y devolver un bloque aditivo `payments: { enabled, scanned, checked, ok, missing,
  unknown }` sin cambiar el resto del cuerpo.
  *Verificación:* `src/lib/whatsapp/payment-method.test.ts` (barrido con reloj inyectado: qué filas
  entran y cuáles no) y `src/app/api/webhooks/cron/route.test.ts` (bloque `payments` presente,
  claves antiguas intactas).
- **R10** (A5) Si el barrido de R9 falla (lectura, Meta o escritura), el sistema debe seguir con la
  fila siguiente y el cron debe responder igual que hoy; el barrido no lanza.
  *Verificación:* vitest con la primera fila fallando en Meta y la segunda `ok`.
- **R11** (A3) Cuando un administrador pulse «Comprobar de nuevo» en una tarjeta de número de
  Ajustes → WhatsApp, el sistema debe llamar a `POST /api/whatsapp/config/payment-status` con
  `{ config_id }`, que exige rol `admin`, aplica un límite de 6 peticiones por minuto y usuario,
  comprueba esa fila (R4) y devuelve `{ status, checked_at }`.
  *Verificación:* `src/app/api/whatsapp/config/payment-status/route.test.ts`: 401/403 sin rol,
  429 al superar el límite, 200 con el estado.
- **R12** (CP3) Cuando `POST /api/whatsapp/config/payment-status` reciba un `config_id` que no sea
  de la cuenta del llamante, el sistema debe responder 404 sin llamar a Meta ni escribir.
  *Verificación:* test de fuga A↔B en el mismo archivo (fila de B, sesión de A: 404, `fetch` sin
  llamar, ningún UPDATE en el log de `fake-supabase`).
- **R13** (riesgo S-M2) Mientras `META_PAYMENT_CHECK_DISABLED=1`, el sistema no debe llamar a Meta
  para esta comprobación (alta, guardado manual, barrido ni botón) y `GET /api/billing/status`
  debe devolver `metaPayment.banner = null`.
  *Verificación:* vitest en `payment-method.test.ts` y `billing/status/route.test.ts` con la
  variable puesta.

### Banner en el CRM

- **R14** (A5) Cuando cualquier miembro cargue el CRM, el sistema debe obtener el estado del
  método de pago dentro de la respuesta existente de `GET /api/billing/status` (campo nuevo
  `metaPayment: { banner: 'missing' | 'unknown' | null, missingNumbers: number }` y
  `metaBilling: 'direct' | 'managed'`), leyendo solo
  `whatsapp_config` filtrado por `account_id`, sin llamar a Meta.
  *Verificación:* `src/app/api/billing/status/route.test.ts`: `fetch` global espiado y nunca
  llamado; consulta con `.eq('account_id', …)`.
- **R15** (A2) Cuando la cuenta sea `direct` y alguna fila `connected` tenga
  `meta_payment_status = 'missing'`, el sistema debe mostrar en todas las páginas del CRM un banner
  rojo (`Alert variant="destructive"`), sin botón de cerrar, que diga cuántos números están
  afectados, que desde el 1 de octubre de 2026 Meta no entrega los mensajes de esos números hasta
  añadir un método de pago, y con un enlace externo al Billing Hub de Meta (nueva pestaña,
  `rel="noopener noreferrer"`).
  *Verificación:* `src/components/billing/meta-payment-alert.test.tsx`: render con
  `banner: 'missing', missingNumbers: 2` → título, cuerpo con «2», enlace con `href` de la constante
  y `target="_blank"`.
- **R16** (A3) Cuando ninguna fila `connected` esté `missing`, el sistema no debe mostrar el banner
  rojo; y cuando además ninguna esté `unknown` en las condiciones de R17, no debe mostrar nada.
  *Verificación:* test del componente con `banner: null` → render vacío; test de
  `metaPaymentBanner()` con todas las filas `ok` y con filas NULL → `null`.
- **R17** (A3, A7) Cuando la cuenta sea `direct`, ninguna fila esté `missing`, el despliegue esté en
  modo plataforma y alguna fila `connected` con `provisioned_via = 'embedded_signup'` esté
  `unknown`, el sistema debe mostrar un aviso suave (variante por defecto de `Alert`, no
  destructiva) que diga que no se pudo comprobar el método de pago y enlace al Billing Hub. Las
  filas manuales (`provisioned_via = 'manual'`) en `unknown` no deben producir aviso global.
  *Verificación:* tests de `metaPaymentBanner()` (combinaciones plataforma/self-hosted ×
  embedded/manual) y del componente con `banner: 'unknown'`.
- **R18** (A4) Cuando `subscriptions.meta_billing = 'managed'`, el sistema debe devolver
  `metaPayment.banner = null` sea cual sea el estado de los números; cuando la columna no exista o
  la fila no tenga ese valor, debe tratar la cuenta como `direct`.
  *Verificación:* tests de `metaBillingOf()` (`{}`, `{meta_billing:'direct'}`,
  `{meta_billing:'managed'}`, `null`) y de la ruta con una fila `managed` y un número `missing`.
- **R19** (CP3) Cuando la cuenta A consulte `GET /api/billing/status`, el sistema no debe reflejar
  el estado de los números de la cuenta B.
  *Verificación:* test de fuga A↔B: B con un número `missing`, A con uno `ok` → A recibe
  `banner: null`; y la consulta lleva el filtro de A.

### Ajustes y superadmin

- **R20** (A3, A7) Cuando se muestre una tarjeta de número en Ajustes → WhatsApp, el sistema debe
  enseñar una etiqueta con el estado del método de pago (`ok` «Método de pago en Meta: activo»,
  `missing` en rojo, `unknown` «No se pudo comprobar», NULL «Pendiente de comprobar») y la fecha de
  la última comprobación, y el botón de R11 solo a quien tenga permiso de editar ajustes. Para
  cuentas `managed` la etiqueta no se muestra.
  *Verificación:* test de render del fragmento extraído (`PaymentStatusBadge`) por estado, y
  `publicNumber()` de `config/route.ts` incluye los tres campos nuevos (test de la ruta GET).
- **R21** (A6) Cuando un operador de plataforma abra `/platform/[id]`, el sistema debe mostrar por
  cada número el estado del método de pago, la fecha de la última comprobación y, si es `unknown`,
  el error de Meta; también en cuentas `managed` (el WABA es de Cabbity y el operador debe verlo).
  *Verificación:* `src/lib/platform/accounts.test.ts` (`loadNumbers` selecciona y mapea los
  campos, filtrado por el `id` de la URL) y test de render de `platform-account-detail`.

### Lo que no cambia

- **R22** (CP11) Cuando llegue un mensaje entrante a un número con `meta_payment_status = 'missing'`
  o `unknown`, el sistema debe guardarlo igual que hoy; esta feature no modifica
  `src/app/api/whatsapp/webhook/route.ts`.
  *Verificación:* test nuevo en `src/app/api/whatsapp/webhook/route.test.ts` con la fila
  `missing` que persiste el entrante; y el diff no toca `webhook/route.ts` (CP8).
- **R23** Cuando un número esté `missing`, el sistema no debe bloquear ningún envío (composer, IA,
  broadcasts, API): el aviso es informativo y quien deja de entregar es Meta.
  *Verificación:* el diff no toca `src/lib/billing/enforce.ts` ni las rutas de envío (CP8), y test
  de `metaPaymentBanner()` que confirma que la función no lee ni devuelve nada de `readOnly`.
- **R24** (CP6) Cuando se añada un texto de UI, el sistema debe tenerlo en `messages/es.json` y
  `messages/en.json` con la misma clave y los mismos placeholders ICU.
  *Verificación:* no hay test de paridad global en el repo; `meta-payment-alert.test.tsx` incluye un
  caso que recorre las claves nuevas (`Billing.metaPayment.*`, `Settings.whatsapp.payment*`,
  `Platform.payment*`) y comprueba que existen en los dos catálogos con los mismos `{placeholders}`.

## Guion manual (exige Meta real; lo ejecuta el humano)

1. Con Graph API Explorer y el token de un número conectado por Embedded Signup, pedir
   `GET /v21.0/{waba_id}?fields=id,primary_funding_id` en un WABA **con** tarjeta y en otro **sin**
   ella. Anotar las dos respuestas literales en `progress/impl_meta-payment-method-check.md`. Si
   no se comportan como R4 (S-M1/S-M2), poner `META_PAYMENT_CHECK_DISABLED=1` en producción y
   volver al spec.
2. Repetir con un token de usuario de sistema (configuración manual) para S-M5.
3. Repetir con un WABA en el portafolio de Cabbity (cuenta `managed`) para confirmar que la línea
   de crédito de Cabbity cuenta como `primary_funding_id`.
4. Abrir el enlace del banner y comprobar que lleva al Billing Hub (S-M4).
5. Añadir la tarjeta en el WABA sin pago, pulsar «Comprobar de nuevo» y ver que el banner
   desaparece en ≤ 30 s (TTL de `useBillingStatus`).

## Fuera de alcance

- Detectar el problema por el error de envío de Meta en el webhook de estados (código de pago, sin
  verificar): se propone como seguimiento en `design.md` §Alternativas.
- Correo al propietario (p11.7).
- Bloquear o encolar envíos de números sin método de pago.
