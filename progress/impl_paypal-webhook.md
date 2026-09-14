# Implementación: f3.3 `paypal-webhook`

- **Rama:** `saas/fase-3-facturacion` (worktree `.claude/worktrees/fase-3`, base `e564f47`)
- **Commits:** `fa29715` — `feat: activar el plan con el webhook de PayPal`;
  `b19f233` — `fix: activar la suscripción de quien vuelve a contratar` (correcciones
  de la revisión, ver «Corrección tras CHANGES_REQUESTED»)
- **Spec:** `docs/saas/fase-3-facturacion.md` §3 «Webhook» (+ «Lo que PayPal no hace»,
  criterios de aceptación y variables de entorno)
- **Estado:** corregido, listo para re-revisión

## Qué hace

`POST /api/billing/webhook` es lo único del producto que convierte un pago en
servicio. La página de retorno de f3.2 informa; esto activa.

1. Lee **los bytes crudos** (`await request.text()`) antes de tocar el JSON y los
   manda a PayPal con las cinco cabeceras `paypal-transmission-*` y
   `PAYPAL_WEBHOOK_ID`. Sin un `SUCCESS` explícito, 401.
2. Inserta en `billing_events` **antes** de procesar. El `UNIQUE (provider,
   provider_event_id)` de la 041 es el cerrojo: 23505 → 200 `duplicate` sin hacer nada.
3. Resuelve la cuenta desde **nuestras** filas (`subscriptions` o `checkout_intents`
   por `provider_subscription_id`, ambos con UNIQUE). El `custom_id` que PayPal
   devuelve solo sirve para **contradecir** esa resolución, nunca para elegirla.
4. Decide con `decideSubscriptionChange` (puro) y escribe con el rol de servicio,
   siempre con `.eq('account_id', …)`.

Lo que **no** hace, a propósito: no aplica límites ni suspende funciones (f3.4),
no cambia de plan desde la app (f3.5), no pinta nada (§6) y **no toca nada del
webhook de WhatsApp** (CP11).

## Archivos

| Archivo | Qué es |
| --- | --- |
| `src/app/api/billing/webhook/route.ts` | la ruta: firma → cerrojo → resolución de cuenta → escritura acotada |
| `src/lib/billing/webhook-events.ts` | lógica pura: parseo del sobre, los seis eventos, reglas de coherencia y desorden |
| `src/lib/billing/paypal-webhook-signature.ts` | la guarda: cinco cabeceras, `PAYPAL_WEBHOOK_ID`, `cert_url` de PayPal, fallo cerrado |
| `src/lib/billing/paypal.ts` | `verifyWebhookSignature()` nueva + `paypalFetch` acepta `rawBody` |
| `supabase/migrations/050_subscription_event_watermark.sql` | `subscriptions.last_event_at` + índice parcial `billing_events_unprocessed_idx` |
| `supabase/ci/verify-schema.sql` | 2 aserciones de 050 |
| `docs/docker.md` | sección «PayPal webhook»: `PAYPAL_WEBHOOK_ID`, los seis eventos, cola de reconciliación |
| `CHANGELOG.md` | nota de migración + entrada Unreleased |

Sin dependencias nuevas (CP5), sin texto de UI (no hay claves i18n que añadir, CP6).

## Criterio ↔ prueba

Criterios de `docs/saas/fase-3-facturacion.md` que caen en §3:

