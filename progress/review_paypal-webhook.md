# Review — f3.3 paypal-webhook (2ª ronda)

**Veredicto:** APPROVED

Re-revisión de `b19f233` («fix: activar la suscripción de quien vuelve a contratar») sobre
`fa29715`. Rango de la feature: `git diff e564f47..b19f233` — 12 archivos, +3587/-3; la
corrección en sí son 7 archivos, +625/-45, **sin SQL nuevo**. Worktree
`.claude/worktrees/fase-3`, limpio, HEAD `9adc3d5`.

`9adc3d5` es el merge de `saas/fase-0-cimientos` que hizo el líder. Comprobado que **no**
mete nada en el rango de f3.3: `1c7ddab` («fix: enseñar el modo 'playground' al único lector
de ai_usage_log») no es ancestro de `b19f233` (`git merge-base --is-ancestor` → falso), y
`e564f47..b19f233` no toca ningún archivo de IA. Los seis cambios requeridos quedan cerrados.

Lancé el skill `code-review` a nivel `high` sobre `e564f47..b19f233`. Devolvió después de
que yo cerrara mi propia lectura hunk por hunk; sus seis hallazgos están contrastados uno a
uno en la sección «Contraste con `code-review`». Ninguno bloquea; dos corroboran los míos y
cuatro son nuevos y menores.

## Compuerta

Ejecutada por mí sobre el HEAD fusionado, no leída del informe.

- lint: **verde** — 0 errores, 37 warnings (línea base de la rama, sin cambios).
- typecheck: **verde**.
- `TZ=UTC npm test`: **verde** — **94 archivos, 1068 pruebas**. (El informe dice 91/1036: la
  diferencia son 3 archivos y 32 pruebas que entran con el merge de fase 0, no de f3.3.)
- build (con las dummy de `ci.yml`): **verde**, exit 0.
- `scripts/replay-migrations.sh <worktree>`: **verde**, exit 0, `verify-schema.sql: OK`.
  Aplicadas en orden 023→050, **incluidas 040, 041, 045, 047, 048, 049 y 050** del merge.
- `progress/checks_paypal-webhook.sql` ejecutado por mí contra ese Postgres
  (`ON_ERROR_STOP=1`): **verde**, `BEGIN/DO/ROLLBACK` **×6** (la parte F nueva), sin
  excepciones.

Nada rojo, ni por f3.3 ni por el merge.

## Cambios requeridos de la 1ª ronda, uno a uno

- **1. Re-contratar tras cancelar activa sobre la suscripción nueva** — [x] **cerrado**.
  `webhook-events.ts:335-345`: `adopting = onAnotherSubscription && ADOPTING_EVENT_TYPES ∋
  eventType && TERMINAL ∋ existing.status && Boolean(intent)`. Test de **ruta con la
  secuencia completa**, leído: `route.test.ts:495` › «activates the new subscription of a
  customer who contracted again after cancelling» — `ACTIVATED` de I-1 → `CANCELLED` de I-1
  con el ciclo ya vencido (la fila queda `cancelled`) → segundo intento sobre I-2 →
  `ACTIVATED` de I-2 deja `status active`, `provider_subscription_id I-2`,
  `cancel_at_period_end false`, `grace_until null`, `last_event_at` del evento nuevo, **una
  sola fila** de `subscriptions`, el intento nuevo `activated` y el viejo `cancelled`, y
  `scopesOf('subscriptions') === {ACCOUNT_A}`. Lógica pura: `webhook-events.test.ts:268`
  («takes over the row left by the subscription the customer cancelled») y :657 para el
  `SALE.COMPLETED` que se adelanta a su activación.
  **Y sigue rechazando la fila viva en otra suscripción** — verificado que el test de la 1ª
  ronda no se tocó: `route.test.ts:688` › «does not let another subscription rewrite an
  account already on one» (fila `active` sobre I-1 + intento sobre I-OTHER → `unmatched`, la
  fila intacta). Más las tres negativas nuevas: `webhook-events.test.ts:257` («does not
  rewrite a **LIVE** account…»), :307 («refuses to take a row over with no checkout intent of
  ours behind it», `intent = null` → `error`) y :318 («will not take over a row whose
  subscription is still alive», `past_due` → `error`). La adopción exige las cuatro
  condiciones a la vez; el control negativo del informe (`adopting = false` → caen 3 pruebas)
  fija que no es código muerto.
