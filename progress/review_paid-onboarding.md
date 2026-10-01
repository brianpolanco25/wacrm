# Review — s9.6 paid-onboarding

**Veredicto:** CHANGES_REQUESTED

## Compuerta (la corrió el reviewer en el worktree, HEAD 1332082)
- lint: verde (0 errores, 35 warnings que ya estaban)
- typecheck: verde
- test (`TZ=UTC npm test -- --reporter=dot`): verde, 239 archivos / 3308 tests
- build: **NO se ejecutó** por orden del líder (`next/font/google` descarga de red). Queda a cargo del líder.
- replay-migrations: verde (001–073 y verify-schema OK desde base limpia). Luego la 073 se re-aplicó 2 veces sobre la misma base: salida 0 y verify-schema OK de nuevo.
- `progress/checks_paid-onboarding.sql`: salida 0, las 11 NOTICE en OK (coinciden con el informe).
- SQL extra del reviewer (en transacción, con ROLLBACK):
  - aceptar la invitación sobre una semilla `incomplete` mueve el perfil (`account_id` = cuenta que invita, rol `agent`);
  - una cuenta personal `incomplete` **con un contacto** sigue contando como «con datos» (23505) y el contacto queda intacto;
  - el owner no puede sellar `onboarding_completed_at` sin perfil (check_violation);
  - `subscriptions_status_check` es único y contiene `incomplete`;
  - la política `accounts_update` sigue siendo `is_account_member(id,'admin')`.

## Desvíos declarados
1. **redeem_invitation (073)**: comparé el cuerpo con el de la 052 (última definición; 019/049 son anteriores y 071 no la redefine). Solo cambian 2 condiciones: `status NOT IN ('trialing','incomplete')` en la comprobación de datos y `status IN (...)` en el DELETE, las dos con `provider_subscription_id IS NULL`. Se mantiene la semántica: absorbe la cuenta vacía, mueve al usuario y no borra datos reales. Con el §8 y el SQL extra de arriba queda probado. **Aceptado.** (Nota menor: el §8 no comprueba que el perfil se mueva; lo comprobé yo.)
2. **Puerta en el layout**:
   - Coste: una resolución de sesión, un SELECT de `accounts` y `getEntitlements` por render servidor del layout, y `isPlatformAdmin` solo si la puerta se cierra. Está envuelto en `React.cache` (`gate.ts:56`). Es aceptable.
   - Navegación cliente: dentro de `(dashboard)` el layout no se re-evalúa (`authentication.md` §«Layouts and auth checks»). Aun así, ninguna transición devuelve una cuenta a `incomplete` estando dentro, y entrar desde `/onboarding` u otro grupo renderiza el layout en servidor. Aunque alguien lo lograra, `assertWritable` bloquea toda escritura por las rutas de Next (`enforce.test.ts`).
   - Las API no pasan por el layout (test «is consulted by the dashboard layout only»).
   - **Aceptado**, con la deuda ya anotada: las escrituras directas a PostgREST no conocen la facturación (preexistente).
3. **`/onboarding/return`**: la URL la elige `isOnboardingCheckout(existing)` (sin fila o `incomplete`). Si la cuenta ya contrató alguna vez, vuelve a `/billing/return` (test «sends an account that already contracted once back to /billing/return»). `/billing/return` no se ha tocado. **Aceptado.**
4. **Sello del onboarding**: la constraint `accounts_onboarding_needs_profile` está verificada en SQL (checks §3 y SQL extra). El sello va filtrado por `id` y tiene test de fuga. **Aceptado.**
5. **Todos los miembros de una cuenta `incomplete` / solo el owner en cuentas que pagan**: encaja con la decisión 6, y el CHANGELOG avisa de que las cuentas que ya pagan verán el paso de empresa. **El spec** exime por completo a las cuentas `active`/`past_due`/`manual`; la implementación es más estricta (manda al owner al paso 1). Lo acepto como lectura de la decisión 6, **pero provoca el bloqueo del hallazgo 1**.

