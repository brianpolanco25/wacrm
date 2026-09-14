# f1.3 `attention-state-list` — informe de implementación

**Rama**: `saas/fase-1-bandeja` (worktree `.claude/worktrees/fase-1`), sobre `a492504`.
**Spec**: `docs/saas/fase-1-bandeja.md` §3 «Ver quién atiende, en la lista».
**Commits**:

- `de7fb0a` — `feat: mostrar quién atiende cada chat en la lista de la bandeja` (1ª ronda).
- `4c63367` — `fix: no decidir el estado de atención sin saber si la IA está activa`
  (2ª ronda, los seis cambios de `progress/review_attention-state-list.md`).

**SQL**: ninguno. La sección no prevé migración y no hizo falta ninguna: todo lo que
la fila necesita ya viaja en `CONVERSATION_SELECT` o es una consulta de cuenta que ya
existía. `scripts/replay-migrations.sh` no procede.

## 2ª ronda — los seis cambios requeridos

| # del review | Qué se hizo | Test |
|---|---|---|
| 1 · fallo de red ⇒ «IA apagada» | `fetchAiAccountStatus` devuelve `AiAccountStatus \| null`: `!res.ok` y el `catch` resuelven a `null` = **desconocido**, nunca a `{ autoReplyOn: false }`. El hook traduce ese `null` a estado `null` y ningún consumidor pinta la alarma. | `resolves a non-OK response to unknown, never to "AI off"`, `resolves a network error to unknown, never to "AI off"` (`src/hooks/use-ai-account-status.test.ts`) |
| 2 · el filtro sin la guarda de la insignia | La guarda **subió a la función pura**: `deriveAttentionState(conv, accountAiOn: boolean \| null)` devuelve `null` cuando el flag es desconocido, y `isUnattended` se define sobre ella. El filtro y la insignia hacen ahora literalmente la misma llamada (`conversation-list.tsx:233` y `:493`), así que no pueden volver a divergir. | `decides nothing for an unassigned thread`, `never reports "unattended" on a failed or pending read`, `still names the assignee — a human is knowable without the flag`, `returns nothing while the account's AI status is unknown` (`src/lib/inbox/attention.test.ts`) |
| 3 · decisión 1 (chats cerrados) | Resuelta en contra de la implementación anterior, por decisión del líder: `status === 'closed'` **no** es «sin atender» ni pinta la alarma ámbar. Un cerrado con asignado sigue mostrando a su dueño; un cerrado sin nadie no muestra insignia. | `gets no alarm when nobody is on a closed thread`, `still shows who owns a closed thread`, `keeps the alarm on the open and pending ones`, `never returns a closed chat — the queue is not the archive` (`src/lib/inbox/attention.test.ts`) |
| 4 · caché sin invalidar | TTL de 30 s (`STATUS_TTL_MS`) **dentro del hook**; no se toca el POST de `/api/ai/config` ni `ai-config.tsx` (fuera de §3). Y se corrigió la frase absoluta del `CHANGELOG.md`, que ahora dice lo que el código hace: apagar el asistente en Ajustes limpia «AI replying» de la lista «en torno a medio minuto, sin recargar». | `expires a cached status so Settings changes reach the list` (`src/hooks/use-ai-account-status.test.ts`) |
| 5 · `??` con nombre vacío | `conversation-list.tsx:510`: `?.full_name \|\| t("attentionAssigned")`. Un `full_name` vacío (`017_account_sharing.sql:230` rellena con `COALESCE(…, '')`) cae al respaldo en vez de dejar el punto de presencia seguido de nada. | sin test propio (el reviewer lo marcó trivial); queda cubierto por inspección |
| 6 · deuda por anotar | Hallazgos 5 y 7 anotados abajo con archivo y línea (puntos 6 y 7 de «Deuda detectada»). | — |

Los cuatro cambios de comportamiento son **detectores comprobados** (se invirtió el código
y la suite falló; luego se restauró):

