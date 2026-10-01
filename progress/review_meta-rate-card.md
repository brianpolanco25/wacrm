# Review — s10.2 meta-rate-card

**Veredicto:** CHANGES_REQUESTED

Worktree `.claude/worktrees/fg-rate-card`, rama `fg/rate-card`, rango `4ad530f..5769fa2` (3 commits: 8bf277c, e85926f, 5769fa2). El diff coincide con el informe (28 archivos, nada fuera de lo declarado; `package.json` intacto).

## Compuerta
Ejecutada por el revisor, comando a comando, en el worktree:
- lint: verde (0 errores, 34 warnings, ninguno en archivos de la feature)
- typecheck: verde
- `TZ=UTC npm test`: verde, 260 archivos / 3652 tests
- build (variables dummy de CI): verde; salen `/platform/rates`, `/api/platform/rates`, `/api/platform/rates/import`, `/api/platform/rates/markets`
- replay-migrations: verde (`ok 076_meta_rates.sql`, `verify-schema.sql: OK`; la 075 no existe en esta rama, como se esperaba)
- `progress/checks_meta-rate-card.sql` contra la réplica (`KEEP=1`, `docker cp` de la 076): `ok 1a`–`1d`, `2`, `3a`–`3d`, `4`, `5`, sin ERROR

## Trazabilidad criterio ↔ test
- C1 «tablas `meta_rates` (PK market,category,effective_from; numeric(8,5)) y `meta_market_countries`»: [x] `verify-schema.sql` bloque 076; checks 1a–2
- C2 «RLS: lectura autenticados, escritura solo service_role»: [x] checks 3a–3d (INSERT → insufficient_privilege, UPDATE/DELETE 0 filas, el inquilino no se pasa a `managed`), 4 (anon); verify-schema exige que no haya política de escritura
- C3 «`rateFor(país, categoría, at)`; desconocido → `rest_of_world` si existe; si no, error visible, nunca 0»: [x] `meta-rates.test.ts` › "sends an unknown country to rest_of_world…", "throws for an unknown country when rest_of_world has no rate either (never 0)", "never borrows another market…", "skips a row with a rate of 0 or garbage…", "throws before the first effective date…"
- C4 «país del destinatario desde el teléfono; +1 809/829/849 → DO»: [x] `phone-country.test.ts` (tabla de 15 casos + 6 null); `meta-rates.test.ts` › `rateForPhone` "(+1 809 is RD, not the US)"
- C5 «`meta_billing` DEFAULT 'direct', `meta_pricing` DEFAULT '{}' sin romper filas existentes»: [x] check 1d (nueva suscripción = direct / `{}`), `ADD COLUMN … NOT NULL DEFAULT` rellena las existentes; [ ] verify-schema no comprueba el DEFAULT `'{}'` de `meta_pricing` (ver hallazgo 4)
- C6 «validador de `meta_pricing` (sin zod, decidido)»: [x] `meta-pricing.test.ts` › `parseMetaPricing`: `{}` → null (direct), entero ≥0, fee ≥0 con 2 decimales, `multiplier` >0 o `usd_per_message` >0, categoría desconocida rechazada explícitamente, campo desconocido rechazado, las cinco categorías obligatorias
- C7 «importe fijo gana sobre multiplicador»: [x] `meta-pricing.test.ts` › "the fixed amount wins over the multiplier", "a fixed per-message price changes the overage without a migration"
- C8 «ejemplos de la spec 4.000 → 1.036; 9.000 → 1.406»: [x] `meta-pricing.test.ts` › `packageCharge` (los dos `it` comprueban `totalUsd` exacto; además 7.000 marketing + 1.200 servicio → 1.069,90)
- C9 «nunca se edita una vigente: fila nueva»: [x] `rates/route.test.ts` › "inserts a NEW row … never touching the one in force" (el log no tiene UPDATE/DELETE sobre `meta_rates`), "409s the same market, category and date"
- C10 «importador CSV con vista previa, atómico»: [x] `rates/import/route.test.ts` › "previews without writing anything (dryRun)", "imports the new rows only, in one insert" (un único insert en el log), "400s and writes nothing when a line would edit a rate in force"; `meta-rate-input.test.ts` › `previewRateImport` "blocks the import on an invalid, conflicting, retroactive or repeated line". Comportamiento: se informa fila a fila **y** una fila mala bloquea todo el lote; el insert es una sola sentencia.
- C11 «`/platform/rates` guardada»: [x] `platform-guard.test.ts` › `/platform/rates`; rutas: 401/403 sin escribir en las tres (`route.test.ts`, `import/route.test.ts`, `markets/route.test.ts`), `requirePlatformAdmin()` antes de cualquier consulta a las tablas
- C12 «nav "Tarifas de Meta"»: [x] `platform-shell.test.tsx`, `platform-rates.test.tsx` › "the nav entry is «Tarifas de Meta» / «Meta rates»"
- C13 «semilla de la tarjeta 2026-10-01 para RoLatam, México, Colombia, Brasil, Norteamérica y España»: parcial y aceptado — solo hay dato local para RoLatam servicio/utilidad/marketing; el resto queda sin fila y lanza `MetaRateMissingError`. Decisión correcta según la regla del humano (no inventar cifras).
- Checkpoint propio «Ninguna tarifa se resuelve a 0 por mercado desconocido»: [x] C3 + `priceFor` "refuses to price with a Meta rate of 0 or NaN" + CHECK `usd_per_message > 0`.
- Checkpoint propio «Fuga A↔B en tarifas por cuenta»: n/a en esta feature — `meta_rates`/`meta_market_countries` son globales sin `account_id` (como `plans`); `meta_pricing` vive en `subscriptions` y no hay en s10.2 ningún endpoint que la lea o escriba por cuenta (lo añade s10.3, que debe traer su test de fuga). Check 3d prueba que el inquilino no la escribe.

