# impl s9.3 `plans-admin`

## Plan
1. Migración `070_plan_provider_history.sql`: tabla `plan_provider_history` (FK RESTRICT a `plans`, self-FK SET NULL, CHECKs, RLS con SELECT solo `is_platform_admin()`), `plans.created_at/updated_at/description` + trigger `set_updated_at`; aserciones `-- 070` en `verify-schema.sql`.
2. `src/lib/billing/plan-catalog.ts`: inventario de métricas (`limits`) y features; validación estricta de alta/edición; test contra la semilla 041 y contra `assertPlanFeature`/`assertQuota`/`assertStockLimit` del código.
3. `src/lib/billing/paypal-catalog.ts`: lo compartible del bootstrap (nombre de producto, `money`, buscar-o-crear producto, nombre/descripción del plan); el script lo reutiliza sin cambiar su comportamiento.
4. `src/lib/billing/plan-sync.ts`: estado de sincronización por ciclo (puro) + `syncPlanCycle` (crear / sustituir / no-op / verificar contra PayPal).
5. Rutas `GET/POST /api/platform/plans`, `PATCH /api/platform/plans/[id]`, `POST /api/platform/plans/[id]/sync` (historial incluido en el GET).
6. UI `/platform/plans`: `PlatformPlans` (tabla, editor en diálogo, sync con confirmación, historial desplegable, `PAYPAL_ENV`).
7. i18n `Platform.plans` es/en/ko.
8. Tests (rutas, validación, sync, fuga en tenant-isolation), SQL real en `progress/checks_plans-admin.sql`.
9. CHANGELOG, compuerta, replay, commits.

## Estado: done (pendiente de reviewer)

Rama `platform/plans` (worktree `.claude/worktrees/platform-plans`), base `feat/superadmin` @ 785c3ae. Sin push.

| Commit | Qué |
|---|---|
| `4452d7b` | feat: migración 070 + `plan-catalog`, `paypal-catalog`, `plan-sync`, `getPlan`, rutas `/api/platform/plans*`, tests y fuga en tenant-isolation |
| `ad221b8` | feat: UI `/platform/plans` (`PlatformPlans`, `plan-form`), i18n `Platform.plans` es/en/ko, CHANGELOG |

## Compuerta (ejecutada en el worktree, HEAD ad221b8)
- `npm run lint`: 0 errores, 35 warnings (los mismos 35 preexistentes; ninguno en archivos nuevos).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 216 archivos, **2894 tests** en verde (base: 208 / 2770).
- `npm run build` (variables dummy): verde; aparecen `/api/platform/plans`, `/api/platform/plans/[id]`, `/api/platform/plans/[id]/sync`, `/platform/plans`.
- `scripts/replay-migrations.sh "$(pwd)"`: salida 0 (`ok 070_plan_provider_history.sql`, `verify-schema.sql: OK`).

