# Implementación: f3.5 `subscription-settings-ui`

- **Rama:** `saas/fase-3-facturacion` (worktree `.claude/worktrees/fase-3`, base `08bc791`)
- **Spec:** `docs/saas/fase-3-facturacion.md` §6 «Área de suscripción» + «Lo que PayPal no
  hace, y cómo se rodea» + los criterios «El consumo mostrado coincide con `usage_counters`»
  y «Un usuario autenticado no puede modificar su propia suscripción ni sus contadores».
- **Estado:** ronda 2. Compuerta verde, pendiente de re-revisión. Última de la fase 3.

## Commits

| SHA | Mensaje |
|---|---|
| `4cd94a4` | `feat: mostrar y gobernar la suscripción desde Ajustes` |
| `adf72a0` | `fix: servir al cliente que vuelve a contratar tras cancelar` (ronda 2: los siete cambios de la revisión) |

Árbol limpio tras el commit. Nada pusheado; `main`, `dev` y `feat/saas-multiempresa`
intactos.

## Qué hace

Ajustes gana una sección **Subscription** (`?tab=subscription`), visible para `admin`+:

1. **Plan, estado y próxima fecha de cobro.** El estado se explica en una frase por rung de
   la escalera de §5: prueba con fecha, cancelación programada con la fecha hasta la que hay
   servicio, `past_due` con su gracia, solo lectura (reutiliza `Billing.lockedBody`, que ya
   existía), y «sin suscripción» para `cancelled`/`expired`. Se muestran `current_period_end`
   y, aparte, la **próxima fecha de cobro**, que es null cuando ya hay cancelación pendiente:
   la misma fecha significa dos cosas distintas y llamarla «próximo cobro» sería una promesa
   falsa.
2. **Consumo del ciclo por métrica con barras**, leído de `usage_counters` y contrastado con
   los límites de `plans`. El número que se pinta es el de la tabla, sin transformar.
3. **Recibos** a partir de los `billing_events` de tipo `PAYMENT.SALE.COMPLETED`: importe (la
   cadena decimal tal cual la mandó PayPal), fecha, id de transacción y, si el evento trae un
   enlace de cara al cliente, el enlace.
4. **Acciones**: cambiar de plan, cancelar, reactivar.

Todo sale de una sola llamada a `GET /api/billing/subscription`; las tres acciones van por
`POST` a la misma ruta con `action`.

**Ninguna ruta de esta feature pone `status = 'active'`.** La única escritura local del
diff es `cancel_at_period_end = true` inmediatamente después de que PayPal aceptara la
cancelación, y esa bandera solo quita derechos. `last_event_at` no se toca: no somos un
evento, y mover la marca de agua haría parecer tardío al `CANCELLED` de PayPal.

## Archivos

| Archivo | Qué es |
| --- | --- |
| `supabase/migrations/056_subscription_cycle_and_receipts.sql` | `subscriptions.cycle` (+ backfill desde `checkout_intents`) y el índice de expresión de recibos |
| `supabase/ci/verify-schema.sql` | 3 aserciones de la 056 |
| `src/lib/billing/paypal.ts` | `cancelSubscription`, `activateSubscription`, `reviseSubscription` |
| `src/lib/billing/subscription-view.ts` | lógica pura: consumo, recibos, qué acciones caben en cada estado, próxima fecha de cobro |
| `src/app/api/billing/subscription/route.ts` | `GET` (panel) y `POST` (`cancel` \| `reactivate` \| `change_plan`) |
| `src/components/settings/subscription-panel.tsx` | la pantalla |
| `src/components/settings/settings-sections.ts`, `settings-rail.tsx`, `src/app/(dashboard)/settings/page.tsx` | la sección nueva y su puerta `adminOnly` en el raíl |
| `src/lib/billing/checkout.ts` | `alreadyContracted` deja contratar a quien ya canceló (es el camino de «reactivar») |
| `src/lib/billing/webhook-events.ts`, `src/app/api/billing/webhook/route.ts` | el ciclo viaja en el parche: `ACTIVATED` lo toma del intento, `UPDATED` de la columna del catálogo que casó, la renovación lo prefiere al del intento. **Ronda 2**: la adopción acepta una fila con cancelación programada y, al adoptar, el ciclo lo manda el intento |
| `messages/en.json`, `messages/ko.json` | espacio `Billing.subscription` (**48** claves) + `Settings.sections.subscription`. Paridad comprobada: 1 559 claves en cada catálogo, ninguna sobrante en ninguno de los dos |
| `CHANGELOG.md`, `docs/docker.md` | entrada Unreleased + nota de migración; sección operativa de la 056 y del evento `UPDATED` |

Sin dependencias nuevas (CP5).

## Las tres acciones, y por qué así

### Cancelar

`POST /v1/billing/subscriptions/{id}/cancel` en PayPal y, solo si PayPal lo aceptó,
`cancel_at_period_end = true` en local. Es literalmente lo que pide la tabla de §3
(«`cancel_at_period_end`, servicio hasta fin de ciclo») adelantado al momento en que el
cliente pulsa, para que la interfaz no mienta durante los segundos que tarda el evento. El
`status` no se toca.

Un 422 de PayPal se trata como «ya estaba cancelada» (el cliente lo hizo desde su cuenta de
PayPal, o el evento viene de camino) y la bandera se pone igual: el estado del proveedor y
nuestra intención coinciden. Cualquier otro fallo es 502 y **no se escribe nada**.

Si PayPal cancela pero la escritura local falla, la respuesta es 200 con
`status: 'cancelled_at_provider'`: decir «falló» invitaría a reintentar una cancelación
sobre una suscripción que ya no existe, y el webhook pone la misma bandera cuando llega su
evento.

### Cambiar de plan

`POST /v1/billing/subscriptions/{id}/revise` sobre **la misma** suscripción. Es el único
camino que cumple las dos cosas que pide el encargo a la vez —«sin dos suscripciones
cobrándose a la vez» y «los cambios de plan se aplican al renovar»— y es el que describe la
tabla del spec: «Subir de plan **puede** exigir re-aprobación → otra redirección a PayPal.
La interfaz contempla ese estado intermedio; no se asume cambio instantáneo». Ese *puede*
es el lenguaje de `revise`: PayPal pide aprobación cuando el importe sube y no la pide
cuando baja. Con un cancelar-y-recontratar la aprobación haría falta **siempre**.

