# Implementación: f3.2 `checkout-flow`

- **Rama:** `saas/fase-3-facturacion` (worktree `.claude/worktrees/fase-3`, base `d44d68e`)
- **Commits:** `aec16df` — `feat: contratar un plan con PayPal sin activar en el retorno`;
  `e564f47` — `fix: no romper la aceptación de invitaciones ni fallar abierto en el checkout`
  (corrección de los seis cambios requeridos de `progress/review_checkout-flow.md`)
- **Spec:** `docs/saas/fase-3-facturacion.md` §2 «Contratación» (+ «Lo que PayPal no
  hace», criterios de aceptación y variables de entorno)
- **Estado:** corregido tras CHANGES_REQUESTED, listo para re-revisión

## Qué hace

1. `/billing` lista el catálogo público y deja a un `admin`+ elegir plan y ciclo.
2. `POST /api/billing/checkout` crea la suscripción en PayPal con el cliente de f3.1,
   usando `plans.provider_plan_id_month/_year`, y devuelve el enlace de aprobación.
3. La intención de contratación (cuenta, plan, ciclo, id de suscripción de PayPal, id
   de plan del proveedor, quién la lanzó) queda en la tabla nueva `checkout_intents`.
4. `/billing/return` **solo informa** («estamos confirmando tu pago») y sondea
   `GET /api/billing/checkout`, que es de solo lectura. Cuando el webhook de f3.3
   active la suscripción, la página lo refleja sola.

Lo que **no** hace, a propósito: no toca `subscriptions`, no procesa eventos, no
aplica límites y no cambia de plan (f3.3, f3.4 y f3.5).

## Archivos

| Archivo | Qué es |
| --- | --- |
| `supabase/migrations/048_checkout_intent.sql` | tabla `checkout_intents` + RLS (SELECT admin+, cero políticas de escritura) |
| `supabase/migrations/049_redeem_invitation_checkout_intents.sql` | `CREATE OR REPLACE redeem_invitation()`: los intentos `pending` se van con la cuenta personal, los demás la hacen «no vacía» |
| `supabase/ci/verify-schema.sql` | 6 aserciones de 048 + 1 de 049 |
| `src/lib/billing/paypal.ts` | `createSubscription` y `approvalLink` |
| `src/lib/billing/checkout.ts` | decisiones puras: ciclo válido, id de plan del proveedor, precio, «ya contratado», clave de idempotencia, URLs de retorno, origen de la app |
| `src/app/api/billing/checkout/route.ts` | `POST` (contratar) y `GET` (estado, solo lectura) |
| `src/app/api/billing/plans/route.ts` | catálogo para el selector, con los ids de PayPal convertidos en banderas |
| `src/components/billing/plan-picker.tsx`, `checkout-return.tsx` | las dos pantallas |
| `src/app/(dashboard)/billing/page.tsx`, `return/page.tsx` | páginas (Suspense por `useSearchParams`) |
| `src/middleware.ts` | `/billing` añadido a `protectedPaths` |
| `messages/en.json`, `messages/ko.json` | espacio `Billing` (**26** claves, misma forma en los dos; el informe original decía 28) |

## Criterio ↔ prueba

Criterios de §2 y los del documento que caen en esta feature:

