# s9.8 `invite-accept` — informe del implementer

## Plan
1. Investigar formatos de enlace de Supabase Auth (PKCE `code`, `token_hash`+`type`, fragmento implícito) en `@supabase/ssr` 0.12 / `auth-js` 2.108.
2. `src/lib/auth/redirects.ts`: `authCallbackUrl(origin, { next, invite })`, `safeNextPath`, `callbackDestination`.
3. `src/lib/auth/callback.ts`: `resolveCallback(params, auth)` (servidor) + `completeAuthCallback` (cliente: fragmento, error, sesión ya abierta).
4. Route handler `src/app/(auth)/auth/callback/route.ts` y página cliente `src/app/(auth)/auth/callback/complete/page.tsx`.
5. `src/lib/auth/reset-password.ts` (`submitNewPassword`) y página `src/app/(auth)/reset-password/page.tsx`.
6. `forgot-password` y `signup` usan `authCallbackUrl`.
7. Middleware: tests de que `/auth/callback*` y `/reset-password` no redirigen a quien tiene sesión.
8. i18n `AuthCallback` y `ResetPassword` (es/en/ko), `docs/docker.md`, `CHANGELOG.md`.
9. Compuerta y commits.

## Estado: done (pendiente de reviewer)

Rama `platform/invite-accept` (worktree `.claude/worktrees/invite-accept`), base `feat/superadmin` @ 22cba4b. Sin push. Sin migración.

| Commit | Qué |
|---|---|
| `ac076e3` | feat: `src/lib/auth/{redirects,callback,reset-password}.ts` (+ tests), `src/app/(auth)/auth/callback/route.ts` (+ test), `src/app/(auth)/auth/callback/complete/page.tsx` (+ test), `src/app/(auth)/reset-password/page.tsx` (+ test), i18n `AuthCallback`/`ResetPassword` es/en/ko, comentario + tests en `src/middleware.ts`/`.test.ts`, regla `/auth/:path*` en `next.config.ts` + `src/next-config-auth.test.ts` |
| `271b6eb` | fix: `forgot-password` y `signup` usan `authCallbackUrl()` |
| `8c3ba29` | docs: `docs/docker.md` §«Auth email links» y `CHANGELOG.md` (al final del bloque Unreleased) |

## Compuerta (worktree, HEAD 8c3ba29)
- `npm run lint`: 0 errores, 35 warnings (las preexistentes; la de `src/middleware.ts:72` `options` sin usar ya estaba).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 226 archivos, **3036 tests** verdes.
- `npm run build` con variables dummy: verde; aparecen `ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`.
- Sin SQL: no aplica `replay-migrations.sh`.
- Comprobado contra el build de producción (`next start` con variables dummy, `curl -D -`): `/auth/callback?next=…` → 307 a `/auth/callback/complete?next=…` con `Cache-Control: private, no-store`; `?error=…&error_code=otp_expired` → 307 a `/auth/callback/complete?error_code=otp_expired`; `/auth/callback/complete` 200 `private, no-store`; `/reset-password` 200 (página estática sin datos, conserva el `public, s-maxage=300` del catch-all).

## Investigación: qué formato llega en cada caso
Leído en `node_modules/@supabase/auth-js` 2.108.2 (`GoTrueClient.js`: `_initialize`, `_getSessionFromURL`, `_isPKCECallback`, `_exchangeCodeForSession`, `verifyOtp`, `setSession`, `resetPasswordForEmail`) y `@supabase/ssr` 0.12.0 (`createBrowserClient`/`createServerClient` fijan `flowType: 'pkce'`; el navegador con `detectSessionInUrl: true`, el servidor `false`).

| Correo | Plantilla por defecto (`{{ .ConfirmationURL }}`) | Plantilla con `{{ .TokenHash }}` |
|---|---|---|
| Invitación (`auth.admin.inviteUserByEmail`, s9.4 y miembros) | Sin PKCE posible (se crea en el servidor, no hay verificador): GoTrue redirige a `redirect_to#access_token=…&refresh_token=…&expires_in=…&token_type=bearer&type=invite`. El servidor no ve el fragmento. | `…/auth/callback?next=…&token_hash=…&type=invite` → `verifyOtp` en el servidor. |
| Recuperación (`resetPasswordForEmail` desde `/forgot-password`, cliente PKCE) | `redirect_to?code=…`; el verificador vive en la cookie `sb-<ref>-auth-token-code-verifier` con sufijo `/PASSWORD_RECOVERY`, así que `exchangeCodeForSession` devuelve `redirectType: 'recovery'`. Solo funciona en el mismo navegador. | `…&token_hash=…&type=recovery` → `verifyOtp`, cualquier navegador. |
| Alta (`signUp` desde `/signup`, PKCE) | `redirect_to?code=…` (mismo navegador). | Se recomienda dejar la plantilla por defecto (ver decisiones). |
| Errores (enlace caducado/usado) | PKCE: `?error=…&error_code=otp_expired&error_description=…` en la query; implícito: lo mismo en el fragmento. | `verifyOtp` devuelve `error.code` (`otp_expired`). |