La ruta devuelve `approval_required` + `approvalUrl` (y el navegador va a PayPal) o
`change_requested`. En los dos casos **no escribe nada**: el plan lo reconcilia
`BILLING.SUBSCRIPTION.UPDATED`, igual que la página de retorno de §2 no activa nada.

Una cuenta sin nada cobrándose (prueba, cancelada, vencida, o con cancelación programada)
no tiene suscripción que revisar: la ruta responde 409 con `mode: 'checkout'` y la pantalla
manda a `/billing`, que es el checkout de f3.2 **reutilizado** en vez de duplicado. Ese es
además el caso mayoritario hoy, porque la 046 siembra a todo el mundo como `trialing`.

### Reactivar

Depende del estado, como pide el encargo:

- `suspended` con id de proveedor → `POST /v1/billing/subscriptions/{id}/activate`. La ruta
  **no escribe nada**: PayPal emite `ACTIVATED` y el webhook levanta el estado.
- `cancelled`, `expired`, o cancelación ya programada → checkout nuevo. El `cancel` de
  PayPal es inmediato e irreversible; no existe «deshacer».

Eso último destapó un bloqueo real: `alreadyContracted()` (f3.2) impedía contratar mientras
el estado siguiera `active`, que es justo lo que pasa tras cancelar hasta que vence el ciclo
pagado. Un cliente que cancelaba y se arrepentía se quedaba semanas sin poder pagarnos. Se
añade `cancel_at_period_end → no contratada`: una suscripción que PayPal ya canceló no puede
volver a cobrar, así que no hay doble cobro posible.

## Por qué había que tocar el webhook (migración 056)

`PAYMENT.SALE.COMPLETED` **no trae `plan_id`**: extiende el periodo con `addCycle(fecha,
ciclo)` y ese ciclo solo vivía en `checkout_intents.cycle`, o sea en lo que se contrató *la
primera vez*. `revise` cambia el plan de la **misma** suscripción sin crear intento nuevo
(el `UNIQUE (provider, provider_subscription_id)` de la 048 ni siquiera permitiría otro), así
que un cliente que pasa de mensual a anual pagaría un año y se le extendería el periodo **un
mes**; cuatro semanas después la cuenta cae en solo lectura habiendo pagado. Es una pérdida
de servicio con dinero cobrado, no una molestia.

La deuda ya estaba declarada y asignada a esta feature: *«`subscriptions` no guarda el ciclo…
Columna `cycle` en `subscriptions` = f3.5 o posterior»* (`progress/impl_paypal-webhook.md`,
deuda 3).

El arreglo es aditivo:

- `subscriptions.cycle`, **nullable** (`NULL` = «no se sabe» → se cae al intento, que es el
  comportamiento anterior a la migración), con CHECK `month|year` y backfill desde el intento
  que creó cada suscripción viva. Aplicarla no cambia el cobro de nadie.
- `decideSubscriptionChange`: `ACTIVATED` escribe `cycle` del intento; `UPDATED` escribe el
  ciclo **de la columna del catálogo que casó** con el `plan_id` del evento —es el único sitio
  del que se puede leer—; `PAYMENT.SALE.COMPLETED` prefiere `existing.cycle` y cae al del
  intento si es NULL.
- `resolvePlanForEvent` en la ruta pasa a devolver `{ planId, cycle }`.

## Aislamiento (CP3)

`billing_events` es la única tabla del diff **sin `account_id`**: es la bitácora global de la
pasarela. El ámbito de inquilino se construye antes de tocarla —los ids de suscripción de
PayPal de esta cuenta, sacados de `subscriptions` y `checkout_intents`, las dos filtradas por
`account_id` y las dos con el id bajo un `UNIQUE` global, así que un id de esa lista no puede
ser de nadie más— y se aplica **en la base** con `.in('payload->resource->>billing_agreement_id', ids)`.
Sin ids, la consulta **no se hace**: leer la tabla entera y filtrar en proceso sería leer el
historial de pagos de todos los clientes.

El resto (`subscriptions`, `usage_counters`, `checkout_intents`, `plans`) va por el cliente
del usuario, con RLS **y** `.eq('account_id', …)` explícito.

## `allowReadOnly: true` en las cuatro verbos

§5 dice que una cuenta `suspended` se comporta como si todos fueran `viewer`; §6 dice que esa
misma cuenta tiene que ver su suscripción y el botón para regularizar. Un área de facturación
que da 403 justo cuando la facturación está rota es una puerta cerrada con la llave dentro.
Precedente exacto: `POST /api/billing/checkout`, que f3.4 ya eximió con este mismo argumento.

La docstring de `RequireRoleOptions` avisa de que en una ruta que escribe la opción «es un
bug». Aquí se asume a conciencia y se acota: **ninguna** de estas rutas escribe dato de
inquilino. Actúan sobre la relación de facturación —que es la salida del bloqueo— y su única
escritura local quita derechos (`cancel_at_period_end`). Que una cuenta suspendida pueda
cancelar es además lo correcto: dejar de pagar tiene que ser posible siempre.

## Criterio ↔ prueba