- devolver `{ autoReplyOn: false }` en `!res.ok` → `2 failed | 9 passed`;
- quitar la comparación del TTL (`if (cached)`) → `1 failed | 10 passed`;
- quitar `if (conversation.status === 'closed') return null` → `4 failed | 15 passed`;
- quitar `if (accountAiOn === null) return null` → `3 failed | 16 passed`.

Lo que **no** se tocó, por acotar al alcance: la insignia (`attention-badge.tsx`), el
`channelKey` de `use-presence.ts`, el reparto de archivos y los catálogos (las cuatro claves
de la 1ª ronda siguen intactas en `messages/en.json:152-155` y `messages/ko.json:152-155`;
CP6 no cambia).

## Qué se hizo

| Archivo | Cambio |
|---|---|
| `src/lib/inbox/attention.ts` (nuevo) | Derivación pura de los tres estados (`ai` / `assigned` / `unattended`), con `null` para «no hay nada que mostrar» (estado de IA desconocido, o hilo cerrado sin nadie), y el predicado `isUnattended` del filtro definido sobre ella. |
| `src/lib/inbox/attention.test.ts` (nuevo) | 19 casos (11 de la 1ª ronda + 8 de la 2ª: desconocido y cerrados). |
| `src/hooks/use-ai-account-status.ts` (nuevo) | La consulta única a `/api/ai/config` con su caché por cuenta, **sacada** de `ai-thread-banner.tsx` para compartirla con la lista; deduplicación de la petición en vuelo, TTL de 30 s y `null` = desconocido en el camino de fallo. |
| `src/hooks/use-ai-account-status.test.ts` (nuevo) | 11 casos (8 + 3 de la 2ª ronda: dos de «desconocido ≠ apagada» y el del TTL). |
| `src/components/inbox/attention-badge.tsx` (nuevo) | La insignia por fila: chispa + acento (IA), punto de presencia + nombre (operador), círculo de alerta + ámbar (sin atender). |
| `src/components/inbox/attention-badge.test.tsx` (nuevo) | 6 casos con `renderToStaticMarkup`. |
| `src/components/inbox/conversation-list.tsx` | Insignia por fila, opción «Sin atender» en el desplegable de filtros, una consulta de `profiles` y una suscripción de presencia (ambas de cuenta, no por conversación). |
| `src/components/inbox/ai-thread-banner.tsx` | Usa el hook compartido; se le quitan 40 líneas que ahora viven en `use-ai-account-status.ts`. Sin cambio de comportamiento. |
| `src/hooks/use-presence.ts` | Parámetro `channelKey` opcional (ver «Decisiones», punto 3). |
| `messages/en.json`, `messages/ko.json` | 4 claves nuevas en `Inbox.conversationList`, misma clave en los dos catálogos. |
| `CHANGELOG.md` | Una entrada en `[Unreleased] → Added`. |

Textos nuevos (`Inbox.conversationList`):

| Clave | en | ko |
|---|---|---|
| `filterUnattended` | Unattended | 미대응 |
| `attentionAi` | AI replying | AI 응답 중 |
| `attentionAssigned` | Assigned | 담당 배정됨 |
| `attentionUnattended` | Nobody on it | 담당자 없음 |

`attentionAssigned` es el respaldo para un `assigned_agent_id` cuyo perfil no está en el
mapa (RLS, o un miembro que se fue): la fila dice «Assigned» en vez de mentir con «sin atender».

## Criterio de aceptación ↔ test