## Archivos
- `supabase/migrations/070_plan_provider_history.sql` — tabla, FKs (plan RESTRICT, `replaced_by` SET NULL), CHECKs de ciclo y entorno, índice único `(provider, provider_env, provider_plan_id)`, índice por plan/ciclo, RLS con SELECT solo `is_platform_admin(auth.uid())`, sin políticas de escritura; `plans.created_at/updated_at/description` + trigger `set_updated_at`.
- `supabase/ci/verify-schema.sql` — bloque `-- 070 … -- /070` justo antes del `RAISE NOTICE` final (dentro del único DO, como exige el archivo): tabla, RLS, política SELECT, ninguna política de escritura en la tabla nueva **ni en `plans`**, las dos FKs con su `confdeltype`, los dos CHECK, los dos índices, las tres columnas y el trigger.
- `src/lib/billing/plan-catalog.ts` — `PLAN_LIMIT_KEYS` (8), `PLAN_FEATURES` (7), `PLAN_ID_RE`, `validatePlanInput/validateLimits/validateFeatures`.
- `src/lib/billing/paypal-catalog.ts` — `DEFAULT_PRODUCT_NAME`, `money`, `ensureProduct`, `paypalPlanName/Description`, `productNameFromEnv`, `PayPalCatalogueClient`. Solo importa tipos de `./paypal.ts`, así el script sigue corriendo con `node scripts/…`.
- `scripts/paypal-bootstrap-catalog.ts` — usa el módulo compartido; sigue exportando `DEFAULT_PRODUCT_NAME`, `PayPalCatalogueClient`, `bootstrapCatalog` (mismo comportamiento, mismos `requestId …-v1`; su test sin cambios y verde; `node --experimental-strip-types` lo importa).
- `src/lib/billing/paypal.ts` — añade `getPlan(id)` (lee el precio del ciclo REGULAR). Único cambio.
- `src/lib/billing/plan-sync.ts` — estado por ciclo (puro), `loadPlatformPlans/loadPlatformPlan`, `syncPlanCycle`.
- `src/lib/platform/plans.ts` — `createCatalogPlan`, `updateCatalogPlan` (rol de servicio, por id).
- `src/app/api/platform/plans/route.ts` (GET, POST), `[id]/route.ts` (PATCH), `[id]/sync/route.ts` (POST).
- `src/components/platform/platform-plans.tsx`, `plan-form.ts`; `src/app/(platform)/platform/plans/page.tsx` monta `PlatformPlans`.
- `src/lib/billing/plan-admin.test-support.ts` — semilla y `fetch` falso de PayPal para los tests (no lo importa código de producción).
- `messages/{es,en,ko}.json` — solo `Platform.plans.*` (bloque nuevo, misma estructura en los tres).
- `CHANGELOG.md` — sección nueva al final de Unreleased.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| GET lista todas (públicas u ocultas), orden, `providerEnv` | `src/app/api/platform/plans/route.test.ts` › `lists every plan, public or not, in sort order, with the PayPal env`; `says live when PAYPAL_ENV=live and flags missing credentials` |
| Estado por ciclo: sin publicar / sincronizado / precio desincronizado / verificar | mismo › `reports the sync state per cycle: unpublished, synced, price mismatch, unknown`; `src/lib/billing/plan-sync.test.ts` › `cycleSync` (5 casos: fila cerrada, id distinto, ciclo distinto, precio a 0 → desincronizado) |
| 401/403 en las cuatro rutas | `plans/route.test.ts` › `401s without a session`, `403s a company owner`, `401s and 403s without writing`; `[id]/route.test.ts` › `401s…`, `403s a company owner and leaves plans untouched`; `[id]/sync/route.test.ts` › `401s without a session and touches nothing`, `403s a company owner — owning an account buys nothing here` |
| Fuga: un owner no escribe en `plans` | `src/lib/security/tenant-isolation.test.ts` › `/api/platform/plans (catalogue writes, service role)` › `403s the owner of account A on every plan route, and writes nothing`; `an operator's catalogue edits move nothing of either company` (auditoría de rol de servicio con waivers razonados); SQL 1a–1f, 2a–2b |
| POST: slug `^[a-z][a-z0-9_-]{1,31}$`, campos, 201, 409 duplicado | `plans/route.test.ts` › `creates a plan with no PayPal id and answers 201`, `400s %s` (7 casos), `400s a body that is not JSON`, `409s an id that already exists`; `plan-catalog.test.ts` › `refuses an id with %s` (6), `accepts the seeded ids as slugs`, `requires %s` |
| PATCH: mismos campos, el id no cambia, sin DELETE | `[id]/route.test.ts` › `updates the fields sent and nothing else`, `400s any attempt to change the id`, `400s invalid limits, features and PayPal ids`, `404s a plan that does not exist, and a malformed id`, `has no DELETE: a plan is unpublished, not deleted` |
| Editar precio no toca PayPal y marca desincronizado | `[id]/route.test.ts` › `a price edit shows «precio desincronizado» and does not call PayPal` |
| `limits`: entero ≥0 o null, solo métricas conocidas, todas presentes | `plan-catalog.test.ts` › `validateLimits` (5) ; `plan-form.test.ts` › `«ilimitado» ticked sends null…`, `an empty limit is an error, not «unlimited»` |
| Inventario fijado contra semilla y código | `plan-catalog.test.ts` › `limit keys are exactly the ones the 041 seed documents and writes`, `feature keys are exactly the ones the 041 seed documents`, `every feature the code checks is in the inventory` (grep de `assertPlanFeature/hasFeature/assertFeature`), `every limit the code enforces is in the inventory` (grep de `assertQuota/assertStockLimit` + `USAGE_METRICS`) |
| Sync: ciclo sin id → crear + guardar id + historial con precio y `PAYPAL_ENV` | `[id]/sync/route.test.ts` › `creates the plan at PayPal, stores the id and records the price`, `creates the product when PayPal has none by that name`, `records the live environment when PAYPAL_ENV=live` |
| Sync: id con otro precio → plan nuevo, sustituir id, `replaced_at/replaced_by` | › `creates a new plan, swaps the id and archives the old one` |
| Sync: mismo precio → no-op 200 `{ synced: true }` sin PayPal | › `answers { synced: true } without calling PayPal` |
| Sync: id sin historial → «verificar» | › `reads the price back from PayPal and, when it matches, only records it`, `when PayPal charges another price, records it and replaces the plan`, `409s when PayPal does not know the id (other environment)`, `502s when the PayPal plan is not of this cycle` |
| Precio 0 o nulo → 400 | › `400s a free cycle: nothing free is published to PayPal`, `400s a cycle without a price` |
| Sin credenciales → 503 claro | › `503s with a clear message when PayPal is not configured` |
| Suscriptores intactos (decisión 5) | › `does not touch any subscription (decision 5)` |
| Error de PayPal sin filtrar su cuerpo | › `502s when PayPal refuses, and stores nothing` |
| `getPlan` sobre `fetch` mockeado | `src/lib/billing/paypal.test.ts` › `getPlan (s9.3)` (3) |
| Bootstrap intacto y lo compartido | `src/lib/billing/paypal-bootstrap-catalog.test.ts` (sin cambios, verde); `src/lib/billing/paypal-catalog.test.ts` (3) |
| UI: tabla, cuatro estados, «Nuevo plan», botones por ciclo, sin borrar, `PAYPAL_ENV`, aviso sin credenciales | `src/components/platform/platform-plans.test.tsx` › `lists every plan, the hidden one too`, `shows the four sync states with the words of the spec (es)`, `offers «Nuevo plan» and a sync button per plan and cycle`, `says which PayPal environment it talks to`, `warns when PayPal is not configured` |
| Confirmación explica plan nuevo y clientes al precio anterior | › `the confirmation says that current customers keep the old price` |
| i18n es/en/ko (CP6) | › `is translated in %s (CP6)` (3), `every static key the page asks for exists in %s` (3), `every metric, feature, state and cycle has a label in %s` (3); `src/i18n/messages.test.ts` (paridad y «nada sin traducir») e `icu-safety.test.ts` verdes |
| Formulario ↔ cuerpo aceptado por el servidor | `src/components/platform/plan-form.test.ts` (9) |
| Página tras la guarda | `src/app/(platform)/platform-guard.test.ts` (sin cambios, verde con la página nueva) |