| Criterio | Prueba |
| --- | --- |
| **Un webhook con firma inválida se rechaza** | `src/app/api/billing/webhook/route.test.ts` › «rejects a delivery with an invalid signature and writes nothing» (401 y **cero** consultas, ni la de auditoría) |
| El cuerpo crudo se verifica antes de parsear | `route.test.ts` › «verifies the raw bytes, before any parsing» (bytes con espaciado y orden de claves que `JSON.stringify` no reproduce); `src/lib/billing/paypal.test.ts` › «sends the delivered bytes verbatim as webhook_event» |
| Fallar cerrado sin `PAYPAL_WEBHOOK_ID` | `src/lib/billing/paypal-webhook-signature.test.ts` › «rejects when PAYPAL_WEBHOOK_ID is not configured» |
| Fallar cerrado si falta una cabecera | `paypal-webhook-signature.test.ts` › «rejects a delivery missing any transmission header» (las cinco, una a una) |
| Fallar cerrado si no se puede preguntar a PayPal | `paypal-webhook-signature.test.ts` › «rejects — does not fall open — when PayPal cannot be asked» y › «rejects when the verification call throws something unexpected» |
| **El mismo evento entregado dos veces se procesa una sola vez** | `route.test.ts` › «processes the same event only once, however often PayPal sends it» (tres entregas → una fila, una escritura) |
| El registro ocurre **antes** de procesar | `route.test.ts` › «records the event before processing it» (orden real de las escrituras) y › «does not process when the event cannot be recorded» |
| **Cerrar el navegador tras aprobar activa igualmente la suscripción** | `route.test.ts` › «activates the plan when the customer closed the browser after approving» (solo hay intento; nadie volvió) |
| La URL de retorno no activa nada por sí sola | ya cubierto en f3.2 (`src/app/api/billing/checkout/route.test.ts` › «activates nothing by being called»); aquí se refuerza: el único escritor de `subscriptions` es esta ruta |
| Los seis eventos de la tabla del spec | `route.test.ts` › describe «the other five events» (cancel, suspend, payment failed, renovación, update de plan) + «activation»; `src/lib/billing/webhook-events.test.ts`, un `describe` por evento |
| `ACTIVATED` → `active` + `current_period_end` | `webhook-events.test.ts` › «turns the plan on and fixes the end of the period»; ruta: «activates the plan when the customer closed the browser…» |
| `UPDATED` → reconciliar plan y cantidad | `webhook-events.test.ts` › «reconciles the plan against our catalogue», › «reconciles the quantity into addons without losing what was there»; ruta: «reconciles the plan an update reports, through our own catalogue» |
| `CANCELLED` → `cancel_at_period_end`, servicio hasta fin de ciclo | `webhook-events.test.ts` › «keeps the service to the end of the paid cycle» (el estado sigue `active`); ruta: «cancels at the end of the paid cycle» |
| `SUSPENDED` → `status = suspended` | `webhook-events.test.ts` › «suspends the account»; ruta: «suspends» |
| `PAYMENT.FAILED` → `past_due` + `grace_until = +7d` | `webhook-events.test.ts` › «moves to past_due with seven days of grace» y › «counts the grace from the event, not from the redelivery»; ruta: «opens a seven-day grace window on a failed payment» |
| `PAYMENT.SALE.COMPLETED` → extender periodo y volver a `active` | `webhook-events.test.ts` › «extends the period by one cycle on renewal and comes back to active»; ruta: «renews on a completed sale and comes back from past_due» |
| **Eventos desordenados: coherencia antes de escribir** | `webhook-events.test.ts` › «cannot resurrect a subscription cancelled by a newer event», › «does nothing at all when a late delivery would also rewind the period», › «cannot undo a newer suspension», › «stamps the watermark only when the event was not late»; ruta: «does not resurrect a cancelled subscription with a late activation» |
| Un `SALE.COMPLETED` antes de su `ACTIVATED` no deja un estado imposible | `webhook-events.test.ts` › «serves the customer when the sale beats its own activation» y › «does not double-extend the first cycle»; ruta: «serves a customer whose payment arrives before the activation» |
| Toda escritura de rol de servicio acotada por `account_id` (CP3) | `route.test.ts` › «never writes to another account than the one the subscription belongs to» (comprueba el ámbito de **cada** escritura sobre `subscriptions` y `checkout_intents`), › «ignores an account id the event tries to supply», › «refuses when our own two records disagree about the owner», › «does not let another subscription rewrite an account already on one» |
| Un evento de una suscripción que no es de nadie no escribe nada | `route.test.ts` › «refuses an event for a subscription no account of ours owns» (queda sin procesar, con el motivo) |
| Un usuario autenticado no puede modificar su suscripción (RLS) | `progress/checks_paypal-webhook.sql` parte C |
| Lo entrante nunca se bloquea (CP11) | el diff no toca `src/app/api/whatsapp/**` ni nada que lea el estado de facturación; esta feature no aplica límites |

Suite completa: **91** archivos, **1019** pruebas (+82 respecto a f3.2).

## Verificación contra base real