## Trazabilidad criterio ↔ test
- C1 «073: CHECK con `incomplete`, semilla `inicio/incomplete` sin fecha, `trialing` → `incomplete`»: [x] verify-schema `-- 073`; checks §1–§2 (re-aplica la 073 dentro de la transacción).
- C2 «`getEntitlements()` sin fila → `incomplete`, readOnly»: [x] `src/lib/billing/entitlements.test.ts` › «resolves an account with no subscription row to incomplete…», «fails closed to incomplete…».
- C3 «`assertWritable` 403 con salida a `/onboarding`»: [x] `src/lib/billing/enforce.test.ts` › «refuses an incomplete account…», «sends an incomplete account to /onboarding, not /billing».
- C4 «CP11, lo entrante se guarda»: [x] `src/app/api/whatsapp/webhook/route.test.ts` › «stores it for an account that never paid». Lo leí: `assertWritable` rechaza, aun así hay upsert del mensaje y `bump_conversation_on_inbound`, y `assertWritable` no se llama.
- C5 «Paso 1 empresa → `accounts`» (owner, validación, aislamiento): [x] `src/app/api/onboarding/company/route.test.ts` (401/403 por rol y soporte, 400 por campo, accountId del cuerpo ignorado) + `tenant-isolation.test.ts` › `/api/onboarding/company (s9.6)` (A↔B) + `profile.test.ts` (ISO-2, lista de `team_size` = CHECK).
- C6 «Paso 2 plan → PayPal (checkout con `incomplete`)»: [x] `src/app/api/billing/checkout/route.test.ts` › «lets an incomplete account… return to /onboarding»; `webhook-events.test.ts` › «activates the incomplete seed…» (los dos órdenes de eventos).
- C7 «Paso 3 esperar al webhook y entrar»: [x] `/onboarding/return` monta `CheckoutReturn continueOnActive`, y hay guion manual en el informe (PayPal sandbox). No hay test unitario del salto automático (`checkout-return.tsx:124-131`). Menor.
- C8 «Puerta y exenciones»: [x] `gate.test.ts` (incomplete → /onboarding, operador → /platform, soporte pasa, sin sesión no hay bucle) + `onboarding-gate.test.ts` (qué rutas quedan fuera del layout). **[ ] Falta el caso de owner de una cuenta de solo lectura que ya paga, sin perfil → hallazgo 1.**
- C9 «Retirar `TrialBanner` y los textos de prueba»: [x] `trial-banner.tsx` y `trial.ts` borrados. El grep en es/en/ko no encuentra «prueba gratis/14 días/free trial». Solo quedan las etiquetas del estado `trialing` («Prueba»/«En prueba»), que siguen siendo válidas porque el valor sigue en el CHECK. `onboarding-flow.test.tsx` › «%s.json has no trial countdown…».
- C10 «Datos existentes `trialing` → `incomplete`»: [x] checks §2 + verify-schema (no quedan filas `trialing`).
- C11 «MRR sin `incomplete`; censo, ficha y dashboard lo muestran»: [x] checks §9 (by_status.incomplete=3, el MRR no se mueve) + `subscription-status.test.tsx`.
- C12 «`BillingStatusAlert` con caso `incomplete`»: [x] `billing-status-alert.test.tsx`.

## Checkpoints
- CP1: [~] lint, typecheck y test en verde. Build no ejecutado por orden del líder.
- CP2: [x] 073 idempotente (re-aplicada 3 veces), verify-schema con bloque `-- 073`, sin CASCADE nuevo; replay en 0.
- CP3: [x] `state.ts:91-95,114-118` y `getEntitlements` filtran por la cuenta del contexto; test de fuga A↔B.
- CP4: [ ] falta cubrir el caso del hallazgo 1. El resto está cubierto (SQL + guion manual).
- CP5: [x] `package.json` y el lock sin cambios.
- CP6: [x] paridad de claves es/en/ko: 0 diferencias.
- CP7: [x] `redirect` fuera de try/catch, `unstable_rethrow`, `React.cache`; limitación de los layouts documentada con cita a `authentication.md`.
- CP8: [x] Lo que se tocó fuera de lo listado (`redeem_invitation`, `tenant-isolation.test.ts`, panel de plataforma) está justificado en el informe.
- CP9: [x] CHANGELOG con aviso de migración y del cambio de comportamiento; sin variables de entorno nuevas.
- CP10: [x] 4 commits en `platform/paid-onboarding`, en español, con prefijo y `Co-Authored-By`; sin push.
- CP11: [x] test leído (C4).

## Hallazgos (archivo:línea)
1. **Bloqueo sin salida para owners de cuentas que ya pagaron y están en solo lectura, sin perfil de empresa.** Afecta a todas las cuentas previas a la 073 que hoy estén `suspended`, `expired`, `past_due` con la gracia agotada o con retención manual, porque las columnas de empresa son nuevas y están a NULL en todas.
   - `src/lib/onboarding/state.ts:137-138`: `paying && !profileComplete && owner` → `step = 'company'`.
   - `src/lib/onboarding/gate.ts:71`/`84` redirige a `/onboarding`, **también desde `/billing`**, que vive en `(dashboard)`.
   - En `/onboarding` el owner ve el formulario de empresa, pero `POST /api/onboarding/company` responde 403 porque `src/app/api/onboarding/company/route.ts:46-48` aplica `assertWritable` a todo estado que no sea `incomplete` (así lo prueba `route.test.ts:247-256`, «its lock is settled at /billing»).
   - `/billing` es inalcanzable por la puerta y `onboarding-flow.tsx:145` no ofrece salida. Resultado: el owner no puede ni completar el perfil ni regularizar el pago.
2. Menor: `progress/checks_paid-onboarding.sql` §8 no comprueba que el perfil del invitado quede en la cuenta que invita con el rol de la invitación. Lo verifiqué a mano. Conviene añadir esa aserción.
3. Menor: `CheckoutReturn` con `continueOnActive` (`src/components/billing/checkout-return.tsx:124-131`) no tiene test del salto a `continueHref`.

