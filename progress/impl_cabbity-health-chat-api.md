# impl · n15.5 cabbity-health-chat-api

Rama `feat/cabbity-health-chat-api` (worktree `.claude/worktrees/cabbity-health-chat-api`), sobre `main` con n15.3 y n15.4.
Spec: `cabbity-health/specs/chat-whatsapp-en-health/` (W6–W12, design §13).

## Compuerta (en el worktree)

| Comando | Resultado |
|---|---|
| `npm run lint` | 0 errores (34 avisos heredados; ninguno nuevo en lo tocado) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 416 archivos pasan, 6363 tests |
| `npm run build` (variables dummy de `ci.yml`) | OK |
| `scripts/replay-migrations.sh $PWD` | 097 aplica y `verify-schema.sql: OK` |

Nota: `node_modules` del worktree es una copia (`cp -a --reflink=auto`), porque Turbopack rechaza un symlink que sale de la raíz.

## Qué se hizo, por requisito

| Req | Test |
|---|---|
| W6 PATCH (scope 403, ajena 404, miembro 400 `invalid_member`, validación previa, eventos, IA, leída) | `src/app/api/v1/conversations/[id]/route.test.ts`, `src/lib/conversations/chat-actions.test.ts`, `status-events.test.ts` |
| W7 `conversation_id` / `sent_by_member_id` | `src/app/api/v1/messages/route.chat.test.ts`, `src/lib/whatsapp/send-message.test.ts` (n15.5) |
| W8 lista (orden, cursor, filtros, búsqueda, ventana, `ai`, aislamiento) | `src/app/api/v1/conversations/route.test.ts` |
| W9 mensaje (`sender_member_id`, `media` firmada, solo bucket y cuenta propios) | `src/lib/api/v1/conversations-chat.test.ts` |
| W10 eventos | `send-message.test.ts` (`message.sent`), `status-events.test.ts` / `chat-actions.test.ts` (`conversation.updated`) |
| W11 OpenAPI, `/developers`, CHANGELOG | `coverage.test.ts`, `model.test.ts`, `real-document.test.ts`, `document.test.ts` (conteo de operaciones 39 -> 40; rutas siguen 27) |
| W12 aislamiento y scope por endpoint | los de arriba |

Commits: ver `git log main..feat/cabbity-health-chat-api`.

## Contrato final (para Health)

Todo bajo `/api/v1`, envoltorio `{data}` / `{data, meta:{next_cursor}}`, errores `{error:{code,message,request_id}}`.

### Scope nuevo `conversations:write`
Se elige al crear la clave (no hace falta migración para scopes).

### `PATCH /conversations/{id}` (scope `conversations:write`)
Cuerpo JSON, al menos uno:
- `assigned_agent_id`: `string` (user id de un miembro NO `viewer` de la cuenta; el de `GET /members`) o `null`.
- `status`: `open` | `pending` | `closed`.
- `ai_autoreply_disabled`: boolean (`true` pausa, `false` reanuda: suelta al asignado, `ai_reply_count = 0`, `ai_handoff_summary = null`).
- `read`: solo `true` (`unread_count = 0`).

Se valida todo antes de escribir. Orden de aplicación: IA, asignación, estado, leída (un `assigned_agent_id` explícito gana sobre el desasignado de reanudar la IA).
Respuesta 200: la conversación serializada (ver abajo). Errores: 400 `bad_request` (sin campos / tipo o valor inválido / cuerpo no JSON), 400 `invalid_member` (asignado ajeno, inexistente o viewer), 403 `forbidden` (sin scope), 404 `not_found` (id de otra cuenta).

### `GET /conversations` (scope `conversations:read`) — parámetros nuevos
- `sort=created_at` (por defecto) | `last_activity` (`last_message_at desc nulls last, id desc`; las sin mensajes al final). Cada orden tiene su cursor: no mezclar. Otro valor: 400.
- `assigned_agent_id=<uuid>|none` (otro valor: 400), `unread=true|false` (otro valor: 400), `search=<texto>` (nombre o teléfono del contacto, saneado como `GET /contacts`; tope de 500 contactos coincidentes), más `status` y `contact_id` de antes.

### Conversación (lista, lectura y PATCH; NO en exportaciones)
Campos de antes más:
- `last_inbound_at`: ISO | null.
- `service_window_expires_at`: `last_inbound_at + 24 h` ISO | null.
- `ai`: `{active, paused, handoff_summary}`; `active` = (`ai_configs.is_active && auto_reply_enabled` de la cuenta) && no pausada && sin asignado.

### `POST /messages` — campos nuevos
- `conversation_id` (uuid): envía por esa conversación y su número; con `to`/`to_user_id` es 400; de otra cuenta 404; `contact_created` siempre `false`. Ahora `to`/`to_user_id`/`conversation_id`: hace falta uno.
- `sent_by_member_id` (user id): miembro no viewer (si no, 400 `invalid_member` y NO envía); se guarda en `messages.sender_id`.
- La clave de idempotencia ya cubre el cuerpo completo.

