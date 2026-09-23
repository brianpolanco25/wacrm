# a7.4 `webhooks-durable` — informe de implementación

Rama `api/webhooks`, worktree `.claude/worktrees/api-webhooks` (base `main` @ 3b82698).
Spec: `progress/spec_api-publica.md` §4 + «Seguridad transversal» + S-A6/S-A7.

## Plan (escrito antes de tocar código)

1. **Migración 062 + cola + cron** — tabla `webhook_deliveries`, escalera de reintentos,
   encolado, reclamo, barrido con cupo por cuenta y purga; ruta `GET /api/webhooks/cron`.
2. **Eventos nuevos** en `WEBHOOK_EVENTS` y sus disparadores de dominio.
3. **Rutas v1** de entregas, reintento, prueba y rotación de secreto.
4. **Panel** Ajustes → Webhooks + rutas con cookie, textos es/en/ko y documentación.

Los cuatro hitos salieron en cuatro commits, cada uno con la compuerta en verde.

## Commits

| Commit | Qué entra |
|---|---|
| `e1fe546` | Migración 062, `src/lib/webhooks/queue.ts`, `deliver.ts` reescrito sobre la cola, `GET /api/webhooks/cron`, aserciones en `verify-schema.sql` |
| `c03241e` | Ocho eventos nuevos y sus disparadores de dominio; `PATCH /api/conversations/{id}`; `emit.ts` |
| `d0c891d` | `src/lib/webhooks/manage.ts` y las cuatro rutas nuevas de `/api/v1/webhooks/{id}/…`; ampliación de la suite de aislamiento |
| `170d73e` | Pestaña Ajustes → Webhooks, rutas `/api/account/webhooks/**`, es/en/ko, CHANGELOG, `docs/docker.md`, `docs/security.md`, `docs/public-api.md` |

## Criterio ↔ test

