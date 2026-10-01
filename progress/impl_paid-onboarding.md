# s9.6 — `paid-onboarding`

## Plan (antes de tocar código)

1. Migración `073_no_trial.sql`: CHECK de `subscriptions.status` con `incomplete`; default de la
   columna a `incomplete`; `seed_account_trial()` siembra `inicio`/`incomplete`/sin fecha;
   `trialing` → `incomplete`; columnas de empresa en `accounts` con CHECKs; RLS de `accounts`
   sin cambios si la política UPDATE (owner/admin) ya basta. Aserciones `-- 073` en verify-schema.
2. Entitlements/enforce: `incomplete` en el tipo, sin fila → `incomplete` (plan `inicio`),
   `isReadOnly(incomplete)`, mensaje «completa tu alta», `upgradeUrl` `/onboarding` para ese caso.
3. Webhook de PayPal: una venta sobre una fila `incomplete` la activa (REVIVABLE / adopción).
4. `src/lib/onboarding/`: validación del perfil, estado del alta (paso), sello
   `onboarding_completed_at` (rol de servicio, filtrado por id de cuenta).
5. Rutas `POST /api/onboarding/company` (owner) y `GET /api/onboarding/state`.
6. `(onboarding)/onboarding` con layout propio (sin sidebar/header): empresa → plan → PayPal.
   Checkout de una cuenta `incomplete` vuelve a `/onboarding` (misma pieza `CheckoutReturn`).
7. Puerta en el layout de `(dashboard)` (servidor) con `redirect('/onboarding')`.
8. Retirar `TrialBanner`, `trial.ts` y los textos de prueba; `BillingStatusAlert`, Ajustes y
   panel de plataforma con «Alta incompleta».
9. Tests, checks SQL, CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer)

Rama `platform/paid-onboarding` (worktree `.claude/worktrees/paid-onboarding`), base `feat/superadmin` @ 38268b4. Sin push.

| Commit | Qué |
|---|---|
| `15c5768` | feat: migración 073 + bloque `-- 073` en `verify-schema.sql` |
| `1fecf8f` | feat: `incomplete` en entitlements/enforce, webhook de PayPal (semilla incomplete), checkout que vuelve a `/onboarding/return`, test CP11 |
| `8b9d998` | feat: `/onboarding` (grupo `(onboarding)`), `POST /api/onboarding/company`, puerta en el layout de `(dashboard)`, retirada de la prueba, «Alta incompleta» en banner/Ajustes/panel, i18n es/en/ko, tests |
| `1332082` | docs: CHANGELOG (al final del bloque Unreleased) |

HEAD = `1332082`.

## Compuerta (en el worktree)

- `npm run lint`: 0 errores, 35 warnings (las preexistentes; ninguna en archivos de esta feature).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 239 archivos, **3308 tests** verdes.
- `npm run build` con las variables dummy: verde; aparecen `ƒ /onboarding`, `ƒ /onboarding/return`, `ƒ /api/onboarding/company`.
- `scripts/replay-migrations.sh "$(pwd)"`: salida 0, `verify-schema.sql: OK`.
- `progress/checks_paid-onboarding.sql` (con `KEEP=1`, `docker cp` de la 073 al contenedor): todas las comprobaciones OK (salida abajo).

**Aviso sobre la regla de red.** `npm run build` usa `next/font/google` (Inter, en `src/app/layout.tsx`), que descarga la
fuente de Google Fonts en tiempo de build si no está en caché; el worktree no tenía caché de fuentes. El build terminó
bien, así que casi seguro hubo esa descarga. No lo detecté hasta después de ejecutarlo. No hubo otra conexión: Docker
con la imagen local (`supabase/postgres:17.4.1.075`, sin `pull`), `fetch` mockeado en tests. Para builds offline:
`NEXT_FONT_GOOGLE_MOCKED_RESPONSES` (mecanismo de Next) o una fuente local; decisión del humano, fuera de alcance.

## Dónde está la puerta: en el LAYOUT de `(dashboard)`, no en el middleware

`src/app/(dashboard)/layout.tsx` llama a `onboardingRedirect()` (`src/lib/onboarding/gate.ts`) y hace `redirect()` fuera de
todo try/catch (docs de Next, `redirect.md`). Por qué:
- El middleware corre en Edge en cada petición (incluidas las API y los prefetch): decidir ahí exige ir a la base en cada
  petición o una cookie firmada que se queda vieja justo cuando el webhook activa la cuenta.
