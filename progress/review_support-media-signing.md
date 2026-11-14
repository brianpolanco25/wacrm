# Review — m14.1 support-media-signing

**Veredicto (ronda 1):** CHANGES_REQUESTED — veredicto vigente en «Ronda 3», al final.

Rama `feat/support-media-signing`, commit `a0f2372` sobre main @ 7bc2fd2. Diff coincide con el informe (9 archivos; sin componentes, `messages/`, `package.json` ni SQL tocados).

## Compuerta (dirigida, en el worktree)
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks`: verde (12 archivos, 260 tests)
- replay-migrations: n/a (sin SQL)
- build / `npm test` completo: no corridos (instrucción del líder)

## Trazabilidad criterio ↔ test
- A1 401: [x] `src/app/api/media/sign/route.test.ts` › "401s without an authenticated user, and signs nothing"
- A1 400 origen/bucket/no-storage: [x] › "400s a URL on another host, outside the media buckets, or not a storage URL"; "400s when the project origin is not configured"
- A1 403 cuenta ajena: [ ] parcial — › "403s an object of another account…" cubre prefijo ajeno, legado y `%2F..%2F`, pero NO las variantes que el fetch de storage-js normaliza a `..` (hallazgo 1). El criterio de aislamiento no se cumple.
- A1 200 en soporte con la cuenta impersonada, TTL, `{url, expiresAt}`: [x] › "200s in a support session…", "signs flow-media objects too"
- A1 fuga en tenant-isolation: [ ] parcial — `tenant-isolation.test.ts` › "/api/media/sign (m14.1…)" (2 `it`) solo prueba la URL limpia de B; ninguna URL con traversal.
- A2 soporte → ruta con credenciales: [x] `src/lib/media/signed-url.test.ts` › "signs through /api/media/sign with credentials, not the browser client"
- A2 no soporte → cliente: [x] › "outside a support session keeps signing with the browser client"
- A2 ruta falla → URL original sin cachear fallo: [x] › "falls back to the stored URL when the route refuses…", "falls back when the request itself fails…"
- A2 caché / in-flight / expiresAt: [x] › "caches per object and shares the in-flight request", "never trusts an expiry later than the browser's own clock allows"
- A3 consumidores sin tocar: [x] leído: `use-media-blob-url.ts:75`, `blob-cache.ts:58`, `download.ts:38` llaman `getSignedMediaUrl(url)` sin opciones → heredan `defaultSupportSession`. Renovación por `msUntilRefresh(expiresAt)` intacta.
- A4 docs/CHANGELOG: [x] nota al pie fechada en `impl_impersonation-audit.md`, punto 3 de `impl_impersonation-write.md`, `docs/security.md`, cabecera de `signed-url.ts`, `CHANGELOG.md`.

## Checkpoints
- Aislamiento (rol de servicio acotado a la cuenta + test de fuga): [ ] — bypass del prefijo (hallazgo 1)
- Migraciones: n/a
- Sin dependencias nuevas: [x]
- i18n: n/a (sin claves nuevas)
- Next 16: [x] route handler `GET(request: Request)` estándar; usa cookies → dinámica
- Middleware de soporte: [x] `supportWriteVerdict` devuelve `'pass'` para GET (`src/lib/auth/support-scope.ts:247`); el matcher `/api/:path*` la cubre
- Bundle: [x] `signed-url.ts` solo importa estáticamente `support-cookie.ts` (sin imports) y `storage-url.ts`; el cliente de navegador sigue en `import()` dinámico dentro de `defaultClient`
- Alcance: [x]
- Skill `code-review high`: no corrido — el hallazgo 1 ya bloquea; correrlo en la re-revisión.

## Hallazgos (archivo:línea)
1. **Bloqueante, fuga entre cuentas.** `src/app/api/media/sign/route.ts:58-66` — el check de segmentos se hace sobre `ref.path` ya decodificado, pero `storage-js` (`createSignedUrl` → `post(\`${url}/object/sign/${bucket}/${path}\`)`, sin codificar; `node_modules/@supabase/storage-js/dist/index.cjs:1043-1045,1528`) pasa la ruta al parser WHATWG de `fetch`, que normaliza después del check. Comprobado con `new URL(...)` en Node:
   - `…/chat-media/account-A/..%5Caccount-B%5Csecret.png` → `ref.path = "account-A/..\account-B\secret.png"` (segmentos `account-A`, `..\account-B\secret.png`: pasa) → fetch a `/object/sign/chat-media/account-B/secret.png`.
   - `…/account-A/%252e%252e/account-B/s.png` → `ref.path` con segmento `%2e%2e` (pasa) → normalizado a `..` → `account-B/s.png`.
   - Segmento `.%09.` (tab/LF, que WHATWG elimina) → `..` → `account-B/…`.
   Un usuario de A (o un operador en soporte sobre A) obtiene con el rol de servicio una URL firmada de cualquier objeto de B (y con dos `..` hasta de otro bucket).
