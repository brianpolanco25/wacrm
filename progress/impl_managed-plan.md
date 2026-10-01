# impl s10.3 `managed-plan`

## Plan
1. Migración `077_plan_gestionado.sql`: columna `plans.meta_pricing jsonb NOT NULL DEFAULT '{}'` (CHECK objeto), plan `gestionado` (oculto, 1.036/mes, sin anual, límites de `negocio` con `messages_out`/`broadcast_recipients` a null, `numbers` 3, todas las features, descripción, política de precio por defecto), `subscriptions.payment_method text CHECK IN ('paypal','manual')` nullable. Idempotente; bloque `-- 077` en `verify-schema.sql`.
2. Lib: `listPlanOptions` devuelve la política por defecto del plan; `overridePlan` acepta condiciones gestionadas (manual: activo, ciclo mensual, corte a un mes, `payment_method`, `meta_billing`, `meta_pricing`); un plan sin política deja la cuenta en `direct`. `src/lib/platform/managed-plan.ts`: alta con PayPal (sync s9.3 si falta el plan, `createSubscription`, `checkout_intents`, fila `incomplete`), edición posterior (`updateManagedPricing`).
3. Rutas: `POST /api/platform/accounts/[id]/plan` extendida (`paymentMethod`, `metaBilling`, `metaPricing`), `PATCH /api/platform/accounts/[id]/meta-pricing` nueva.
4. Sync s9.3: un plan oculto solo se publica con `confirmHidden: true` (casilla en el diálogo de `/platform/plans`); el bootstrap CLI solo publica planes públicos.
5. `getEntitlements()` expone `metaBilling` y `paymentMethod`; ficha (`loadAccountDetail`) los muestra.
6. UI: campos gestionados en «Asignar plan a mano», enlace de checkout en la ficha, bloque «Precio de Meta gestionado»; i18n `Platform.managed` (es/en).
7. Tests (rutas, lib, fuga A↔B, catálogo público, entitlements), réplica + `progress/checks_managed-plan.sql`, CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer)

Rama `fg/managed-plan` (worktree `.claude/worktrees/fg-managed-plan`), base `feat/facturacion-gestionada` @ 194e4e6. Sin push. Commits: ver «Commits» al final.

