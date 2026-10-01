# Review — s10.3 managed-plan

**Veredicto:** CHANGES_REQUESTED

Worktree `.claude/worktrees/fg-managed-plan`, rama `fg/managed-plan`, rango `194e4e6..52809ed` (3 commits: c40f1ca, c4a3024, 52809ed). Árbol limpio. 33 archivos, coinciden con la lista del informe. `main`/`fg/managed-plan` intactos, nada pusheado.

## Compuerta
- lint / typecheck / test (TZ=UTC) / build: verde — ejecutada por el líder (ver sección abajo); no reejecutada por este reviewer (instrucción explícita).
- replay-migrations: verde — reejecutado por este reviewer: `KEEP=1 scripts/replay-migrations.sh "$(pwd)"` → `ok 077_plan_gestionado.sql`, `verify-schema.sql: OK`.
- checks_managed-plan.sql: verde — reejecutado contra el contenedor de la réplica (`docker cp` + `psql -f`): `ok 1a` … `ok 5`, todos los NOTICE del guion aparecen, `ROLLBACK` limpio al final. Confirma: plan oculto/1036/mensual/sin tope, límites, política por defecto, CHECKs (`payment_method` y `meta_pricing` no objeto/NULL), RLS (A lee su fila, UPDATE de `meta_billing`/`meta_pricing`/`payment_method`/`current_period_end` y DELETE tocan 0 filas, INSERT `insufficient_privilege`, no edita `plans`), anon sin acceso, idempotencia (reaplicar la 077 respeta la edición del operador).

## Compuerta ejecutada por el líder (2026-10-01, HEAD 52809ed, worktree fg-managed-plan)
- `npm run lint`: salida 0 (0 errores). `npm run typecheck`: salida 0.
- `TZ=UTC npx vitest run`: 265 archivos, 3 768 tests, verde (13,6 s).
- `scripts/replay-migrations.sh`: salida 0; `ok 077_plan_gestionado.sql`; `verify-schema.sql: OK`.
- `npm run build` con variables dummy: salida 0; aparece `ƒ /api/platform/accounts/[id]/meta-pricing`.
Motivo: dos reviewers se colgaron por el watchdog con la máquina cargada; el reviewer de relevo solo lee código y ejecuta el SQL.

## Migración 077
- Leída completa: idempotente (`ADD COLUMN IF NOT EXISTS`, CHECK drop-then-add, plan con `ON CONFLICT (id) DO NOTHING`, política de precio sembrada solo si `meta_pricing = '{}'`). Límites = `negocio` (041) con `messages_out`/`broadcast_recipients` a `null`, `numbers` 3; `features` = inventario completo de `plan-catalog.ts`. `payment_method` nullable con CHECK `IN ('paypal','manual')`. Sin `CASCADE`.
- `verify-schema.sql` bloque `-- 077` (líneas 2084-2135): afirma columna+default+CHECK de `meta_pricing`, la fila `gestionado` (oculto/1036/mensual/límites/features), la política por defecto exacta, `payment_method` nullable+CHECK, y que `plans`/`subscriptions` siguen sin políticas de escritura de cliente. El recuento `(SELECT count(*) FROM plans) <> 5` (línea 1826) ya refleja el quinto plan.
- Decisión documentada y correcta: `plans.meta_pricing` como columna propia, no `plans.limits.meta_pricing` — evita que el editor de s9.3 (que reescribe `limits` entero con sus 8 claves) la borre silenciosamente. Verificado leyendo `validateLimits`/`normalizeLimits` en `plan-catalog.ts` y el editor de s9.3; coincide con lo que dice la migración en comentario.

## Trazabilidad criterio ↔ test (leídos, no solo localizados)

