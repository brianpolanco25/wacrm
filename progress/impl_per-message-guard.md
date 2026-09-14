# f1.4 — `per-message-guard`

Rama `saas/fase-1-bandeja`, worktree `.claude/worktrees/fase-1`, sobre `4c63367`.
Spec: `docs/saas/fase-1-bandeja.md` §4 «La automatización que apaga la IA sin avisar».

## Qué se sustituyó

`src/lib/ai/auto-reply.ts` preguntaba «¿tiene esta **cuenta** alguna automatización
activa con `new_message_received` o `keyword_match`?» y, si la había, se callaba en
todos los chats de la empresa. Una automatización de palabra clave para «horario»
apagaba el agente de IA entero, en silencio.

Ahora la pregunta es por mensaje, y **hacerla es reservarlo**: los dos respondedores
automáticos insertan en `inbound_auto_replies` antes de enviar y la clave primaria de
esa tabla elige un único ganador.

## Orden y carrera — la decisión (reescrita tras la revisión)

El criterio duro es «el cliente nunca recibe dos respuestas automáticas al mismo
mensaje». Quien lo cumple es **la reserva, honrada por los dos respondedores**; el orden
del `after()` solo decide quién suele contestar.

1. **Exclusión mutua, en los dos sentidos.** La reserva es un `INSERT ... ON CONFLICT
   (message_id) DO NOTHING RETURNING` contra una PK sobre `message_id` **a secas**. Lo
   decide Postgres, no la aplicación. La IA se calla si pierde (`if (!won) return;`) y
   **el motor también**: desde esta corrección, `reserveReplyToInbound` devuelve booleano
   y los cuatro pasos que hablan con el cliente abortan el envío si es `false`
   (`REPLY_ALREADY_ANSWERED` queda como detalle del paso en el log del run, en verde: no
   es un fallo, es una cesión). Comprobado con dos sesiones reales (partes E e I de
   `progress/checks_per-message-guard.sql`): la segunda sesión **se bloquea** hasta que la
   primera decide, y devuelve 0 filas si confirmó o 1 si revirtió.
2. **Callarse ante uno mismo, no.** Un run puede enviar varios mensajes, y el tramo
   posterior a un `wait` se reanuda con la reserva que el propio run tomó antes. Por eso
   el motor no usa el claim pelado sino `claimInboundAutoReplyForAutomation`: si pierde el
   INSERT, lee el titular (acotado por `message_id` **y** `account_id`) y solo sigue
   hablando cuando la reserva es de **esa misma automatización**. Cualquier otro titular
   —la IA, u otra automatización— es una respuesta ya enviada, y se cede. La lectura es
   segura porque `ON CONFLICT DO NOTHING` espera a que el ganador confirme: medido, el
   `INSERT` perdedor se bloquea 2 950 ms y la lectura siguiente ve `ai` 2 ms después
   (parte I).
3. **El orden no es la garantía, es la ergonomía.** En el `after()` del webhook el bucle
   de automatizaciones está `await`-eado y el despacho de IA va después, para que en el
   caso normal la IA pregunte cuando toda automatización que fuera a responder ya reservó
   o ya terminó. Intercambiar las dos llamadas cambiaría **quién** contesta, nunca
   **cuántas** respuestas recibe el cliente. El comentario del webhook decía lo contrario
   («the guarantee does not rest on this ordering alone» apoyándose en un motor que
   ignoraba la reserva) y está reescrito.

Alternativas descartadas, y por qué:

- **Solo leer la marca** (sin reservar): deja una ventana entre el `SELECT` y el envío en
  la que dos despachos del mismo entrante leen «libre» y ambos envían.
- **PK compuesta `(account_id, message_id)`**: dos inserciones con distinta cuenta no
  chocarían y la exclusión mutua se perdería. La aserción de `verify-schema.sql`
  bloquea ese cambio explícitamente (probada como detector).
- **Marcar después de enviar** en el motor: una caída entre el envío y la marca deja el
  mensaje libre y la IA responde encima. Se marca **antes**; si el envío falla, el
  cliente se queda sin respuesta, que es la dirección segura.
