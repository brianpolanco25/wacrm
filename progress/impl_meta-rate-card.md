# impl s10.2 `meta-rate-card`

## Plan
1. Migración `076_meta_rates.sql`: `meta_rates`, `meta_market_countries`, RLS (SELECT autenticados, sin política de escritura), `subscriptions.meta_billing` / `meta_pricing`, semilla solo con dato local. Aserciones `-- 076` al final de `verify-schema.sql`.
2. `src/lib/whatsapp/phone-country.ts`: país del destinatario por prefijo (con las áreas del Caribe en +1).
3. `src/lib/billing/meta-rates.ts`: `buildRateCard` / `rateFor(país, categoría, at)` / `rateForPhone` / `loadRateCard`, `MetaRateMissingError`.
4. `src/lib/billing/meta-pricing.ts`: validador de `meta_pricing`, `priceFor`, `packageCharge` (ejemplos 1.036 / 1.406).
5. `src/lib/billing/meta-rate-input.ts`: validación de tarifa, clasificación (nunca editar una vigente), parser CSV con vista previa, validación país→mercado.
6. `src/lib/platform/rates.ts` + rutas `GET/POST /api/platform/rates`, `POST /api/platform/rates/import`, `GET/PUT /api/platform/rates/markets`.
7. Página `/platform/rates` guardada, entrada «Tarifas de Meta» en `PLATFORM_NAV`, componente `PlatformRates`, i18n `Platform.rates` + `Platform.shell.nav.rates` (es/en).
8. Tests, réplica + checks SQL, CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer)

Rama `fg/rate-card` (worktree `.claude/worktrees/fg-rate-card`), base `feat/facturacion-gestionada` @ 4ad530f. Sin push.

| Commit | Qué |
|---|---|
| `8bf277c` | feat: migración 076 + aserciones `-- 076` en `verify-schema.sql` |
| `e85926f` | feat: `rateFor`, `meta-pricing`, `phone-country`, rutas, `/platform/rates`, nav, i18n, tests |
| `5769fa2` | docs: CHANGELOG con aviso de migración 076 |