| Criterio de la spec | Test |
|---|---|
| 500 → `failed` con `next_attempt_at` a +1 min | `src/lib/webhooks/queue.test.ts` › `attemptDelivery` › «un 500 deja la entrega failed con next_attempt_at a +1 min» |
| el cron la reintenta y, agotada la escalera, la marca `dead` | `src/lib/webhooks/queue.test.ts` › «reintenta lo vencido y, agotada la escalera, lo marca dead» |
| un 200 en el 3.º intento → `delivered` | `src/lib/webhooks/queue.test.ts` › «un 200 en el tercer intento la deja delivered» |
| la escalera es la de S-A6 (1 m, 5 m, 30 m, 2 h, 12 h) | `src/lib/webhooks/queue.test.ts` › `backoffMsForAttempt` › «da 1 min, 5 min, 30 min, 2 h y 12 h en ese orden» + «se agota tras los cinco reintentos» |
| el barrido reparte el cupo entre cuentas (1 000 pendientes no bloquean a 1) | `src/lib/webhooks/queue.test.ts` › `selectFairBatch` › «una cuenta con 1 000 pendientes no bloquea a otra con 1» y `sweepDueDeliveries` › «reparte el barrido entre cuentas» |
| SSRF comprobado en **cada** intento | `src/lib/webhooks/queue.test.ts` › «comprueba SSRF en CADA intento: una URL que pasa a resolver a 10.x no se llama» |
| fuga: entregas de otra cuenta → 404 | `src/lib/security/tenant-isolation.test.ts` › «deliveries: solo las de A; el endpoint y la entrega de B → 404; el payload no sale»; `src/lib/webhooks/manage.test.ts` › «un endpoint de otra cuenta no existe (404, no 403)», «una entrega de otra cuenta no existe» |
| el panel no ve `secret` | `src/lib/webhooks/manage.test.ts` › `rotateWebhookSecret` › «cambia el secreto guardado y devuelve el nuevo una vez»; `src/app/api/account/webhooks/route.test.ts` › «crea con admin, cifra el secreto y lo devuelve una vez» |
| `dispatchWebhookEvent` persiste una entrega por endpoint y hace el primer intento | `src/lib/webhooks/deliver.test.ts` › «persiste una entrega por endpoint suscrito y hace el primer intento» |
| un receptor caído no pierde el evento | `src/lib/webhooks/deliver.test.ts` › «un receptor caído deja la entrega en la cola, no la pierde» |
| autodesactivación a los 15 fallos, conservada | `src/lib/webhooks/queue.test.ts` › «sigue disparándose a los 15 fallos consecutivos» |
| purga de entregas > 30 días | `src/lib/webhooks/queue.test.ts` › `purgeOldDeliveries` › «borra la bitácora de más de 30 días y respeta la reciente» |
| cron protegido por `WEBHOOK_CRON_SECRET` en `x-cron-secret` | `src/app/api/webhooks/cron/route.test.ts` (503 sin variable, 401 sin cabecera, 401 con longitud distinta, 401 con mismo largo y distinto valor, 200 drenando y purgando) |
| `GET /api/v1/webhooks/{id}/deliveries` paginado y con filtro | `src/lib/webhooks/manage.test.ts` › `listDeliveries` (orden, filtro, cursor) + `src/app/api/v1/webhooks/[id]/deliveries/route.test.ts` |
| `POST …/retry` | `src/lib/webhooks/manage.test.ts` › `retryDelivery` + `src/app/api/v1/webhooks/[id]/deliveries/[deliveryId]/retry/route.test.ts` (200/404/409/429) |
| `POST …/test` entrega un `ping` firmado | `src/lib/webhooks/manage.test.ts` › `sendTestDelivery` › «encola y entrega un ping firmado…» + `src/app/api/v1/webhooks/[id]/test/route.test.ts` |
| `POST …/rotate-secret` devuelve el secreto una vez | `src/lib/webhooks/manage.test.ts` › `rotateWebhookSecret` + `src/app/api/v1/webhooks/[id]/rotate-secret/route.test.ts` |
| eventos nuevos declarados y documentados | `src/lib/webhooks/events.test.ts` › «incluye los eventos de dominio de la fase 7», «declara los campos de `data` de cada evento» |
| `conversation.closed` / `conversation.assigned` desde el dominio | `src/lib/conversations/status-events.test.ts` (10 casos: emisión, no-op, fuga entre cuentas, variante por contacto del motor) y `src/app/api/conversations/[id]/route.test.ts` |
| `contact.tag_added` / `contact.tag_removed` | `src/lib/contacts/tag-events.test.ts` › describe «webhooks de etiquetas» |
| `contact.created` solo en el alta real | `src/lib/api/v1/contacts.test.ts` › «emite contact.created solo en el alta real» |
| `broadcast.completed`, una sola vez | `src/lib/whatsapp/broadcast-core.test.ts` › «emite broadcast.completed al cerrar la campaña, con sus cuentas», «no lo emite dos veces si la campaña ya estaba cerrada», «tampoco lo emite mientras queden destinatarios pendientes» |
| panel: crear rechaza `http://` y eventos desconocidos; plan sin webhooks no crea | `src/app/api/account/webhooks/route.test.ts` |
| panel: acotación por cuenta, reactivar limpia la racha, 404 ajeno | `src/app/api/account/webhooks/[id]/route.test.ts` |
| panel: probar y reintentar con rol de servicio acotado a la sesión | `src/app/api/account/webhooks/[id]/test/route.test.ts` |
| textos en los tres catálogos con las mismas claves | `src/i18n/messages.test.ts` (paridad + ICU) y `src/i18n/brand.test.ts`, ya existentes |

## Verificaciones contra base real

`progress/checks_webhooks-durable.sql`, ejecutado contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh .claude/worktrees/api-webhooks` y luego `psql`). Salida:
`checks_webhooks-durable: OK`. Cubre lo que los mocks no ven:

- **A.** el `CHECK` de `status` rechaza un estado inventado (`retrying`) y acepta los cuatro
  legítimos. Sin él, un estado fuera del filtro del barrido perdería la entrega en silencio.
- **B.** RLS real con `request.jwt.claim.sub`: un miembro ve 1 entrega (la suya) y 0 de la otra
  cuenta, y un `INSERT` como `authenticated` falla con `insufficient_privilege` — encolar es solo
  del rol de servicio. Una entrega forjada sería un POST firmado por nosotros a la URL que
  quisiera el atacante.
- **C.** el reclamo optimista: dos `UPDATE` con la misma foto (`attempt = 0`) afectan 1 y 0 filas.
  Es la garantía de que dos barridos solapados no entregan dos veces.
- **D.** cascadas: borrar el endpoint (y borrar la cuenta) no deja payloads huérfanos.
- **E.** el índice del barrido existe y es parcial.

`scripts/replay-migrations.sh` sale 0 con `verify-schema.sql: OK` (001–060 + 062; la 061 es de la
rama hermana y no está en este worktree, lo que confirma que la 062 no depende de ella).

## Verificaciones manuales pendientes

Ninguna depende de Meta ni de PayPal, pero sí hay una que necesita un receptor real:

1. **Cron en un despliegue.** Programar `curl -H "x-cron-secret: $WEBHOOK_CRON_SECRET"
   https://<host>/api/webhooks/cron` cada minuto y comprobar en la respuesta JSON que
   `scanned/attempted/delivered/purged` avanzan. Sin la variable la ruta devuelve 503: es el
   modo de fallo ruidoso buscado.
