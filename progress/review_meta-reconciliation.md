# Review — s10.7 meta-reconciliation

**Veredicto:** APPROVED (segunda ronda, 1dd5c4a; primera ronda: CHANGES_REQUESTED)

Rama `pmd/meta-reconciliation` @ 50b8183 (un commit) sobre `feat/precios-meta-directo` @ 74a5daa.
El diff (17 archivos) coincide con el informe. `package.json` sin cambios.

## Compuerta
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde, 295 archivos / 4.312 tests. Corrido con un guardia de red propio
  (`NODE_OPTIONS=--import netguard.mjs` que bloquea y registra cualquier `fetch` a un host que no sea
  localhost, heredado por los workers de vitest): **0 peticiones salientes** registradas.
- build: no corrido (orden del humano)
- replay-migrations: n/a (Docker apagado por orden del humano)

## Red en tests (punto crítico)
- `src/lib/security/tenant-isolation.test.ts` › «the cron bills the managed company…»: `vi.stubGlobal('fetch', graph)`
  antes de `GET`, comprueba 1 llamada y ninguna a `waba-b`. Ojo: el `vi.unstubAllGlobals()` (l.4808) va al final
  del cuerpo, no en `finally`/`afterEach`; si una aserción falla antes, el mock queda puesto (no sale a la red,
  pero se filtra a los tests siguientes). No bloqueante.
- `src/app/api/billing/cron/route.test.ts`: `beforeEach` pone un `fetch` que lanza; `afterEach` con `unstubAllGlobals`. Correcto.
- `src/lib/billing/meta-reconciliation.test.ts`: todos los `sweepMetaReconciliation` pasan `fetchAnalytics` mockeado
  salvo los dos tests de la llamada por defecto, que hacen `vi.stubGlobal('fetch', …)`; `afterEach` desmonta.
- Grep de `sweepMetaReconciliation`/`getWabaPricingAnalytics`/`billing/cron`: los únicos invocadores en tests son
  esos tres archivos; `reconcileStatements`/`listAccountStatements` no hacen red. Sin huecos.

## Trazabilidad criterio ↔ test
- C1 «el cron baja `pricing_analytics` (COST+VOLUME por PHONE y PRICING_CATEGORY) y lo guarda en `meta_spend_snapshots`»:
  [x] `meta-reconciliation.test.ts` › "fetches only managed accounts…", "the default Graph call…" (URL, campos, Bearer, token fuera de la URL).
- C2 «solo cuentas managed con número conectado y token»: [x] mismo test (C directa y D desconectada sin llamada ni filas); `route.test.ts` › "the response carries the `reconciliation` block…" (E directa no se pide).
- C3 «como mucho una vez al día por cuenta (`fetched_at`)»: [x] "at most once a day per account…" y la segunda pasada del test del cron. Salvo el hueco del hallazgo 2.
- C4 «respuesta rara → nada guardado; respuesta vacía válida»: [x] "anything odd invalidates the WHOLE answer", "an odd answer stores nothing…", "a valid empty answer stores the `_none` mark…".
- C5 «CP11: nunca lanza ni rompe el cron»: [x] "CP11: Meta failing, a token that cannot be read or the database failing never throw…", "a Graph HTTP error… is a failure, not a throw". En la ruta, el barrido va dentro del `try` y no puede lanzar (todos sus caminos capturan).
- C6 «bloque `reconciliation` en la respuesta»: [x] `route.test.ts` (scanned/fetched/skipped/failed exactos).
- C7 «ficha: diferencia vs `statements`, por WABA»: [x] "the difference is our cost − what Meta reports…", `reconciliation.test.ts` › "per statement: Meta's cost of the period…"; UI `platform-statements.test.tsx` › "shows Meta's cost, ours, the signed difference…".
- C8 «sin dato de Meta cuando no hay snapshot»: [x] "no row in the period → «sin dato de Meta»"; UI "«sin dato de Meta» without a snapshot…".
- C9 «sin ajuste automático, texto de ajuste manual»: [x] UI comprueba el texto `adjust` y ausencia de `<button`.
- C10 «la lista carga si falla la conciliación»: [x] `reconciliation.test.ts` › "the list still loads…".
- C11 «supuesto del formato de Graph con guion manual»: [x] en `impl_meta-reconciliation.md` y `docs/docker.md` (falta el punto de paginación, ver hallazgo 5).
- C12 «esquema 084»: [ ] sin verificar contra Postgres (Docker apagado); revisado a mano, abajo.

