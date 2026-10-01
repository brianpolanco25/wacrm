# impl s10.7 `meta-reconciliation`

## Plan

1. Migración `084_meta_spend_snapshots.sql`: tabla, UNIQUE NULLS NOT DISTINCT, índice por cuenta y periodo, RLS sin políticas, REVOKE a `anon`/`authenticated`; aserciones `-- 084 --` en `verify-schema.sql`.
2. `getWabaPricingAnalytics` en `src/lib/whatsapp/meta-api.ts` (única construcción de la URL de Graph).
3. `src/lib/billing/meta-reconciliation.ts`: parser puro y conservador de la respuesta, barrido `sweepMetaReconciliation` (cuentas managed, número conectado con WABA y token, como mucho una vez al día por cuenta, nunca lanza), y `reconcileStatements` para la ficha.
4. Cron `GET /api/billing/cron`: una llamada más y el bloque `reconciliation`.
5. Ficha del superadmin: `listAccountStatements` añade la conciliación; `platform-statements.tsx` la pinta (diferencia o «sin dato de Meta», texto de ajuste manual). i18n es/en.
6. Tests vitest (parser, barrido con fetch mockeado, fuga A↔B, ruta del cron, UI), `progress/checks_meta-reconciliation.sql`, docs, CHANGELOG.

## Rama y commits

- Rama `pmd/meta-reconciliation` (worktree `.claude/worktrees/pmd-meta-reconciliation`), base `feat/precios-meta-directo` @ 74a5daa.
- `50b8183` feat: conciliación del costo de Meta contra el estado de cuenta (s10.7).

## INCIDENTE: una petición de red real a Graph durante los tests

En la **primera** pasada de `TZ=UTC npm test`, el test de `src/lib/security/tenant-isolation.test.ts`
«the cron bills the managed company it is due for — A — and leaves B as it was» llamó a
`GET /api/billing/cron`, que ahora corre también el barrido de conciliación. Ese test siembra la
cuenta A con un número `connected`, `waba_id = 'waba-a'` y un token de fixture, y **no tenía `fetch`
mockeado**: salió UNA petición real a `https://graph.facebook.com/v21.0/waba-a?fields=pricing_analytics…`
con el token de fixture del test (no es un secreto real). Meta respondió
`Invalid OAuth access token - Cannot parse access token`; el barrido lo contó como `failed` y siguió.
Esto contradice la condición del humano (sin conexiones fuera de la máquina). Corregido antes del commit:
- ese test ahora mockea `fetch` (`vi.stubGlobal`) y comprueba que se llamó una vez y solo por A;
- `src/app/api/billing/cron/route.test.ts` pone en `beforeEach` un `fetch` que lanza
  («no network in tests») para que ningún test de esa ruta pueda salir a la red.
Las pasadas siguientes no hacen ninguna petición. Los únicos tests que llaman a la ruta del cron son esos dos.

## Diseño (no hay `specs/meta-reconciliation/`)

### Tabla `meta_spend_snapshots` (084)
- Columnas de la decisión del líder: `account_id` → accounts (CASCADE), `whatsapp_config_id` nullable,
  `waba_id`, `period_start`, `period_end`, `category`, `volume int`, `cost_usd numeric(14,6)`,
  `fetched_at`, `raw jsonb`; más `id uuid`.
- UNIQUE `meta_spend_snapshots_key` (account_id, waba_id, period_start, period_end, category,
  whatsapp_config_id) **NULLS NOT DISTINCT** (Postgres 15+; el harness usa 17.4): si no, el upsert
  con número NULL duplicaría la fila en cada pasada.
- **Sin FK en `whatsapp_config_id`** (desviación consciente): con `ON DELETE SET NULL` y el UNIQUE
  NULLS NOT DISTINCT, borrar un número podía chocar con la fila NULL del mismo día/categoría y hacer
  fallar el borrado del número. El id queda como dato histórico.