Dato clave: el cliente de navegador (PKCE) ve `#access_token` al inicializarse, lo clasifica como `implicit` y falla con `AuthPKCEGrantCodeExchangeError: Not a valid PKCE flow url` **sin guardar la sesión** (lo confirma el hallazgo de s9.4). Por eso la página cliente llama a `setSession({ access_token, refresh_token })` explícitamente, que no depende de `flowType`.

**Se soportan los tres formatos**: `code` y `token_hash` en el servidor (route handler), fragmento en el cliente como respaldo.

## Diseño
- `GET /auth/callback` (`src/app/(auth)/auth/callback/route.ts`): cliente SSR de `@/lib/supabase/server` (escribe cookies con `cookies()`, permitido en route handlers según `next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`). Lógica en `resolveCallback()` (`src/lib/auth/callback.ts`):
  - error en la query → `/auth/callback/complete?error_code=…` (sin llamar a Supabase);
  - `token_hash` + `type` válido (`signup|invite|magiclink|recovery|email_change|email`) → `verifyOtp`; tipo desconocido → error `invalid` sin llamar;
  - `code` → `exchangeCodeForSession`, `redirectType` como tipo;
  - nada → `/auth/callback/complete?next&invite`: el navegador conserva el fragmento al seguir un 307 cuyo `Location` no trae uno (estándar Fetch), así que `#access_token=…` llega a la página cliente.
  - La redirección se hace sobre `request.nextUrl.clone()` (mismo host que la petición, como el middleware), porque las cookies recién escritas son de ese host.