2. **Ida y vuelta con un receptor real.** Crear un endpoint en Ajustes → Webhooks contra un
   servicio tipo webhook.site o un `nc` propio con TLS, pulsar «Probar» y verificar a mano la
   firma con el fragmento de `docs/public-api.md`. Después apagar el receptor, provocar un
   evento (etiquetar un contacto), ver la entrega `failed` con `next_attempt_at` a +1 min,
   encender el receptor y comprobar que el barrido la entrega.
3. **SSRF con DNS cambiante.** Registrar un dominio que resuelva público y repuntarlo a 10.x
   entre el alta y la entrega; la entrega debe quedar `failed` con
   «delivery target does not resolve to a public address» y sin ninguna petición saliente.
   Automatizado con mock en vitest, pero conviene verlo una vez con DNS de verdad.

## Decisiones donde la spec era ambigua

1. **Cuántos intentos.** S-A6 dice «5 reintentos con espera 1 min, 5 min, 30 min, 2 h, 12 h» y el
   criterio dice «tras 5 fallos, la marca `dead`». Las dos frases no pueden ser ciertas a la vez:
   cinco reintentos consumen las cinco esperas y eso son **seis** intentos (el inicial más cinco),
   mientras que morir al quinto fallo dejaría la espera de 12 h sin usar nunca. Se implementa
   S-A6 literal (`MAX_ATTEMPTS = 1 + RETRY_BACKOFF_MS.length = 6`), que es lo que el prompt del
   líder señaló como autoritativo y lo único que da sentido a los cinco valores. El test recorre
   la escalera entera hasta `dead`.
2. **Reparto por cuenta.** El cupo se aplica en TypeScript (`selectFairBatch`, por turnos) sobre
   una ventana de barrido de 500 filas ordenadas por vencimiento, en vez de con una función SQL
   con `row_number()`: `FOR UPDATE SKIP LOCKED` no se puede combinar con funciones de ventana en
   la misma consulta, y partir la función en CTEs habría dejado la equidad igual de acotada a la
   ventana pero con SQL mucho menos revisable. Limitación anotada abajo.
3. **Reclamo sin estado `processing`.** El candado es optimista sobre `attempt`
   (`UPDATE … WHERE id = ? AND attempt = ?`), no un estado nuevo en el `CHECK`. Misma familia que
   el reclamo de `/api/automations/cron` y sin ampliar el enum de estados que la spec fija.
4. **Reintento manual de una entrega `pending`.** Se rechaza con 409 en lugar de reintentar:
   reintentar a mano algo que ya está en cola es entregarlo dos veces. Las `failed`, `dead` y
   `delivered` sí se reencolan, y lo hacen desde el **primer** peldaño (si no, una entrega ya
   muerta volvería a morir al primer fallo y el botón sería decorativo).
5. **`broadcast.completed` sin repetición.** `finalizeBroadcastStatus` pasa a ser idempotente
   (`.neq('status', finalStatus)`): sin eso, cada pasada vacía de «reanudar» reemitía el evento.
   Efecto colateral deseable: deja de reescribir `updated_at` sin motivo.
6. **Cerrar/asignar desde la bandeja pasa por el servidor.** El panel escribía `status` y
   `assigned_agent_id` directamente contra Supabase desde el navegador, así que no había dónde
   emitir el evento. Se añade `PATCH /api/conversations/{id}` (sesión de cookie, cliente con RLS,
   `requireRole('agent')` — exactamente el mismo permiso que exige la política de la 017) y
   `message-thread.tsx` llama ahí. No se gana ni se pierde acceso.
7. **Ping no es suscribible.** `ping` no entra en `WEBHOOK_EVENTS` a propósito: un evento que
   nadie puede recibir por suscripción no ensucia el catálogo ni el formulario del panel.
8. **El `payload` no sale nunca.** Ni la API ni el panel devuelven la columna: lleva el texto del
   cliente final y la bitácora la ve cualquier miembro de la cuenta. La spec no lo pedía; la
   sección de seguridad transversal sí lo implica.
9. **Rotación sin periodo de gracia.** Un solo secreto válido en todo momento. Dos secretos
   válidos son dos cosas que pueden filtrarse; la interfaz avisa antes de rotar y la
   documentación lo dice.

## Variables de entorno nuevas