| Criterio | Prueba |
| --- | --- |
| El cliente elige plan y el backend crea la suscripción con los `provider_plan_id_*` | `src/app/api/billing/checkout/route.test.ts` › «creates the PayPal subscription and hands back its approval link» (afirma `planId: 'P-PRO-YEAR'`) |
| Se devuelve el enlace de aprobación | mismo test (`approvalUrl`) + `src/lib/billing/paypal.test.ts` › «posts the plan with our correlation id and returns the approval link» |
| **La URL de retorno no activa nada** | `route.test.ts` › «activates nothing by being called» (dos llamadas: todas las consultas son `select`, `subscriptions` sigue vacía, el intento sigue `pending`) y › «exposes only POST and GET» |
| El checkout tampoco activa | `route.test.ts` › «does not touch subscriptions — only the webhook activates» |
| Cerrar el navegador tras aprobar no pierde el pago | la intención queda registrada antes de que el cliente vuelva: `route.test.ts` › «records the intent so the webhook can match the event to a tenant»; el `custom_id = account_id` viaja en la suscripción (`paypal.test.ts` › «posts the plan with our correlation id…») |
| Toda consulta de rol de servicio filtra por `account_id` (CP3) | `route.test.ts` › «ignores an account_id supplied by the caller», › «keeps two accounts checking out at once apart», › «never shows another account its checkout», › «reuses the intent when PayPal replays…» (afirma el filtro también en la lectura de recuperación) |
| Fuga entre cuentas en base real (RLS) | `progress/checks_checkout-flow.sql` parte A |
| Un ciclo sin plan en PayPal no rompe | `route.test.ts` › «409s when the catalogue has no PayPal plan for that cycle»; `checkout.test.ts` › «treats a missing or blank id as "not contractable yet"» |
| Sin prorrateo: no se abre una segunda suscripción | `route.test.ts` › «409s instead of opening a second paid subscription» y › «lets a trialing account contract»; `checkout.test.ts` › describe `alreadyContracted` (3 tests) |
| Doble clic = una sola suscripción y un solo cobro | `checkout.test.ts` › «is stable inside a ten-minute window and changes after it»; `route.test.ts` › «reuses the intent when PayPal replays a subscription we already stored»; unicidad en base real: `checks_checkout-flow.sql` parte B |
| Solo `admin`+ contrata | `route.test.ts` › «refuses a caller below admin» (POST y GET); en base real, la política admin+ (parte A, el caso del `agent`) |
| Los ids de PayPal no llegan al navegador | `src/app/api/billing/plans/route.test.ts` › «never puts a PayPal plan id on the wire» y › «reports which cycles can actually be contracted» |
| Un fallo del proveedor no inventa una contratación | `route.test.ts` › «reports a PayPal refusal as a gateway error and writes nothing»; `paypal.test.ts` › «rejects a subscription that came back without an approve link», › «surfaces a PayPal refusal instead of inventing a subscription» |
| Una intención que no se puede registrar no entrega enlace | `route.test.ts` › «fails closed when the intent cannot be recorded» |

Suite completa tras la corrección: 88 archivos, **937** pruebas (49 nuevas).

## Verificación contra base real

