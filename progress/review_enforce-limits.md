# Review — f3.4 enforce-limits (ronda final)

**Veredicto:** APPROVED

Rango de esta ronda: `1446796..08bc791` (1 commit, 12 archivos, +464/−96, sin SQL).
Conjunto de la feature: `9adc3d5..08bc791` (4 commits) en `saas/fase-3-facturacion`,
worktree `.claude/worktrees/fase-3`, HEAD `08bc791`, árbol limpio.

Los tres defectos que dejé anotados al aprobar `1446796` (A, B, C) están **cerrados**,
cada uno con test que yo he leído y que discrimina de verdad la versión rota. No aparece
nada nuevo que sea tope esquivable, bloqueo de lo entrante ni fuga entre cuentas. Lo que
queda abajo son observaciones, dos de ellas serias y con dueño para la fase 4.

## Compuerta

Ejecutada por mí en el worktree, no leída del informe.

- `npm run lint`: **verde** (0 errores, 37 warnings, todos preexistentes y fuera de los
  archivos de la ronda).
- `npm run typecheck`: **verde**.
- `TZ=UTC npm test`: **verde** — 105 archivos, **1204 tests**, 0 saltados (antes 1193; +11).
- `npm run build` con las dummy de `docs/harness.md`: **verde**.
- `scripts/replay-migrations.sh <worktree>`: **verde**, salida 0, `verify-schema.sql: OK`.
  La ronda no toca SQL; lo corro igualmente porque la feature sí tocó (046, 052).

## Trazabilidad criterio ↔ test (ronda final)

### A — editar el número propio ya no devuelve 402

- «Editar la fila existente con `numbers: 1` → 200»: [x]
  `src/app/api/whatsapp/config/route.test.ts:204` › *"lets a 1-number plan swap its number:
  editing the row is not a second number"*. Fila `cfg-1` con `pn-old`, se guarda `pn-prod`,
  200, `updated.phone_number_id = 'pn-prod'`, `inserted === null`, y el filtro capturado es
  `['neq:id','cfg-1']`.
- «El conteo excluye por identidad de fila, no por número»: [x] verificado en
  `route.ts:247-253` (`numberCountQuery.neq('id', existing.id)` cuando hay fila, sin
  exclusión cuando no la hay).
- «El test que canonizaba el fallo ya no existe»: [x] el `numberCount = 1` fijo desapareció.
  Y el doble de Supabase ahora **aplica los filtros**: `route.test.ts:123-139` filtra las
  filas por `neq:id`, de modo que con el `.neq('phone_number_id', …)` viejo el conteo daría
  1 y el test de arriba se pondría rojo. Comprobado leyendo el doble, no solo el `it`.
- «El 402 sigue existiendo por un camino alcanzable»: [x] `:224` › *"402s when the plan
  leaves no room for the number being saved"*, con `numbers: 0`. El caso multi-fila es
  inalcanzable mientras viva `UNIQUE(account_id)`, y el test lo dice en su cuerpo en vez de
  fingirlo. Correcto: prefiero un test honesto y estrecho a uno falso y ancho.
- «Falla cerrado»: [x] `:258` (conteo) y `:265` (lectura de la fila) → 500, nada escrito.
- Aislamiento: [x] `:243` › *"counts only this account… (leak test)"* — `['account_id',
  'acct-1']` y `assertWritable('acct-1')`.

### B — §5 llega a flujos y automatizaciones (§5 «suspended no puede enviar»)

- «Cuenta suspendida: el flujo no envía, no persiste, no cobra»: [x]
  `src/lib/flows/meta-send.test.ts:198` › *"engineSendText sends nothing, persists nothing
  and bills nothing"* — `AccountLockedError`, `sendTextMessage` no llamado, `inserts` vacío,
  `recordUsage` no llamado y `assertQuota` **tampoco** (el orden §5→§4 está probado, no solo
  escrito).
- «Los otros dos senders del motor de flujos igual»: [x] `:212` (media + botones).
- «Automatizaciones»: [x] `src/lib/automations/meta-send.test.ts:135` › *"sends nothing for
  a suspended account, and does not even weigh it"*.
- «Los cuatro puntos de envío»: [x] verificado por grep, no por el informe:
  `flows/meta-send.ts:85,201,359` y `automations/meta-send.ts:137`. El
  `engineSendInteractive` de automatizaciones (`automations/meta-send.ts:89`) delega en los
  senders de flujos, así que queda cubierto por `:359`; no hay quinto camino sin compuerta.
- Fuga: [x] `flows/meta-send.test.ts:233` y `automations/meta-send.test.ts:152` —
  `assertWritable` se pregunta por la cuenta que envía y **no** por `acct-1`.