| Criterio | Prueba |
| --- | --- |
| **«El consumo mostrado coincide con `usage_counters`»** | `src/lib/billing/subscription-view.test.ts` › «shows the counter value verbatim, not a derived number», › «does NOT clamp the used figure to the limit», › «decodes a bigint that arrives as a string without changing it» |
| ídem, extremo a extremo por la ruta | `src/app/api/billing/subscription/route.test.ts` › «shows the consumption of usage_counters, unchanged» |
| ídem, mismo periodo que el que aplica los límites | `route.test.ts` › «counts only the current period, never a previous one»; en base real, `progress/checks_subscription-settings-ui.sql` **parte B** (el ancla de `increment_usage` es la misma que `currentPeriodStart()`) |
| Una métrica sin fila muestra 0; una sin tope muestra el consumo sin barra | `subscription-view.test.ts` › «reports zero for a metric with no counter row yet», › «shows an unlimited metric with no bar instead of hiding it» |
| **«Un usuario autenticado no puede modificar su propia suscripción ni sus contadores»** | base real: `checks_subscription-settings-ui.sql` **parte A** (UPDATE/DELETE a 0 filas, INSERT con `insufficient_privilege`, y los dos campos que §6 mueve: `cancel_at_period_end` y `cycle`). Complementa la parte C de `checks_paypal-webhook.sql` (plan y marca de agua) y la parte G de `checks_enforce-limits.sql` |
| El consumo es dato admin+ | parte A: un `agent` de la **misma** cuenta lee 0 contadores y sí lee la fila de `subscriptions` (041 la abre a cualquier miembro; la puerta admin+ de §6 es de la ruta) |
| Nadie lee `billing_events` desde el navegador | parte A (0 filas con `authenticated`) |
| Plan, estado, ciclo y próxima fecha de cobro | `route.test.ts` › «reports plan, status, cycle and the next charge»; `subscription-view.test.ts` › describe `nextChargeAt` (3 tests) |
| Recibos de esta cuenta y de ninguna otra (CP3) | `route.test.ts` › «lists this account receipts and never another account (leak test)», › «never touches the gateway log when the account has no PayPal id», › «includes the payments of a subscription that was cancelled and re-contracted» |
| Importe, fecha, id de transacción y enlace | `subscription-view.test.ts` › describe `parseReceipt` (6 tests), incluido «keeps the amount as the decimal string PayPal sent» y «takes a customer-facing PayPal link and nothing else» |
| Toda consulta de rol de usuario acotada por cuenta (CP3) | `route.test.ts` › «scopes every tenant query by account_id (leak test)», › «never writes another account (leak test)», › «ignores an account_id the caller tries to supply» |
| **Una cuenta `suspended` ve su suscripción y su salida** | `route.test.ts` › «answers a suspended account — it is the one that needs the button» (200, `readOnly: true`, `reactivate: 'activate'`) y › «lets a suspended account cancel — stopping the bill is the way out too» |
| Solo `admin`+ | `route.test.ts` › «refuses a caller below admin» (GET y POST) |
| **Cancelar = PayPal + `cancel_at_period_end`, y nada más** | `route.test.ts` › «cancels at PayPal and only flags the end of the cycle» (comprueba que el parche tiene **exactamente** esa clave, que `status`, `current_period_end` y `last_event_at` no se mueven) |
| Cancelar es idempotente frente a PayPal | › «accepts a subscription PayPal had already cancelled» |
| Un fallo de PayPal no inventa una cancelación | › «502s and writes nothing when PayPal refuses» |
| No se cancela dos veces ni sin nada que cancelar | › «409s when there is nothing to cancel», › «does not cancel twice once the cancellation is scheduled» |
| **Reactivar no activa: lo pide** | › «asks PayPal to resume and writes absolutely nothing» |
| Reactivar según el estado | › «sends a cancelled subscription to the checkout instead», › «does not try to resume a subscription that is already running»; `subscription-view.test.ts` › describe `availableActions` (7 tests) |
| **Cambiar de plan sin dos suscripciones cobrándose** | `route.test.ts` › «revises the same PayPal subscription, never opening a second one»; `src/lib/billing/paypal.test.ts` › «moves the SAME subscription onto another plan» (afirma la ruta `/revise`, no `POST /v1/billing/subscriptions`) |
| Estado intermedio de re-aprobación | `route.test.ts` › «hands back the approval link when PayPal wants the buyer to approve»; `paypal.test.ts` › «reports the approval link when PayPal needs the buyer to approve» |
| El cambio de plan no escribe el plan | `route.test.ts` › «writes no plan of its own — the UPDATED event reconciles it» |
| Cambio de ciclo | `route.test.ts` › «can move the billing cycle of the very same plan» |
| Validación antes de tocar PayPal | › «refuses the plan and cycle already in force», › «refuses a plan that is not on sale and a cycle PayPal has no plan for», › «validates the body before touching PayPal» |
| Reutilizar el checkout de f3.2 cuando no hay nada que revisar | › «sends an account with nothing being charged to the checkout»; `src/app/api/billing/checkout/route.test.ts` › «lets an account that already cancelled contract again (fase 3 §6)»; `src/lib/billing/checkout.test.ts` › «lets an account whose cancellation is already accepted contract again» |
| **«Volver a contratar tras cancelar funciona» — el OTRO extremo: que el webhook aplique el `ACTIVATED` de la suscripción nueva** (ronda 2) | `src/lib/billing/webhook-events.test.ts` › describe `re-contracting after a cancellation` (7 tests) y `src/app/api/billing/webhook/route.test.ts` › los dos «step 8». Antes de la ronda 2 la cobertura se detenía justo antes de este punto y el webhook lo rechazaba |
| **La renovación usa el ciclo que se cobra, no el contratado** (056) | `src/lib/billing/webhook-events.test.ts` › describe `billing cycle` (6 tests) y `src/app/api/billing/webhook/route.test.ts` › «learns the new billing cycle from the plan the update names (056)» (cambia a anual y comprueba que la venta siguiente extiende **un año**) |
| Compatibilidad con las filas anteriores a la 056 | `webhook-events.test.ts` › «falls back to the intent when no cycle was ever recorded», › «ignores a stored cycle that is not one we sell» |
| CP11 | el diff no toca `src/app/api/whatsapp/**` ni nada que el webhook de entrada lea |

Suite completa (ronda 2): **107** archivos, **1 290** pruebas (ronda 1: 1 276; antes de la
feature: 105 / 1 204).

## Ronda 2 — los siete cambios del revisor

`adf72a0`. Nada de SQL: la 056 no se toca, así que el replay de la ronda 1 sigue siendo
válido (se vuelve a anotar abajo sin re-ejecutar Docker).

### 1. El cliente que vuelve a contratar tras cancelar (bloqueante, dinero)

`src/lib/billing/webhook-events.ts`. La regla de adopción exigía
`TERMINAL.has(existing.status)` con `TERMINAL = {cancelled, expired}`. Cancelar deja la
fila en `active` + `cancel_at_period_end` —el manejador de `CANCELLED` escribe **solo** la
bandera mientras quede ciclo pagado, y no hay job de vencimiento que la mueva después—, así
que el `ACTIVATED` de la suscripción nueva caía en `kind: 'error'` → `unmatched`: nada
escrito, intento nunca `activated`, y solo lectura al vencer el ciclo viejo. Exactamente el
daño que la fase existe para evitar.

Se ensancha a «la fila ya no se está cobrando», que son dos cosas y no una:

```ts
const noLongerCharged = Boolean(
  existing && (TERMINAL.has(existing.status) || existing.cancel_at_period_end)
);
const adopting =
  onAnotherSubscription &&
  ADOPTING_EVENT_TYPES.has(event.eventType) &&
  noLongerCharged &&
  Boolean(input.intent);
```

