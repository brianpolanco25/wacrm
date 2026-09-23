# Review — a7.4 webhooks-durable

**Veredicto:** APPROVED

Rama `api/webhooks`, base `feat/api-publica` (= `main` @ 3b82698). Commits revisados:
`e1fe546`, `c03241e`, `d0c891d`, `170d73e` — coinciden con el informe (60 archivos,
+5 898 / −350). Sin `code-review`: revisión a mano del diff completo, según el encargo.

## Compuerta

Ejecutada por mí, paso a paso y en primer plano, sobre el worktree:

- `npm run lint` → **verde** (0 errores, 35 avisos; los mismos de la base, ninguno en
  archivos nuevos).
- `npm run typecheck` → **verde**.
- `TZ=UTC npm test` → **verde**: 165 archivos, 2 170 tests, 0 fallos (coincide con el
  informe).
- `npm run build` con las variables dummy de `docs/harness.md` → **verde**.
- `scripts/replay-migrations.sh "$(pwd)"` → **verde**, salida `0`, `verify-schema.sql: OK`
  (001–060 + 062; la 061 no está en este worktree, así que la 062 no depende de ella).

## Trazabilidad criterio ↔ test

Criterios del spec §4 (leí cada test, no solo su nombre):

- C1 «500 → `failed` con `next_attempt_at` = +1 min»: [x]
  `src/lib/webhooks/queue.test.ts:181` › «un 500 deja la entrega failed con next_attempt_at
  a +1 min». Comprueba estado, `last_status_code`, la ventana 59–61 s y que el fallo suma a
  `failure_count` del endpoint.
- C2 «el cron la reintenta y, agotada la escalera, la marca `dead`»: [x]
  `queue.test.ts:266` recorre `sweepDueDeliveries` hasta `MAX_ATTEMPTS`, verifica
  `attempt` en cada vuelta, el `dead` final y que un barrido posterior ya no la toca
  (`attempted === 0`).
- C3 «un 200 en el 3.º intento → `delivered`»: [x] `queue.test.ts:295` (3 llamadas a
  `fetch`, `attempt === 3`, estado `delivered`).
- C4 «escalera de S-A6»: [x] `queue.test.ts:120` y `:128` (1 m, 5 m, 30 m, 2 h, 12 h y
  agotamiento en `MAX_ATTEMPTS`).
- C5 «el barrido reparte el cupo entre cuentas (1 000 vs 1)»: [x] `queue.test.ts:348`
  (unitario de `selectFairBatch`: 10 de A, 1 de B, y la de B entra en la **primera**
  vuelta, `batch[1]`) + `:375` de extremo a extremo sobre `sweepDueDeliveries`
  (31 filas → 6 intentos con `perAccountLimit: 5`).
- C6 «SSRF comprobado en cada intento»: [x] `queue.test.ts:242` — la URL pasa la guarda al
  encolar y se vuelve no entregable antes del intento: `fetch` **no** se llama y
  `last_error` dice «public address». Verificado además en el código:
  `src/lib/webhooks/queue.ts:355` llama `isDeliverableUrl` dentro de `attemptDelivery`, o
  sea en cada intento (inicial, barrido, reintento manual y `test`), y
  `redirect: 'manual'` sigue puesto (`queue.ts:389`), con test que lo afirma
  (`queue.test.ts:214`).
- C7 «fuga: entregas de otra cuenta → 404; el panel no ve `secret`»: [x]
  `src/lib/security/tenant-isolation.test.ts:1416` › «deliveries: solo las de A; el
  endpoint y la entrega de B → 404; el payload no sale» — lista acotada, `404` para el
  endpoint ajeno, `404` para reintentar `whd-b` **tanto** nombrando `wh-b` como colándola
  bajo `wh-a`, y `404` en `test` y `rotate-secret` ajenos; afirma
  `not.toHaveProperty('payload')` y `not.toHaveProperty('account_id')`. Complementado por
  `src/lib/webhooks/manage.test.ts` y `src/app/api/account/webhooks/[id]/route.test.ts:92`.
- C8 «replay verde + `docs/security.md` con `WEBHOOK_CRON_SECRET`»: [x] replay verde con
  aserciones nuevas en `supabase/ci/verify-schema.sql` (tabla, `CHECK` de `status`, índice
  parcial del barrido, los otros dos índices, RLS activa, política de SELECT y —buena
  idea— que **no** exista ninguna política de escritura). `docs/security.md` y
  `docs/docker.md` documentan la variable. `.env.local.example` queda pendiente del humano
  (archivo bloqueado para agentes); el informe lo dice.
