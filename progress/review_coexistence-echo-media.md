# Review — m14.2 coexistence-echo-media

**Veredicto:** CHANGES_REQUESTED

Rama `feat/coexistence-echo-media`, 1 commit `7e33c06` sobre main @ 7bc2fd2. Diff: 6 archivos (CHANGELOG, route.ts, coexistence-webhook.ts + test, inbound-media-url.ts + test). Coincide con el informe.

## Compuerta (dirigida, ejecutada por el reviewer en el worktree)
- lint: verde (0 errores; 34 warnings. En los archivos tocados solo hay uno, `route.ts:5` `downloadMedia` sin usar, y ya estaba en main)
- typecheck: verde
- vitest dirigido (`TZ=UTC`, 7 archivos): 318/318 verde
- `npm test` completo / build: no se corrieron (lo indicó el líder)
- replay-migrations: n/a (no hay SQL)

## Trazabilidad criterio ↔ test
- A1 «extraer verifyAndBuildUrl a un módulo compartido con test propio; el webhook de entrantes no cambia»: [x] `src/lib/whatsapp/inbound-media-url.test.ts`: mirror on, documento con fileName, mirror off, fallo de upload → proxy, Meta falla → null sin token en logs. `route.test.ts` sigue verde sin cambios y cubre mirror true/false/undefined con `mirrorInboundMedia` real y `getMediaUrl` mockeado. Comparé el cuerpo extraído con el de main línea a línea: igual en getMediaUrl → mirror → proxy → catch null, fileName, `messageTimestamp: message.timestamp` y `mirror_inbound_media !== false` (route.ts:550, sin tocar).
- A2 «eco con media → fila de entrante, null → marcador, nunca lanza»: [x] `coexistence-webhook.test.ts` › echo media (m14.2): "mirrored image echo…", "sticker → image; document → file name…", "Meta fails → the marker…" (`resolves`), "no access token…". El token no aparece en `messages` ni en logs, y el caption no aparece en logs (`expectLogsClean`).
- A3 «texto, revoke, edit, historial y last_message_text sin cambios; mirror false → proxy»: [ ] parcial. Texto, historial, last_message_text y mirror=false tienen test. **Revoke y edit sobre una fila que ahora es media cambian de comportamiento y no tienen test** (hallazgos 1 y 2).
- A4 «tests, sin red, CHANGELOG, compuerta»: [x] `vi.stubGlobal('fetch', throw)` en el beforeEach de los dos archivos; `meta-api` mockeado con `importOriginal`; `expect(fetch).not.toHaveBeenCalled()`. CHANGELOG (Unreleased) actualizado.

## Checkpoints
- CP1: [x] compuerta dirigida verde (lo que pidió el líder; el gate completo queda para el humano)
- CP2: [x] n/a, sin SQL
- CP3: [x] el mirror usa `config.account_id` (la fila resuelta por phone_number_id); el test comprueba que la ruta contiene la cuenta. Las consultas nuevas no salen de la cuenta. tenant-isolation verde.
- CP4: [ ] faltan tests de revoke/edit sobre fila con media y de reintento de un eco con media (ver abajo)
- CP5: [x] package.json intacto
- CP6: [x] n/a, sin UI
- CP7: [x] n/a, ninguna API de framework nueva
- CP8: [x] alcance correcto
- CP9: [x] CHANGELOG; sin variables nuevas; el informe coincide con el diff
- CP10: [x] commit en español con prefijo y Co-Authored-By; nada pusheado
- CP11: [x] la media es de mejor esfuerzo; un fallo de Meta, de descifrado o de storage no impide guardar la fila

## Hallazgos (archivo:línea)
1. `src/lib/whatsapp/coexistence-webhook.ts:588-604` — **regresión en revoke.** `applyEchoRewrite` solo actualiza `content_text = '[deleted]'`. Ahora un eco con media es una fila `content_type='image'` con `media_url` (URL pública de `chat-media` o proxy). Si el negocio borra la foto para todos desde el teléfono, la bandeja la sigue mostrando, con «[deleted]» como caption. Antes de este cambio la fila era texto y desaparecía entera. Esto rompe el «revoke sin cambios» de A3.
2. `src/lib/whatsapp/coexistence-webhook.ts:588` y `:323` (`contentTextFor`) — **edit sobre fila con media.** Un edit escribe `content_text = '[image] adios'`. En una fila de media, `content_text` es ahora el caption a secas, así que la burbuja de la imagen muestra el prefijo literal «[image] ». A3 pedía conservar el marcador, y eso tenía sentido cuando la fila era texto. Sobre una fila de adjunto deja el caption corrupto.
3. `src/lib/whatsapp/coexistence-webhook.test.ts` — falta un test de reintento para un eco con media (la misma entrega dos veces → una sola fila, sin lanzar y con `last_message_text` sin cambios). El único test de idempotencia (`:575`) usa un eco de texto. El mecanismo es el mismo upsert y no veo fallo, pero el líder lo pidió explícitamente y el camino nuevo (mirror antes del upsert) no está ejercitado.

