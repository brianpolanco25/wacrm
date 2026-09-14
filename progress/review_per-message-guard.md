# Review — f1.4 per-message-guard (re-revisión tras la corrección)

**Veredicto:** APPROVED

Rama `saas/fase-1-bandeja`, worktree `.claude/worktrees/fase-1`, HEAD `316441c`, limpio,
sin upstream. `main` en `46a0999` y `feat/saas-multiempresa` en `593b92f`, intactas.
Commits de la feature: `8e126a1` (17 archivos, +1026/−41) y `316441c` (11 archivos,
+661/−55), con `3782fbb` (merge de fase 0) en medio. El diff coincide con el informe.

## Compuerta

Ejecutada por mí en el worktree sobre el HEAD fusionado, no leída del informe:

- `npm run lint`: verde — 0 errores, 37 avisos (la línea base de la rama).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde — **93 archivos, 1 022 tests**.
- `npm run build` con las variables dummy de CI: verde.
- `scripts/replay-migrations.sh .claude/worktrees/fase-1`: exit 0, aplica 040, 041, 042,
  043, 047 y 051 sobre base limpia, `verify-schema.sql: OK`.
- Reaplicar `051` sobre la base ya migrada: exit 0 (`already exists, skipping`) y el
  verify vuelve a pasar → idempotente.
- `progress/checks_per-message-guard.sql` contra el Postgres del harness: **exit 0, 14 OK,
  cero `FALLO`**, incluidas las partes nuevas H.1/H.2/H.3 (la lectura del titular acotada
  por cuenta, que es lo que decide si el motor cede).

Nada rojo, ni por f1.4 ni por el merge.

## El merge de fase 0 (`3782fbb`)

Comprobado que la resolución conserva los dos lados y que no desactivó nada:

- `src/lib/ai/types.ts`: `AiKeySource` y `keySource` (f0.4) conviven con
  `handoffMode`/`handoffMessage` (f1.2).
- `src/app/api/ai/config/route.ts`: valida `handoff_mode`/`handoff_message` y la regla
  «`fixed` necesita destino» (f1.2) **y** resuelve `keySource`/`clearKey` dentro de
  `credentialsChanged` (f0.4).
- `src/components/settings/ai-config.tsx`: `secretFieldLoaded`, `canUsePlatformKey` /
  «usar la clave de la plataforma», `clearKey` explícito (f0.4) junto al selector de modo
  de cesión, el mensaje de cesión y el aviso de solapamiento (fase 1).
- `CHANGELOG.md`: aditivo; el aviso de «migration required» lista 040, 041, 042, 043,
  047 y 051.
- **Ningún test desactivado ni perdido**: cero `it.skip`/`describe.skip`/`it.todo`/`xit`
  en `src/`. Comparados los títulos de `it(` de `1c7ddab` (fase 0, 871) y `8e126a1`
  (f1.4 v1, 936) contra HEAD (985): lo único que desaparece es
  `stands down when an active message-level automation exists` (el test de la guarda
  global que esta feature sustituye) y los dos títulos de `automation-overlap.test.ts`
  que se renombraron al ampliar la lista de disparadores. Todo lo demás está.

## Los cuatro cambios requeridos, uno a uno

1. **El motor honra la reserva también al reanudar un `wait`** — hecho, y no solo al
   reanudar: `reserveReplyToInbound` (`engine.ts:404-421`) devuelve booleano y los cuatro
   pasos que hablan con el cliente abortan con `REPLY_ALREADY_ANSWERED`
   (`engine.ts:443`, `467`, `504`; `send_buttons` y `send_list` comparten rama). Para no
   callarse ante sí mismo usa `claimInboundAutoReplyForAutomation`
   (`reply-marker.ts:101-134`), que al perder el INSERT lee el titular acotado por
   `message_id` **y** `account_id`. Test exigido, leído: `engine.test.ts` ›
   `does not send when the AI answered while the run was waiting` — monta
   `keyword_match` → `wait` → `send_message`, comprueba que al aparcar no hay ninguna
   reserva (`claimUpserts` vacío), siembra la reserva de la IA, llama a
   `resumePendingExecution` y exige `engineSendText` **no llamado** y la fila intacta con
   `responder: 'ai'`. El mock del `upsert` implementa ON CONFLICT DO NOTHING de verdad
   (devuelve `[]` si la clave ya está), y el de `automation_steps` respeta el `gte` de
   `startPosition`, así que el run reanudado no re-ejecuta el `wait`.