Lo demás de la regla no se afloja: solo los dos eventos que significan «contratado y
pagado», y solo con un `checkout_intents` de los nuestros detrás —que es lo que resolvió la
cuenta en la ruta (`route.ts:341-385`: si el dueño de la suscripción y el intento
discrepasen de cuenta, la ruta corta antes con `conflict`), así que «hay intento» ya
**implica** «resuelve a esta misma cuenta»—. Una fila viva **sin** cancelación programada
sigue rechazada.

### 2. El ciclo al adoptar (dinero, regresión de la 056)

```ts
const cycle = (adopting ? null : asBillingCycle(existing?.cycle)) ?? intent?.cycle;
```

y el parche de `!existing || adopting` escribe `cycle`. Sin esto, quien estaba en anual,
cancelaba y volvía a contratar **mensual** recibía `addCycle(eventTime, 'year')` por un mes
de dinero, y el `ACTIVATED` posterior no lo corregía (`laterIso` no rebobina el periodo).

### 3. El guardián de «ese ya es tu plan» con `cycle` NULL

`src/app/api/billing/subscription/route.ts`. Se sustituye la comparación por ciclo (falsa
siempre con `cycle` NULL) por una comparación del **`provider_plan_id` resultante contra el
vigente**, resuelto en `providerPlanIdInForce()`:

- del catálogo cuando `subscriptions.cycle` dice qué id está en vigor (y solo sobre el
  plan **propio** de la fila: dos planes distintos nunca comparten id de PayPal, así que un
  cambio de plan es un cambio real diga lo que diga el ciclo);
- del `checkout_intents.provider_plan_id` que creó la suscripción (columna de la 048)
  cuando el ciclo es NULL. Todo evento que mueve el ciclo lo escribe, así que un ciclo NULL
  significa que nada se ha movido desde el checkout.

`null` = «no lo sabemos» y entonces el `revise` **pasa**: negar un cambio a ciegas dejaría
al cliente encerrado en su plan. La consulta nueva va por el cliente del usuario y filtra
por `account_id` (CP3), con aserción de ello en el test.

### 4 y 5. Interfaz

- Los retornos tempranos de carga y de error van **dentro** de `RequireRole` (fallback
  extraído a `adminOnly`, una sola vez para los tres retornos). Además el panel no dispara
  ya el `fetch` por debajo de `admin`: `useAuth` + `hasMinRole` con el mismo criterio que
  `RequireRole` (falla cerrado mientras el perfil carga), así que un `agent` que abra
  `?tab=subscription` ve «solo administradores» y no un toast de error por un 403.
- La cadena de `note` pone `readOnly` **por delante** de `cancelAtPeriodEnd`: una cuenta
  `suspended` o `expired` que canceló leía «el servicio sigue hasta <fecha ya pasada>» y se
  perdía `Billing.lockedBody`, el único mensaje que explica el bloqueo.

### 6. El sandbox de PayPal: **no se puede correr aquí**

No hay credenciales de sandbox en este entorno y `.env.local` está bloqueado por permisos,
así que **no se declara hecho**. Los pasos 6, 7 y 8 quedan marcados «pendiente de ejecutar
por el humano» en el guion de más abajo, con lo que hay que mirar en cada uno.

En su lugar se añaden tests de ruta que reproducen esas tres secuencias con mocks
(`src/app/api/billing/webhook/route.test.ts` › describe «the sandbox script, reproduced with
mocks»). No sustituyen la ejecución real —lo que un mock no puede decir es qué contesta
PayPal, que es justo la deuda 1 de este informe— pero fijan todo lo que está de nuestro lado
del cable.

### 7. El reformateo de prettier (CP8)

Revertido. `settings-rail.tsx`, `settings-sections.ts` y `src/app/(dashboard)/settings/page.tsx`
vuelven a su contenido de `08bc791` y solo reciben las líneas de la feature (import,
`'subscription'` en la lista, `adminOnly` en `SectionMeta` y su entrada, el filtro del raíl y
el panel en el mapa). Diff de los tres: **+28 −1** líneas, todas de §6.

Esos tres archivos estaban sucios para prettier **antes** de esta feature (la config actual
es `trailingComma: es5` + `prettier-plugin-tailwindcss` y ellos venían de otra), y siguen
estándolo: `npm run lint` no corre prettier, así que la compuerta no se ve afectada. Queda
anotado como deuda ajena (ver deuda 9).

### Criterio ↔ prueba (ronda 2)

| Cambio | Prueba |
| --- | --- |
| 1 — la fila con cancelación programada se adopta con `ACTIVATED` | `src/lib/billing/webhook-events.test.ts` › describe `re-contracting after a cancellation` › «takes the row over when the new subscription activates» (`provider_subscription_id` → `I-NEW`, `cancel_at_period_end: false`, `grace_until: null`, `intentStatus: 'activated'`) |
| 1 — y con la venta, cuando llega antes | ídem › «takes the row over when the first payment arrives first» |
| 1 — de punta a punta por la ruta (paso 8 del guion) | `src/app/api/billing/webhook/route.test.ts` › «step 8 — contracting again after cancelling is served, not refused» (200 `processed`, fila sobre `I-NEW`, intento `activated`, una sola fila, escritura solo en la cuenta) y › «step 8 — and the payment of the new subscription extends its own cycle» |
| 1 — la fila viva sin cancelación **sigue** rechazada (regla de f3.3) | `webhook-events.test.ts` › «still refuses a row that is alive with no cancellation scheduled» (`active` y `past_due`), y los dos tests de f3.3 intactos: › «does not rewrite a LIVE account that is on a different PayPal subscription», › «will not take over a row whose subscription is still alive» |
| 1 — sin intento no hay adopción | › «refuses even a scheduled-to-cancel row with no intent behind it» |
| 1 — la adopción nunca es tardía | › «is never treated as a late delivery» (evento sellado **antes** de la marca de agua de la suscripción muerta) |
| 1 — solo los dos eventos de compra adoptan | › «does not adopt on an event that is not a purchase» (`SUSPENDED` → error) |
| 2 — el ciclo adoptado es el del intento | › «charges the new cycle, not the one the dead subscription had» (fila `year`, intento `month` → periodo **un mes**, `cycle: 'month'`) |
| 2 — y la fila queda en `month` para la renovación siguiente | ídem, `decision.patch.cycle`; por la ruta, «step 8 — and the payment…» comprueba `cycle: 'month'` y `current_period_end` a un mes |
| 3 — el guardián no depende de un `cycle` NULL | `src/app/api/billing/subscription/route.test.ts` › «refuses the plan in force even when the cycle column is NULL» (409, `reviseSubscription` sin llamar) |
| 3 — y no bloquea un cambio de ciclo real | › «still lets a NULL cycle move to the other cycle of the same plan» (200, `P-PRO-YEAR`) |
| 3 — sin nada que diga el plan vigente, pasa | › «lets the change through when nothing records the plan in force» |
| 3 — la consulta nueva va acotada por cuenta (CP3) | el primero de los tres afirma `['account_id', ACCOUNT_A]` en **todas** las lecturas de `checkout_intents` |
| 6 — paso 6 del guion (cambio de ciclo con re-aprobación) | `webhook/route.test.ts` › «step 6 — a month→year change is charged as a year, on one subscription» (`UPDATED` a `P-PRO-YEAR` + venta → `cycle: 'year'`, periodo **un año**, **una sola** fila y el mismo `I-1`) |
| 6 — paso 7 del guion (cancelación) | › «step 7 — the CANCELLED event changes nothing the panel already wrote» (`status` sigue `active`, bandera puesta, periodo intacto, intento `cancelled`) |
| 4 y 5 | sin test de runner: el repositorio no tiene jsdom ni testing-library y CP5 prohíbe añadir dependencias (decisión 12). Cubierto por `typecheck` y por el paso 9 del guion manual, que ya los contempla |