- El layout corre al entrar al grupo del panel (docs «Layouts and auth checks»: no se re-renderiza en navegación cliente
  entre sus páginas). Una cuenta no vuelve a `incomplete` estando dentro, y quien viene de `/onboarding` (otro grupo)
  siempre renderiza el layout en servidor. La salida tras pagar es `window.location.assign('/dashboard')` para forzarlo.
- No es la frontera de seguridad (los docs lo advierten): las escrituras las rechaza `requireRole` → `assertWritable`
  (`incomplete` es solo lectura) y la RLS de `subscriptions`. `src/middleware.ts` NO se ha tocado.

Exenciones: por construcción (no renderizan ese layout) `/onboarding`, `/onboarding/return`, `/platform`, `/auth/*`,
`/reset-password`, `/join/*`, `/login`, `/signup` y toda `/api/*` (webhooks de WhatsApp y PayPal, `/api/v1`, crons,
`/api/platform`, `/api/billing`); por regla: sesión de soporte (pasa), `platform_admins` (→ `/platform`), miembros de una
cuenta que paga (su `account_id` es el de la cuenta que paga → `done`).

`/billing/return`: una cuenta `incomplete` ya no vuelve de PayPal ahí sino a `/onboarding/return` (`checkoutUrls(origin,
{ onboarding })`), que monta la misma pieza `CheckoutReturn` (mismo sondeo de `GET /api/billing/checkout`) y al activarse
salta sola a `/dashboard`. Así la página que necesita quien está pagando está fuera de la puerta sin exenciones por ruta
dentro de un layout (que no ve el pathname y no se re-renderiza). Un retorno viejo a `/billing/return` con cuenta
`incomplete` cae en `/onboarding` por la puerta; el sondeo sin `subscription_id` responde por el último intento.

## Criterio ↔ test