## Checkpoints
- CP1 Compuerta: [x] verde, corrida por el revisor
- CP2 Migraciones: [x] 076 idempotente (check 5 la reaplica y conserva la edición del operador), sin CASCADE, aserciones en verify-schema; [ ] falta aserción del DEFAULT de `meta_pricing` (hallazgo 4)
- CP3 Aislamiento: [x] tablas globales; consultas de `src/lib/platform/rates.ts` detrás de `requirePlatformAdmin()`; no tocan filas de inquilinos
- CP4 Tests: [x] salvo lo señalado en hallazgos 1–3
- CP5 Sin dependencias nuevas: [x] (sin zod, decisión correcta)
- CP6 i18n: [x] `Platform.rates` 55 claves en es y 55 en en, mismo conjunto; `Platform.shell.nav.rates` = «Tarifas de Meta» / «Meta rates»
- CP7 Next 16: [x] página server con `guardPlatformPage()`, route handlers con `Request`/`NextResponse` como el resto de `/api/platform/*`; build verde
- CP8 Alcance: [x] solo archivos de s10.2
- CP9 Documentación: [x] CHANGELOG Unreleased con «migration required: 076»; sin variables nuevas
- CP10 Git: [x] 3 commits en español con prefijo y `Co-Authored-By`; sin push
- CP11 Lo entrante: [x] no toca webhook ni `enforce.ts`