## Migración 084 y verify-schema (revisión manual)
- Idempotente: `CREATE TABLE IF NOT EXISTS`, `CREATE INDEX IF NOT EXISTS`, `ENABLE RLS`, `REVOKE`/`GRANT` y `COMMENT` re-ejecutables. `SET lock_timeout='5s'` / `RESET`.
- UNIQUE NULLS NOT DISTINCT dentro de `CREATE TABLE` (requiere PG15+; el harness usa 17.4; confirmar la versión del proyecto alojado antes del `db push`).
- RLS activada sin políticas; `REVOKE ALL FROM anon, authenticated`; `GRANT ALL TO service_role`.
- Único `ON DELETE CASCADE`: `account_id → accounts`, borra solo los snapshots internos de la cuenta borrada. Aceptable. Sin FK en `whatsapp_config_id` (desviación documentada).
- `verify-schema.sql` bloque `-- 084 --`: tabla, 10 columnas, UNIQUE con `indnullsnotdistinct`, 4 CHECKs, 2 índices, RLS, sin políticas, sin SELECT/INSERT de clientes. Correcto en lectura.
- **Sin verificar contra base real**: que la 084 aplica y re-aplica con salida 0; que `verify-schema.sql` pasa; que el `upsert(onConflict: …whatsapp_config_id)` de PostgREST infiere el índice NULLS NOT DISTINCT y no duplica la fila NULL; `progress/checks_meta-reconciliation.sql` entero (su paso 4, borrar un número con snapshots, está solo descrito, no escrito).

## Checkpoints
- CP1: [ ] parcial: lint/typecheck/test verdes ejecutados por mí; build no corrido por orden del humano.
- CP2: [ ] revisada a mano y correcta en lectura; replay no corrido (Docker apagado).
- CP3: [x] lectura de `subscriptions` entre cuentas (el barrido, con waiver justificado); `whatsapp_config` `.in('account_id', ids)`; todo select de snapshots `.eq('account_id')`; upserts con una sola cuenta por lote. Tests de fuga leídos: "A↔B: every write carries the account…" (con `unscopedServiceRoleQueries`), los dos de la ficha y el de `tenant-isolation.test.ts`.
- CP4: [ ] los tests existen y prueban lo que dicen, pero los hallazgos 1 y 2 no tienen test y contradicen el comportamiento declarado.
- CP5: [x] sin dependencias nuevas.
- CP6: [x] `Platform.statements.reconciliation.*` (5 claves) en es y en con los mismos placeholders.
- CP7: [x] no se usa API nueva de Next (route handler y componente cliente ya existentes).
- CP8: [x] alcance acorde a s10.7 (el salto de línea en CHANGELOG l.30 es ruido menor).
- CP9: [x] CHANGELOG, `docs/docker.md`, informe coincide con el diff.
- CP10: [x] un commit en español con prefijo y `Co-Authored-By`; nada pusheado.
- CP11: [x] no toca el entrante; el barrido no lanza.

## Hallazgos (archivo:línea)
1. `src/lib/billing/meta-reconciliation.ts:218-221,271` — **doble conteo.** `whatsapp_config_id` es parte de la clave
   única y nada borra lo que Meta dejó de reportar. Cada pasada vuelve a bajar los días desde el 1 del mes anterior;
   si el casado PHONE→número cambia entre pasadas (un número se desconecta y deja de estar en `configs`, se reconecta
   con otra fila de `whatsapp_config`, o cambia `display_phone_number`), el mismo día+categoría se guarda con otro
   `whatsapp_config_id` (o NULL) **junto** a la fila anterior, y `reconcileOne` suma las dos. Resultado: el costo de
   Meta en la ficha sale duplicado y la diferencia es falsa. Ningún test lo cubre.