| Criterio | Archivo | `it(...)` |
|---|---|---|
| Sin fila → `incomplete`, `inicio`, solo lectura | `src/lib/billing/entitlements.test.ts` | «resolves an account with no subscription row to incomplete on inicio, read-only (s9.6: no trial)» |
| Fila `incomplete` = lock `subscription`, no hold | idem | «an incomplete row (the 073 seed) is read-only for the subscription, not a hold»; «status incomplete → readOnly true» (it.each); `isReadOnly` «handles every status» |
| Estado desconocido falla cerrado | idem | «fails closed to incomplete (read-only) when the stored status is not a known value» |
| `assertWritable` 403 «complete your sign-up» | `src/lib/billing/enforce.test.ts` | «refuses an incomplete account (s9.6, the 073 seed) and says «complete your sign-up»»; «refuses an account with no subscription row at all (no trial fallback)» |
| `upgradeUrl` `/onboarding` para `incomplete` (hold conserva `/billing`) | idem | «sends an incomplete account to /onboarding, not /billing (s9.6)» |
| CP11: entrante de cuenta `incomplete` se guarda | `src/app/api/whatsapp/webhook/route.test.ts` | «stores it for an account that never paid — incomplete, no trial (s9.6)» |
| Webhook PayPal activa la semilla incomplete con el plan comprado | `src/lib/billing/webhook-events.test.ts` | «activates the incomplete seed of an account that never paid, on the plan it bought»; «activates an incomplete seed when the first sale beats the activation (s9.6)» |
| Checkout funciona con `incomplete` (allowReadOnly) y vuelve a `/onboarding/return` | `src/app/api/billing/checkout/route.test.ts` | «lets an incomplete account (the 073 seed, read-only) contract and return to /onboarding»; «creates the PayPal subscription and hands back its approval link» (sin fila → onboarding); «sends an account that already contracted once back to /billing/return» |
| URLs y detección del primer contrato | `src/lib/billing/checkout.test.ts` | «brings an account still signing up back to the onboarding flow (s9.6)»; `isOnboardingCheckout` «is the first contract: no row, or the incomplete seed» |
| Ruta de empresa: 401 | `src/app/api/onboarding/company/route.test.ts` | «401s without a session, and writes nothing» |
| 403 no owner (admin/agent/viewer), 403 soporte | idem | «403s a %s: step 1 is owner-only»; «403s a support session…» |
| 400 validación por campo | idem | «400s a bad %s and names the field»; «400s a body that is not JSON» |
| 200 en `incomplete` (su salida del lock) y siguiente paso | idem | «saves the profile of an INCOMPLETE account…»; «answers done for an account that already pays (manual plan)…» |
| Aislamiento por `account_id` (cuerpo ignorado) | idem | «writes the CALLER account only — an accountId in the body is ignored (CP3)» |
| Otros locks (suspended/expired/hold) siguen bloqueando | idem | «403s a %s account: its lock is settled at /billing, not here»; «403s an incomplete account an operator put on hold» |
| Fuga A↔B con base simulada + auditoría de rol de servicio | `src/lib/security/tenant-isolation.test.ts` › `/api/onboarding/company (s9.6)` | «saves the profile of A and stamps A only — B untouched, even when the body names B»; «lets an INCOMPLETE A save its profile…»; «403s an agent of A and writes nothing anywhere» |
| Pasos en servidor (company → plan → done), todos los miembros de `incomplete` con puerta | `src/lib/onboarding/state.test.ts` | «a new signup…starts at the company step»; «…goes to the plan step, and is not stamped»; «gates every member of an incomplete account, %s included» |
| Manual/active sin empresa: solo paso 1 (y solo al owner) | idem | «a manual plan (s9.4) without company data only shows step 1 to the owner» |
| Sello `onboarding_completed_at` una vez, al pagar + perfil | idem | «a paying account with its profile is done — and stamps the onboarding once»; «the stamp never overrides incomplete…»; «a failed stamp is not a failure…» |
| Rol de servicio filtrado por la cuenta (CP3) | idem | «reads and stamps ONLY the caller account, and leaves B untouched» |
| Puerta: `incomplete` → `/onboarding`; active/manual pasan; operador → `/platform`; soporte pasa; sin sesión no hay bucle; error abre | `src/lib/onboarding/gate.test.ts` | «sends an account on the %s step to /onboarding»; «lets an active account in…»; «lets a manual plan in (s9.4)…»; «sends a platform operator…to /platform»; «never gates a support session…»; «leaves the signed-out and the unlinked to the shell…»; «fails open on a database error…» |
| El layout redirige / renderiza | `src/app/(onboarding)/onboarding-gate.test.ts` | «redirects an incomplete account to /onboarding»; «redirects an operator with an unpaid company to /platform»; «renders the CRM when the gate is open…» |
| Páginas de onboarding: sin sesión → /login, done/soporte → /dashboard | idem | «send the signed-out to /login»; «send a finished onboarding to /dashboard»; «send a support session to /dashboard…»; «render for an account that is still signing up» |
| Exenciones por construcción | idem | «keeps the onboarding pages out of (dashboard)…»; «/%s does not render under the (dashboard) layout»; «is consulted by the dashboard layout only — no API route, webhook or cron»; «lets the WhatsApp webhook, /api/v1…through the middleware untouched» |
| Validación del perfil y listas = CHECKs de la 073 | `src/lib/onboarding/profile.test.ts` | «accepts a complete profile and normalises it»; «refuses a bad %s»; «team sizes are exactly the CHECK list»; «every country satisfies the alpha-2 CHECK…» |
| UI de los pasos (es/en/ko) | `src/components/onboarding/onboarding-flow.test.tsx` | «step 1 for the owner: the five fields, translated (%s)»; «step 1 for a member who is not the owner…»; «step 2: the plan picker…»; «step 2 for an agent…» |
| Retirada de textos de prueba + paridad i18n | idem + `src/i18n/messages.test.ts` (global) | «%s.json has no trial countdown and has the Onboarding namespace»; «es says «Alta incompleta»…» |
| Banner con caso `incomplete` → `/onboarding` | `src/components/billing/billing-status-alert.test.tsx` | «an incomplete account: «completa tu alta», not «settle the subscription»»; «a manual hold wins over incomplete…» |
| Censo/ficha con «Alta incompleta» | `src/components/platform/subscription-status.test.tsx` | «names incomplete in %s»; «says «Alta incompleta» in Spanish…» |
| MRR no cuenta `incomplete`; «por estado» sí | `progress/checks_paid-onboarding.sql` §9 | NOTICE «incomplete stays out of the MRR: OK» (`platform_metrics()` de la 069 ya filtra `status IN ('active','past_due')`; sin cambios en SQL) |

