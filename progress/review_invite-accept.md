# Review — s9.8 invite-accept

**Veredicto:** CHANGES_REQUESTED

Worktree `.claude/worktrees/invite-accept`, rama `platform/invite-accept`, rango `22cba4b..8c3ba29` (3 commits). El diff coincide con el informe (23 archivos, sin SQL, sin `package.json`).

## Compuerta (ejecutada por el reviewer, HEAD 8c3ba29)
- lint: verde (0 errores, 35 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 226 archivos / 3036 tests
- build (variables dummy de CI): verde; `ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`
- replay-migrations: n/a (sin SQL)
- `next start` + `curl -I` (puerto 3977):
  - `/auth/callback?code=x` → 307 `…/auth/callback/complete?error_code=pkce_code_verifier_not_found`, `Cache-Control: private, no-store`
  - `/auth/callback?error=a&error_code=otp_expired&error_description=secret` → 307 `?error_code=otp_expired` (no reenvía `error_description`), `private, no-store`
  - `/auth/callback?token_hash=h&type=bogus` → 307 `?error_code=invalid` (no llama a Supabase)
  - `/auth/callback/complete` → 200 `private, no-store`
  - `/login` → 200 `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` (sin cambios)
  - `/reset-password` → 200 `public, s-maxage=300` (página estática sin datos; aceptable, ver hallazgo 5)

## Trazabilidad criterio ↔ test
- C1 «callback con `code`»: [x] `src/lib/auth/callback.test.ts` › "exchanges a PKCE code…", "a recovery code (redirectType)…", "a sign-up code with ?invite=…"; `src/app/(auth)/auth/callback/route.test.ts` › "code → exchanged, 307 to the dashboard, private"
- C2 «`token_hash` + `type` en lista cerrada»: [x] `callback.test.ts` › "verifies a token_hash invite…", "…recovery", "refuses a token_hash with an unknown type without calling Supabase"; `route.test.ts` › "token_hash invite → /reset-password carrying the invite". Lista `OTP_TYPES` en `src/lib/auth/callback.ts:47-54`.
- C3 «fragmento → `setSession`»: [x] `callback.test.ts` › "opens the session from the fragment…" (comprueba los args de `setSession`), "a fragment recovery…", "a fragment magic link…"
- C3b «no acepta tokens por query string»: [ ] el código es correcto (`completeAuthCallback` solo lee tokens de `opts.hash`, `callback.ts:222`), pero ningún test pasa `access_token`/`refresh_token` en `search` y comprueba que `setSession` no se llama.
- C3c «limpia el fragmento del historial»: [x] por lectura (`complete/page.tsx:37-39`, `history.replaceState` antes de nada; el hash se captura antes). Sin jsdom en el repo; cubierto por el paso 5 del guion manual. Aceptable.
- C4 «error / enlace caducado / otro navegador»: [x] `callback.test.ts` › "an expired token_hash…", "a code without its verifier…", "an error Supabase put in the query…", "an error in the fragment…", "setSession refusing the tokens…", `callbackErrorReason` ›*; UI con enlace a `/forgot-password` en `complete/page.tsx`; los textos no muestran `error_description`.
- C5 «sesión ya abierta»: [x] "no fragment but a session already open → carries on"; "nothing at all and no session → missing"
- C6 «destino tras fijar contraseña (operador → /platform, invite → /join, resto → /dashboard)»: [x] `src/lib/auth/reset-password.test.ts` › "success with an invite…", "success as an operator…", "success as anyone else…"
- C7 «`/reset-password` sin sesión no hace nada; mínimo = signup (6)»: [x] "no session → noSession", "GoTrue session_not_found → noSession", "different passwords…", "too short…", "uses the same floor as /signup" (signup `page.tsx:54` usa `< 6`)
- C8 «`next` no sale del sitio»: [ ] **falla**. `redirects.test.ts` › `safeNextPath` › "refuses %s" cubre `//evil.test`, `https://evil.test/x`, `/\evil.test`, `/\tx`, `javascript:`; `route.test.ts` › "an absolute next never leaves the host". Pero no cubre segmentos de punto y hay un bypass real (hallazgo 1). Tampoco hay test de `%2F%2Fevil` a través del route (query decodificada).
- C9 «middleware no redirige `/auth/callback*` ni `/reset-password`»: [x] `src/middleware.test.ts` › "middleware — /auth/callback y /reset-password (s9.8)" (con y sin sesión; `/forgot-password` sigue redirigiendo). `supportSessionBlocks`/`SUPPORT_SESSION_EXEMPT` intactos (solo 4 líneas de comentario en `src/middleware.ts:132-135`).
- C10 «`/auth/:path*` → `private, no-store` tras el comodín»: [x] `src/next-config-auth.test.ts` (usa el `getPathMatch` de Next y la regla "último gana"); confirmado con `curl`.
- C11 «signup/forgot-password usan `authCallbackUrl`; signup con `?invite=` sigue llevando al join»: [x] `redirects.test.ts` › `authCallbackUrl` ›*; `callback.test.ts` › "a sign-up code with ?invite= goes to /join/<token>". No existía test de página de signup previo (el brief lo suponía): nada que siga verde ni que se rompa.
- C12 «docs/docker.md: Redirect URLs y plantillas»: [x] contrastado con el código: `/auth/callback**` cubre `?next&invite`; la plantilla `{{ .RedirectTo }}&token_hash=…&type=invite|recovery` casa con `resolveCallback` (`token_hash` + `type` en `OTP_TYPES`) y la app siempre manda query en esos dos correos (`authCallbackUrl` con `next`).
- C13 «i18n `AuthCallback`/`ResetPassword` es/en/ko»: [x] mismas claves (9 y 23) y mismos placeholders en los tres catálogos; `page.test.tsx` de ambas páginas formatea cada clave en los tres.
- Cookies en la misma respuesta que redirige (#288): [x] por lectura del framework: `node_modules/next/dist/server/route-modules/app-route/module.js:502-512` fusiona `requestStore.mutableCookies` (lo que escribe `cookies().set` desde `createClient` de `@/lib/supabase/server`) en la respuesta devuelta por el handler, incluido `NextResponse.redirect`. El route test mockea el cliente y no lo prueba; no es exigible sin Supabase real y queda en el guion manual (pasos 2 y 7).

## Checkpoints
- CP1 Compuerta: [x] verde, ejecutada por el reviewer.
- CP2 Migraciones: [x] n/a, sin SQL.
- CP3 Aislamiento: [x] n/a, no hay `supabaseAdmin()` en el diff.
- CP4 Tests: [ ] C8 con bypass sin test; C3b sin test.
- CP5 Sin dependencias nuevas: [x] `package.json`/`package-lock.json` sin cambios.
- CP6 i18n: [x] es/en/ko en paridad para lo nuevo. (`forgot-password`/`signup` en inglés fijo: deuda preexistente, anotada.)
- CP7 Next 16: [x] `cookies()` escribible en Route Handler (`node_modules/next/dist/docs/01-app/03-api-reference/04-functions/cookies.md`), `route.ts` y `page.tsx` en segmentos distintos, `headers()` de `next.config.ts` con "último gana" comprobado en build real.
- CP8 Alcance: [x] `next.config.ts` y `middleware.ts` (comentario) justificados; resto dentro de §s9.8.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased), `docs/docker.md` §«Auth email links», informe coincide con el diff.
- CP10 Git: [x] 3 commits en español con prefijo y `Co-Authored-By`; sin push.
- CP11 Entrante: [x] no toca el webhook.

## Hallazgos (archivo:línea)
1. **BLOQUEANTE — open redirect por segmentos de punto.** `src/lib/auth/redirects.ts:44-55` (`safeNextPath`) valida el `next` crudo (`startsWith('//')`) y luego devuelve `url.pathname` **normalizado** por `new URL`, que resuelve `.`/`..` y puede producir `//host`. Comprobado:
   - `safeNextPath('/.//evil.com')` → `'//evil.com'`
   - `'/..//evil.com'`, `'/%2e//evil.com'`, `'/%2E%2E//evil.com'`, `'/a/..//evil.com'` → `'//evil.com'`
   
   `callbackDestination` (`redirects.ts:117-120`) lo devuelve tal cual y `src/app/(auth)/auth/callback/complete/page.tsx:46` hace `window.location.replace('//evil.com')` → `https://evil.com/`. Cadena explotable de punta a punta (verificada con `next start`): `GET /auth/callback?next=/.//evil.com` → 307 a `/auth/callback/complete?next=%2F.%2F%2Fevil.com` → si la víctima tiene sesión (rama "sesión ya abierta", `callback.ts:236-238`) **o** el atacante pone sus propios tokens en el fragmento (`#access_token=…&refresh_token=…`, sin `type`), la página redirige a `evil.com` desde el dominio de la app. En el servidor (`route.ts:29`) el mismo valor acaba en `https://<host>/` porque `new URL('//evil.com', base)` cambia de host y solo se copia `pathname`: no sale del sitio, pero descarta el destino en silencio.
2. `src/lib/auth/redirects.test.ts:50-61` — la tabla de "refuses %s" no incluye los vectores de punto ni `%2F%2Fevil`/`/%2F%2Fevil` pasados por la query del route (decodificados por `URLSearchParams`). `route.test.ts` solo prueba `https://evil.test/x`.
3. `src/lib/auth/callback.test.ts` (bloque `completeAuthCallback`, ~l. 212-311) — falta el caso "tokens en la query, fragmento vacío → no se llama a `setSession`".
4. Riesgo residual, no bloqueante: `/auth/callback/complete` acepta cualquier par de tokens válidos del fragmento y sustituye la sesión abierta sin avisar (login CSRF / cambio de cuenta). Es inherente al flujo implícito (el `detectSessionInUrl` del SDK hace lo mismo) y la plantilla token-hash que recomienda `docs/docker.md` lo reduce. Anotar en el informe como deuda; opcional: si ya hay sesión de otro usuario, pedir confirmación.
5. Menor, no bloqueante: `/reset-password` sale con `public, s-maxage=300` del comodín. Es `○` estática sin datos del usuario, así que no filtra nada; si se quiere coherencia, ampliar la regla de `next.config.ts:195` (`source`) a `/reset-password`.
6. Nota de merge (no es un defecto): s9.4 añade `/platform/:path*` en el mismo hueco de `next.config.ts` (tras el comodín, antes de las cabeceras de seguridad); al integrar hay que conservar **ambas** reglas, las dos después del comodín. Igual con los namespaces nuevos al final de `messages/*.json`. Y aplicar los dos `redirectTo` de s9.4 que lista el informe.

## Cambios requeridos
1. `src/lib/auth/redirects.ts` `safeNextPath`: validar el **resultado normalizado**, no solo la entrada: rechazar si `url.pathname` empieza por `//` (o por `/\`), además de la comprobación actual. Mantener el rechazo de `\` y caracteres de control.
2. `src/lib/auth/redirects.test.ts`: añadir a "refuses %s" `'/.//evil.com'`, `'/..//evil.com'`, `'/%2e//evil.com'`, `'/%2E%2E//evil.com'`, `'/a/..//evil.com'`; y un caso de `callbackDestination({ next: '/.//evil.com' })` → `null`.
3. `src/app/(auth)/auth/callback/route.test.ts`: un `it.each` con `next` = `//evil.com`, `https://evil.com`, `/\evil.com`, `%2F%2Fevil.com`, `/.//evil.com` (codificados en la query) que compruebe que `location` empieza por `https://app.test/` y no contiene `evil` como host; y en `callback.test.ts` el mismo conjunto por `completeAuthCallback` con sesión abierta, esperando `destination` relativa que no empiece por `//`.
4. `src/lib/auth/callback.test.ts`: caso "tokens en `search`, `hash` vacío → `setSession` no llamado" (y resultado `missing` sin sesión).
5. Anotar el hallazgo 4 como deuda en `progress/impl_invite-accept.md`.

## Contraste con `code-review` (high, `22cba4b..8c3ba29`)
- «Los `inviteUserByEmail` de s9.4 siguen mandando a `/login` y `/join/<token>`»: **no aplica a esta rama**. En la base `22cba4b` no hay ningún `inviteUserByEmail`/`redirectTo` en `src/app/api/platform/` (s9.4 vive en `platform/provisioning`). El informe da los dos cambios exactos para la integración; el líder debe aplicarlos al fusionar, si no la mitad «invitación» de s9.8 no se activa. También ajusta `docs/docker.md` §«Auth email links», que ya habla de invitaciones desde el panel y desde Equipo como si pasaran por `/auth/callback` (Equipo no manda correo en esta base).
- «Plantilla token-hash `{{ .RedirectTo }}&…` rota si `RedirectTo` no trae query»: válido solo con los callers de s9.4 sin integrar, o con una recuperación lanzada desde el panel de Supabase (el `RedirectTo` es la Site URL pelada). Cambio requerido 6.
- «StrictMode ejecuta el efecto dos veces y se pierde el `type`» (`src/app/(auth)/auth/callback/complete/page.tsx:34-50`): **confirmado por lectura**. `next.config.ts` no fija `reactStrictMode` (en App Router el valor por defecto es `true` en dev). Pasada 1: `replaceState` borra el hash y lanza `setSession`; la limpieza pone `cancelled = true`. Pasada 2: `hash === ''`, rama `getUser()`, `type = null` → `callbackDestination` ya no fuerza `/reset-password`. El impacto queda acotado porque los correos de invitación/recuperación llevan `next=/reset-password` (la persona sigue llegando al formulario; solo se pierde `welcome=1`), pero con un `redirectTo` sin `next` el invitado se saltaría la contraseña en dev. Cambio requerido 7.
- «Login CSRF por fragmento»: coincide con el hallazgo 4.
- «Alta PKCE en otro navegador se muestra como fallo aunque el correo ya quedó confirmado»: ya anotado como deuda en el informe. No bloqueante.
- «El comodín `public, s-maxage=300` sigue cubriendo respuestas con `Set-Cookie` del middleware»: preexistente y fuera de alcance (CP8). Deuda para el líder.
- `Cache-Control` duplicado en `route.ts:36`, rama `'missing'` muerta en `callbackErrorReason`, tarjeta de «sin sesión» y claves `requestNewLink`/`backToSignIn` duplicadas, literal `http://same.origin.invalid` en tres sitios: limpiezas, no bloquean.

## Cambios requeridos (adicionales)
6. `docs/docker.md` §«Auth email links»: decir que la plantilla token-hash solo sirve cuando el `redirectTo` de la app lleva query (es decir, tras integrar los `authCallbackUrl` de s9.4) y que no vale para correos lanzados desde el panel de Supabase.
7. `src/app/(auth)/auth/callback/complete/page.tsx`: capturar `hash`/`search` una sola vez fuera del ciclo del efecto (p. ej. un `useRef` o una variable de módulo), para que la segunda pasada de StrictMode no se quede sin fragmento; o no cancelar el resultado de la primera pasada.

---

# Segunda ronda — HEAD 4057287 (rango `8c3ba29..4057287`, 2 commits)

**Veredicto:** CHANGES_REQUESTED

## Compuerta (ejecutada por el reviewer, HEAD 4057287)
- `npm run lint`: verde (0 errores, 35 warnings preexistentes)
- `npm run typecheck`: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 226 archivos / 3095 tests
- `npm run build` (variables dummy de CI): verde (`ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`)
- replay-migrations: n/a

## Cambios de la primera ronda
1. Open redirect por segmentos de punto: [x] **cerrado**. `isSameOriginPath()` (`src/lib/auth/redirects.ts:46-67`) valida la cadena final: forma, versión decodificada, mismo origen y que sea estable al renormalizar. La usan `safeNextPath` (l. 78-91), `callbackDestination` (l. 144-152), `completePath` (`src/lib/auth/callback.ts:93-104`, descarta el `next` inseguro en vez de reenviarlo) y, como última defensa, `route.ts:33` y `complete/page.tsx:59-61`.
2. Tests de los vectores: [x] `redirects.test.ts` (`OPEN_REDIRECT_VECTORS`, `%2F%2F`, `%5C`, `isSameOriginPath` › accepts/refuses); `route.test.ts` › "code + next=%s → /dashboard on this host" y "no code + next=%s → the browser page WITHOUT that next" (codificados en la query); `callback.test.ts` › "never leaves the site with next=%s" (con y sin fragmento, con sesión) y "forwarding drops an unsafe next". Los leí: comprueban el destino exacto, no solo que no falle.
3. Tokens en la query: [x] `callback.test.ts` › "tokens in the QUERY are never used" (`setSession` no se llama, `missing`).
4. StrictMode: [x] `complete/page.tsx:36-42`: `useRef` para arrancar una sola vez y sin cancelar la primera pasada. Así la segunda no relee el hash ya borrado. El `setReason` tras desmontar no aplica en StrictMode, porque conserva el estado.
5. `docs/docker.md`: [x] aclara que la plantilla token-hash exige un `redirectTo` con query y que no sirve para correos lanzados desde el panel de Supabase.

## Vectores contra el build de producción (`next start -H 127.0.0.1`, `curl -I`)
Cada vector va codificado en `?next=` de `/auth/callback` (rama "nada", que reenvía a `/complete`) y con `error_code=otp_expired`:

| `next` | Location |
|---|---|
| `/.//evil.com`, `/..//evil.com`, `/%2e//evil.com`, `//evil.com`, `/a/..//evil.com`, `/\evil.com`, `%2F%2Fevil`, `/%2F%2Fevil` | `/auth/callback/complete` (sin `next`) |
| `/%5C%5Cevil.com`, `/%2F%5Cevil.com`, `/dashboard%00//evil.com`, `/%09/evil.com`, `https:evil.com` | `/auth/callback/complete` (sin `next`) |
| `/％2f／evil.com` (U+FF05, U+FF0F) | `?next=%2F%25EF%25BC%25852f%25EF%25BC%258Fevil.com`: una ruta del propio sitio, percent-codificada. Inocuo. |
| sin codificar: `next=/.//evil.com`, `next=%2F%2Fevil`, `next=/%252e//evil.com` | `/auth/callback/complete` |
| `token_hash=h&type=bogus&next=/.//evil.com` | `/auth/callback/complete?error_code=invalid` |
| `/settings` (control) | `/auth/callback/complete?next=%2Fsettings` |

Todas con `Cache-Control: private, no-store`. `/login` sigue en `public, max-age=0, s-maxage=300, stale-while-revalidate=86400` y `/auth/callback/complete` en `private, no-store`. La rama `code` no se ejercitó con `curl`, para no llamar a la URL dummy de Supabase (regla de no salir de la máquina); la cubren `route.test.ts` y `callbackDestination`.

## Hallazgo nuevo (bloqueante; ya existía en la primera ronda y no lo vi)
1. **`src/app/(auth)/auth/callback/route.ts:34-40`: la redirección sale con el host en el que escucha el servidor, no con el de la petición.** `request.nextUrl` (y su `origin`) en un Route Handler de `next start` y del servidor standalone (el del `Dockerfile`, con `HOSTNAME=0.0.0.0`) no se construye desde `Host`/`X-Forwarded-Host`. Comprobado con `.next/standalone/.../server.js` (`HOSTNAME=127.0.0.1 PORT=3979`):
   - sin cabeceras → `Location: http://localhost:3979/auth/callback/complete?next=%2Fsettings`
   - `Host: crm.example.com` → `Location: http://localhost:3979/…`
   - `Host` + `X-Forwarded-Host: crm.example.com` + `X-Forwarded-Proto: https` → `Location: https://localhost:3979/…`
   
   En producción, detrás del proxy, cada enlace de correo mandaría al usuario a `https://localhost:3000/...`. Las cookies de sesión recién escritas son del dominio real, así que se pierden, y el flujo de invitación y recuperación no funciona nunca. El comentario de `route.ts:28-29` («same host the request came in on — as the middleware's own redirects do») no se cumple: las redirecciones del middleware salen **relativas** (`curl -I /dashboard` da `location: /login`), porque Next reescribe a relativo el `Location` de mismo origen en middleware, pero no en un Route Handler. `route.test.ts` no lo detecta porque construye `NextRequest('https://app.test…')` a mano.

## Cambios requeridos
1. `src/app/(auth)/auth/callback/route.ts`: no construir un `Location` absoluto desde `request.nextUrl`. Dos opciones:
   - **Recomendada:** `Location` relativo con la ruta ya validada: `new NextResponse(null, { status: 307, headers: { Location: safe, 'Cache-Control': 'private, no-store' } })`. Así no se confía en ninguna cabecera de host, las cookies las añade Next igual (`appendMutableCookies`) y el navegador resuelve contra la URL real.
   - Alternativa: `new URL(safe, resolveAppOrigin(request))` (`src/lib/billing/checkout.ts:147`). Confía en `X-Forwarded-Host`, así que queda peor.
   
   Corregir también el comentario de l. 28-32.
2. `src/app/(auth)/auth/callback/route.test.ts`: afirmar que `location` es **relativo** (p. ej. `/dashboard`, `/auth/callback/complete`), o que no depende del origen del `NextRequest`: un caso con `new NextRequest('http://localhost:3000/auth/callback?…', { headers: { host: 'crm.example.com' } })` que no deje `localhost` en `Location`.
3. Repetir la comprobación con el servidor standalone y `-H "Host: crm.example.com"`, y pegar el `Location` en el informe.

El resto de la segunda ronda está bien. Los hallazgos 4 y 5 de la primera ronda (login CSRF por fragmento; `/reset-password` con `public, s-maxage=300`) siguen como deuda no bloqueante.

---

# Tercera ronda — HEAD 2214d8d (rango `4057287..2214d8d`, 1 commit)

**Veredicto:** APPROVED

## Compuerta (ejecutada por el reviewer, HEAD 2214d8d)
- `npm run lint`: verde (0 errores, 35 warnings preexistentes)
- `npm run typecheck`: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 226 archivos / 3097 tests
- `npm run build` (variables dummy de CI): verde (`ƒ /auth/callback`, `○ /auth/callback/complete`, `○ /reset-password`)
- replay-migrations: n/a

## Cambio requerido de la segunda ronda
1. `Location` relativo: [x] `src/app/(auth)/auth/callback/route.ts:32-51` responde con `new NextResponse(null, { status: 307, headers: { Location: safe, 'Cache-Control': 'private, no-store' } })`, donde `safe` es la ruta que ya pasó `isSameOriginPath` (o `/dashboard`). No depende de `request.nextUrl`, ni de `Host`, ni de `X-Forwarded-*`. El comentario viejo («same host… as the middleware») se ha quitado.
2. Test: [x] `route.test.ts` › "relative Location, independent of the listening host (%s)". Construye el `NextRequest` sobre `http://localhost:3000` con `Host`/`X-Forwarded-Host: crm.example.com` y exige `location` exacto, sin `localhost` ni `://`, 307 y `private, no-store`, tanto en la rama `code` como en la de fragmento. El resto de aserciones del archivo pasan a rutas relativas exactas.
3. `complete/page.tsx:59-61` y `reset-password/page.tsx` ya navegaban a rutas relativas: `window.location.replace` / `href` con destinos de `callbackDestination` / `postLoginDestination`. No cambian en esta ronda.

## Cookies de sesión en esa misma respuesta (#288)
[x] Comprobado en el código de Next 16.2.12:
- `createClient()` (`src/lib/supabase/server.ts`) escribe con `cookieStore.set` de `cookies()`, que en un Route Handler va a `requestStore.mutableCookies`.
- `node_modules/next/dist/server/route-modules/app-route/module.js:502-512`: tras el handler, `new Headers(res.headers)` + `appendMutableCookies(headers, requestStore.mutableCookies)` y `new Response(res.body, { status: res.status, statusText, headers })`. Se hace sobre **la respuesta que devuelve el handler**, que es la construida a mano. Status 307, `Location` y `Cache-Control` se conservan y los `Set-Cookie` se añaden a esa misma respuesta. No hay una segunda respuesta que se descarte: el handler no crea ninguna otra, y el middleware devuelve `NextResponse.next()` con sus propias cookies, que Next también fusiona.
- `appendMutableCookies` (`next/dist/server/web/spec-extension/adapters/request-cookies.js:83-97`) solo actúa si hay cookies modificadas, y respeta las que ya lleve la respuesta.
- No se puede comprobar de punta a punta sin Supabase real (la regla del humano prohíbe salir de la máquina). Cubierto por lectura y por el guion manual (pasos 2 y 7 del informe).

## Servidor standalone (`HOSTNAME=127.0.0.1 PORT=3993`, sin `code`)
| Petición | Resultado |
|---|---|
| `/auth/callback?next=%2Freset-password&invite=tok` sin cabeceras | 307, `location: /auth/callback/complete?next=%2Freset-password&invite=tok`, `private, no-store` |
| ídem con `Host: crm.example.com` | 307, mismo `location` relativo, `private, no-store` |
| ídem con `Host` + `X-Forwarded-Host: crm.example.com` + `X-Forwarded-Proto: https` | 307, mismo `location` relativo, `private, no-store` |
| `Host: crm.example.com`, `?error_code=otp_expired&next=/.//evil.com` | `location: /auth/callback/complete?error_code=otp_expired` |
| `Host: crm.example.com`, `?next=/..//evil.com` | `location: /auth/callback/complete` |
| `curl -L` (seguir la redirección) | acaba en `http://127.0.0.1:3993/auth/callback/complete?next=%2Freset-password` 200. El cliente resuelve contra la dirección que usó. |

Antes (segunda ronda), las mismas peticiones daban `https://localhost:3979/...`.

## Checkpoints (estado final)
CP1 [x] · CP2 n/a · CP3 n/a · CP4 [x] · CP5 [x] · CP6 [x] · CP7 [x] · CP8 [x] · CP9 [x] · CP10 [x] (commit `fix:` en español con `Co-Authored-By`, sin push) · CP11 [x]

## Deuda no bloqueante (para el líder)
- Login CSRF por fragmento en `/auth/callback/complete`: es propio del flujo implícito. Lo reduce la plantilla token-hash.
- `/reset-password` sale con `public, s-maxage=300`: página estática sin datos del usuario.
- El comodín `public, s-maxage=300` de `next.config.ts` también cubre respuestas en las que el middleware rota cookies. Es preexistente.
- Integración con s9.4: los dos `redirectTo` con `authCallbackUrl` y las reglas `/auth/:path*` + `/platform/:path*`, ambas después del comodín.

## Nota operativa
El proceso PID 35332 que ocupaba el puerto 3979 (título `next-server`, cwd `.claude/worktrees/invite-accept/.next/standalone/...`) es el servidor standalone que lancé yo en la segunda ronda. No se detuvo porque cambia su título y el `pkill -f "node server.js"` no lo encontró. Al intentar pararlo con `kill`, el permiso se denegó. Queda para el humano: `kill 35332`. El de esta ronda (PID 46454/puerto 3993) sí se detuvo.
