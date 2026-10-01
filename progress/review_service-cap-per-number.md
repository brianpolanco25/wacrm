# Review — p11.3 service-cap-per-number

**Veredicto:** APPROVED (tercera ronda, HEAD 29fb4bc; condición: réplica de la 080 y `checks_service-cap-per-number.sql` en verde antes del `db push`, Docker apagado por orden del humano)

Rama `pmd/service-cap`, HEAD `e5b53fb`, base `be8ca0f` (4 commits: 4138911, 19b8126, 37677f1, e5b53fb).
El diff coincide con el informe (21 archivos; sin `package.json`).

## Compuerta
- lint: **rojo**, por el cambio. `src/lib/billing/service-cap.test.ts`:
  ```
  312:50  error  The `Function` type accepts any function-like value.  @typescript-eslint/no-unsafe-function-type
  313:34  error  The `Function` type accepts any function-like value.  @typescript-eslint/no-unsafe-function-type
  ✖ 36 problems (2 errors, 34 warnings)
  ```
  Las 34 advertencias son preexistentes; los 2 errores son de este diff. El implementer no corrió lint.
- typecheck: verde.
- test (`TZ=UTC npm test`, una pasada): verde, 272 archivos / 3897 tests.
- build: no corrido por orden del líder (lo corre sobre la rama integrada).
- replay-migrations: n/a (Docker apagado por orden del humano).

## Revisión manual del SQL (sustituye a la réplica)
`supabase/migrations/080_service_cap.sql`:
- Idempotente: `ADD COLUMN IF NOT EXISTS`, CHECK dentro de `DO` con `IF NOT EXISTS` en `pg_constraint`,
  `CREATE OR REPLACE FUNCTION`, `REVOKE`/`GRANT` y `COMMENT` repetibles. [x]
- `SET lock_timeout = '5s'` antes del `ALTER TABLE accounts` y `RESET` después. DEFAULT constante (sin
  reescritura en PG >= 11). [x]
- `service_quota_usage`: **`SECURITY INVOKER`**, no `DEFINER` (el encargo decía DEFINER). Es lo que fija
  `design.md` §080 y es lo correcto: solo `service_role` tiene `EXECUTE` y ese rol ya salta la RLS de
  `message_charges`, así que con DEFINER no se gana nada y se abre más superficie. `SET search_path = public`
  fijo. Filtro `mc.account_id = p_account_id` y el resto de condiciones de R2 tal cual (`service`,
  `delivered|read`, `delivered_at >= p_since`, `IS DISTINCT FROM 'free_entry_point'`, config no NULL). [x]
- Permisos: `REVOKE ALL` de `PUBLIC`, `anon`, `authenticated`; `GRANT EXECUTE` a `service_role`. [x]
- Sin `CASCADE`, sin tocar `messages`/`conversations`/`message_charges` (CP11). [x]
- `verify-schema.sql` bloque `-- 080` dentro del `DO`: columna NOT NULL con default `'warn'`, CHECK,
  `to_regprocedure`, `has_function_privilege` false para authenticated/anon y true para service_role. [x]
- `progress/checks_service-cap-per-number.sql` (240 líneas) cubre R1, R2 con cada exclusión, R3 y R7; leído.

**Sin verificar contra base real:** que la 080 aplique sobre 001–076 + 079 y dos veces seguidas;
`--single-transaction`; que `column_default LIKE '''warn''%'` case con el texto real del catálogo
(`'warn'::text`); el resultado exacto de R2/R3/R7 en `checks_service-cap-per-number.sql`; y que el
`maybeSingle` de `subscriptions` con el cliente de sesión de un agente no quede vacío por RLS (si quedara,
`metaBillingOf(null)` da `direct` y una cuenta `managed` vería el aviso). Todo eso queda para cuando haya Docker.