- **2. El duplicado reprocesa `processed_at IS NULL`** — [x] **cerrado**, con la decisión del
  líder implementada tal cual. `route.ts:145-193`: el 23505 ya no contesta `duplicate` a
  ciegas; relee la fila y solo contesta `duplicate` si `processed_at` está puesto (o si la
  fila no aparece). Test leído: `route.test.ts:382` › «reprocesses a redelivery of an event
  that was never applied» — primera entrega `unmatched` con `processed_at` NULL → se arregla
  la causa (el intento) → el **mismo** `event.id` se aplica, **una** fila de evento,
  `processed_at` puesto y `error` a NULL. Y `docs/docker.md:173-177` lo refleja: «Fix the
  cause and hit **Resend** … a redelivery of an event that was never applied
  (`processed_at IS NULL`) is processed again, so no row has to be deleted by hand. An event
  that _did_ complete is never applied twice». El caso contrario sigue probado en
  `route.test.ts:365` («processes the same event only once…», tres entregas → una escritura),
  porque un `skipped` sí cierra la fila (`finishEvent`: `matched = status !== 'unmatched'`).
- **3. El `catch` genérico deja `error` escrito y suelta el cerrojo** — [x] **cerrado**.
  `route.ts:233` llama a `recordFailure` (`:513-548`), que escribe
  `error = 'unexpected failure — <name>: <message>'` recortado a 500 y deja `processed_at`
  NULL a propósito: por el cambio 2 eso **es** soltar el cerrojo, sin perder el motivo. Es
  best-effort y no lanza; la respuesta sigue siendo 500. Test leído: `route.test.ts:407` ›
  «leaves a queryable reason when processing blows up unexpectedly» — un `TypeError` lanzado
  desde la escritura de `subscriptions` (mock `throwOnWrite`, no un `{error}` de supabase-js)
  → 500, `processed_at` NULL, `error` con el mensaje, **y la reentrega posterior procesa de
  verdad**. Cubre exactamente el par `processed_at IS NULL AND error IS NULL` que el hallazgo
  3 denunciaba como invisible a la consulta de `docs/docker.md:164`.
- **4. Test del `CANCELLED` viejo → `skip`** — [x] **cerrado**, en los dos niveles.
  `webhook-events.test.ts:517` › «cannot cancel a subscription a newer event already
  reactivated» (`create_time` 2026-03-01 contra `last_event_at` 2026-03-10 → `skip`) y
  `route.test.ts:851` › «does not cancel with a late cancellation of an already reactivated
  plan», que además afirma `writesTo('subscriptions')` y `writesTo('checkout_intents')`
  **vacíos**: ni el estado, ni la bandera, ni la marca de agua, ni el intento.
- **5. Parseo antes de verificar sin alterar los bytes** — [x] **cerrado**. `route.ts:105-113`
  hace `JSON.parse` y exige objeto plano (`!payload || typeof !== 'object' ||
  Array.isArray`) **antes** de `verifyPayPalWebhook(rawBody, …)` en `:115`; a PayPal siguen
  yendo los bytes originales. Tests leídos: `route.test.ts:349` › «refuses a body that is not
  a JSON object before asking PayPal» (`[1,2]`, `"a string"`, `null`, `42` → 400 y
  `expect(verifyPayPalWebhook).not.toHaveBeenCalled()`) y `:320` › «verifies the delivered
  bytes, never a re-serialisation of them» (cuerpo con saltos de línea y orden de claves que
  `JSON.stringify` no reproduce; afirma que lo que viaja es `rawBody`). Comentarios de
  `paypal.ts:432-437` y `:451-456` corregidos: ahora describen el orden real. Con la guarda,
  el escenario del hallazgo 4 (cerrar el objeto y colar un `webhook_id` raíz) es inalcanzable
  — un cuerpo así no es JSON válido y muere en el 400 sin llegar a PayPal.