Suite: **107** archivos, **1 290** pruebas (ronda 1: 1 276).

### Controles negativos de la ronda 2 (mutación → pruebas que caen)

| Mutación | Pruebas que caen |
| --- | --- |
| `noLongerCharged` vuelve a ser solo `TERMINAL.has(status)` | **6**: las cuatro de adopción de `webhook-events.test.ts` y los dos «step 8» de la ruta |
| el ciclo de la venta vuelve a preferir `existing.cycle` al adoptar | **2**: «charges the new cycle…» y «step 8 — and the payment…» |
| el parche de adopción deja de escribir `cycle` | **2**: las mismas |
| el guardián vuelve a comparar `asCycle(subscription.cycle) === cycle` | **1**: «refuses the plan in force even when the cycle column is NULL» |

### i18n y documentación de la ronda 2 (CP6, CP9)

**Ninguna clave nueva**: los cinco cambios de conducta reutilizan textos que ya existían
(`Billing.adminOnly`, `Billing.lockedBody`, `Billing.subscription.*`). `messages/en.json` y
`messages/ko.json` siguen en **1 559 claves cada uno, conjuntos idénticos** (comprobado
aplanando los dos catálogos: 0 huérfanas en cada lado), y `Billing.adminOnly` está en los
dos. No hay `es.json` en este repositorio.

`CHANGELOG.md` (Unreleased → Fixed) gana tres entradas: la re-contratación tras cancelar y
su ciclo, el cambio al plan que ya está en vigor, y los dos arreglos de la pantalla.
`docs/docker.md` no cambia: la ronda 2 no añade ni renombra variables de entorno.