- **Plan 077 (oculto/1036/mensual/límites/features/política)**: `src/lib/billing/managed-plan.test.ts` › `plan gestionado (077)` — parsea el SQL de la migración con regex y compara contra `PLAN_LIMIT_KEYS`/`PLAN_FEATURES`/`parseMetaPricing`. Es un test de texto sobre el SQL (no ejecuta la migración), pero la ejecución real la cubre `checks_managed-plan.sql` (ok 1a/1b) que sí corrí contra Postgres. [x]
- **`gestionado` nunca en PlanPicker/onboarding/`/api/billing/plans`**: `managed-plan.test.ts` › `a customer never sees it` (lee que `plan-picker.tsx` y `onboarding-flow.tsx` solo llaman a `/api/billing/plans`, que esa ruta filtra `is_public`, que el checkout rechaza `!plan.is_public`); `src/app/api/billing/plans/route.test.ts` › `never lists the managed plan... even once it is published to PayPal` (leído: empuja una fila `gestionado` con `provider_plan_id_month` puesto y comprueba que `ids` y el JSON entero no la mencionan). [x]
- **POST plan 401/403**: `managed.test.ts` › `the guard` (2 casos), `tenant-isolation.test.ts` › `s10.3: 403s the owner of A...` (4 variantes: plan manual, plan paypal, PATCH precio, PATCH método, las 4 con `expectNoBIds` y snapshot sin cambios). [x]
- **POST plan 400 validación**: `managed.test.ts` › `validation` `it.each` (6 casos: método desconocido, metaBilling desconocido, categoría faltante, multiplicador 0, fee con 3 decimales, precio vacío con managed) + `needs_terms` + `not_managed_plan` para PayPal sobre plan sin política. Leídos: cada caso comprueba `res.status===400` y que la tabla no cambió. [x]
- **POST plan manual (active/month/+1 mes/precio guardado/bitácora)**: `managed.test.ts` › `200: manual, active, monthly...` — lee `row.cycle`, `row.current_period_end` (ventana 27-32 días), `payment_method`, `meta_billing`, `meta_pricing`, y la fila de `impersonation_log` con `details`. B intacto (snapshot). [x]
- **POST plan sin política → `direct`**: `managed.test.ts` › `a plan with no price policy afterwards takes the company out of managed billing` y `provisioning.test.ts` › `manualPlanRow with managed terms (s10.3)`. Leído `manualPlanRow`: sin `terms`, `meta_billing: 'direct'`, `meta_pricing: {}`, `payment_method: null`, `cycle: null`. [x]
- **`gestionado` sin términos → 400 `needs_terms`**: `managed.test.ts` › `400s the managed plan given blind (no payment method): needs_terms` — comprueba código y que no escribió bitácora ni movió el plan de A. [x]
- **POST plan PayPal (crea plan si falta, suscripción de la cuenta, `checkout_intents`, `incomplete`, enlace)**: `managed.test.ts` › `200: publishes the hidden plan...` — leído con detalle: orden de llamadas a PayPal (`GET products`, `POST plans`, `POST subscriptions`), `custom_id`, `return_url` de onboarding, header `PayPal-Request-Id` con el prefijo `checkout-{A}-gestionado-month-`, fila `plan_provider_history`, fila `checkout_intents` completa, fila `subscriptions` con `status: 'incomplete'`, `provider_subscription_id: null`. [x]
- **Repetir la asignación no crea dos suscripciones (idempotencia, fetch mockeado)**: **sin test.** Ver hallazgo 1 abajo — [ ].
- **PayPal reutiliza plan existente / no republica**: `managed.test.ts` › `reuses the PayPal plan when it already exists (no second publication)` — comprueba `published:false` y que `apiCalls()` solo tiene `POST /v1/billing/subscriptions`. [x]
- **PayPal 502/503/409**: `managed.test.ts` › `502s when PayPal refuses the subscription...`, `503s without PayPal credentials...`, `409s company B (PayPal still billing) before calling PayPal` — los tres comprueban que nada se escribió (`checkout_intents`, `impersonation_log`, fila de la cuenta). [x]
- **PATCH meta-pricing 401/403/400/404**: `meta-pricing/route.test.ts` › `the guard` (2), `validation` `it.each` (7 casos incluida categoría desconocida y fee negativo), `404s a malformed id and a company that does not exist`. [x]
- **PATCH bitácora antes/después, `changed:false` sin escribir, 500 sin escribir si falla bitácora, 409 `not_managed`**: `meta-pricing/route.test.ts` › `200: changes A only, with before/after in the trail` (leído `details.before`/`details.after` exactos), `writes neither the trail nor the row when nothing changes`, `500s and changes nothing when the trail cannot be written`, `409s a company Cabbity does not pay Meta for (direct)`. [x]
- **PATCH `payment_method` sin cuota doble (matriz manual↔paypal)**: `meta-pricing/route.test.ts` › `409s manual while PayPal is still billing the fee (B)`, `409s paypal with no live PayPal subscription (A)`, `moves to manual once PayPal no longer bills (cancelled)` — los tres leídos, cubren la matriz completa descrita en el código (`isLivePayPalSubscription`). [x]
- **Fuga A↔B (y C)**: `managed.test.ts` (A↔B en todo el bloque paypal/manual), `meta-pricing/route.test.ts` › `200: changes A only...` (A, B, C: B y C con snapshot `toBe`), `tenant-isolation.test.ts` › `s10.3: gives ONE company the managed plan by hand...`, `s10.3: changes the Meta price of ONE managed company...` (auditoría automática de `supabaseAdmin()` por el harness de `tenant-isolation.test.ts`). Mutación propuesta por el informe (quitar `.eq('account_id', …)` de `updateManagedPricing`) verificada por lectura: la query en `managed-plan.ts:323-326` sí lleva `.eq('account_id', params.accountId)`; sin él el test de fuga fallaría. [x]
- **`getEntitlements()` expone `metaBilling`/`paymentMethod`**: `entitlements.test.ts` › `Meta billing (s10.3, migrations 076/077)` (4 casos, incluido valor desconocido → `direct`/`null` y verificación de columnas+filtro `account_id` en la query). [x]
- **Sync s9.3 no publica oculto sin pedirlo**: `plans/[id]/sync/route.test.ts` › `a hidden plan is published only on purpose (s10.3)` (4 casos: 409 `hidden_plan`, `'true'` string no vale, `confirmHidden:true` publica y sigue oculto, plan público no pide nada). `scripts/paypal-bootstrap-catalog.ts` con `.eq('is_public', true)` confirmado en el diff; test de texto en `managed-plan.test.ts` › `the CLI bootstrap only publishes plans that are for sale`. [x]
- **`confirmHidden: true`**: mismo bloque anterior, leído en `plan-sync.ts:567-574` (`if (!plan.is_public && !allowHidden) throw 'hidden_plan'`) y en `managed-plan.ts:126-131` (`allowHidden: true` fijo en el alta PayPal). [x]
- **«Meta lo paga Cabbity» → acepta `meta_billing='managed'`**: confirmado en `managed.test.ts` › `unticked «Meta lo paga Cabbity»: direct and no price`; wording «Meta lo paga Cabbity CRM» confirmado en `messages/es.json` (`Platform.managed.*`), consistente con `brand.test.ts`. [x]
- **i18n es/en paridad**: comprobado por mí aplanando ambos JSON con un script Python: 46 claves bajo `Platform.managed`/`hiddenBox`, 0 solo-es, 0 solo-en, y placeholders ICU (`{…}`) idénticos entre ambos catálogos. [x]
- **RLS (base real)**: `checks_managed-plan.sql`, corrido por mí contra la réplica — ver sección Compuerta arriba. [x]

