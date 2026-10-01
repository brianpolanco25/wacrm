# Review — s9.1 platform-shell

**Veredicto:** CHANGES_REQUESTED

Worktree `.claude/worktrees/superadmin`, rama `feat/superadmin`, rango `005f85a..785c3ae` (97e042d, e911cef, 785c3ae). El diff (23 archivos) coincide con el informe.

## Compuerta (ejecutada por el reviewer, HEAD 785c3ae)
- lint: verde (0 errores, 35 warnings preexistentes; el único en un archivo tocado es `src/middleware.ts:72` `'options'`, anterior al cambio)
- typecheck: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 208 archivos / 2770 tests
- build (variables dummy de `docs/harness.md`): verde; `/platform`, `/platform/[id]`, `/platform/accounts`, `/platform/operators`, `/platform/plans` salen como `ƒ` (dinámicas, no un 404 prerenderizado)
- replay-migrations: n/a (sin SQL)

## Trazabilidad criterio ↔ test
- C1 «grupo `(platform)` con layout propio, `requirePlatformAdmin()` + `notFound()` en el layout»: [x] `src/app/(platform)/platform-guard.test.ts` › `(platform) layout` › "is a 404 for a user without platform_admins" / "renders for a platform admin". `notFound()` se lanza desde el `catch` (`src/lib/auth/platform-page.ts:24-28`), no dentro del `try`. La guarda repetida en cada página (con `React.cache`) es más estricta que el spec y está justificada con `01-app/02-guides/authentication.md` §«Layouts and auth checks», que he comprobado.
- C2 «ningún usuario sin `platform_admins` ve nada bajo `/platform`»: [x] mismo archivo, `describe.each(ROUTES)` con las 5 páginas + layout, y `guardPlatformPage` › "404s for %s" (403, 401, error cualquiera).
- C3 «nav Resumen/Cuentas/Planes/Operadores, sin bandeja/contactos/pipelines»: [x] `src/components/platform/platform-shell.test.tsx` › "offers Resumen, Cuentas, Planes and Operadores, in that order", "has none of the CRM sections".
- C4 «paleta de marca con acento distinto»: [x] › "uses the navy accent, not the CRM sidebar" (`bg-navy` en el `<aside>`), "shows the operator badge and name, not the CRM brand lockup".
- C5 «mover `/platform` y `/platform/[id]` sin cambiar URLs; ítem «Plataforma» de la sidebar del CRM se mantiene»: [x] URLs `/platform` y `/platform/[id]` siguen existiendo (build); `src/components/layout/sidebar.tsx:121` sin tocar. Ojo: el censo se movió a `/platform/accounts`, lo que el spec asigna a s9.2 (ver hallazgo 5).
- C6 «tras el login un `platform_admin` aterriza en `/platform`; su cuenta de inquilino sigue accesible»: [x] `src/lib/auth/post-login.test.ts` › "sends a platform admin to /platform", "sends everyone else (403…) to /dashboard", "fails toward /dashboard when the check itself fails" (500 y rechazo de red), "an invite still wins, for operators too, without asking" (y sin consultar). «Ir al CRM» (`/dashboard`): `platform-shell.test.tsx` › "keeps a way back to the CRM". **No cubre un `/api/platform/me` que no responde** (hallazgo 1).
- C7 «i18n es/en/ko»: [x] `platform-shell.test.tsx` › "is translated in %s (CP6)" (shell y placeholder) + `src/i18n/messages.test.ts` (paridad). Leí las 39 claves nuevas en los tres catálogos: `es` en español, `ko` en coreano, sin cascarón en inglés; sin placeholders ICU.
- C8 «tests de render con las mocks de `platform-panel.test.tsx`»: [x] mismo enfoque (`renderToStaticMarkup` + `NextIntlClientProvider`), sin dependencias nuevas.
- Middleware `/platform` protegida: [x] `src/middleware.test.ts` › "redirects %s to /login without a session" (5 rutas), "lets a signed-in user through", "does not turn /api/platform/* into a redirect".

## Puntos pedidos por el líder
1. Sin `platform_admins` no se ve nada: [x] layout y las cinco páginas; `notFound()` en el `catch`.
2. Impersonación: [x] por lectura de código. `(dashboard)/layout.tsx` y `DashboardShell` no cambian (banner + salida intactos al navegar al CRM). `(platform)/layout.tsx:40` llama a `supportBanner()` y `PlatformFrame` monta `ImpersonationBanner`; la salida hace `POST /api/platform/impersonate/stop`, exento en el middleware. [ ] sin test: `platform-shell.test.tsx` solo renderiza con `support={null}` y `platform-guard.test.ts` mockea `supportBanner` a `null` (hallazgo 3).
3. Post-login: [x] invitación (`?invite=`) intacta y sin consulta; inquilino (403) → `/dashboard`; 500/red → `/dashboard`. [ ] una respuesta que no llega deja el login colgado (hallazgo 1).
4. Paridad es/en/ko y traducción real: [x].
5. Exenciones del middleware: [x] `SUPPORT_SESSION_EXEMPT` (`/api/platform/`, `/api/whatsapp/webhook`, `/api/v1/`, `/api/automations/cron`, `/api/flows/cron`) sin tocar; `protectedPaths` solo casa rutas que empiezan por `/platform`, no `/api/platform`; el bloque de `/api/whatsapp/` no cambia.