`progress/checks_checkout-flow.sql`, ejecutado contra el Postgres del harness:

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
docker exec -i wacrm-migrations-37804 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 < progress/checks_checkout-flow.sql
# BEGIN/DO/ROLLBACK ×4
```

- **Parte A — RLS.** Un `admin` lee sus intentos y **ninguno** de otra cuenta (incluida
  la búsqueda por `provider_subscription_id`, que es la que hace la página de retorno);
  un `agent` de la misma cuenta no lee ninguno (es dato de facturación, admin+); INSERT
  desde `authenticated` da `insufficient_privilege` y UPDATE/DELETE afectan 0 filas.
  El `service_role` sí puede insertar: es el único escritor y la ruta depende de ello.
- **Parte B — unicidad.** Un id de suscripción de PayPal repetido choca, lo intente la
  misma cuenta (reintento) o **otra** (reclamar el pago ajeno). Otro `provider` es otro
  espacio de nombres.
- **Parte C — borrado.** `ON DELETE RESTRICT` impide que borrar una cuenta se lleve por
  delante su rastro de contratación; que se vaya el miembro que contrató deja
  `created_by` en NULL y la fila en pie.
- **Parte D — significado de la fila.** `status` nace `pending`, `provider` nace
  `paypal`, un ciclo `week` y un `status` inventado se rechazan por CHECK, un plan que
  no está en el catálogo se rechaza por FK, y el trigger de `updated_at` dispara.

**Controles negativos ejecutados** (todos hacen fallar la aserción correspondiente):

| Mutación | Falla con |
| --- | --- |
| política `FOR INSERT/SELECT … USING (true)` en `checkout_intents` | `a tenant read 1 checkout intent(s) of another account` |
| `DROP CONSTRAINT checkout_intents_provider_subscription_key` | `a replayed PayPal subscription id created a second intent` |
| FK de `account_id` a `ON DELETE CASCADE` | `deleting an account silently removed its checkout intents` |
| política de escritura + `verify-schema.sql` | `checkout_intents has a write policy — only the service role may write it (migration 048)` |
| `DROP INDEX checkout_intents_account_created_idx` + `verify-schema.sql` | `checkout_intents_account_created_idx is missing (migration 048)` |

También se comprobaron por mutación las dos pruebas de fuga del runner: quitar el
`.eq('account_id', …)` del `GET` y dejar que el cuerpo fije el `account_id` del insert
rompen «never shows another account its checkout» y «ignores an account_id supplied by
the caller» respectivamente.


## Corrección tras CHANGES_REQUESTED (`progress/review_checkout-flow.md`)

Los seis cambios requeridos, con las decisiones que dio el líder.

### 1 · La FK `RESTRICT` rompía `redeem_invitation()` (bloqueante)

Se **mantiene** el `ON DELETE RESTRICT` de 048 y se arregla la función, en
`supabase/migrations/049_redeem_invitation_checkout_intents.sql`
(`CREATE OR REPLACE`, idempotente, cuerpo de 019 reproducido con dos cambios):

- la comprobación de «cuenta vacía» gana
  `UNION ALL SELECT 1 FROM checkout_intents WHERE account_id = … AND status <> 'pending'`:
  un intento que el webhook ya movió (`activated`/`cancelled`) significa que hubo una
  suscripción de verdad, así que cuenta como dato y la invitación se rechaza con 23505,
  exactamente igual que si hubiera contactos;
- antes del `DELETE FROM accounts` se borran los intentos `pending` de esa cuenta: una
  aprobación abandonada no vale nada (no hay cobro; PayPal deja caducar la suscripción en
  `APPROVAL_PENDING`) y el `RESTRICT` obliga a que el borrado sea explícito.

`041_billing_model.sql` **no se toca**: en esta rama todavía declara sus dos FK con
`ON DELETE CASCADE`, pero la fase 0 ya las pasó a `RESTRICT` (`324f087` en
`saas/fase-0-cimientos`) y el cambio llegará por merge. El comentario de 048 que daba ese
precedente por hecho se corrigió para decir justo eso, y para dejar escrito que el único
flujo del producto que borra cuentas es `redeem_invitation()`.

`verify-schema.sql` gana la aserción de que `prosrc` de `redeem_invitation(text)` menciona
`checkout_intents`: si una migración futura reemplaza la función y se olvida de la cláusula,
CI lo ve antes de que un cliente se quede fuera de su equipo.

### 2 · `POST` fallaba abierto ante un error leyendo `subscriptions`

`loadSubscription()` ya no devuelve `null` cuando la consulta falla: lanza
`SubscriptionReadError`, que el `catch` de la ruta convierte en 500 vía `toErrorResponse`.
Ocurre **antes** de llamar a PayPal, así que un error de lectura no puede abrir una segunda
suscripción. El `GET` hereda el mismo trato (500 en vez de «no hay suscripción»); la página
de retorno ya trata `!res.ok` como «sigo esperando», así que no cambia de comportamiento.

### 3 · `activated` sin intento que lo respaldara

Cuando el `GET` recibe `subscription_id`, ahora exige intento coincidente
(`matchesAttempt = intent ? sub.provider_subscription_id === intent.provider_subscription_id
: !subscriptionId`). Sin `subscription_id` se mantiene la semántica anterior: se responde
sobre el último intento de la cuenta, y una cuenta con suscripción activa y ningún intento
registrado está legítimamente activa.

### 4 · El `fetch` del catálogo podía rechazar sin recogerse

`load()` de `plan-picker.tsx` envuelve `fetch` + `res.json()` en `try/catch` y da a un
rechazo el mismo trato que a `!res.ok` (`toast.error` + `setPlans([])`), en lugar de dejar
el spinner girando para siempre. Efecto colateral: el `eslint-disable-next-line
react-hooks/set-state-in-effect` del `useEffect` quedó **sin usar** (la regla ya no dispara
porque el `setState` vive dentro del `catch`) y se quitó; el recuento de avisos de `lint`
vuelve a ser exactamente el de la línea base, 37.

### 5 · El id del plan en vez de su nombre

El `GET` devuelve `subscription.planName` (una lectura extra de `plans` por `id`; el
catálogo es público, no necesita ámbito de cuenta) y `checkout-return.tsx` lo usa en
`Billing.return.activeBody` con fallback al id. **No hubo cambio de claves i18n**: el
marcador `{plan}` ya existía en los dos catálogos y ahora recibe «Pro» en vez de «pro»;
`en.json` y `ko.json` siguen con las mismas 26 claves y la misma forma.

### 6 · Informe

Corregido el recuento (26 claves, no 28) y anotada la deuda de `middleware.ts` → `proxy.ts`
(abajo, sin tocar el archivo).

### Pruebas nuevas de la corrección

| Cambio | Prueba |
| --- | --- |
| 1 — invitación con intento abandonado | `progress/checks_checkout-flow.sql` **parte E**, contra el Postgres del harness |
| 1 — invitación con intento no pendiente | misma parte E (tercer escenario, exige 23505) |
| 1 — la aserción de CI | `supabase/ci/verify-schema.sql` (ver control negativo abajo) |
| 2 — fallar cerrado | `route.test.ts` › «500s instead of contracting when the subscription cannot be read» (afirma `createSubscription` **no** llamado y cero intentos) |
| 3 — intento coincidente | `route.test.ts` › «does not call an attempt we never recorded activated» |
| 5 — nombre del plan | `route.test.ts` › «reports the plan by name, not by id» |

Las tres pruebas de runner son detectoras: revertidos los tres cambios de `route.ts` a la
vez, `3 failed | 22 passed`; con el código corregido, 25/25.

El cambio 4 es de interfaz y **no lleva test**: el repositorio no tiene jsdom ni
testing-library (los tests de componentes existentes usan `renderToStaticMarkup`, que no
ejecuta efectos) y CP5 prohíbe añadir dependencias. Queda cubierto por `typecheck`, por la
lectura del diff y por el paso 11 del guion manual.

## Verificación contra base real de la corrección

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
# … ok 048_checkout_intent.sql / ok 049_redeem_invitation_checkout_intents.sql
# verify-schema.sql: OK   → exit 0
docker exec -i wacrm-migrations-48986 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 < progress/checks_checkout-flow.sql
# BEGIN/DO/ROLLBACK ×5
```