`progress/checks_paypal-webhook.sql`, contra el Postgres del harness:

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
docker exec -i wacrm-migrations-70161 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 < progress/checks_paypal-webhook.sql
# BEGIN/DO/ROLLBACK ×5
```

- **Parte A — el cerrojo es de la base, no del código.** Un `provider_event_id`
  repetido choca con 23505; otro `provider` es otro espacio de nombres; la consulta
  de reconciliación (`processed_at IS NULL AND error IS NOT NULL`) devuelve lo que
  debe.
- **Parte B — la 050 existe y significa lo que el código cree.** `last_event_at` es
  `timestamptz` y **nullable** («sin marca» no puede leerse como «época»); el índice
  es realmente parcial sobre `processed_at IS NULL`.
- **Parte C — RLS.** Un miembro lee su suscripción y **ninguna** de otra cuenta; no
  puede hacer UPDATE de su plan, ni de su propio `last_event_at` (moverlo sería
  poder repetir un evento favorable o congelar los futuros), ni DELETE, ni INSERT;
  `billing_events` no se lee ni se escribe desde `authenticated` (sus `payload`
  llevan datos de otros inquilinos).
- **Parte D — una suscripción de PayPal es de una sola cuenta.** El UNIQUE de
  `subscriptions.provider_subscription_id` y el de `checkout_intents` impiden que
  dos cuentas reclamen el mismo id; si no, la resolución de inquilino sería un
  volado entre el dinero de dos clientes.
- **Parte E — las escrituras reales caben en el esquema.** Los cinco `status` que
  escriben los manejadores pasan el CHECK de la 041, uno inventado no; el `addons`
  del `UPDATED` se fusiona sin perder claves; el trigger `set_updated_at` está
  cableado.

**Controles negativos ejecutados** (cada mutación hace fallar su aserción):

| Mutación | Falla con |
| --- | --- |
| `DROP CONSTRAINT billing_events_provider_provider_event_id_key` | `a replayed PayPal event was stored twice — the idempotency lock does not exist` |
| política `FOR UPDATE … USING (true)` en `subscriptions` | `a tenant updated its own subscription (1 rows) — it could grant itself any plan` |
| `DROP COLUMN subscriptions.last_event_at` | `subscriptions.last_event_at is missing or not timestamptz`; `verify-schema.sql`: `subscriptions.last_event_at is missing (migration 050)` |
| `DROP INDEX billing_events_unprocessed_idx` | `billing_events_unprocessed_idx does not exist`; `verify-schema.sql`: `billing_events_unprocessed_idx is missing (migration 050)` |

**Controles negativos del runner** (mutaciones en el código, revertidas después):

| Mutación | Pruebas que caen |
| --- | --- |
| quitar `.eq('account_id', …)` de la escritura de `subscriptions` y de `checkout_intents`, y la comprobación de `custom_id` | 2: «never writes to another account…», «ignores an account id the event tries to supply» |
| no verificar la firma (fallar abierto) | 2: «rejects a delivery with an invalid signature…», «verifies the raw bytes, before any parsing» |
| tratar el 23505 del cerrojo como «sigue adelante» | 1: «processes the same event only once…» |
| `const stale = false` (ignorar la marca de agua) | 5, entre ellas «cannot resurrect a subscription cancelled by a newer event» y «does not resurrect a cancelled subscription with a late activation» |

## Verificación manual pendiente (sandbox de PayPal)

Depende de un servicio externo; el cliente HTTP va con mocks, como `paypal.test.ts`.
Guion, con `PAYPAL_ENV=sandbox` y la base de sandbox:

1. En PayPal → Apps & Credentials → la app de sandbox → Webhooks, crear uno apuntando
   a `https://<despliegue>/api/billing/webhook` con los seis eventos de la tabla del
   spec. Copiar el **Webhook ID** a `PAYPAL_WEBHOOK_ID` y reiniciar la app.
2. Arrancar sin esa variable y disparar una entrega de prueba: debe responder **401**
   y no escribir en `billing_events`. Ponerla y repetir: 200.
3. Contratar un plan desde `/billing` con un comprador de sandbox y **cerrar el
   navegador tras aprobar, sin volver**. A los pocos segundos, `subscriptions` de esa
   cuenta debe estar `active` con `current_period_end`, y su `checkout_intents`
   en `activated`. (Criterio «cerrar el navegador tras aprobar activa igualmente».)
4. En el panel de webhooks de PayPal, **reenviar** el mismo `ACTIVATED` («Resend»).
   Respuesta 200, `billing_events` sigue con una sola fila para ese `id`, y
   `current_period_end` no se mueve.
5. Manipular un byte de `paypal-transmission-sig` con `curl` reproduciendo una entrega
   guardada: 401 y nada escrito.
6. En PayPal, suspender la suscripción → `status = suspended`. Reactivarla → vuelve a
   `active` por el `UPDATED`/`ACTIVATED`.
7. Provocar un fallo de pago (comprador de sandbox con fondos insuficientes) →
   `past_due` y `grace_until` a siete días del `create_time` del evento.
8. Cancelar la suscripción → `cancel_at_period_end = true` y el estado **sigue**
   `active` hasta `current_period_end`.