- CHECKs: `period_end > period_start`, `volume >= 0 AND cost_usd >= 0`, categoría y waba no vacíos.
- Índices `(account_id, period_start)` (ficha) y `(account_id, fetched_at DESC)` (barrido).
- RLS activada, sin políticas, `REVOKE ALL` a `anon`/`authenticated`, `GRANT ALL` a `service_role`.
  No hizo falta SELECT de miembros: la ficha lee con rol de servicio.
- `SET lock_timeout = '5s'`, idempotente. Aserciones `-- 084 --` en `verify-schema.sql` tras `/082`.

### Llamada a Graph (SUPUESTO SIN VERIFICAR)
- `getWabaPricingAnalytics` en `src/lib/whatsapp/meta-api.ts` (junto a `getWabaFundingInfo` de p11.1,
  misma `META_API_BASE` = `v21.0`; en el repo no existe `META_GRAPH_VERSION`, la versión es la
  constante de ese archivo).
- Forma asumida: campo del nodo WABA por expansión de campo, no un edge `/{waba}/pricing_analytics`
  como decía el encargo (es lo que recuerdo de la documentación de Meta; por eso el guion manual lo
  comprueba primero):
  `GET /v21.0/{waba_id}?fields=pricing_analytics.start(<unix>).end(<unix>).granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["PHONE","PRICING_CATEGORY"])`,
  `Authorization: Bearer <token de la fila>`, timeout 10 s.
- Respuesta asumida:
  `{"pricing_analytics":{"data":[{"data_points":[{"start":1759276800,"end":1759363200,"phone_number":"18095550000","pricing_category":"MARKETING","pricing_type":"REGULAR","volume":120,"cost":8.88}]}]},"id":"<waba>"}`.
- `parsePricingAnalytics` (puro): devuelve `null` (no se guarda NADA de ese WABA, cuenta `failed`)
  si falta `pricing_analytics` o `data` no es array, o si un solo punto no tiene `start`/`end`
  numéricos con `end > start`, `volume` entero ≥ 0, `cost` ≥ 0 o `pricing_category` no vacía. Acepta
  números como cadena numérica. Categoría a minúsculas, texto libre. `data` vacío o sin puntos = respuesta
  válida «sin datos».
- Granularidad diaria y no mensual: los cortes de `statements` son anclas arbitrarias (p. ej. día 15 a
  las 14:23), no meses naturales; con días se suma cualquier periodo.

### Barrido (`src/lib/billing/meta-reconciliation.ts`, `sweepMetaReconciliation`)
- Lista `subscriptions` con `meta_billing = 'managed'` (entre cuentas, como el barrido de estados; hasta 200),
  luego `whatsapp_config` `.in('account_id', ids)`, `status = 'connected'`, `waba_id` no nulo, token no vacío.
  Agrupa por cuenta y WABA.
- Como mucho una vez al día por cuenta: `max(fetched_at)` de sus snapshots; < 24 h → `skipped`.
  Las que tocan se ordenan nunca-bajadas primero y se bajan hasta 10 por pasada; el resto cuenta como
  `skipped` y espera a la siguiente.
- Por WABA: descifra el token del primer número que lo permita, pide la ventana [día 1 del mes anterior
  UTC, ahora], parsea, mapea PHONE → número por dígitos de `display_phone_number` **de esa cuenta**
  (sin casar → `whatsapp_config_id = NULL`), agrega puntos de misma clave (p. ej. dos `pricing_type`) y
  hace upsert por la clave única en trozos de 500, con `fetched_at = now`.
- Respuesta válida vacía → marca `_none` del día (volumen y costo 0): evita volver a preguntar en el día y
  hace que la ficha diga «Meta: 0» en lugar de «sin dato».
- Nunca lanza: error de listado → resumen a cero; error de Meta, token ilegible, respuesta rara o error
  de base en un WABA → la cuenta cuenta `failed` y se reintenta en la siguiente pasada (como mucho una
  por hora con el cron horario documentado). Log sin token ni URL.