| Criterio (spec §3) | Test | Archivo |
|---|---|---|
| Los tres estados se distinguen a simple vista | `renders a different mark for each of the three states`, `does not lean on colour alone — each state carries its own icon`, `keeps the AI and unattended states visually apart`, `shows the label of each state` | `src/components/inbox/attention-badge.test.tsx` |
| … y el operador va con su punto de presencia | `carries the assignee's presence dot`, `defaults an assignee with no presence row to offline` | `src/components/inbox/attention-badge.test.tsx` |
| Al asignar desde el hilo, la fila cambia al instante por el canal de tiempo real que ya existe | `flips a row to 'assigned' when the payload brings an assignee`, `flips a row back to 'unattended' when the assignee is dropped` (+ verificación manual, abajo) | `src/lib/inbox/attention.test.ts` |
| El filtro «Sin atender» devuelve los chats sin operador y sin IA, **incluidos los cedidos** | `returns the chats with no operator AND no AI, handed-off included`, `returns every unassigned chat once the account's AI is off`, `never returns a closed chat — the queue is not the archive`, `returns nothing while the account's AI status is unknown` | `src/lib/inbox/attention.test.ts` |
| Con la IA desactivada en la cuenta, «IA atendiendo» no aparece nunca | `never returns 'ai' when the account has auto-reply off`, `still shows the assignee when the account has auto-reply off`; el TTL lo hace cierto también en una pestaña ya abierta (`expires a cached status so Settings changes reach the list`) | `src/lib/inbox/attention.test.ts`, `src/hooks/use-ai-account-status.test.ts` |
| (2ª ronda) Un fallo de lectura del estado de IA **no** es «IA apagada» | `resolves a non-OK response to unknown, never to "AI off"`, `resolves a network error to unknown, never to "AI off"`, `decides nothing for an unassigned thread`, `never reports "unattended" on a failed or pending read` | `src/hooks/use-ai-account-status.test.ts`, `src/lib/inbox/attention.test.ts` |
| (2ª ronda) Un chat cerrado no entra en la cola ni pinta la alarma | `gets no alarm when nobody is on a closed thread`, `still shows who owns a closed thread`, `keeps the alarm on the open and pending ones` | `src/lib/inbox/attention.test.ts` |
| No añade consultas por conversación | `hits the endpoint once per account, however many rows ask`, `keys the cache by account so a workspace switch re-reads`, y los dos de no-cachear-fallos | `src/hooks/use-ai-account-status.test.ts` |
| Textos en los catálogos del repo (CP6: en + ko, no existe `es.json`) | inspección: las 4 claves están en los dos archivos | `messages/en.json`, `messages/ko.json` |

Casos extra que fija la suite y no están literalmente en el spec: la fila cedida
(`ai_autoreply_disabled` sin asignado) es «sin atender»; un `ai_autoreply_disabled`
ausente (filas anteriores a la 029) cuenta como «no pausada»; el humano gana a la IA
aunque la bandera de pausa aún no haya llegado.

**Los tests son detectores** (comprobado invirtiendo el código, no solo leyéndolo):

- quitar `accountAiOn &&` de `deriveAttentionState` → `2 failed | 9 passed`;
- borrar el icono del estado «sin atender» de la insignia → `1 failed | 5 passed`;
- borrar `statusCache.set(...)` del hook de estado de IA → `1 failed | 7 passed`.

En los tres casos se restauró el archivo y la suite vuelve a verde.

## Verificaciones contra base real

Ninguna: la feature no toca SQL, no usa el rol de servicio y no añade consultas de
servidor. No hay `progress/checks_attention-state-list.sql` **a propósito**. Lo único
que se comprobó en las migraciones es que `conversations` y `member_presence` ya están
en la publicación `supabase_realtime` (001 línea 420 y 024 línea 99), que es de lo que
depende el criterio del tiempo real.

## Verificaciones manuales pendientes

Una sola, porque necesita dos navegadores y un WebSocket vivo contra Supabase
(no hay e2e en el repo y no se añade ninguno):

**Guion — la fila cambia al instante para el resto del equipo**