2. `src/lib/security/tenant-isolation.test.ts:6256-6312` y `src/app/api/media/sign/route.test.ts` (it "403s an object of another account…") — no hay casos para `%5C`, `%252e%252e`, `%09`/`%0A`, `%3F`/`%23` en el path; por eso la fuga del hallazgo 1 pasa verde.

## Cambios requeridos
1. En `route.ts`, validar la ruta **en la forma que verá storage**, no solo la decodificada. Opción robusta: tras el check actual, construir `new URL(\`${origin}/storage/v1/object/sign/${ref.bucket}/${ref.path}\`)` y exigir que su `pathname` sea exactamente `/storage/v1/object/sign/${ref.bucket}/account-${accountId}/…` y que ningún segmento de ese pathname, decodificado, sea `.`/`..`; y además rechazar (403) cualquier `ref.path` con `\`, `%`, caracteres de control (`< 0x20`, `0x7f`), `?` o `#`. Lo más simple que cierra todo: lista blanca de caracteres por segmento compatible con los nombres que genera el upload real (comprobarlo contra el código de subida antes de fijarla).
2. Añadir esos vectores (`..%5C`, `%252e%252e`, `.%09.`, `%0A`, `%3F..%2F`, `%23`) al `it` de 403 en `route.test.ts` **y** al describe de `tenant-isolation.test.ts` (A no firma B con ninguno de ellos; `h.signs`/admin sin llamadas).
3. Nota para el líder (fuera de alcance de m14.1, no bloquea esta feature): otras rutas que validan una `media_url` con `parseStorageObjectUrl`/`accountIdFromPath` y luego usan `supabaseAdmin().storage` (p. ej. el envío saliente que descarga el objeto, test `tenant-isolation.test.ts:1586`) probablemente tienen el mismo bypass por normalización; conviene un `security_auditor` sobre ellas.

---

## Ronda 2 — `e6bdd0c` (sobre `a0f2372`)

**Veredicto:** CHANGES_REQUESTED

### Compuerta (dirigida, en el worktree)
- lint: verde (0 errores, 34 warnings preexistentes) · typecheck: verde
- `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks`: verde (12 archivos, 262 tests)
- replay-migrations: n/a

