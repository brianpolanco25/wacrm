# impl m14.2 coexistence-echo-media

Estado: **done** (pendiente de reviewer). Rama `feat/coexistence-echo-media`, worktree
`.claude/worktrees/coexistence-echo-media`. Commit: `7e33c06` (fix: muestra la media de los ecos
de coexistencia en la bandeja (m14.2)).

## Plan (seguido)
1. Extraer `verifyAndBuildUrl` del webhook de entrantes a módulo compartido + test propio (A1).
2. Parser de ecos: descriptor de media (`<tipo>.id`, mime, caption, filename, timestamp).
3. `handleEchoes`: token descifrado de la fila, resolver URL con el módulo de A1, fila de entrante o marcador.
4. `storeThreadMessages`: content_type / media_url / media_type por fila; last_message_text sigue siendo el marcador.
5. Tests (A4), CHANGELOG, compuerta dirigida.

## Archivos
- `src/lib/whatsapp/inbound-media-url.ts` (nuevo): `resolveInboundMediaUrl({ mediaId, accessToken, mirror: {storage, accountId} | null, fileName?, messageTimestamp? })`. Mismo cuerpo que el `verifyAndBuildUrl` anterior (getMediaUrl → mirrorInboundMedia si mirror → proxy `/api/whatsapp/media/<id>` → null con log si Meta falla; nunca lanza).
- `src/app/api/whatsapp/webhook/route.ts`: `verifyAndBuildUrl` ahora es un wrapper de una línea sobre `resolveInboundMediaUrl` con los mismos argumentos (storage = `supabaseAdmin().storage`, mirror según `config.mirror_inbound_media !== false`, como antes). Imports de `getMediaUrl`/`mirrorInboundMedia` retirados del route.
- `src/lib/whatsapp/coexistence-webhook.ts`:
  - `CoexistenceConfig` declara `access_token?` (cifrado) y `mirror_inbound_media?` — el webhook ya le pasaba la fila entera de `whatsapp_config` (`select('*')`), no se tocó el route para esto.
  - `CoexistenceMessage` gana `media?: EchoMedia` (del parser) y `stored?: StoredMedia` (cuando resolvió). Nuevos exports: `ECHO_MEDIA_TYPES`, `echoMediaFor`, `contentTypeForMedia` (sticker → image), `storedMediaFor`.
  - `parseMessageEchoes` adjunta `media` si hay `<tipo>.id`; `contentText` sigue siendo el marcador.
  - `handleEchoes` descifra el token una vez por entrega solo si hay algún eco con media (`echoMediaToken`, null + log sin secreto si falta o no descifra) y llama a `resolveEchoMedia` (try/catch, nunca lanza).
  - `storeThreadMessages`: `content_type = stored?.contentType ?? 'text'`, `content_text = stored ? caption : marcador`, `media_url`, `media_type`. `last_message_text` se toma del marcador por wamid (antes de la fila), así no cambia.
- `src/lib/whatsapp/inbound-media-url.test.ts` (nuevo), `src/lib/whatsapp/coexistence-webhook.test.ts` (mock de meta-api + guardia de fetch en todo el archivo + describe `echo media (m14.2)`).
- `CHANGELOG.md` (Unreleased).

## Criterio ↔ test
| Criterio | Test |
|---|---|
| A1 módulo compartido | `inbound-media-url.test.ts`: «mirror on → verifies with Meta (id, token) and returns the bucket URL», «document → the sender file name reaches the mirrored object», «mirror off → proxy URL, nothing downloaded», «mirror fails (upload error) → proxy URL», «Meta fails → null, logged without the token, never throws» |
| A1 sin cambio en entrantes | `src/app/api/whatsapp/webhook/route.test.ts` completo en verde sin tocarlo (incluye mirror on/off/undefined) |
| A2 eco media → fila de entrante | `coexistence-webhook.test.ts` › echo media (m14.2): «mirrored image echo → image row with the bucket URL, caption and mime; summary keeps the marker», «sticker → image; document → file name as text; audio without caption → null text», «parser: an echo media with id carries its descriptor…» |
| A2 null → marcador, nunca lanza | «Meta fails → the marker of today with media_url null, and the webhook goes on», «no access token on the config → marker, Meta never asked» |
| A3 texto/edit/historial/last_message_text | «text echo → untouched…», «edit with media keeps the marker; history media stays as markers», assert de `last_message_text` en el test de imagen; tests previos de revoke/edit/historial intactos |
| A3 mirror_inbound_media = false | «mirror_inbound_media = false → proxy URL, nothing uploaded» |
| A4 sin red | `vi.stubGlobal('fetch', …throw)` en beforeEach de ambos archivos + `expect(fetch).not.toHaveBeenCalled()`; meta-api mockeado |

Token: assert de que no aparece en filas de `messages` ni en logs (`expectLogsClean(TOKEN, …)`).