1. Dos sesiones en la misma cuenta (dos navegadores, dos miembros: A y B), ambas en `/inbox`.
2. Con la IA de la cuenta **activa**: un chat sin asignar debe leerse «AI replying» en las dos.
3. A abre ese chat y lo asigna a A desde el desplegable «Assign» del hilo.
4. **Esperado en la pantalla de B, sin recargar**: la fila pasa a «A» con su punto de
   presencia en verde, en menos de un segundo. (Camino: `UPDATE` de `conversations` →
   `useRealtime` → `handleConversationEvent` de `src/app/(dashboard)/inbox/page.tsx`, que
   mezcla `{ ...c, ...conv }` → la insignia se deriva en render.)
5. A pulsa «Unassign»: la fila de B vuelve a «AI replying» (o a «Nobody on it» si el hilo
   quedó pausado).
6. Filtro «Unattended» en la cabecera de B: debe listar los chats sin operador y sin IA,
   **incluido** uno que la IA cedió (`ai_autoreply_disabled = true`, sin asignado) y nadie
   recogió, y **sin** los cerrados. Cerrar uno de los que salían (estado «Closed» en el hilo)
   y comprobar que desaparece del filtro y que en la vista «All» pierde la alarma ámbar.
7. Ajustes → IA, apagar la respuesta automática de la cuenta y **volver a la bandeja por
   navegación de cliente, sin recargar**: en menos de 30 s (el TTL de `STATUS_TTL_MS`, que se
   consume en el siguiente montaje de la lista) ninguna fila dice «AI replying». Un paso más:
   volver a encenderla y repetir.
8. Con las herramientas de red del navegador, bloquear `/api/ai/config` (o responder 401) y
   recargar `/inbox`: **ninguna** fila sin asignar debe pintar «Nobody on it» en ámbar ni
   aparecer en el filtro «Unattended» — las filas asignadas sí siguen mostrando a su
   operador. Es el hallazgo 1 del review, y el que no tiene forma de probarse sin navegador
   más allá de la unidad del hook.

## Decisiones donde el spec era ambiguo

1. **Los chats cerrados quedan fuera. Resuelto en la 2ª ronda.** El spec da una tabla de
   tres filas que no menciona `open/pending/closed`, así que la 1ª ronda se implementó literal
   y un chat cerrado sin asignado salía como «sin atender». El reviewer falló el criterio en
   contra (hallazgo 3) y el líder lo confirmó: «Sin atender» es una **cola de trabajo**, no
   el historial. `deriveAttentionState` devuelve ahora `null` para un cerrado que nadie
   atiende (`src/lib/inbox/attention.ts:70`) — sin insignia en la lista y fuera del filtro.
   Un cerrado con asignado sigue mostrando a su dueño, y uno cerrado con la IA activa sigue
   leyéndose «AI replying»: ninguno de los dos es una alarma.

   Consecuencia conocida y aceptada: `filter === "unattended"` sigue siendo una rama `else if`
   frente a los filtros de estado (`conversation-list.tsx:224-236`), así que no se puede
   combinar «Unattended» con «Open». Con los cerrados ya excluidos la combinación pierde casi
   todo su valor; un selector de filtros compuesto es un rediseño de la cabecera, fuera de §3.

2. **El nombre del operador sale de un mapa de `profiles`, no de un join.** Se consideró
   embeber `assigned_agent:profiles(...)` en `CONVERSATION_SELECT` (cero consultas extra),
   pero **rompería el criterio del tiempo real**: los payloads de Realtime no traen joins, y
   la página mezcla el payload sobre la fila que ya tiene, así que el join quedaría con el
   nombre del asignado anterior. Con el mapa por `user_id` la fila resuelve el nombre nuevo
   en el mismo render. Es **una** consulta por montaje de la lista (la misma que ya hace el
   panel del hilo), no una por conversación, que es lo que el spec prohíbe.