## Verificaciones contra base real (`progress/checks_paid-onboarding.sql`)

```
NOTICE:  new signup → inicio/incomplete, no trial_ends_at: OK
NOTICE:  trialing → incomplete, trial_ends_at NULL (and 073 re-runs cleanly): OK
NOTICE:  company profile CHECKs: OK
NOTICE:  owner updates the profile, cannot touch subscriptions: OK
NOTICE:  agent cannot update the profile: OK
NOTICE:  support session cannot update accounts nor subscriptions: OK
NOTICE:  onboarding stamp with a complete profile: OK
NOTICE:  invitation redeems over an incomplete seed: OK
NOTICE:  a manual/active personal account still counts as data: OK
NOTICE:  platform_metrics by_status.incomplete = 3, mrr = 0.00
NOTICE:  incomplete stays out of the MRR: OK
```
La sección 2 pone una fila en `trialing` y re-aplica la 073 entera dentro de la transacción (`\i`): prueba la conversión
y la idempotencia a la vez. Cómo correrlo: cabecera del archivo.

## Verificación manual pendiente (PayPal real, sandbox) — guion

1. Alta nueva en `/signup`, verificar el correo, entrar: debe aterrizar en `/onboarding`, paso 1.
2. Rellenar empresa → paso 2 (planes). `Elegir` en Pro mensual → PayPal sandbox → aprobar.
3. PayPal devuelve a `/onboarding/return?subscription_id=…`: «Estamos confirmando tu pago» hasta que llegue
   `BILLING.SUBSCRIPTION.ACTIVATED`; entonces «plan activo» y a los ~1,5 s salta a `/dashboard`.
4. En la base: `subscriptions` de la cuenta en `pro`/`active` con el id de PayPal; `accounts.onboarding_completed_at` sellado.
5. Cancelar en PayPal en el paso 2 → vuelve a `/onboarding?checkout=cancelled` con el aviso del PlanPicker.
6. Con una cuenta a la que el operador asignó plan a mano (s9.4) y sin datos de empresa: su owner ve solo el paso 1 y al
   guardar entra a `/dashboard`; un agente de esa cuenta entra directo.
7. Con un operador de plataforma cuya empresa propia está `incomplete`: `/dashboard` lo manda a `/platform`.

## Decisiones donde el spec era ambiguo

- **Puerta en el layout** (arriba). No se toca `src/middleware.ts`.
- **Quién sella `onboarding_completed_at`**: `loadOnboardingState` (rol de servicio, UPDATE condicional `IS NULL`) la
  primera vez que coinciden «paga» y «perfil completo»: lo llaman la ruta de empresa, las páginas de onboarding y la puerta
  del layout (cubre al cliente que paga y cierra la pestaña). No el webhook de PayPal: no cubriría los planes manuales ni el
  perfil rellenado después, y metería una escritura más en el camino que concilia dinero. El sello es una caché: la puerta
  nunca confía solo en él (`incomplete` manda) y un CHECK (`accounts_onboarding_needs_profile`) impide sellar sin perfil,
  así que un UPDATE directo del owner a PostgREST no se salta el paso 1.
- **`incomplete` bloquea a todos los miembros** (no solo al owner): la cuenta entera es de solo lectura. Un agente/viewer ve
  en `/onboarding` quién tiene que actuar. **Perfil incompleto con cuenta que paga** solo bloquea al owner (es quien puede
  rellenarlo; `requireRole('owner')`), el equipo sigue trabajando.
- **Estados «pagados»**: todo lo que no es `incomplete` (active, past_due, suspended, cancelled, expired) sale de la puerta;
  la escalera de morosidad existente se ocupa del resto. El spec nombra «active/past_due en gracia/manual»; tratar
  suspended/expired/cancelled como puerta los mandaría a un alta que ya hicieron.
- **La ruta de empresa en una cuenta `incomplete`** usa `allowReadOnly` (es la salida del lock, como `/api/billing/*`) y
  re-aplica `assertWritable` para cualquier otra causa (suspended, expired, gracia agotada, retención manual).
- **`plan_id` de las filas `trialing` existentes** se deja como estaba (`pro`): el spec solo fija `status` y `trial_ends_at`.
  Al pagar, el webhook pone el plan del `checkout_intent`.