## Trazabilidad criterio ↔ test
- R1 «columna NOT NULL default warn, CHECK»: [x] verify-schema `-- 080` + checks SQL (sin ejecutar).
- R2 «conteo por número con exclusiones»: [x] checks SQL bloque R2 (sin ejecutar).
- R3 «solo service_role»: [x] verify-schema + checks SQL (sin ejecutar).
- R4 «agotado si used>=1000 o billable>0, mes UTC»: [x] `src/lib/billing/service-cap.test.ts` › serviceCapState (999/0, 1000/0, 10/1) y serviceMonthWindow (31-dic, 29-feb, 1-oct 02:00 UTC).
- R5 «forma exacta, sin Meta, managed sin RPC»: [x] `src/app/api/whatsapp/service-cap/route.test.ts` › "an agent gets the exact shape…" (fetch espiado), "managed → numbers: []…", "no session → 401".
- R6 «A no ve B»: [x] route.test › "A never sees B's numbers…"; `tenant-isolation.test.ts` › "A sees only its own number at 0…" (comprueba `p_account_id` = A en la RPC).
- R7 «PATCH admin, 400/403, solo A»: [x] route.test › "an admin switches to warn…" (filtro `id = A`, `requireRole('admin')`), 400 ×3 + JSON inválido, "below admin → 403", 401; tenant-isolation › "PATCH writes A's setting and leaves B untouched".
- R8 «500 genérico, cliente = sin dato»: [x] route.test › "the rpc failing → 500…"; `use-service-cap.test.ts` (500 y red → null); alert › null → nada.
- R9 «pause_ai + agotado: sin claim, modelo, envío ni uso»: [x] `src/lib/ai/auto-reply.test.ts` › "pause_ai + exhausted number…" (claimUpserts vacío, generateReply/engineSendText/recordUsage sin llamar, conversación sin tocar, console.info con la cuenta). La compuerta está antes de `claimInboundAutoReply` (`auto-reply.ts:134-157`).
- R10 «warn / managed / bajo cuota / sin número → responde»: [x] auto-reply.test, un caso por condición; en warn y managed se comprueba que la RPC no se llama.
- R11 «falla abierta»: [x] service-cap.test › "fails open" ×5; auto-reply.test › "the count failing fails open…".
- R12 «número sellado, por defecto, más antiguo, nunca de otra cuenta»: [x] service-cap.test (sellado, NULL → defecto, sin defecto → más antiguo, sellado de B no resuelve y RPC solo con A, sellado inexistente → defecto); auto-reply.test › "every service-cap read is scoped…".
- R13 «reset el día 1 UTC»: [x] service-cap.test › "on the 1st at 00:00:01 UTC…" (p_since = 2026-11-01).
- R14 «CP11, webhook intacto»: [x] `webhook/route.test.ts` › "persists the inbound, calls the AI dispatch, and nothing is sent" (upsert 1 vez, dispatch invocado, `isAiPausedByServiceCap` real → true). `webhook/route.ts` sin cambios en el diff. Test débil (el despacho es un doble), pero cumple lo que pide el spec.
- R15 «no condiciona envíos manuales»: [x] el diff no toca `enforce.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`, `whatsapp/send/route.ts` ni `broadcast-core.ts`; `isAiPausedByServiceCap` solo lo importa `auto-reply.ts` fuera de tests (comprobado).
- R16 «franja de la bandeja»: [x] `service-cap-alert.test.tsx` (warn, pause_ai con fecha, en inglés, dos números, managed, null, ninguno agotado). Montada en `inbox/page.tsx:583`.
- R17 «uso por número»: [x] `service-cap-settings.test.tsx` (0, 734, agotado por conteo, por billable, managed/sin dato).
- R18 «tarjeta y PATCH con reversión»: [x] `service-cap-settings.test.tsx` (marcada, deshabilitada sin permiso, oculta, cuerpo exacto del PATCH, revierte en no-OK y en error de red).
- R19 «i18n es/en»: [x] alert.test recorre `Inbox.serviceCap.*` y `Settings.whatsapp.serviceCap.*` con mismos placeholders; leído a mano en `messages/es.json` y `messages/en.json`: mismas 4 + 10 claves, mismos placeholders ICU.
- Guion manual (Meta real): [x] en el informe, pasos 1–5.