- `/auth/callback/complete` (cliente): `completeAuthCallback()` — error en query o fragmento → mensaje; tokens → `setSession`; sin tokens pero con sesión abierta (enlace abierto dos veces) → sigue; nada → «este enlace no trae sesión». Borra el fragmento del historial con `history.replaceState` antes de nada y navega con `window.location.replace` (recarga completa, como `/login`, issue #365).
- Destino (`callbackDestination()` en `src/lib/auth/redirects.ts`): `type` `invite`/`recovery` → `/reset-password` (con `?invite=` y, para `invite`, `?welcome=1` que solo cambia el texto) aunque `next` diga otra cosa; si no, `next` seguro (misma origen: rechaza `//x`, `/\x`, absolutas, caracteres de control); si no, `?invite=` → `/join/<token>`; si no, servidor → `/dashboard`, cliente → `postLoginDestination()` (operador → `/platform`).
- `/reset-password` (cliente, `AuthCard` dentro de `AuthShell`, mismos tokens `--cb-*` y campos que `/login`): `getUser()` al montar; sin sesión → «Tu enlace caducó» + botón a `/forgot-password`; `submitNewPassword()` (`src/lib/auth/reset-password.ts`): coincidencia y mínimo 6 (como `signup`) antes de enviar, `updateUser({ password })`, errores `same_password`/`weak_password`/sesión ausente mapeados, y destino `postLoginDestination(invite)`.
- Middleware: `/auth/callback*` y `/reset-password` no estaban en la lista de páginas de auth (`/login`, `/signup`, `/forgot-password`) ni en `protectedPaths`, así que ya pasaban; se añade un comentario de 4 líneas propias sobre esa lista (no se toca `supportSessionBlocks`/`SUPPORT_SESSION_EXEMPT`) y tests que lo fijan con y sin sesión.
- `next.config.ts`: regla `source: '/auth/:path*'` → `Cache-Control: private, no-store` después del catch-all. Motivo: el catch-all pisa el header que pone la ruta (lo comprobé con `next start`: salía `public, s-maxage=300` en un 307 que lleva `Set-Cookie` con la sesión).

## Criterio ↔ test
| Criterio | Test |
|---|---|
| Callback con `code` | `src/lib/auth/callback.test.ts` › «exchanges a PKCE code and goes to the default place», «a recovery code (redirectType) goes to /reset-password», «a sign-up code with ?invite= goes to /join/<token>»; `src/app/(auth)/auth/callback/route.test.ts` › «code → exchanged, 307 to the dashboard, private» |
| Callback con `token_hash` | `callback.test.ts` › «verifies a token_hash invite and goes to /reset-password», «verifies a token_hash recovery», «a token_hash signup / email lands on the safe next or the default», «refuses a token_hash with an unknown type without calling Supabase»; `route.test.ts` › «token_hash invite → /reset-password carrying the invite» |
| Callback sin nada → rama cliente con fragmento | `callback.test.ts` › «nothing in the query → the browser page (the fragment rides along)», «opens the session from the fragment and sends an invite to /reset-password», «a fragment recovery also goes to /reset-password», «a fragment magic link without next asks postLoginDestination (operator → /platform)», `parseAuthFragment` ›*; `route.test.ts` › «nothing → the browser page, which will read the fragment» |
| Callback con error (caducado/usado/otro navegador) | `callback.test.ts` › «an expired token_hash goes to the error page, keeping next/invite», «a code without its verifier (other browser) goes to the error page», «an error Supabase put in the query is forwarded without any call», «an error in the fragment (expired link) → expired, no session call», «an error the server forwarded in the query wins over everything», «setSession refusing the tokens → error», `callbackErrorReason` ›*; `route.test.ts` › «expired link → the browser page with the error» |
| Sesión ya abierta | `callback.test.ts` › «no fragment but a session already open → carries on»; «nothing at all and no session → missing» |
| `next` no sale del sitio | `redirects.test.ts` › `safeNextPath` › «refuses %s»; `route.test.ts` › «an absolute next never leaves the host» |
| `redirectTo` compartido | `redirects.test.ts` › `authCallbackUrl` ›* (alta, recuperación/propietario, miembro con invite, next externo) |
| Reset sin sesión | `reset-password.test.ts` › «no session → noSession (the page then offers a new link)», «GoTrue session_not_found → noSession» |
| Reset con contraseñas distintas / cortas | «different passwords: nothing is sent», «too short: nothing is sent», `validateNewPassword` › «mismatch first, then length» |
| Éxito con cada destino | «success with an invite → /join/<token>, without asking about operators», «success as an operator → /platform», «success as anyone else → /dashboard» |
| Conservar `?invite=` callback → reset → join | `redirects.test.ts` › «invite keeps ?invite= for the join step afterwards», «next=/reset-password also gets the invite»; `callback.test.ts` (fragmento con invite) ; `reset-password.test.ts` (invite → /join) |
| Middleware no redirige `/auth/callback*` ni `/reset-password` | `src/middleware.test.ts` › «middleware — /auth/callback y /reset-password (s9.8)» (con sesión, sin sesión, y `/forgot-password` sigue redirigiendo) |
| No cacheable | `src/next-config-auth.test.ts` › «%s is private, no-store», «leaves the rest of the app as it was»; `route.test.ts` (header del 307) |
| i18n es/en/ko en paridad | `src/i18n/messages.test.ts` (paridad y placeholders, global); `src/app/(auth)/reset-password/page.test.tsx` › «%s: renders the session check first», «%s: every error and label formats»; `src/app/(auth)/auth/callback/complete/page.test.tsx` › «%s: renders the waiting state», «%s: a sentence for every failure» |

Sin jsdom ni testing-library en el repo (no se añaden): el comportamiento de las páginas se prueba en las funciones puras que llaman (`completeAuthCallback`, `submitNewPassword`), y las páginas con `renderToStaticMarkup` (primer estado + catálogos). El cambio de `forgot-password`/`signup` es una llamada a `authCallbackUrl` (probada); sin test de página propio.

## Verificación manual pendiente (guion; requiere Supabase con SMTP y las Redirect URLs dadas de alta)
1. Supabase → Auth → URL Configuration: Site URL = origen; Redirect URLs `<origen>/auth/callback**`, `<origen>/join/**`.
2. **Recuperación (plantilla por defecto)**: `/forgot-password` → correo → abrir en el mismo navegador → llega a `/auth/callback?code=…` → `/reset-password` («Nueva contraseña») → guardar → `/dashboard` (o `/platform` si es operador). Iniciar sesión con la nueva contraseña.
3. Repetir abriendo el enlace en **otro navegador** → «Abre el enlace en el mismo navegador…» con botón a `/forgot-password`.
4. Abrir el mismo enlace una segunda vez → «caducó o ya se usó».
5. **Invitación de propietario (s9.4, plantilla por defecto)**, tras integrar s9.4 con el cambio de abajo: crear empresa → correo → `/auth/callback?next=%2Freset-password#access_token=…&type=invite` → `/auth/callback/complete` → `/reset-password?welcome=1` («Elige tu contraseña») → `/dashboard`. Comprobar que la barra de direcciones ya no muestra `#access_token`.
6. **Miembro invitado por correo**: → `/reset-password?invite=<token>&welcome=1` → guardar → `/join/<token>` → Aceptar.
7. **Plantilla `{{ .TokenHash }}`** en «Invite user» y «Reset password» (ver `docs/docker.md`): repetir 2 y 5; el enlace va directo a `/auth/callback?…&token_hash=…&type=invite|recovery` y funciona en cualquier navegador.
8. `/reset-password` sin sesión (ventana privada) → «Tu enlace caducó».
9. Alta nueva desde `/signup?invite=<token>` → correo de confirmación → `/auth/callback?invite=<token>&code=…` → `/join/<token>`.

## Integración con s9.4 (el líder)
En `platform/provisioning` @ 71bb414 hay que cambiar dos `redirectTo` para que usen `authCallbackUrl` de `@/lib/auth/redirects`:
- `src/app/api/platform/accounts/route.ts:212`
  `redirectTo: \`${resolveAppOrigin(request)}/login\`,`
  → `redirectTo: authCallbackUrl(resolveAppOrigin(request), { next: RESET_PASSWORD_PATH }),`
- `src/app/api/platform/accounts/[id]/members/route.ts:174`
  `const invited = await inviteAuthUser({ email, redirectTo: url });` (con `url = inviteUrl(token, …)` → `/join/<token>`)
  → `redirectTo: authCallbackUrl(resolveAppOrigin(request), { next: RESET_PASSWORD_PATH, invite: token })`. La variable `url` sigue sirviendo para el enlace que se devuelve a la UI (usuario existente).
- Conflicto de merge esperable en `next.config.ts`: s9.4 añade la regla `/platform/:path*` y esta rama `/auth/:path*`, ambas en el mismo hueco (después del catch-all, antes de las cabeceras de seguridad). Resolver quedándose con las dos. `messages/*.json`: ambas añaden namespaces al final → conservar los dos.
- El «Añadir miembro» de la pestaña Equipo (fase 0) no envía correo de Supabase (genera enlace para copiar), así que no hay otro `redirectTo` que cambiar en esta rama.

## Decisiones donde el spec era ambiguo
- **Route handler + página cliente en ruta hija** (`/auth/callback` y `/auth/callback/complete`): Next no permite `route.ts` y `page.tsx` en el mismo segmento, y fijar cookies exige route handler o Server Function. El salto conserva el fragmento.
- **El `type` del enlace manda sobre `next`**: invite/recovery siempre pasan por `/reset-password`, porque sin contraseña no podrán volver a entrar.
- **Destino por defecto en el servidor = `/dashboard`** (no se consulta `platform_admins` desde el callback; un operador que confirma un alta por `code` cae en el CRM, a un clic del panel). En el cliente sí se usa `postLoginDestination`.
- **`?welcome=1`** solo cambia el título («Elige tu contraseña» frente a «Nueva contraseña»); también cuando hay `?invite=`.
- **Plantilla token-hash recomendada solo para Invite y Reset**: `{{ .RedirectTo }}&token_hash=…` necesita que el `redirectTo` ya lleve query, y la app siempre la pone en esos dos correos; el alta sin invitación no la lleva, así que se deja con la plantilla por defecto (PKCE).
- **`/join/**` en las Redirect URLs**: para invitaciones enviadas antes de este cambio (que apuntaban directo a `/join/<token>`).
- **Mínimo 6 caracteres**, como `signup` y el mínimo por defecto de Supabase (`MIN_PASSWORD_LENGTH`).
- **`next.config.ts`** estaba fuera de la lista literal de la tarea, pero sin esa regla el `Cache-Control` de la ruta no servía (comprobado); cabe en el alcance del callback.

## Variables de entorno nuevas
Ninguna. `.env.local.example` no se toca.

## Deuda detectada fuera de alcance (no arreglada)
- `forgot-password` y `signup` tienen todos sus textos en inglés fijo (sin `next-intl`), igual que `/join/[token]`: incumplen CP6 desde antes. Solo se cambió su `redirectTo`.
- `/join/[token]` sigue sin leer un fragmento de sesión: una invitación de miembro enviada **antes** de integrar el cambio de s9.4 llega allí con `#access_token` y sin sesión. Tras integrar, los correos nuevos pasan por `/auth/callback`.
- La confirmación de alta por `code` en otro navegador falla (limitación de PKCE): el correo queda confirmado igualmente en GoTrue y el mensaje invita a pedir enlace nuevo; podría ofrecer también «iniciar sesión».
- `src/middleware.ts` es el nombre antiguo (Next 16 lo llama `proxy.ts`); no se migra aquí.

## Segunda ronda (tras `review_invite-accept.md`, CHANGES_REQUESTED)

HEAD `4057287`. Commits nuevos:

| Commit | Qué |
|---|---|
| `429e948` | fix: open redirect de `?next=` cerrado; `complete/page.tsx` lee la URL una sola vez; tests nuevos |
| `4057287` | docs: límites de la plantilla token-hash en `docs/docker.md` |

### Cambios
1. **Open redirect (bloqueante).** `src/lib/auth/redirects.ts`: nueva `isSameOriginPath(path)` que valida el destino **final**: empieza por exactamente una `/` no seguida de `/` ni `\`, sin `\` ni caracteres de control, la misma forma también tras `decodeURIComponent` del path (rechaza `/%2F%2Fevil`, `/%5Cevil`), resuelve al mismo origen y es idempotente al normalizar (`new URL` no le cambia nada: no queda `.`/`..` que colapse después). `safeNextPath` rechaza `\` y control en la entrada (antes de que `new URL` los «arregle»), normaliza, y valida el resultado con `isSameOriginPath`. `callbackDestination` pasa todo lo que construye (reset con invite, `next`, `/join/<invite>`) por `isSameOriginPath`. Además:
   - `resolveCallback` ya no reenvía un `next` inseguro a `/auth/callback/complete` (lo descarta en el servidor).
   - `route.ts` vuelve a comprobar el destino con `isSameOriginPath` (si no, `/dashboard`) y construye la URL sobre `request.nextUrl.origin`.
   - `complete/page.tsx` comprueba `isSameOriginPath(result.destination)` antes de `window.location.replace` (si no, `/dashboard`).
   - `invite` solo se usa como valor de query (`URLSearchParams`) o como segmento con `encodeURIComponent`, y el resultado pasa por la misma comprobación final.
2. **Tokens en la query**: test «tokens in the QUERY are never used (only the fragment counts)» (`setSession` no se llama; sin sesión → `missing`).
3. **StrictMode**: `complete/page.tsx` usa un `useRef` para ejecutar el canje una sola vez por carga y no cancela la primera pasada (StrictMode conserva el estado, así que su `setReason` llega). La segunda pasada ya no encuentra el hash borrado ni pierde el `type`.
4. **Docs**: `docs/docker.md` §«Auth email links» dice que la plantilla `{{ .TokenHash }}` solo sirve cuando el `redirectTo` de la app lleva query (recuperación desde `/forgot-password` ya; invitaciones cuando s9.4 use `authCallbackUrl()`) y que **no** vale para correos lanzados desde el panel de Supabase (su `{{ .RedirectTo }}` es la Site URL sin query), ni con un `redirectTo` rechazado.

### Tests nuevos
- `src/lib/auth/redirects.test.ts`: `safeNextPath` › «refuses %s (after normalising)» con `//evil.com`, `/\evil.com`, `https://evil.com`, `/.//evil.com`, `/..//evil.com`, `/%2e//evil.com`, `/%2E%2E//evil.com`, `/a/..//evil.com`; «refuses a percent-encoded double slash in the path»; «still keeps legitimate dot segments that stay on the site»; `isSameOriginPath` › «accepts %s» / «refuses %s»; `callbackDestination` › «ignores next=%s» (y con invite → `/join/tok`).
- `src/app/(auth)/auth/callback/route.test.ts`: «code + next=%s → /dashboard on this host» y «no code + next=%s → the browser page WITHOUT that next» con `//evil.com`, `https://evil.com`, `/\evil.com`, `%2F%2Fevil.com`, `/%2F%2Fevil.com`, `/.//evil.com`, `/..//evil.com`, `/%2e//evil.com`, `/a/..//evil.com` (codificados en la query).
- `src/lib/auth/callback.test.ts`: «never leaves the site with next=%s» (lo que decide la página `complete`, con sesión abierta y con tokens en el fragmento → `/dashboard`); «tokens in the QUERY are never used…»; `resolveCallback — forwarding drops an unsafe next`.
- La página `complete` no se ejecuta en tests (no hay jsdom); su decisión es `completeAuthCallback` + la comprobación `isSameOriginPath` antes de navegar.

### Compuerta (HEAD 4057287)
- lint: 0 errores, 35 warnings preexistentes.
- typecheck: verde.
- `TZ=UTC npm test`: 226 archivos, **3095 tests** verdes.
- build con variables dummy: verde (`ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`).
- `next start -H 127.0.0.1` + `curl -I` (solo localhost, sin `code` para que la ruta no llame a Supabase; sin cookies, así que el middleware no sale a la red): `?next=/.//evil.com`, `/..//evil.com`, `/%2e//evil.com`, `//evil.com`, `/a/..//evil.com` → 307 `http://localhost:3917/auth/callback/complete` (sin `next`), `Cache-Control: private, no-store`; `?next=/reset-password` → `…/complete?next=%2Freset-password`.

### Deuda añadida
- **Login CSRF por fragmento** (inherente al flujo implícito): `/auth/callback/complete` acepta cualquier par de tokens válidos del fragmento y sustituye la sesión abierta sin avisar; un atacante puede enviar un enlace con los tokens de SU cuenta y dejar a la víctima trabajando dentro de ella. El `detectSessionInUrl` del SDK hace lo mismo. La plantilla token-hash lo reduce (los tokens no viajan en la URL). Mejora posible: si ya hay sesión de otro usuario, pedir confirmación antes de `setSession`.
- `/reset-password` sigue con `public, s-maxage=300` del catch-all: página estática sin datos del usuario; no filtra nada (hallazgo 5, no aplicado).
- El catch-all público también cubre respuestas del middleware con `Set-Cookie` rotado (preexistente, fuera de alcance).

## Tercera ronda (hallazgo nuevo de la segunda revisión: `Location` con el host de escucha)

HEAD `2214d8d` (commit `fix: /auth/callback responde con Location relativo`).

### Cambio
- `src/app/(auth)/auth/callback/route.ts`: la respuesta se construye a mano, `new NextResponse(null, { status: 307, headers: { Location: <ruta relativa>, 'Cache-Control': 'private, no-store' } })`. La ruta relativa ya pasó por `isSameOriginPath`; si no la pasa, se usa `/dashboard`. `NextResponse.redirect` no sirve: pasa la URL por `validateURL`, que exige una absoluta (`node_modules/next/dist/server/web/spec-extension/response.js:109`). Con la ruta relativa no se confía en `Host` ni en `X-Forwarded-*`: el navegador la resuelve contra la dirección real y conserva el fragmento. Las cookies escritas con `cookies()` las sigue fusionando Next en la respuesta que devuelve el handler. El comentario ya no dice «el mismo host, como el middleware».
- Revisé `complete/page.tsx` y `reset-password/page.tsx`: solo navegan a rutas relativas (`window.location.replace(dest)` y `window.location.href = dest`, con `dest` en `/…`). Ninguna construye URLs absolutas.

### Tests
- `src/app/(auth)/auth/callback/route.test.ts`: todas las aserciones de `location` esperan ahora rutas relativas (`/dashboard`, `/reset-password?invite=tok&welcome=1`, `/auth/callback/complete…`). Nuevo `it.each` «relative Location, independent of the listening host (%s)». Hace la petición a `http://localhost:3000/auth/callback?…` con `Host: crm.example.com` + `X-Forwarded-Host` + `X-Forwarded-Proto: https` y comprueba el valor exacto, 307, `private, no-store`, que no aparece `localhost` y que no hay `://`.

### Comprobación con el servidor standalone (solo 127.0.0.1, sin `code` ni cookies: no sale a la red)
`HOSTNAME=127.0.0.1 PORT=3988 node .next/standalone/.claude/worktrees/invite-accept/server.js`. El 3979 estaba ocupado por otro servidor ajeno, que no toqué: mi primer intento contra ese puerto falló con `EADDRINUSE` y los `curl` respondieron desde ese otro proceso, con el build anterior y `Location` absoluto. Repetido en el 3988 con el build nuevo:

```
--- sin cabeceras                       GET /auth/callback?next=%2Fsettings
HTTP/1.1 307 Temporary Redirect
Cache-Control: private, no-store
location: /auth/callback/complete?next=%2Fsettings
--- Host: crm.example.com               /auth/callback?next=%2Freset-password&invite=tok
HTTP/1.1 307 Temporary Redirect
Cache-Control: private, no-store
location: /auth/callback/complete?next=%2Freset-password&invite=tok
--- Host + X-Forwarded-Host/Proto       /auth/callback?error=access_denied&error_code=otp_expired
HTTP/1.1 307 Temporary Redirect
Cache-Control: private, no-store
location: /auth/callback/complete?error_code=otp_expired
--- vector /.//evil.com (Host cambiado)
HTTP/1.1 307 Temporary Redirect
Cache-Control: private, no-store
location: /auth/callback/complete
--- GET (no HEAD), Host cambiado
HTTP/1.1 307 Temporary Redirect
Cache-Control: private, no-store
location: /auth/callback/complete?next=%2Freset-password
```

Servidor parado al terminar.

### Compuerta (HEAD 2214d8d)
- lint: 0 errores, 35 warnings preexistentes.
- typecheck: verde.
- `TZ=UTC npm test`: 226 archivos, **3097 tests** verdes.
- build con variables dummy: verde (`ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`).

### Pendiente manual
- La rama con `code`/`token_hash` real (cookies de sesión en el 307 relativo) necesita Supabase. Queda en el guion (pasos 2, 5 y 7), detrás del proxy de producción.

## Integración con s9.4

En `feat/superadmin` (worktree `.claude/worktrees/superadmin`), base `8305e7d` (s9.4 y s9.8 ya fusionadas). Commit `381552a`, sin push.

### Cambios
- `src/app/api/platform/accounts/route.ts` (crear empresa): `redirectTo: \`${resolveInviteBaseUrl(request)}/login\`` → `authCallbackUrl(resolveInviteBaseUrl(request), { next: RESET_PASSWORD_PATH })`. Se mantiene `resolveInviteBaseUrl`, que aplica `ALLOWED_INVITE_HOSTS` (no `resolveAppOrigin`).
- `src/app/api/platform/accounts/[id]/members/route.ts` (añadir miembro): se calcula `baseUrl = resolveInviteBaseUrl(request)` una sola vez. `inviteAuthUser({ email, redirectTo: url })` → `redirectTo: authCallbackUrl(baseUrl, { next: RESET_PASSWORD_PATH, invite: token })`. `url` (`<base>/join/<token>`) sigue siendo el enlace que se devuelve al operador. Cabecera del archivo actualizada.
- `docs/docker.md` §«Auth email links»: la plantilla token-hash ya no aparece como pendiente de s9.4. Ahora dice que las invitaciones del panel llevan `?next=/reset-password` (empresa) y `?next=/reset-password&invite=<token>` (miembro), y que no vale para correos lanzados desde el panel de Supabase. El párrafo inicial deja de decir que Ajustes → Equipo manda correo: genera un enlace para copiar.

### Tests
- `src/app/api/platform/accounts/create.test.ts`:
  - «creates the company…»: exige `redirectTo: 'http://app.example.test/auth/callback?next=%2Freset-password'`. Además comprueba el origen, `pathname === '/auth/callback'`, `next === '/reset-password'` y que no hay `invite`.
  - «builds the redirect from NEXT_PUBLIC_SITE_URL when it is set»: exige `https://crm.example.com/auth/callback?next=%2Freset-password`.
- `src/app/api/platform/accounts/[id]/members/route.test.ts`, test del alta con correo: `redirectTo` con origen `http://app.test`, `pathname === '/auth/callback'`, `next === '/reset-password'` e `invite` igual al token del enlace `/join/<token>`, cuyo hash es el guardado.

### Compuerta (feat/superadmin @ 381552a)
- lint: 0 errores, 35 warnings preexistentes.
- typecheck: verde.
- `TZ=UTC npm test`: 240 archivos, **3374 tests** verdes.
- build con variables dummy: verde.