- Contadores (`reconciliation` en la respuesta del cron): `scanned` (cuentas managed con número
  conectado con WABA y token), `fetched` (todos sus WABA guardados), `skipped`, `failed`.
- En la ruta solo se añadió la llamada tras `sweepStatements` y el bloque de respuesta. Si el barrido
  de estados lanza (500), el de conciliación no corre en esa pasada.

### Ficha del superadmin
- `listAccountStatements` añade `reconciliation` a cada estado (`reconcileStatements`, rol de servicio,
  `.eq('account_id', …)`, paginado de 1.000 en 1.000). Si la lectura falla, la lista carga igual sin el bloque.
- Un día de Meta cae en el estado cuyo [día UTC(period_start), día UTC(period_end)) contiene su inicio:
  cada día cae en un solo estado; hasta un día de desfase en cada borde frente a un ancla a media jornada.
- Por estado: `metaReportedCostUsd` (suma de `cost_usd`, todas las WABA), `differenceUsd` = nuestro
  `statements.meta_cost_usd` − Meta, `volume` (sin la marca `_none`), desglose por WABA, `lastFetchedAt`
  y `partial` (la última bajada es anterior al fin del periodo). Sin filas → `null` = «sin dato de Meta».
- `platform-statements.tsx`: línea bajo las cifras con Meta, la nuestra y la diferencia con signo;
  lista por WABA si hay más de una; aviso de dato incompleto; y el texto de que la diferencia se ajusta
  como línea manual en el siguiente estado. Sin botón de ajuste.
- i18n `Platform.statements.reconciliation.*` en es y en.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| Cron baja pricing_analytics (COST+VOLUME por PHONE y PRICING_CATEGORY) y guarda en meta_spend_snapshots | `src/lib/billing/meta-reconciliation.test.ts` › «fetches only managed accounts with a connected number, WABA and token, and stores their days»; «the default Graph call: GET the WABA with the pricing_analytics expansion, bearer token, nothing in the URL» |
| Solo cuentas managed con número conectado y token | mismo «fetches only managed accounts…» (C directa, D desconectada); `src/app/api/billing/cron/route.test.ts` › «the response carries the `reconciliation` block; managed WABAs are fetched (Graph mocked), the direct one is not» |
| Como mucho una vez al día por cuenta (`fetched_at`) | «at most once a day per account: a second run skips; 24 h later it refreshes without duplicating»; parte final del test del cron |
| Respuesta rara → sin snapshot | «anything odd invalidates the WHOLE answer (null): never an invented cost»; «an odd answer stores nothing for that WABA, counts as failed, and is retried on the next run» |
| Respuesta vacía válida | «an empty answer is valid and means «no data»»; «a valid empty answer stores the `_none` mark of the day…» |
| Nunca lanza fuera del barrido (CP11) | «CP11: Meta failing, a token that cannot be read or the database failing never throw out of the sweep»; «a Graph HTTP error through the default call is a failure, not a throw» |
| Bloque `reconciliation` (`scanned`, `fetched`, `skipped`, `failed`) | test del cron arriba; «a batch limit: the rest waits for the next run (counted as skipped)» |
| Fuga A↔B en el barrido | «A↔B: every write carries the account it belongs to, every read of the snapshots is filtered by account» (incluye `unscopedServiceRoleQueries`); `src/lib/security/tenant-isolation.test.ts` › «the cron bills the managed company it is due for — A — and leaves B as it was» |
| Ficha: diferencia por estado y WABA | `meta-reconciliation.test.ts` › «the difference is our cost − what Meta reports in the period, per WABA too; only A’s rows count (A↔B)»; `src/app/api/platform/accounts/[id]/statements/reconciliation.test.ts` › «per statement: Meta’s cost of the period, the difference with ours, and «sin dato» where there is none — only A’s rows (A↔B)» |
| «Sin dato de Meta» | «no row in the period → «sin dato de Meta» (null)…»; UI ««sin dato de Meta» without a snapshot; nothing at all when it could not be read» |
| Bordes de periodo y dato parcial | «a period anchored mid-day is rounded to UTC days…»; «the `_none` mark is «Meta says 0», not «no data»; a last reading before the period end is partial» |
| La lista carga aunque falle la conciliación | `reconciliation.test.ts` › «the list still loads when the snapshots cannot be read (no reconciliation block)» |
| Solo se muestra, con texto de ajuste manual, sin botón | `src/components/platform/platform-statements.test.tsx` › «shows Meta’s cost, ours, the signed difference, per WABA, partial data and the manual-adjustment note — no adjust button»; «a negative difference carries its sign; one WABA is not listed apart» |
| i18n es/en | «is translated in en» (bloque s10.7) y «every key exists in es AND en (CP6)» (recoge las claves nuevas) |
| Esquema 084 | `supabase/ci/verify-schema.sql` bloque `-- 084 --` (sin correr: Docker apagado) |