3. **`usePresence` recibe un `channelKey`.** El punto de presencia obliga a llamar al hook
   desde la lista, y el panel del hilo ya lo llama en la misma página. `realtime-js`
   **deduplica canales por topic** (`RealtimeClient.channel()` devuelve el existente,
   `node_modules/@supabase/realtime-js/dist/main/RealtimeClient.js:343`) y los bindings de
   `postgres_changes` solo reciben su id en la respuesta del join
   (`RealtimeChannel.js:138,160`): el segundo consumidor habría quedado suscrito a un canal
   ya unido y **sin recibir eventos**. Con `channelKey` cada punto de montaje tiene su topic
   (`presence:<account>:<key>`) y son independientes. El arreglo «bueno» —una suscripción
   compartida con recuento de referencias dentro del hook— es un refactor de infraestructura
   común, fuera del alcance de esta sección: queda en «Deuda».

4. **Nada se decide sin saber el estado de IA de la cuenta** (salvo en filas ya asignadas,
   que no dependen de él). Si no, cada chat que la IA atiende parpadearía en ámbar «Nobody on
   it» durante el viaje de ida y vuelta a `/api/ai/config`, que es exactamente la alarma que
   esta feature introduce: mejor nada durante 200 ms que una alarma falsa. En la 2ª ronda
   esta decisión se llevó hasta el final, que es donde el reviewer la encontró rota:
   (a) **desconocido es un tercer valor** y no colapsa a `false` ni siquiera cuando la
   petición falla — un 401 en un refresco de token habría dejado la alarma encendida para
   siempre en toda la lista; y (b) la guarda vive en `deriveAttentionState`, así que el filtro
   «Unattended» la hereda y no puede volver a divergir de la insignia.

5. **El TTL es de 30 s** (`STATUS_TTL_MS`, `src/hooks/use-ai-account-status.ts:40`). El spec
   no dice nada del refresco. 30 s es corto para que apagar la IA en Ajustes se vea al volver
   a la bandeja sin recargar, y largo para que el valor se lea una vez por montaje de la lista
   y nunca por fila (el criterio «no añade consultas por conversación» lo fija un test). La
   alternativa —limpiar la entrada desde el POST de `/api/ai/config`— tocaría
   `src/components/settings/ai-config.tsx`, que §3 no justifica, y solo arreglaría la pestaña
   que hizo el cambio; el TTL arregla también las demás.

