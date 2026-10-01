# impl s9.1 `platform-shell`

## Plan
1. Guarda de servidor compartida `guardPlatformPage()` (React `cache` + `requirePlatformAdmin()` + `notFound()`).
2. `src/app/(platform)/layout.tsx`: metadata noindex, guarda, banner de soporte, `PlatformShell` (cliente).
3. `PlatformShell`: nav lateral (Resumen, Cuentas, Planes, Operadores), cabecera con título, ModeToggle y menú de usuario («Ir al CRM», cerrar sesión con `useAuth().signOut`); acento navy.
4. Mover `(dashboard)/platform/*` a `(platform)/platform/*`; censo a `/platform/accounts`; `/platform` Resumen placeholder; `/platform/plans` y `/platform/operators` placeholder.
5. Enlace «volver» de la ficha a `/platform/accounts`.
6. Login: `postLoginDestination()` consulta `/api/platform/me`; operador → `/platform`.
7. Middleware: `/platform` en `protectedPaths`.
8. i18n es/en/ko (`Platform.shell`, `Platform.placeholder`).
9. Tests: shell/nav, destino post-login, middleware `/platform`, 404 de las cinco páginas y del layout.
10. CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer)

Rama `feat/superadmin` (worktree `.claude/worktrees/superadmin`), base `main` @ 005f85a. Sin push.

| Commit | Qué |
|---|---|
| `97e042d` | feat: grupo `(platform)`, layout, shell/nav, guarda, placeholders, mover `/platform` y `/platform/[id]`, i18n |
| `e911cef` | feat: destino post-login del operador + `/platform` en `protectedPaths` |
| `785c3ae` | docs: CHANGELOG |

## Compuerta (ejecutada en el worktree, HEAD 785c3ae)
- `npm run lint`: 0 errores (35 warnings, todos preexistentes; ninguno en archivos nuevos).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 208 archivos, **2770 tests** en verde.
- `npm run build` (variables dummy): verde; aparecen `/platform`, `/platform/[id]`, `/platform/accounts`, `/platform/plans`, `/platform/operators`.
- Sin SQL: no aplica `replay-migrations.sh`.

## Archivos
- `src/app/(platform)/layout.tsx`: layout de servidor; metadata noindex; `guardPlatformPage()`; `supportBanner()` (se conserva el banner de soporte que tenía bajo `(dashboard)`); `PlatformShell`.
- `src/app/(platform)/platform/{page,accounts/page,plans/page,operators/page,[id]/page}.tsx`.
- `src/lib/auth/platform-page.ts`: `guardPlatformPage = cache(requirePlatformAdmin + notFound())`.
- `src/components/platform/platform-shell.tsx` (`PlatformShell`, `PlatformFrame`, `PLATFORM_NAV`, `platformSectionFor`), `platform-placeholder.tsx`.
- `src/lib/auth/post-login.ts` + cambio en `src/app/(auth)/login/page.tsx`.
- `src/middleware.ts`: `'/platform'` en `protectedPaths`.
- `src/components/platform/platform-account-detail.tsx`: los dos enlaces «volver a la lista» apuntan a `/platform/accounts` (el censo ya no está en `/platform`). Único cambio en la ficha.
- `messages/{es,en,ko}.json`: `Platform.shell.*` y `Platform.placeholder.*` (misma estructura en los tres; `src/i18n/messages.test.ts` de paridad sigue verde).
- Eliminados `src/app/(dashboard)/platform/page.tsx` y `[id]/page.tsx` (movidos).

