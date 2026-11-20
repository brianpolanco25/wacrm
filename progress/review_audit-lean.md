# Review — p16.7 audit-lean

**Veredicto:** APPROVED

Rama `chore/audit-lean` (worktree `.claude/worktrees/audit-lean`), 4 commits sobre `main` = `bd071af`: `66ac41c` G1, `28e19fe` G2, `a91444f` G3, `3b3d672` G4. Árbol limpio.

## Compuerta (ejecutada por el reviewer, worktree, variables dummy de `ci.yml`)
- `npx eslint . --ignore-pattern '.claude/**'`: verde (0 errores, 34 warnings preexistentes).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde, 425 archivos / 6477 tests (1 archivo y 7 tests skipped). `middleware.test.ts` no falló.
- `npm run build`: verde.
- `mcp-server`: `npm ci && npm run build` exit 0; `dist/` y `node_modules/` borrados después.
- `npm ci` limpio con el `package.json` + `package-lock.json` nuevos en un directorio aparte: ok, sin `shadcn` ni `@modelcontextprotocol/sdk` en el árbol.
- replay-migrations: n/a (sin SQL).

## Trazabilidad criterio ↔ test
- G1 «shadcn fuera, CSS vendorizado, overrides sin destino fuera, mcp-server aparte, compuerta verde»: [x]
  - `diff node_modules/shadcn/dist/tailwind.css src/app/shadcn.css` (shadcn 4.16.2 del checkout principal): idéntico salvo la línea de cabecera. El CSS original no tiene `@import`/`@plugin`/`url()`; el export `shadcn/tailwind.css` apuntaba a `dist/tailwind.css`. No se pierde ninguna clase/keyframe/variante.
  - Overrides: `ip-address`, `fast-uri`, `hono` → 0 entradas en el lockfile nuevo (1 cada uno en `main`). `postcss`, `js-yaml`, `nanoid`, `@babel/core`, `sharp`, `brace-expansion` siguen presentes.
  - Lockfile: 804 → 609 entradas; ninguna versión cambiada ni paquete nuevo (comparado por clave/versión); el resto del diff es `"dev": true` en lo que antes llegaba vía shadcn.
  - `tsconfig.json` solo añade `mcp-server` a `exclude`; ese era el único código que dependía de `@modelcontextprotocol/sdk` (subárbol de shadcn). Paso de CI `Build mcp-server` con `working-directory: mcp-server`, `npm ci && npm run build`, después de `Build` (no ensucia lint). Correcto.
  - Dockerfile: `npm ci` + `npm run build`, `.dockerignore` ya excluía `mcp-server`; no referencia `shadcn`. Copia `public/` (los SVG borrados no estaban referenciados).
- G2 «un solo supabaseAdmin()»: [x] `src/lib/auth/admin-client.test.ts` › «es una sola función…» (comprueba identidad de las tres reexportaciones). Las tres copias inline (`whatsapp/{config,embedded-signup,webhook}/route.ts`) eran `createClient(URL, SERVICE_ROLE_KEY)` sin opciones: mismo cliente. Ningún `auth.signIn*/setSession` sobre el cliente de servicio, así que compartir la instancia no mezcla sesiones.
- G2 «un solo UUID_RE estricto»: [x] `src/lib/uuid.test.ts` › «acepta los v4 que emite Postgres y rechaza lo que no es RFC 4122». Revisado cada sitio que pasa de any-hex a estricto:
  - `v1/templates/[id]`, `whatsapp/templates/[id]`, `platform/integrations/**`, `account/integrations/**`: PK `gen_random_uuid()` (v4). Ninguna PK uuid sin default aleatorio en `supabase/migrations`.
  - `v1/conversations` (`assigned` = user id de GoTrue, v4), `pagination{,-activity}` (cursor con id de fila), `storage-url` (`account-<accounts.id>` y legacy `<auth uid>`), `support-cookie` (account id), `support-actions` (`x-wacrm-support-request` lo pone `middleware.ts:54` con `crypto.randomUUID()`).
  - Único literal no-RFC del repo: el nil `instance_id` de `supabase/seed.sql:56`, no llega a ninguna ruta. Sin `uuidv7`, `md5()::uuid` ni `uuid_generate_v1/3/5`.
  - `support-cookie.ts` importa solo `@/lib/uuid` (sin imports): sigue siendo seguro para Edge; el build del middleware pasa.
  - Cast `webhook/route.ts:790` `as unknown as {...}[]`: antes era `any` implícito; mismo tipo declarado, sin cambio de runtime.