## Hallazgos (archivo:línea)
1. `supabase/migrations/076_meta_rates.sql:133-136` y `:155-159` — la asignación país → mercado sale del conocimiento del implementer, no de un archivo del repo, y la migración no lo dice. El informe sí (`impl_meta-rate-card.md:33`), la migración no: quien lea la 076 la toma por dato verificado. Tampoco la UI: `messages/es.json:2449` (`Platform.rates.markets.help`) y su par en `en.json` no avisan de que la tabla sembrada está pendiente de revisión. Lo mismo para la elección de mercado propio de AR/CL/PE (también sin dato local).
2. `src/components/platform/platform-rates.tsx:219-225` — `unpriced` solo lista mercados **sin ninguna** tarifa vigente. `rest_of_latam` tiene servicio/utilidad/marketing, así que su falta de `authentication` y `authentication_international` no se ve en ningún sitio de `/platform/rates`, y un OTP a un número de RD lanza `MetaRateMissingError`. El operador no puede ver qué falta en un mercado que ya tiene tarifas. Texto en `messages/es.json:2393`.
3. `src/lib/billing/meta-rate-input.ts:147-154` (`classifyRate`) — reglas de retroactividad:
   a. `effective_from = today` con una tarifa anterior ya vigente se acepta (`meta-rate-input.test.ts:158` "today is allowed"). Como `rateFor` va por día UTC, la fila nueva cambia el precio de los mensajes entregados **antes** en ese mismo día, incluidos los que entren en un estado de cuenta emitido hoy (s10.4 corta en `current_period_end`, a cualquier hora). Eso reescribe la tarifa de mensajes ya cobrados.
   b. Una fecha pasada en un mercado/categoría sin fila previa (p. ej. `rest_of_latam/authentication` o `mexico`) se acepta sin límite. Es seguro **solo** si s10.4 nunca emite un estado de cuenta saltándose los mensajes sin tarifa. Si `buildStatement` capturara `MetaRateMissingError` y emitiera sin esas líneas, el relleno con fecha pasada cambiaría el precio de mensajes de un estado de cuenta ya emitido. Esta condición no está escrita en ningún sitio.
   El caso del día anterior con tarifa previa (`retroactive`) está bien resuelto y probado.
4. `supabase/ci/verify-schema.sql:1949-1956` — la aserción de `meta_pricing` comprueba `jsonb` y `NOT NULL`, pero no `column_default = '{}'::jsonb`, cosa que sí hace con `meta_billing`. La spec fija el DEFAULT y de él depende que toda cuenta existente quede `direct`.

Observaciones (sin cambio requerido):
- `src/lib/whatsapp/phone-country.ts:133-150`: un número sin prefijo internacional puede coincidir con otro código (un `55…` nacional de México se lee `BR`). Con `recipient_id` de Meta (E.164 sin `+`) no pasa. s10.4 debe resolver el país desde el número E.164 que guarda `message_charges.recipient_phone`, no desde `contacts.phone`.
- No hay todavía ningún consumidor de `rateFor` en producción: el error no se traga en ningún sitio porque nadie lo captura aún. s10.4 debe propagarlo (hallazgo 3b).
- PR (`+1 787/939`) resuelve a `PR` sin fila → `rest_of_world`. Está declarado en el informe como pendiente del humano.

## Cambios requeridos
1. En `076_meta_rates.sql`, encima de los dos `INSERT INTO meta_market_countries`, poner un comentario explícito «A VERIFICAR POR EL HUMANO contra la tarjeta oficial de Meta: asignación sembrada sin fuente en el repo; editable en /platform/rates». Añadir el mismo aviso en `Platform.rates.markets.help` (es y en). Sin tocar los datos.
2. En `/platform/rates`, mostrar los pares mercado/categoría que faltan, no solo los mercados sin ninguna tarifa (como mínimo `rest_of_latam: authentication, authentication_international` con la semilla actual), con un test en `platform-rates.test.tsx` que lo compruebe. Claves en es y en.
3. Retroactividad, en `classifyRate` y con tests:
   a. Si ya hay una tarifa anterior vigente para ese mercado/categoría, exigir `effective_from > today` (UTC) y rechazar `today` como `retroactive`. Actualizar `meta-rate-input.test.ts:158`, `editor.dateHelp` y `RateRefusedError` («usa una fecha posterior a hoy»).
   b. Para el relleno con fecha pasada de un mercado/categoría sin fila previa: dejar escrita la regla en la cabecera de `meta-rate-input.ts` y en el informe, como contrato para s10.4. `buildStatement` debe fallar entero ante `MetaRateMissingError` y no emitir nunca un estado de cuenta con mensajes sin tarifa, de modo que un relleno no pueda volver a poner precio a algo ya cobrado. Si el implementer prefiere no permitir el relleno pasado, también vale: rechazarlo y que el operador cargue con fecha de hoy o futura.
