# Spec p8.1 — hacer visible la documentación pública de la API (`/developers`)

Rama `feat/enlazar-developers`, worktree `.claude/worktrees/developers-link`, base `main` @ 9c8d5d9.
Contexto: la fase 7 publicó `/developers` (12 páginas es/en generadas del `openapi.json`), pero hoy
solo se enlaza desde Ajustes → Claves de API (`DEVELOPERS_URL` en `api-keys-settings.tsx`). El humano
no sabía que existía. Esta feature la enlaza desde los sitios por donde pasa la gente. **No se toca el
contenido ni la estructura de `/developers`**; no hay landing pública (la raíz redirige a `/dashboard`).

## Alcance

1. **Menú lateral** (`src/components/layout/sidebar.tsx`): un ítem `{ href: '/developers', labelKey:
   'developers', icon: Code2 (lucide) }` en `bottomNavItems`, después de Ajustes y antes del ítem de
   plataforma. Misma clase y patrón de activo que los demás. Como `/developers` es pública y vive
   fuera del shell del panel, el ítem lleva `target="_blank"` y `rel="noopener"` solo si el resto del
   panel ya lo hace para enlaces externos; si no, abre en la misma pestaña (la doc tiene su propia
   navegación de vuelta: comprobar en `src/components/developers/docs-shell.tsx` que existe un enlace al
   panel o al login; si no existe, añadir uno discreto «Volver al panel» → `/dashboard` en la cabecera
   del shell, con su clave i18n en `Developers.ui`).
2. **Menú de usuario de la cabecera** (`src/components/layout/header.tsx`): tras «Ajustes», un
   `DropdownMenuItem` «Documentación de la API» → `/developers`, icono `BookOpen`, con el mismo
   `render={<Link …/>}` que los otros dos.
3. **Pie del login** (`src/app/(auth)/login/page.tsx`): debajo del párrafo «¿Todavía no tienes cuenta?»,
   una línea `text-xs text-muted-foreground` con un enlace «API para desarrolladores» → `/developers`,
   mismo estilo de enlace que `createAccount`. Ver `docs/brand.md` o los tokens `--cb-*` si dudas del
   color; no inventar tokens.
4. **i18n (CP6)**: claves nuevas en `messages/es.json`, `messages/en.json` y `messages/ko.json` con
   paridad exacta: `Sidebar.developers` («API para desarrolladores» / «Developer API» / «개발자 API»),
   `Header.menuApiDocs` («Documentación de la API» / «API documentation» / «API 문서»),
   `LoginPage.developersLink` («API para desarrolladores» / «Developer API» / «개발자 API»). Si existe
   un test de paridad de claves, debe seguir verde.
5. **Tests**: el sidebar y la cabecera tienen tests? (`src/components/layout/*.test.tsx`). Si los hay,
   añade un caso por enlace nuevo; si no, un test mínimo de render para `sidebar.tsx` que compruebe
   `href="/developers"` con las mocks que ya usen otros tests de componentes (`useAuth`, `next-intl`).
6. **Cambio de `DEVELOPERS_URL`**: no hace falta; déjalo.

## Compuerta y entrega

`npm run lint`, `npm run typecheck`, `TZ=UTC npm test`, `npm run build` (variables dummy de `ci.yml`).
Un commit (o dos: código + i18n) con mensaje imperativo en español. Informe en
`progress/impl_developers-link.md` **del worktree `.claude/worktrees/cabos`** (ruta absoluta
`/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/cabos/progress/impl_developers-link.md`),
donde vive el harness; NO edites `feature_list.json` ni `progress/current.md`. Entrada en `CHANGELOG.md`
(Unreleased) del worktree de la feature.
