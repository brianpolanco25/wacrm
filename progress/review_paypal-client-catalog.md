# Review — f3.1 paypal-client-catalog (re-revisión tras `d44d68e`)

**Veredicto:** APPROVED

Los tres bloqueantes de la revisión anterior están cerrados de verdad, no de palabra: los
comprobé leyendo cada test y ejecutando yo el SQL y la compuerta. Base `saas/fase-0-cimientos`,
worktree `.claude/worktrees/fase-3`, commits `2028607` + `d44d68e`, 10 archivos / 1113
inserciones, worktree limpio. El diff coincide con `progress/impl_paypal-client-catalog.md`.

Queda una corrección de documentación pendiente (hallazgo 1) que no bloquea el merge —esta
feature no enciende la facturación— pero **sí tiene que estar arreglada antes de promover a
live**.

## Compuerta

Ejecutada por el reviewer en el worktree, no leída del informe:

- `npm run lint`: **verde** — 0 errores, 37 advertencias preexistentes (ninguna en archivos nuevos).
- `npm run typecheck`: **verde**.
- `TZ=UTC npm test`: **verde** — 85 archivos, 888 pruebas.
- `npm run build` con las variables dummy de CI: **verde**.
- `scripts/replay-migrations.sh <worktree>`: **verde** — 001–041 y 045 aplicadas, `verify-schema.sql: OK`.
- `progress/checks_paypal-client-catalog.sql` ejecutado por el reviewer contra el Postgres del
  harness (`KEEP=1`, `psql -v ON_ERROR_STOP=1`): `BEGIN / DO / DO / DO / DO / ROLLBACK`, salida 0.

## Cierre de los tres bloqueantes anteriores

1. **Paginación — cerrado.** `src/lib/billing/paypal.ts:198-216`: `listProducts` recorre
   `page=N&page_size=20&total_required=false` hasta página corta, con tope de 25 páginas y
   `PayPalError` al agotarlo. Tests leídos: `paypal.test.ts:102` afirma las URLs exactas de
   `page=1` y `page=2` y la unión de ambas; `paypal.test.ts:134` afirma 26 llamadas a `fetch` y
   rechazo cuando el catálogo no termina. Y el caso de flujo:
   `paypal-bootstrap-catalog.test.ts:195` pone 20 productos ajenos en `page=1` y `wacrm` en
   `page=2`, inyecta el `listProducts` **real** con `fetch` simulado y afirma `createProduct` no
   llamado y `productId === 'PROD-wacrm-page-2'`. Con la implementación anterior (una sola página)
   ese test falla: es la regresión que faltaba.
2. **Cobertura del criterio central y SQL — cerrado.** `bootstrapCatalog` salió del `main()` con
   `CatalogueStore` / `PayPalCatalogueClient` inyectables
   (`scripts/paypal-bootstrap-catalog.ts:90-176`) y guarda de punto de entrada (`:233-239`), así
   que el test importa el módulo sin abrir Supabase ni exigir credenciales.
   `paypal-bootstrap-catalog.test.ts:112` afirma la matriz completa de las seis llamadas
   (`productId`, `cycle`, `priceUsd`, `requestId`) y los seis ids en las dos columnas de las tres
   filas; `:169` corre el bootstrap **dos veces** sobre un store con memoria y afirma
   `createPlan`/`savePlanId` siguen en 6, `plans` idéntico y seis líneas `skipping`.
   El fixture (`:23-48`) reproduce el seed real de `041_billing_model.sql:189-215`
   (29/290, 79/790, 199/1990), no valores inventados.
   `progress/checks_paypal-client-catalog.sql` existe, lo ejecuté y **muerde**: control negativo
   propio — al borrar `provider_plan_id_year` la aserción 1 falla con
   `ERROR: plans.provider_plan_id_year text NULL is missing`; al vaciar los ids antes de la
   segunda pasada, la 4 falla con `second pass updated 3 rows, expected 0`.
3. **Sandbox/live — cerrado en lo que se pidió.** Los tres sitios dicen lo mismo: cabecera del
   script (`scripts/paypal-bootstrap-catalog.ts:13-16`), sección «Going from sandbox to live» de
   `docs/docker.md` y el informe (`impl_…:53-66`): bases separadas, sandbox primero, nunca copiar
   ids. El refuerzo ejecutable está probado: `paypal-bootstrap-catalog.test.ts:230` afirma
   exactamente una línea `WARNING:` en una corrida `live` con ids ya guardados, que el id existente
   **no** se sobrescribe y que solo se crean los 5 planes restantes. El `requestId` lleva el
   entorno (`wacrm-${env}-…`), así que sandbox y live no comparten clave de idempotencia.