## Checkpoints
- CP1 Compuerta: [x] verde, ejecutada por el reviewer.
- CP2 Migraciones: [x] n/a, sin SQL.
- CP3 Aislamiento: [x] n/a, no hay consultas nuevas con `supabaseAdmin()`; la guarda reutiliza `requirePlatformAdmin()`.
- CP4 Tests: [ ] casi todo cubierto; falta el caso de `/api/platform/me` colgado (hallazgo 1). El banner bajo `(platform)` solo tiene guion manual (paso 2).
- CP5 Sin dependencias nuevas: [x] `package.json` sin cambios.
- CP6 i18n: [x].
- CP7 Next 16: [x] `notFound`, `unstable_rethrow`, layouts/auth comprobados en `node_modules/next/dist/docs/`.
- CP8 Alcance: [x] con reservas: el cambio a `/platform/accounts` y el placeholder del Resumen adelantan parte de s9.2 (hallazgo 5), necesario para que la nav tenga Resumen y Cuentas. Aceptable.
- CP9 Documentación: [ ] CHANGELOG actualizado pero se contradice (hallazgo 2); sin variables de entorno nuevas; el informe coincide con el diff.
- CP10 Git: [x] 3 commits en `feat/superadmin`, en español, con prefijo y `Co-Authored-By`; sin push; `main` en 005f85a.
- CP11 Lo entrante nunca se bloquea: [x] el webhook no cambia y sigue exento.

## Hallazgos (archivo:línea)
1. `src/lib/auth/post-login.ts:26` — `await fetchImpl('/api/platform/me', { cache: 'no-store' })` sin timeout ni `AbortSignal`. Ahora está en el camino de **todo** login (también el de inquilinos): si la ruta tarda (arranque en frío, `findPlatformAdmin` lento) el botón se queda en «cargando» con la sesión ya abierta y no hay navegación. «Falla hacia `/dashboard`» solo vale para rechazos y no-2xx.
2. `CHANGELOG.md:19` — «Same URLs as before.» contradice las líneas 20-22: el censo pasa de `/platform` a `/platform/accounts` y `/platform` es ahora el Resumen. Quien tenga marcado `/platform` para el censo cae en «Próximamente».
3. `src/components/platform/platform-shell.test.tsx:57-67` — `frame()` siempre pasa `support={null}`; nada comprueba que el shell del operador renderice el banner y el botón de salida durante una sesión de soporte, que es lo único que el layout `(platform)` hereda de `(dashboard)`.
4. `src/lib/auth/platform-page.ts:26` — el `catch` vacío convierte cualquier error en `notFound()`, incluidas las señales internas de Next. Hoy no rompe nada (sin `dynamic = 'error'` ni PPR; el build las marca `ƒ`) y el patrón ya existía en las páginas antiguas, pero `support-view.ts` e `impersonation.ts` del mismo repo usan `unstable_rethrow(err)` justo por esto. No bloqueante; recomendado.
5. `src/app/(platform)/platform/accounts/page.tsx` y `src/app/(platform)/platform/page.tsx` — el spec pone «el censo pasa a `/platform/accounts`» en s9.2; aquí se adelanta con un Resumen de relleno. Coherente con la nav de s9.1; lo dejo anotado para que s9.2 no lo haga otra vez.
6. `src/middleware.ts:132-150` — un operador ya autenticado que abre `/login` sigue yendo a `/dashboard`. Está declarado en el informe y el spec dice «tras el login»; no bloqueante.
7. `src/lib/auth/post-login.ts:25` — repite la consulta de `src/hooks/use-platform-admin.ts:29` (`/api/platform/me`, `r.ok`). Dos copias de la regla; no bloqueante.
8. Deuda preexistente, fuera de alcance: `next.config.ts:178-186` pone `public, s-maxage=300, stale-while-revalidate=86400` en todas las rutas que no son `/api`, `/platform/*` incluido (y `/dashboard`). Detrás de una CDN compartida, el 404 o el 200 de `/platform` podría servirse a otra persona. Hay que tratarlo en una feature propia; no se arregla en esta.