- **CP11, leído entero**: [x] tres mitades, las tres con test:
  1. El entrante se guarda **antes** de que se pregunte nada:
     `src/app/api/whatsapp/webhook/route.test.ts:613` › *"stores the inbound before either
     outbound engine is asked anything"*. No asserta «al final hay un mensaje» sino que
     había 1 persistido **en el instante** en que entra cada motor. Es la forma correcta.
  2. El rechazo no escapa al `after()`: `src/lib/flows/dispatch.test.ts:331` › *"swallows
     the refusal instead of letting it reach the webhook"* y
     `src/lib/automations/engine.test.ts:575` › *"logs the refused send as a failed step and
     never throws"* (asserta el último `logUpdates` con `status: 'failed'`).
  3. El webhook sigue sin consultar la capa de facturación por sí mismo: los dos tests
     estructurales de la ronda anterior siguen verdes.

### C — una difusión rechazada no deja contactos detrás

- «Se pesa antes de escribir nada»: [x] `broadcast-core.ts:204` está **encima** del bucle
  de `findOrCreateContact` (`:213`), verificado en el archivo, no en el informe.
  `broadcast-core.test.ts:273` › *"weighs the whole campaign before writing anything at
  all"* → `assertQuota(…, 2)` con dos números distintos.
- «Rechazada: ni campaña ni contactos»: [x] `:311` › *"refuses over the limit and persists
  no campaign — nor any contact"* — `findOrCreateContact` **no** se llamó. Es el assert que
  faltaba y ahora existe (el mock se movió a `vi.hoisted` para poder interrogarlo).
- «Un número repetido se pesa una vez»: [x] `:288` › *"weighs a number the caller listed
  twice once"* (`+14155550123` y `+1 415 555 0123` → 1).
- «El comentario dice la verdad»: [x] `:186-203` describe la cota superior y por qué se
  yerra hacia rechazar. `deliverBroadcast` sigue pesando las filas exactas (`:309`) antes
  del primer envío, así que el tope no se afloja: se pesa de más, nunca de menos.

### Criterios del spec que esta ronda mueve

- «Una cuenta `suspended` no puede enviar, difundir ni usar IA»: [x] — hasta esta ronda
  estaba a medias (flujos y automatizaciones seguían respondiendo). Ahora completo.
- «Una cuenta `suspended` sigue recibiendo mensajes entrantes»: [x] CP11 arriba.
- «Todo el flujo de extremo a extremo en el sandbox de PayPal»: [ ] manual, sigue pendiente
  con guion en `impl_enforce-limits.md`. Sin cambio.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí.
- **CP2 Migraciones**: [x] la ronda no toca SQL. Replay 0 y `verify-schema.sql: OK` igual.
- **CP3 Aislamiento**: [x] las consultas nuevas van por el cliente RLS con
  `.eq('account_id', accountId)` (`config/route.ts:212-216` y `:247-250`); las de rol de
  servicio (`getEntitlements`, `assertQuota`, `recordUsage`) reciben el `accountId` del
  motor, con test de fuga en los cuatro puntos nuevos. El `supabaseAdmin()` de
  `config/route.ts:277` (reclamo del `phone_number_id` por otra cuenta) es deliberadamente
  cross-account y preexistente: es la comprobación de que nadie más tiene ese número.
- **CP4 Tests**: [x] cada defecto cerrado tiene test leído por mí, y los de A y B
  discriminan la versión rota (el de A por el doble que aplica filtros; el de C por el
  assert sobre `findOrCreateContact`). `progress/checks_enforce-limits.sql` no se ve
  afectado por esta ronda.
- **CP5 Sin dependencias nuevas**: [x] `package.json`/`package-lock.json` intactos en todo
  el rango `9adc3d5..08bc791`.
- **CP6 i18n**: [x] sin texto de interfaz nuevo. Paridad comprobada por mí:
  `en.json` y `ko.json`, 0 claves de más en cada lado. No hay `es.json`.
- **CP7 Next 16**: [x] ninguna API de framework nueva en esta ronda.
- **CP8 Alcance**: [x] los 12 archivos son exactamente A, B, C más `CHANGELOG.md`. No se
  arregla nada de lo visto roto fuera (ver hallazgo 1, que se deja como deuda).
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) dice las tres cosas en lenguaje de
  usuario. El informe coincide con el diff salvo una imprecisión menor (hallazgo 5).
- **CP10 Git**: [x] `fix:` en español, cuerpo que explica los tres cambios, con
  `Co-Authored-By`; nada pusheado; `main` (46a0999), `dev` (7ecf644) y
  `feat/saas-multiempresa` (593b92f) intactos; árbol limpio.
- **CP11 Lo entrante nunca se bloquea**: [x] recorrido entero arriba, con las tres mitades
  probadas. El entrante se guarda antes del despacho y ningún rechazo escapa al `after()`.

## Hallazgos (archivo:línea)

Contrastados con el skill `code-review` (nivel `high`, rango `1446796..08bc791`), que
devolvió 5. Los verifiqué uno a uno en el código: **los cinco son reales**, ninguno es tope
esquivable, bloqueo de lo entrante ni fuga, y ninguno bloquea. Los dos primeros merecen
feature propia en la fase 4.

