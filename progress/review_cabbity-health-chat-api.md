# Review — n15.5 cabbity-health-chat-api

**Veredicto:** APPROVED

## Compuerta
- Corridos en el worktree: `npm run lint`, `npm run typecheck`, `TZ=UTC npm test`, `npm run build` (variables dummy de `ci.yml`), `scripts/replay-migrations.sh $PWD`.
- lint: 0 errores (34 avisos heredados). typecheck: limpio. test: 416 archivos / 6363 tests verdes. build: OK. replay: `097` aplica y `verify-schema.sql: OK`.

## Aislamiento (foco)
- PATCH `/v1/conversations/{id}`: valida el cuerpo, luego `SELECT ... eq(account_id)` (404 si ajena) y recién después escribe; cada helper de `status-events.ts` vuelve a filtrar por `account_id`. Asignado: `checkAccountMember` sobre `profiles` con `user_id` + `account_id` y `rejectViewer` (400 `invalid_member`, sin escribir).
- Lista: `account_id` en la consulta; `search` filtra contactos por `account_id` y tope de 500. El cursor de actividad valida UUID y `Date.parse`, igual que el existente (misma tolerancia heredada; el `.or()` va ANDed con `account_id`, no hay fuga entre cuentas).
- Media firmada: `parseStorageObjectUrl` con origen propio, `MEDIA_BUCKETS`, `assertStoragePathOwnedBy` y solo `kind === 'account'`. Ajena, `../`, externa, otro bucket o ruta heredada `<uid>/` dan `null`. Cubierto en `conversations-chat.test.ts`.
- `POST /messages`: `conversation_id` filtrado por cuenta (404), excluye `to`/`to_user_id`; `sent_by_member_id` no viewer y de la misma cuenta, validado antes de enviar.
- Scope `conversations:write` exigido en PATCH (403 sin él).

## Migración 097
Aplica sin error. `ADD COLUMN IF NOT EXISTS`, relleno con `AND last_inbound_at IS NULL` (idempotente, una sola pasada), `CREATE OR REPLACE` de `bump_conversation_on_inbound` idéntico al de 037 salvo `last_inbound_at = NOW()` (mismo `SECURITY DEFINER`, `search_path` y REVOKE/GRANT), índice `IF NOT EXISTS`, aserciones en `verify-schema.sql`. No es un trigger, es la función existente; es el mismo UPDATE, así que el webhook de Meta no cambia y las repeticiones de entrega (que no llegan a la función) no la mueven. Sin cascadas. No trae `down`, pero el repo no usa `down` (migraciones forward-only). Nota: el relleno es un UPDATE de toda la tabla en una sentencia; aceptable una vez, vigilar el tamaño en producción.

## Juicio de los 6 desvíos
1. Panel `POST /api/ai/autoreply/{id}` 500→404 y eventos: aceptable. El 404 al fallar la BD es un matiz peor (`setConversationAiPaused` devuelve `false` en ambos casos) pero igual que `assign`/`status`; los eventos nuevos son el objetivo de W10. Deuda menor, sin cambios requeridos.
2. `conversation.updated` al reabrir/pasar a `pending` desde el panel: aceptable; no duplica `closed`. El reabrir automático (`reopen.ts`) no emite: Health no verá ese cambio hasta recargar (ver diferencias).
3. Panel sin `sender_id`: aceptable para wacrm, pero afecta a Health (ver diferencias, punto 1).
4. `message.sent` de bots con relectura por (conversación, wamid): aceptable, dentro de `try`.
5. Cursor con zona de nulos: correcto y probado.
6. Campos nuevos opcionales en OpenAPI: aceptable.

## Eventos sin duplicados
`message.sent` se emite una vez en `sendMessageToConversation` y en los caminos de bot/flujo/automatización; no por destinatario de difusión. `conversation.updated` no acompaña a `closed`; IA solo si la bandera cambió; leída solo si había sin leer. Reanudar la IA con `assigned_agent_id` explícito en el mismo PATCH emite dos `conversation.assigned` seguidos (`null` y luego el id): el segundo es el estado final correcto; Health debe tratar eventos como señal de «recargar», no como diff.