## Verificación contra base real

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
# … ok 056_subscription_cycle_and_receipts.sql / verify-schema.sql: OK → exit 0
docker exec -i wacrm-migrations-48863 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 < progress/checks_subscription-settings-ui.sql
# BEGIN/DO/ROLLBACK ×4
```

- **Parte A — RLS.** Un `admin` lee sus contadores y **ninguno** de otra cuenta; no puede
  ponerlos a cero (UPDATE 0 filas), ni borrarlos, ni inventarse una fila
  (`insufficient_privilege`); no puede marcar su propia suscripción como cancelada ni cambiar
  su `cycle`; un `agent` de la misma cuenta no ve un solo contador pero sí la fila de
  `subscriptions`; `billing_events` es invisible desde `authenticated`. Y el valor que lee el
  panel es exactamente el que escribió `increment_usage`.
- **Parte B — el periodo del panel es el periodo de los límites.** `increment_usage` ancla en
  `date_trunc('month', now())::date` y la ruta pide `YYYY-MM-01` en UTC; la parte B compara
  las dos expresiones sobre la base real. Si divergieran, el panel mostraría un número y el
  envío se bloquearía por otro, con todos los tests unitarios en verde.
- **Parte C — la 056.** La columna es nullable (NULL = «no se sabe»), el CHECK rechaza
  `'week'`, y la sentencia de backfill rellena desde el intento sin pisar un ciclo ya puesto.
- **Parte D — el índice de recibos.** Existe, es de expresión sobre `billing_agreement_id` y
  es **parcial** sobre `PAYMENT.SALE.COMPLETED`; y el filtro que usa la ruta devuelve la venta
  de la suscripción propia y no la ajena.

### Controles negativos en base real (cada mutación hace fallar su aserción)

| Mutación | Falla con |
| --- | --- |
| política `FOR UPDATE … USING (true)` en `usage_counters` | `a tenant reset 2 of its own usage counters` |
| `DROP CONSTRAINT subscriptions_cycle_check` | `subscriptions.cycle accepted 'week' — the CHECK of migration 056 is missing`; `verify-schema.sql`: `subscriptions_cycle_check is missing (migration 056)` |
| `DROP INDEX billing_events_sale_subscription_idx` | `billing_events_sale_subscription_idx does not exist (migration 056)`; `verify-schema.sql`: `billing_events_sale_subscription_idx is missing (migration 056)` |
| `DROP COLUMN subscriptions.cycle` | `verify-schema.sql`: `subscriptions.cycle is missing or not text (migration 056)` |

Tras el último control, la 056 se reaplicó sobre la base ya migrada (con el índice presente y
la columna ausente) sin efecto adverso — es la comprobación de idempotencia — y
`verify-schema.sql` y las cuatro partes volvieron a pasar.

### Controles negativos del runner (mutaciones en el código, revertidas después)

| Mutación | Pruebas que caen |
| --- | --- |
| recibos sin `.in(…)` (sin ámbito de cuenta) | 1: «lists this account receipts and never another account (leak test)» |
| cancelar escribe también `status: 'cancelled'` | 1: «cancels at PayPal and only flags the end of the cycle» |
| la renovación ignora `subscriptions.cycle` | 2: «renews on the cycle being charged, not the one contracted» y «learns the new billing cycle from the plan the update names (056)» |
| el consumo se recorta al límite | 1: «does NOT clamp the used figure to the limit» |

## Verificación manual pendiente (sandbox de PayPal)

**No se ha ejecutado, y no se puede ejecutar desde aquí:** no hay credenciales de sandbox
de PayPal en este entorno y `.env.local` está bloqueado por permisos. Los nueve pasos
siguen **pendientes de ejecutar por el humano**; los pasos **6, 7 y 8** —los que tocan los
dos defectos de dinero de la revisión— llevan además, desde la ronda 2, un test de ruta que
reproduce la secuencia con mocks (describe «the sandbox script, reproduced with mocks» en
`src/app/api/billing/webhook/route.test.ts`). Lo que el mock **no** puede contestar es qué
hace PayPal de verdad: eso es lo que hay que mirar al correrlo.

Depende de un servicio externo; el cliente HTTP va con mocks. Guion de extremo a extremo,
con `PAYPAL_ENV=sandbox`, el catálogo de f3.1 creado, el webhook de f3.3 apuntando al
despliegue y suscrito a los **seis** eventos de la tabla del spec —
`BILLING.SUBSCRIPTION.UPDATED` incluido, que es el que aplica un cambio de plan — y las
migraciones hasta la **056** aplicadas.

**0 · Preparación.** `NEXT_PUBLIC_SITE_URL` apuntando al despliegue (se congela en el build),
`PAYPAL_CLIENT_ID/SECRET/WEBHOOK_ID` en el entorno de ejecución. Entrar como `owner` o
`admin`.

**1 · Alta.**
1. Ajustes → **Subscription**. Con la cuenta recién creada: plan «Pro», estado «Trial» con la
   fecha de fin de la prueba, próxima fecha de cobro «—», consumo a 0 en las tres métricas y
   «No payments yet». El único botón es **See plans**.
2. Pulsarlo, elegir «Pro» mensual en `/billing`, aprobar con un comprador del sandbox.
3. Volver a Ajustes → Subscription: estado «Active», ciclo «Billed monthly», próxima fecha de
   cobro = `current_period_end`, y **un recibo** con el importe (`79.00 USD`), la fecha y el
   id de transacción de PayPal. Contrastar ese id con el que PayPal muestra en Activity.
4. En la base: `select cycle from subscriptions where account_id = …` → `month`. (Es lo que la
   056 materializa; si sale NULL, el `ACTIVATED` no llegó.)

**2 · Consumo.** Enviar tres mensajes desde la bandeja y recargar el panel: «Outbound
messages» sube exactamente 3. Comparar con
`select value from usage_counters where account_id=… and metric='messages_out' and period_start=date_trunc('month',now())::date`
— **el mismo número**, sin redondeo ni tope. Es el criterio de aceptación; si difieren, la
feature está mal aunque todo lo demás funcione.

**3 · Fallo de pago.** Provocar un cobro fallido (comprador de sandbox sin fondos) o disparar
`BILLING.SUBSCRIPTION.PAYMENT.FAILED` desde el simulador de webhooks. El panel pasa a «Payment
failed» con el texto de gracia y la fecha; la cuenta sigue escribiendo. Pasada la gracia (o
moviendo `grace_until` a mano en la base del sandbox), el panel dice «This account is
read-only» y la propia página **sigue cargando** con sus botones: ese es el punto que hay que
mirar, porque es donde §5 podría encerrar al cliente.

**4 · Suspensión y reactivación.** Suspender la suscripción desde el panel de PayPal →
`BILLING.SUBSCRIPTION.SUSPENDED` → estado «Suspended» y aparece **Resume subscription**.
Pulsarlo: la app responde de inmediato («Asked PayPal to resume…») y **no** cambia el estado.
Comprobar en la base que `subscriptions.status` sigue `suspended` hasta que llega el
`ACTIVATED`/`UPDATED` de PayPal, y que entonces el panel pasa a «Active» solo. (Si el estado
cambiara antes del evento, la regla del spec estaría rota.)

**5 · Cambio de plan — bajada.** Con la suscripción activa en «Pro» mensual, elegir «Inicio»
mensual y **Change plan**. PayPal no debería pedir aprobación al bajar de precio: aviso
«Change requested» y el panel **no** cambia todavía. Al llegar `BILLING.SUBSCRIPTION.UPDATED`
el plan pasa a «Inicio». Verificar en PayPal que **sigue habiendo una sola suscripción**
(mismo `I-…`) y que no hay un segundo cobro.

**6 · Cambio de plan — subida con re-aprobación y cambio de ciclo. → PENDIENTE DE
EJECUTAR POR EL HUMANO.** Lado nuestro cubierto por el test «step 6 — a month→year change
is charged as a year, on one subscription»; lo que falta por confirmar es que PayPal acepte
un `revise` entre planes de distinta frecuencia (deuda 1) y que devuelva enlace de
aprobación al subir de importe. Elegir «Pro» **anual** y
**Change plan**. PayPal devuelve enlace de aprobación: la app avisa y redirige. Aprobar.
1. Al volver, esperar el `UPDATED`: el panel dice «Pro» y «Billed yearly».
2. En la base: `select cycle from subscriptions …` → `year`.
3. **La comprobación que justifica la 056:** dejar (o forzar) que llegue el siguiente
   `PAYMENT.SALE.COMPLETED` y verificar que `current_period_end` avanza **un año**, no un mes.
   Con el intento diciendo todavía `month`, sin la columna esto fallaría y el cliente perdería
   el servicio a las cuatro semanas de pagar un año.

**7 · Cancelación. → PENDIENTE DE EJECUTAR POR EL HUMANO.** Lado nuestro cubierto por el
test «step 7 — the CANCELLED event changes nothing the panel already wrote»; falta
confirmar que el `cancel` de PayPal responde 204 y que el `CANCELLED` llega.

**Cancel subscription** → el diálogo dice hasta qué día hay servicio.
Confirmar.
1. En PayPal, la suscripción queda `CANCELLED` de inmediato.
2. En la base, **antes** de que llegue el evento: `cancel_at_period_end = true`, `status`
   **sigue** `active`, `current_period_end` intacto, `last_event_at` intacto.
3. El panel dice «Cancelled. The service keeps running until …», la próxima fecha de cobro es
   «—» y los botones pasan a **Contract a plan** / **See plans**.
4. Al llegar `BILLING.SUBSCRIPTION.CANCELLED` nada cambia visiblemente: la bandera ya estaba.

**8 · Reactivación tras cancelar. → PENDIENTE DE EJECUTAR POR EL HUMANO.** Es el paso que
destapó el hallazgo 1 de la revisión; lado nuestro cubierto ahora por los dos tests «step 8»
y por el describe `re-contracting after a cancellation` de `webhook-events.test.ts`. Falta
confirmar que PayPal deja crear una segunda suscripción para el mismo comprador mientras la
primera sigue en su ciclo pagado.

Pulsar **Contract a plan** → `/billing` → contratar «Pro»
mensual otra vez y aprobar. Debe funcionar **aunque el estado siga `active`** con el ciclo
viejo sin agotar (es el arreglo de `alreadyContracted`). Al llegar el `ACTIVATED` de la
suscripción nueva, el panel muestra el plan activo sobre el `I-…` nuevo y los recibos listan
**los pagos de las dos** suscripciones, la vieja incluida.

**9 · Permisos.** Con un miembro `agent` de la misma cuenta: la sección **Subscription** no
aparece en el raíl, y `GET /api/billing/subscription` responde 403. Con un `admin` de **otra**
cuenta: sus recibos y su consumo son los suyos y ninguno de los de la primera.

## Decisiones donde el spec era ambiguo

1. **Cambiar de plan = `revise`, no cancelar-y-recontratar.** Razonado arriba. El
   desempate es la palabra «puede» de la tabla del spec: con cancelar-y-recontratar la
   re-aprobación sería obligatoria siempre, no un caso.
2. **Una sola ruta con `action`** en vez de tres. Una puerta de rol, un límite de tasa y un
   sitio donde se lee la suscripción antes de decidir. Las tres acciones comparten
   precondición (qué permite el estado actual), y separarlas la habría triplicado.
3. **`availableActions` es del servidor.** La pantalla no deduce qué botones caben: los
   recibe. Así la interfaz no puede ofrecer un `revise` sobre una suscripción cancelada ni
   esconder la salida de una suspendida, y la tabla de estados se prueba sin navegador.
4. **`suspended` sí se puede cancelar.** Dejar de pagar tiene que ser posible siempre,
   incluso —sobre todo— cuando el servicio está cortado.
5. **El importe del recibo es la cadena de PayPal.** Nada de parsear a float y volver a
   formatear: un recibo que no cuadra carácter a carácter con el extracto bancario es un
   ticket de soporte. La moneda se imprime al lado, sin convertir (se factura en dólares, dice
   el spec).
6. **El enlace del recibo solo si es de cara al cliente.** Los `links` de un `sale` son casi
   todos endpoints de API (`self`, `refund`) que exigen token OAuth y filtran nuestra base de
   API. Se toma solo `rel` `receipt`/`invoice`, solo `https`, solo en `paypal.com` o
   subdominio. En la práctica hoy suele no haber ninguno y la columna queda vacía: es la
   verdad, no un fallo.
7. **Los recibos se buscan por `billing_agreement_id`, no por una columna nueva.** La
   alternativa era añadir `account_id` a `billing_events`, lo que obligaría al webhook a
   escribirlo y dejaría NULL en todas las filas históricas. El índice de expresión de la 056
   da lo mismo sin tocar el contrato de la bitácora.
8. **El consumo mostrado son solo las métricas de flujo.** `usage_counters` solo tiene esas
   tres; los topes de existencias (`operators`, `numbers`, `knowledge_documents`) son un
   recuento de filas *ahora* y pintarlos aquí con un cero sería mentira. Lo dice la cabecera
   de `enforce.ts` y este módulo lo respeta.
9. **Una métrica sin tope se muestra igual**, con el número y sin barra. Es consumo real y
   esconderlo haría que el panel discrepara de la factura.
10. **El consumo no se recorta al límite.** Estar por encima es un estado alcanzable (un
    downgrade baja el tope con el contador ya corrido) y es justo cuando el cliente necesita
    ver el número de verdad para entender por qué no sale nada.
11. **`adminOnly` en el raíl de Ajustes.** La interfaz de `SectionMeta` ya lo prometía en su
    docstring y no existía. Se implementa solo para esta sección; `members` y `api` siguen
    como estaban (cambiarlas sería alcance ajeno). La puerta de verdad son `RequireRole` en el
    panel y `requireRole('admin')` en la ruta: el raíl solo deja de anunciar una puerta que no
    abre.
12. **El panel no tiene test de runner.** El repositorio no tiene jsdom ni testing-library y
    CP5 prohíbe añadir dependencias; los tests de componentes existentes usan
    `renderToStaticMarkup`, que no ejecuta efectos y aquí no probaría nada. Queda cubierto por
    `typecheck`, por la lógica extraída a `subscription-view.ts` (que sí se prueba entera) y
    por el guion manual. Es el mismo criterio que aceptó f3.2 para `plan-picker.tsx`.
13. **El sandbox no se declara hecho por no poder hacerse.** El cambio 6 pedía correr los
    pasos 6, 7 y 8 contra PayPal. Sin credenciales de sandbox y con `.env.local` bloqueado
    por permisos, la única salida honesta era dejarlos pendientes del humano y sustituir lo
    que sí está de nuestro lado por tests de ruta con mocks. Declararlos ejecutados habría
    sido la clase de afirmación que esta revisión existe para cazar.
14. **El guardián de plan, cuando no se sabe, deja pasar.** `providerPlanIdInForce()`
    devuelve `null` si ni el ciclo ni el intento dicen qué se está cobrando. La alternativa
    —refusar por si acaso— dejaría a esas cuentas sin poder cambiar de plan desde la
    aplicación, que es peor que un `revise` redundante: PayPal contesta a un revise al mismo
    plan sin cobrar nada.
15. **La adopción se decide por «ya no se cobra», no por «está cancelada».** El estado
    `cancelled` y la bandera `cancel_at_period_end` son dos caminos al mismo hecho; el que
    importa para no cobrar dos veces es si esa suscripción de PayPal puede volver a cobrar,
    y una cancelada en PayPal no puede. Por eso la regla se escribe sobre esa pregunta y no
    sobre la lista de estados.

## Variables de entorno

**Ninguna nueva.** Se reutilizan `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`
(f3.1), `PAYPAL_WEBHOOK_ID` (f3.3) y `NEXT_PUBLIC_SITE_URL` (f3.2, ahora también para la URL
de retorno de una re-aprobación de `revise`). Documentado en la sección «Subscription area»
de `docs/docker.md`, junto con el aviso de que `BILLING.SUBSCRIPTION.UPDATED` no es opcional.

**`.env.local.example` está bloqueado por permisos y no se tocó.** Siguen pendientes para el
humano, de features anteriores: `PAYPAL_WEBHOOK_ID`, `META_WEBHOOK_VERIFY_TOKEN` y
`ENCRYPTION_KEY_PREVIOUS`.

## CP7 — Next 16

`GET()` sin argumentos y `POST(request: Request)` son la firma documentada en
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:9,31`. El
panel es `'use client'` con `useRouter` de `next/navigation`, como el resto de Ajustes; no
usa `useSearchParams`, así que no necesita frontera de `Suspense` propia (la página ya la
tiene). El build confirma `ƒ /api/billing/subscription` y `/settings` sigue prerenderizándose.