## Criterio ↔ test
| Criterio | Test |
|---|---|
| Layout propio con guarda; 404 sin `platform_admins` en `/platform`, `/platform/accounts`, `/platform/plans`, `/platform/operators`, `/platform/[id]` y el layout | `src/app/(platform)/platform-guard.test.ts` › `describe.each(ROUTES)` › `is a 404 for a user without platform_admins` (6 rutas) y `renders for a platform admin` |
| La guarda da 404 para 403, 401 y cualquier error | mismo archivo › `guardPlatformPage` › `404s for %s`, `hands back the operator context` |
| Nav Resumen/Cuentas/Planes/Operadores | `src/components/platform/platform-shell.test.tsx` › `offers Resumen, Cuentas, Planes and Operadores, in that order` |
| Sin bandeja/contactos/pipelines | › `has none of the CRM sections` |
| «Ir al CRM» (`/dashboard`) | › `keeps a way back to the CRM` |
| Sección activa + título de cabecera | › `marks the current section and titles the header with it`; `platformSectionFor` › 6 casos (la ficha cuenta como Cuentas) |
| Acento distinto al CRM | › `uses the navy accent, not the CRM sidebar`, `shows the operator badge and name, not the CRM brand lockup` |
| i18n es/en/ko (CP6) | › `is translated in %s (CP6)` (shell y placeholder, 3 locales cada uno) + `src/i18n/messages.test.ts` (paridad) |
| Resumen con tarjetas «próximamente» | › `PlatformPlaceholder` › `the Resumen shows empty cards that say «coming soon», not zeros`; `the %s page says what it will be` (plans, operators) |
| Operador aterriza en `/platform` tras login | `src/lib/auth/post-login.test.ts` › `sends a platform admin to /platform`, `sends everyone else (403 from /api/platform/me) to /dashboard`, `fails toward /dashboard when the check itself fails`, `an invite still wins, for operators too, without asking` |
| `/platform` protegida en middleware | `src/middleware.test.ts` › `middleware — /platform is a protected page (s9.1)` › `redirects %s to /login without a session` (5 rutas), `lets a signed-in user through (the page decides, with a 404)`, `does not turn /api/platform/* into a redirect` |
| Censo intacto | `src/components/platform/platform-panel.test.tsx` (sin cambios, verde) |

## Verificaciones contra base real
Ninguna: no hay SQL ni RPC nuevos.

## Verificación manual pendiente (guion)
1. `npm run dev`; entrar con un usuario con fila en `platform_admins` → debe aterrizar en `/platform` (Resumen, barra navy).
2. Navegar Cuentas → abrir una ficha → «Volver a la lista» vuelve a `/platform/accounts`; impersonar sigue funcionando (banner y salida).
3. Menú de usuario → «Ir al CRM» abre `/dashboard` con el CRM normal; la sidebar del CRM sigue mostrando «Plataforma».
4. Menú de usuario → «Cerrar sesión» → `/login`.
5. Con un usuario inquilino: `/platform`, `/platform/accounts`, `/platform/plans`, `/platform/operators` dan 404; tras login aterriza en `/dashboard`.
6. Sin sesión: `/platform` redirige a `/login`.
7. Revisar el contraste en modo claro y oscuro de la barra navy (no hay test visual).

## Decisiones donde el spec era ambiguo
- **Guarda en layout Y en cada página.** El spec dice «en el layout, no en cada página», pero `node_modules/next/dist/docs/01-app/02-guides/authentication.md` («Layouts and auth checks») advierte que los layouts no se re-ejecutan en la navegación de cliente (Partial Rendering). Se mantiene la guarda en el layout (lo que pide el spec) y se repite en cada página con `React.cache` para que cueste una sola consulta por render. Es más estricto que el spec, no añade requisitos funcionales.
- **Redirección post-login en el formulario, no en el middleware.** El middleware no consulta `platform_admins` y hacerlo añadiría una lectura con rol de servicio a cada petición de la app; el formulario ya hace navegación completa tras `signInWithPassword` y `/api/platform/me` ya existe. Falla hacia `/dashboard`.
- Un operador ya autenticado que visita `/login` sigue siendo redirigido por el middleware a `/dashboard` (comportamiento previo; el spec habla de «tras el login»). No se tocó para no meter la consulta en el middleware.
- El shell usa `AuthProvider`/`useAuth` solo para nombre/correo y `signOut` (que cierra además la sesión de soporte). No monta `PresenceHeartbeat`, `BillingStatusAlert` ni `AccountAccessAlert` (son del inquilino). Sí monta `ImpersonationBanner` para no perder el aviso y el botón de salida que tenía bajo `(dashboard)`.
- Acento: `--cb-token-navy` (vía `bg-navy`) para la barra y ámbar `--cb-token-brand` para el ítem activo, sin tocar `globals.css`. `docs/brand.md` no existe.
- Resumen: 4 tarjetas (Cuentas, MRR, Altas recientes, Morosos) con «Próximamente»; s9.2 las sustituye.