**Parte E — aceptar una invitación con un checkout abandonado detrás.** Tres escenarios en
la misma transacción: control sin intento (se acepta, la cuenta personal desaparece);
intento `pending` (se acepta, la fila se va con la cuenta, la invitación queda sellada y el
perfil se mueve al equipo); intento `activated` (23505, la cuenta y el intento siguen en pie
y la invitación **no** se marca aceptada).

**Controles negativos ejecutados** (los dos reproducen el fallo esperado):

| Mutación | Falla con |
| --- | --- |
| reaplicar 019 sobre la base migrada (deshace 049) | `an abandoned checkout blocked the invitation: 23503 update or delete on table "accounts" violates foreign key constraint "checkout_intents_account_id_fkey"` — exactamente el 23503 que reprodujo el reviewer |
| ídem, con `verify-schema.sql` | `redeem_invitation() does not handle checkout_intents; the RESTRICT FK of 048 will break invitation redemption (migration 049)` |
| 049 mutada para borrar **todo** intento (no solo los `pending`) | `an account with an activated checkout was dissolved by accepting an invitation` |

049 se aplicó tres veces seguidas sobre la misma base sin efecto adverso (`CREATE OR
REPLACE`); tras restaurarla, las cinco partes y `verify-schema.sql` vuelven a pasar.