## Verificaciones contra base real
`progress/checks_plans-admin.sql` contra el contenedor de `KEEP=1 scripts/replay-migrations.sh`, en una transacción con ROLLBACK: **19/19 «ok»**.
- 1a–1f: owner autenticado lee 0 filas del historial, sigue leyendo `plans`, `UPDATE plans` = 0 filas, `INSERT plans` e `INSERT` historial rechazados por RLS, `UPDATE/DELETE` historial = 0 filas.
- 2a–2b: operador (fila en `platform_admins`) lee el historial pero tampoco escribe desde su sesión.
- 3a: `DELETE` de un plan con historial falla por `plan_provider_history_plan_id_fkey` (RESTRICT). 3b–3c: `replaced_by` es FK real y pasa a NULL al borrar la fila referida. 3d: `plan_id` FK. 3e–3g: CHECK de ciclo, de entorno, NOT NULL de `provider_plan_id`. 3h–3i: un id de PayPal una vez por entorno. 3j: defaults.
- 4: `created_at` rellenado en filas existentes; trigger de `updated_at`; `description` escribible.
- Idempotencia: la 070 re-ejecutada sobre la base ya migrada + `verify-schema.sql` → OK.
- Nota del harness: la imagen `supabase/postgres:17.4.1.075` resuelve `auth.uid()` desde `request.jwt.claim.sub`, no desde `request.jwt.claims`; el SQL fija los dos y aserta `auth.uid()` antes de comprobar nada.

