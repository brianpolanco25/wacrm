# m14.1 support-media-signing — informe de implementación

## Plan
1. Ruta `GET /api/media/sign` (A1) con firma por rol de servicio acotada a `account-<cuenta efectiva>/`.
2. `signed-url.ts`: en soporte (bandera `wacrm_support_active`) firmar vía la ruta con `fetch` inyectable (A2).
3. Tests de ruta, de `signed-url` y caso de fuga en `tenant-isolation.test.ts`.
4. Verificar A3 leyendo consumidores; correcciones documentales y CHANGELOG (A4).

## Rama y commits
- Rama `feat/support-media-signing` (worktree `.claude/worktrees/support-media-signing`), desde main @ 7bc2fd2.
- `a0f2372` fix: firma en el servidor la media de chat-media en sesión de soporte (m14.1)

## Archivos
- Nuevo `src/app/api/media/sign/route.ts`, `src/app/api/media/sign/route.test.ts`
- `src/lib/media/signed-url.ts` (+ cabecera corregida), `src/lib/media/signed-url.test.ts`
- `src/lib/security/tenant-isolation.test.ts` (describe nuevo al final + import)
- `CHANGELOG.md`, `docs/security.md` («Private attachments»), `progress/impl_impersonation-audit.md` (nota al pie fechada `[^m141]`), `progress/impl_impersonation-write.md` (punto 3, actualización fechada)