1. `src/lib/flows/engine.ts:774` y `:790` (y las reprompts de `:1047-1049`) — **el
   `assertWritable` nuevo puede dejar un `flow_run` varado en `active`.**
   `sendButtonsAndSuspend`/`sendListAndSuspend` son los **únicos** ejecutores de nodo sin
   `try/catch` propio: `send_message` (`:628`), `send_media` (`:659`) y `collect_input`
   (`:695`) sí cierran el run con `endRun(…, 'failed', …)`. Con un flujo cuyo nodo de
   entrada sea `send_buttons`, una cuenta suspendida hace: `startNewRun` inserta el run
   `active` (`:1098-1116`) → el nodo lanza `AccountLockedError` → se desenrolla hasta el
   `catch` de `dispatchInboundToFlows:912`, que lo traga y devuelve `no_match`. El run se
   queda `active` sin `endRun`, y el índice parcial `idx_one_active_run_per_contact`
   (`010_flows.sql:189`) impide arrancar otro para ese contacto. No es CP11 —el entrante ya
   está guardado— ni es permanente —al regularizar, la siguiente entrada reprompta y
   envía—, pero mientras dure la suspensión cada entrante sube `reprompt_count` por un menú
   que el cliente nunca vio, y puede disparar la política de handoff/fin.
   **Atribución honesta:** la vía la abrió `a6703da` con `assertQuota` en el mismo punto
   (`flows/meta-send.ts:360`), que también lanza, y se me pasó entonces. Esta ronda no la
   crea: la vuelve rutinaria, porque `suspended` dura días y «cuota agotada» duraba hasta
   fin de mes. Los tests nuevos solo ejercitan `engineSendText` sobre un flujo de palabra
   clave, así que esta rama queda sin cubrir.
   Arreglo: envolver ambas llamadas como las otras tres (`try/catch` + `endRun`), y un test
   con nodo de entrada `send_buttons`.
2. `src/app/api/whatsapp/config/route.ts:352` — **`registeredAt` arrastra el sello del
   número viejo al nuevo.** `let registeredAt = existing?.registered_at ?? null` y luego
   `registered_at: registrationError ? null : registeredAt` (`:423`). Guardas el número de
   prueba con PIN (`registered_at` puesto), guardas el de producción sin PIN →
   `sameNumber` es falso, `registrationSkipped = true`… y la fila se persiste diciendo que
   el número de producción está registrado. `whatsapp-config.tsx:94` calcula
   `isRegistered = Boolean(config?.registered_at)`, así que el cartel «Not registered»
   desaparece y el operador no sabe que le falta el `/register` del que depende el
   enrutado del webhook entrante.
   **Es preexistente** (está igual en la base `9adc3d5`), así que CP8 manda dejarlo como
   deuda y no arreglarlo aquí. Pero lo subo al primer plano porque **esta ronda es la que
   lo hace alcanzable**: hasta ahora el cambio de número devolvía 402 en `inicio` y `pro`.
   Arreglo: `registeredAt = existing?.phone_number_id === phone_number_id ? existing.registered_at : null`.
3. `src/app/api/whatsapp/config/route.ts:212-216` — la lectura nueva usa
   `.eq('account_id', …).maybeSingle()`, que revienta con PGRST116 en cuanto una cuenta
   tenga dos filas. Es justo el estado que f4.2 trae al retirar `UNIQUE(account_id)`: el
   POST devolvería 500 en vez de aplicar el tope. Coincide con la deuda 12 del informe y
   hay que resolverlo **en** f4.2, no antes: hoy la restricción lo hace imposible.
4. `src/lib/flows/engine.ts:628` — bajo suspensión, un nodo `send_message` cierra el run con
   `endRun(…, 'failed', 'send_text_failed')`: la suspensión **destruye** los flujos en vuelo
   en vez de pausarlos, y regularizar no los devuelve. Es la convención que ya existía para
   los fallos de Meta, ahora heredada por §5. Decisión de producto, no defecto de código;
   la anoto para que alguien la tome a propósito.
5. `progress/impl_enforce-limits.md` (sección C) y el cuerpo del commit dicen que «el
   segundo `assertQuota`, el exacto post-dedup, se retiró por redundante». En `1446796`
   `createBroadcast` tenía **uno solo** (`:202`), que era justo ese; lo que pasó es que se
   movió arriba y cambió de `deduped.length` a `candidates.length`. El estado final es
   correcto y está bien razonado; la frase describe mal cómo se llegó. Cosmético.

### Sin acción

- Deuda 11 del informe (`assertWritable` + `assertQuota` resuelven `getEntitlements` dos
  veces en el camino caliente del webhook): confirmada, es el quinto hallazgo del skill y
  cae dentro de la deuda 2 (enhebrar `Entitlements` por `assertQuota`). Ya está anotada.
- Observaciones 1-5 de la revisión anterior siguen en pie sin cambio, incluida la
  atribución del trailer (`Claude Fable 5.1`) por si el líder la normaliza al integrar.

## Cambios requeridos

Ninguno. Las tres correcciones exigidas están hechas y probadas; los hallazgos 1 y 2 van a
la lista de la fase 4 (1 con prioridad: es un `try/catch` de cuatro líneas en dos sitios y
un test).