## Compuerta de la corrección

- `npm run lint` — 0 errores, 37 avisos (la línea base exacta; el aviso 38 que introdujo la
  corrección se eliminó quitando el `eslint-disable` muerto).
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — 88 archivos, **937** pruebas.
- `npm run build` con las variables dummy de CI — `Compiled successfully`; `/billing` y
  `/billing/return` siguen prerenderizándose.
- `scripts/replay-migrations.sh "$(pwd)"` — salida 0 con 048 **y** 049,
  `verify-schema.sql: OK`.

## Verificación manual pendiente (PayPal real)

No se llamó a PayPal: exige credenciales y crea recursos que cobran. Guion contra el
sandbox, con el catálogo de f3.1 ya creado:

1. Aplicar 041, 045 y **048** a la base del entorno de pruebas.
2. `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` y
   `NEXT_PUBLIC_SITE_URL=<url del despliegue>` (esta última **en el build**, ver
   `docs/docker.md`). Arrancar la app.
3. Entrar como `owner` o `admin`, ir a `/billing`, elegir «Pro» mensual → el navegador
   acaba en PayPal con el plan y el precio correctos y la marca `wacrm`.
4. En la base: una fila en `checkout_intents` con `status = 'pending'`, el `plan_id`,
   el `cycle`, el `provider_plan_id` y el `provider_subscription_id` (`I-…`) que PayPal
   muestra en la URL. **`subscriptions` no ha cambiado.**
5. Aprobar con un comprador del sandbox → se vuelve a `/billing/return?subscription_id=I-…`
   y la página dice «estamos confirmando tu pago». Comprobar que **sigue sin haber
   cambio en `subscriptions`** (el webhook es f3.3; hasta que exista, la página se
   quedará en «still confirming» a los 2,5 min, que es la verdad).
6. **La trampa:** abrir a mano `…/billing/return?subscription_id=I-…` con otra sesión
   admin de **otra** cuenta → la página no muestra el intento ajeno y no activa nada;
   `GET /api/billing/checkout?subscription_id=I-…` responde `intent: null`.
7. Cancelar en PayPal en vez de aprobar → se vuelve a `/billing?checkout=cancelled` con
   el aviso «nada se ha cobrado»; la intención queda `pending` (la limpieza de intentos
   abandonados es de f3.3).
8. Doble clic en «Elegir plan» (o recargar y repetir antes de 10 minutos) → PayPal
   devuelve **la misma** `I-…` y `checkout_intents` sigue teniendo una sola fila.
9. Un miembro `agent` en `/billing` ve el catálogo pero no el botón, y
   `POST /api/billing/checkout` le responde 403.
10. Cuando f3.3 exista, repetir el paso 5 y comprobar que la página pasa sola a «tu
    plan está activo» **con el nombre del plan** («Pro», no «pro») y sin recargar.
11. **Corrección, hallazgo 4:** en `/billing`, con las herramientas del navegador en modo
    sin conexión (o cortando la red), recargar la página → aparece el aviso «Failed to load
    the plans» y la lista queda vacía, en vez del spinner infinito. Volver a poner la red y
    recargar restaura el catálogo.
12. **Corrección, hallazgo 1:** con un usuario nuevo que ha pulsado «Elegir plan» y ha
    cerrado PayPal sin aprobar (fila `pending` en `checkout_intents`), aceptar una
    invitación a otra cuenta → entra en el equipo y su fila `pending` desaparece con su
    cuenta personal. Ya está cubierto en base real por la parte E; el paso manual solo
    comprueba que la ruta `POST /api/invitations/[token]/redeem` devuelve 200 y no un 500
    con el 23503 en el log.

## Decisiones donde el spec era ambiguo

- **Tabla nueva en vez de columnas en `subscriptions`.** El spec exige que el checkout
  no active; escribir `provider_subscription_id` en `subscriptions` durante el checkout
  habría dejado huella (y colisionado con su `UNIQUE`) en la fila que decide si la
  cuenta tiene servicio. `checkout_intents` es un registro aparte que el webhook lee.