- **Que el motor ignore el resultado y envíe siempre** (lo que hacía la primera
  entrega, con el argumento «las automatizaciones son deterministas: siempre ganan»):
  **descartado en la revisión**. Abría el `wait` como agujero — `keyword_match` → `wait
  1 min` → `send_message` con la IA contestando en medio deja dos respuestas al mismo
  entrante— y dejaba la garantía colgando del orden del `after()`, sin ningún test que lo
  fijara. Ahora el motor honra la reserva; «siempre ganan» sigue siendo cierto en el caso
  que importa, porque el orden del webhook les da la primera oportunidad.

Dirección del fallo, en las dos puntas: un error de base al reservar devuelve `false`
(no enviar). Responder de menos es molesto; responder dos veces es el bug que esta
feature existe para evitar. El error se registra con `console.error` porque «la IA no
responde nunca» es, si no, indiagnosticable.

Consecuencia deliberada, ahora en las dos puntas: si un respondedor reserva y luego se
cae, se le agota el cupo o cede el turno, la reserva se queda tomada y ese mensaje no
recibe respuesta automática de nadie. No hay doble envío posible; se pierde una respuesta.
Es el hallazgo 5 de la revisión, anotado como deuda.

## Commits

| Commit | Qué |
|---|---|
| `8e126a1` | `feat: callar la IA solo en el mensaje que respondió una automatización` |
| `3782fbb` | `Merge branch 'saas/fase-0-cimientos' into saas/fase-1-bandeja` (tarea A: conflictos de `CHANGELOG.md`, `ai/config/route.ts`, `settings/ai-config.tsx` y `ai/types.ts` resueltos conservando ambos lados) |
| `316441c` | `fix: honrar la reserva del entrante también en el motor` (los cuatro cambios requeridos) |

## Criterio ↔ test

| Criterio del spec | Test |
|---|---|
| Con una automatización de palabra clave activa que **no** coincide, la IA responde | `src/lib/ai/auto-reply.test.ts` → `replies when no automation answered this message, even with active ones in the account` (y comprueba que la tabla `automations` ya no se consulta) · lado del motor: `src/lib/automations/engine.test.ts` → `leaves no reservation when the keyword does not match (the AI keeps this message)` |
| Con una que **sí** coincide y responde, la IA no responde | `src/lib/ai/auto-reply.test.ts` → `stays quiet when an automation already answered this message` · lado del motor: `src/lib/automations/engine.test.ts` → `reserves the reply for the inbound it is answering, scoped to the account` |
| El cliente nunca recibe dos respuestas automáticas al mismo mensaje | `src/lib/automations/reply-marker.test.ts` → `picks exactly one winner when an automation and the AI race for the same message` · `src/lib/ai/auto-reply.test.ts` → `sends exactly one automatic reply when the same inbound is dispatched twice` y `does not send the handoff notice either when it lost the reservation` · **motor después de la IA** (el hueco que encontró la revisión): `src/lib/automations/engine.test.ts` → `does not send when the AI answered while the run was waiting`, `stands down when another automation already answered this inbound` y `a reservation held by another account is not ours either` · **orden del webhook**: `src/app/api/whatsapp/webhook/route.test.ts` → `dispatches AND awaits every automation before dispatchInboundToAiReply` · en base real: partes A, E, H e I de `checks_per-message-guard.sql` |
| La IA no responde en una conversación cerrada (hallazgo 3; coherente con f1.3) | `src/lib/ai/auto-reply.test.ts` → `stays quiet in a conversation an automation just closed`, `still replies in an open or pending thread` y `reads the status column it gates on` |
| El aviso de solapamiento nombra a todas las automatizaciones que pueden contestar el entrante (hallazgo 4) | `src/lib/ai/automation-overlap.test.ts` → `counts welcome automations too: they answer the first inbound`, `ignores triggers a customer message never fires on its own` y `covers exactly the triggers the webhook dispatches for an inbound` |
| El run no se calla ante su propia reserva | `src/lib/automations/reply-marker.test.ts` → `keeps talking when the reservation is its own` (+ `stands down when the AI got there first`, `stands down when a different automation got there first`, `does not accept a reservation belonging to another account`, `fails closed (and loudly) when the holder cannot be read`) · `engine.test.ts` → `reserves once even when the run sends several messages` y `sends on resume when the reservation is the run's own, taken before the wait` |