## Trazabilidad criterio ↔ test

Criterios de `docs/saas/fase-3-facturacion.md` §1:

- C1 «Un producto» (reutilizar, no duplicar): [x] `src/lib/billing/paypal-bootstrap-catalog.test.ts:112`
  › "turns three plan rows into six PayPal plans and stores the six ids" (`createProduct` no
  llamado) + `:195` › "reuses a product that lives past the first page of the catalogue".
- C2 «Seis planes: tres niveles × mensual y anual»: [x] mismo test `:126-145` — 6 `createPlan` con
  ciclo y precio exactos; `src/lib/billing/paypal.test.ts:186` verifica el cuerpo real
  (`interval_unit: 'YEAR'`, `total_cycles: 0`, `fixed_price` en USD).
- C3 «Se crean una vez»: [x] `paypal-bootstrap-catalog.test.ts:169` › "creates and updates nothing
  on a second execution"; idempotencia en el proveedor vía `PayPal-Request-Id`
  (`paypal.test.ts:186` afirma la cabecera).
- C4 «Contra el entorno de pruebas primero»: [x] `paypal.test.ts:48` › "uses the sandbox unless
  PAYPAL_ENV is exactly 'live'" (incluye `'LIVE'` → sandbox) + `paypal-bootstrap-catalog.test.ts:230`
  para el aviso de mezcla; procedimiento humano en `docs/docker.md` y guion manual en
  `impl_…:117-133`.
- C5 «Los ids se guardan en `plans.provider_plan_id_month` / `_year`»: [x]
  `paypal-bootstrap-catalog.test.ts:148-166`; esquema en
  `supabase/migrations/045_billing_provider_plans.sql:17-19`, aserción en
  `supabase/ci/verify-schema.sql:89-103`, base real en `progress/checks_paypal-client-catalog.sql`
  (ejecutada arriba).
- Servicio externo: [x] guion manual de 7 pasos en `impl_…:117-133`, incluye el caso paginado
  (crear ≥20 productos ajenos) y remite a los cuatro pasos de promoción a live.

## Checkpoints

- CP1 Compuerta: [x] verde, ejecutada por el reviewer.
- CP2 Migraciones: [x] 045 idempotente (`ADD COLUMN IF NOT EXISTS`), sin `CASCADE`, dos aserciones
  en `verify-schema.sql`, replay 0. `d44d68e` no toca SQL de migración.
- CP3 Aislamiento: [x] N/A comprobado, no asumido. El único cliente de rol de servicio vive en
  `main()` (`scripts/paypal-bootstrap-catalog.ts:193-220`) y solo toca el catálogo global `plans`,
  que no tiene `account_id` — aserción 5 del SQL, ejecutada. No hay dato de cuenta, luego no cabe
  test de fuga.
- CP4 Tests: [x] los cinco criterios con test leído; SQL de base real presente y ejecutado; guion
  manual para PayPal.
- CP5 Dependencias: [x] `package.json` y `package-lock.json` sin cambios en el rango.
- CP6 i18n: N/A — no hay UI ni textos nuevos.
- CP7 Next 16: N/A — no se usa ninguna API del framework.
- CP8 Alcance: [x] los 10 archivos pertenecen a §1 (`scripts/package.json` acota `type: module` al
  directorio del script; `tsconfig.json` ya aceptado, no se reabre). La deuda de fuera queda
  anotada, no arreglada.
- CP9 Documentación: [x] con reserva — `CHANGELOG.md` (Unreleased) con nota de migración,
  variables en `docs/docker.md`, informe fiel al diff; pero el paso 3 del procedimiento de live es
  incorrecto (hallazgo 1).
- CP10 Git: [x] dos commits en la rama de fase, asunto en español con prefijo, sin upstream,
  `main` (`46a0999`) y `feat/saas-multiempresa` (`593b92f`) intactos. Menor: `2028607` firma
  `Co-authored-by: OpenAI`, `d44d68e` firma `Co-Authored-By: Claude Opus 5`.
- CP11 Lo entrante nunca se bloquea: [x] el diff no toca webhooks, rutas ni envío.

## Hallazgos (archivo:línea)