2. `src/lib/billing/meta-reconciliation.ts:438,532,607` — el control «una vez al día» y `partial` usan el
   `max(fetched_at)` de la **cuenta**. Con dos WABA, si W1 guarda y W2 falla (o falla el segundo trozo del upsert),
   la cuenta se cuenta `failed` pero en la pasada siguiente queda `skipped` 24 h: W2 no se reintenta, contra lo que
   dicen el informe y `docs/docker.md`, y la ficha no marca el dato de W2 como incompleto.
3. `src/lib/billing/meta-reconciliation.ts:599` — paginación con `.range()` ordenada solo por `period_start`, que no es
   único (varias categorías y números por día). Con más de 1.000 filas (24 estados de cuenta × días × categorías ×
   números lo supera), el orden de los empates entre páginas no está garantizado en Postgres: filas duplicadas u
   omitidas en la suma. Falta un desempate único (`.order('id')`).
4. `src/lib/billing/meta-reconciliation.ts:452` (no bloqueante) — las cuentas que fallan siempre nunca ganan
   `fetched_at` y ordenan primero; con ≥10 cuentas rotas ocupan el lote de 10 cada hora y las sanas no se refrescan nunca.
5. `src/lib/whatsapp/meta-api.ts:349` (no bloqueante, supuesto) — se ignora un posible `paging.next`; si Graph pagina,
   el costo sale incompleto sin marcar `partial`. Añadirlo al guion manual (comprobar si la respuesta trae `paging`).
6. `src/lib/billing/meta-reconciliation.ts:257` (no bloqueante) — una respuesta vacía solo escribe `_none` del día de
   hoy; un periodo ya cerrado durante el que no hubo ninguna pasada sigue saliendo «sin dato de Meta» en vez de «Meta: 0»
   como afirma el informe. Documentarlo o escribir la marca para los días de la ventana.
7. `src/lib/billing/meta-reconciliation.ts:400` (no bloqueante) — tope de 200 suscripciones sin rotación: las cuentas con
   el UUID más alto a partir de la 201 nunca se concilian y no aparecen en ningún contador.
8. `src/lib/billing/meta-reconciliation.ts:438` (no bloqueante) — N+1: una consulta `lastFetchedAt` por cuenta, en serie, cada hora.
9. `src/lib/security/tenant-isolation.test.ts:4808` (no bloqueante) — `vi.unstubAllGlobals()` fuera de `finally`.
   `src/app/api/billing/cron/route.test.ts:473` deja `process.env.ENCRYPTION_KEY` puesto tras el test.

## Cambios requeridos
1. Hallazgo 1: que re-bajar la ventana **reemplace** lo de esa cuenta+WABA en esos días, en vez de sumarse por
   `whatsapp_config_id` (p. ej. borrar las filas de `account_id`+`waba_id` con `period_start` en la ventana devuelta
   antes del upsert, o sacar `whatsapp_config_id` de la clave y guardar los dígitos del PHONE en su lugar; si cambia
   la clave, actualizar la 084, `verify-schema.sql` y `checks_meta-reconciliation.sql`). Test: dos pasadas con el mismo
   día y distinto casado de número → una sola fila (o la suma no se duplica).
2. Hallazgo 2: gate de «una vez al día» por cuenta+WABA (o no actualizar el gate si algún WABA de la cuenta falló), y
   `partial` por WABA o marcado cuando falte la lectura de algún WABA. Test con dos WABA, uno falla, la siguiente pasada lo reintenta.
3. Hallazgo 3: añadir desempate único al `order` de la paginación de `reconcileStatements`.
4. Al guion manual (informe y `docs/docker.md`): comprobar si la respuesta de `pricing_analytics` trae `paging`.

## Segunda ronda — 1dd5c4a

`git log 50b8183..HEAD`: un commit (`fix: la conciliación con Meta reemplaza la ventana y se controla por WABA (s10.7)`,
con `Co-Authored-By`). 11 archivos; sin cambios en `package.json` ni en `supabase/` (084 y `verify-schema.sql` intactos).