## Compuerta

- `npm run lint`: 0 errores (34 warnings ajenos; los archivos tocados, limpios con `npx eslint`).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 295 archivos, 4.312 tests, verde.
- `npm run build`: NO corrido, por orden del humano.
- `scripts/replay-migrations.sh`: NO corrido (Docker apagado). La 084 y su bloque de `verify-schema.sql`
  no se han ejecutado contra Postgres: lo tiene que hacer el reviewer o el líder.

## Verificaciones contra base real (pendientes)

`/Users/brian/Documents/Dev/projects/wacrm/progress/checks_meta-reconciliation.sql`, en una transacción con ROLLBACK:
UNIQUE NULLS NOT DISTINCT con upsert de número NULL, CHECKs, `authenticated`/`anon` sin SELECT ni INSERT,
`service_role` lee, CASCADE al borrar la cuenta. Además: re-aplicar la 084 dos veces (idempotencia) y
`verify-schema.sql` con salida 0.
```
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/pmd-meta-reconciliation
docker exec -i <contenedor> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < progress/checks_meta-reconciliation.sql
```

## Verificación manual pendiente: formato de `pricing_analytics` (requiere red y un WABA real)

1. Con el token de usuario de sistema del WABA gestionado (nunca en un log ni en un ticket):
   ```
   START=$(date -u -v1d -v-1m -v0H -v0M -v0S +%s)   # día 1 del mes anterior, UTC (macOS)
   END=$(date -u +%s)
   curl -sS -G "https://graph.facebook.com/v21.0/$WABA_ID" \
     -H "Authorization: Bearer $TOKEN" \
     --data-urlencode "fields=pricing_analytics.start($START).end($END).granularity(DAILY).metric_types([\"COST\",\"VOLUME\"]).dimensions([\"PHONE\",\"PRICING_CATEGORY\"])" | jq .
   ```
2. Comprobar: (a) la respuesta trae `pricing_analytics.data[].data_points[]`; (b) cada punto lleva
   `start`, `end` (segundos Unix), `phone_number`, `pricing_category`, `volume` y `cost`; (c) los días
   sin tráfico vienen omitidos o con 0; (d) si `cost` falta cuando es 0 (servicio gratis), el parser
   actual invalida TODA la respuesta: habría que aceptar `cost` ausente como 0 en
   `parsePricingAnalytics`; (e) si Meta exige el edge `/{waba}/pricing_analytics` o rechaza
   `granularity(DAILY)` con la dimensión PHONE, ajustar solo `getWabaPricingAnalytics`.
3. Si (1) devuelve error de permisos, comprobar que el token tiene `whatsapp_business_management`.
4. Con el formato confirmado: correr el cron en un entorno con la 084 aplicada
   (`curl -H "x-cron-secret: $BILLING_CRON_SECRET" …/api/billing/cron`), ver `reconciliation.fetched ≥ 1`,
   y en `/platform/<id>` que cada estado de cuenta muestra Meta, el nuestro y la diferencia;
   comparar con el Billing Hub de Meta del mismo periodo.