## Archivos
- `supabase/migrations/077_plan_gestionado.sql`; `supabase/ci/verify-schema.sql` (bloque `-- 077` tras `/076`, y el recuento de planes de la 074 pasa de 4 a 5).
- Lib: `src/lib/platform/managed-plan.ts` (nuevo: alta con PayPal, edición del precio), `src/lib/platform/provisioning.ts` (`PlanOption.metaPricing`, `planPricingOf`, `loadAssignablePlan`, `loadCurrentSubscription` exportada, `manualPlanRow`/`overridePlan` con condiciones gestionadas), `src/lib/platform/accounts.ts` (ficha: `metaBilling`, `metaPricing`, `paymentMethod`), `src/lib/billing/entitlements.ts` (`metaBilling`, `paymentMethod`, `asMetaBilling`, `asPaymentMethod`), `src/lib/billing/plan-sync.ts` (`allowHidden`, código `hidden_plan`), `src/lib/billing/checkout.ts` (`CHECKOUT_BRAND_NAME`, reutilizado por la ruta de checkout).
- Rutas: `src/app/api/platform/accounts/[id]/plan/route.ts` (extendida), `src/app/api/platform/accounts/[id]/meta-pricing/route.ts` (nueva, PATCH), `src/app/api/platform/plans/[id]/sync/route.ts` (`confirmHidden`), `src/app/api/billing/checkout/route.ts` (solo la constante de marca).
- `scripts/paypal-bootstrap-catalog.ts`: solo carga planes `is_public = true`.
- UI: `src/components/platform/managed-form.ts` (nuevo, puro), `src/components/platform/platform-managed.tsx` (nuevo: `ManagedTermsFields`, `PricingFields`, `CheckoutLinkNotice`, `ManagedPricingCard`, `saveManagedPricing`), `platform-provisioning.tsx` (`PlanAssignment` con los campos gestionados y `onCheckoutLink`), `platform-account-detail.tsx` (enlace de checkout guardado por la ficha + bloque «Precio de Meta gestionado»), `platform-plans.tsx` (casilla «publicar igualmente» para planes ocultos en el diálogo de sync).
- i18n: `Platform.managed.*` (namespace nuevo, es/en) y `Platform.plans.confirm.hiddenBox` (es/en). `src/i18n/messages.test.ts`: dos claves idénticas justificadas.
- Docs: `CHANGELOG.md` (Unreleased, con aviso de migración), `docs/security.md` («The managed plan»).
- Tests: ver tabla.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| 077: plan `gestionado` oculto, 1036/mes, sin anual, límites de `negocio` con `messages_out`/`broadcast_recipients` null, `numbers` 3, todas las features, descripción, política por defecto; `payment_method` CHECK nullable | `verify-schema.sql` bloque `-- 077`; `src/lib/billing/managed-plan.test.ts` › `plan gestionado (077)` (5 casos: oculto/precio, límites = negocio sin tope, todas las features, política válida para `parseMetaPricing`, ON CONFLICT DO NOTHING); `checks_managed-plan.sql` 1a–1c, 2 |
| Idempotente, una edición del operador sobrevive a una segunda pasada | `checks_managed-plan.sql` 5 (reaplica la 077 con `\i`); réplica completa |
| RLS: el inquilino no cambia su `meta_billing`/`meta_pricing`/`payment_method` (ni el corte, ni el plan) | `checks_managed-plan.sql` 3a–3e (UPDATE 0 filas, DELETE 0, INSERT `insufficient_privilege`, `plans` no editable), 4 (anon) |
| POST plan: 401/403 | `accounts/[id]/plan/managed.test.ts` › `401s without a session, and nothing moves`, `403s a company owner — on his own company too — and nothing moves`; `tenant-isolation.test.ts` › `s10.3: 403s the owner of A on the managed plan and its price, and moves nothing` |
| POST plan: 400 validación del precio (con `meta-pricing.ts`) | `managed.test.ts` › `400s %s, and writes nothing` (6 casos: método desconocido, meta_billing desconocido, categoría ausente, multiplicador 0, cuota con 3 decimales, precio vacío con «Meta lo paga Cabbity»), `400s the managed plan given blind (no payment method): needs_terms`, `400s PayPal for a plan without a price policy` |
| POST plan manual: `provider manual`, `active`, `cycle month`, `current_period_end = now + 1 mes`, `payment_method manual`, `meta_pricing` guardado; bitácora con método, `meta_billing`, `meta_pricing` | `managed.test.ts` › `200: manual, active, monthly, cut-off in a month, the price stored — company A only`, `stores an edited price (fixed USD for marketing) instead of the default`, `unticked «Meta lo paga Cabbity»: direct and no price`; `provisioning.test.ts` › `manualPlanRow with managed terms (s10.3)` (3 casos, incluido el recorte 31-ene → 28-feb), `overridePlan with a plan that carries a Meta price policy (s10.3)` (3 casos: needs_terms, copia el precio del plan + orden bitácora→upsert, precio editado) |
| POST plan paypal: el plan se crea en PayPal si falta (sync s9.3), suscripción para la cuenta, `checkout_intents`, cuenta `incomplete`, enlace de checkout en la respuesta | `managed.test.ts` › `200: publishes the hidden plan, creates the subscription for A, leaves A incomplete, hands back the link` (llamadas a PayPal en orden, `custom_id`, `return_url` de onboarding, `PayPal-Request-Id` de checkout, fila de historial, intent, fila `incomplete`, B sin tocar, bitácora con `provider_subscription_id`), `reuses the PayPal plan when it already exists (no second publication)`, `502s when PayPal refuses the subscription: no trail, no intent, A unchanged`, `503s without PayPal credentials, and nothing moves`, `409s company B (PayPal still billing) before calling PayPal` |
| Fuga A↔B | `managed.test.ts` (base falsa con A y B: B nunca cambia; 409 en B con PayPal vivo); `meta-pricing/route.test.ts` › `200: changes A only…` (A, B y C); `tenant-isolation.test.ts` › `s10.3: gives ONE company the managed plan by hand — price and method on its row only`, `s10.3: changes the Meta price of ONE managed company — A and B untouched` (+ auditoría automática de consultas de rol de servicio). Comprobado por mutación: quitar `.eq('account_id', …)` del UPDATE de `updateManagedPricing` hace fallar el test |
| PATCH meta-pricing: 401/403, motivo ≥10, validación, 404 | `meta-pricing/route.test.ts` › `the guard` (2), `400s %s, and writes nothing` (7), `404s a malformed id and a company that does not exist` |
| PATCH: bitácora con antes/después; nada si no cambia; 500 sin escribir si falla la bitácora; 409 cuenta `direct` | `meta-pricing/route.test.ts` › `200: changes A only, with before/after in the trail`, `writes neither the trail nor the row when nothing changes`, `500s and changes nothing when the trail cannot be written`, `409s a company Cabbity does not pay Meta for (direct)` |
| PATCH: `payment_method` sin doble cuota | `meta-pricing/route.test.ts` › `409s manual while PayPal is still billing the fee (B)`, `409s paypal with no live PayPal subscription (A)…`, `moves to manual once PayPal no longer bills (cancelled)` |
| `gestionado` nunca en `PlanPicker`, `/api/billing/plans`, onboarding | `src/app/api/billing/plans/route.test.ts` › `never lists the managed plan of the 077, even once it is published to PayPal (s10.3)`; `managed-plan.test.ts` › `a customer never sees it` (PlanPicker y onboarding solo leen `/api/billing/plans`; la ruta filtra `is_public` en la consulta; el checkout rechaza `!plan.is_public`); `checkout/route.test.ts` › `404s on an unknown or non-public plan` (preexistente: un plan oculto con id de PayPal da 404 sin llamar a PayPal) |
| El sync de s9.3 no publica un plan oculto salvo petición explícita | `plans/[id]/sync/route.test.ts` › `a hidden plan is published only on purpose (s10.3)` (4: 409 `hidden_plan` sin llamar a PayPal, `'true'` en texto no vale, `confirmHidden: true` publica y sigue oculto, un plan público no pide nada); `managed-plan.test.ts` › `the CLI bootstrap only publishes plans that are for sale` |
| `getEntitlements()` expone `metaBilling` y `paymentMethod` | `entitlements.test.ts` › `Meta billing (s10.3, migrations 076/077)` (4 casos: managed+manual, paypal, fila vieja/sin fila = direct/null, valor desconocido nunca es managed; la consulta sigue filtrada por `account_id`) |
| `listPlanOptions` da la política por defecto para precargar | `provisioning.test.ts` › `listPlanOptions (s10.3)` |
| UI: campos al elegir `gestionado`, casilla marcada por defecto, precio precargado; nada extra para otros planes; enlace de checkout guardado por la ficha; bloque «Precio de Meta gestionado» solo para `managed` | `platform-managed.test.tsx` › `«Asignar plan a mano» with the managed plan` (3), `ManagedTermsFields` (2), `the PayPal link on the file` (3), `«Precio de Meta gestionado»` (render + 7 respuestas de `saveManagedPricing`) |
| Formulario ↔ `meta_pricing` | `platform-managed.test.tsx` › `managed-form` (precarga e ida y vuelta, USD fijo gana, coma decimal, 4 rechazos, política vacía/rota, cuerpo de la ruta) |
| i18n es/en | `platform-managed.test.tsx` › `every key exists in es AND en (CP6)` (todas las claves `t(…)` de `platform-managed.tsx`, las `tm(…)` de `platform-provisioning.tsx`, las de plantilla, y `Platform.plans.confirm.hiddenBox`); `src/i18n/messages.test.ts` y `brand.test.ts` |