## Criterio ↔ test
| Criterio | Test |
|---|---|
| A1 401 sin usuario | `route.test.ts` › «401s without an authenticated user, and signs nothing» |
| A1 400 URL ajena/externa/bucket no media | «400s a URL on another host, outside the media buckets, or not a storage URL»; «400s when the project origin is not configured» |
| A1 403 cuenta ajena (incl. la propia del operador en soporte, ruta legada, `..` codificado) | «403s an object of another account — including the operator's own company in a support session»; «403s a user without an effective account» |
| A1 200 en soporte con la cuenta impersonada, TTL, `{url, expiresAt}` | «200s in a support session: signs the impersonated account's object with the service role»; «signs flow-media objects too» |
| A1 fallo de storage | «502s when storage refuses to sign (missing object), without leaking the error» |
| A1 fuga (CP3) | `tenant-isolation.test.ts` › `/api/media/sign (m14.1, …)` › «a support session over A signs A's objects and never B's (the operator's own company)»; «outside a support session, an actor from A cannot sign B's objects» |
| A2 soporte → ruta (con credenciales) | `signed-url.test.ts` › «signs through /api/media/sign with credentials, not the browser client» |
| A2 no soporte → cliente | «outside a support session keeps signing with the browser client» (+ los 6 tests previos, que corren sin `document` → camino de siempre) |
| A2 ruta falla → URL original, sin cachear el fallo | «falls back to the stored URL when the route refuses, without caching the failure»; «falls back when the request itself fails or the body has no URL» |
| A2 caché + in-flight | «caches per object and shares the in-flight request» |
| A2 expiresAt | «never trusts an expiry later than the browser's own clock allows» |
| A2 no-bucket intacto | «leaves non-bucket URLs alone without calling the route» |

## A3 (lectura de código)
Todos los consumidores pasan por `getSignedMediaUrl(url)` sin opciones, así que heredan la detección de soporte por defecto:
- `useMediaBlobUrl` / `useMediaSrc` (`src/hooks/use-media-blob-url.ts` L75) → `MediaImageBubble`, vídeo/audio/documento en `message-media.tsx`, lightbox (`media-lightbox.tsx` L119/L235), Flow builder y preview de plantilla. La renovación usa `msUntilRefresh(expiresAt)`, sin cambios.
- `loadMediaBlob` → `defaultSigner` (`blob-cache.ts` L57) → `getSignedMediaUrl`; `downloadMediaMessage` (`download.ts` L26/L38) usa ambos.
Ningún componente tocado.

## Compuerta (dirigida)
- `npm run lint`: 0 errores (34 warnings preexistentes; ninguno en archivos tocados: `npx eslint` sobre ellos limpio).
- `npm run typecheck`: verde.
- `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks`: 12 archivos, 260 tests verdes. También `src/lib/security src/lib/auth` (654 tests) verde.
- No se corrió `npm test` completo ni `build` (instrucción del líder). Sin SQL → sin replay de migraciones.

## Decisiones (spec ambiguo)
- Orden de comprobaciones: 401 → 400 (parseo/origen/bucket) → 403 (cuenta efectiva + prefijo). El parseo va antes de resolver la cuenta para no gastar consulta en URLs inválidas.
- Sin `NEXT_PUBLIC_SUPABASE_URL` configurada → 400 (si no, `parseStorageObjectUrl` aceptaría cualquier host).
- Además del prefijo exacto, 403 si algún segmento es vacío, `.` o `..` (p. ej. `account-A%2F..%2Faccount-B/x`, que tras decodificar empieza por `account-A`). Rutas legadas `<uid>/…` → 403 (el spec exige `account-<id>`); en soporte esos objetos legados siguen sin verse.
- Usuario sin cuenta efectiva → 403. Fallo de `createSignedUrl` (objeto inexistente, etc.) → 502 genérico sin filtrar el mensaje de storage.
- Respuesta con `Cache-Control: private, no-store`.
- Cliente: `expiresAt = min(expiresAt del servidor, ahora_local + ttl)` para que un reloj de servidor adelantado no retrase la renovación. Fetch con `credentials: 'same-origin'` (misma origen, envía cookies) y `cache: 'no-store'`.
- Detección de soporte: `supportFlagValue(document.cookie)` de `support-cookie.ts` (módulo sin imports) en lugar de importar `supportSessionActive` de `supabase/client.ts`, para no arrastrar el cliente de navegador estáticamente a `signed-url.ts` (que la ruta del servidor importa por `SIGNED_URL_TTL_SECONDS`). Opciones nuevas inyectables: `supportSession` y `fetch`.
- La caché sigue siendo por URL de objeto, sin distinguir modo: una URL firmada vale para cualquiera, así que entrar/salir de soporte no la invalida (comportamiento aceptable; no se cachean fallos).

## Verificación manual pendiente (producción/staging)
1. Como operador de plataforma, abrir sesión de soporte sobre una empresa con imágenes entrantes espejadas en `chat-media`.
2. Bandeja → conversación con imagen: debe verse (no `ImageOff`). DevTools → Red: `GET /api/media/sign?url=…` 200 y la imagen cargada desde `…/object/sign/chat-media/account-<empresa>/…?token=`.
3. Abrir lightbox y descargar: funcionan. Vídeo/audio reproducen.
4. Salir de soporte: en la propia empresa, ninguna petición a `/api/media/sign` (firma el navegador como antes).
5. Middleware: la petición no deja fila en `impersonation_actions` (es GET).

## Variables de entorno
Ninguna nueva.

## Deuda fuera de alcance
- Objetos legados `<uid>/…` (pre-020) siguen sin verse en soporte (la ruta los rechaza por diseño del spec).
- Subir adjuntos/enviar con adjunto en soporte sigue bloqueado (sin cambio).

## Nota
El líder pidió `Co-Authored-By: Claude Fable 5.1`; el commit lleva `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>` según la atribución fijada por el entorno de ejecución. Ajustable con `--amend` si se prefiere la otra.

## Ronda 2 (CHANGES_REQUESTED, cambios 1 y 2)

Commit `e6bdd0c` fix: cierra la fuga por normalización de ruta en /api/media/sign (m14.1), sobre `a0f2372`.

**Cambio 1 — `src/app/api/media/sign/route.ts`.** Nueva `pathBelongsTo(origin, bucket, path, accountId)`, dos capas independientes:
1. `hasUnsafePathChars`: 403 si la ruta decodificada contiene `\`, `%`, `?`, `#`, `< 0x20` o `0x7f` (bucle por carácter, sin regex de control para no chocar con `no-control-regex`). Se optó por lista negra, no blanca: `buildMediaPath` deja la extensión tal cual venga del nombre de archivo, y el espejo entrante puede llevar espacios/acentos en el nombre; una lista blanca estricta podría romper objetos existentes. Ninguno de los nombres generados contiene esos caracteres.
2. Primer segmento exacto `account-<cuenta>` y sin segmentos vacíos/`.`/`..`; luego `new URL(\`${origin}/storage/v1/object/sign/${bucket}/${path}\`)` (la misma forma que interpola storage-js) y se exige `search` y `hash` vacíos, `pathname` que empiece por `/storage/v1/object/sign/<bucket>/account-<cuenta>/` y ningún segmento decodificado vacío/`.`/`..`.

**Cambio 2 — tests.**
- `route.test.ts` › «403s an object of another account…»: añade `TRAVERSALS` (`..%5C…%5C`, `%252e%252e`, `.%09.`, `.%0A.`, `x%3F..%2F..%2F…`, `x%23/../../…`, `%7F`), con `h.signs` vacío.
- `route.test.ts` › nuevo «still signs legitimate names with spaces, accents and dots» (no regresión).
- `tenant-isolation.test.ts` › nuevo «no path form under A's folder reaches B's objects through the service role»: sesión de soporte sobre A, los seis vectores apuntando a B → 403 sin `account-B` en la respuesta, y cero llamadas a `storage.from` del cliente admin (espía sobre el getter `admin` del fake); control positivo: firmar A registra una llamada.
- Prueba de mutación: con la ruta de `a0f2372` fallan los dos `it`; quitando solo la capa 1, el de tenant-isolation sigue en verde gracias a la capa 2 y el de ruta falla por `%7F` → ambas capas son efectivas.

`docs/security.md` amplía el párrafo de la excepción de soporte con esta validación.

**Compuerta dirigida:** lint 0 errores (34 warnings preexistentes; eslint limpio en lo tocado), typecheck verde, `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks` → 12 archivos, 262 tests verdes.

Cambio 3 (otras rutas con el mismo patrón) no tocado: es del líder.

## Ronda 3 (cambios de la sección «Ronda 2» del review)

Commit `b705399` sobre `e6bdd0c`.

1. `src/lib/media/signed-url.ts` `signThroughServer`: el `expiresAt` se calcula solo con el reloj local, `issuedAt + min(expiresIn, ttl) * 1000` (o `issuedAt + ttl` si falta o no es válido). El epoch `expiresAt` del servidor ya no se lee. La ruta (`src/app/api/media/sign/route.ts`) devuelve además `expiresIn: SIGNED_URL_TTL_SECONDS`; `{ url, expiresAt }` del contrato A1 se conserva.
2. `signed-url.test.ts`: nuevo «computes the expiry on the browser clock, ignoring a server clock that runs behind» (cuerpo con `expiresAt = now − 10 min` → `expiresAt = now + TTL`; segunda llamada inmediata desde caché, 1 solo fetch). «never trusts an expiry later than the browser's own clock allows» sustituido por «never trusts a lifetime longer than the TTL, and defaults to it» (expiresIn 86400 → TTL; sin expiresIn → TTL). `route.test.ts` comprueba `expiresIn`.
3. `src/lib/supabase/client.ts` (comentario de `createSignedUrl(s)` en las operaciones de storage de solo lectura): en soporte firma `GET /api/media/sign`; el `createSignedUrl` del navegador queda para fuera de soporte.

Opcional (restringir la ruta a sesiones de soporte): **no aplicado**, anotado como deuda. Motivo: A1 fija `resolveEffectiveAccountId` (cuenta propia fuera de soporte); restringirlo cambia el contrato y los tests de A1/CP3 del caso «fuera de soporte». Es trivial si el líder lo decide: llamar `resolveSupportSession(user.id)` y 403 si es null, usando `support.accountId`.

Compuerta dirigida: lint 0 errores (34 warnings preexistentes; eslint limpio en lo tocado), typecheck verde, `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks src/lib/supabase` → 13 archivos, 306 tests verdes.