9. Esperar (o forzar) una renovación → `PAYMENT.SALE.COMPLETED` extiende el periodo
   un ciclo y devuelve a `active`.
10. Crear una suscripción en el panel de PayPal **fuera de la app** (sin intento) y
    dejar que llegue su `ACTIVATED`: respuesta 200 `unmatched`, ninguna escritura en
    `subscriptions`, y la fila aparece en la consulta de reconciliación de
    `docs/docker.md`.

Paso 10 y paso 2 son los que prueban «fallar cerrado» de punta a punta; los pasos
3–4 son los dos criterios de aceptación que no se pueden cerrar solo con mocks.

## Decisiones donde el spec era ambiguo

1. **`webhook_event` con los bytes crudos, no re-serializados.** El spec pide «el
   cuerpo crudo sin parsear». La llamada de verificación se construye concatenando
   texto (`"webhook_event":${rawBody}`) en vez de con `JSON.stringify`, porque
   `JSON.parse` + `JSON.stringify` no hace ida y vuelta (orden de claves, espacios,
   formato de números) y PayPal devolvería `FAILURE` para entregas legítimas. Todo lo
   demás del cuerpo sí pasa por `JSON.stringify`, así que una cabecera no puede
   escaparse de su cadena (probado: «escapes a header that tries to break out of its
   JSON string»).
2. **Marca de agua para el desorden (`subscriptions.last_event_at`, migración 050).**
   El spec dice «cada manejador comprueba coherencia antes de escribir» pero no cómo.
   La regla elegida es una sola y uniforme: *un evento con `create_time` anterior a la
   marca solo puede empujar `current_period_end` hacia adelante*; nunca cambia estado,
   plan, gracia ni la marca de cancelación, ni mueve el intento. Y, aparte,
   **`current_period_end` nunca retrocede**: el fallo asumible es servir de más unos
   días, no cortar a quien pagó.
3. **El primer cobro no duplica el ciclo.** `PAYMENT.SALE.COMPLETED` llega junto al
   `ACTIVATED` en la primera compra. En vez de sumar un ciclo a ciegas, se toma
   `max(periodo_actual, fecha_de_la_venta + ciclo)`: en la primera compra las dos
   fechas coinciden y no se regala un mes; en una renovación la venta cae al final del
   periodo y sí lo extiende.
4. **Cancelación: el estado no cambia.** La tabla del spec dice «`cancel_at_period_end`,
   servicio hasta fin de ciclo», así que `status` sigue `active`. Solo si no queda
   ciclo por servir (sin `current_period_end` o ya vencido) se pasa a `cancelled`: la
   bandera sin fecha detrás sería una promesa vacía.
5. **«Cantidad» del `UPDATED`.** Vendemos cuotas fijas y no hay columna de cantidad.
   Se guarda en `subscriptions.addons.paypal_quantity` para que una discrepancia sea
   visible en vez de perderse en silencio.
6. **Un fallo de escritura suelta el cerrojo y devuelve 500.** Literalmente, «insertar
   antes, 200 si choca» significa que un fallo transitorio de base (la escritura de
   `subscriptions` cae) dejaría el evento marcado como tomado y la reentrega de PayPal
   contestaría «duplicate» para siempre: una activación pagada perdida sin rastro. Por
   eso, y solo en ese camino, la fila de `billing_events` se **borra** y se responde
   500 para que el reintento de PayPal sea un reintento de verdad. Es seguro: nada se
   aplicó, y los manejadores escriben valores absolutos, así que repetir aterriza en el
   mismo estado. La idempotencia que pide el spec se mantiene: un evento **procesado**
   nunca se borra, así que su reentrega sí contesta `duplicate` sin hacer nada
   (probado: «releases the lock when a write fails…» + «processes the same event only
   once…»).
7. **Evento que no casa con ninguna cuenta → 200, no 500.** Es determinista: reintentar
   no lo arregla. Se guarda con `processed_at IS NULL` y el motivo en `error`, que es
   la cola de reconciliación que sirve el índice parcial de la 050 y que
   `docs/docker.md` documenta con su consulta. Se prefiere eso a adivinar la cuenta.
8. **`custom_id` no elige inquilino, solo contradice.** Se resuelve desde nuestras
   filas (intento o suscripción) y, si PayPal devuelve un `custom_id` distinto del
   dueño resuelto, se rechaza el evento en vez de escoger un bando.