- **6a. Guarda `TERMINAL`** — [x] **cerrado, y mejor de lo pedido**: se implementa como regla
  uniforme en `decideSubscriptionChange` (`terminated`, `webhook-events.ts:355-360`) en vez
  de dentro del manejador, y **no depende de `last_event_at`** (NULL en toda fila anterior a
  la 050), que era justo el agujero. Se trata como entrega tardía, así que el periodo aún
  puede avanzar: quien pagó conserva lo pagado. No colisiona con la adopción porque exige
  `existing.provider_subscription_id === subscriptionId`. Tests leídos:
  `webhook-events.test.ts:330` › «does not lift a cancelled subscription back with its own
  activation» (con `last_event_at: null`, `skip` y razón «already cancelled») y
  `route.test.ts:880` › «does not lift a cancelled subscription with a redelivery of its own
  activation».
- **6b. `quantity` numérica** — [x] **cerrado**. `numberOrNull` (`webhook-events.ts:69-81`)
  acepta número JSON finito o string numérica; `:535` usa `quantity !== null && quantity > 0`
  en vez del `Number(str(...))` que devolvía 0. Test leído: `webhook-events.test.ts:452` ›
  «records a quantity PayPal sends as a JSON number, not a string» → `addons`
  `{ paypal_quantity: 2 }`.
- **6c. Contraste de `provider_plan_id`** — [x] **cerrado implementándolo** (no corrigiendo
  el comentario de la 048), y sin migración: la 048 ya guarda la columna. `INTENT_COLUMNS`
  (`route.ts:65`) la selecciona, `resolveAccount` (`:412-420`) la propaga, y el manejador de
  `ACTIVATED` (`webhook-events.ts:467-477`) compara `event.resource.plan_id` con
  `intent.provider_plan_id`: si difieren → `error` → `unmatched`, **sin escritura**, y queda
  en la cola con su payload. Tests leídos: `route.test.ts:566` › «refuses an activation of a
  plan the customer never asked for» (`unmatched`, `db.subscriptions` vacío,
  `writesTo('subscriptions')` vacío, el `error` contiene `P-NEGOCIO-YEAR`) y `:579` ›
  «activates when PayPal reports the very plan the intent asked for»; en puro,
  `webhook-events.test.ts:341` y `:354`. La parte F del SQL comprueba contra el Postgres real
  que `checkout_intents.provider_plan_id` es `text` **NOT NULL**, así que el contraste siempre
  tiene con qué comparar.

## Trazabilidad criterio ↔ test (lo que cambió respecto a la 1ª ronda)

Los criterios C1, C1b, C2, C4, C5, la tabla de los seis eventos y el desorden siguen
cubiertos por los tests que ya leí en la 1ª ronda y que la corrección no debilita (solo se
renombró uno, `route.test.ts:320`). Lo que estaba en `[~]`/`[ ]` queda así:

- **C3 «Cerrar el navegador tras aprobar activa igualmente la suscripción»**: [x] — además de
  la primera contratación (`route.test.ts:470`) y la cuenta `trialing` (`:490`), ahora el
  caso que faltaba: re-contratar tras cancelar, `route.test.ts:495`, con la secuencia
  completa de cuatro pasos.
- **Desorden — `CANCELLED` viejo tras un `ACTIVATED` nuevo**: [x] — `webhook-events.test.ts:517`
  y `route.test.ts:851`.
- **Verificación contra base real**: [x] — `progress/checks_paypal-webhook.sql` parte F,
  ejecutada por mí: un segundo `checkout_intents` sobre otra suscripción del proveedor cabe
  en el esquema (el UNIQUE de la 048 es por suscripción, no por cuenta — si fuera por cuenta
  recontratar sería imposible); el UPDATE de adopción acotado por `account_id` no choca con
  el UNIQUE de `subscriptions.provider_subscription_id` y deja **una** fila; la cola de
  reconciliación se vacía con el reenvío **en sitio**, sin borrar. Control negativo del
  informe (`DROP NOT NULL` sobre `provider_plan_id`) verosímil y coherente con la aserción.
