# impl p16.7 audit-lean

## Plan

1. G1: node_modules propio en el worktree (`npm ci`), vendorizar `shadcn/dist/tailwind.css` en `src/app/shadcn.css`, quitar `shadcn` y los overrides sin efecto, regenerar lockfile, excluir `mcp-server` de `tsconfig.json`, paso de CI que construye `mcp-server`. Compuerta. Commit.
2. G2: `supabaseAdmin()` único en `src/lib/auth/admin-client.ts` (los otros tres reexportan; copias inline en rutas → import). `UUID_RE` único estricto; listar rutas que pasan de any-hex a estricto y revisar sus tests. Commit.
3. G3: borrar código muerto confirmado por grep. Commit.
4. G4: secuencias editar/borrar/enviar plantilla en `src/lib/whatsapp/`; panel filtra por `account_id`; test de fuga. Commit.
5. Informe.

## Estado: done (compuerta verde)

Rama `chore/audit-lean`, worktree `.claude/worktrees/audit-lean`, sobre `bd071af`.

| Bloque | Commit | Archivos | Líneas (+/-) | Sin lockfile |
|---|---|---|---|---|
| G1 | `66ac41c` | 8 | +733 / -2492 | +644 / -6 (630 son el CSS vendorizado) |
| G2 | `28e19fe` | 38 | +75 / -182 | igual |
| G3 | `a91444f` | 17 | +4 / -619 | igual |
| G4 | `3b3d672` | 7 | +460 / -287 | igual (de las +460: 198 lib, 123 tests) |

Compuerta final (worktree, `node_modules` propio, variables dummy): `npx eslint . --ignore-pattern '.claude/**'` 0 errores (34 warnings, los mismos 34 que en `main`); `npm run typecheck` ok; `TZ=UTC npm test` 425 archivos / 6477 tests verdes (1 archivo y 7 tests skipped, ya así antes); `npm run build` exit 0. `src/middleware.test.ts` no falló. Se corrió la compuerta completa también tras G1, G2 y G3 (verde en cada uno).

`node_modules` del worktree: ya no es enlace; es una instalación propia (`npm ci` + `npm install` sin shadcn). El del checkout principal no se tocó.

## G1: shadcn fuera, mcp-server aparte

- `src/app/shadcn.css` = copia literal de `shadcn@4.16.2/dist/tailwind.css` con una línea de cabecera; `globals.css` importa `./shadcn.css`. Añadido a `.prettierignore` (vendorizado, como `public/opus`). Comprobado que llega al bundle: `accordion-down` aparece en `.next/static/chunks/*.css`.
- `grep shadcn` en todo el árbol: solo el `@import` de `globals.css` (más `components.json`, que es la config del CLI y es inocua sin el paquete; se queda) y comentarios.
- Lockfile: **803 → 608 paquetes** (195 menos, `shadcn` incluido).
- Overrides: tras quitar `shadcn` y `npm install`, busqué en el lockfile cada paquete objetivo. `ip-address`, `fast-uri`, `hono`: 0 apariciones → quitados. Los demás siguen teniendo destino (`postcss` 8.5.24, `js-yaml` 4.3.1, `nanoid` 3.3.18, `@babel/core` 7.29.7, `sharp` 0.35.3, `brace-expansion` 1.1.18 y 5.0.9) → se quedan. Tras quitar los tres, un segundo `npm install` deja `.packages` del lockfile idéntico (diff vacío).
- `tsconfig.json`: `exclude: ["node_modules", "mcp-server"]`. Root typecheck verde sin `@modelcontextprotocol/sdk` en el árbol raíz.
- `mcp-server` tiene `package-lock.json` y `build: tsc`. `cd mcp-server && npm ci && npm run build` → exit 0 en local (borré después `mcp-server/dist` y `mcp-server/node_modules`, gitignoreados). CI: paso nuevo `Build mcp-server` (`working-directory: mcp-server`, `npm ci && npm run build`) tras `Build`, para que `dist/` no exista cuando corre `lint`.
- CHANGELOG: sección «Leaner install and an MCP server built on its own».

## G2: un cliente de servicio, un UUID_RE