9. **Eventos fuera de la tabla del spec** (`PAYMENT.SALE.REFUNDED`, etc.) se guardan en
   `billing_events` y se responden 200. Devolver 500 por cada uno convertiría el panel
   de entregas de PayPal en ruido y acabaría ocultando los fallos que sí importan.
10. **Validación de `cert_url`.** PayPal valida el certificado por su lado; aun así se
    exige `https` y host `paypal.com` o subdominio antes de reenviarlo, porque esa
    cabecera llega sin autenticar y es una petición saliente.
11. **Sin límite de tasa en la ruta.** `checkRateLimit` protege acciones de usuario;
    estrangular a PayPal solo provocaría reintentos y entregas perdidas.

## Variables de entorno nuevas

| Variable | Uso |
| --- | --- |
| `PAYPAL_WEBHOOK_ID` | id del webhook en PayPal; **obligatoria** para verificar la firma. Sin ella la ruta rechaza todo. |

Documentada en `docs/docker.md` (sección «PayPal webhook»), con los seis eventos a
suscribir y la consulta de reconciliación.

**`.env.local.example` está bloqueado por permisos y no se ha tocado.** Queda para el
humano añadir ahí `PAYPAL_WEBHOOK_ID` (ya estaba anotado como pendiente en
`progress/current.md`).

## Deuda detectada fuera de alcance (no arreglada)

1. **`CHANGELOG.md` ya estaba sucio para prettier antes de este cambio** (comprobado con
   `git stash` + `npx prettier --check`). No se ha corrido `prettier --write` sobre él
   para no meter ruido ajeno en el diff; alguien debería formatearlo en un commit
   propio. Lo mismo pasa con dos tablas de `docs/docker.md` que prettier quiere
   realinear y que se han dejado como estaban.
2. **Lectura-modificación-escritura sin bloqueo por cuenta.** El cerrojo de
   `billing_events` serializa *el mismo* evento, no dos eventos distintos de la misma
   cuenta llegando a la vez. PayPal entrega de forma prácticamente secuencial y la
   marca de agua limita el daño (el segundo en escribir gana, y es el más nuevo salvo
   carrera exacta), pero un `SELECT … FOR UPDATE` o un `UPDATE` condicional por
   `last_event_at` lo cerraría del todo. Fuera de §3.
3. **`subscriptions` no guarda el ciclo.** El ciclo de facturación solo vive en
   `checkout_intents.cycle`, así que una renovación necesita que el intento siga ahí.
   Si un día se purgan intentos viejos, las renovaciones dejarían de saber cuánto
   extender. Columna `cycle` en `subscriptions` = f3.5 o posterior.
4. **`src/middleware.ts`**: el build de Next 16 ya lo anuncia como `Proxy
   (Middleware)`; el archivo debería llamarse `proxy.ts`. Deuda ya anotada en
   `progress/impl_checkout-flow.md`, sin tocar.
5. **La migración 041 de esta rama todavía declara `subscriptions.account_id` con
   `ON DELETE CASCADE`**; la fase 0 ya lo pasó a `RESTRICT` y llegará por merge. La 050
   no lo toca (no es su sección).

## Compuerta

```
npm run lint       → 0 errors, 37 warnings (exactamente la línea base)
npm run typecheck  → ok
TZ=UTC npm test    → 91 archivos, 1019 pruebas, todas verdes
npm run build      → ✓ compiled; ƒ /api/billing/webhook
scripts/replay-migrations.sh <worktree> → verify-schema.sql: OK, exit 0
```

---

# Corrección tras CHANGES_REQUESTED (2ª ronda)

Revisión atendida: `progress/review_paypal-webhook.md` (seis cambios requeridos; el
hallazgo 5 queda como deuda declarada, por decisión del líder). Archivos tocados:
`src/lib/billing/webhook-events.ts`, `src/lib/billing/webhook-events.test.ts`,
`src/app/api/billing/webhook/route.ts`, `src/app/api/billing/webhook/route.test.ts`,
`src/lib/billing/paypal.ts`, `docs/docker.md`, `CHANGELOG.md`. **Sin SQL nuevo**: el
contraste del hallazgo 8 no necesita columna (la 048 ya guarda `provider_plan_id`).

## Cambio 1 — volver a contratar tras cancelar (bloqueante)

`decideSubscriptionChange` ya no rechaza sin más todo evento de una suscripción distinta
de la que la fila lleva. Distingue dos casos:

- **fila viva en otra suscripción** → sigue siendo `error` (lo que prueba
  `route.test.ts` › «does not let another subscription rewrite an account already on one»
  y, en la lógica pura, «does not rewrite a LIVE account that is on a different PayPal
  subscription» y «will not take over a row whose subscription is still alive»);