- **`trialing` sigue en el CHECK** (se añade `incomplete`, no se sustituye): nadie lo escribe y no queda ninguna fila, pero
  quitarlo rompería un despliegue con código viejo. `trial_period()` se conserva (verify-schema la pide) y queda comentada
  como obsoleta; `seed_account_trial()` mantiene el nombre por lo mismo.
- **Webhook**: una venta (`PAYMENT.SALE.COMPLETED`) que llega antes que `ACTIVATED` sobre la semilla `incomplete` sin id de
  PayPal se trata como «no hay fila»: plan, ciclo e id del intent. Antes (con `trialing`) activaba el estado pero dejaba el
  plan de la semilla y sin id hasta el `ACTIVATED`.
- **País**: lista corta de 29 códigos ISO (LatAm, España, Portugal, EE. UU., Canadá, Reino Unido, Francia, Alemania,
  Italia, Corea) con nombres de `Intl.DisplayNames` en el idioma del usuario; el servidor exige que esté en la lista y la
  base, dos mayúsculas. Sector: 10 claves + `other`. Teléfono: 6–15 dígitos, `+ ( ) - .` y espacios.
- **Nombre de la marca** en la cabecera del onboarding va literal («Cabbity CRM», como `BRAND_NAME` del checkout), no en i18n.
- **Etiqueta** `Platform.metrics.status.incomplete` pasa de «Pago pendiente» a «Alta incompleta» (y en/ko) para que
  dashboard, censo y ficha digan lo mismo; el censo y la ficha ahora traducen todos los estados conocidos.

## Hallazgo que obligó a tocar SQL fuera de lo listado

`redeem_invitation()` (052) solo descartaba la semilla `trialing`. Con la semilla `incomplete`, **aceptar una invitación
habría fallado para todo usuario nuevo** («Your account already contains data», 23505). La 073 la reescribe (cuerpo de la
052 con `status IN ('trialing','incomplete')`); verify-schema lo asegura y el check §8 lo prueba (y que una cuenta con plan
manual sigue contando como datos).

## Variables de entorno

Ninguna nueva. `.env.local.example` no se toca.

## Deuda detectada fuera de alcance

- `src/app/(dashboard)/layout.tsx`, `src/components/layout/header.tsx` y `src/lib/billing/entitlements.ts` no estaban
  formateados con prettier en la base; no los he reformateado enteros para no inflar el diff.
- Las escrituras que el navegador manda directo a PostgREST (contactos, etiquetas…) no conocen la facturación: una cuenta
  `incomplete` (como hoy una `suspended`) solo queda bloqueada en las rutas de Next. La puerta la mantiene fuera del CRM,
  pero la RLS no lo impide. Preexistente (fase 3 §5).
- `next/font/google` en el build necesita red (ver aviso arriba).
- La cadena `Billing.return.backToDashboard` sigue diciendo «Ir al panel» en `/onboarding/return`; correcto porque lleva a
  `/dashboard`, pero con cuenta aún sin activar la puerta te devuelve a `/onboarding`.

## Segunda ronda (review CHANGES_REQUESTED)

Commit `b9bfba2` sobre `1332082`. HEAD = `b9bfba2`. Sin push. Sin `npm run build` (orden del líder: `next/font/google`).

### Hallazgo 1 (bloqueante): owner atrapado en una cuenta bloqueada que ya pagó — corregido

`src/lib/onboarding/state.ts`, en este orden:
1. `manualHold` → `done`, sea cual sea el estado (incluido `incomplete`): solo el operador levanta la retención y la ruta
   de empresa rechazaría el guardado; `BillingStatusAlert` muestra el aviso de retención.
2. `incomplete` → `company` / `plan` (sin cambios).
3. Paga con perfil → sello + `done` (sin cambios).
4. **Paga, sin perfil y `readOnly`** (suspended, expired, past_due sin gracia) → `done`, sin sello: la escalera de
   morosidad y `/billing` se encargan; el perfil se pedirá cuando la cuenta vuelva a poder escribir.
5. Paga, sin perfil, escribible → `company` solo para el owner (sin cambios; `past_due` dentro de la gracia entra aquí).