- C9 «API: deliveries paginado + retry + test + rotate-secret»: [x] `manage.test.ts` por
  función y un `route.test.ts` por ruta (200/404/409/429).
- C10 «eventos nuevos disparados desde el dominio»: [x] `events.test.ts`,
  `status-events.test.ts` (10 casos, con dos de fuga entre cuentas),
  `tag-events.test.ts`, `contacts.test.ts` («solo en el alta real»),
  `broadcast-core.test.ts` (emisión, no-repetición y no-emisión con pendientes).
- C11 «panel: crear, editar, activar/desactivar, borrar, ver entregas, reintentar»: [x]
  las tres suites de `src/app/api/account/webhooks/**`.

Verificación contra base real: `progress/checks_webhooks-durable.sql` (226 líneas) cubre
lo que los mocks no ven — `CHECK` de `status`, RLS con `request.jwt.claim.sub`,
`INSERT` como `authenticated` rechazado, exclusividad real del reclamo optimista con dos
`UPDATE` sobre la misma foto, cascadas y el índice parcial. El informe reporta
`checks_webhooks-durable: OK`; el replay que corrí yo confirma que el esquema sobre el que
se ejecuta es el bueno. Guiones manuales (cron en despliegue, ida y vuelta con receptor
real, SSRF con DNS cambiante) están escritos y son razonables.

## Checkpoints

- CP1 Compuerta: [x] los cuatro pasos en verde, ejecutados por mí.
- CP2 Migraciones: [x] `062_webhook_deliveries.sql` con el número que fija el spec,
  idempotente (`CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`,
  `DROP POLICY IF EXISTS` + `CREATE POLICY`), aserción por objeto nuevo en
  `verify-schema.sql`, replay 0. Los dos `ON DELETE CASCADE` son de la tabla nueva hacia
  `accounts` y `webhook_endpoints`: borran la bitácora subordinada, nunca datos de
  clientes (contactos, mensajes). Está justificado en la cabecera de la migración y
  anunciado en el CHANGELOG.
- CP3 Aislamiento: [x] repasé una a una las consultas nuevas con rol de servicio.
  `src/lib/webhooks/manage.ts` filtra `.eq('account_id', accountId)` en las cinco
  (`endpointBelongsToAccount`, `listDeliveries` —doble acotación endpoint+cuenta—,
  `retryDelivery`, `sendTestDelivery`, `rotateWebhookSecret`); `queue.ts` lo hace en
  `markDelivered`, `markFailed`, el `UPDATE` de endpoint borrado y el reinicio de racha.
  Las rutas de panel que usan `supabaseAdmin()` —`[id]/test/route.ts:34` y
  `[id]/deliveries/[deliveryId]/retry/route.ts:36`— pasan `ctx.accountId` de la sesión, no
  un valor del cuerpo, y tienen test propio («usa el rol de servicio acotado por la cuenta
  de la sesión» + 404 ajeno). Las dos excepciones globales son el barrido y la purga del
  cron, globales por definición como el de automatizaciones.
- CP4 Tests: [x] ver trazabilidad; SQL de base real presente y pertinente.
- CP5 Sin dependencias nuevas: [x] `package.json` no aparece en el diff.
- CP6 i18n: [x] 63 claves nuevas, **el mismo conjunto exacto** en `messages/es.json`,
  `en.json` y `ko.json` (comparado con un diff de claves aplanadas contra la base:
  diferencia simétrica vacía en los tres pares), traducidas de verdad al coreano y con los
  mismos placeholders ICU (`messages.test.ts` lo verifica y pasa).
- CP7 Next 16: [x] `params: Promise<{…}>` con `await` en las ocho rutas nuevas,
  `after()` no se toca, `NextResponse.json` como el resto del repo. Sin APIs inventadas.