### Cambios 1 y 2 de la ronda 1: resueltos
- `pathBelongsTo` (`src/app/api/media/sign/route.ts:31-70`): rechaza `\ % ? #` y caracteres de control en la ruta decodificada, y además vuelve a parsear con `new URL` la misma forma que construye storage-js.
- Ataque por mi cuenta: vitest temporal fuera del árbol, ya borrado, sobre la `pathBelongsTo` real del commit y `parseStorageObjectUrl`. Resultado: ningún vector deja una URL de fetch fuera de `/chat-media/account-A/`. Probé fullwidth `%EF%BC%8E%EF%BC%8E`, `%EF%BC%BC`, `%E2%80%A4`, `%E3%80%82` y `%C0%AE%C0%AE` (que da `URIError` y luego 400). También `/./`, `//`, `%2E%2E`, `%2e.`, `%20..`, `..%20`, `..;`, `%3B..`, `x/..%2F..%2F`, `account-A%2Fx`, `account-AB/…` y `ACCOUNT-A/…`. Los que pasan se quedan dentro de `account-A/` como claves literales. Los que traversan dan 403 en la capa 1 o en la 2.
- Nombres legítimos: `route.test.ts` › "still signs legitimate names with spaces, accents and dots" pasa, y yo comprobé `foto%20de%20perfil%20(1).jpg` y `ni%C3%B1o.caf%C3%A9.v2.png`. `buildMediaPath` (`src/lib/storage/upload-media.ts:67-71`) limpia la base a `[a-zA-Z0-9_-]`. El espejo entrante usa `buildMediaPath(…, 'inbound')`.
- Tests de fuga: `route.test.ts` › `TRAVERSALS` dentro de "403s an object of another account…". `tenant-isolation.test.ts` › "no path form under A's folder reaches B's objects through the service role" espía `storage.from` del admin: cero llamadas con vectores y una con el control positivo. Los leí: prueban lo que dicen.

### `code-review high` sobre `7bc2fd2..e6bdd0c`, contrastado
Confirmados a mano:
1. **Bloqueante, nuevo en esta rama: bucle de renovación por desfase de reloj.** Está en `src/lib/media/signed-url.ts:104-108` (`signThroughServer`): `expiresAt = Math.min(body.expiresAt, issuedAt + ttlMs)` mezcla el reloj del servidor con el del navegador.
   - Si el reloj del navegador va por delante del servidor más de TTL − margen (600 s − 60 s = 9 min), `expiresAt` cae ya dentro del margen.
   - Consecuencia en la caché (`:146`): nunca se reutiliza.
   - Consecuencia en el hook: `msUntilRefresh` (`:212`) devuelve el suelo de 1 s y `use-media-blob-url.ts:81-85` vuelve a firmar cada segundo por cada adjunto montado. Cada vuelta cuesta `getUser`, la consulta de sesión de soporte y una firma con rol de servicio.
   - Con desfases menores no hay bucle, pero las renovaciones se adelantan en la misma proporción.
   - El camino del navegador no lo sufre, porque solo usa `issuedAt + ttl` local. La firma de Storage es relativa: la valida su propio reloj.
2. Menor, A4: comentario obsoleto en `src/lib/supabase/client.ts:61-62`, «`createSignedUrl(s)` … is how this panel resolves every attachment». En soporte ya no es así. La afirmación equivalente de `057_support_session_reads.sql` está en una migración aplicada: no se toca, basta la corrección en docs.