## Compuerta (en el worktree, HEAD 5769fa2)
- `npm run lint`: 0 errores, 34 warnings (todos preexistentes, ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 260 archivos, **3652 tests** en verde.
- `npm run build` (variables dummy): verde; salen `/platform/rates`, `/api/platform/rates`, `/api/platform/rates/import`, `/api/platform/rates/markets`.
- `scripts/replay-migrations.sh <worktree>`: salida 0, `ok 076_meta_rates.sql`, `verify-schema.sql: OK`.

## Semilla: qué entra y qué queda fuera
- **Entra** (dato de la spec, «Contexto»): `rest_of_latam` desde 2026-10-01: `service` 0,01130, `utility` 0,01130, `marketing` 0,07400.
- **Fuera por falta de dato local** (no hay cifras en la spec ni en `progress/meta_*.md`; no se buscó en internet): `rest_of_latam` `authentication` y `authentication_international`; todas las tarifas de México, Colombia, Brasil, Norteamérica, España y `rest_of_world`. Las carga el superadmin desde `/platform/rates` (CSV). Hasta entonces, `rateFor` lanza `MetaRateMissingError` para esos casos (nunca 0).
- **Países → `rest_of_latam`**: DO, HT, JM, GT, SV, HN, NI, CR, PA, EC, VE, BO, PY, UY. **Países → mercado propio sin tarifa**: MX→`mexico`, CO→`colombia`, BR→`brazil`, AR→`argentina`, CL→`chile`, PE→`peru`, US/CA→`north_america`, ES→`spain`. La pertenencia de cada país a su mercado sale de lo que sé de la tarjeta de Meta, no de un archivo del repo: **que el humano la revise** contra la tarjeta oficial (es editable en la UI; PR y CU se dejaron fuera a propósito por duda).

## Criterio ↔ test

| Criterio | Test |
|---|---|
| Tablas, PK, CHECKs, RLS, columnas de `subscriptions`, semilla | `supabase/ci/verify-schema.sql` bloque `-- 076`; `progress/checks_meta-rate-card.sql` 1a–1d, 2 |
| RLS: un inquilino lee tarifas y países y no escribe | `checks_meta-rate-card.sql` 3a–3d (INSERT → `insufficient_privilege`; UPDATE/DELETE → 0 filas; no puede pasarse a `managed`), 4 (anon) |
| Migración idempotente | `checks_meta-rate-card.sql` 5 (reaplica la 076 con `\i`: mismas filas, edición del operador conservada) + réplica completa |
| `rateFor` RD marketing 0,0740 / servicio y utilidad 0,0113 | `meta-rates.test.ts` › `prices a marketing message to the Dominican Republic at 0,0740 from 2026-10-01` |
| Vigencia: la `effective_from` más reciente ≤ día UTC | `meta-rates.test.ts` › `uses the latest effective_from that is not after the UTC day of delivery`, `throws before the first effective date instead of answering 0` |
| Mercado desconocido → `rest_of_world` si existe | `meta-rates.test.ts` › `sends an unknown country to rest_of_world when that market has a rate` |
| Si no, error visible, nunca 0 | `meta-rates.test.ts` › `throws for an unknown country when rest_of_world has no rate either (never 0)`, `throws for a category the market has no rate for…`, `never borrows another market…`, `skips a row with a rate of 0 or garbage…` |
| País del destinatario desde el teléfono | `phone-country.test.ts` (RD por 809/829/849, PR, JM, US/CA, MX…; null si no se conoce); `meta-rates.test.ts` › `rateForPhone` › `resolves the recipient country from the number (+1 809 is RD, not the US)` |
| Validador de `meta_pricing` (`{}` = direct, todas las categorías, multiplicador o importe) | `meta-pricing.test.ts` › `parseMetaPricing` (accepts gestionado, `{}` → null, refuses 14 casos, requires every category) |
| El importe fijo gana sobre el multiplicador | `meta-pricing.test.ts` › `the fixed amount wins over the multiplier`; `a fixed per-message price changes the overage without a migration` |
| Ejemplos de la spec: 4.000 → 1.036; 9.000 marketing → 1.406 | `meta-pricing.test.ts` › `4.000 marketing deliveries → exactly the fee, 1.036`, `9.000 marketing deliveries → 1.036 + 2.000 × 0,0740 × 2,5 = 1.406` |
| `priceFor` nunca con tarifa 0/NaN | `meta-pricing.test.ts` › `refuses to price with a Meta rate of 0 or NaN (never 0)` |
| «Nueva tarifa» inserta fila, nunca edita la vigente | `rates/route.test.ts` › `inserts a NEW row … never touching the one in force` (sin UPDATE en el log), `409s the same market, category and date`, `409s a past date that would re-price delivered messages`; `meta-rate-input.test.ts` › `classifyRate` |
| Importador CSV con validación y vista previa antes de guardar | `rates/import/route.test.ts` › `previews without writing anything (dryRun)`, `imports the new rows only, in one insert…`, `400s and writes nothing when a line would edit a rate in force`; `meta-rate-input.test.ts` › `previewRateImport` |
| Tabla país→mercado editable | `rates/markets/route.test.ts` › `upserts, adds and removes countries, and answers the whole table` |
| 401/403/200/400 en las tres rutas | `rates/route.test.ts`, `rates/import/route.test.ts`, `rates/markets/route.test.ts` (401 sin sesión, 403 owner de empresa sin filtrar datos, 400 por validación y JSON roto, 500 sin eco del error) |
| Página guardada (404 sin `platform_admins`) | `src/app/(platform)/platform-guard.test.ts` › `/platform/rates` |
| Nav «Tarifas de Meta» | `platform-shell.test.tsx` › `offers Resumen, Cuentas, Planes, Tarifas de Meta and Operadores, in that order`, `platformSectionFor` `/platform/rates → rates` |
| UI: tabla con vigencia, sin editar/borrar, importador, tabla de países; i18n | `platform-rates.test.tsx` (render + todas las claves `t('…')` en es/en) |

## Aislamiento (CP3)
`meta_rates` y `meta_market_countries` son **globales** (sin `account_id`: la tarjeta de Meta es la misma para todas las empresas), como `plans`. Las consultas con `supabaseAdmin()` de `src/lib/platform/rates.ts` no leen ni escriben filas de ningún inquilino; van detrás de `requirePlatformAdmin()`. No aplica test de fuga A↔B; los tests de 403 comprueban que un owner no ve nada.

## Decisiones donde la spec era ambigua
1. **Sin zod.** La spec pide «validador con zod», pero `zod` no está en `package.json` de la raíz (solo en `mcp-server/`) y la regla es «sin dependencias nuevas». Validador a mano con el estilo de `plan-catalog.ts`. Si el humano quiere zod, es añadir la dependencia y reescribir `parseMetaPricing`.
2. **`phone-country.ts` en vez de tocar `phone-utils.ts`**: `phone-utils.ts` no está en formato prettier y reformatearlo metería ruido; el archivo nuevo vive al lado y reutiliza `sanitizePhoneForMeta`. +1 no caribeño → `US` (Canadá comparte mercado).
3. **Retroactividad.** «Nunca se edita una vigente» se aplica como: misma clave → 409 (`exists` si mismo precio, `conflict` si otro); fecha anterior a hoy (UTC) cuando ya había tarifa ese día para ese mercado y categoría → 409 `retroactive`. Una fecha pasada para un mercado sin tarifa previa (p. ej. cargar México tarde) se acepta.
4. **Día de vigencia en UTC**: la tarifa de un mensaje es la del día UTC de `at`.
5. **Mercado conocido sin tarifa no cae en `rest_of_world`**: sería cobrar a un precio que no es el suyo; lanza `MetaRateMissingError`.
6. **`meta_pricing` exige las cinco categorías** (cada una con `multiplier` y/o `usd_per_message`): una categoría ausente dejaría un excedente sin precio. Además CHECK en base de que es un objeto JSON.
7. **Formato CSV**: el que fijó el líder (`market,category,usd_per_message,effective_from`, cabecera opcional, `#` comentario; también `;` con coma decimal de una hoja en español). No hay en el repo un ejemplo del CSV/matriz oficial de Meta, así que no se modela su formato de matriz.
8. **`packageCharge`** (cuota + excedente en orden de entrega) se añadió en `meta-pricing.ts` para probar los ejemplos de la spec; s10.4 puede usarlo dentro de `buildStatement`.
9. `meta_rates` lleva además `created_at` y `created_by` (quién la cargó); `meta_market_countries`, `updated_at`.

## Verificaciones contra base real
`progress/checks_meta-rate-card.sql` contra la réplica (`KEEP=1`), salida: `ok 1a` … `ok 5` (todos). Pasos en la cabecera del archivo (incluye `docker cp` de la 076 para la prueba de idempotencia).

## Verificaciones manuales pendientes
Ninguna depende de Meta ni de PayPal. Guion de humo en la consola:
1. Entrar como operador a `/platform/rates`: aparecen las tres tarifas de `rest_of_latam` «Vigente» y el aviso de mercados sin tarifa (`argentina, brazil, …, rest_of_world`).
2. «Nueva tarifa» `rest_of_latam / marketing / 0.0740 / 2026-10-01` → error «Esa tarifa ya existe»; con fecha futura → se añade como «Programada».
3. Pegar en el importador `mexico,marketing,<tarifa>,2026-10-01` → Vista previa «Nueva» → Importar.
4. Cambiar HT a otro mercado, quitar un país, añadir `PR → rest_of_latam` → Guardar países → recargar y comprobar.

## Variables de entorno nuevas
Ninguna. `docs/docker.md` sin cambios; `.env.local.example` no se toca.

## Deuda fuera de alcance
- `verify-schema.sql`: s10.1 (075) añade su bloque en el mismo punto (tras `/074`); el merge de ambas ramas tendrá un conflicto trivial de orden (075 antes de 076).
- `src/lib/whatsapp/phone-utils.ts` sigue sin formato prettier (preexistente).
- La pertenencia país→mercado y las tarifas que faltan las tiene que cargar/validar el humano con la tarjeta oficial de Meta.

## Segunda ronda (review CHANGES_REQUESTED)

Commit `de4298b` (fix) sobre `5769fa2`. HEAD = `de4298b`. Sin push.

| Hallazgo | Cambio | Test |
|---|---|---|
| 1. País→mercado sin fuente, no marcado | Comentario «A VERIFICAR POR EL HUMANO contra la tarjeta oficial de Meta: asignación sembrada sin fuente en el repo; editable en /platform/rates» encima de los dos `INSERT INTO meta_market_countries` de la 076 (solo comentario; datos intactos). Mismo aviso en `Platform.rates.markets.help` (es/en). | `platform-rates.test.tsx` › `says the seeded country → market mapping is to be verified by a human` |
| 2. Pares mercado/categoría que faltan, invisibles | `/platform/rates` muestra un aviso nuevo `Platform.rates.missingPairs` (es/en) con las categorías sin tarifa vigente dentro de mercados que sí tienen alguna (`data-missing-pairs`). Con la semilla: `rest_of_latam: Autenticación, Autenticación internacional`. Una fila programada o histórica no cuenta como tarifada hoy. | `platform-rates.test.tsx` › `lists the categories missing inside markets that have some rate (seed: rest_of_latam without authentication)` |
| 3a. `effective_from = hoy` sobre un par ya tarifado | `classifyRate` lo trata como `retroactive` (`<= today`): un cambio en un par tarifado exige fecha **posterior** a hoy (UTC). Mensaje de `RateRefusedError`, `refused.retroactive` y `editor.dateHelp` actualizados. | `meta-rate-input.test.ts` › `today is retroactive when the pair already has a rate: rates apply per UTC day`; `rates/route.test.ts` › `409s today for a pair already priced: a change must be dated after today` |
| 3b. Relleno retroactivo de un par sin fila previa | Se mantiene permitido (hoy o fecha pasada). **Contrato para s10.4**, escrito en la cabecera de `src/lib/billing/meta-rate-input.ts` y en una línea de `progress/spec_facturacion-gestionada.md` §s10.4: `buildStatement` **falla entero** ante `MetaRateMissingError` (no emite estado de cuenta parcial ni salta mensajes sin tarifa). Así ningún estado de cuenta emitido contiene mensajes de un par sin tarifa, y un relleno retroactivo solo pone precio a lo que nunca se cobró; nunca reprecia un cargo cuya tarifa ya estaba resuelta. | `meta-rate-input.test.ts` › `today or a past date fills a pair with no earlier rate (contract for s10.4)`; `rates/route.test.ts` › `accepts a past date for a market that had no rate (Mexico, loaded late)` |
| 4. DEFAULT `'{}'` de `meta_pricing` sin aserción | `verify-schema.sql` bloque 076: `column_default LIKE '''{}''::jsonb%'`. | réplica: `verify-schema.sql: OK` |

La decisión 3 de la primera ronda («fecha pasada sin tarifa previa se acepta») sigue en pie, ahora con el contrato de 3b; lo que cambia es que «hoy» sobre un par ya tarifado deja de aceptarse.

### Compuerta (HEAD de4298b)
- `npm run lint`: 0 errores, 34 warnings preexistentes.
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 260 archivos, **3656 tests** en verde.
- `npm run build` (variables dummy): verde.
- `scripts/replay-migrations.sh` (`KEEP=1`): salida 0, `ok 076_meta_rates.sql`, `verify-schema.sql: OK`; `progress/checks_meta-rate-card.sql`: `ok 1a` … `ok 5`, sin ERROR.