## Cambios requeridos
1. Deshacer el bloqueo del hallazgo 1. Opción recomendada: en `loadOnboardingState`, si la cuenta paga y `entitlements.readOnly` (o `manualHold`), responder `done`, para que la escalera de morosidad y `/billing` se ocupen y el perfil se pida cuando vuelva a ser escribible. La alternativa es permitir en la ruta de empresa guardar el perfil en cualquier estado de solo lectura; si se elige, que sea una decisión explícita.
2. Añadir los tests: en `state.test.ts`, `suspended`/`expired`/`past_due` fuera de gracia/`manualHold` **sin perfil** con rol owner → `done` (o el comportamiento elegido); y en `gate.test.ts`, que ese owner no se redirige a `/onboarding`.
3. (Opcional) Las aserciones de los hallazgos 2 y 3.

CHANGES_REQUESTED — build no ejecutado por orden del líder.

---

# Segunda ronda — rango 1332082..b9bfba2 (HEAD b9bfba2)

**Veredicto:** APPROVED

## Compuerta (la corrió el reviewer, un comando por llamada)
- lint: verde (0 errores, 35 warnings que ya estaban)
- typecheck: verde
- test (`TZ=UTC npm test -- --reporter=dot`): verde, 240 archivos / 3337 tests
- build: **NO se ejecutó**, por orden del líder (red de `next/font/google`)
- replay-migrations: verde (001–073 + verify-schema OK) desde base limpia
- `progress/checks_paid-onboarding.sql`: salida 0, 11 NOTICE en OK. El bloque 8 ahora dice «profile moved as agent». Contenedor borrado.

## Hallazgo 1 (bloqueo) — resuelto
- `src/lib/onboarding/state.ts:138-155`:
  - con `manualHold` → `done`;
  - si la cuenta paga, no tiene perfil y está en `readOnly` → `done`;
  - en esos casos no se sella nada;
  - `past_due` dentro de la gracia (se puede escribir) sigue pidiendo el perfil.
- Tests leídos:
  - `state.test.ts`: it.each suspended/expired/past_due fuera de gracia/hold → `done`, sin UPDATE y con `onboarding_completed_at` NULL; «a past_due account still inside its grace… is asked for the profile».
  - `gate.test.ts`: los mismos casos a través de `onboardingRedirect()` → `null`, y un caso de control: owner activo sin perfil → `/onboarding`.

## Bloque del middleware (`src/middleware.ts:57-64`)
- Solo hace `request.headers.set('x-wacrm-pathname', nextUrl.pathname)`, antes del primer `NextResponse.next({ request })`. El diff no toca `supportSessionVerdict`, `SUPPORT_WRITE_HEADERS`, las exenciones de soporte (s9.5) ni las listas de auth (s9.8): el grep sobre el diff da vacío.
- `set` sobrescribe siempre: `middleware.test.ts` › «overwrites a value the client sent» (el cliente manda `/billing` y llega `/dashboard`).
- Falsear la cabecera no sirve para saltarse `incomplete`: `gate.ts:84` solo la consulta si `state.status !== 'incomplete'` (test «an incomplete account is sent to /onboarding even from /billing»). Lo máximo que consigue es que el owner de una cuenta que paga aplace el paso de empresa. `isBillingPath` descarta rutas parecidas y la cabecera ausente (test «does not mistake a lookalike path…»).
- `onboarding-gate.test.ts` comprueba que el middleware solo importa `path-header` y que ese módulo no importa nada (seguro para Edge).

## Observaciones (no bloquean)
1. `src/middleware.ts:199`: el matcher omite las rutas que terminan en `.png`, `.svg`, etc. En una página de `(dashboard)` con un segmento así, la cabecera llegaría tal como la manda el cliente. El efecto es el ya aceptado: solo aplaza el paso de empresa de un owner que paga.
2. Una cuenta `incomplete` con retención manual ahora entra al CRM en solo lectura, con el banner «held», en vez de ir a `/onboarding`. Solo puede provocarlo un operador y la cuenta sigue sin poder escribir: aceptable.
3. Si el owner que paga y no tiene perfil entra por `/billing`, puede seguir navegando dentro del CRM desde el cliente hasta el siguiente render en servidor. Está documentado en `gate.ts:37-44` y el paso de empresa no es un bloqueo de seguridad.

## Hallazgos menores de la ronda 1
- 2 (bloque 8 del SQL sin comprobar el perfil del invitado): [x] resuelto.
- 3 (sin test del salto automático tras activarse el plan): [x] `scheduleContinue` extraída y cubierta en `src/components/billing/checkout-return.test.ts`.

## Checkpoints (cambios frente a la ronda 1)
- CP1: [~] verde salvo el build, que no se ejecutó por orden del líder.
- CP4: [x] el caso del hallazgo 1 ya tiene tests.
- CP8: [x] tocar `src/middleware.ts` está justificado: 10 líneas, sin consultas a la base.
- CP10: [x] commit b9bfba2 con prefijo `fix:`, en español y con `Co-Authored-By`; sin push.

APPROVED — build no ejecutado por orden del líder.