- CP8 Alcance: [x] todo lo tocado cae dentro de §4 (cola, eventos de dominio, rutas v1,
  panel, docs). Lo único fuera de la línea recta es `PATCH /api/conversations/{id}` +
  `message-thread.tsx`, y está justificado: sin servidor en medio no hay dónde emitir
  `conversation.closed`/`assigned` desde el panel. Ruido menor: prettier reformateó tres
  fragmentos ajenos (`settings/page.tsx`, el `upsert` de `engine.ts:649`,
  `v1/contacts/[id]/route.ts:110`); es formato, no comportamiento.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) con nota de migración,
  `docs/docker.md` con la variable nueva, su tabla y el crontab de un minuto,
  `docs/security.md` y `docs/public-api.md`. El informe coincide con el diff.
- CP10 Git: [x] cuatro commits en `api/webhooks`, en español, con prefijo y
  `Co-Authored-By`; nada pusheado.
- CP11 Lo entrante nunca se bloquea: [x] `dispatchWebhookEvent`
  (`src/lib/webhooks/deliver.ts:46`) envuelve todo en `try/catch` y usa
  `Promise.allSettled`; `enqueueWebhookDeliveries` tiene su propio `try/catch` y devuelve
  `[]` ante error; `attemptDelivery` «nunca lanza» y hasta el `markFailed` de rescate va
  en `try/catch`. Test explícito: `deliver.test.ts:133` › «nunca lanza aunque la base
  falle (CP11)», con un cliente cuyo `.from()` lanza. En
  `src/app/api/whatsapp/webhook/route.ts:870` la llamada nueva
  (`contact.created`) va dentro del `after()` que ya existía y con el mismo
  `supabaseAdmin()` local que la función ya usaba varias líneas antes, así que no
  introduce un punto de fallo nuevo antes del 200 a Meta.

## Puntos que el encargo pedía mirar

1. **Reclamo optimista por `attempt`, ¿estado huérfano?** No. `claimDelivery`
   (`queue.ts:236`) deja la fila en `status='pending'`, `attempt+1` y **no toca**
   `next_attempt_at`, que por construcción ya estaba en el pasado (el barrido filtra
   `lte('next_attempt_at', now)`; el encolado, el `retry` y el `test` lo ponen a `now`).
   Si el proceso muere con el intento en vuelo, la fila sigue casando el filtro
   `status IN ('pending','failed') AND next_attempt_at <= now()` del barrido siguiente, así
   que la recoge. Y termina: cada reclamo consume un `attempt`, de modo que tras
   `MAX_ATTEMPTS` la siguiente pasada la marca `dead` en vez de girar para siempre.
   Contrapartida conocida y aceptada: sin estado `processing` ni arriendo, un barrido que
   arranque **después** del reclamo y antes del fin del intento (ventana ≤ 5 s,
   `DELIVERY_TIMEOUT_MS`) puede entregar en paralelo. La garantía declarada es «al menos
   una vez» y el sobre lleva `id` para deduplicar; el `CHECK` del estado más el
   `verify-schema.sql` impiden la otra variante del fallo (un estado inventado que
   ningún barrido vea).
2. **SSRF y `redirect: 'manual'`**: comprobado en cada intento y conservado (ver C6).
3. **`payload` y `secret` fuera de toda respuesta**: `DELIVERY_PUBLIC_COLUMNS`
   (`queue.ts:99`) no incluye `payload` ni `account_id`, y `serializeDelivery` proyecta
   campo a campo; `WEBHOOK_PUBLIC_COLUMNS` (`endpoints.ts:18`) no incluye `secret`. El
   secreto solo sale en claro en la respuesta de crear y de rotar, una vez. El panel
   (`webhooks-settings.tsx`) no lee `payload` en ningún sitio.
4. **CP3 en las rutas nuevas con rol de servicio**: sí, incluida `/api/account/webhooks/
   [id]/test` (ver CP3).
5. **`PATCH /api/conversations/{id}`**: mantiene el permiso exacto de la 017.
   `conversations_update` exige `is_account_member(account_id,'agent')`; la ruta pide
   `requireRole('agent')` y escribe con `ctx.supabase` (cliente con RLS), y
   `status-events.ts` acota además por `account_id` en lectura y escritura, devolviendo
   404 —no 403— en lo ajeno (`status-events.test.ts:84` y `:132`). Antes el navegador
   hacía el mismo `UPDATE` con el mismo cliente, así que no se gana acceso. Ver hallazgo 1
   por lo que **ya** faltaba y sigue faltando.