- **Sandbox de PayPal**: [x] guion manual ampliado con los pasos 11–13 (recontratación,
  `Resend` de un `unmatched`, `Resend` de un procesado), que son exactamente los tres caminos
  nuevos que un mock no puede cerrar. Pendiente de ejecución humana, como corresponde.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí sobre el HEAD fusionado.
- **CP2 Migraciones**: [x] la corrección **no añade SQL**; la 050 no se tocó. Sigue idempotente
  (`ADD COLUMN IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`), sin ningún `CASCADE`, con sus
  dos aserciones en `verify-schema.sql` (una por objeto). Replay exit 0 con las 040/041/045/
  047/048/049/050 del merge. Confirmado que la 041 fusionada trae
  `subscriptions_account_id_fkey … ON DELETE RESTRICT`.
- **CP3 Aislamiento**: [x] las tres escrituras nuevas o cambiadas siguen acotadas:
  `writeSubscription` (`route.ts:472` `.eq('account_id', accountId)`; el insert `:480` lleva
  `account_id` en el payload), `markIntent` (`:504`). `recordFailure` (`:528-534`) y la
  lectura del duplicado (`:169-172`) van sobre `billing_events`, que no tiene columna de
  cuenta, filtradas por `(provider, provider_event_id)` — la clave UNIQUE. Las dos únicas
  lecturas sin filtro de cuenta siguen siendo las que **producen** la cuenta, por columnas
  UNIQUE. `subscriptions.account_id` es PRIMARY KEY (041:66), así que el UPDATE de adopción
  toca exactamente una fila. Test de fuga intacto y ampliado: la secuencia de recontratación
  vuelve a afirmar `scopesOf('subscriptions') === {ACCOUNT_A}`.
- **CP4 Tests**: [x] — ya sin `[~]`. 17 pruebas nuevas, todas leídas, cada una con su control
  negativo declarado en el informe (8 mutaciones, y las que caen son las que deben caer).
- **CP5 Sin dependencias nuevas**: [x] `package.json` / `package-lock.json` no aparecen en
  `e564f47..b19f233`.