## Checkpoints (`CHECKPOINTS.md`)
- CP1 Compuerta: [x] verde, confirmada por el líder (no reejecutada por mí, según instrucción).
- CP2 Migraciones: [x] idempotente, aserción en `verify-schema.sql`, `replay-migrations.sh` verde (reejecutado), sin `CASCADE`.
- CP3 Aislamiento: [x] toda consulta de `managed-plan.ts`, `provisioning.ts`, `accounts.ts`, `entitlements.ts` y las dos rutas filtra por `account_id`/`id`; tests de fuga A↔B(↔C) leídos en tres archivos distintos.
- CP4 Tests: [ ] **un criterio sin test** (idempotencia del alta PayPal repetida, ver hallazgo 1). El resto, cubierto y leído.
- CP5 Sin dependencias nuevas: [x] `package.json`/`package-lock.json` sin diff.
- CP6 i18n: [x] paridad es/en y placeholders verificados por mí.
- CP7 Next 16: [x] `context: { params: Promise<{ id: string }> }` + `await context.params` en ambas rutas, patrón ya usado en el resto del repo (s9.4); no hay API nueva de framework que verificar.
- CP8 Alcance: [x] los 33 archivos corresponden a s10.3; los dos cambios "externos" (`checkout.ts`/`checkout/route.ts` para la constante de marca compartida, `enforce.test.ts` por el fixture de `Entitlements`) son mínimos y justificados por el tipo nuevo.
- CP9 Documentación: [x] `CHANGELOG.md` con aviso de migración 077, `docs/security.md` con sección «The managed plan», informe coincide con el diff.
- CP10 Git: [x] 3 commits en `fg/managed-plan`, español, prefijo, `Co-Authored-By`; nada pusheado; `main` intacto en `005f85a`.
- CP11 Lo entrante nunca se bloquea: n/a — la feature no toca el webhook de WhatsApp ni `isReadOnly()`; reutiliza el `status='incomplete'` ya existente de s9.6, cuyo efecto sobre lo entrante ya está cubierto por esa feature.