2. **Comentarios e informe dicen lo que el código garantiza** — corregidos el bloque de
   `webhook/route.ts:886-899` y la §«Orden y carrera» del informe. **Menos uno**: ver
   hallazgo 1.
3. **Test del orden en `processMessage`** — `webhook/route.test.ts` ›
   `dispatches AND awaits every automation before dispatchInboundToAiReply`: el mock de
   `dispatchInboundToAiReply` anota `automationCompleted` en el instante de la llamada y
   el test exige 3 (las tres automatizaciones **terminadas**, no solo lanzadas).
   Intercambiar las llamadas o soltar el `await` lo deja en 0. Junto a él,
   `hands the AI the inbound id the automations were given`, que fija que los dos
   despachos reservan sobre la misma fila.
4. **La IA no responde en `conversations.status = 'closed'`** — `auto-reply.ts:82`, con
   la columna añadida al SELECT. Tres tests leídos:
   `stays quiet in a conversation an automation just closed` (además comprueba que ni
   siquiera reserva), `still replies in an open or pending thread` y
   `reads the status column it gates on` (que impide desarmar la guarda quitando la
   columna del SELECT).

Y el hallazgo 4 de la revisión anterior: `OVERLAPPING_TRIGGERS` incluye ahora
`first_inbound_message` y `new_contact_created`, con el porqué en el módulo y tres tests
(`counts welcome automations too`, `ignores triggers a customer message never fires on
its own`, `covers exactly the triggers the webhook dispatches for an inbound`).

## Trazabilidad criterio ↔ test

- **C1 «automatización de palabra clave activa que NO coincide → la IA responde»**:
  [x] `src/lib/ai/auto-reply.test.ts:539` › `replies when no automation answered this
  message, even with active ones in the account` — envía y además exige
  `tablesRead).not.toContain('automations')`, o sea que el censo global desapareció.
  Lado motor: `engine.test.ts` › `leaves no reservation when the keyword does not match`.
- **C2 «una que SÍ coincide y responde → la IA no responde»**:
  [x] `auto-reply.test.ts:554` › `stays quiet when an automation already answered this
  message` (ni `generateReply`, ni `engineSendText`, ni RPC) y `:595` ›
  `does not send the handoff notice either when it lost the reservation`.
  Lado motor: `engine.test.ts` › `reserves the reply for the inbound it is answering,
  scoped to the account`.
- **C3 «el cliente nunca recibe dos respuestas automáticas al mismo mensaje»**:
  [x] **ahora completo en los dos sentidos**. IA↔IA: `auto-reply.test.ts:581` › `sends
  exactly one automatic reply when the same inbound is dispatched twice` (dos upserts,
  una fila, un envío). Motor↔motor: `engine.test.ts` › `stands down when another
  automation already answered this inbound`. **Motor-después-de-la-IA** (el hueco de la
  ronda anterior): `does not send when the AI answered while the run was waiting`.
  Propiedad del ganador único: `reply-marker.test.ts` › `picks exactly one winner when an
  automation and the AI race for the same message`. Orden: el test del webhook de arriba.
  Contra base real: partes A.1/A.2/A.3 (segunda reserva → 0 filas; sin `ON CONFLICT` →
  23505; el siguiente mensaje sigue libre) y H.1/H.2/H.3, ejecutadas por mí.
- **El run no se calla ante su propia reserva**: [x] `reply-marker.test.ts` › `keeps
  talking when the reservation is its own` (+ `stands down when the AI got there first`,
  `stands down when a different automation got there first`, `does not accept a
  reservation belonging to another account`, `fails closed (and loudly) when the holder
  cannot be read`) y `engine.test.ts` › `reserves once even when the run sends several
  messages` (dos envíos, una sola fila, y la lectura del titular acotada por cuenta) y
  `sends on resume when the reservation is the run's own, taken before the wait`.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí sobre el HEAD fusionado.
