# Review — s9.9 drop-korean

**Veredicto:** APPROVED

Rango `68594c2..b164284` (1 commit, 33 archivos, +170/−2645), worktree `.claude/worktrees/drop-korean`.
El diff coincide con lo que dice `progress/impl_drop-korean.md`. Sin migración, sin cambios en
`package.json`/`package-lock.json`, `messages/es.json` y `messages/en.json` intactos.

## Compuerta (ejecutada por el revisor)
- lint: verde (0 errores, 34 warnings previos)
- typecheck: verde
- `TZ=UTC npm test -- --reporter=dot`: verde, 250 archivos / 3488 tests
- build: NO ejecutado (orden del humano: descarga Google Fonts; pendiente tras s9.10)
- replay-migrations: n/a (sin SQL)
- prettier --check sobre lo tocado: los 3 `.md` que avisa (`.claude/agents/implementer.md`,
  `.claude/agents/reviewer.md`, `docs/docker.md`) ya estaban sin formatear en la base; el código pasa.

## Trazabilidad criterio ↔ test
- C1 «Borrar `messages/ko.json`»: [x] `src/i18n/messages.test.ts:163-171` › "messages/ holds exactly
  en.json and es.json" (readdirSync, no tautológico). `ls messages/` = en.json, es.json.
- C2 «Paridad es/en»: [x] `src/i18n/messages.test.ts` (`TRANSLATED_LOCALES = ['es']`, fuente `en`),
  `src/i18n/icu-safety.test.ts:23`, `src/i18n/brand.test.ts:15`. Comprobado a mano: aplanados,
  2128 claves en cada uno, diferencia simétrica vacía.
- C3 «`ko` no es locale válido (cae a `es`)»: [x] `src/i18n/request.test.ts:55-66` › "%j is not a
  valid locale and resolves to es" (`ko`, `xx`, `''`): comprueba `resolveLocale`, `config.locale` y
  que el catálogo cargado es el español (`Sidebar.inbox === 'Bandeja'`). Más "ships exactly es and en"
  y "still serves en when the variable asks for it".
- C4 «`/developers` sin `ko`»: [x] `src/content/developers/nav.test.ts` (nuevo) › tabla
  undefined/es/en/ko/xx → es/es/en/es/es y "does not accept ?lang=ko". `DOCS_LOCALES` ya era
  `['es','en']` (`src/content/developers/types.ts:19`); `links.test.ts` y `legal.test.ts` iteran
  `DOCS_LOCALES`, no esperan `ko`.
- C5 «Todo test que cargaba `ko.json` ajustado»: [x] los 20 archivos de test que importaban/leían
  `ko` en la base (`git grep` en 68594c2) están todos en el diff; ninguno se borró.

### Tests parametrizados por locale (fase 9 y anteriores)
- `platform-shell.test.tsx`, `platform-provisioning.test.tsx`, `platform-overview.test.tsx`,
  `onboarding-flow.test.tsx`: `it.each(CATALOGUES)` con es+en; siguen ejecutando dos casos reales.
- `impersonation-actions.test.tsx:160`: pasa de `['es','ko']` a `['es','en']`; el cuerpo exige
  `CATALOGUES[locale]…` y `not.toContain('Platform.support.')`, válido para ambos.
- `platform-panel.test.tsx:106-110` e `impersonation-banner.test.tsx:95-107`: el caso «traducido,
  no inglés» ahora renderiza `es` y exige `not.toContain(en.Platform.title)`: sigue discriminando.
- `platform-plans.test.tsx`, `subscription-status.test.tsx`, `tag-manager.test.tsx`,
  `plan-prices.test.ts` (antes en/ko, ahora es/en: gana cobertura de `es`), `login`,
  `reset-password`, `auth/callback/complete`, `nav-developers-link`: sin casos vacíos.
- `request.test.ts`: el test «falls back to the English catalogue for an unknown locale» se
  sustituye por el nuevo comportamiento (C3); correcto, no se perdió cobertura.

## Cambios de comportamiento declarados
- (a) Valor desconocido de `NEXT_PUBLIC_APP_LOCALE` → `es` (antes `en.json` con `locale` = valor
  pedido, lo que dejaba `<html lang>` y el formateo `Intl` en un idioma inexistente). Correcto: `es`
  es el idioma por defecto y ahora hay una sola regla. Probado (C3) y documentado en
  `docs/docker.md:41-45` y `CHANGELOG.md:14-16`.
- (b) `/developers` en instancia `ko` abre en español: `src/content/developers/nav.ts:17-19` usa
  `resolveLocale`. Probado (C4) y en CHANGELOG. Aceptados ambos.

## Rastro de `ko`
- `grep` en `src`, `messages`, `docs`, `CHECKPOINTS.md`, `CLAUDE.md`, `AGENTS.md`, `.claude/agents`,
  `.opencode/agent`, `README.md`, `next.config.ts`, `Dockerfile`, `docker-compose.yml`, `.github`:
  solo quedan menciones intencionales (tests que prueban que `ko` se rechaza, comentarios de
  `request.ts:16`/`nav.ts:14`, CP6 y `docs/docker.md` explicando el retiro).
- Hangul en `src/lib/automations/engine.ts:806-810` y `engine.test.ts:782-789`: falso positivo
  (prueba de coincidencia de palabras en escritura no latina, no un locale).
- `progress/*.md` y `feature_list.json` históricos citan es/en/ko: historia, se dejan.

## Checkpoints (versión del worktree)
- CP1 Compuerta: [x] lint/typecheck/test verdes; build pendiente por orden del humano.
- CP2 Aislamiento: [x] n/a, sin consultas nuevas.
- CP3 Migraciones: [x] n/a.
- CP4 Trazabilidad: [x] ver arriba.
- CP5 Sin dependencias nuevas: [x].
- CP6 i18n: [x] `CHECKPOINTS.md:18-20` dice es (por defecto) + en; paridad exacta verificada.
- CP7 Next 16: [x] sin APIs de framework nuevas; `getRequestConfig` sin cambios de uso.
- CP8 Alcance: [x] todo lo tocado lo justifica §s9.9; `COUNTRIES` con `KR` anotado como deuda.

## Hallazgos (archivo:línea)
1. `CHECKPOINTS.md:18-20`, `.claude/agents/implementer.md:46`, `.claude/agents/reviewer.md:42` del
   **checkout principal** siguen exigiendo `ko.json` hasta el merge de la rama: los agentes que se
   lancen antes (por ejemplo s9.10) recibirán la regla vieja. El líder debe avisarles. No bloquea.
2. `src/lib/ai/handoff-message.ts:20` y `docs/docker.md:45`: líneas por encima de 80 columnas tras
   el cambio (prettier no reenvuelve comentarios ni markdown aquí). Cosmético, no bloquea.
3. Build sin ejecutar: tras s9.10, correr `npm run build` con las variables de CI para confirmar que
   el import dinámico `../../messages/${locale}.json` (`src/i18n/request.ts:25`) ya no busca `ko`.

## Cambios requeridos
Ninguno.

APPROVED