## Hallazgos (archivo:línea)

1. **Falta el test de idempotencia explícitamente pedido**: «que repetir la asignación no cree dos suscripciones». `src/lib/platform/managed-plan.ts:90-234` (`assignManagedPlanViaPayPal`) reutiliza `checkoutRequestId` (bucket de 10 min) y el mismo patrón de `checkout_intents.insert` con captura de `23505` que `src/app/api/billing/checkout/route.ts:264-316`. Pero a diferencia de ese archivo — que tiene `src/app/api/billing/checkout/route.test.ts:474` › `'reuses the intent when PayPal replays a subscription we already stored'` (llama `post()` dos veces y comprueba `checkout_intents` con una sola fila) — `src/app/api/platform/accounts/[id]/plan/managed.test.ts` **no llama `call()` dos veces en ningún test** del bloque `describe('paypal', …)` (confirmado con grep: 0 apariciones de una segunda invocación sobre la misma cuenta A). El único test parecido, `reuses the PayPal plan when it already exists (no second publication)` (línea 482), solo prueba que no se republica el **plan** en el catálogo de PayPal (`provider_plan_id_month` ya puesto de antemano), no que repetir el alta con PayPal no duplique la **suscripción**/el intent para la cuenta. Además, el mock de PayPal en este archivo (`usePayPal`, línea ~113) ignora el header `PayPal-Request-Id` y siempre acuña un id nuevo (`minted += 1`), así que ni siquiera simula el comportamiento real de idempotencia de PayPal que el código asume. El mecanismo de defensa (`provider_subscription_id` repetido → `23505` en `checkout_intents`, migración 048) es real y está probado en otro endpoint, pero no en este.
   - **Riesgo concreto**: mientras la cuenta está `incomplete` (antes de que llegue el webhook), `isLivePayPalSubscription` (`provisioning.ts:253-260`) no la bloquea — no tiene `provider_subscription_id` puesto hasta la activación — así que una segunda llamada al mismo endpoint (doble clic del operador, o un reintento) vuelve a llamar a `createSubscription`. El código confía en que PayPal, con el mismo `PayPal-Request-Id`, responde con la MISMA suscripción; eso no está verificado por ningún test del repo para esta ruta.
   - **Cambio requerido**: añadir a `managed.test.ts` un test que llame `call({ planId: 'gestionado', reason: REASON, paymentMethod: 'paypal' })` dos veces sobre A dentro de la misma ventana, con el mock de PayPal devolviendo el mismo `subscriptionId`/approval link en ambas llamadas (como hace `checkout/route.test.ts:474`), y comprobando `h.db.rows('checkout_intents')` con una sola fila y `sub(A)` sin duplicarse.