## Cambios requeridos
1. `src/lib/auth/post-login.ts`: acotar la espera (p. ej. `signal: AbortSignal.timeout(3000)`, o un `Promise.race`) y que al cumplirse el plazo devuelva `/dashboard`. Añadir en `src/lib/auth/post-login.test.ts` un caso con un `fetch` que nunca resuelve (o que rechaza con `AbortError`/`TimeoutError`) que acabe en `/dashboard`. Actualizar el `expect(fetchImpl).toHaveBeenCalledWith(...)` de la línea 19 si cambian las opciones.
2. `CHANGELOG.md:19`: quitar «Same URLs as before» o decir exactamente qué cambia (`/platform` = Resumen, censo en `/platform/accounts`, `/platform/<id>` igual).
3. `src/components/platform/platform-shell.test.tsx`: añadir un render de `PlatformFrame` con `support={{ accountId, accountName: 'Acme', expiresAt }}` que compruebe el texto `Impersonation.viewing` con el nombre de la cuenta y el botón `Impersonation.exit`.

Recomendado, no bloqueante: `unstable_rethrow(err)` antes de `notFound()` en `src/lib/auth/platform-page.ts:26` (hallazgo 4).

---

# Segunda ronda — 785c3ae..82f0d0c

**Veredicto:** APPROVED

Commits `5492d72` (fix y tests) y `82f0d0c` (CHANGELOG). Solo tocan los 6 archivos que pidió la revisión y coinciden con la sección «Segunda ronda» de `impl_platform-shell.md`.

## Compuerta (ejecutada por el reviewer, HEAD 82f0d0c)
- lint: verde (0 errores, 35 warnings preexistentes, los mismos que en la primera ronda)
- typecheck: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 208 archivos / 2780 tests
- build (variables dummy): verde; las cinco rutas `/platform*` siguen saliendo `ƒ`
- replay-migrations: n/a

## Cambios requeridos de la primera ronda
1. Tiempo máximo en post-login: [x] `src/lib/auth/post-login.ts:24-52`. El `Promise.race` contra un temporizador acota la espera aunque `fetch` ignore la señal, y `AbortSignal.timeout` cancela la petición. Si vence el plazo, devuelve `/dashboard`. El `clearTimeout` va en `finally`. La invitación sigue saliendo antes de cualquier consulta. Tests leídos en `src/lib/auth/post-login.test.ts`:
   - "gives up on a /api/platform/me that never answers → /dashboard": un `fetch` que nunca resuelve, con plazo de 20 ms.
   - "treats an aborted request (TimeoutError)…".
   - "waits at most a few seconds by default": el plazo por defecto es de 3000 ms.
   - La llamada ahora exige `signal: expect.any(AbortSignal)`.
2. CHANGELOG: [x] `CHANGELOG.md:19-23`. Se quitó «Same URLs as before». Una línea **URL change** dice que el censo pasa de `/platform` a `/platform/accounts` y que `/platform/<id>` no cambia.
3. Banner de soporte en el shell: [x] `src/components/platform/platform-shell.test.tsx:150-182`. Renderiza `PlatformFrame` con una sesión (`accountName: 'Acme'`) y comprueba cuatro cosas:
   - el texto `Impersonation.viewing` con «Acme», antes del `<aside>`;
   - el botón `Impersonation.exit`;
   - la traducción es/en/ko, sin claves crudas;
   - que no hay banner fuera de una sesión.

## Recomendado (hallazgo 4)
- [x] `src/lib/auth/platform-page.ts:29`: `unstable_rethrow(err)` va antes de `notFound()`, dentro del `catch`. Test: `platform-guard.test.ts` › "rethrows through unstable_rethrow before deciding 404". Los 404 de las seis rutas siguen en verde (el mock de `unstable_rethrow` no lanza nada con errores de la app, igual que la función real).

## Checkpoints (cambios respecto a la primera ronda)
- CP4 Tests: [x]
- CP9 Documentación: [x]
- CP10 Git: [x] 2 commits nuevos en español, con prefijo y `Co-Authored-By`; sin push; `main` sigue en 005f85a.
- El resto sigue como en la primera ronda: [x].

## Deuda que sigue abierta (no bloqueante)
- Hallazgo 6: un operador ya autenticado que abre `/login` va a `/dashboard`.
- Hallazgo 7: la regla de `/api/platform/me` está duplicada con `use-platform-admin.ts`.
- Hallazgo 8: `Cache-Control: public, s-maxage=300` en `/platform/*` desde `next.config.ts:178-186`. Conviene una feature propia antes de producción.
- Hallazgo 5: s9.2 no debe volver a mover el censo.