- **fila en estado terminal** (`cancelled`/`expired`) → la **adopta** el evento de la
  suscripción nueva, y solo si además (a) el evento es `ACTIVATED` o
  `PAYMENT.SALE.COMPLETED` —los dos que significan «esto se contrató y se pagó»— y (b)
  existe un `checkout_intents` **nuestro** para esa suscripción, que es justamente lo que
  identificó la cuenta en la ruta.

Al adoptar, la marca de agua no cuenta (`stale = !adopting && …`): `last_event_at`
pertenece al flujo de eventos de la suscripción que murió, no al de la que se contrata
ahora. Sin eso, un `ACTIVATED` de S2 anterior al último evento de S1 volvería a dejar al
cliente pagando sin servicio.

`PAYMENT.SALE.COMPLETED` adopta con la misma forma de parche que `ACTIVATED` (plan,
`active`, id de suscripción, periodo, `grace_until: null`, `cancel_at_period_end: false`),
porque el cobro puede adelantarse a la activación también en la recontratación.

**Lectura de la decisión del líder.** El enunciado («adopta cuando la anterior está en
estado terminal **o** cuando el intento resuelve a la misma cuenta») es, en el código,
una conjunción: el intento de `route.test.ts:526` también resuelve a la misma cuenta, y
ese caso debe seguir rechazándose («sigue rechazando una fila viva en otra suscripción»).
Se implementa por tanto: terminal **y** evento de contratación **y** intento nuestro.

## Cambio 2 — el duplicado reprocesa lo que nunca se aplicó

La rama de 23505 lee la fila de `billing_events` y solo contesta `duplicate` si tiene
`processed_at`. Con `processed_at IS NULL` —un `unmatched`, o un evento que murió— cae
por debajo y se procesa: la fila no es un evento terminado sino una entrada de la cola de
reconciliación, y el reenvío de PayPal (mismo `event.id`) es el reintento que la saca de
ahí. Es seguro porque cada manejador decide contra la fila **tal como está ahora** y
escribe valores absolutos.

`docs/docker.md` («When an event could not be applied») queda ajustado a eso: arreglar la
causa y pulsar **Resend**; nadie borra filas a mano; un evento que sí terminó no se aplica
dos veces por muchos reenvíos que haya.

## Cambio 3 — el `catch` genérico deja rastro consultable

Un throw inesperado (un `TypeError`, un rechazo que supabase-js no convierte en `{error}`)
escribe `billing_events.error` con `unexpected failure — <name>: <message>` (recortado a
500 caracteres) y **deja `processed_at` en NULL**. Dos consecuencias: la consulta de
reconciliación de `docs/docker.md` lo ve, y —por el cambio 2— la reentrega de PayPal lo
reintenta de verdad. Eso es «soltar el cerrojo» sin perder el motivo: borrar la fila, como
hace la rama transitoria, se llevaría por delante el único rastro del fallo.
`recordFailure` es «best effort» y no lanza: la respuesta a PayPal sigue siendo 500.

## Cambio 4 — el `CANCELLED` viejo tras un `ACTIVATED` nuevo

Con test propio en los dos niveles: `webhook-events.test.ts` › «cannot cancel a
subscription a newer event already reactivated» y `route.test.ts` › «does not cancel with
a late cancellation of an already reactivated plan», que además comprueba que **no hay
ninguna escritura** ni en `subscriptions` ni en `checkout_intents`.

## Cambios 5 y 6

- **Parsear antes de verificar.** `POST` hace `JSON.parse` y exige **objeto plano** (ni
  array, ni `null`, ni escalar) antes de llamar a PayPal, y sigue mandando los bytes
  originales. Así la precondición que describe `paypal.ts` es cierta cuando se escribe el
  cuerpo de verificación a mano, y un cuerpo que intente cerrar el objeto y colar un
  `webhook_id` propio muere en el 400. Los comentarios de `paypal.ts:449,461` quedan
  corregidos para decir lo que ocurre, en el orden en que ocurre.
- **Guarda `TERMINAL` en `ACTIVATED`.** Se implementa como regla uniforme en
  `decideSubscriptionChange` (`terminated`) y no dentro del manejador: una suscripción
  `cancelled`/`expired` es el fin de línea **de esa suscripción**, así que ningún evento
  suyo la levanta, y la regla **no depende de `last_event_at`** (NULL en toda fila anterior
  a la 050). Se trata como entrega tardía, no como rechazo, para que el periodo pueda
  seguir moviéndose hacia adelante: quien pagó conserva lo pagado. No colisiona con el
  cambio 1 porque solo aplica cuando la fila está en **esa misma** suscripción.
