# impl s9.9 `drop-korean`

## Plan
1. Borrar `messages/ko.json`.
2. `src/i18n/request.ts`: lista cerrada `LOCALES = ['es','en']` y `resolveLocale()`; cualquier valor fuera (incluido `ko`) cae a `es`.
3. `/developers`: `instanceDocsLocale()` usa `resolveLocale()`; comentarios sin coreano.
4. Tests: paridad es/en (`messages.test.ts`, `icu-safety.test.ts`, `brand.test.ts`), tests de componentes/rutas que importan `ko.json` a dos locales; test nuevo «`ko` no es locale válido y resuelve a `es`».
5. Docs: CHECKPOINTS CP6, agentes `.claude/agents`, `.opencode/agent`, `docs/docker.md`, CHANGELOG.
6. Compuerta sin build: lint, typecheck, `TZ=UTC npm test`.

## Resultado

- Rama `platform/drop-korean` (worktree `.claude/worktrees/drop-korean`), base `feat/superadmin` @ 68594c2.
- Commit: `b164284` feat: retirar el coreano; el producto sirve es (por defecto) y en (s9.9). 33 archivos.
- Compuerta (sin `build`, por orden del humano): `npm run lint` 0 errores (34 warnings previos, ninguno en archivos tocados), `npm run typecheck` 0, `TZ=UTC npm test` 250 archivos / 3488 tests en verde. Sin migración, sin replay.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| `messages/ko.json` borrado; solo quedan es/en | `src/i18n/messages.test.ts` › `shipped catalogues` › «messages/ holds exactly en.json and es.json» |
| Paridad es/en (claves, huérfanas, ICU) | `src/i18n/messages.test.ts` (`TRANSLATED_LOCALES = ['es']`), `src/i18n/icu-safety.test.ts`, `src/i18n/brand.test.ts` (`['en','es']`) |
| `ko` no es locale válido y cae a `es` | `src/i18n/request.test.ts` › «%j is not a valid locale and resolves to es» (`ko`, `xx`, `''`) y «ships exactly es and en» |
| `en` sigue disponible | `src/i18n/request.test.ts` › «still serves en when the variable asks for it» |
| `/developers` no espera `ko` | `src/content/developers/nav.test.ts` (nuevo) › «NEXT_PUBLIC_APP_LOCALE=%s opens the docs in %s» (ko→es) y «does not accept ?lang=ko» |
| Tests de fase 9 y anteriores a dos locales | `platform-shell`, `platform-panel`, `platform-overview`, `platform-plans`, `platform-provisioning`, `impersonation-actions`, `subscription-status`, `onboarding-flow`, `impersonation-banner`, `nav-developers-link`, `tag-manager`, `login`/`reset-password`/`auth/callback/complete` page tests, `handoff-message.test.ts`, `plan-prices.test.ts` |

## Cambios de código

- `src/i18n/request.ts`: `LOCALES = ['es','en']`, tipo `Locale`, `resolveLocale()`. Cualquier valor fuera de la lista cae a `es` (locale y catálogo). No hay selector de idioma en la UI ni detección por `Accept-Language`/cookie: el idioma es solo `NEXT_PUBLIC_APP_LOCALE`. `next.config.ts` no cita `ko`.
- `src/content/developers/nav.ts`: `instanceDocsLocale()` usa `resolveLocale()`. `DOCS_LOCALES` ya era `['es','en']`; `/developers` no genera páginas por locale `ko`.
- Comentarios sin coreano en `docs-shell.tsx`, `types.ts`, `handoff-message.ts`, `onboarding/profile.ts`.

## Decisiones donde el spec era ambiguo

1. **Valor desconocido cae a `es`, no a `en`.** Antes, un locale sin catálogo servía `en.json` con `locale` = el valor pedido (p. ej. `ko`). El spec pide que `ko` caiga a `es`; lo generalicé a cualquier valor fuera de `LOCALES` (una sola regla, y `<html lang>` ya no declara un idioma inexistente). El test antiguo «falls back to the English catalogue for an unknown locale» se sustituyó. `docs/docker.md` actualizado.
2. **`/developers` con instancia `ko`**: antes la prosa caía a inglés; ahora sigue a la interfaz (`es`).
3. En los tests que comparaban «en vs ko» (p. ej. `platform-panel`, `impersonation-banner`), el segundo catálogo pasa a ser `es`, manteniendo la aserción «traducido, no inglés».
4. Entradas históricas de CHANGELOG que mencionan Korean se dejan (son historia de versiones publicadas).

## Documentación

- `CHECKPOINTS.md` CP6 del worktree: «es (por defecto) + en», sin `ko`. `.claude/agents/implementer.md` y `reviewer.md` del worktree igual. `.opencode/agent/*.md`, `docs/harness.md`, `CLAUDE.md`, `AGENTS.md`, `README.md` no citaban `ko` (sin cambios).
- **Ojo**: las copias del checkout principal (`/Users/brian/Documents/Dev/projects/wacrm/CHECKPOINTS.md`, `.claude/agents/*.md`) siguen diciendo es/en/ko hasta que se mergee la rama; no las toqué (regla de trabajar solo en el worktree). El líder puede querer avisar a los agentes que se lancen antes del merge.
- `CHANGELOG.md` (Unreleased): sección «Korean retired».
- Sin variables de entorno nuevas; `.env.local.example` no tocado.

## Verificaciones manuales pendientes

- `npm run build` no se ejecutó (orden del humano: descarga Google Fonts; lo quita s9.10). Guion tras s9.10: `npm run build` con las variables de CI y comprobar que no hay import dinámico roto de `messages/ko.json`. El import de `request.ts` es `../../messages/${locale}.json` con `locale` tipado a `es|en`, así que el bundler solo encuentra es/en.

## Deuda fuera de alcance

- `src/lib/onboarding/profile.ts` `COUNTRIES` sigue incluyendo `'KR'` (lista de países del formulario de alta, no locale). Si Corea deja de ser mercado, quitarlo es decisión de negocio; no lo toqué (la migración 073 solo valida formato ISO, no la lista).
