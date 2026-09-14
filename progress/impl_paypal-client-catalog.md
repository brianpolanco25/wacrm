# Implementación: f3.1 `paypal-client-catalog`

- **Rama:** `saas/fase-3-facturacion` (worktree `.claude/worktrees/fase-3`)
- **Commits:**
  - `2028607` — `feat: crear el catálogo de PayPal` (implementación inicial)
  - `d44d68e` — `fix: paginar el catálogo de PayPal y probar el bootstrap`
    (corrección tras `progress/review_paypal-client-catalog.md`)
- **Spec:** `docs/saas/fase-3-facturacion.md`, §1
- **Estado:** lista para re-revisión

## Alcance implementado

- Cliente REST de PayPal con OAuth2 de credenciales de cliente, sandbox por
  defecto, renovación de token y errores explícitos
  (`src/lib/billing/paypal.ts`).
- Script manual idempotente `scripts/paypal-bootstrap-catalog.ts`: reutiliza o
  crea un producto y crea los seis planes (tres niveles × ciclos mensual y
  anual), guardando cada id en el catálogo global `plans`.
- Migración idempotente `045_billing_provider_plans.sql` con
  `provider_plan_id_month` y `provider_plan_id_year` (sin cambios en esta
  corrección).
- Documentación de variables y del procedimiento sandbox → live en
  `docs/docker.md`; entrada en `CHANGELOG.md` (Unreleased).

## Qué cambió en la corrección

### Hallazgo 1 — paginación del catálogo de productos

`listProducts` ya no pide solo los primeros 20 productos: recorre
`GET /v1/catalogs/products?page=N&page_size=20&total_required=false` hasta que
una página vuelve corta (PayPal no devuelve cursor de página siguiente) y
devuelve la unión. Así la búsqueda por nombre del bootstrap encuentra el
producto de wacrm aunque la cuenta tuviera un catálogo anterior, en vez de
crear un producto duplicado.

El bucle está **acotado** a 25 páginas (500 productos) y lanza `PayPalError` al
agotarlo: sin tope, un proveedor que respondiera siempre páginas completas
dejaría el script girando para siempre. Se prefirió la paginación a persistir
la identidad del producto porque no exige columna nueva (la migración 045 ya
está fijada por el spec) y porque el nombre del producto ya es la clave de
reutilización documentada.

### Hallazgo 2 — cobertura del criterio central

`bootstrapCatalog` se extrajo del `main()` del script con dos interfaces
inyectables, `CatalogueStore` (leer `plans`, guardar un id) y
`PayPalCatalogueClient` (listar/crear producto, crear plan). `main()` sigue
siendo el único que abre el cliente de Supabase con rol de servicio y el único
que llama a PayPal de verdad; solo se ejecuta cuando el archivo es el punto de
entrada del proceso (`import.meta.url` contra `pathToFileURL(process.argv[1])`),
para que el test pueda importar el módulo sin exigir credenciales.

### Hallazgo 3 — procedimiento sandbox/live

Tres sitios dicen ahora lo mismo: la cabecera del script, la nueva sección
«Going from sandbox to live» de `docs/docker.md` y este informe. La decisión es
la primera de las dos opciones que ofrecía el reviewer: **sandbox y live viven
en bases distintas**, porque las dos columnas guardan ids de un solo entorno y
un id de sandbox no se distingue de uno de live a simple vista. No se
implementa sustitución versionada de ids: cambiar precio con suscriptores exige
un plan nuevo, y eso pertenece a f3.2+.

Como refuerzo ejecutable, una corrida con `env: 'live'` que encuentre filas ya
pobladas emite una línea `WARNING:` explicando que esos ids tienen que ser de
live y que la causa habitual es apuntar a la base equivocada. **Avisa, no
aborta**: abortar haría irrecuperable una corrida de live interrumpida a mitad.

## Criterios y pruebas

| Criterio del spec §1 | Prueba |
| --- | --- |
| Un solo producto: se reutiliza el existente en vez de duplicarlo | `src/lib/billing/paypal-bootstrap-catalog.test.ts` → `it('turns three plan rows into six PayPal plans and stores the six ids')` (afirma `createProduct` no llamado) |
| Un solo producto aunque esté más allá de la primera página | `paypal-bootstrap-catalog.test.ts` → `it('reuses a product that lives past the first page of the catalogue')` (20 productos ajenos en `page=1`, wacrm en `page=2`, cliente real `listProducts` con `fetch` simulado) |
| Paginación del listado a nivel de cliente HTTP | `src/lib/billing/paypal.test.ts` → `it('lists all product pages so the bootstrap reuses its one product')` y `it('gives up instead of paging forever when the catalogue never ends')` |
| Seis planes: tres niveles × dos ciclos, con ciclo y precio correctos | `paypal-bootstrap-catalog.test.ts` → `it('turns three plan rows into six PayPal plans and stores the six ids')` (seis llamadas con su `productId`, `cycle`, `priceUsd` y `requestId`) |
| Los seis identificadores se guardan en `plans` | mismo test: seis `savePlanId` y las dos columnas de las tres filas con su id |
| Creados una vez: la segunda ejecución no crea ni actualiza nada | `paypal-bootstrap-catalog.test.ts` → `it('creates and updates nothing on a second execution')` (0 `createPlan`/`savePlanId` nuevos, filas idénticas, seis líneas `skipping`) |
| Entorno de pruebas primero / no mezclar entornos | `paypal-bootstrap-catalog.test.ts` → `it('warns on a live run when the database already holds provider ids')`; `paypal.test.ts` → `it('uses the sandbox unless PAYPAL_ENV is exactly "live"')` |
| Columnas nuevas en `plans` | `supabase/ci/verify-schema.sql:89-103` + `progress/checks_paypal-client-catalog.sql` |