- `supabaseAdmin()`: `src/lib/{ai,automations,flows}/admin-client.ts` reexportan el de `src/lib/auth/admin-client.ts` (se mantienen los archivos: hay `vi.mock` de esas rutas). Las tres copias inline de `api/whatsapp/{config,embedded-signup,webhook}/route.ts` importan el de auth. El tipo pasa de `any` a `SupabaseClient`: un solo ajuste, `as unknown as` en un cast de `webhook/route.ts:790`.
- `UUID_RE`: recuento actual 23 definiciones (14 estrictas, 9 any-hex, incluida la exportada de `platform/integrations.ts`). Ahora una: `src/lib/uuid.ts`, variante estricta v1-5 + variante RFC. 22 archivos la importan; los 5 que importaban de `platform/integrations.ts` pasan a `@/lib/uuid` (y `integrations.ts`, que solo la definía, deja de tenerla). `support-cookie.ts` («módulo sin imports a propósito», por el Edge) importa `@/lib/uuid`, que no tiene imports; comentario ajustado.
- Sitios que pasan de any-hex a estricto (9): `api/v1/conversations/route.ts`, `api/v1/templates/[id]/route.ts`, `api/whatsapp/templates/[id]/route.ts`, `lib/media/storage-url.ts`, `lib/api/v1/pagination.ts`, `lib/api/v1/pagination-activity.ts`, `lib/auth/support-actions.ts`, `lib/auth/support-cookie.ts` y los 5 importadores de `platform/integrations` (`api/account/integrations/[integrationId]{,/test}`, `api/platform/integrations/[id]{,/operations,/operations/[opId]}`).
  - Ids reales: todas las PK son `gen_random_uuid()` o `uuid_generate_v4()` (v4); los usuarios de GoTrue también. El único UUID no-v4 de `supabase/` es el `instance_id` nil de `seed.sql`, que no llega a ninguna ruta.
  - Fixtures: busqué todos los literales UUID en los tests y fuentes de esas áreas; ninguno falla la variante estricta. Suite completa verde.
- Tests nuevos: `src/lib/uuid.test.ts` («acepta los v4 que emite Postgres y rechaza lo que no es RFC 4122»), `src/lib/auth/admin-client.test.ts` («es una sola función»).
- Nota: en este commit usé `git add -A src` (acotado a `src/`); comprobé antes que solo había cambios míos.

## G3: código muerto

Confirmado con `git grep` en todo el árbol (tests, config, CSS, strings) antes de borrar:

- `tremor/bar-chart.tsx`: región Legend/ScrollButton/ChartLegend, el `RechartsLegend`, las props `showLegend`, `enableLegendSlider`, `legendPosition`, el estado `legendHeight` y `onCategoryClick` (solo lo llamaba la leyenda). Los dos llamadores pierden su `showLegend={false}`. Cabecera del archivo vendorizado actualizada. Sin reformatear (estilo upstream intacto).
- Borrados: `tremor/use-on-window-resize.ts`, `ui/separator.tsx`, `platform/platform-placeholder.tsx` (+ su bloque `describe('PlatformPlaceholder')` en `platform-shell.test.tsx`, 5 tests), `assertNever`, `assertMessageTemplate`, `COEXISTENCE_FEATURE_TYPE`, `public/{file,globe,next,vercel,window}.svg`.
- Además: las claves `Platform.placeholder.*` de `messages/es.json` y `en.json` (22 líneas cada uno) solo las usaba el placeholder borrado.
- No tocado: exportaciones sueltas de `src/components/ui`.

## G4: plantillas

Nuevo `src/lib/whatsapp/template-operations.ts` (al principio lo llamé `template-lifecycle.ts`; ya existía un `template-lifecycle.test.ts` de `meta-api`; lo pisé y lo restauré desde HEAD antes del commit, y renombré el módulo):

- `EDITABLE_TEMPLATE_STATUSES`, `isTemplatesDryRun()` (tres copias de `isDryRun` y dos de `EDITABLE_STATUSES` fuera).
- `templateContentColumns(payload)`: las 9 columnas de contenido, usadas por el upsert del panel, el insert de v1 y la edición.
- `submitTemplateToMeta(payload, target, accountId)`: handle de cabecera + `submitMessageTemplate`.
- `editTemplate(db, {...})`: handle + `editMessageTemplate` (con `submission_error` en la fila si Meta falla) + update a PENDING. `accessToken: null` = dry-run.
- `deleteTemplate(db, {...})`: Meta (si hay `target`) + borrado local.
- Toda escritura filtra por `id` **y** `account_id`. Devuelven `{ ok, step, error }`; cada ruta pone sus códigos y mensajes.