## Decisiones donde el encargo era ambiguo

- Expansión de campo en vez de edge `/{waba}/pricing_analytics` y `metric_types` en vez de `fields=cost,volume` (ver arriba).
- Granularidad diaria y asignación por día UTC (los cortes no son meses naturales).
- Sin FK en `whatsapp_config_id` (ver tabla).
- Marca `_none` para respuestas vacías válidas (distingue «Meta: 0» de «sin dato» y cumple el «una vez al día»).
- PHONE sin casar con un número de la cuenta se guarda con `whatsapp_config_id = NULL` en la cuenta
  dueña del token y del WABA (la llamada se hace con el token de esa cuenta; un WABA compartido entre
  dos cuentas sería un error de configuración).
- Los fallos se reintentan en la siguiente pasada (no hay dónde guardar un fallo sin inventar columnas):
  con el cron horario, como mucho ~24 llamadas al día por WABA que falla.
- Diferencia = nuestro `meta_cost_usd` − Meta (positiva: calculamos más de lo que Meta reporta).
- Se muestra en todos los estados de cuenta (también pagados o anulados).
- `cost_usd numeric(14,6)` (Meta reporta fracciones de centavo por día).

## Variables de entorno nuevas

Ninguna. Usa `BILLING_CRON_SECRET` (s10.4) y `ENCRYPTION_KEY`. `.env.local.example` no se tocó.

## Deuda detectada fuera de alcance

- En el repo no hay `META_GRAPH_VERSION`: la versión de Graph (`v21.0`) es una constante en `meta-api.ts`.
- El barrido de estados y el de conciliación corren en serie en la misma petición: con 10 cuentas y
  timeout de 10 s el peor caso añade ~100 s a la ruta; si el planificador corta antes, bajar
  `RECONCILIATION_FETCH_LIMIT`.
- `src/lib/security/tenant-isolation.test.ts` y otros tests que llaman rutas con efectos de red no
  tienen un guardia global de `fetch`; un `vi.stubGlobal('fetch', …)` que lance en el setup de vitest
  habría evitado el incidente de arriba.

## Segunda ronda (review `progress/review_meta-reconciliation.md`)

Commit `1dd5c4a` fix: la conciliación con Meta reemplaza la ventana y se controla por WABA (s10.7).

### Cambios
1. **Hallazgo 1, doble conteo.** `fetchWaba` borra, antes del upsert, las filas de `account_id` +
   `waba_id` con `period_start` en [inicio de la ventana pedida, ahora] (`.delete().eq().eq().gte().lte()`),
   y escribe lo que Meta dice ahora. Clave y 084 sin cambios. Si el upsert falla tras el borrado, ese WABA
   cuenta `failed`, queda «sin dato» o `partial` y se reintenta en la pasada siguiente (no hay transacción
   en PostgREST sin RPC).
2. **Hallazgo 2, gate y `partial` por WABA.** `lastFetchedAt(db, accountId, wabaId)`. Una cuenta entra
   si algún WABA lleva ≥ 24 h sin leerse (o nunca); solo se piden esos. `skipped` = todos sus WABA leídos
   en las últimas 24 h, o fuera del lote. En la ficha, los WABA del periodo son los que tienen filas en él
   más los que hoy tienen un número conectado (lectura nueva de `whatsapp_config`, filtrada por
   `account_id`). Cada uno lleva `lastFetchedAt` y `partial`. El estado es `partial` si lo es alguno, y su
   `lastFetchedAt` es la lectura más vieja (`null` si algún WABA no se leyó nunca). En la UI: «WABA X:
   sin dato de Meta» y «algún WABA todavía no se ha podido leer» (claves nuevas `wabaNoData` y
   `partialMissing` en es/en).