## Nota sobre decisiones ya juzgadas (sin objeción)
- `plans.meta_pricing` como columna propia: correcto y necesario, verificado contra `validateLimits`/`normalizeLimits`.
- Camino PayPal: reutiliza `checkoutRequestId`, `custom_id`, `checkout_intents`; `incomplete` hasta el webhook; enlace en la ficha (`approvalUrl`, no persistido en base, igual que la invitación) — correcto salvo el hallazgo 1 de arriba.
- `needs_terms`/`no_pricing` 400: correctos y testeados.
- PATCH método de pago: matriz 409 correcta y completa.
- `confirmHidden: true` / bootstrap CLI: coherentes, con tests de ambos lados (`plan-sync.ts` y `paypal-bootstrap-catalog.ts`).
- «Meta lo paga Cabbity»: acepta, wording con «Cabbity CRM» consistente con `brand.test.ts`.

## Cambios requeridos
1. Añadir el test de idempotencia del alta PayPal repetida descrito en el hallazgo 1 (`managed.test.ts`, bloque `paypal`), con el mock de PayPal honrando el `PayPal-Request-Id` como ya hace `checkout/route.test.ts`. Sin esto, CP4 no está satisfecho para este criterio explícito del encargo.

---

## Segunda ronda — s10.3 managed-plan (rango 52809ed..4917f86, HEAD 4917f86)

**Veredicto final:** APPROVED

Un solo commit (`4917f86`), mensaje en español con prefijo y `Co-Authored-By`, árbol limpio, sin push. Diff: `src/lib/billing/paypal.ts` (+20), `src/lib/platform/managed-plan.ts` (+167/-45), `src/app/api/platform/accounts/[id]/plan/route.ts` (+14), `src/components/platform/platform-provisioning.tsx` (+4), `messages/{es,en}.json` (+3 cada uno, paridad), `managed.test.ts` (+227). Sin tocar `supabase/` ni `package.json` (confirmado con `git diff --stat`), así que no volví a correr `replay-migrations.sh`/`checks_managed-plan.sql` — ya verdes de la primera ronda y la migración no cambió.

### El hallazgo 1 de la primera ronda, cerrado
Leído `src/lib/platform/managed-plan.ts:171-227` (la nueva sección «0.»): antes de llamar a PayPal, `findPendingAttempt` busca el `checkout_intents` `pending` más reciente de esa cuenta+plan (filtrado `account_id`/`provider`/`plan_id`/`status`), y si existe, pregunta a PayPal (`getSubscription`) por su estado real:
- `APPROVAL_PENDING` con enlace → se reutiliza el mismo `subscriptionId`/`approvalUrl`, sin segundo POST a `/v1/billing/subscriptions`, sin segundo intent (el insert se salta con `reused ? {error:null} : ...insert(...)`), sin republicar el plan (`providerPlanId = reused?.providerPlanId ?? …`).
- `APPROVED`/`ACTIVE` (el dueño ya aprobó, el webhook viene en camino) → `{ ok:false, reason:'checkout_in_progress' }`, mapeado a 409 en la ruta, nada se escribe (confirmado: el `return` ocurre antes de cualquier paso de escritura).
- Cualquier otro estado o 404 → se cierra el intent viejo (`UPDATE … SET status='cancelled' WHERE account_id=… AND id=…`, doblemente filtrado por cuenta y por id) y se sigue el camino normal (nueva suscripción, nuevo intent).