6. **`finalizeBroadcastStatus` idempotente y reanudación (038)**: no la rompe. La guarda
   de salida temprana por `pending > 0` (`broadcast-core.ts:517`) es anterior al `.neq()`,
   así que una pasada de «reanudar» con trabajo pendiente sigue dejando la campaña en
   `sending` y la interfaz sigue ofreciendo Reanudar; el `.neq('status', finalStatus)` solo
   evita reescribir el estado terminal que ya estaba puesto, que es exactamente el caso que
   reemitía el webhook. Probado en `broadcast-core.test.ts` («no lo emite dos veces si la
   campaña ya estaba cerrada», «tampoco mientras queden destinatarios pendientes»).
7. **6 intentos frente a «tras 5 fallos»**: aceptada. La contradicción entre S-A6 y el
   texto del criterio está razonada en el informe (decisión 1), el código la documenta
   (`queue.ts:37-51`) y el test recorre la escalera entera hasta `dead`.
8. **CP6 y CP11**: ver checkpoints; ambos en verde.
9. **Ruta del cron**: cupo por cuenta (`selectFairBatch` con `SWEEP_PER_ACCOUNT_LIMIT`),
   purga a 30 días después del barrido, y la respuesta son solo contadores
   (`scanned/attempted/delivered/failed/dead/skipped/purged`) — ni un id, ni una URL, ni
   un dato de cliente. Secreto en `x-cron-secret` comparado con `timingSafeEqual` tras
   igualar longitud, 503 si la variable no está; cinco tests cubren los cinco caminos.

**Diff mínimo en los archivos compartidos con `api/recursos`**: confirmado.
`src/app/api/v1/webhooks/route.ts` y `src/app/api/v1/webhooks/[id]/route.ts` tienen diff
**vacío** contra `feat/api-publica`; `respond.ts` y `rate-limit.ts` tampoco se tocan (el
cubo nuevo vive en `manage.ts`, con la deuda anotada). No exijo la centralización aquí.

## Hallazgos (archivo:línea) — ninguno bloqueante

1. `src/app/api/conversations/[id]/route.ts:82` — `assigned_agent_id` no se valida contra
   la pertenencia a la cuenta: un `agent` puede asignar una conversación a cualquier uuid
   de `auth.users` (la FK de la 040 solo apunta a `auth.users`, sin comprobar membresía, y
   la RLS de la 017 no mira el destino). **Es preexistente** —la bandeja hacía el mismo
   `UPDATE` desde el navegador— y la feature no lo empeora, así que por CP8 no lo pido
   aquí; pero ahora que hay un servidor en medio, el sitio natural para cerrarlo es este.
   Vale la pena anotarlo como deuda en `progress/` para la fase que toque asignaciones.
2. `src/lib/contacts/tag-events.ts:98` y `src/lib/automations/engine.ts:582` —
   `contact.tag_removed` se emite siempre, sin mirar si el `DELETE` quitó algo
   (`removeContactTag` devuelve `void`). Asimetría con `contact.tag_added`, que sí
   comprueba `added`. Consecuencia: un evento espurio si se quita una etiqueta que el
   contacto no tenía. Sin impacto de aislamiento (la pertenencia se valida antes en
   `assertContactAndTagOwnership`).
3. `src/lib/webhooks/queue.ts:236` — el reclamo no deja marca de «en vuelo», así que dos
   barridos separados por más de lo que tarda el reclamo pueden intentar la misma fila a la
   vez (ventana ≤ 5 s). Coherente con la semántica «al menos una vez» declarada en la
   cabecera del archivo y en `docs/public-api.md`; lo anoto por si algún día se quiere
   subir a «exactamente una vez por intento» con un `claimed_until`.
4. `src/app/(dashboard)/settings/page.tsx:71`, `src/lib/automations/engine.ts:649`,
   `src/app/api/v1/contacts/[id]/route.ts:110` — reformateo de prettier en código que la
   feature no cambia. Ruido en el diff, cero riesgo.

## Cambios requeridos

Ninguno. Las cuatro deudas que el informe declara (cubo fuera de `RATE_LIMITS`, código
`conflict` sin tipar, equidad acotada a la ventana de 500, purga sin lote) están bien
identificadas y son correctas como deuda: las tres primeras se cierran al fusionar con
`api/recursos` y la cuarta solo muerde en un despliegue que lleve meses sin cron.