3. **Hallazgo 3.** `.order('period_start').order('id')` antes de `.range()`.
4. **Guion manual / `docs/docker.md`.** Añadido: comprobar si `pricing_analytics` trae `paging`
   (`paging.next`). Hoy no se sigue; si Meta pagina, el costo guardado saldría incompleto. Punto (f) del guion:
   en la respuesta del paso 1, mirar si hay `pricing_analytics.paging` o `paging.next`. Si lo hay, hay que
   seguir los cursores en `getWabaPricingAnalytics` antes de dar por bueno el dato.
5. **Hallazgo 9.** `tenant-isolation.test.ts`: el cuerpo tras el `stubGlobal` va en `try` con
   `vi.unstubAllGlobals()` en `finally`. `cron/route.test.ts`: `vi.stubEnv('ENCRYPTION_KEY', …)` y
   `vi.unstubAllEnvs()` en `afterEach`.

### Tests nuevos (`src/lib/billing/meta-reconciliation.test.ts`)
- «re-downloading REPLACES the window: the same day matched to another number is not summed twice»: dos pasadas,
  mismo día; en la segunda el número cambia de display y el punto cae con config NULL. Queda una fila, y la
  ficha suma 7,40, no 14,80.
- «replacing never touches days outside the window, another WABA or another account».
- «the once-a-day gate is per WABA: with two WABAs, the one that failed is retried next run, the other is not re-asked».
- «partial per WABA: one WABA read after the period end, the other never read → the statement is partial».
- «pagination of the file has a unique tie-breaker (period_start, then id)»: lee el fuente, porque el fake no registra los `order`.
- UI: «a WABA without data is named as such, and a WABA never read says the data is incomplete».
- Ajustados a la nueva forma: el test de fuga A↔B (el `delete` va filtrado por `account_id` y `waba_id`), los de
  `reconcileOne`, el de la ruta de la ficha y las semillas (`whatsapp_config: []`).

### Red
Antes de correr los tests del cron comprobé que `fetch` estaba mockeado: `beforeEach` con un `fetch` que lanza
en `cron/route.test.ts`, y `stubGlobal` antes del `GET` en `tenant-isolation.test.ts`. El resto de llamadas
del barrido en los tests inyecta `fetchAnalytics`. No hubo ninguna salida a la red en esta ronda.

### Compuerta
- `npm run lint`: 0 errores (34 warnings ajenos).
- `npm run typecheck`: verde.
- `TZ=UTC npx vitest run src/lib/billing/meta-reconciliation.test.ts src/app/api/billing/cron src/lib/security/tenant-isolation.test.ts "src/app/api/platform/accounts/[id]/statements" src/components/platform/platform-statements.test.tsx`:
  6 archivos, 198 tests, verde.
- Sin build ni Docker, por orden del humano. La suite completa no se corrió en esta ronda.

### Deuda anotada (hallazgos 4–8, sin arreglar)
- 4: las cuentas que fallan siempre nunca ganan `fetched_at` y van primero en el orden. Con ≥ 10 rotas ocupan el
  lote cada hora y las sanas no se refrescan. Arreglo posible: guardar el último intento (columna o tabla nueva,
  requiere migración).
- 5: `paging.next` no se sigue (añadido al guion, ver arriba).
- 6: una respuesta vacía solo escribe `_none` del día de hoy. Un periodo cerrado sin ninguna pasada sigue saliendo
  «sin dato de Meta», no «Meta: 0».
- 7: tope de 200 suscripciones managed sin rotación: a partir de la 201 (por UUID) nunca se concilian ni aparecen
  en los contadores.
- 8: N+1, ahora una consulta `lastFetchedAt` por cuenta+WABA en serie cada hora (y por WABA al abrir la ficha).
- Pendiente de la primera ronda: el paso 4 de `checks_meta-reconciliation.sql` (borrar un número con snapshots)
  sigue solo descrito, y faltan replay y verify-schema contra Postgres.