### Falla cerrado si PayPal no responde (verificado por lectura, lo que pedía el encargo)
`getSubscription` (`paypal.ts:433-448`) usa `paypalFetch`, que lanza `PayPalError` en cualquier respuesta no-2xx y deja propagar cualquier fallo de red (el `fetch` del intento revienta antes de llegar a `res.ok`). En `managed-plan.ts:180-184`:
```
try { remote = await read(pending.provider_subscription_id); }
catch (err) { if (!(err instanceof PayPalError && err.status === 404)) throw err; }
```
Solo el 404 explícito se traga (significa «esa suscripción ya no existe»); cualquier otro error —500, timeout, red caída, lo que sea— se relanza. Ese throw ocurre **antes** del paso 2 (crear suscripción), paso 3 (bitácora) y paso 4 (intent), así que nada se escribe. En la ruta, `assignWithPayPal` (`route.ts:286-313`) captura `PayPalError` y responde 502 «nothing changed» — mismo camino ya probado para el fallo de `createSubscription` (`502s when PayPal refuses the subscription`). No hay un test dedicado que simule un 500 del `GET /v1/billing/subscriptions/:id` (solo hay casos para `APPROVAL_PENDING`, `EXPIRED`, `404`, `ACTIVE`), pero el código que lo cubre es el mismo `try/catch` de una línea y comparte el mapeo de errores ya testeado para el POST — no encontré ninguna razón para dudar de la lectura. Queda como mejora menor, no bloqueante: un test `remoteStatus['I-NEW-1'] = '500'` (o `read` rechazando) junto a los otros cinco de `repeating it (idempotency)` cerraría esto del todo.

### `cancelled` no pisa un intent de otra cuenta (verificado)
`findPendingAttempt` (líneas 92-111) filtra `.eq('account_id', accountId)` antes de devolver `pending`; el cierre del intent viejo (líneas 216-222) vuelve a filtrar `.eq('account_id', params.accountId).eq('id', pending.id)` — doble scoping, aunque `id` ya es único. El test `"another company's pending checkout is never reused (A↔B)"` siembra un intent `pending` de B y comprueba que A nunca llama a `GET …/I-B-PENDING` y que el intent de B sigue `pending` tras la asignación de A — cubre el caso de lectura cruzada; el de escritura cruzada (que el `UPDATE cancelled` de A no toque una fila de B) no tiene un test que lo ejercite directamente (ningún test deja un intent `pending` de OTRA cuenta que debiera expirar a la vez), pero el filtro doble en el `UPDATE` hace la fuga imposible por construcción, igual que el resto de escrituras de este archivo (ya auditadas en la primera ronda).

### Tests nuevos, leídos uno a uno
`managed.test.ts` › `paypal` › `repeating it (idempotency)` (6 casos): doble clic (`subscriptionPosts()` longitud 1, un solo intent, una sola fila de suscripción, `plan_provider_history` con una sola fila), pasadas las 10 min del bucket de `PayPal-Request-Id` (con `vi.useFakeTimers`, mismo resultado), enlace caducado (`EXPIRED` → cierra y abre otro, dos intents con los estados correctos), 404 (mismo efecto que caducado), `ACTIVE` → 409 sin escribir nada (snapshot completo de `h.db.tables` sin cambios), y A↔B. El mock de PayPal ahora sí honra `PayPal-Request-Id` (`byRequestId` Map) y expone `GET /v1/billing/subscriptions/:id`; el `supabaseAdmin` fake para `checkout_intents` aplica el UNIQUE (provider, provider_subscription_id) de la migración 048 vía `23505`, igual que hace `checkout/route.test.ts`. Esto corrige exactamente el defecto que señalé en la primera ronda: ya no hace falta confiar en que PayPal nunca duplique: ahora el código consulta el estado antes de volver a pedir una suscripción, y el mock deja de fingir una idempotencia que el código real de PayPal no garantiza fuera de los 10 minutos.

### Resto de CHECKPOINTS, sin novedad
CP3 (aislamiento): todas las consultas nuevas filtran por `account_id` (`findPendingAttempt`, el `UPDATE … cancelled`). CP5 (sin dependencias nuevas): confirmado, sin diff en `package.json`. CP6 (i18n): `checkoutInProgress` presente y con el mismo texto en es/en (traducción fiel, sin placeholders). CP8 (alcance): los 7 archivos tocados son exactamente los que el fix requiere. CP10 (git): commit único, bien formado, sin push.

### Hallazgo menor (no bloqueante)
1. No hay un test que simule explícitamente que `GET /v1/billing/subscriptions/:id` falla con un error que no sea 404 (p. ej. 500) para probar el camino «falla cerrado» por test además de por lectura de código. Recomendado para una futura pasada, no bloquea esta.

APPROVED