Total de la vertical: 40 pruebas en `src/lib/billing` (14 nuevas o reescritas
en esta corrección). Suite completa: 85 archivos / 888 pruebas.

## Verificación contra base real

`progress/checks_paypal-client-catalog.sql`, ejecutado contra el Postgres del
harness:

```bash
KEEP=1 scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
docker exec -i wacrm-migrations-14465 psql -U postgres -h localhost -d postgres \
  -v ON_ERROR_STOP=1 < progress/checks_paypal-client-catalog.sql
# BEGIN / DO / DO / DO / DO / ROLLBACK
```

Comprueba, sobre una base limpia con 001–041 y 045 aplicadas:

1. `provider_plan_id_month` y `_year` existen, son `text` y anulables (una base
   de live recién migrada tiene que empezar sin ids).
2. Las tres filas con precio mensual y anual que el bootstrap convierte en seis
   planes.
3. Que una base limpia **no** trae ids de PayPal — la mitad comprobable del
   procedimiento sandbox/live.
4. Las dos pasadas del bootstrap simuladas en SQL: la primera escribe seis ids
   (tres filas × dos columnas), la segunda, que solo toca lo que sigue en
   `NULL`, actualiza 0 filas.
5. Que `plans` no tiene `account_id` (por eso CP3 no aplica al script).

Control negativo ejecutado: borrando `provider_plan_id_year` en una
transacción, la aserción 1 falla con
`ERROR: plans.provider_plan_id_year text NULL is missing`. Las aserciones
muerden.

`scripts/replay-migrations.sh` vuelve a salir 0 con `verify-schema.sql: OK`
(esta corrección no toca SQL de migración).

## Verificación manual pendiente (servicio externo)

PayPal no se llamó: hacerlo exige credenciales reales y crea recursos
permanentes. Guion, contra un sandbox de PayPal:

1. Aplicar 041 y 045 a la base del entorno.
2. `node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts` con
   `PAYPAL_ENV=sandbox`.
3. En PayPal: un producto llamado `wacrm` y seis planes activos (tres nombres ×
   `monthly`/`yearly`), en USD, con los precios de `plans`.
4. En `plans`: los seis ids repartidos en las dos columnas.
5. Repetir el comando: debe imprimir seis líneas `skipping`, no crear planes y
   dejar `plans` igual.
6. Para el caso paginado, crear a mano ≥20 productos ajenos antes del paso 2 y
   comprobar que el paso 3 sigue viendo **un** producto `wacrm`.
7. Promoción a live: los cuatro pasos de «Going from sandbox to live» en
   `docs/docker.md`.

## Compuerta

Verde en el worktree de fase 3:

- `npm run lint` — 0 errores, 37 advertencias preexistentes fuera de alcance.
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — 85 archivos, 888 pruebas.
- `npm run build` con las variables dummy de CI — correcto.
- `scripts/replay-migrations.sh "$(pwd)"` — salida 0.
- `node --check scripts/paypal-bootstrap-catalog.ts` y una ejecución sin
  `PAYPAL_CLIENT_ID` (sale 1 con «Missing env») confirman que la guardia de
  punto de entrada sigue arrancando `main()` cuando toca.

## Decisiones donde el spec era ambiguo

- **Paginación en vez de identidad persistida** (hallazgo 1): el spec fija las
  dos columnas de `plans` y nada más; añadir una tercera para el id del
  producto habría cambiado una migración ya escrita. El nombre del producto ya
  era la clave de reutilización.
- **Tope de 25 páginas**: el spec no dice qué hacer con un catálogo enorme.
  Fallar con un error explícito es preferible a colgar el script.
- **Aviso y no aborto en live** (hallazgo 3): el spec dice «se crean una vez»,
  no cómo detectar la base equivocada. Abortar rompería el reintento de una
  corrida interrumpida, que es el caso legítimo indistinguible.
- **`bootstrapCatalog` exportado desde `scripts/`**: el test vive junto al
  código en `src/lib/billing/` (convención del repo) e importa el script por
  ruta relativa con extensión `.ts`, que es lo que ya habilita
  `allowImportingTsExtensions` (aceptado por el reviewer).

## Variables de entorno

Sin variables nuevas respecto al commit anterior: `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV` y `PAYPAL_PRODUCT_NAME` (opcional), todas
en `docs/docker.md`. `PAYPAL_WEBHOOK_ID` queda para f3.3.
`.env.local.example` está bloqueado por permisos y **no se tocó**: si el humano
quiere las cuatro claves en la plantilla pública, hay que añadirlas a mano.

## Deuda detectada fuera de alcance (no corregida)

- `CHANGELOG.md` y `docs/docker.md` no están formateados según prettier en
  `main`. Pasarles `prettier --write` reescribe entradas viejas enteras, así
  que en esta corrección solo se editaron a mano los párrafos propios; el
  formateo automático se limitó a los archivos de código tocados.
- Ejecutar el script imprime
  `MODULE_TYPELESS_PACKAGE_JSON` para `src/lib/billing/paypal.ts`: el
  `package.json` de la raíz no declara `type: module` y `scripts/package.json`
  solo cubre el directorio del script. Es una advertencia de rendimiento de
  Node, no un fallo; arreglarla toca el manifiesto de la raíz.
- Checkout, URL de retorno, activación por webhook, límites, recibos y UI de
  suscripción siguen siendo f3.2–f3.5.