## Verificación manual pendiente (PayPal sandbox)
Con `PAYPAL_ENV=sandbox`, `PAYPAL_CLIENT_ID/SECRET` de sandbox y una base dedicada a sandbox:
1. Entrar como operador en `/platform/plans`: la insignia dice «Sandbox (pruebas)»; con las credenciales vacías aparece el aviso de que no se puede publicar.
2. «Nuevo plan» → `prueba-s93`, precio 12/120, todos los límites con número y uno «Ilimitado», dos features → Guardar. Sale en la tabla, oculto, «Sin publicar» en los dos ciclos.
3. «Sincronizar mes» → confirmar. En el dashboard de PayPal sandbox (Catalog → Subscription plans) aparece `prueba-s93 (monthly)` a 12.00 USD bajo el producto «Cabbity CRM». La celda pasa a «Sincronizado»; el historial muestra el id.
4. «Sincronizar mes» otra vez → «Ya estaba sincronizado»; en PayPal no aparece un plan nuevo.
5. Editar el precio mensual a 15 → la celda dice «Precio desincronizado» (PayPal intacto). Sincronizar → en PayPal hay un segundo plan a 15.00; el primero sigue ACTIVE a 12.00; el historial muestra el primero «sustituido» y el segundo vigente.
6. Con un plan creado por `scripts/paypal-bootstrap-catalog.ts` (id sin historial) → la celda dice «Verificar»; sincronizar lee el precio de PayPal: si coincide queda «Sincronizado» sin crear nada; si no, crea un plan nuevo.
7. Poner el precio anual de un plan a vacío y pulsar «Sincronizar año» → error «precio vacío o 0».
8. Suscribir una cuenta de pruebas al plan de 12 antes del paso 5 y comprobar tras él que su suscripción en PayPal sigue en el plan de 12 (decisión 5).

## Decisiones donde el spec era ambiguo
- **«Verificar» al sincronizar.** El spec pide mostrar «verificar» cuando el id no tiene historial, pero no dice qué hace el botón. Se lee el plan de PayPal (`getPlan`, `GET /v1/billing/plans/{id}`, único añadido a `paypal.ts`), se registra en el historial con el precio real y se aplica la regla: igual → no-op `{ synced: true, verified: true }`; distinto → plan nuevo. Alternativa descartada: crear siempre un plan nuevo (duplicaría los planes del bootstrap que ya están bien) o negarse (dejaría al operador sin salida salvo SQL). PayPal 404 → 409 «puede ser del otro entorno»; plan de otro ciclo o sin precio USD → 502.
- **Orden de escrituras y `PayPal-Request-Id`.** PayPal → `plans` → historial. El `requestId` es `wacrm-<env>-<plan>-<ciclo>-<céntimos>-r<nº filas de historial>`: determinista para reintentar el mismo intento (PayPal devuelve el mismo plan), distinto en el siguiente cambio de precio, y separado de los `…-v1` del bootstrap. Un fallo entre `plans` y el historial deja el id en «verificar», que se cura con el siguiente sync.
- **Índice único `(provider, provider_env, provider_plan_id)`**, no pedido explícitamente: un id de PayPal se registra una vez por entorno; dos sync simultáneos del mismo plan convergen en una fila (23505 → se reutiliza la existente y, si estaba cerrada, se reabre).
- **Al registrar la fila vigente se cierran todas las demás filas abiertas del plan y ciclo** (no solo la inmediatamente anterior), para que un id cambiado a mano no deje filas abiertas huérfanas.
- **Todos los `limits` obligatorios en cada escritura.** El código de enforcement trata una clave ausente como ilimitado (`limit === undefined → return`), así que un editor que omitiera una clave regalaría uso ilimitado. «Ilimitado» es `null` explícito. Inventario: las 8 claves y 7 features documentadas por la 041 (solo `api`, `webhooks` y `ai_autoreply` se consultan hoy en código; el test exige que cualquier consulta nueva esté en la lista).
- **PATCH con `id` en el cuerpo → 400**, aunque sea el mismo valor; campos desconocidos (incluidos `provider_plan_id_*`) → 400: los ids de PayPal solo los escribe el sync.
- **Precio 0 permitido en `plans`** (el plan `ilimitado` de s9.7 lo necesita); solo el sync lo rechaza.
- **Historial incluido en el GET** (no hay `GET …/[id]/history`); la respuesta del sync y del PATCH devuelve el plan con su estado recalculado.
- **Rate limit** `RATE_LIMITS.adminAction` en POST/PATCH/sync, como `hold`.
- `paypalConfigured` se expone en el GET además de `providerEnv`, para avisar en la página.
- `created_by` sin FK (el spec lo da como `uuid nullable`).
- `PlatformPlaceholder` conserva la sección `plans` (y su i18n `Platform.placeholder.plans`) aunque la página ya no la usa: quitarla tocaría `platform-shell.test.tsx` y claves compartidas con s9.2 en paralelo. Ver deuda.