Contrastados con el skill `code-review` a nivel `high` sobre `saas/fase-0-cimientos..HEAD`, que
devolvió 8 hallazgos; los verifiqué uno a uno y descarté el que no se sostiene.

1. **`docs/docker.md:95` — corregir antes de promover a live.** El paso 3 dice «In the shell of
   that live deployment» y ahí el script no existe: la etapa `runner` del `Dockerfile:49-51` copia
   solo `.next/standalone`, `.next/static` y `public`; `scripts/` no entra en la imagen. Un
   operador que siga la frase al pie de la letra obtiene
   `Cannot find module '/app/scripts/paypal-bootstrap-catalog.ts'`. Redactar como en la línea 66:
   desde un checkout con `npm ci`, con las variables de la base de live. Es una frase; no bloquea
   el merge porque esta feature no enciende la facturación (así lo dice el `CHANGELOG`), pero sí
   bloquea la promoción.
2. `scripts/paypal-bootstrap-catalog.ts:184` — `PAYPAL_ENV` mal escrito (`production`, `Live`)
   cae a sandbox en silencio. **Falla cerrado** (credenciales de live contra
   `api-m.sandbox.paypal.com` dan 401 y el script aborta sin escribir), por eso no bloquea, pero
   el error que ve el operador es «invalid_client», no «PAYPAL_ENV no es sandbox ni live».
   Rechazar aquí cualquier valor distinto de esos dos; el fallback permisivo de `paypalBaseUrl` sí
   está bien como valor por defecto de librería.
3. `scripts/paypal-bootstrap-catalog.ts:171-172` — el id que acaba de acuñar PayPal se registra
   **después** de `savePlanId`. Si la escritura falla (clave de servicio caducada, 045 sin aplicar),
   el id no aparece en ningún sitio y queda un plan ACTIVE huérfano en live; pasada la ventana de
   retención del `PayPal-Request-Id`, el reintento acuña un segundo plan. Registrar el id antes de
   persistirlo, o re-lanzar el error con el id en el mensaje.
4. `scripts/paypal-bootstrap-catalog.ts:111` — el aviso de entorno cruzado solo salta en
   `env === 'live'`; el caso simétrico (corrida sandbox contra la base de live) pasa en silencio.
5. `scripts/paypal-bootstrap-catalog.ts:157-160` — el guardián de «sin precio» salta `NULL` pero no
   `0`: un futuro plan gratuito llegaría a `createPlan` con `0.00`, que PayPal rechaza con 422 a
   mitad de la corrida. Descartar `<= 0` (y valorar filtrar por `is_public`).
6. `src/lib/billing/paypal.ts:201` — desfase de uno en el tope: un catálogo de exactamente 500
   productos da 25 páginas llenas, el bucle cae al final y `listProducts` lanza aunque la
   enumeración estuviera completa.
7. `src/lib/billing/paypal.ts:224` — `PayPal-Request-Id: product-${name}` revienta con `TypeError`
   (no `PayPalError`) si `PAYPAL_PRODUCT_NAME` —variable documentada y editable por el operador—
   lleva una raya larga, comilla tipográfica o emoji: `Headers` exige ByteString.
8. `supabase/migrations/045_billing_provider_plans.sql:17-19` — nada ata `provider_plan_id_*` al
   precio con el que se creó, y `041_billing_model.sql:185-188` invita explícitamente a revisar
   precios con una migración que re-siembra. Una re-siembra dejaría la UI anunciando el precio
   nuevo y PayPal cobrando el viejo, y el bootstrap saltaría la fila por tener id. Entrada para
   f3.2: la migración de precios debe poner los ids a `NULL`, y conviene un `UNIQUE` en las dos
   columnas (`subscriptions.provider_subscription_id` ya lo tiene en 041; los `NULL` no colisionan
   en Postgres).

Descartado del `code-review`: su `next build` falló en el prerender por falta de `.env.local` en su
entorno; con las variables dummy de CI el build pasa.

## Cambios requeridos

Ninguno bloquea el merge de f3.1. Para el líder, por orden:

1. Commit de solo documentación con el hallazgo 1 antes de que alguien ejecute la promoción a live.
2. Hallazgos 2, 3 y 5 (endurecer `PAYPAL_ENV`, registrar el id antes de persistir, descartar precio
   `<= 0`): baratos y del mismo archivo; caben en f3.2 o en el mismo commit de documentación.
3. Hallazgo 8: decidirlo al escribir la migración de f3.2, no ahora.