## Variables de entorno nuevas
Ninguna.

## Deuda detectada fuera de alcance
- `src/middleware.ts` y `src/middleware.test.ts` no estaban formateados con prettier antes de este cambio; no se pasó `prettier --write` para no reformatear el archivo entero en este diff.
- En Next 16 `middleware.ts` está renombrado a `proxy.ts` (`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/proxy.md`); el repo sigue en `middleware.ts`.
- `vi.fn().mockReset()` en un `beforeEach` combinado con `mockRejectedValue` hacía fallar los tests con el error original en vitest 4.1.10 (se evitó; `clearMocks` ya está en la config).

## Segunda ronda (respuesta a review_platform-shell.md, CHANGES_REQUESTED)

Commits: `5492d72` (fix + tests), `82f0d0c` (CHANGELOG). HEAD `82f0d0c`. Solo se tocaron los archivos que pide la revisión (post-login, guarda, sus tests, test del shell, CHANGELOG), para que el merge con `platform/dashboard` y `platform/plans` (cortadas en 785c3ae) sea trivial.

| Hallazgo | Cambio | Test |
|---|---|---|
| 1. `/api/platform/me` sin tiempo máximo | `postLoginDestination(invite, fetch, timeoutMs = PLATFORM_CHECK_TIMEOUT_MS = 3000)`: `signal: AbortSignal.timeout(timeoutMs)` y `Promise.race` con un temporizador (acota la espera aunque el `fetch` ignore la señal); plazo cumplido → `/dashboard`; `clearTimeout` en `finally` | `src/lib/auth/post-login.test.ts` › `gives up on a /api/platform/me that never answers → /dashboard` (fetch que nunca resuelve, plazo 20 ms), `treats an aborted request (TimeoutError) as "not an operator"`, `waits at most a few seconds by default`; `sends a platform admin to /platform` ahora exige `signal: expect.any(AbortSignal)` |
| 2. CHANGELOG contradictorio | Se quita «Same URLs as before»; una línea **URL change** dice que el censo pasa de `/platform` a `/platform/accounts`, que `/platform` es el Resumen y que `/platform/<id>` no cambia | — |
| 3. Banner de soporte sin test | — | `src/components/platform/platform-shell.test.tsx` › `PlatformFrame — during a support session` › `says whose company the operator is in, above the console` (texto `Impersonation.viewing` con «Acme», antes del `<aside>`), `offers the exit button` (`Impersonation.exit` en un `<button>`), `is translated in %s (CP6)` (es/en/ko), `shows no banner outside a session` |
| 4. (recomendado) `unstable_rethrow` | `guardPlatformPage` llama a `unstable_rethrow(err)` antes de `notFound()` | `src/app/(platform)/platform-guard.test.ts` › `guardPlatformPage and Next signals` › `rethrows through unstable_rethrow before deciding 404` |

Hallazgos 5–8: sin cambios (no bloqueantes). El 7 (la regla de `/api/platform/me` duplicada con `use-platform-admin.ts`) y el 8 (`Cache-Control: public` en `/platform/*` desde `next.config.ts`) quedan como deuda.

Compuerta (HEAD 82f0d0c): lint 0 errores (35 warnings, los mismos de antes), typecheck verde, `TZ=UTC npm test` 208 archivos / **2780 tests** verde, build verde.