## Variables de entorno nuevas
Ninguna. Se usan las existentes `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_PRODUCT_NAME` (esta última ahora también la lee el panel). `.env.local.example` no se tocó.

## Deuda detectada fuera de alcance
- `Platform.placeholder.plans` y la rama `'plans'` de `PlatformPlaceholder` quedan sin uso en producción (solo los usa `platform-shell.test.tsx`); limpiar tras integrar s9.2/s9.4.
- `docs/docker.md` («PayPal catalogue») describe el bootstrap por CLI como única vía; convendría añadir que el panel publica y versiona planes (no es variable de entorno, no se tocó).
- `verify-schema.sql` aserta exactamente 3 filas en `plans`; s9.7 (plan `ilimitado`) tendrá que ajustarlo.
- En la imagen del harness `auth.uid()` lee `request.jwt.claim.sub` (formato antiguo); cualquier SQL de comprobación que solo fije `request.jwt.claims` prueba con `auth.uid() = NULL` sin avisar.
- La consulta de la fila vigente no filtra por `provider_env`: una base que mezclara ids de sandbox y live (lo que `docs/docker.md` ya prohíbe) mostraría estados engañosos; el historial enseña el entorno de cada fila.
- Nota de git: el trailer de los dos commits es `Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>` (el que fija el entorno para este modelo), no `Claude Opus 5` como pedía el líder; se reescribieron en local antes de reportar (sin push).

## Segunda ronda (review CHANGES_REQUESTED)

Rama `platform/plans`, sobre `ad221b8`. Commits nuevos (sin push):

| Commit | Qué |
|---|---|
| `2bdec06` | fix: el webhook de PayPal resuelve planes sustituidos desde `plan_provider_history` |
| `53b5236` | fix: «verificar» exige plan ACTIVE; 409 `paypal_id_in_use`; acción `unpublish`; avisos en la tabla; i18n; CHANGELOG |

### Compuerta (HEAD 53b5236)
- lint: 0 errores, los 35 warnings de siempre. typecheck: verde.
- `TZ=UTC npm test`: 216 archivos, **2907 tests** en verde (antes 2894).
- build (variables dummy): verde.
- `scripts/replay-migrations.sh "$(pwd)"`: salida 0, con y sin `KEEP=1`. `progress/checks_plans-admin.sql`: 19/19 «ok», ROLLBACK. La migración y el SQL no cambian en esta ronda.

### Bloqueo 1: «verificar» con plan no ACTIVE o respuesta incompleta (`src/lib/billing/plan-sync.ts`)
- Se exige `remote.cycle === cycle` (un `interval_unit` que falta ya no vale) y un precio USD fijo; si no, 502 `paypal_unreadable` sin tocar historial ni `plans`.
- `remote.status !== 'ACTIVE'` (INACTIVE, CREATED…): el id **nunca** se registra como vigente. Se publica un plan nuevo (mismo camino que un cambio de precio) y el id viejo queda en el historial como fila **cerrada** (`replaced_at`, `replaced_by` = fila nueva) con el precio que PayPal devolvió, para que el webhook siga resolviendo a sus posibles suscriptores. Respuesta `{ action: 'replaced', verified: true, inactive: true }`. Decisión: opción «crear plan nuevo» que ofrecía el líder; no hace falta un estado de UI nuevo porque el sync lo resuelve en un paso.
- `paypalFake` (`src/lib/billing/plan-admin.test-support.ts`) acepta `status`, puede omitir `unit` (sin `interval_unit`) o `value` (sin `pricing_scheme`), y `raw` para devolver un cuerpo tal cual.
- Tests en `src/app/api/platform/plans/[id]/sync/route.test.ts` › `«verificar» must not vouch for what PayPal will not sell (round 2)`: `a %s PayPal plan at the same price is archived and replaced, never recorded as current` (INACTIVE, CREATED); `502s paypal_unreadable on %s, touching nothing` (sin `pricing_scheme`, sin `interval_unit`, sin `billing_cycles`).