### Mensaje (`GET /conversations/{id}/messages`) — campos nuevos
- `sender_member_id`: `sender_id` si `sender_type = agent`, si no `null`.
- `media`: `{url, mime_type, filename, expires_at}` | `null`. URL firmada de 10 min solo para objetos de `chat-media` / `flow-media` bajo `account-<id de la cuenta de la clave>/`; enlaces externos, otra cuenta, otros buckets o rutas heredadas `<uid>/…` dan `null`. `media_url` se conserva tal cual (los buckets son privados; no se abre directo). `mime_type` es `messages.media_type` (solo entrantes; `null` en salientes). `filename` sale del último segmento de la ruta.
- Firmar URLs: una llamada a storage por mensaje con adjunto (paginas de hasta 100).

### Eventos nuevos y cambios (webhooks)
- `message.sent`: `{conversation_id, message_id, whatsapp_message_id, sender_type ('agent'|'bot'), sender_member_id, content_type}` por cada saliente guardado desde panel, API, IA, flujo o automatización; NO por destinatario de difusión. `message_id` puede ser `null` solo en envíos del bot si la relectura falla.
- `conversation.updated`: `{conversation_id, contact_id, fields: ['status'|'ai_autoreply_disabled'|'unread_count']}`: estado a algo distinto de `closed` (el cierre emite solo `conversation.closed`), IA pausada/reanudada (solo si la bandera cambió), `unread_count` a 0 (solo si había sin leer).
- `message.received` y `message.status_updated` suman `message_id` (`messages.id`).
- Reanudar la IA además emite `conversation.assigned` (`assigned_agent_id: null`) si soltó a alguien.

## Migración (no aplicada a ninguna base remota)
`supabase/migrations/097_conversation_last_inbound_at.sql`: columna `conversations.last_inbound_at`, relleno desde `messages` (`sender_type = 'customer'`), `bump_conversation_on_inbound` la actualiza (mismo UPDATE; el webhook de Meta no cambia, las repeticiones de entrega no llegan a la función) e índice `(account_id, last_message_at desc, id desc)`. Aserciones en `supabase/ci/verify-schema.sql`. Idempotente.
Orden de despliegue: aplicar 097 antes de desplegar el código (el SELECT `*` no falla sin la columna, pero `last_inbound_at` saldría siempre `null` y `service_window_expires_at` también).

## Desvíos y decisiones
1. **Panel**: `POST /api/ai/autoreply/{id}` usa ahora `setConversationAiPaused` (misma lógica extraída a `lib/ai/autoreply-toggle.ts`) y por tanto emite `conversation.updated`/`assigned`; un error de BD en esa ruta ahora responde 404 en vez de 500 (igual que ya hacían `assign`/`status`). `PATCH /api/conversations/{id}` usa `checkAccountMember` (mismo comportamiento: miembro, viewers incluidos).
2. **`conversation.updated` desde el panel**: reabrir/pasar a `pending` desde el panel también lo emite (`setConversationStatus` es compartido). El reabrir automático al entrar un mensaje (`reopen.ts`) NO lo emite (no se tocó).
3. **Panel no guarda `sender_id`**: el panel no pasa `senderId` (su fila y comportamiento no cambian), así `message.sent.sender_member_id` es `null` para envíos desde el panel. Si Health quiere atribuir también esos, es un cambio de una línea en `/api/whatsapp/send` (pasar `userId`).
4. **`message.sent` de bots** resuelve el `messages.id` con una lectura por (conversación, wamid) porque esos caminos insertan sin `.select()` (no se cambió su cadena de inserción); dentro de `try`, nunca afecta al envío.
5. **Ordenar por actividad con nulos**: el cursor lleva el timestamp vacío al entrar en la zona de conversaciones sin mensajes.
6. Los campos nuevos de `Conversation` en OpenAPI son opcionales (no van en exportaciones, que reutilizan el esquema).
7. `ai.active` usa `ai_configs` por cuenta (una consulta por petición).
8. No se hizo `POST /api/v1/media`, notas internas ni respuestas rápidas (fuera de n15.5 según el diseño).

## Verificación manual pendiente (requiere wacrm real)
1. Aplicar 097 a una base local; `PATCH` con clave con `conversations:write` y comprobar en el panel que asignar/cerrar/pausar IA se ve igual.
2. Enviar con `conversation_id` + `sent_by_member_id` y ver el nombre en `messages.sender_id` y el evento `message.sent` en un receptor de prueba.
3. Mensaje con foto: pedir `GET .../messages` y abrir `media.url` antes y después de 10 min.

## Deuda detectada (no arreglada)
- 34 avisos de lint heredados (`react-hooks/exhaustive-deps`, variables sin uso).
- El panel lee el SELECT `*` de conversaciones (sin proyección explícita) — heredado, igual que `GET /conversations` previo.