- G3 «borrar código muerto confirmado con grep»: [x] `git grep` en todo el árbol (src, mcp-server, messages, docs, README, CSS): 0 referencias a `assertNever`, `assertMessageTemplate`, `COEXISTENCE_FEATURE_TYPE`, `PlatformPlaceholder`, `useOnWindowResize`, `ui/separator`, `{file,globe,next,vercel,window}.svg`, `showLegend`/`enableLegendSlider`/`legendPosition`/`ChartLegend` (solo comentarios de cabecera). `Platform.placeholder.*`: ningún `t(\`…\`)` dinámico que construya `placeholder.`; claves borradas igual en `es` y `en`. Los dos llamadores de `BarChart` pasaban `showLegend={false}`: sin cambio visual. El test borrado (`platform-shell.test.tsx`, `describe('PlatformPlaceholder')`) solo probaba el componente borrado.
- G4 «secuencias compartidas en `src/lib/whatsapp/`, cada ruta conserva auth y formato»: [x] rutas comparadas antes/después (abajo); tests existentes de `v1/templates/**` y `whatsapp/templates/{submit,sync}` sin cambios y verdes.
- G4 «escrituras del panel filtran por `account_id`»: [x]
  - `src/lib/security/tenant-isolation.test.ts` › «PATCH and DELETE write message_templates only with account_id = A (p16.7)»: exige exactamente `['update','delete']` y el filtro `account_id = A` en cada escritura.
  - `src/lib/whatsapp/template-operations.test.ts` › edit con id de B bajo A no toca B; fallo de Meta no escribe `submission_error` en B; delete con id de B borra nada.
  - `accountId` sale de `resolveEffectiveAccountId(supabase, user.id)` (panel) o `ctx.accountId` de la API key (v1), nunca del cuerpo.
- Aserciones existentes: `git diff main...HEAD -- '*.test.ts' '*.test.tsx'` solo añade tests y borra el bloque del placeholder.

## Comparación G4 ruta por ruta
- Panel `PATCH [id]`: mismos 400/401/403/404, mismo orden (config → header → Meta → update local). Header 400 y Meta 502 con el mismo mensaje y fallback. `submission_error` igual (`'Meta edit failed.'`). Dry-run: sin llamada a Meta, mismo `dry_run`. `select('*')` = `select()`.
- Panel `DELETE [id]`: mismos 400 de config/`waba_id`, Meta 502, 500 local, 200 aunque no se borre fila (como antes).
- Panel `submit`: `decrypt` sigue fuera del try (misma excepción → 500); payload de Meta se construye después del handle (el handle muta `payload.header_handle`), como antes.
- v1 `PATCH [id]`: `resolveTemplateWaba` antes del handle (igual), header 400 `bad_request`, Meta `metaErrorResponse`, local 500 mismo texto.
- v1 `DELETE [id]`, v1 `POST`: mismo orden y códigos.

## Los 5 «cambios observables menores» del informe
1. Panel con `.eq('account_id')`: lo pide el spec. OK.
2. Panel PATCH `.single()` → `.maybeSingle()`: sigue 500 con el mismo prefijo; solo cambia el detalle del texto si no hay fila. Aceptable.
3. Panel DELETE con `select('id')`: RLS de `message_templates` (017) tiene SELECT = miembro ⊇ DELETE = admin, así que el RETURNING no filtra filas borrables; respuesta igual. Aceptable.
4. v1 PATCH `'Meta edit failed'` → `'Meta edit failed.'` solo si Meta lanza algo que no es `Error`. Aceptable (unifica con el panel).
5. v1 DELETE devuelve `id` del parámetro: **no es exactamente el mismo valor** — `UUID_RE` es `/i`, así que un `DELETE /api/v1/templates/3F2504E0-…` (mayúsculas) antes devolvía `data.id` en minúsculas (lo que emite Postgres) y ahora devuelve el id en mayúsculas tal como llegó. No bloquea (el cliente recibe el id que mandó y el formato del sobre no cambia), pero el informe lo describe mal. Ver hallazgo 1.