## Checkpoints
- CP1: [ ] lint rojo por el cambio (2 errores en `service-cap.test.ts:312-313`). typecheck y test verdes; build no corrido por orden del líder.
- CP2: [ ] parcial: 080 idempotente, aserciones en verify-schema, sin CASCADE (revisión manual); réplica no ejecutada (Docker apagado por orden del humano).
- CP3: [x] única llamada con rol de servicio en la ruta (`loadServiceUsage(supabaseAdmin(), ctx.accountId)`); en `isAiPausedByServiceCap` todas las lecturas filtran por cuenta; tests de fuga en route.test, tenant-isolation y service-cap.test.
- CP4: [x] cada R con test leído; SQL y guion manual presentes.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] es + en, mismas claves y placeholders; sin `ko`.
- CP7: [x] Route Handler `GET`/`PATCH` estándar, acorde con `01-app/01-getting-started/15-route-handlers.md` citado en el design.
- CP8: [x] solo archivos justificados por el spec; deuda (prettier de `inbox/page.tsx`, `/tmp/replay-out.txt` fijo) anotada, no arreglada.
- CP9: [x] CHANGELOG Unreleased con la 080; sin variables nuevas; informe coincide con el diff.
- CP10: [x] commits en español con prefijo y `Co-Authored-By`; sin push.
- CP11: [x] la cuota solo devuelve antes de responder con la IA; el webhook no cambia; falla abierta.

## Hallazgos (archivo:línea)
1. `src/lib/billing/service-cap.test.ts:312-313` — `(client as unknown as { rpc: Function }).rpc` dispara
   `@typescript-eslint/no-unsafe-function-type` (error) y deja `npm run lint` en rojo.
2. `supabase/migrations/080_service_cap.sql:65` — `SECURITY INVOKER` en vez del `DEFINER` del encargo. No es
   defecto (lo fija el design y es más seguro); se anota para que el líder no lo tome como desviación.
3. `src/app/api/whatsapp/service-cap/route.ts:49-55` — si la RLS de `subscriptions` dejara a un agente sin
   fila, `metaBillingOf(null)` devuelve `direct`. No verificado contra base; la política `subscriptions_select`
   (041) debería permitir leer a cualquier miembro. Comprobarlo en la réplica, no bloquea.

La revisión del skill `code-review` (nivel high) se lanzó sobre `be8ca0f..e5b53fb` en segundo plano y sus
hallazgos no estaban cuando se cerró este informe; la revisión manual del diff no encontró defectos
de corrección aparte de los anotados.

## Cambios requeridos
1. `src/lib/billing/service-cap.test.ts:312-313`: tipar el `rpc` sustituido con una firma explícita
   (p. ej. `(name: string, args: Record<string, unknown>) => unknown`) en vez de `Function`, y volver a
   correr `npm run lint` (0 errores) y `npx vitest run src/lib/billing/service-cap.test.ts`.
2. Cuando haya Docker: `scripts/replay-migrations.sh` (001–076 + 079 + 080, y la 080 dos veces) y
   `progress/checks_service-cap-per-number.sql` hasta `NOTICE: checks_service-cap-per-number: OK`, con la
   salida pegada en el informe.

## Segunda ronda (HEAD 0912d47)

- `git log --oneline e5b53fb..HEAD`: un commit, `0912d47 fix: tipar el rpc sustituido en el test del tope de servicio (p11.3)`.
- `git diff e5b53fb..HEAD --stat`: solo `src/lib/billing/service-cap.test.ts` (+3 −2). Cambia `Function` por el alias
  `type RpcFn = (name: string, args: Record<string, unknown>) => unknown` en las líneas 312-314. Nada más.
- `npm run lint`: 0 errores, 34 advertencias (las mismas preexistentes). Verde.
- `npm run typecheck`: exit 0.
- `npx vitest run src/lib/billing/service-cap.test.ts`: 26/26.
- Suite completa y build no repetidos, por orden del líder (la suite de la primera ronda salió 3897/3897; este
  commit solo toca el tipo de una variable local del test).
- replay-migrations: n/a (Docker apagado por orden del humano). Cambio requerido 2 sigue pendiente: hay que
  correr la réplica (001–076 + 079 + 080, y la 080 dos veces) y `progress/checks_service-cap-per-number.sql`
  antes del `db push`. Lo que queda sin verificar contra base real es lo que lista «Revisión manual del SQL».