### Bloqueo 2: webhook y planes sustituidos (`src/app/api/billing/webhook/route.ts`)
- `resolvePlanForEvent`: si el id no está en `plans.provider_plan_id_month/_year`, busca en `plan_provider_history` por `provider = 'paypal'`, `provider_env` = `PAYPAL_ENV` actual y `provider_plan_id` (filas vigentes o sustituidas), y devuelve `plan_id` y `cycle`. El índice único de la 070 garantiza como mucho una fila. Un error de lectura es `TransientWebhookError`, como la consulta de `plans`. Nada más del webhook cambia.
- Tests en `src/app/api/billing/webhook/route.test.ts`: `resolves a PayPal plan the panel superseded, through the history (s9.3)` (UPDATED con un id que solo existe en el historial → la suscripción pasa a `negocio`/`year`, no `unmatched`) y `does not resolve a superseded id recorded for the other PayPal environment`.

### Bloqueo 3: id ya registrado en otro plan o ciclo
- `recordCurrent` lanza `PlanSyncError` 409 `paypal_id_in_use` con el id y el plan en el mensaje cuando un 23505 no corresponde a este plan y ciclo. Para probarlo, el mock del cliente de servicio en el test de sync aplica el índice único de la 070 a los INSERT del historial (el fake no aplica índices).
- Test: `a PayPal id recorded for another plan or cycle (round 2)` › `409s paypal_id_in_use instead of silently leaving «verificar»`.

### No bloqueantes
- **Precio 0 en un ciclo publicado:** nueva acción `POST …/sync` con `{ cycle, action: 'unpublish' }` (`unpublishPlanCycle`): `provider_plan_id_<ciclo>` vuelve a NULL y se cierra la fila vigente. El historial se conserva, así que el webhook sigue resolviendo a los suscriptores, y no se llama a PayPal ni se toca ninguna suscripción. Un ciclo sin publicar o un id sin historial («verificar») da 409 (`not_published` / `unverified`): despublicar un id sin historial borraría el único registro que hay de él. En la UI, una celda publicada con precio 0 o vacío muestra un aviso y «Despublicar mes/año», con confirmación, en lugar de sincronizar. Tests: `unpublish a cycle (round 2)` (3) en el test de sync, y `offers «Despublicar» instead of sync for a published cycle whose price is now 0` en `platform-plans.test.tsx`.
- **Aviso sobre el precio para el humano:** si se hace un PATCH de precio y no se sincroniza, `/api/billing/plans` (y por tanto el checkout y la ficha de precios) enseña el precio nuevo, pero la suscripción se crea contra el id de PayPal viejo, que cobra el precio viejo. El estado «Precio desincronizado» ya lo indicaba. Ahora, además, cada celda en ese estado muestra en rojo, junto al botón: «El checkout ya muestra el precio nuevo, pero PayPal sigue cobrando el anterior hasta que sincronices». Test: `warns next to the sync button that checkout already shows the new price`. Recomendación operativa: sincronizar justo después de editar un precio.
- i18n: `Platform.plans.hint.*`, `Platform.plans.unpublish.*`, `syncDone.unpublished`; `confirm.verifyRule` menciona el caso de un plan inactivo. Mismas claves en es, en y ko.

### Deuda que sigue abierta
- `openRowFor`/`loadHistory` siguen sin filtrar por `provider_env` (ya estaba anotado). El webhook sí filtra.
- Si el proceso cae entre el UPDATE de `plans` y el registro del id INACTIVE archivado, ese id viejo se pierde del historial; el plan nuevo queda bien. Es la misma ventana que tiene el orden de escrituras elegido y se acepta.