## Compuerta

Ronda 2 (`adf72a0`), ejecutada entera:

| Comando | Resultado |
|---|---|
| `npm run lint` | 0 errores, **37** avisos — exactamente la línea base, ninguno en archivos de esta feature |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 107 archivos, **1 290** pruebas |
| `npm run build` (variables dummy de CI) | `✓ Compiled successfully`; `ƒ /api/billing/subscription`, `/settings` estático |
| `scripts/replay-migrations.sh "$(pwd)"` | **no re-ejecutado**: la ronda 2 no toca una línea de SQL (la 056 y `verify-schema.sql` quedan idénticas a `4cd94a4`, que sí lo pasó con salida 0 y `verify-schema.sql: OK`, y el revisor lo repitió) |

`npx prettier --write` sobre los archivos de la feature (`webhook-events.ts` y su test, las
dos rutas y sus tests, `subscription-panel.tsx`) — todos ya limpios salvo el panel. **Sin
prettier** sobre `settings-rail.tsx`, `settings-sections.ts` y `settings/page.tsx`: ese es
el cambio 7 (ver ronda 2), y pasarlo volvería a reformatear líneas ajenas a §6. `CHANGELOG.md` y
`docs/docker.md` ya estaban sucios para prettier antes de este cambio (deuda anotada en f3.2 y
f3.3); solo se editaron a mano los párrafos propios.