- `code-review` (high) sobre `be8ca0f..e5b53fb`: llegó después de cerrar el informe de la primera ronda.
  Trajo 10 hallazgos. Los he contrastado a mano:
  1. **Confirmado, bloquea.** `src/app/api/whatsapp/service-cap/route.ts:118-151`: en una sesión de soporte
     `requireRole('admin')` pasa, porque el rol efectivo es admin. Pero la 072
     (`072_impersonation_actions.sql:52-54, 420`) deja `accounts` fuera de lo que soporte puede escribir.
     El UPDATE afecta 0 filas por RLS y la ruta responde **404 «Account not found»**. Además
     `impersonation_actions` registra un 404 y no el rechazo deliberado (403) que dejan las demás rutas
     vedadas a soporte, todas con `assertNotSupportSession`: `api-keys`, `webhooks`, `members`,
     `invitations`, `transfer-ownership`. En la UI los radios siguen activos (`canEditSettings`) y el
     cambio falla con «saveFailed». No hay fuga ni escritura indebida, pero el rastro de auditoría de
     fase 9 queda mal y el error engaña.
  2. **Confirmado, bloquea.** `src/hooks/use-service-cap.ts:64-83`: con `force` se lanza la petición B sin
     anular la A que sigue en vuelo, y la A hace `cache.set` sin condición al terminar. Si la A (lanzada
     antes del PATCH) responde después de la B, la caché se queda con la acción anterior durante 60 s y
     la bandeja muestra «La IA sigue respondiendo» con la IA en pausa (o al revés). La ventana es
     pequeña, pero la cuenta se engaña justo sobre lo que esta feature quiere hacer visible.
  3. Confirmado, no bloquea. `src/components/settings/service-cap-settings.tsx:104-110`: `chosen` nunca
     se limpia, así que si otro admin cambia el ajuste, esta vista enseña el valor viejo hasta que se
     vuelve a montar. Arreglo recomendado: `setChosen(null)` en el `onSaved`/refresh.
  4. Válido, no bloquea (rendimiento). Con `pause_ai`, cada entrante agrega el mes de **todos** los
     números de la cuenta (`service-cap.ts:179`). Hay índice `(account_id, delivered_at)` y solo corre en
     `pause_ai`. Mejora futura: filtrar por número en la RPC o cachear el «agotado» hasta `resetsAt`.
  5. No bloquean (limpieza): `conversationId` de `isAiPausedByServiceCap` no se usa
     (`service-cap.ts:142, 147`); lecturas en serie que podrían ir en paralelo; el patrón de caché está
     duplicado con `use-billing-status`; `ServiceCapAction` y su normalizador están en tres sitios;
     `metaBilling` se lee de dos fuentes en `whatsapp-config.tsx`. Que lo decida el implementer; no se exige.
  6. Rechazado como defecto: «`resolveConversationNumber` copia la regla de `resolveWhatsAppConfig`». Es la
     decisión documentada en el informe (sellado con `account_id`, y luego `resolveWhatsAppConfig` sin
     `conversationId` para el defecto y el más antiguo). La caída sí delega en `resolveWhatsAppConfig`.

Checkpoints actualizados: CP1 [x] (lint, typecheck y test verdes; build lo corre el líder sobre la rama
integrada). CP2 sigue parcial por lo mismo de antes, la réplica.

### Cambios requeridos (segunda ronda)
1. `src/app/api/whatsapp/service-cap/route.ts` `PATCH`: llamar a `await assertNotSupportSession(ctx)` justo
   después de `requireRole('admin')` (403 explícito, igual que el resto de rutas vedadas a soporte). Test en
   `route.test.ts`: con `ctx.impersonation` → 403 y ningún UPDATE. En `whatsapp-config.tsx`, pasar
   `canEdit={canEditSettings && !impersonating}` a `ServiceCapCard` (o lo que use el repo para saber si hay
   sesión de soporte) para que los radios no parezcan editables.