- **`quantity` numérica.** `numberOrNull` acepta número JSON o string numérica; un `2` sin
  comillas ya no se descarta en silencio.
- **Contraste de `provider_plan_id` (hallazgo 8): implementado, sin migración.** La 048 ya
  guarda `checkout_intents.provider_plan_id` (NOT NULL, verificado contra el Postgres del
  harness), así que no hacía falta columna nueva ni corregir el comentario de la 048: ahora
  describe algo que el código hace. `INTENT_COLUMNS` lo selecciona y el manejador de
  `ACTIVATED` compara `event.resource.plan_id` con él. Si difieren → `error` →`unmatched`,
  sin escritura: el cliente aprobó algo distinto de lo que pidió y conceder cualquiera de
  los dos planes sería adivinar. Queda en la cola de reconciliación con su payload y, tras
  arreglar la causa, un reenvío lo aplica (cambio 2).

## Pruebas nuevas

| Cambio | Prueba |
| --- | --- |
| 1 — recontratación (ruta, secuencia completa) | `route.test.ts` › «activates the new subscription of a customer who contracted again after cancelling»: `ACTIVATED` de S1 → `CANCELLED` de S1 (fila `cancelled`) → intento de S2 → `ACTIVATED` de S2 deja `active` sobre `I-2`, `cancel_at_period_end: false`, `grace_until: null`, una sola fila, y el ámbito de toda escritura sigue siendo la cuenta |
| 1 — lógica pura | `webhook-events.test.ts` › «takes over the row left by the subscription the customer cancelled», › «takes over the cancelled row when the new sale lands before its activation» |
| 1 — lo que **no** se adopta | › «will not take over a row whose subscription is still alive», › «refuses to take a row over with no checkout intent of ours behind it», › «does not rewrite a LIVE account that is on a different PayPal subscription» |
| 2 — reproceso del reenvío | `route.test.ts` › «reprocesses a redelivery of an event that was never applied» (unmatched → se arregla la causa → el mismo `event.id` se aplica, una sola fila de evento, `error` a NULL) |
| 3 — rastro del fallo inesperado | `route.test.ts` › «leaves a queryable reason when processing blows up unexpectedly» (`processed_at` y `error` nunca ambos NULL; y la reentrega posterior sí procesa) |
| 4 — `CANCELLED` desordenado | `route.test.ts` › «does not cancel with a late cancellation of an already reactivated plan»; `webhook-events.test.ts` › «cannot cancel a subscription a newer event already reactivated» |
| 5 — objeto plano antes de verificar | `route.test.ts` › «refuses a body that is not a JSON object before asking PayPal» (array, string, `null`, número → 400 y **ni se llama** a PayPal); › «verifies the delivered bytes, never a re-serialisation of them» (renombrada) |
| 6 — fin de línea de una suscripción | `route.test.ts` › «does not lift a cancelled subscription with a redelivery of its own activation» (con `last_event_at` NULL, como nacen las filas tras la 050); `webhook-events.test.ts` › «does not lift a cancelled subscription back with its own activation» |
| 6 — `quantity` numérica | `webhook-events.test.ts` › «records a quantity PayPal sends as a JSON number, not a string» |
| 6 — contraste de plan | `route.test.ts` › «refuses an activation of a plan the customer never asked for» y › «activates when PayPal reports the very plan the intent asked for»; `webhook-events.test.ts` › «refuses an activation of a plan the intent never asked for», › «activates when the activated plan is the one the intent asked for» |

Suite completa: **91** archivos, **1036** pruebas (+17).

### Controles negativos del runner (2ª ronda)

Cada mutación se aplicó, se corrió la suite y se revirtió:

| Mutación | Pruebas que caen |
| --- | --- |
| adopción apagada (`adopting = false`) | 3: las dos de adopción pura y la secuencia completa de la ruta |
| sin guarda de fin de línea (`terminated = false`) | 2: las dos de «no levantar una cancelada con su propia activación» |
| sin contraste de plan | 2: las dos de «plan que el cliente no pidió» |
| `quantity` solo string | 1: «records a quantity PayPal sends as a JSON number» |
| el duplicado nunca reprocesa | 2: «reprocesses a redelivery…» y «leaves a queryable reason…» |
| `catch` genérico sin `recordFailure` | 1: «leaves a queryable reason when processing blows up unexpectedly» |
| sin exigir objeto antes de verificar | 1: «refuses a body that is not a JSON object before asking PayPal» |
| `stale = false` (sin marca de agua) | 9, entre ellas las dos nuevas de desorden |