Descartados o no bloqueantes, como recomendación:
- Restringir la ruta a sesiones de soporte (403 si `resolveSupportSession` es nulo). A1 no lo exige, porque usa la cuenta efectiva, que también cubre al usuario normal. Pero reduciría la superficie del rol de servicio a los operadores, con poco coste. Recomendado, no exigido.
- Rate limit, endpoint por lotes (`createSignedUrls`) y caché negativa para 4xx: optimizaciones; no bloquean.
- Extensiones con `%?#\` en subidas antiguas (`buildMediaPath` no limpia la extensión): darían 403 en soporte. Es un caso marginal y queda como deuda.
- Caché de URLs firmadas tras salir de soporte: una URL firmada es un token portador válido 10 min de todos modos. No cambia la exposición.
- Duplicación de la comprobación de prefijo en `pathBelongsTo`: es defensa en profundidad intencionada y la prueba de mutación del informe demuestra que ambas capas actúan. Se acepta.

### Checkpoints (ronda 2)
- Aislamiento con rol de servicio + test de fuga: [x]
- Sin dependencias nuevas: [x] · Next 16: [x] · Middleware (GET → pass): [x] · Bundle de servidor sin cliente de navegador: [x] · Alcance: [x]
- Comportamiento correcto bajo la renovación (A2 «expiresAt y renovación se conservan»): [ ] (hallazgo 1)

### Cambios requeridos (ronda 2)
1. `src/lib/media/signed-url.ts:104-108`: calcular `expiresAt` solo con el reloj local, `issuedAt + ttlMs`, como el camino del navegador. Opción: que la ruta devuelva `expiresIn` (segundos) y usar `issuedAt + min(expiresIn, ttl) * 1000`. No comparar el epoch del servidor con `now()` del navegador.
2. `src/lib/media/signed-url.test.ts`: test con el servidor atrasado. Por ejemplo, `expiresAt` del cuerpo = `now − 10 min`: debe dar `expiresAt = now + TTL`, y una segunda llamada inmediata se sirve de caché, sin fetch. Ajustar "never trusts an expiry later than the browser's own clock allows" si cambia el contrato.
3. `src/lib/supabase/client.ts:61-62`: corregir el comentario. En soporte las firmas las hace `GET /api/media/sign`, y `createSignedUrl` del navegador queda para fuera de soporte.

---

## Ronda 3 — `b705399` (sobre `e6bdd0c`)

**Veredicto:** APPROVED

### Compuerta (dirigida, en el worktree)
- lint: verde (0 errores, 34 warnings preexistentes) · typecheck: verde
- `TZ=UTC npx vitest run src/app/api/media src/lib/media src/lib/security/tenant-isolation.test.ts src/hooks`: verde (12 archivos, 263 tests)
- replay-migrations: n/a

### Cambios de la ronda 2
1. [x] `src/lib/media/signed-url.ts:106-116`: `signThroughServer` ya no lee el `expiresAt` del servidor. Calcula `issuedAt + min(expiresIn·1000, ttlMs)`, y sin `expiresIn` válido usa `ttlMs`. `issuedAt` es `now()` local, tomado antes del fetch (`:163`). En el archivo ya no hay ninguna comparación entre un epoch del servidor y `now()`. Las únicas restas contra `now()` son de entradas calculadas en local (`:149`, `:215`).
   - Caché e in-flight: la entrada se guarda en `cache` (`:168`) y la promesa compartida no cambia, así que la segunda llamada se sirve de caché.
   - Renovación: `use-media-blob-url.ts:81-85` → `msUntilRefresh(expiresAt)` = `TTL − 60 s` en reloj local (540 s).
2. [x] `signed-url.test.ts` › "computes the expiry on the browser clock, ignoring a server clock that runs behind": servidor 10 min atrasado → `expiresAt = NOW + TTL`, y la segunda llamada se sirve de caché (`calls` = 1). › "never trusts a lifetime longer than the TTL, and defaults to it": tope en el TTL, y vuelve al TTL si falta `expiresIn`. `route.test.ts` comprueba `expiresIn === SIGNED_URL_TTL_SECONDS`.
3. [x] `src/lib/supabase/client.ts:61-65`: comentario corregido.

### Checkpoints (final)
- Aislamiento con rol de servicio + tests de fuga (incluida la normalización de ruta): [x]
- Trazabilidad A1–A4: [x] (ver rondas 1–3)
- Sin dependencias nuevas, sin SQL, sin i18n: [x]
- Next 16 route handler · middleware GET → pass · bundle de servidor sin cliente de navegador · alcance: [x]
- Renovación y caché de A2 correctas bajo desfase de reloj: [x]

### Deuda anotada (no bloquea)
- Restringir `/api/media/sign` a sesiones de soporte (403 si `resolveSupportSession` es nulo) reduciría la superficie del rol de servicio. Anotado en el informe.
- Rate limit, endpoint por lotes (`createSignedUrls`) y caché negativa para 4xx.
- Objetos legados `<uid>/…` y extensiones con `%?#\` siguen rotos en soporte.
- El campo `expiresAt` de la respuesta de la ruta ya no lo usa el cliente; se puede retirar.
- Pendiente la verificación manual en staging, con el guion de `progress/impl_support-media-signing.md`.