2. `src/hooks/use-service-cap.ts` `fetchServiceCap`: escribir en la caché solo si la petición sigue siendo la
   vigente (`if (inFlight.get(accountId) === request) cache.set(...)`, o un contador de generación). Test en
   `use-service-cap.test.ts`: A lenta + B forzada que termina antes → la caché se queda con B.
3. Sigue pendiente lo de antes: la 080 no va al remoto hasta que la réplica y
   `checks_service-cap-per-number.sql` salgan en verde.

## Tercera ronda (HEAD 29fb4bc)

- `git log --oneline 0912d47..HEAD`: un commit, `29fb4bc fix: tope de servicio vedado a soporte y caché sin carreras (p11.3)`.
- `git diff 0912d47..HEAD`: 6 archivos. Todos están dentro de lo que pidió la segunda ronda: `route.ts`,
  `route.test.ts`, `use-service-cap.ts`, `use-service-cap.test.ts`, `service-cap-settings.tsx` y
  `whatsapp-config.tsx`.

### Cambios requeridos de la segunda ronda
1. [x] PATCH vedado a soporte. `route.ts:121-123` llama a `await assertNotSupportSession(ctx)` justo después de
   `requireRole('admin')`, igual que las demás rutas vedadas. Test leído:
   `route.test.ts` › "a support session → 403 and nothing written (s9.5, 072)". Usa la implementación real
   de `assertNotSupportSession`, porque el mock de `@/lib/auth/account` hace `importOriginal` y solo
   sustituye `getCurrentAccount`/`requireRole`. Con `ctx.impersonation` presente comprueba status 403, 0
   UPDATE en `accounts` y `service_cap_action` de A sin cambiar. En la UI, `whatsapp-config.tsx:1132` pasa
   `canEdit={canEditSettings && !supportSession}`; `supportSession` existe en `useAuth()`
   (`use-auth.tsx:122, 605`). Esa línea no tiene test (no hay jsdom). El servidor ya lo cubre.
2. [x] Carrera en la caché. `use-service-cap.ts` tiene un contador `generation` por cuenta y `cache.set`
   solo si `generation.get(accountId) === gen`. `__resetServiceCapCache` lo vacía. Test leído:
   `use-service-cap.test.ts` › "a slow request A cannot overwrite a forced request B that finished first".
   A queda colgada, B forzada responde `pause_ai`, A se libera con `warn`, y la siguiente lectura sin
   forzar devuelve `pause_ai` de la caché sin un tercer `fetch`. Prueba exactamente lo pedido. En el
   hook, el `alive = false` del efecto anterior impide además que A pise el estado del componente.
3. [x] Hallazgo 3 (recomendado, no exigido). `service-cap-settings.tsx:106-113` borra `chosen` cuando llega
   otro objeto `status`, ajustando el estado durante el render, que es el patrón de React para reaccionar
   a un cambio de prop sin efecto. Sin test, por falta de jsdom; se acepta. Compruebo el flujo a mano:
   tras guardar, `setChosen(result.action)` y luego `onSaved` → refresh → `status` nuevo → `chosen = null`
   → se pinta `status.action` del servidor, que coincide con lo guardado.

### Compuerta (tercera ronda)
- `npm run lint`: 0 errores, 34 advertencias, las mismas preexistentes.
- `npm run typecheck`: exit 0.
- `TZ=UTC npx vitest run` sobre `route.test.ts`, `use-service-cap.test.ts`, `service-cap-settings.test.tsx`
  y `tenant-isolation.test.ts`: 4 archivos, 146/146.
- Suite completa y build: no repetidos, por orden del líder.
- replay-migrations: n/a (Docker apagado por orden del humano).

### Pendiente (no bloquea esta aprobación, sí el `db push`)
- Réplica 001–076 + 079 + 080 (y la 080 dos veces) y `progress/checks_service-cap-per-number.sql` hasta
  `NOTICE: checks_service-cap-per-number: OK`. Sigue sin verificar contra base real lo que lista «Revisión
  manual del SQL».
- Hallazgos 4 y 5 del `code-review` (rendimiento y limpieza): sin tocar, por decisión del líder; quedan
  como deuda.
- Guion manual con Meta real (S-C1…S-C6): lo hace el humano.