6. **La insignia va en su propia línea** bajo la vista previa del mensaje. La lista mide
   320 px en escritorio; meter el nombre del operador en la línea del contacto o en la del
   preview los dejaba a los dos truncados.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` no cambia. `.env.local.example` sigue bloqueado por permisos y
esta feature no le añadiría nada de todos modos.

## Deuda detectada (no arreglada)

1. **`usePresence` no comparte suscripción.** Con el `channelKey` de arriba, la bandeja abre
   ahora **dos** suscripciones a `member_presence` (lista + hilo) con el mismo filtro: el doble
   de mensajes de Realtime por latido para quien tenga la bandeja abierta. Lo correcto es una
   suscripción por cuenta con recuento de referencias dentro del hook, y consumidores sin
   `channelKey`. Es un refactor de `src/hooks/use-presence.ts` con impacto en tres pantallas;
   merece su propia tarea.

2. **La caché del estado de IA se refresca por tiempo, no por evento.** La 2ª ronda le puso
   un TTL de 30 s (`src/hooks/use-ai-account-status.ts:40`), que cierra el caso real —apagar
   la IA en Ajustes y volver a la bandeja—, pero sigue habiendo una ventana de hasta 30 s en
   la que la lista miente, y el refresco solo ocurre cuando algo vuelve a montar el hook: una
   pestaña dejada abierta en `/inbox` sin navegar no se entera nunca. Lo correcto sería que el
   POST de `/api/ai/config` (`src/components/settings/ai-config.tsx:228-246`, `handleSave`)
   invalidase la entrada, y un canal de Realtime sobre `ai_configs` para las demás pestañas.
   Toca archivos que §3 no justifica.

3. **`presenceLabel` devuelve inglés fijo** (`src/lib/presence.ts`), sin pasar por i18n. La
   insignia lo reutiliza para el tooltip del punto de presencia, igual que ya hacía el
   desplegable «Assign» del hilo. Preexistente; no se tocó.

4. **La lista y el hilo consultan `profiles` por separado** (dos veces la misma consulta al
   montar la bandeja). Un hook `useAccountProfiles` compartido lo dejaría en una; toca
   `message-thread.tsx`, fuera de esta sección.

5. **`conversation-list.tsx` no cumple `.prettierrc`** desde antes de este cambio (comillas
   dobles, líneas > 80). Se formateó **solo lo nuevo** (`attention.ts`, `attention-badge.tsx`,
   los tres tests y `use-ai-account-status.ts`) y en los archivos preexistentes se escribió al
   estilo del código de alrededor, para que el diff sea solo lo mío y no 500 líneas de ruido.
   Reformatear la bandeja entera merece un `chore:` propio.

6. **El cupo de IA agotado no cede el hilo ni se ve** (hallazgo 5 del review). Cuando una
   conversación llega a `autoReplyMaxPerConversation`, `src/lib/ai/auto-reply.ts:83` (el
   early-out barato) y `:241` (`if (claimed !== true) return`, el resultado del RPC
   `claim_ai_reply_slot`, invocado en `:226-232`) **retornan sin escribir**
   `ai_autoreply_disabled` y sin asignar a nadie. La fila queda `disabled = false`, sin
   asignado, y esta feature la pinta «AI replying» para siempre, fuera del filtro
   «Unattended», cuando ya no va a contestar ni la IA ni nadie: es exactamente la muerte en
   silencio que §3 ataca, por un camino que la tabla del spec no cubre. La derivación es
   literal y correcta respecto al spec, así que **no se arregla aquí**: el arreglo va en
   `auto-reply.ts` (poner `ai_autoreply_disabled = true` al agotar el cupo, y probablemente
   reutilizar el aviso de cesión de f1.2), no en la lista. Anotado por exigencia del review.

7. **La lista se re-renderiza entera cada 15 s** (hallazgo 7). `usePresence`
   (`src/components/inbox/conversation-list.tsx:90`) expone un `now` con tick de 15 s para
   envejecer los puntos de presencia; la lista, que antes no tenía temporizador ninguno,
   hereda ese tick. `ConversationItem` no está memoizado y recalcula `formatDistanceToNow`
   por fila, sin virtualización: con cientos de conversaciones abiertas es trabajo repetido
   cada 15 s. Arreglo: `memo` sobre `ConversationItem` y sacar el `now` de presencia a un
   contexto, o virtualizar la lista. Menor pero nuevo, y nace de este cambio.

## Compuerta

Ejecutada entera en el worktree, en el orden de CI:

```
npm run lint        → 0 errors, 37 warnings (todas preexistentes; en los archivos tocados
                      solo la de <img> que ya estaba en conversation-list.tsx)
npm run typecheck   → limpio
TZ=UTC npm test     → 87 archivos, 949 tests, todo verde
npm run build       → ✓ Compiled successfully in 5.8s (con las cuatro variables dummy de ci.yml)
```

(1ª ronda: 938 tests. La 2ª añade 11 —8 en `attention.test.ts`, 3 en
`use-ai-account-status.test.ts`— sobre los 913 de la base.)

Sin SQL → no procede `scripts/replay-migrations.sh`.

CP7: no se usó ninguna API de framework nueva. Lo único de Next es la directiva
`"use client"` en los dos hooks/componentes nuevos que la necesitan, contrastada con
`node_modules/next/dist/docs/01-app/01-getting-started/05-server-and-client-components.md`;
`attention-badge.tsx` no la lleva porque no tiene estado y lo importa un componente que ya
es de cliente (mismo patrón que `presence/presence-dot.tsx`).