Rutas: `api/whatsapp/templates/[id]` (PATCH, DELETE), `api/whatsapp/templates/submit` (POST), `api/v1/templates/[id]` (PATCH, DELETE), `api/v1/templates` (POST). Cada una conserva su auth, su resolución de WABA (panel: número predeterminado; v1: `resolveTemplateWaba`), sus códigos (panel 400/502, v1 409/`metaErrorResponse`) y su envoltorio. Los tests existentes de ambas familias (`v1/templates/**`, `whatsapp/templates/{submit,sync}`, `tenant-isolation`) siguen verdes sin tocarlos. El panel `[id]` no tenía test propio.

Cambios observables (todos menores):
- Panel PATCH/DELETE: update, borrado y la escritura de `submission_error` llevan `.eq('account_id', …)` (lo que pide el spec).
- Panel PATCH: el update local usa `.maybeSingle()` en vez de `.single()`; si no hay fila, sigue saliendo 500 «Edited on Meta but failed to save locally: row not found…» (antes, el texto del error de PostgREST).
- Panel DELETE: el borrado local ahora pide `select('id')`; la respuesta no cambia (200 aunque no se borre fila, como antes).
- v1 PATCH: si Meta lanza algo que no es `Error`, el `submission_error` guardado es «Meta edit failed.» (con punto) en vez de «Meta edit failed».
- v1 DELETE: la respuesta devuelve `id` del parámetro en vez de `data.id` (son el mismo valor, filtrado por igualdad).

Tests de fuga nuevos:
- `src/lib/whatsapp/template-operations.test.ts`: «editTemplate with B's id under A leaves B's row untouched», «a Meta refusal records submission_error only on the caller account», «deleteTemplate with B's id under A deletes nothing». Los tres fallan si se quitan los `.eq('account_id')` del módulo (comprobado).
- `src/lib/security/tenant-isolation.test.ts`: «PATCH and DELETE write message_templates only with account_id = A (p16.7)». Falla con la ruta del panel de antes (comprobado con `git stash` de la ruta).

Líneas de producción en G4: rutas -287/+139, lib +198 → **+50 netas**. El ahorro de ~350 líneas de la auditoría no sale: las rutas conservan sus mensajes, sus códigos y su resolución de WABA, que eran la mayor parte del código. Lo que se gana es una sola secuencia y el filtro por cuenta.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| G1 compuerta verde sin shadcn | compuerta completa (arriba); `mcp-server` `npm ci && npm run build` exit 0 |
| G2 un solo `supabaseAdmin()` | `src/lib/auth/admin-client.test.ts` › «es una sola función (un solo cliente de servicio por proceso)» |
| G2 un solo `UUID_RE` estricto | `src/lib/uuid.test.ts` › «acepta los v4 que emite Postgres y rechaza lo que no es RFC 4122»; suite completa verde con ids de fixtures |
| G3 borrado sin romper nada | typecheck + suite + build verdes |
| G4 rutas existentes sin cambiar aserciones | `src/app/api/v1/templates/**/route.test.ts`, `src/app/api/whatsapp/templates/{submit,sync}/route.test.ts`, `tenant-isolation.test.ts` (sin cambios en aserciones existentes) |
| G4 escrituras del panel por `account_id` | `tenant-isolation.test.ts` › «PATCH and DELETE write message_templates only with account_id = A (p16.7)»; `template-operations.test.ts` (3 `it`) |

## Verificación contra base real / manual

- Sin SQL ni migraciones: no aplica `replay-migrations.sh`.
- Manual pendiente: el primer run de CI en GitHub con el paso `Build mcp-server` (no se puede correr Actions en local). Guion: abrir el PR y comprobar que el job `check` pasa el paso «Build mcp-server».

## Variables de entorno nuevas

Ninguna. `.env.local.example` sin tocar.

## Deuda fuera de alcance (no arreglada)

- `webhook/route.ts`: warning previo `'downloadMedia' is defined but never used`.
- Auditoría hallazgo 6, segunda mitad: el bloque de validación del `PATCH` de webhooks (`buildWebhookPatch`) sigue duplicado en `api/account/webhooks/[id]` y `api/v1/webhooks/[id]`; G4 solo pedía plantillas.
- Auditoría hallazgo 11: `isPlainObject` ×8, `isAuthError` ×6, `secretMatches` ×3, `getClientIp` ×2, `rpcErrorToResponse` ×3, `errorMessage` ×5 siguen copiados; G2 solo pedía `supabaseAdmin` y `UUID_RE`.
- `components.json` (config del CLI de shadcn) se queda; sirve si alguien usa `npx shadcn add`.
- Los `vi.mock('@/lib/flows/admin-client')` de los tests son la razón de que `template-operations.ts` importe la ruta de flows y no la de auth; si algún día se unifican los mocks, se puede cambiar.