### Verificación contra base real (parte F, nueva)

`progress/checks_paypal-webhook.sql` gana una parte F, ejecutada contra el Postgres del
harness (`BEGIN/DO/ROLLBACK` ×6, `ON_ERROR_STOP=1`, sin excepciones):

- una cuenta con la suscripción `cancelled` sobre `I-1` puede tener un **segundo**
  `checkout_intents` sobre `I-2` (el UNIQUE de la 048 es por suscripción del proveedor, no
  por cuenta: si fuera por cuenta, recontratar sería imposible);
- el UPDATE de adopción acotado por `account_id` no choca con el UNIQUE de
  `subscriptions.provider_subscription_id` y deja **una** fila;
- `checkout_intents.provider_plan_id` existe, es `text` y **NOT NULL** — el contraste del
  `ACTIVATED` siempre tiene con qué comparar;
- una fila de evento con `processed_at IS NULL AND error IS NOT NULL` aparece en la cola de
  reconciliación y el reenvío la cierra **en sitio**, sin borrar nada.

Control negativo ejecutado: `ALTER TABLE checkout_intents ALTER COLUMN provider_plan_id
DROP NOT NULL` hace fallar la aserción con
`checkout_intents.provider_plan_id is missing or nullable — the activation could not be
contrasted`.

## Verificación manual pendiente (añadido al guion)

Al guion de sandbox de la primera ronda se añaden tres pasos, que dependen igualmente de
PayPal:

11. Cancelar la suscripción del paso 8, esperar a que el ciclo pagado venza (o forzar el
    `CANCELLED` con el periodo ya vencido) y **volver a contratar** desde `/billing` con el
    mismo comprador: al llegar el `ACTIVATED` de la nueva suscripción, `subscriptions` de
    esa cuenta debe quedar `active` con el **nuevo** `provider_subscription_id`,
    `cancel_at_period_end = false` y `grace_until = NULL`, y el intento nuevo en
    `activated` (el viejo sigue en `cancelled`).
12. Provocar un `unmatched` (paso 10), arreglar la causa y pulsar **Resend** en el panel de
    entregas: la misma fila de `billing_events` pasa a `processed_at` con `error` a NULL,
    sin borrar nada, y `subscriptions` refleja el evento.
13. Con el mismo evento ya procesado, pulsar **Resend** otra vez: respuesta 200
    `duplicate`, `current_period_end` sin moverse.

## Deuda declarada (sin arreglar, por decisión del líder)

- **Hallazgo 5 — lectura-modificación-escritura sin bloqueo por cuenta.** Dos entregas
  simultáneas de la misma cuenta leen el mismo `last_event_at` y la segunda en escribir
  pisa estado y marca de agua. Un `UPDATE … WHERE last_event_at IS NOT DISTINCT FROM
  <leído>` lo cerraría. El cambio 2 **amplía ligeramente** la ventana: una entrega que
  llega mientras la primera sigue en vuelo ya no se contesta `duplicate` sino que se
  procesa en paralelo. El daño sigue acotado —los manejadores escriben valores absolutos y
  la marca de agua limita el resto— y PayPal entrega prácticamente en serie, pero es el
  mismo agujero y se cierra con la misma línea. Queda anotado para f3.4 o posterior.
- Sigue vigente el resto de la deuda de la primera ronda (formato de `CHANGELOG.md` y
  `docs/docker.md` sucio de antes —solo se han formateado las líneas propias—,
  `subscriptions` sin columna de ciclo, `src/middleware.ts` → `proxy.ts`, `ON DELETE
  CASCADE` de la 041 que llega arreglado por merge de fase 0).
- **`.env.local.example` sigue bloqueado por permisos y sin tocar**: `PAYPAL_WEBHOOK_ID`
  queda pendiente para el humano.

## Compuerta (2ª ronda)

```
npm run lint       → 0 errors, 37 warnings (la línea base de la rama, sin cambios)
npm run typecheck  → ok
TZ=UTC npm test    → 91 archivos, 1036 pruebas, todas verdes
npm run build      → ✓ compiled in 6.2s; ƒ /api/billing/webhook
scripts/replay-migrations.sh <worktree> → verify-schema.sql: OK, exit 0
progress/checks_paypal-webhook.sql → BEGIN/DO/ROLLBACK ×6, sin excepciones
```