## Commits (rama `fg/managed-plan`, HEAD 52809ed, sin push)
| Commit | Qué |
|---|---|
| `c40f1ca` | feat: migración 077 + bloque `-- 077` de `verify-schema.sql` (recuento de planes 4 → 5) |
| `c4a3024` | feat: libs, rutas, UI, i18n `Platform.managed` (es/en), tests |
| `52809ed` | docs: CHANGELOG (aviso de migración 077) y `docs/security.md` |

## Compuerta (worktree, HEAD 52809ed)
- `npm run lint`: 0 errores, 34 warnings (las mismas preexistentes; ninguna en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 265 archivos, **3768 tests** en verde. (Una primera pasada con la máquina a carga ~18 dio «Timeout waiting for worker» al arrancar un worker, sin ningún test fallido; la repetición salió limpia en 16 s.)
- `npm run build` (variables dummy): verde; aparecen `ƒ /api/platform/accounts/[id]/meta-pricing` y `/plan`.
- `scripts/replay-migrations.sh <worktree>`: salida 0, `ok 077_plan_gestionado.sql`, `verify-schema.sql: OK`.

## Verificaciones contra base real
`progress/checks_managed-plan.sql` contra la réplica (`KEEP=1`, más `docker cp` de la 077 a `/tmp`): salida 0, `ok 1a` … `ok 5`. Cubre el plan y su precio, los CHECK, la RLS (el propietario de A lee su fila pero UPDATE de `meta_billing`/`meta_pricing`/`payment_method`/`current_period_end` y DELETE tocan 0 filas, INSERT da `insufficient_privilege`, no ve la fila de B, no puede editar ni publicar `gestionado`), anon sin acceso, y la reaplicación idempotente que respeta lo que editó el operador.
Nota del guion: el paso 4 limpia las claims del JWT antes de pasar a `anon`; si no, `auth.uid()` sigue devolviendo A y la política `subscriptions_select` (041, sin `TO`) devuelve su fila. Un anon real no trae `sub`, así que es cosa del guion, no un fallo.

## Verificaciones manuales pendientes (dependen de PayPal real)
1. Sandbox de PayPal configurado (`PAYPAL_CLIENT_ID/SECRET`, `PAYPAL_ENV=sandbox`). En la ficha de una empresa: «Asignar plan» → `Gestionado` → método PayPal, precio por defecto, motivo → confirmar. Comprobar que aparece «Enlace de pago de PayPal», que `/platform/plans` muestra `gestionado` mes «sincronizado» y que la empresa queda `incomplete` (solo lectura).
2. Abrir el enlace con una cuenta de comprador del sandbox, aprobar → vuelve a `/onboarding/return`; al llegar `BILLING.SUBSCRIPTION.ACTIVATED`, la fila queda `active` con `provider_subscription_id`, `current_period_end` y `cycle month`, y siguen intactos `payment_method = paypal`, `meta_billing = managed` y `meta_pricing`.
3. Repetir en menos de 10 minutos: el mismo `PayPal-Request-Id` devuelve la misma suscripción y el intent no se duplica.
4. En `/platform/plans`, sincronizar `ilimitado`/`gestionado`: sin marcar la casilla el botón está desactivado; marcándola se publica.
5. Manual: asignar `Gestionado` con pago manual → `active`, corte a un mes; bloque «Precio de Meta gestionado» → cambiar marketing a USD fijo con motivo → aparece en la bitácora (`details.before/after`).

## Decisiones donde la spec era ambigua
1. **`plans.meta_pricing` como columna, no `plans.limits.meta_pricing`.** `normalizeLimits` la habría descartado al leer, así que no rompía los topes. Pero `validateLimits` rechaza claves desconocidas, y el editor de s9.3 reescribe `limits` con sus ocho claves: la primera edición del plan la habría borrado sin aviso. La política vive en una columna propia `NOT NULL DEFAULT '{}'` con CHECK de objeto.
2. **El enlace de checkout existente** es el `approvalUrl` de PayPal. El operador crea la suscripción **para esa cuenta** con la misma llamada (`createSubscription`), el mismo `custom_id`, la misma clave de idempotencia (`checkoutRequestId`) y la misma fila `checkout_intents` que el checkout del inquilino; el webhook la activa sin cambios. No toqué `/api/billing/checkout`, que sigue rechazando planes ocultos. El enlace se ve una vez en la ficha (lo guarda la ficha, como el de invitación) y no se guarda en base.
3. **Orden en PayPal:** comprobaciones → PayPal (publicar plan si falta, crear la suscripción) → bitácora con `provider_subscription_id` → intent → fila. Si PayPal falla, no se escribe nada de la cuenta; una suscripción pendiente sin aprobar caduca sola, igual que en el checkout. El plan solo se publica si le falta id; si ya tiene uno se usa tal cual (no se republica aunque el precio cambie).
4. **Fila con PayPal:** `provider = 'paypal'`, `status = 'incomplete'`, `provider_subscription_id = NULL` (el webhook encuentra la cuenta por el intent), `cycle = 'month'`. `provider` se fija antes porque el webhook no lo escribe.
5. **Casilla «Meta lo paga Cabbity» sin marcar:** `meta_billing = 'direct'` y `meta_pricing = {}`; los campos de precio se ocultan y lo que traiga el cuerpo se ignora.
6. **Un plan sin política** asignado a mano (incluido salir de `gestionado`) deja la cuenta en `direct`, `{}` y `payment_method NULL`. Una política de precio solo tiene sentido con el paquete del plan. Esto cambia `manualPlanRow` de s9.4 (su test se actualizó).
7. **`gestionado` sin condiciones → 400 `needs_terms`**, también desde «Nueva empresa». Allí el paso del plan falla de forma suave (`planError`, el aviso que ya existía) y se termina desde la ficha.
8. **`metaPricing` omitido** → se usa el precio por defecto del plan. Un `{}` explícito con `managed` → 400.
9. **PATCH y `payment_method`:** a `manual` con PayPal todavía cobrando → 409 `paypal_active`; a `paypal` sin suscripción viva → 409 `needs_checkout` (se usa «Asignar plan» con PayPal). Así s10.4 nunca cobra la cuota dos veces ni la deja sin cobrar. El PATCH no toca `status` ni `provider`. Si no hay nada que cambiar, responde 200 `changed:false` sin bitácora.
10. **Bitácora:** `action = 'plan_override'` (la spec no cambia el CHECK). El PATCH escribe `details.kind = 'meta_pricing'` con `before`/`after`; el alta, `payment_method`, `meta_billing`, `meta_pricing`, `from_meta_billing`, y en PayPal además `provider_plan_id`, `provider_subscription_id` y `paypal_plan_published`.
11. **Sync de planes ocultos:** la ruta exige `confirmHidden: true` (literal booleano), y en el diálogo de `/platform/plans` hay una casilla obligatoria. `syncPlanCycle` tiene `allowHidden` (por defecto `false`), y lo pone a `true` el alta con PayPal. También añadí `.eq('is_public', true)` al bootstrap CLI, que habría publicado `gestionado` en bloque.
12. **i18n:** namespace nuevo `Platform.managed`, no `Platform.provisioning`. Así la comprobación de claves de `platform-provisioning.tsx` sigue siendo de un solo namespace, y el traductor nuevo se llama `tm`. `brand.test.ts` exige «Cabbity CRM» en cada mención, por eso la etiqueta es «Meta lo paga Cabbity CRM».
13. **Formulario:** cada categoría se edita de una sola forma (multiplicador o USD fijo). Si una categoría guardada trae las dos, se muestra el importe fijo (que es el que gana) y al guardar se conserva solo ese. Se acepta coma decimal.
14. **`sort_order` 90** para `gestionado`. La migración usa `ON CONFLICT DO NOTHING` (no `DO UPDATE` como la 074) para no pisar las ediciones del operador, y siembra la política solo si está vacía.

## Variables de entorno nuevas
Ninguna. `docs/docker.md` sin cambios; `.env.local.example` no se tocó.

## Deuda detectada fuera de alcance
- `subscriptions_select` (041) no lleva `TO authenticated`: un rol `anon` con claims de JWT ajenas leería la fila. En la práctica PostgREST no da `sub` a anon; anotarlo para una migración de endurecimiento.
- `plans` es legible por cualquier autenticado (041), así que cualquier inquilino puede leer el precio por defecto de `gestionado` (`plans.meta_pricing`), igual que ya lee `limits` y precios. No es secreto de cuenta, pero conviene saberlo.
- Un propietario `incomplete` con PayPal pendiente que entra al onboarding ve el `PlanPicker` público y podría contratar otro plan antes de aprobar el enlace. El webhook activaría el que pague primero; el otro intent quedaría pendiente. El onboarding no sabe que hay un checkout del operador pendiente.
- La bitácora de la ficha muestra la acción y el motivo, pero no `details` (deuda ya anotada en s9.4): el antes/después del precio solo se ve por API.
- Conflictos triviales de merge previsibles: `verify-schema.sql` (bloque tras `/076`), `messages/*.json` (`Platform.managed` al final de `Platform`), `tenant-isolation.test.ts` (tests dentro del bloque de s9.4), `CHANGELOG.md`.

## Segunda ronda (review CHANGES_REQUIRED: idempotencia del alta con PayPal)

Commit `4917f86` (fix) sobre `52809ed`. HEAD = `4917f86`. Sin push.

**Se confirmó el riesgo y se corrigió el código.** Mientras la cuenta está `incomplete` no tiene `provider_subscription_id`, así que `isLivePayPalSubscription` no la frena. PayPal solo repite la misma suscripción para el mismo `PayPal-Request-Id`, y `checkoutRequestId` cambia cada 10 minutos. Así, repetir la asignación pasado ese tiempo creaba una **segunda** suscripción y un segundo intent, con dos enlaces vivos.

Lo confirmé por mutación: sin la reutilización, el test «hours later…» falla con dos `POST /v1/billing/subscriptions` y dos intents.

| Cambio | Dónde |
|---|---|
| `getSubscription(id)`: estado y enlace `approve` de una suscripción | `src/lib/billing/paypal.ts` |
| Antes de llamar a PayPal, `assignManagedPlanViaPayPal` busca el `checkout_intents` `pending` más reciente de **esa cuenta** y ese plan (filtrado por `account_id`) y pregunta a PayPal. `APPROVAL_PENDING` → reutiliza el mismo id y enlace, sin crear suscripción, sin intent nuevo y sin republicar el plan. `APPROVED`/`ACTIVE` → `checkout_in_progress`. Otro estado o 404 → marca el intent `cancelled` (filtrado por cuenta e id) y abre uno nuevo. La fila de `subscriptions` y la bitácora se escriben igual en cada asignación; la bitácora lleva `reused_pending_checkout`. | `src/lib/platform/managed-plan.ts` |
| Ruta: 409 `checkout_in_progress`; la respuesta 200 lleva `reused` | `src/app/api/platform/accounts/[id]/plan/route.ts` |
| UI: aviso `Platform.managed.errors.checkoutInProgress` (es/en) | `platform-provisioning.tsx`, `messages/{es,en}.json` |

Tests nuevos en `src/app/api/platform/accounts/[id]/plan/managed.test.ts` › `paypal` › `repeating it (idempotency)`. El mock de PayPal ahora honra `PayPal-Request-Id` (misma clave → misma suscripción y enlace) y atiende `GET /v1/billing/subscriptions/:id`. El cliente falso aplica el UNIQUE de la 048 (`23505` en `checkout_intents`). Casos:
- `twice in a row (double click): one subscription, one intent, the same link`: un solo POST de suscripción, una fila en `checkout_intents`, una fila de `subscriptions` de A y una de historial. Es el equivalente de `checkout/route.test.ts:474`.
- `hours later, past the ten-minute PayPal-Request-Id bucket: still no second subscription`: el caso que antes duplicaba.
- `a pending link PayPal let expire is closed and a new one opened`: el intent viejo queda `cancelled` y el nuevo `pending`.
- `a subscription PayPal no longer knows (404) counts as gone`.
- `409s once the owner already approved it (webhook on its way), and creates nothing`.
- `another company's pending checkout is never reused (A↔B)`: no se consulta la suscripción de B a PayPal y su intent sigue `pending`.

Decisión: se reutiliza el intent pendiente aunque el plan se hubiera republicado en PayPal a otro precio entre las dos asignaciones. Es raro (requiere cambiar el precio de `gestionado` durante la ventana de aprobación); si pasa, el operador puede esperar a que caduque el enlace. Queda como deuda.

### Compuerta (HEAD 4917f86)
- `npm run lint`: 0 errores, 34 warnings preexistentes.
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 265 archivos, **3774 tests** en verde.
- `npm run build` (variables dummy): verde.
- `scripts/replay-migrations.sh`: salida 0, `verify-schema.sql: OK`; `progress/checks_managed-plan.sql`: salida 0, los 11 NOTICE `ok`. La migración no cambió en esta ronda.