Tests de apoyo: `still replies to the NEXT message the automation did not answer` (la
reserva es por mensaje, no por conversación), `reserves once even when the run sends
several messages`, `reserves nothing when the run has no inbound behind it`, `fails
closed when the reservation cannot be written`, `fails closed (and loudly) when the
write errors`, y los cinco de `src/lib/ai/automation-overlap.test.ts` para el aviso.

**Todos verificados como detectores**, invirtiendo el código:

- quitar `if (!won) return;` de `auto-reply.ts` → 5 rojos.
- quitar las llamadas a `reserveReplyToInbound` de `engine.ts` → 2 rojos.
- quitar `delete context.inbound_message_id` de la ruta manual → 1 rojo.

Y los de esta ronda, invertidos uno a uno:

- volver a ignorar el resultado de `reserveReplyToInbound` en `engine.ts` → 3 rojos
  (`stands down when another automation…`, `a reservation held by another account…`,
  `does not send when the AI answered while the run was waiting`).
- que `claimInboundAutoReplyForAutomation` no reconozca su propia reserva → 4 rojos
  (incluido `reserves once even when the run sends several messages`, que es el que
  impide «arreglarlo» callando al run ante sí mismo).
- quitar `if (conv.status === 'closed') return;` y la columna del SELECT → 2 rojos.
- soltar el `await` del bucle de automatizaciones en el webhook → 2 rojos
  (`dispatches AND awaits every automation before dispatchInboundToAiReply` y el de
  #368).

Un test existente de f1.2 (`sends exactly one notice when two inbounds hand off
concurrently`) se ajustó: modelaba «dos entrantes con un segundo de diferencia», así que
ahora usa **dos ids de mensaje distintos**. Con el mismo id la segunda ya no llega al
handoff, y el test dejaba de probar lo suyo (la UPDATE condicional de f1.2). Con ids
distintos vuelve a ser el detector que era.

## Aislamiento entre cuentas (CP3)

- La reserva se escribe siempre con el `account_id` del despacho (`accountId` del webhook
  en la IA, `automation.account_id` en el motor). Test:
  `tags the reservation with the dispatch account (it is service-role, RLS does not apply)`.
- La **única lectura** de `inbound_auto_replies` es la del titular, que el motor hace
  cuando pierde el INSERT (`claimInboundAutoReplyForAutomation`), y va acotada por
  `.eq('message_id')` **y** `.eq('account_id')`. Test de fuga:
  `reply-marker.test.ts` → `does not accept a reservation belonging to another account`
  y `engine.test.ts` → `a reservation held by another account is not ours either` (una
  reserva de otra cuenta no se lee como propia y el paso no envía); en base real, H.2. En
  la escritura el filtro por cuenta no es un `.eq()` sino una columna del payload; la
  parte B del SQL comprueba que una consulta acotada por cuenta solo ve lo suyo y que
  `account_id` es `NOT NULL`.
- **Fuga encontrada y cerrada al cablear la feature**: `POST /api/automations/engine`
  pasa `body.context` tal cual al motor. Con la columna nueva, un `agent` de la cuenta B
  podía enviar `context.inbound_message_id` con el id de un mensaje de la cuenta A y
  quedarse con la reserva de ese entrante, silenciando la respuesta de IA de A. La ruta
  ahora borra esa clave del contexto antes de despachar; test de fuga en
  `src/app/api/automations/engine/route.test.ts`.

## Verificaciones contra base real

`progress/checks_per-message-guard.sql`, ejecutado contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fase-1`). Todas con control
negativo:

- **A** un solo respondedor por mensaje: la segunda reserva con `ON CONFLICT` devuelve 0
  filas; sin `ON CONFLICT` se estrella con 23505; el **siguiente** mensaje de la misma
  conversación sigue libre.
- **B** aislamiento: una consulta acotada solo ve sus marcas; `account_id` `NOT NULL`;
  `responder` rechaza valores fuera del CHECK.
- **C** RLS: con `SET ROLE authenticated` no se lee ninguna fila y el INSERT sale
  `insufficient_privilege`.
- **D** recogida de basura: la marca muere con su mensaje; borrar la automatización
  **no** libera la reserva (`automation_id` pasa a NULL con `ON DELETE SET NULL`).
- **E** concurrencia con dos sesiones: medida, con los dos caminos (COMMIT y ROLLBACK).
- **F** las tres aserciones nuevas de `verify-schema.sql` son detectores (PK compuesta,
  política de RLS añadida, RLS desactivada → las tres hacen fallar el verify).
- **G** idempotencia: reaplicar `051` sobre la base migrada sale 0, no pierde filas y el
  verify sigue pasando.
- **H** (nueva) lectura del titular, la que decide si el motor cede: con la reserva
  perdida, la consulta acotada por `(message_id, account_id)` devuelve la propia
  automatización (H.1 → sigue enviando), no devuelve nada si se acota a la otra cuenta
  (H.2) y no reconoce como suya una reserva de la IA (H.3 → cede). Ejecutada, las tres OK.
- **I** (nueva) la carrera contra esa lectura, con dos sesiones: el `INSERT` perdedor se
  bloquea **2 950 ms** hasta que la IA confirma y devuelve 0 filas; la lectura del titular,
  2 ms después, ya ve `ai`. No hay ventana en la que el motor lea «libre» y envíe encima.

`scripts/replay-migrations.sh` limpio: exit 0, `verify-schema.sql: OK`.

## Migración

`supabase/migrations/051_automation_reply_marker.sql` — tabla `inbound_auto_replies`
(`message_id` PK → `messages(id)` `ON DELETE CASCADE`, `account_id` NOT NULL →
`accounts(id)` `ON DELETE CASCADE`, `responder` con CHECK, `automation_id` →
`automations(id)` `ON DELETE SET NULL`, `created_at`), índice
`(account_id, created_at DESC)` y RLS activada **sin políticas**.

Sobre CP2 y las cascadas: las dos apuntan de padre a hijo y solo borran esta marca
derivada, nunca datos de clientes. Son además la recogida de basura de la tabla, sin
cron: la marca se va con su mensaje. El `ON DELETE CASCADE` hacia `accounts` sigue la
forma del resto del esquema multiempresa (017) y **no** repite el `RESTRICT` de 041, a
propósito: un `RESTRICT` aquí volvería a romper `redeem_invitation()` en cuanto una
cuenta personal tuviera un mensaje respondido (el hallazgo 1 de `review_checkout-flow.md`).

## Compuerta

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 37 avisos (la línea base exacta de la rama; ninguno nuevo) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 93 archivos, 1 022 tests, todos en verde (tras fusionar fase 0 y añadir los 12 de esta ronda) |
| `npm run build` | `Compiled successfully in 8.0s` |
| `scripts/replay-migrations.sh` | exit 0, `verify-schema.sql: OK` |

## Red de seguridad en Ajustes → IA

`src/components/settings/ai-config.tsx` muestra un aviso ámbar cuando la cuenta tiene
automatizaciones activas con disparador de contenido, con enlace a `/automations`. La
decisión de qué cuenta como solapamiento vive en `src/lib/ai/automation-overlap.ts`
(puro y probado); el componente solo pinta. No se añade endpoint: reutiliza
`GET /api/automations`, que ya va acotado por RLS con el cliente del usuario, y el
`fetch` es best-effort (si falla, el aviso no aparece y el panel funciona igual).

Qué cuenta como solapamiento (corregido tras el hallazgo 4): `OVERLAPPING_TRIGGERS` =
`first_inbound_message`, `new_contact_created`, `new_message_received`, `keyword_match`
— exactamente los disparadores que el webhook despacha con `inbound_message_id` en el
contexto a raíz de un mensaje del cliente, en ese orden. Los dos de relación estaban
fuera con el argumento de que «van de quién escribe, no de qué dijo», pero el webhook los
dispara **los primeros** y con el mismo entrante: una automatización de bienvenida reserva
el primer mensaje de un contacto nuevo y la IA se calla para ese mensaje. Dejarlos fuera
hacía que el aviso faltara justo en la cuenta más propensa a toparse con ello.

Siguen fuera, con el porqué en el propio módulo:
- `interactive_reply`: el webhook no despacha la IA cuando llega una pulsación de botón,
  así que no pueden chocar.
- `tag_added` y los demás encadenados por el motor: arrastran el entrante si otra
  automatización los encadena (`add_tag` propaga el contexto), pero nunca se disparan solos
  por un mensaje del cliente, y marcar toda automatización de etiquetas ahogaría el aviso
  en ruido. Anotado como deuda.

Los textos del aviso no cambian: `overlapTitle`/`overlapBody`/`overlapLink` dicen
«pueden responder a los mismos mensajes», que sigue siendo literal con la lista ampliada.
Sin claves nuevas, y las tres siguen en `messages/en.json` y `messages/ko.json`.

Sin tests de render: el repo no tiene jsdom ni testing-library y no se añaden
dependencias. Toda la lógica está en el módulo puro, que sí los tiene.

## i18n (CP6)

Tres claves nuevas en `Settings.aiConfig`, en `messages/en.json` y `messages/ko.json` con
la misma clave: `overlapTitle` (con `{count}` y plural ICU, la forma que ya usa el
catálogo), `overlapBody`, `overlapLink`. 47 → 50 claves en los dos.

## CP11 — lo entrante no se bloquea

El webhook no cambia de orden ni de condiciones: el `upsert` idempotente de `messages` y
su frontera de reentrega siguen exactamente donde estaban. Lo único que se añade después
es leer el id de la fila recién insertada (`insertedRows[0].id`) para pasarlo a los dos
despachos. Nada de la reserva puede impedir que el mensaje se guarde: ocurre entera
aguas abajo del guardado.

## Variables de entorno

Ninguna nueva. `docs/docker.md` no se toca. `.env.local.example` está bloqueado por
permisos, pero esta feature no le añadiría nada de todos modos (siguen pendientes para
el humano las de f0.4, f2.3 y f2.4).

## Decisiones donde el spec no decidía

1. **Clave de la reserva: el uuid interno de `messages`, no el `wamid` de Meta.** Es el
   id con el que ya trabajan los dos despachos, permite la FK (y con ella la recogida de
   basura automática) y no depende del formato de un tercero.
2. **Dónde reserva la IA**: después de las guardas baratas de conversación (asignada,
   pausada, tope) y antes de la llamada al modelo. Así un hilo que un humano ya lleva no
   escribe filas, y un mensaje que ya contestó una automatización no gasta tokens.
3. **La reserva silencia también el aviso de cesión de f1.2**, porque es un segundo
   mensaje automático sobre el mismo entrante. Con su test.
4. **El motor reserva en los cuatro pasos que hablan con el cliente**
   (`send_message`, `send_buttons`, `send_list`, `send_template`), justo antes del envío
   y después de la validación, para no reservar por un paso que va a fallar de todos
   modos.
5. **Un `wait` que reanuda más tarde también reserva** (el contexto viaja en
   `automation_pending_executions.context`) **y honra el resultado**: si la IA contestó
   mientras el run dormía, el paso de envío se salta. Es el caso que la revisión
   encontró abierto y está pinchado por dos tests (el que no envía y el que sí envía
   cuando nadie más contestó), más un tercero para `send_message` → `wait` →
   `send_message`, donde la reserva es del propio run y la cola del run sigue enviando.

## Tarea A — merge de `saas/fase-0-cimientos` (1c7ddab)

Fase 0 completa fusionada en `saas/fase-1-bandeja`; commit de merge `3782fbb`. Cuatro
conflictos, todos resueltos conservando **ambos** lados:

| Archivo | Cómo |
|---|---|
| `CHANGELOG.md` | aditivo: el aviso de «migration required» lista ahora 040, 041, 042, 043, 047 y 051; se quedan las entradas de f1.4 **y** las cuatro de f0.4 |
| `src/lib/ai/types.ts` | `AiConfig` con `keySource` (f0.4) **y** `handoffMode`/`handoffMessage` (f1.2); se recupera el punto y coma de `AiKeySource`, que el lado de fase 0 traía sin él contra `.prettierrc` |
| `src/app/api/ai/config/route.ts` | se conserva la validación de `handoff_mode`/`handoff_message` y la regla «`fixed` necesita destino» de f1.2, y la resolución de clave de f0.4 con `keySource` y `clearKey`. La escalera de claves antigua de f1.2 se descarta: fase 0 la movió dentro de `credentialsChanged` y allí ya decide `keySource` en la misma rama |
| `src/components/settings/ai-config.tsx` | campos de secreto de f0.4 (`secret-field.ts`, «usar la clave de la plataforma», `clearKey` explícito) junto al selector de modo de cesión, el mensaje de cesión y el aviso de solapamiento de fase 1. `MASKED_KEY` y `HANDOFF_QUEUE` desaparecen porque el cuerpo fusionado ya no los usa: los sustituyen `secretFieldLoaded` y `HANDOFF_UNSET` |

Compuerta completa en verde sobre el merge antes de commitearlo, y replay 0 aplicando
040–043, 047 y 051. `CHANGELOG.md` sigue sin pasar `prettier --check`, igual que antes
del merge (deuda preexistente, comprobada contra el `HEAD` anterior).

## Segunda ronda — lo que pidió la revisión

`progress/review_per-message-guard.md`, veredicto CHANGES_REQUESTED. Los cuatro cambios
requeridos, con la decisión del líder aplicada:

1. **Hallazgo 1 (bloqueante) — el `wait` reabría el doble envío.** Cerrado por la vía más
   barata de las tres que proponía la revisión, pero sin condicionarla a
   `triggerEvent === 'resumed_wait'`: el motor honra el resultado **siempre**. Condicionarlo
   al reanudar habría dejado el mismo agujero para cualquier otro camino que llegue tarde
   (una reentrega, un run largo) y una rama de código que solo se ejerce en el cron. El
   precio es tener que distinguir «la reserva es mía» de «es de otro»: eso es
   `claimInboundAutoReplyForAutomation`, con su lectura del titular acotada por cuenta.
2. **Hallazgo 2 — afirmaciones falsas.** Reescritos el comentario de
   `src/app/api/whatsapp/webhook/route.ts` y la sección «Orden y carrera» de este informe.
   Ahora dicen lo que el código hace: la no-duplicación la da la reserva honrada por los
   dos lados; el orden decide quién suele contestar, y cambiarlo no duplica nada.
3. **Cambio 3 — el orden sin test.** `src/app/api/whatsapp/webhook/route.test.ts` →
   `dispatches AND awaits every automation before dispatchInboundToAiReply`: el mock de
   `dispatchInboundToAiReply` anota cuántas automatizaciones habían **terminado** en ese
   instante y el test exige 3. Intercambiar las dos llamadas, o soltar el `await`, lo deja
   en 0. Junto a él, `hands the AI the inbound id the automations were given`, que fija que
   los dos despachos reservan sobre la misma fila.
4. **Hallazgo 3 — la IA en un hilo cerrado.** Decidido: la IA **no** responde con
   `conversations.status = 'closed'`. Es una guarda barata (la columna ya se leía en la
   misma consulta) y coherente con f1.3, que excluye los cerrados de «sin atender». No
   cambia el caso normal: cuando un cliente escribe a un hilo cerrado, el webhook lo
   reabre (`reopenClosedConversation`, #409) **antes** del `after()`, así que leer
   `closed` aquí significa que algo lo cerró después de llegar este mensaje — en la
   práctica, el paso `close_conversation` de una automatización de «baja»/«stop» que
   corrió unas líneas más arriba. Se descartó marcar `ai_autoreply_disabled` desde el paso
   `close_conversation`: eso es pegajoso (apaga la IA en ese hilo para siempre, también
   tras reabrirlo) y sería un cambio de comportamiento mayor que el que pedía el hallazgo.
5. **Hallazgo 4 — el aviso.** Se incluyen `first_inbound_message` y `new_contact_created`
   (ver «Red de seguridad en Ajustes → IA»). Los hallazgos 5, 6 y 7 quedan como deuda
   anotada abajo, por decisión del líder.

## Deuda detectada, no arreglada

- `src/app/api/automations/engine/route.ts` y `src/app/api/whatsapp/webhook/route.ts`
  incumplen `.prettierrc` desde antes de esta feature (sin punto y coma). Se mantuvo el
  estilo del archivo en las líneas añadidas para no meter cientos de líneas ajenas en el
  diff; ya está anotado como deuda en f2.4 y merece un `chore:` propio. Lo mismo con
  `CHANGELOG.md`, que tampoco pasa `prettier --check` en `4c63367`.
- `src/lib/automations/engine.ts` tenía una llamada a `contact_custom_values.upsert` que
  prettier quiere reformatear; se revirtió esa reformateada para que el diff no salga del
  alcance.
- `inbound_auto_replies` no tiene purga. Crece una fila por mensaje entrante contestado
  automáticamente y solo se limpia por cascada al borrar el mensaje o la cuenta. Con el
  volumen actual da igual; cuando importe, el índice `(account_id, created_at DESC)` está
  puesto para un barrido por antigüedad. Fuera del alcance de §4.
- Si la IA reserva y luego no envía (fallo del proveedor, tope, cesión), la reserva queda
  tomada y nadie contesta ese mensaje. Es la dirección segura elegida, pero un futuro
  «liberar la reserva al fallar el envío» sería una mejora real. No está en el spec.
- El aviso de solapamiento trae la lista completa de automatizaciones para contar dos
  campos. En una cuenta con muchas es un payload mayor del necesario; un
  `GET /api/automations?overlap=1` sería lo suyo. No lo pedía la sección.
- **Hallazgo 5 de la revisión** — la marca miente sobre quién respondió: la IA reserva
  antes del tope por cuenta, de `generateReply` y del `claim_ai_reply_slot`, así que una
  ráfaga que choque con `RATE_LIMITS.aiAutoReplyAccount` deja filas con `responder='ai'`
  sin envío. Es la dirección segura (responder de menos), pero degrada la tabla como
  rastro de auditoría. Arreglarlo bien es liberar la reserva cuando el envío no ocurre, y
  eso es un cambio de diseño que el spec no pide.
- **Hallazgo 6** — asimetría al desplegar sin `051`: `claimInboundAutoReply` falla y la IA
  se calla en el 100 % de los mensajes, mientras el motor ahora **también** se calla (antes
  ignoraba el error). O sea: el fallo cerrado es ahora simétrico, que es mejor, pero sigue
  siendo un apagón silencioso si alguien despliega el código sin la migración. Está en el
  CHANGELOG como migración requerida y el log lo dice con nombre y apellidos
  (`could not reserve the reply…` / `could not read the holder…`).
- **Hallazgo 7** — `inbound_auto_replies` sin retención (ya arriba): la IA reserva en
  todos los entrantes elegibles y la única recogida es la cascada de `messages`.
- El aviso de solapamiento ignora `tag_added` y el resto de disparadores encadenados por
  el motor, que sí pueden arrastrar el `inbound_message_id` de un run a otro (`add_tag`
  propaga el contexto). Es un solapamiento indirecto y de segundo orden; incluirlo marcaría
  toda automatización de etiquetas. Fuera del alcance de §4.

## Verificaciones manuales pendientes

Ninguna que dependa de Meta o PayPal: todo lo comprobable se probó con vitest o contra el
Postgres del harness. Queda, si se quiere confirmar en un entorno con WhatsApp real
(**no** es bloqueante y no cambia el veredicto):

1. Con el agente de IA activo y una automatización de palabra clave activa sobre
   «horario», escribir desde el móvil **«hola»** → llega **una** respuesta, la de la IA.
2. Escribir **«¿cuál es el horario?»** → llega **una** respuesta, la de la automatización;
   la IA no dice nada. En la base:
   `SELECT responder FROM inbound_auto_replies WHERE message_id = <el de ese entrante>`
   devuelve `automation`.
3. Volver a escribir **«hola»** → la IA responde otra vez. Antes de esta feature los
   pasos 1 y 3 no producían nada.
4. Ajustes → IA muestra el aviso ámbar con el número de automatizaciones y el enlace
   lleva a `/automations`. Con solo una automatización de bienvenida
   (`new_contact_created` / `first_inbound_message`) el aviso **también** aparece: es el
   hallazgo 4.
5. Con `keyword_match` («horario») → `wait 1 minuto` → `send_message`: escribir «¿horario?»
   → la IA contesta enseguida (la automatización está dormida) y **un minuto después no
   llega nada más**. En la base, `SELECT responder FROM inbound_auto_replies WHERE
   message_id = <ese entrante>` devuelve `ai`, y el log del run trae el paso de envío con
   detalle `skipped: another responder already answered this inbound message`.
6. Con una automatización de palabra clave «baja» cuyo único paso sea
   `close_conversation`: escribir «baja» → la conversación queda cerrada y **la IA no
   responde**. Escribir de nuevo después reabre el hilo y la IA vuelve a atender.