4. `verify-schema.sql` bloque 076: añadir `column_default LIKE '''{}''::jsonb%'` (o equivalente) a la aserción de `subscriptions.meta_pricing`.

Después, volver a pasar la compuerta, replay y checks y actualizar `progress/impl_meta-rate-card.md`.

---

# Segunda ronda — HEAD de4298b (rango 5769fa2..de4298b, 1 commit)

**Veredicto:** APPROVED

## Compuerta (corrida por el revisor, comando a comando)
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde, 260 archivos / 3656 tests (+4)
- build (variables dummy): verde
- replay-migrations: verde (`ok 076_meta_rates.sql`, `verify-schema.sql: OK`, ya con la aserción nueva del DEFAULT)
- `checks_meta-rate-card.sql` contra la réplica: 11 `ok`, 0 ERROR (incluido el 5, reaplicación de la 076)
- i18n: `Platform.rates` 56 claves en es y 56 en en, mismo conjunto (`missingPairs` nueva en los dos)

## Cambios requeridos de la primera ronda
1. Aviso «A VERIFICAR POR EL HUMANO»: [x] `076_meta_rates.sql:133-134` y `:157-158` encima de los dos INSERT de países, sin tocar los datos; `Platform.rates.markets.help` en es («A VERIFICAR POR EL HUMANO…») y en («TO BE VERIFIED BY A HUMAN…»). Test: `platform-rates.test.tsx` › "says the seeded country → market mapping is to be verified by a human" (renderiza es y en).
2. Pares que faltan: [x] `platform-rates.tsx:227-242` calcula, por mercado con alguna tarifa vigente, las categorías de `META_CATEGORIES` sin fila `inForce`; `:427-445` lo muestra con `t('missingPairs')` y nombres de categoría traducidos. Test: `platform-rates.test.tsx` › "lists the categories missing inside markets that have some rate" comprueba con la semilla `rest_of_latam:authentication+authentication_international`, el texto en es y en, y que una fila programada o pasada no cuenta como vigente.
3a. Hoy con tarifa vigente: [x] `meta-rate-input.ts:158` pasa a `effective_from <= today`. Tests: `meta-rate-input.test.ts` › "today is retroactive when the pair already has a rate" (hoy → `retroactive`, mañana → `new`); `rates/route.test.ts` › "409s today for a pair already priced" (409 `retroactive`, sin escribir; el 16-11 → 201). Mensajes `refused.retroactive`, `editor.dateHelp` y `RateRefusedError` (`rates.ts:58`) actualizados.
3b. Contrato para s10.4: [x] cabecera de `meta-rate-input.ts:21-28`; spec §s10.4 (`spec_facturacion-gestionada.md:173`): «ante `MetaRateMissingError` `buildStatement` falla entero»; informe, fila 3b. Test del relleno permitido: `meta-rate-input.test.ts` › "today or a past date fills a pair with no earlier rate (contract for s10.4)". **El revisor de s10.4 tiene que exigir el test de ese contrato.**
4. DEFAULT de `meta_pricing`: [x] `verify-schema.sql:1954` `column_default LIKE '''{}''::jsonb%'`; la réplica pasa.

## Alcance de la segunda ronda
Los 10 archivos tocados corresponden a los cuatro cambios; nada más. Sin dependencias nuevas.

## Pendiente del humano (no bloquea)
- Revisar contra la tarjeta oficial de Meta la asignación país → mercado sembrada y cargar las tarifas que faltan: `rest_of_latam` autenticación/autenticación internacional, México, Colombia, Brasil, Norteamérica, España, Argentina, Chile, Perú y `rest_of_world`.