### No bloqueantes (para deuda o para decidir el líder)
4. `coexistence-webhook.ts:706-710` — la media se resuelve (Meta, descarga, upload) eco a eco dentro del `after()` (maxDuration 60 s), antes del drain del historial. Una entrega con varios vídeos puede agotar el presupuesto. Es el mismo patrón que el webhook de entrantes.
5. `coexistence-webhook.ts:709` — en un reintento se descarga y se sube otra vez antes de que el upsert `ignoreDuplicates` lo descarte. Se podría comprobar si existe `(conversation_id, message_id)` antes de resolver. Y si la primera entrega quedó como marcador por un fallo transitorio de Meta, nunca se actualiza a adjunto.
6. Con `mirror_inbound_media=false`, el proxy `/api/whatsapp/media/<id>` usa el token del número por defecto de la cuenta. La media de eco de un segundo número con otra WABA puede quedar «no disponible» en lugar del marcador. El webhook de entrantes ya tiene este problema.
7. `coexistence-webhook.ts:670` — el try/catch de `resolveEchoMedia` es redundante: `resolveInboundMediaUrl` no lanza. Es inofensivo.
8. `route.ts:1448-1455` — `supabaseAdmin().storage` se evalúa antes de `getMediaUrl` en lugar de dentro del try. Como el cliente está memoizado, en la práctica no cambia el comportamiento.
9. La media de eco (enviada por el negocio) se espeja en `account-<id>/inbound/` y depende del toggle `mirror_inbound_media`, que está documentado como «lo que nos envió el cliente». Conviene anotarlo en la doc de `MIRROR_FOLDER` o en el informe.

## Cambios requeridos
1. Revoke: en `applyEchoRewrite`, cuando `echo.kind === 'revoke'`, pon también `content_type: 'text'`, `media_url: null` y `media_type: null`, para que la fila borrada deje de mostrar el adjunto. Test: un eco de imagen espejado y luego su revoke → fila `content_type 'text'`, `content_text '[deleted]'`, `media_url null`, y `last_message_text` sin tocar.
2. Edit: si la fila destino ya es un adjunto (`content_type` distinto de `'text'`), escribe el caption nuevo a secas (o null), no el marcador `[tipo] caption`. Las filas de texto mantienen el marcador como hoy. Test: imagen con caption «hola» resuelta, luego edit a «adios» → `content_text 'adios'`, `content_type` y `media_url` intactos.
3. Test de reintento para un eco con media (hallazgo 3).

---

## Ronda 2 — commit `0dd04d8` sobre `7e33c06`

**Veredicto:** APPROVED

### Compuerta (dirigida, ejecutada en el worktree @ 0dd04d8, árbol limpio)
- lint: verde (0 errores, 34 warnings, ninguno nuevo)
- typecheck: verde
- vitest dirigido (`TZ=UTC`, 7 archivos): 321/321 verde (+3 tests)

### Cambios requeridos de la ronda 1
1. Revoke: [x] `coexistence-webhook.ts:614-620`. El patch de revoke ahora pone `content_text '[deleted]'`, `content_type 'text'`, `media_url null` y `media_type null`. Test «revoke of a mirrored image → text row, [deleted], no media, summary untouched»: espeja una imagen real (fake storage), la revoca, y comprueba los cuatro campos, que no hay fila del wamid del revoke y que `last_message_text` no cambia.
2. Edit sobre adjunto: [x] `coexistence-webhook.ts:323-335` (el parser guarda `caption` solo cuando el editado no es texto) y `:623-635`. El select previo está acotado por `conversation_id` (la conversación ya se buscó con `.eq('account_id', config.account_id)`) y por `message_id`, igual que el update que viene después. Si `content_type !== 'text'` escribe el caption a secas; si no, el marcador de siempre. Test «edit of an attachment row → bare new caption, media intact»: `content_text 'adios'`, `content_type`, `media_url` y `media_type` intactos. El test de la ronda 1 «edit with media keeps the marker» (fila destino de texto) sigue verde.
   - Carrera: entre el select y el update, un revoke concurrente del mismo wamid podría dejar el caption del edit encima de `[deleted]`. Esa ventana ya existía antes de este cambio: un edit que llegara después de un revoke también sobrescribía el texto. El edit nunca toca `content_type`, `media_url` ni `media_type`, así que no puede devolver la media a una fila revocada ni cruzar de cuenta. No es peligroso.
3. Reintento de un eco con media: [x] test «the same media echo delivered twice → one row, no throw, summary unchanged». Comprueba una sola fila `image`, que la segunda entrega resuelve sin lanzar y que `last_message_text` y `last_message_at` no cambian.

### Opcionales atendidos
- 7: try/catch redundante retirado de `resolveEchoMedia` (`:705`); `resolveInboundMediaUrl` no lanza (cubierto por el test «Meta fails → null…»). [x]
- 9: la doc de `MIRROR_FOLDER` (`mirror-inbound-media.ts:47-50`) anota la excepción de los ecos. Es solo un comentario. [x]

### Deuda anotada, no bloqueante
H4 (presupuesto de `after()` con varios vídeos), H5 (descarga repetida en un reintento, el marcador nunca pasa a adjunto), H6 (el proxy usa el token del número por defecto) y H8 (`supabaseAdmin().storage` evaluado antes del try): constan en el informe del implementer como deuda.

### Checkpoints (ronda 2)
CP1 [x] dirigida · CP3 [x] · CP4 [x] · CP5 [x] · CP8 [x] (el único archivo nuevo tocado es un comentario de `mirror-inbound-media.ts`, justificado por H9) · CP10 [x] commit en español con Co-Authored-By, nada pusheado · CP11 [x].
