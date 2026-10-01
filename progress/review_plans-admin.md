# Review — s9.3 plans-admin

**Veredicto:** CHANGES_REQUESTED

Rama `platform/plans`, rango `785c3ae..ad221b8` (2 commits), worktree `.claude/worktrees/platform-plans`.

## Compuerta (ejecutada por el reviewer)
- lint: verde (0 errores, 35 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde (216 archivos, 2894 tests)
- build (variables dummy de CI): verde; aparecen `/api/platform/plans`, `/api/platform/plans/[id]`, `/api/platform/plans/[id]/sync`, `/platform/plans`
- replay-migrations: verde (`ok 070_plan_provider_history.sql`, `verify-schema.sql: OK`; sin 069, como se esperaba)
- `progress/checks_plans-admin.sql` con `KEEP=1`: 19/19 «ok» (1a–1f, 2a–2b, 3a–3j, 4), ROLLBACK
- Idempotencia: 070 re-ejecutada sobre la base ya migrada + `verify-schema.sql` → OK
- `node --experimental-strip-types` importa `scripts/paypal-bootstrap-catalog.ts` (exporta `DEFAULT_PRODUCT_NAME`, `bootstrapCatalog`); su test sigue sin cambios y en verde

## Trazabilidad criterio ↔ test
- C1 «listado y edición de nombre, precios, limits, features, is_public, sort_order»: [x] `api/platform/plans/route.test.ts` › "lists every plan…"; `[id]/route.test.ts` › "updates the fields sent and nothing else"
- C2 «crear plan nuevo (id slug)»: [x] `route.test.ts` › "creates a plan…201", "400s %s", "409s an id that already exists"; `plan-catalog.test.ts` › "refuses an id with %s"
- C3 «no se borran planes (se despublican)»: [x] `[id]/route.test.ts` › "has no DELETE…"
- C4 «todas con requirePlatformAdmin() y rol de servicio; plans sin política de escritura»: [x] 401/403 en las tres rutas (sync: sin llamadas a PayPal ni escritura); `tenant-isolation.test.ts` › "403s the owner of account A on every plan route, and writes nothing" (solo `platform_admins` llega al rol de servicio); SQL 1c–1e, 2b; `verify-schema.sql` aserta que ni `plans` ni `plan_provider_history` tienen política de escritura
- C5 «limits por métrica, ilimitado = null»: [x] `plan-catalog.test.ts` › `validateLimits` (claves desconocidas, ausentes, no enteras, negativas); `plan-form.test.ts` › "«ilimitado» ticked sends null…". Lo que produce el validador siempre es un objeto con las 8 claves, entero ≥0 o null, así que no puede romper `normalizeLimits`
- C6 «features del inventario real»: [x] `plan-catalog.test.ts` busca con grep `assertPlanFeature/hasFeature/assertFeature` y `assertQuota/assertStockLimit`. Lo comprobé a mano: el código consulta `api`, `webhooks` y `ai_autoreply`, y los límites que aplica son `messages_out`, `ai_replies`, `broadcast_recipients`, `numbers`, `knowledge_documents` y `operators`. Todos están en el inventario, que coincide con los comentarios y la semilla de la 041 y con los ajustes de la 065
- C7 «sync: ciclo sin id → crear y guardar id»: [x] `[id]/sync/route.test.ts` › "creates the plan at PayPal, stores the id and records the price", "creates the product when PayPal has none…"
- C8 «cambio de precio → plan nuevo, sustituir id, historial con replaced_at/replaced_by»: [x] › "creates a new plan, swaps the id and archives the old one" (solo POST, nunca update del plan viejo)
- C9 «mismo precio → no-op»: [x] › "answers { synced: true } without calling PayPal"
- C10 «precio 0/nulo → 400; sin credenciales → 503»: [x] › "400s a free cycle…", "400s a cycle without a price", "503s with a clear message…"
- C11 «suscriptores intactos (decisión 5)»: [x] › "does not touch any subscription (decision 5)" (ni la tabla ni `/billing/subscriptions`); `reviseSubscription` no se importa en `plan-sync.ts`
- C12 «estados sin publicar / sincronizado / precio desincronizado / verificar»: [x] `route.test.ts` › "reports the sync state per cycle…"; `plan-sync.test.ts` › `cycleSync`; `platform-plans.test.tsx` › "shows the four sync states…"
- C13 «PAYPAL_ENV visible»: [x] `route.test.ts` › "says live when PAYPAL_ENV=live…"; `platform-plans.test.tsx` › "says which PayPal environment it talks to"
- C14 «la ficha dice que los clientes siguen al precio anterior»: [x] `platform-plans.test.tsx` › "the confirmation says that current customers keep the old price" (`confirm.newPlanRule`)
- C15 desvío «verificar» con `getPlan`: [ ] parcial. Están cubiertos el precio igual, el precio distinto, el 404 → 409 y el ciclo distinto → 502. **Faltan** un plan INACTIVE, una respuesta sin `billing_cycles`/`pricing_scheme` (solo `paypal.test.ts` cubre el caso EUR a nivel de cliente, no la ruta) y una respuesta sin `interval_unit` (hallazgo 1)
- CP6 i18n: [x] `Platform.plans` tiene 87 claves idénticas en es/en/ko (lo comprobé por script); `messages.test.ts` y `icu-safety` en verde

## Checkpoints
- CP1 Compuerta: [x]
- CP2 Migraciones: [x] número 070; `IF NOT EXISTS` y drop-then-create; FK `plan_id` RESTRICT (`confdeltype='r'`), self-FK SET NULL (`'n'`); RLS con solo SELECT e `is_platform_admin(auth.uid())`; aserciones en un bloque `-- 070 … -- /070`; sin CASCADE
- CP3 Aislamiento: [x] `plans` y `plan_provider_history` no tienen `account_id`; las consultas van por `plan_id` y hay test de fuga tenant → catálogo con waivers razonados
- CP4 Tests: [ ] faltan los casos de C15
- CP5 Sin dependencias nuevas: [x] `package.json` y el lock sin cambios
- CP6 i18n: [x]
- CP7 Next 16: [x] `params: Promise<{id}>` con `await`, igual que las rutas hermanas de `/api/platform`
- CP8 Alcance: [x] de s9.1 solo cambia `(platform)/platform/plans/page.tsx`. El refactor del script y `getPlan` en `paypal.ts` están justificados
- CP9 Documentación: [x] CHANGELOG (Unreleased); sin variables nuevas; el informe coincide con el diff
- CP10 Git: [x] 2 commits en español con prefijo `feat:` y `Co-Authored-By`; sin push
- CP11 Lo entrante: [x] no toca el webhook de WhatsApp

## Hallazgos (archivo:línea)
1. `src/lib/billing/plan-sync.ts:530` — la rama «verificar» ignora `remote.status` y acepta `remote.cycle === null`. Un plan de PayPal INACTIVE (o CREATED) al mismo precio queda registrado como fila vigente y responde `noop` / «Sincronizado». Como a partir de ahí ya hay fila abierta, no se vuelve a llamar a `getPlan`: el panel dirá «Sincronizado» para siempre, y el checkout mandará clientes a un plan que PayPal no acepta. `paypal.ts:328` calcula `status`, pero nadie lo usa. Una respuesta sin `interval_unit` también se da por buena.
2. `src/app/api/billing/webhook/route.ts:444-470` (sin tocar, pero la feature lo rompe) — `resolvePlanForEvent` busca el id de PayPal solo en `plans.provider_plan_id_month/_year`. Tras un sync de tipo «replaced», el id viejo solo queda en `plan_provider_history`, así que todo `BILLING.SUBSCRIPTION.UPDATED` de un suscriptor antiguo (decisión 5: se queda en el plan viejo) termina en `decideSubscriptionChange` → `error` «PayPal plan … is not in our catalogue» → `unmatched`, y ese evento no se aplica. Con la 065 esto era un caso manual y raro; con s9.3 pasa a ser la operación normal del panel, y la tabla de historial es justo el dato que falta para resolverlo.
3. `src/lib/billing/plan-sync.ts:442-466` — ante un 23505, si el id de PayPal ya está registrado para otro plan u otro ciclo (el índice único no incluye `plan_id`/`cycle`), `maybeSingle` devuelve null y `recordCurrent` sale sin error: el plan ya apunta al id y no queda registro, así que sigue en «verificar» para siempre sin que nadie se entere. Debería fallar con un 409 explícito.
4. `src/lib/billing/plan-sync.ts:200-219` + `:503` — si a un ciclo ya publicado se le pone precio 0 o vacío, aparece «precio desincronizado», pero el sync siempre responde 400 `no_price`. No hay forma de salir de ese estado desde el panel. Menor.
5. `src/app/api/platform/plans/[id]/route.ts` / `src/lib/platform/plans.ts:50` — un PATCH de precio sin sync hace que `/api/billing/plans` muestre el precio nuevo mientras el checkout suscribe al id de PayPal viejo. El spec lo acepta con el estado «precio desincronizado», y pasaba lo mismo con la 065. No lo bloqueo; lo anoto para el humano (valdría un aviso en el editor al cambiar precio de un ciclo publicado).
6. `src/lib/billing/plan-sync.ts:180-198, 301-315` — ni `openRowFor` ni `loadHistory` filtran por `provider_env`. El informe ya lo declara como deuda y `docs/docker.md` prohíbe mezclar entornos en una misma base. No bloquea.

## Cambios requeridos
1. En la rama «verificar» (`plan-sync.ts:530`): tratar un `status !== 'ACTIVE'` como un id que no vale para vender. O crea un plan nuevo (como en un cambio de precio, y cierra el viejo en el historial) o responde 409/502 con un código propio; no puede registrar el plan como vigente ni devolver `noop`. Exigir además `remote.cycle === cycle` (que `null` no pase). Tests en `[id]/sync/route.test.ts`: plan INACTIVE, respuesta sin `billing_cycles`/`pricing_scheme` (→ 502 `paypal_unreadable`, sin tocar el historial) y respuesta sin `interval_unit`. Para eso hay que ampliar `paypalFake` (`plan-admin.test-support.ts:139-160`), que hoy devuelve siempre `ACTIVE` con precio.
2. Que `resolvePlanForEvent` (`src/app/api/billing/webhook/route.ts:444`) caiga a `plan_provider_history` (por `provider_plan_id`, y si se puede también `provider_env`) cuando el id no está en `plans`, y devuelva el `plan_id` y el `cycle` de esa fila. Test en el webhook: un evento UPDATED con el id sustituido se resuelve al plan y al ciclo, y no queda `unmatched`. Si el líder prefiere sacarlo a otra feature, que lo apruebe el humano y quede registrado; sin eso, la decisión 5 deja a los suscriptores antiguos fuera del webhook.
3. En `recordCurrent` (`plan-sync.ts:454`): si después de un 23505 no se encuentra la fila para este plan y ciclo, lanzar un `PlanSyncError` 409 (el id ya pertenece a otro plan o ciclo), no volver en silencio. Con su test.

---

# Segunda ronda — HEAD 53b5236 (rango `ad221b8..53b5236`, 2 commits)

**Veredicto:** APPROVED

## Compuerta (ejecutada por el reviewer)
- lint: verde (0 errores, 35 warnings preexistentes, sin cambio en la cuenta)
- typecheck: verde
- `TZ=UTC npm test`: verde (216 archivos, 2907 tests)
- build (variables dummy de CI): verde
- replay-migrations: verde (`ok 070_plan_provider_history.sql`, `verify-schema.sql: OK`)
- `progress/checks_plans-admin.sql` con `KEEP=1`: 19/19 «ok», ROLLBACK. Esta ronda no toca la migración ni el SQL

## Cambios requeridos de la ronda 1
1. [x] **«Verificar» con plan no ACTIVE o respuesta incompleta**, en `src/lib/billing/plan-sync.ts:582-606`
   - La comprobación es ahora `remote.cycle !== cycle`, así que un `null` ya no pasa. Si falta precio o ciclo → 502 `paypal_unreadable`, sin tocar historial, `plans` ni PayPal.
   - Si `status !== 'ACTIVE'`, el id no se registra como vigente. Se publica un plan nuevo, `recordCurrent` lo deja abierto y `recordArchived` (`:500-525`) guarda el id viejo como fila cerrada (`replaced_at` relleno, `replaced_by` = fila nueva) con el precio que devolvió PayPal. Así el webhook sigue resolviendo a quien siga suscrito a ese id.
   - Tests en `[id]/sync/route.test.ts` › "a %s PayPal plan at the same price is archived and replaced, never recorded as current" (INACTIVE y CREATED). Comprueban la secuencia GET plan → productos → POST plan, que `boot.replaced_by === fresh.id`, que `boot.replaced_at` está relleno, que `fresh.replaced_at` es null y que el estado final es `synced`. Y "502s paypal_unreadable on %s, touching nothing": sin `pricing_scheme`, sin `interval_unit` y sin `billing_cycles`. `paypalFake` acepta ahora `status`, `raw` y campos omitidos.
2. [x] **Webhook con ids sustituidos**, en `src/app/api/billing/webhook/route.ts:471-492`
   - Si el id no aparece en `plans`, se busca en `plan_provider_history` por `provider`, `provider_env` y `provider_plan_id`. `maybeSingle` es seguro porque es exactamente el índice único de la 070. Un error de lectura se trata como `TransientWebhookError`.
   - La duda de un historial «sin `provider_env`» no aplica: la columna es `NOT NULL` con `CHECK IN ('sandbox','live')` en la 070, y lo ejercen los checks 3f y 3j. El entorno por defecto (`!== 'live'` → sandbox) es el mismo en el sync y en el webhook, así que un id que registró el panel siempre se busca en su propio entorno. Solo quedan fuera los ids del otro entorno, como debe ser.
   - Tests en `webhook/route.test.ts` › "resolves a PayPal plan the panel superseded, through the history (s9.3)": un UPDATED con un id que solo está en el historial y cerrado → `negocio`/`year` con el `current_period_end` aplicado. Y "does not resolve a superseded id recorded for the other PayPal environment" → `unmatched`.
3. [x] **Id que ya pertenece a otro plan o ciclo**, en `plan-sync.ts:477-483`: responde 409 `paypal_id_in_use` y nombra el id y la columna. Test "409s paypal_id_in_use instead of silently leaving «verificar»": el mock del cliente de servicio reproduce el 23505 del índice único y el test comprueba que el historial queda en 1 fila.

## No bloqueantes de la ronda 1
- [x] **`unpublish`**, en `plan-sync.ts:689-745` y en la ruta `sync/route.ts:79-91`
   - Pasa por `requirePlatformAdmin()` antes de leer el body; el test "400s an unknown action and 403s an owner" da 403 al owner.
   - Solo escribe `plans.provider_plan_id_<ciclo> = NULL` y cierra las filas abiertas de ese plan y ciclo. No importa ni llama a nada de PayPal y no hay ninguna consulta a `subscriptions` (lo comprobé leyendo el código). El test comprueba `paypal.requests === []` y que el historial se conserva.
   - Si el ciclo no está publicado → 409 `not_published`; si el id no tiene historial → 409 `unverified`, y en ese caso el id no se toca.
- [x] **Aviso de «precio desincronizado» junto al botón y opción «Despublicar» cuando el precio es 0**: tests en `platform-plans.test.tsx`. Las claves nuevas de `Platform.plans` están en paridad: 95 idénticas en es, en y ko (comprobado por script).

## Checkpoints (ronda 2)
- CP1 [x] · CP2 [x] (sin SQL nuevo) · CP3 [x] (la consulta nueva del webhook va por el id de PayPal sobre el catálogo global, sin datos de ninguna cuenta; la escritura sigue con el `account_id` de antes) · CP4 [x] · CP5 [x] (`package.json` sin cambios) · CP6 [x] · CP7 [x] · CP8 [x] (el webhook entra en alcance por el cambio requerido 2; nada más fuera) · CP9 [x] (CHANGELOG actualizado) · CP10 [x] (commits `fix:` en español con `Co-Authored-By`, sin push) · CP11 [x] (no toca el webhook de WhatsApp)

## Observaciones que no bloquean
1. `src/lib/billing/plan-sync.ts:523-524`: `recordArchived` da por bueno cualquier 23505, también si el id viejo ya está registrado para otro plan o ciclo. No puede pasar en la práctica, porque en ese caso `recordCurrent` ya habría devuelto 409 al verificar. Anotado.
2. `plan-sync.ts:180-198`: `openRowFor`/`loadHistory` siguen sin filtrar por `provider_env`. Ya estaba declarado como deuda; el webhook sí filtra.
3. El test de `unpublish` no aserta de forma explícita que `subscriptions` queda intacta, como sí hace el del sync. La lectura del código lo garantiza.
4. Recordatorio para el humano: entre un PATCH de precio y su sync, el checkout enseña el precio nuevo y PayPal cobra el viejo. Ahora la UI lo avisa en rojo; conviene sincronizar justo después de editar.