## Diferencias con lo que espera Health (tandas HA–HC)
1. **Autor de lo enviado desde el panel de wacrm (importante).** `sender_member_id` es `null` para mensajes del panel (desvío 3). El diseño de Health (`ChatMessagePresenter`) pinta `integration` si `agent` sin miembro, así que lo que alguien responde en wacrm se vería como «Integración», contra la promesa del diseño («Ambos sitios a la vez… con su nombre»). Arreglar en **wacrm**: pasar `userId` como `senderId` en `/api/whatsapp/send` (una línea). Alternativa en Health: mostrar «Agente en wacrm».
2. **`last_message.direction`.** El ejemplo de conversación de Health (§4.1) lleva `last_message{text, direction, at}`; wacrm solo da `last_message_text` y `last_message_at`, sin dirección. Arreglar en **Health** (calcular `inbound` si `last_inbound_at == last_message_at`, o quitar `direction` de la bandeja); no vale tocar wacrm.
3. **`meta.unread_total`.** Health lo promete en la bandeja; wacrm no da total de no leídas. Arreglar en **Health** (contar con `unread=true` o devolver solo la página).
4. **Detección `wacrm_outdated`.** Health la marca con 400/404 por parámetro desconocido, pero un wacrm viejo ignora `sort`/`unread`/`search` en el GET (200 sin los campos nuevos) y el PATCH sería 405/404. Arreglar en **Health**: detectar por ausencia de `service_window_expires_at`/`ai` en la conversación y por `conversations:write` en `me()`, no por 400.
5. **Forma del cuerpo.** Health manda `assign: me|none|{user_id}`, `status`, `ai_paused`, `read`; wacrm espera `assigned_agent_id` (id de usuario de wacrm o `null`), `status`, `ai_autoreply_disabled`, `read` (solo `true`). El mapeo es de Health (`UpdateChatConversationAction`); `assign: me` necesita el id de miembro del vínculo. `status` de wacrm admite además `pending`.
6. **Orden y estado al reanudar IA.** Reanudar suelta al asignado (comportamiento del panel). Health debe enviar el `assigned_agent_id` en el mismo PATCH si quiere conservar asignación; wacrm aplica el explícito al final.
7. **`media.mime_type` nulo en salientes** y solo `media` firmada de 10 min para objetos de la cuenta; el resto es `null` aunque `media_url` exista. Coincide con W9; Health debe tratar `media: null` + `content_type` ≠ text como «Ábralo en wacrm».
8. **Eventos.** Coinciden con W10: `message.sent`, `conversation.updated{fields}`, `message_id` en `message.received`/`message.status_updated`. El reabrir automático por mensaje entrante no emite `conversation.updated` (el `message.received` ya llega). `message.sent` del panel lleva `sender_member_id: null` (punto 1).

## Checkpoints (`CHECKPOINTS.md`)
- CP1: [x] lint, typecheck, test y build corridos por mí.
- CP2: [x] 097 idempotente, aserciones, replay sale 0, sin cascadas.
- CP3: [x] cada consulta con `supabaseAdmin()` filtra por `account_id`; tests de fuga en las rutas y en media.
- CP4: [x] tests junto a PATCH, lista, mensajes, media, eventos; verificación manual pendiente listada en el informe (necesita wacrm real).
- CP5: [x] `package.json` sin cambios.
- CP6: n/a (sin UI nueva).
- CP7: n/a.
- CP8: [x] el diff toca solo lo que W6–W12 justifica (el panel por la extracción compartida, declarado).
- CP9: [x] CHANGELOG, OpenAPI, `/developers` e informe presentes.
- CP10: [x] tres commits en la rama, sin push.
- CP11: [x] `message.received` solo suma `message_id`; la función del webhook mantiene la misma sentencia.

## Hallazgos
Ninguno bloqueante.

## Cambios requeridos
Ninguno. Recomendado antes de integrar Health: punto 1 (pasar `userId` en `/api/whatsapp/send`).