**`/billing` fuera de la puerta para toda cuenta que no sea `incomplete`.** Además de lo anterior, que ya lo cubre en todo
estado bloqueado, un owner que paga y puede escribir pero aún debe el paso de empresa también llega a `/billing` y
`/billing/return`. Como un layout no ve la ruta, el middleware reenvía `x-wacrm-pathname` (bloque propio y delimitado
`s9.6 onboarding gate` en `src/middleware.ts`, 10 líneas; `set` sobrescribe lo que mande el cliente; no consulta la base
ni redirige a nadie) y `gate.ts` lo lee con `headers()`. Constante y `isBillingPath` en `src/lib/onboarding/path-header.ts`,
sin imports (Edge). Corrige lo que dije en la primera ronda: **`src/middleware.ts` sí se toca ahora**, solo con ese
bloque. Falsificar la cabecera solo permitiría a un owner que paga aplazar el paso de empresa. La exención vale por
navegación al grupo: si ese owner pasa de `/billing` a otra página del CRM por navegación cliente, no se le vuelve a
preguntar hasta el siguiente render en servidor. Es aceptable porque el paso de empresa es una petición, no un bloqueo.
Una cuenta `incomplete` sigue saliendo de `/billing` hacia `/onboarding`.

Tests nuevos:
| Criterio | Archivo | `it(...)` |
|---|---|---|
| Los cuatro estados bloqueados, sin perfil, owner → `done`, sin sello | `src/lib/onboarding/state.test.ts` | «%s, no company profile, owner → done (the dunning ladder and /billing own it)» (suspended, expired, past_due past its grace, active with a manual hold) |
| `incomplete` con retención → `done` | idem | «an incomplete account an operator put on hold is not sent to onboarding either» |
| `past_due` en gracia (escribible) sí pide el perfil | idem | «a past_due account still inside its grace (writable) is asked for the profile» |
| La puerta con el `loadOnboardingState` real: esos cuatro entran desde `/dashboard`, `/billing` y `/settings` | `src/lib/onboarding/gate.test.ts` | «%s: the owner without a profile goes straight in, from anywhere»; control «an active, writable owner without a profile is asked for it» |
| `/billing` y `/billing/return` abiertos para quien no es `incomplete` | idem | «a paying owner still owing the company step reaches /billing and /billing/return»; «an incomplete account is sent to /onboarding even from /billing»; «does not mistake a lookalike path for /billing, nor a missing header» |
| El middleware reenvía la ruta, sobrescribe la del cliente y no redirige las API | `src/middleware.test.ts` › «middleware — onboarding path header (s9.6)» | «forwards %s to the layout»; «overwrites a value the client sent»; «never redirects %s %s to /onboarding» (webhooks de WhatsApp y PayPal, `/api/v1`, cron, `/api/platform`, `/api/billing/status`) |
| El middleware no resuelve la puerta | `src/app/(onboarding)/onboarding-gate.test.ts` | «the middleware never resolves the gate: it only forwards the path (no state, no database)» (sustituye al test que exigía que el middleware no mencionara `onboarding`) |

### Menores

- **Hallazgo 2**: el §8 de `progress/checks_paid-onboarding.sql` comprueba ahora que el perfil del invitado queda en la
  cuenta que invita con rol `agent` (NOTICE «invitation redeems over an incomplete seed, profile moved as agent: OK»).
- **Hallazgo 3**: la redirección automática de `CheckoutReturn` pasa a `scheduleContinue()` (exportada, sin DOM) y
  `src/components/billing/checkout-return.test.ts` la prueba con temporizadores falsos: salta a `/dashboard` justo a los
  `CONTINUE_DELAY_MS`, no se mueve en `confirming`/`slow` ni sin `continueOnActive` (`/billing/return`), y se cancela al
  desmontar.

### Compuerta (sin build)

- `npm run lint`: 0 errores, 35 warnings (las preexistentes).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 240 archivos, **3337 tests** verdes.
- `KEEP=1 scripts/replay-migrations.sh`: salida 0, `verify-schema.sql: OK`.
- `progress/checks_paid-onboarding.sql`: salida 0, las 11 NOTICE OK. Contenedor borrado después.
- `npm run build`: **no ejecutado** (orden del líder).

`src/middleware.ts` y `src/middleware.test.ts` no tenían formato prettier en la base: mis bloques siguen el estilo del
archivo, sin reformatearlo entero.