### Compuerta (acotada por orden del líder)
- `npm run lint`: 0 errores (34 warnings ajenos). `npm run typecheck`: verde.
- `TZ=UTC npx vitest run` de `meta-reconciliation.test.ts`, `src/app/api/billing/cron`, `tenant-isolation.test.ts`,
  `src/app/api/platform/accounts/[id]/statements` y `platform-statements.test.tsx`: 6 archivos, 198 tests, verde.
- Guardia de red (`NODE_OPTIONS=--import netguard.mjs`): 0 peticiones salientes.
- Sin suite completa, build ni replay (Docker apagado).

### Cambios requeridos
1. [x] Doble conteo. `meta-reconciliation.ts:359-365`: tras un parse válido (no antes: una respuesta rara no borra
   nada) se borra `account_id`+`waba_id` con `period_start` en [inicio de la ventana, ahora] y luego upsert.
   Test "re-downloading REPLACES the window…": misma jornada, el número cambia de display, queda una sola fila
   (NULL) y la ficha suma 7,40 con diferencia 0; sin el `delete` habría dos filas y fallaría. "replacing never
   touches days outside the window, another WABA or another account" deja intactas la fila de septiembre, la de
   otro WABA y la de B con el mismo `waba_id`. El `delete` filtra por `account_id` (CP3) y el test de fuga A↔B lo comprueba.
2. [x] Gate y `partial` por WABA. `lastFetchedAt(db, accountId, wabaId)`; solo se piden los WABA pendientes.
   Test "the once-a-day gate is per WABA…": W-A2 falla, en la pasada siguiente solo se pide W-A2
   (`calls == ['W-A2']`) y se guarda. "partial per WABA…": W-A2 nunca leído → estado `partial`,
   `lastFetchedAt` null y W-A2 «sin dato». La lectura nueva de `whatsapp_config` en la ficha va con `.eq('account_id')`.
   UI con claves nuevas `wabaNoData`/`partialMissing` en es y en, mismos placeholders.
3. [x] `.order('period_start').order('id')` antes de `.range()` (l.681). El test lee el fuente con regex porque el
   fake no registra `order`: es un test débil pero suficiente para un desempate de una línea.
4. [x] `paging`/`paging.next` añadido al guion del informe (punto f) y a `docs/docker.md:558`.
- Hallazgo 9: [x] `finally { vi.unstubAllGlobals() }` en `tenant-isolation.test.ts`; `vi.stubEnv('ENCRYPTION_KEY')` +
  `vi.unstubAllEnvs()` en `cron/route.test.ts`.

### Observaciones (no bloqueantes)
- Una respuesta válida vacía borra lo que había del WABA en la ventana y deja solo `_none` de hoy: si Meta devuelve
  vacío por retraso, la ficha pasa de una cifra a «sin dato» hasta la siguiente lectura buena. Es «lo que Meta dice
  ahora»; anotarlo en el guion manual al confirmar el formato.
- Si falla el upsert tras el `delete`, ese WABA queda sin filas en la ventana hasta el reintento (sin transacción en
  PostgREST). Documentado en el informe; cuenta `failed` y se reintenta.
- Deuda 4–8 anotada en el informe (inanición con ≥10 cuentas rotas, `paging` sin seguir, `_none` de un solo día,
  tope de 200, N+1 ahora por cuenta+WABA).

### Sin verificar contra base real (sigue pendiente para el líder)
- Replay de la 084 dos veces y `verify-schema.sql` con salida 0.
- `upsert(onConflict: …whatsapp_config_id)` de PostgREST contra el UNIQUE NULLS NOT DISTINCT y el `delete` con filtros
  de rango; `progress/checks_meta-reconciliation.sql` (su paso 4 sigue solo descrito).
- Versión de Postgres del proyecto alojado ≥ 15 antes del `db push`.
- Formato real de `pricing_analytics` (guion manual con red y un WABA real).

### Checkpoints (segunda ronda)
- CP1: [ ] parcial (lint/typecheck/tests acotados verdes; sin build ni suite completa por orden). CP2: [ ] sin replay
  (Docker apagado); 084 sin cambios. CP3: [x]. CP4: [x]. CP5: [x]. CP6: [x]. CP7: [x]. CP8: [x]. CP9: [x]. CP10: [x]. CP11: [x].