- **Escritura solo por rol de servicio.** Si un inquilino pudiera insertar en
  `checkout_intents` reclamaría la suscripción de otro (o el plan Negocio pagando el
  Inicio). Por eso RLS con solo SELECT (admin+) y una aserción en `verify-schema.sql`
  que falla si alguien añade una política de escritura.
- **`custom_id = account_id`.** PayPal devuelve `custom_id` en el recurso de cada
  evento, así que f3.3 tiene dos caminos para resolver la cuenta (la intención y el
  propio evento) y ninguno depende de la redirección.
- **`provider_plan_id` guardado en la intención.** Deja a f3.3 contrastar el `plan_id`
  del evento con el que se contrató: si no coinciden, el cliente aprobó otra cosa.
- **Idempotencia por ventana de 10 minutos** (`checkoutRequestId`). PayPal reproduce la
  respuesta de un `PayPal-Request-Id` repetido; el bucket convierte el doble clic en una
  sola suscripción. Con ventana infinita, un cliente que cancela y quiere volver a
  contratar se quedaría atrapado en la suscripción vieja.
- **`admin`+ para contratar y para leer el estado.** El spec pone el área de suscripción
  (§6) en `admin`+; contratar gasta dinero, así que la misma puerta. El catálogo
  (`/api/billing/plans`) sí es de cualquier miembro: no es secreto.
- **Bloquear una segunda contratación** cuando ya hay suscripción `active`/`past_due`/
  `suspended` con id de proveedor. PayPal no cambia de plan en sitio; abrir otra
  suscripción sería un segundo cobro. `trialing`, `cancelled` y `expired` sí pueden
  contratar.
- **Fallar cerrado si no se puede registrar la intención**: se devuelve 500 sin enlace.
  La suscripción queda `APPROVAL_PENDING` en PayPal y caduca sin cobrar; entregar un
  enlace que luego no se puede conciliar es peor.
- **La página de retorno sondea** cada 4 s durante 2,5 min y luego dice «seguimos
  confirmando». El spec dice «la interfaz se actualiza sola»; sondear es lo más simple
  que no requiere realtime ni tocar `subscriptions`.
- **Qué significa un intento al disolver una cuenta (049).** El spec no dice nada de la
  interacción entre `checkout_intents` y `redeem_invitation()`. La línea que se trazó, por
  decisión del líder: `pending` es basura (una aprobación abandonada, sin cobro) y se borra
  con la cuenta; cualquier otro estado lo puso el webhook y por tanto es dato contable, así
  que hace que la cuenta «no esté vacía» y la invitación se rechace con el mismo 23505 y el
  mismo mensaje que usan contactos o difusiones. La alternativa —aflojar la FK a `SET NULL`
  o `CASCADE`— habría convertido borrar una cuenta en una forma silenciosa de perder el
  rastro de facturación, que es justo lo que 041 y 048 evitan.
- **El nombre del plan lo resuelve el servidor.** `GET` hace una lectura extra de `plans`
  en vez de que el cliente cargue el catálogo entero en la página de retorno: es una fila
  por sondeo, cacheable, y evita añadir a `/billing/return` una dependencia del endpoint de
  catálogo que no necesita para nada más.
- **Sin entrada de navegación a `/billing`.** El enlace natural es el área de
  suscripción de Ajustes, que es f3.5; añadirlo ahora pisaría esa feature. La página es
  accesible por URL y `middleware.ts` la protege.

## Variables de entorno

Ninguna nueva. Se usan las de f3.1 (`PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`,
`PAYPAL_ENV`) y **`NEXT_PUBLIC_SITE_URL`**, que ya existía para los enlaces de
invitación y ahora también fija la URL de retorno; documentado en la sección
«Checkout (`/billing`)» de `docs/docker.md`, incluido el detalle de que al ser
`NEXT_PUBLIC_*` se congela en el build (confirmado en
`node_modules/next/dist/docs/01-app/02-guides/environment-variables.md:164`).
`PAYPAL_WEBHOOK_ID` sigue siendo de f3.3.