- **CP2 Migraciones**: [x] `051` sin cambios desde la ronda anterior; idempotente
  (reaplicada), cuatro aserciones en `verify-schema.sql` (existe la tabla, PK sobre
  `message_id` **a secas**, CHECK de `responder`, RLS activada y sin políticas), replay 0.
  Cascadas hacia `messages` y `accounts` solo borran la marca derivada; `automation_id` es
  `ON DELETE SET NULL` para que borrar la automatización no libere la reserva (D.2/D.3).
- **CP3 Aislamiento**: [x] la escritura lleva siempre el `account_id` del despacho
  (`auto-reply.ts:109-113`, `engine.ts:415`). La **única** lectura de
  `inbound_auto_replies` es `reply-marker.ts:111-119`, filtrada por `message_id` **y**
  `account_id`. Tests de fuga leídos: `reply-marker.test.ts` › `does not accept a
  reservation belonging to another account`, `engine.test.ts` › `a reservation held by
  another account is not ours either`, y el de la ruta manual
  (`automations/engine/route.test.ts` › `drops a caller-supplied inbound_message_id`);
  `delete context.inbound_message_id` sigue en `route.ts:39`. En base real, B.1 y H.2.
- **CP4 Tests**: [x] los tres criterios y los cuatro cambios requeridos tienen test
  vitest leído por mí; lo que exige base real tiene SQL ejecutado.
- **CP5 Sin dependencias nuevas**: [x] `package.json` / `package-lock.json` sin tocar.
- **CP6 i18n**: [x] `Settings.aiConfig` tiene exactamente las mismas claves en
  `messages/en.json` y `messages/ko.json` (comprobado por diferencia de conjuntos, 0 en
  cada sentido); `overlapTitle`/`overlapBody`/`overlapLink` presentes en los dos. No hay
  `es.json` y no se creó.
- **CP7 Next 16**: [x] la corrección no añade API de framework; lo único era
  `import Link from 'next/link'`, ya comprobado contra
  `node_modules/next/dist/docs/01-app/03-api-reference/02-components/link.md`.
- **CP8 Alcance**: [x] los dos commits de f1.4 tocan solo archivos de §4 (guarda, motor,
  marcador, webhook, ruta del motor, aviso de Ajustes → IA, i18n, migración, verify,
  CHANGELOG). El resto del diff contra `4c63367` es el merge de fase 0.
- **CP9 Documentación**: [x] `CHANGELOG.md` actualizado y coherente tras el merge
  (migraciones 040-043, 047, 051; la entrada describe el caso del `wait`); informe
  coincide con el diff. Salvedad: hallazgo 1.
- **CP10 Git**: [x] dos commits en `saas/fase-1-bandeja`, en español con prefijo
  `feat:`/`fix:` y `Co-Authored-By`; sin upstream, nada pusheado; `main` y
  `feat/saas-multiempresa` intactas.
- **CP11 Lo entrante nunca se bloquea**: [x] el webhook no cambia de orden ni de
  condiciones; toda la reserva ocurre aguas abajo del upsert idempotente de `messages` y
  de la frontera de reentrega.

## Hallazgos (archivo:línea) — ninguno bloqueante

Ninguno es doble envío, fuga ni pérdida de datos. Los tres primeros son **respuestas de
menos**, que es la dirección de fallo elegida a propósito; se dejan como observación por
decisión del líder.

1. **`supabase/migrations/051_automation_reply_marker.sql:32-35` — el comentario de la
   migración sigue diciendo lo contrario que el código.** Reza «el motor de
   automatizaciones reserva pero **ignora el resultado** — las automatizaciones son
   deterministas […] así que siempre ganan sobre el modelo». Desde `316441c` el motor lo
   honra. Es el único resto del cambio requerido 2: el comentario del webhook y el
   informe sí se corrigieron. Un `chore:` de una línea lo cierra.