## Compuerta dirigida
- `npm run typecheck`: verde.
- `npm run lint`: 0 errores (34 warnings preexistentes del repo; ninguno nuevo en lo tocado).
- `TZ=UTC npx vitest run src/lib/whatsapp/inbound-media-url.test.ts src/app/api/whatsapp/webhook/ src/lib/whatsapp/coexistence src/lib/whatsapp/mirror-inbound-media.test.ts src/lib/security/tenant-isolation.test.ts`: 7 archivos, 318 tests en verde.
- No se corrió `npm test` completo ni `build` (instrucción del líder). Sin SQL, sin migraciones.

## Decisiones (spec ambiguo)
- **Documento**: `content_text = caption || filename` (no solo caption), igual que el webhook de entrantes; la bandeja usa `content_text` como nombre del adjunto (`message-media.tsx` L269). A2 dice «caption o null»; elegí la equivalencia con el entrante.
- **last_message_text**: se mantiene el marcador `[tipo] caption` de hoy (A3), no el caption solo.
- **Token**: se usa `config.access_token` (cifrado, ya presente en la fila que pasa el webhook) + `decrypt`, en vez de una consulta extra con `resolveWhatsAppConfig`. Solo se descifra si la entrega trae algún eco con media.
- **Edit con media**: sigue siendo reescritura de `content_text` con el marcador (A3); no se resuelve la media del edit.
- **Historial con `image.id`**: no se resuelve (fuera de alcance; el historial va por batches y Meta no entrega bytes del placeholder).

## Verificación manual pendiente (requiere Meta real)
1. Con un número en coexistencia y la rama desplegada, enviar desde el teléfono una foto con caption a un contacto.
2. En la bandeja, la burbuja del agente debe mostrar la imagen (URL de `chat-media/<account>/inbound/...`), con el caption debajo; la lista de conversaciones muestra «[image] caption».
3. Repetir con `mirror_inbound_media = false`: la imagen carga vía `/api/whatsapp/media/<id>`.
4. Logs `[webhook] message echoes:` sin token ni caption.

## Variables de entorno
Ninguna nueva.

## Deuda detectada (fuera de alcance, no tocada)
- `src/app/api/whatsapp/webhook/route.ts` L5 importa `downloadMedia` sin usarlo (warning de lint preexistente).

## Ronda 2 (CHANGES_REQUESTED → atendido)
Commit `0dd04d8` (fix: revoke y edit de ecos con media respetan el adjunto (m14.2)) sobre `7e33c06`.

Cambios requeridos:
1. **Revoke** (`applyEchoRewrite`): el patch del revoke es ahora `{ content_text: '[deleted]', content_type: 'text', media_url: null, media_type: null }`. Para filas de texto no cambia nada; una fila de adjunto deja de mostrar la media. Test: «revoke of a mirrored image → text row, [deleted], no media, summary untouched».
2. **Edit sobre adjunto**: el `ParsedEcho` de edit lleva `caption` (string o null) cuando el mensaje editado no es texto. Si la fila destino tiene `content_type !== 'text'` (se lee antes con un select acotado por `conversation_id` + `message_id`), se escribe el caption a secas; si es texto, el marcador de siempre. Test: «edit of an attachment row → bare new caption, media intact» (hola → adios, content_type/media_url/media_type intactos). El test del parser de edit se actualizó para esperar `caption: 'nueva'`; el test «edit with media keeps the marker…» (fila destino de texto) sigue verde.
3. **Reintento con media**: «the same media echo delivered twice → one row, no throw, summary unchanged» (también `last_message_at` intacto).

Opcionales aplicados:
- Hallazgo 7: quitado el try/catch redundante de `resolveEchoMedia` (comentario: `resolveInboundMediaUrl` nunca lanza).
- Hallazgo 9: anotado en el doc de `MIRROR_FOLDER` (`mirror-inbound-media.ts`) que la media de eco también cae en `inbound/` y sigue el toggle `mirror_inbound_media`.

Compuerta dirigida ronda 2: typecheck verde; eslint sobre lo tocado sin avisos; vitest dirigido (7 archivos: inbound-media-url, webhook route, coexistence-webhook, coexistence-batches, mirror-inbound-media, tenant-isolation) 321/321 verde.

## Deuda (hallazgos no bloqueantes del reviewer, no implementados)
- H4: la media se resuelve eco a eco dentro del `after()` (60 s) antes del drain del historial; una entrega con varios vídeos puede agotar el presupuesto (mismo patrón que entrantes).
- H5: en un reintento se descarga y sube otra vez antes de que el upsert `ignoreDuplicates` lo descarte; y si la primera entrega quedó como marcador por un fallo transitorio de Meta, nunca se promueve a adjunto. Posible mejora: comprobar `(conversation_id, message_id)` antes de resolver.
- H6: con `mirror_inbound_media=false` el proxy `/api/whatsapp/media/<id>` usa el token del número por defecto de la cuenta; la media de un segundo número de otra WABA puede quedar «no disponible» (ya ocurre en entrantes).
- H8: en `route.ts` `supabaseAdmin().storage` se evalúa antes de `getMediaUrl` y fuera del try; cliente memoizado, sin efecto práctico.