## Checkpoints
- CP1 Compuerta: [x] ejecutada por el reviewer (arriba).
- CP2 Migraciones: [x] n/a, sin SQL.
- CP3 Aislamiento: [x] escrituras de `template-operations.ts:127-135,140-152,189-195` filtran por `id` y `account_id`; tests de fuga presentes. `headerHandle` usa `supabaseAdmin()` con `accountId` igual que antes.
- CP4 Tests: [x] cada criterio G1–G4 con test o comprobación leída; guion manual para el primer run del paso `Build mcp-server` en Actions en el informe.
- CP5 Sin dependencias nuevas: [x] `package.json` solo quita `shadcn` y tres overrides, como pide el spec; lockfile sin paquetes ni versiones nuevas.
- CP6 i18n: [x] solo borra `Platform.placeholder` en ambos catálogos, simétrico.
- CP7 Next 16: [x] no usa API nueva de framework.
- CP8 Alcance: [x] todo lo tocado lo justifica G1–G4 (CHANGELOG, `.prettierignore` del CSS vendorizado incluidos). Deuda fuera de alcance anotada en el informe.
- CP9 Documentación: [x] CHANGELOG Unreleased; sin variables nuevas; informe coincide con el diff (salvo la precisión del hallazgo 1).
- CP10 Git: [x] commits en español con prefijo y `Co-Authored-By`; nada pusheado; `main` = `bd071af`.
- CP11 Lo entrante nunca se bloquea: [x] el webhook solo cambia de dónde importa `supabaseAdmin()` y un cast de tipo.

## Hallazgos (archivo:línea)
1. `src/app/api/v1/templates/[id]/route.ts` (`return ok({ id, deleted: true })`) — devuelve el id con la capitalización de la URL en vez del de Postgres; `progress/impl_audit-lean.md:73` dice «son el mismo valor». No bloquea; si se quiere cero cambio, `deleteTemplate` ya hace `select('id')` y puede devolver `data.id`.
2. `src/app/api/account/transfer-ownership/route.ts:51` — queda una regex UUID any-hex inline (no se llamaba `UUID_RE`, por eso no entró en el recuento de 23). No la pedía el spec explícitamente; anotarla como deuda o unificarla en la siguiente limpieza.

3. `.github/workflows/ci.yml:55-59` + `tsconfig.json:34` — con `mcp-server` fuera del `tsconfig` raíz, `npm run typecheck`, `/check` y `./init.sh wacrm` ya no lo compilan; un error de tipos en `mcp-server/src` solo se ve en CI. Es lo que pide G1, pero rompe la promesa de `wacrm/CLAUDE.md` («si los cuatro pasan en local, el PR pasa»). No bloquea esta feature; seguimiento para el leader (harness): añadir `cd mcp-server && npm ci && npm run build` a `/check` y a `./init.sh wacrm`.

## Contraste con `code-review` high (main...chore/audit-lean)
- UUID estricto (`src/lib/uuid.ts:4`): verificado arriba sitio por sitio; ningún id real de producción es no-v4 según migraciones y generadores (`gen_random_uuid`, `crypto.randomUUID`, GoTrue). No comprobado contra datos vivos del Supabase remoto (fuera de alcance; si se quiere certeza, `SELECT count(*) … WHERE id::text !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5]…'` sobre `accounts`, `message_templates`, `integrations`, `integration_operations`). No bloquea.
- Ruta de import elegida por los mocks (`template-operations.ts:2-3`) y las reexportaciones: el spec pide literalmente «los otros tres archivos lo reexportan»; deuda ya anotada en el informe. Descartado.
- mcp-server sin typecheck local: aceptado como hallazgo 3.
- Panel DELETE ignora `deleted: false`: igual que antes (el `delete().eq('id')` previo tampoco miraba filas). Descartado.
- Mensaje «Edited on Meta…» en dry-run con 0 filas: antes `.single()` daba el mismo prefijo con PGRST116. Preexistente. Descartado.
- `accessToken: null` como dry-run implícito: los llamadores pasan `decrypt(...)`/`resolveTemplateWaba(...).accessToken`, tipados `string`; solo llega `null` por la rama de dry-run. Descartado.
- Cast `webhook/route.ts:790`: antes era `any`, mismo nivel de comprobación. Descartado.

## Cambios requeridos
Ninguno bloqueante.