2. **`src/lib/automations/engine.ts:443` — la reserva ahora también calla a las
   automatizaciones hermanas, no solo a la IA.** El webhook despacha varios disparadores
   sobre el **mismo** `inbound_message_id` (`route.ts:827-854`: `first_inbound_message`,
   `new_contact_created`, `new_message_received`, `keyword_match`), así que en una cuenta
   con un acuse genérico de `new_message_received` **más** automatizaciones de palabra
   clave, el acuse se queda la reserva y las de palabra clave dejan de enviar. Antes de
   la feature enviaban las dos. Es exactamente lo que dice el criterio C3 leído al pie de
   la letra («nunca dos respuestas automáticas al mismo mensaje») y está decidido y
   pinchado a propósito (`engine.test.ts` › `stands down when another automation already
   answered this inbound`), pero es un cambio de comportamiento de producto que conviene
   que el líder firme explícitamente, porque no lo pide ninguna frase de §4 fuera de C3.
3. **`src/lib/automations/engine.ts:541-553` — el mismo efecto en las cadenas de
   `add_tag`.** El contexto encadenado es `{ ...args.context, tag_id, vars }`, o sea que
   arrastra el `inbound_message_id`: un `keyword_match` que envía «Un momento…» y luego
   añade una etiqueta deja sin voz a la automatización de `tag_added` que iba a mandar la
   respuesta buena. El propio `automation-overlap.ts` reconoce que la cadena arrastra el
   entrante. Se cierra borrando `inbound_message_id` del contexto encadenado.
4. **`src/lib/ai/auto-reply.ts:109` — la reserva de la IA sigue tomándose antes de cinco
   caminos que no envían** (contexto vacío, tope por cuenta, `generateReply` que lanza,
   rama de cesión, `claim_ai_reply_slot` perdido). Era el hallazgo 5 de la ronda anterior
   y el informe lo acepta como deuda; lo que cambia es el coste: ahora una fila `ai`
   fantasma **también** calla a una automatización que se reanuda de un `wait`, así que
   ese entrante se queda sin ninguna respuesta automática. Escenario realista: una ráfaga
   que choca con `RATE_LIMITS.aiAutoReplyAccount`.
5. **`src/lib/automations/engine.ts:404` — un seguimiento diferido se trata como
   duplicado.** `new_message_received` → `wait 30 min` → «¿te ayudó la respuesta?» no
   llega si la IA contestó el entrante original: no es una segunda respuesta al mismo
   mensaje, pero la reserva no distingue. Es el precio del cambio requerido 1; conviene
   anotarlo en la deuda del informe.
6. **`src/lib/automations/reply-marker.ts:105` — un error transitorio del upsert es
   indistinguible de «perdí la reserva»**: `claimInboundAutoReply` devuelve `false` en los
   dos casos, la lectura del titular no encuentra fila y el paso no envía. Fallo cerrado,
   coherente con lo decidido, pero «no hay titular» podría tratarse como «envía».
7. **`src/lib/ai/auto-reply.ts:82` — la guarda de cerrado cuelga de un reabrir
   best-effort.** `reopenClosedConversation` (`src/lib/conversations/reopen.ts:37-42`)
   se traga su error; si esa UPDATE falla, el hilo se lee `closed` y la IA calla ante un
   cliente que acaba de escribir. Asimétrico además: el motor no mira `status`, así que
   una automatización reanudada de un `wait` sí escribe en el hilo que `close_conversation`
   cerró.
8. **`reply-marker.ts:10` — el comentario dice «`inbound_auto_replies` has no RLS»**
   cuando la migración la activa (sin políticas). Se entiende, pero contradice a
   `verify-schema.sql`.
9. **Menor teórico**: la propiedad de la reserva se comprueba por `automation_id`, no por
   run, así que dos ejecuciones concurrentes de la **misma** automatización sobre el mismo
   entrante enviarían las dos. Hoy es inalcanzable: el cron reclama la fila pendiente con
   un UPDATE condicional (`automations/cron/route.ts:47-54`) y la reentrega de Meta la
   ataja la frontera del upsert de `messages`.

## Cambios requeridos

Ninguno. Recomendado para la siguiente pasada de deuda, por orden: el hallazgo 1 (una
línea), el 3 (borrar `inbound_message_id` del contexto encadenado) y dejar los
hallazgos 2, 4 y 5 escritos en la sección de deuda de `progress/impl_per-message-guard.md`,
que hoy no los menciona.