`.env.local.example` está bloqueado por permisos y **no se tocó**.

## Compuerta

Ejecutada en el worktree de fase 3:

- `npm run lint` — 0 errores, 37 advertencias preexistentes (ninguna en archivos nuevos).
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — 88 archivos, 934 pruebas.
- `npm run build` con las variables dummy de CI — correcto; `/billing` y
  `/billing/return` se prerenderizan.
- `scripts/replay-migrations.sh "$(pwd)"` — salida 0, `verify-schema.sql: OK` con 048.

## Deuda detectada fuera de alcance (no corregida)

- **`NEXT_PUBLIC_SITE_URL` se congela en el build.** Una imagen promovida entre
  entornos lleva la URL del entorno donde se construyó. Lo correcto sería una variable
  de servidor (`APP_BASE_URL`) leída en tiempo de ejecución, pero eso cambia también el
  flujo de invitaciones y `docker-compose.yml`: es un cambio transversal, no de §2.
  Mientras tanto el fallback por cabeceras cubre el caso.
- **Resolución del origen duplicada.** `resolveAppOrigin` (checkout) y `getBaseUrl`
  (`src/app/api/account/invitations/route.ts:94`) hacen casi lo mismo con criterios
  distintos (la de invitaciones tiene lista blanca `ALLOWED_INVITE_HOSTS` y un fallback
  al dominio de marketing). Unificarlas toca una ruta ajena a esta feature.
- **Hallazgo 8 de la revisión de f3.1** (nada ata `provider_plan_id_*` al precio con el
  que se creó el plan) sigue abierto: esta feature no re-siembra precios, así que no
  añadió la restricción `UNIQUE` ni el `NULL` en re-siembra que el reviewer sugería para
  f3.2. Si el líder quiere cerrarlo, es una migración propia.
- **Hallazgos 2, 3, 4, 5, 6 y 7 de la revisión de f3.1** (endurecer `PAYPAL_ENV`,
  registrar el id antes de persistirlo, aviso simétrico sandbox/live, precio `<= 0` en el
  bootstrap, desfase de uno en el tope de páginas, cabecera no-ASCII) siguen sin tocar:
  viven en `scripts/paypal-bootstrap-catalog.ts` y en `listProducts`, que son f3.1.
  El precio `<= 0` sí se filtra **en el checkout** (`priceFor`).
- **`CHANGELOG.md` y `docs/docker.md` no cumplen prettier** ya en `main` (comprobado
  guardando mis cambios: los dos archivos fallan `prettier --check` igual antes y
  después). Solo se editaron a mano los párrafos propios; formatearlos reescribiría
  entradas viejas enteras.
- **Intentos abandonados.** Un cliente que no aprueba deja la fila en `pending` para
  siempre. Caducarlas (o marcarlas `cancelled` con el evento correspondiente) es del
  manejador de eventos, f3.3. 049 solo cubre el caso en que esa cuenta se disuelve al
  aceptar una invitación.
- **`middleware.ts` está deprecado en Next 16** a favor de `proxy.ts`
  (`node_modules/next/dist/docs/01-app/02-guides/upgrading/version-16.md:625-648`: «The
  `middleware` filename is deprecated… The named export `middleware` is also deprecated»),
  y el build lo delata imprimiendo `ƒ Proxy (Middleware)`. Es **preexistente** y
  transversal: renombrar el archivo y su export afecta a todas las rutas protegidas del
  producto, no a §2. Esta feature solo añadió una línea a `protectedPaths`; el renombrado
  merece su propio `chore:`. Anotado a petición del reviewer (hallazgo 6, CP7).
- **Borrar una cuenta a mano.** Fuera de `redeem_invitation()` no hay flujo de producto que
  borre `accounts`, así que el `RESTRICT` no molesta hoy; el día que exista «dar de baja la
  cuenta» tendrá que limpiar `checkout_intents`, `subscriptions` y `usage_counters` a
  propósito, como ya dice la cabecera de 041 en la rama de fase 0.