## Deuda detectada fuera de alcance (no arreglada)

1. **`revise` y el ciclo: sin confirmación de PayPal en el sandbox.** No se ha podido
   contrastar contra PayPal real que `revise` acepte mover una suscripción entre planes de
   **distinta frecuencia** (mensual ↔ anual) dentro del mismo producto. La documentación
   permite revisar a otro plan del mismo producto y no dice lo contrario, y el código está
   preparado para las dos respuestas; pero si PayPal lo rechazara, el 502 lo diría y habría que
   restringir el selector de ciclo. **Es el paso 6 del guion manual y es el que más importa.**
2. **Dos eventos simultáneos de la misma cuenta.** El cerrojo de `billing_events` serializa
   *el mismo* evento, no dos distintos. Ya estaba anotado en `impl_paypal-webhook.md` (deuda
   2) y esta feature no lo cambia; el cambio de plan añade una fuente más de eventos casi
   simultáneos (`UPDATED` + `SALE.COMPLETED`), así que el riesgo sube un poco. Un `UPDATE`
   condicional por `last_event_at` lo cerraría.
3. **Un `revise` abandonado no deja rastro.** Si el cliente no aprueba, no hay fila que diga
   «pidió cambiar a Negocio anual y no terminó»: la interfaz sigue mostrando el plan actual,
   que es correcto, pero no hay forma de contar cuántos cambios se abandonan. Una columna
   `pending_plan_id` en `subscriptions`, o reutilizar `checkout_intents` con otra forma, sería
   una feature propia.
4. **Los recibos no incluyen reembolsos.** `PAYMENT.SALE.REFUNDED` se guarda en
   `billing_events` (f3.3 lo acepta como evento fuera de la tabla) pero no se pinta, así que un
   cliente reembolsado ve el cobro y no la devolución. §6 pide «recibos», no un estado de
   cuenta; añadirlo es alcance nuevo.
5. **El panel no pagina los recibos.** Se muestran los 24 últimos (dos años de renovación
   mensual). A partir de ahí hay que consultar PayPal.
6. **`contacts` sigue sin punto de aplicación.** El tope existe en `plans.limits` y §4 no
   listaba dónde aplicarlo; el panel tampoco lo muestra porque no está en `usage_counters`.
   Anotado ya en la cabecera de `enforce.ts`.
7. **`middleware.ts` está deprecado en Next 16** a favor de `proxy.ts`; el build lo delata con
   `ƒ Proxy (Middleware)`. Preexistente y transversal, ya anotado en f3.2 y f3.3. Esta feature
   **no** tocó `middleware.ts`: la sección vive dentro de `/settings`, que ya estaba protegida.
8. **`members` y `api` siguen visibles en el raíl para cualquier miembro.** Sus paneles se
   gatean por dentro, así que no es una fuga, pero la bandera `adminOnly` que esta feature
   implementa les vendría bien. Fuera de §6.
9. **Tres archivos de Ajustes sucios para prettier.** `settings-rail.tsx`,
   `settings-sections.ts` y `src/app/(dashboard)/settings/page.tsx` vienen de una
   configuración anterior de prettier (comas finales de argumento, clases de Tailwind sin
   ordenar) y así se quedan tras revertir el reformateo del cambio 7. No afecta a la
   compuerta —`npm run lint` no corre prettier— pero cualquiera que ejecute
   `npm run format` los va a mover enteros. Formatearlos es un commit de estilo propio,
   ajeno a §6.
10. **El ciclo vigente no se puede confirmar contra PayPal.** `providerPlanIdInForce()`
   deduce el plan en vigor de nuestros propios registros; la fuente autoritativa sería un
   `GET /v1/billing/subscriptions/{id}` a PayPal. No se añade: sería una llamada de red más
   en el camino de cambiar de plan y f3.5 no la necesita para ser correcta (cuando no se
   sabe, el `revise` pasa). Si algún día se quiere el 409 exacto para toda fila, eso es lo
   que hay que llamar.