| Variable | Obligatoria | Qué es |
|---|---|---|
| `WEBHOOK_CRON_SECRET` | para que haya reintentos | Secreto compartido de `GET /api/webhooks/cron`, en `x-cron-secret`, comparado con `timingSafeEqual`. Sin ella la ruta responde 503 y solo ocurre el primer intento de cada entrega. |

Documentada en `docs/docker.md` (con el crontab de un minuto y el porqué de esa frecuencia) y en
`docs/security.md` (sección «Outbound webhook delivery queue»).

**`.env.local.example` está bloqueado por permisos para los agentes**: la línea
`WEBHOOK_CRON_SECRET=` la tiene que añadir el humano, junto a `AUTOMATION_CRON_SECRET`. Es el
mismo pendiente que arrastran `ENCRYPTION_KEY_PREVIOUS`, `META_WEBHOOK_VERIFY_TOKEN` y
`PAYPAL_WEBHOOK_ID` de fases anteriores.

## Deuda detectada (fuera de alcance, no la arreglé)

1. **El cubo de rate limit vive fuera de `RATE_LIMITS`.** `WEBHOOK_ACTION_RATE_LIMIT` está en
   `src/lib/webhooks/manage.ts` para no chocar con `api/recursos`, que está tocando
   `src/lib/rate-limit.ts` en paralelo. Al fusionar hay que moverlo a `RATE_LIMITS` con el resto.
2. **El código de error `conflict` está escrito a mano.** `fail('conflict', …, 409)` en la ruta de
   reintento; `ApiErrorCode` lo añade a7.1 en la otra rama. Al fusionar, tipar.
3. **Equidad acotada a la ventana de barrido.** `selectFairBatch` reparte sobre las 500 filas
   vencidas más antiguas. Una cuenta con más de 500 vencidas simultáneas podría llenar la ventana
   y retrasar (no perder) la entrega de otra cuenta cuyo vencimiento sea posterior. La solución
   real es una función SQL que seleccione por cuenta; se documenta y se deja para cuando haya
   volumen que lo justifique (fase 5 §3).
4. **La purga no está acotada por lote.** `purgeOldDeliveries` borra todo lo anterior a 30 días en
   una sentencia y devuelve los ids borrados. En un despliegue que lleve meses sin cron, el primer
   barrido puede borrar mucho de golpe. Un `LIMIT` necesitaría una función SQL (PostgREST no lo
   ofrece en `DELETE`).
5. **Las cabeceras de entrega siguen diciendo `Wacrm`.** `X-Wacrm-Event`, `X-Wacrm-Signature`,
   `X-Wacrm-Webhook-Id` y los dos que añade esta feature (`X-Wacrm-Delivery-Id`,
   `X-Wacrm-Attempt`) conservan la marca retirada. Renombrarlas rompería a todos los receptores
   existentes, así que se dejan tal cual; por eso el texto del panel habla de «la firma que
   acompaña a cada entrega» en vez de nombrar la cabecera (el test `src/i18n/brand.test.ts`
   prohíbe la marca retirada en los catálogos, y con razón).
6. **El alta y la edición de contactos desde el panel siguen siendo escrituras directas del
   navegador**, así que `contact.updated` solo sale de `PATCH /api/v1/contacts/{id}`, y
   `contact.created` de la API y del webhook entrante. Cerrarlo del todo pide llevar esas
   escrituras a rutas de servidor, como se ha hecho aquí con conversaciones; es un cambio de
   alcance propio.
7. **El primer intento sigue corriendo dentro de `after()`.** Si el proceso muere ahí, la fila
   queda `pending` con `next_attempt_at` en el pasado y la recoge el barrido siguiente — correcto,
   pero significa que un despliegue sin cron ni siquiera reintenta ese caso.
8. **`src/lib/security/service-role-audit.ts` no tuvo que ampliarse**: todas las consultas nuevas
   con rol de servicio llevan `account_id` (el barrido del cron es global por definición y no se
   ejercita en esa suite).

## Compuerta

Ejecutada paso a paso en primer plano sobre el worktree, tras el último commit:

- `npm run lint` → 0 errores (35 avisos preexistentes, ninguno en archivos nuevos).
- `npm run typecheck` → limpio.
- `TZ=UTC npm test` → 165 archivos, **2 170 tests**, todos verdes (base: 155 archivos / 2 103).
- `npm run build` con las variables dummy de `docs/harness.md` → «Compiled successfully».
- `scripts/replay-migrations.sh "$(pwd)"` → salida 0, `verify-schema.sql: OK`.
- `progress/checks_webhooks-durable.sql` → `checks_webhooks-durable: OK`.
