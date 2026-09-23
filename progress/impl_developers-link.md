# impl p8.1 — developers-link

## Plan
1. Ítem `/developers` en `bottomNavItems` del sidebar (Code2), tras Ajustes.
2. `DropdownMenuItem` «Documentación de la API» en el menú de usuario de la cabecera (BookOpen).
3. Enlace «API para desarrolladores» en el pie del login.
4. Claves i18n en es/en/ko con paridad.
5. Tests de render estático de sidebar, cabecera y login.
6. `DEVELOPERS_URL` sin tocar.

## Rama y commits
- Worktree `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/developers-link`, rama `feat/enlazar-developers`, base `9c8d5d9`.
- `f76d4eb` feat: enlazar /developers desde el menú lateral, la cabecera y el login.

## Por punto
1. **Menú lateral** — `src/components/layout/sidebar.tsx`: `{ href: '/developers', labelKey: 'developers', icon: Code2 }` en `bottomNavItems` tras Ajustes; el ítem de plataforma sigue anexándose al final. Misma clase y patrón de activo (`pathname.startsWith`). **Misma pestaña**: el panel solo usa `target="_blank"` para URLs realmente externas (Meta, wa.me, PayPal), y el único enlace interno previo a `/developers` (`api-keys-settings.tsx`) abre en la misma pestaña. `docs-shell.tsx` ya tiene enlace de vuelta al panel en la cabecera (`t('dashboard')` → `/settings`, visible desde `sm`), así que **no se tocó el shell** ni se añadió clave `Developers.ui`.
2. **Cabecera** — `src/components/layout/header.tsx`: `DropdownMenuItem` con `render={<Link href="/developers" …/>}`, icono `BookOpen`, después de «Ajustes» y antes del separador de cerrar sesión.
3. **Login** — `src/app/(auth)/login/page.tsx`: `<p className="text-muted-foreground text-center text-xs">` bajo «¿Todavía no tienes cuenta?», con `Link` de las mismas clases que `createAccount` (`text-brand-ink hover:text-brand-ink/80 font-semibold`). Sin tokens nuevos.
4. **i18n** — `messages/{es,en,ko}.json`: `Sidebar.developers`, `Header.menuApiDocs`, `LoginPage.developersLink` con los textos del spec. `src/i18n/messages.test.ts` (paridad) verde.
5. **Tests** — no había tests de sidebar ni cabecera. Añadidos:
   - `src/components/layout/nav-developers-link.test.tsx` (mocks de `next/navigation`, `useAuth`, hooks de no leídos/plataforma, `TrialBanner`, `ModeToggle`, y el wrapper de `dropdown-menu` inlineado porque el popup de Base UI vive en un portal que no se pinta en SSR):
     - `Sidebar → /developers` › `lists the developer docs in the bottom block, after Settings`
     - › `opens in the same tab, like the other internal link to the docs`
     - › `labels the item in every catalogue`
     - `Header account menu → /developers` › `offers the API documentation right after Settings`
     - › `labels the item in every catalogue`
   - `src/app/(auth)/login/page.test.tsx`:
     - `LoginPage → /developers` › `links the developer API below the sign-up prompt`
     - › `labels the link in every catalogue`
6. `DEVELOPERS_URL` sin cambios.

CHANGELOG.md (Unreleased): sección «Developer docs are linked from the panel and the login».

## Compuerta (worktree developers-link)
- `npm run lint`: 0 errores, 35 warnings preexistentes (ninguno en archivos tocados).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 201 archivos, 2638 tests, todos verdes.
- `npm run build` (vars dummy de ci.yml): OK, tabla de rutas completa.
- Sin SQL: no aplica replay de migraciones.

## Decisiones
- Misma pestaña para el ítem del sidebar (razonado en punto 1).
- Prettier: `sidebar.tsx` y `header.tsx` ya no cumplían prettier en `main` (comillas dobles, etc.); pasarlo reformatearía el archivo entero. Se dejó el estilo local del archivo para no ensuciar el diff. Los archivos nuevos y `login/page.tsx` sí están formateados.
- `node_modules` enlazado por symlink al checkout raíz (ignorado por git).

## Variables de entorno nuevas
Ninguna.

## Verificación manual pendiente
Abrir el panel: el ítem «API para desarrolladores» aparece bajo Ajustes, el menú del avatar muestra «Documentación de la API», y `/login` muestra el enlace bajo «Crear cuenta»; los tres llevan a `/developers`, y desde ahí «Panel» vuelve a `/settings`.

## Deuda fuera de alcance
- `sidebar.tsx` y `header.tsx` sin formatear con prettier en `main`.
- El enlace de vuelta del docs-shell está oculto en móvil (`hidden sm:inline-flex`); en pantallas pequeñas no hay vuelta al panel salvo el botón atrás.