- **CP6 i18n**: [x] n/a — `messages/` no aparece en el diff; no hay texto de UI.
- **CP7 Next 16**: [x] recomprobado contra
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:31`
  (`export async function POST(request: Request) {}`). El cambio no altera la forma del
  handler; el build sigue marcando la ruta dinámica y `ƒ Proxy (Middleware)`.
- **CP8 Alcance**: [x] los 7 archivos de la corrección son los mismos módulos de §3 más docs.
  Nada fuera; ningún arreglo oportunista de la deuda ajena.
- **CP9 Documentación**: [x] — el `[~]` de la 1ª ronda queda cerrado: el runbook de
  `docs/docker.md` ya describe un procedimiento que **funciona** (Resend reprocesa lo no
  aplicado). `CHANGELOG.md` (Unreleased) actualizado con la recontratación, el reenvío y el
  contraste de plan. El informe coincide con el diff archivo por archivo, incluida la nota de
  que la suite que él midió (1036) es la de antes del merge.
- **CP10 Git**: [x] `b19f233` solo en `saas/fase-3-facturacion` (`git branch --contains`),
  mensaje en español con prefijo `fix:` y `Co-Authored-By`, sin push. `main` y
  `feat/saas-multiempresa` intactos.
- **CP11 Lo entrante nunca se bloquea**: [x] `git diff e564f47..b19f233 --name-only` no
  contiene nada de `whatsapp`; la feature sigue sin leer estado de facturación en ninguna
  ruta entrante.

## Hallazgos (archivo:línea) — ninguno bloqueante

1. `src/lib/billing/checkout.ts:71` + `src/lib/billing/webhook-events.ts:454-463` — **la
   adopción solo es alcanzable si el ciclo ya venció al llegar el `CANCELLED`.** El manejador
   de `CANCELLED` deja `status = 'active'` con `cancel_at_period_end = true` mientras quede
   ciclo, y **nada en §3 mueve esa fila a `cancelled`/`expired` cuando el ciclo pasa** (la
   escalera de vencimiento es §5 → f3.4). Como `CONTRACTED_STATUSES` incluye `active`, quien
   cancela a mitad de ciclo no puede volver a contratar hasta que algo escriba el estado
   terminal, y ese algo todavía no existe. No es un fallo de f3.3 —el barrido de vencimiento
   no es su sección, y el camino que arregla el hallazgo 1 está correcto y probado— pero la
   corrección no sirve de nada hasta que f3.4 escriba `expired`. **Para el líder: atar esto a
   f3.4 explícitamente**, o la recontratación seguirá rota de cara al cliente.
2. `src/app/api/billing/webhook/route.ts:145-193` — el cambio 2 **ensancha** la ventana del
   hallazgo 5 (lectura-modificación-escritura sin bloqueo): dos entregas del mismo evento en
   vuelo a la vez ya no se cortan con `duplicate`, se procesan en paralelo. El informe lo
   declara honestamente y el daño sigue acotado (valores absolutos + marca de agua), y el
   hallazgo 5 es deuda aceptada por decisión del líder — pero ahora hay dos motivos para el
   mismo `UPDATE … WHERE last_event_at IS NOT DISTINCT FROM <leído>`, no uno.
3. `src/app/api/billing/webhook/route.ts:105-113` — el 400 por JSON inválido ahora ocurre
   **antes** de verificar la firma, así que quien no tiene firma puede distinguir 400 de 401.
   No revela nada (el cuerpo lo controla quien llama) y es el precio de la corrección 5.
   Anotado, no accionable.
4. `b19f233` — el trailer dice `Co-Authored-By: Claude Fable 5.1` y el implementer corre en
   Opus. Cosmético; CP10 solo exige que el trailer esté.

## Contraste con `code-review` (high, `e564f47..b19f233`)

Corrí el skill y verifiqué **yo** cada hallazgo contra el código antes de aceptarlo. Corrió
además la suite de facturación en un worktree desechable (188 pruebas, verdes), consistente
con mi compuerta.

- **Su 1 (medium, `webhook-events.ts:565`) = mi hallazgo 1. Confirmado y reforzado.** Aporta
  la prueba que a mí me faltaba: `BILLING.SUBSCRIPTION.EXPIRED` **no está** en
  `HANDLED_EVENT_TYPES` (`webhook-events.ts:30-37`), y la entrada `EXPIRED` de `STATUS_MAP`
  (`:281`) solo es alcanzable desde `UPDATED`, que PayPal no manda al vencer el plazo. Así
  que nada —ni evento, ni cron— mueve nunca la fila de `active` + `cancel_at_period_end` a
  terminal. Suma una consecuencia que yo no había recorrido: `isReadOnly()` tampoco se activa
  jamás, o sea que quien cancela a mitad de ciclo **conserva servicio completo para siempre**,
  no solo «no puede recontratar». Sigue siendo f3.4 (§5), no §3, pero sube la urgencia.
- **Su 2 (medium, `route.ts:94`) — sin límite de tasa.** Es la decisión 11 del informe, que yo
  acepté en la 1ª ronda; su argumento es mejor que el que yo pesé: la verificación de firma es
  una llamada **saliente**, así que cualquiera que conozca la URL puede hacernos gastar token
  OAuth + `verify-webhook-signature` en bucle y agotar la cuota de la API de PayPal —con lo
  que las entregas legítimas fallarían cerrado (401) **y** `createSubscription` de §2
  empezaría a dar 502. No es criterio de §3 ni checkpoint, y estrangular a PayPal tiene su
  propio riesgo, pero un cubo por IP/`transmission-id` **antes** de la llamada saliente es
  barato. Para el líder: f3.4.
- **Su 3 (low, `route.ts:189`) — nuevo, correcto.** `if (!recorded || processedAt)` contesta
  `duplicate` también cuando la fila **no está**, y ausencia no es «ya procesado»: es el
  estado que deja la rama transitoria de una entrega concurrente del mismo evento al borrar el
  cerrojo. En ese entrelazado este request acusa 200 sin hacer nada. No se pierde el evento
  (el otro request devuelve 500 y PayPal reintenta), pero `!recorded` es justo el caso en que
  nada se aplicó y lo seguro sería procesar, no acusar.
- **Su 4 (low, `route.ts:205`) — nuevo, correcto.** La rama de `TransientWebhookError` borra
  la fila de `billing_events` sin mirar de dónde vino el throw, y `finishEvent` —que es quien
  lanza ese error— corre **después** de que `writeSubscription`/`markIntent` hayan
  comprometido. Resultado posible: la suscripción cambiada y **cero** rastro de auditoría, ni
  payload, ni visibilidad en la consulta de reconciliación. Converge si PayPal reintenta;
  si la ventana de reintento se agota, queda un cambio de facturación aplicado y mudo.
  Acotarlo a los fallos de `handleEvent` es una condición.
- **Su 5 (low, `paypal-webhook-signature.ts:124`) — matiz de capas sobre mi cambio 5.** La
  precondición se cumple, pero la impone `route.ts`, no la guarda. Hoy es correcto (lo probé);
  su punto es que un segundo punto de entrada la rompería en silencio. Mover el `JSON.parse` +
  objeto plano dentro de `verifyPayPalWebhook` lo haría estructural en vez de convencional.
- **Su 6 (low, `route.ts:15-21`) — nuevo, verificado y el que más me importa de los cuatro.**
  La cabecera del archivo sigue diciendo, en la propiedad 2: «A clash means the event was
  already taken, and the answer is 200 with nothing done». Eso es **exactamente lo contrario**
  de lo que hace ahora `:145-193` por el cambio 2 que yo exigí, y de lo que dice
  `docs/docker.md`. Es la misma clase que el hallazgo 4 de la 1ª ronda (un comentario que
  afirma lo que el código no sostiene), en un archivo donde un modelo mental equivocado cuesta
  dinero — aunque aquí **no** afirma una invariante de seguridad falsa, solo se quedó viejo.
  No lo convierto en bloqueante por eso, pero debe caer en el próximo commit que toque el
  archivo.

Lo que el skill revisó y dio por sano coincide con lo mío: fallo cerrado de la firma y
comprobación de `cert_url`, bytes crudos preservados por `paypalFetch({rawBody})`, el
`laterIso` que nunca retrocede, la interacción `adopting`/`terminated`/`late`, el `custom_id`
solo como contradicción, `account_id` en toda escritura de rol de servicio, la idempotencia de
la 050 con sus aserciones, y que `middleware.ts` no intercepta `/api/billing/*`.

## Cambios requeridos

Ninguno. Los seis de la 1ª ronda están cerrados con test leído por mí; el hallazgo 5 sigue
siendo deuda declarada por decisión del líder, con la nota 2 de arriba encima.

Para el líder, por orden de lo que costaría dejarlo correr, **todo fuera de §3**:

1. **f3.4 tiene que escribir el estado terminal** (mi hallazgo 1 + su 1). Sin eso, quien
   cancela a mitad de ciclo conserva servicio para siempre y no puede recontratar, y la
   corrección bloqueante de esta ronda queda sin camino que la alcance.
2. **Cabecera de `route.ts:15-21` desactualizada** (su 6): una línea, en el próximo commit que
   toque el archivo.
3. `route.ts:205` acotado a `handleEvent` (su 4) y `route.ts:189` procesando cuando la fila no
   está (su 3): dos condiciones, cierran los dos rastros que pueden perderse.
4. Límite de tasa antes de la llamada saliente de verificación (su 2) y el `UPDATE`
   condicional por `last_event_at` (hallazgo 5): los dos de f3.4.
