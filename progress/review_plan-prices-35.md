# Review — p6.3 plan-prices-35

**Veredicto:** APPROVED

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `aed1d3b`, único commit
`d6088eb`. Árbol limpio, sin upstream (nada pusheado).

## Compuerta

Ejecutada por mí, paso a paso, en el worktree:

- `npm run lint`: **verde** — 0 errores, 35 warnings, todos preexistentes y ninguno en los
  archivos del diff.
- `npm run typecheck`: **verde** — `tsc --noEmit` sin salida.
- `TZ=UTC npx vitest run --reporter=dot`: **verde** — 148 archivos, 1988 tests, 0 fallos.
- `npm run build` con las dummy de `ci.yml`: **verde**.
- `scripts/replay-migrations.sh`: **verde** — 001…059 en orden, `059_plan_inicio_35.sql ok`,
  `verify-schema.sql: OK`.

## Verificación contra base real (ejecutada por mí)

Con `KEEP=1` sobre el contenedor del replay:

1. `progress/checks_plan-prices-35.sql` → sin `ERROR`, `BEGIN … ROLLBACK` completo (los cinco
   bloques `DO` y los tres `UPDATE 1` de idempotencia).
2. Volcado directo de la tabla:
   `inicio 35.00/350.00`, `pro 79.00/790.00`, `negocio 199.00/1990.00`, los cuatro
   `provider_plan_id_*` en `NULL`.
3. **La aserción no es decorativa**: tras `UPDATE plans SET price_usd_month=29 WHERE id='inicio'`,
   `verify-schema.sql` aborta con
   `ERROR: plan 'inicio' is not priced 35/350 (migrations 041 + 059); found 29.00/350.00`.

## Trazabilidad criterio ↔ test

- C1 «Tras el replay, `plans` = inicio 35/350, pro 79/790, negocio 199/1990»: [x]
  `supabase/ci/verify-schema.sql:924-960` (tres `IF NOT EXISTS … RAISE`, uno por nivel) +
  `progress/checks_plan-prices-35.sql` §1, ambos ejecutados por mí contra Postgres.
  Adelantado a la compuerta en `src/lib/billing/plan-prices.test.ts` ›
  "cobra el plan Inicio a 35 USD/mes y 350 USD/año" y › "no mueve Pro ni Negocio de 79/790 y
  199/1990": leídos — no comprueban que el archivo exista, reconstruyen el catálogo efectivo
  recorriendo `supabase/migrations/*.sql` en orden y aplicando el patrón de siembra (041) y el
  de `UPDATE` (059); una migración futura que resembrara a 29 los pondría rojos.
- C2 «`/billing` y Ajustes → Suscripción muestran 35 sin cambio de código (leen de `plans`);
  test si algún texto tenía el precio fijo»: [x] verificado por mí que **no** hay precio fijo:
  `grep -rnE '(^|[^0-9.])29([^0-9]|$)'` sobre `src` (sin tests) → 0 resultados; sobre `messages/`
  → 0; sobre `docs/` solo `429` de códigos HTTP en `public-api.md`. El camino real es
  `src/app/api/billing/plans/route.ts:53-54` → `src/components/billing/plan-picker.tsx:169-170`,
  que interpola `t('priceMonth', { price: amount })`. El test que fija esa propiedad,
  `plan-prices.test.ts` › "interpolan el importe en vez de llevarlo escrito", está leído: exige
  `{price}` y **ningún dígito** en `Billing.priceMonth`/`priceYear` de `en` y `ko`
  (`messages/*.json:1802-1803`). Complementado por `checks_plan-prices-35.sql` §4, que corre el
  mismo `SELECT` que la ruta (primer plan público por `sort_order`) y exige 35.
  Nota: `subscription-panel.tsx` (640 líneas) no pinta ningún importe de plan —su parte del
  criterio es vacua, no un hueco de cobertura.
- C3 (spec §3) «Si PayPal ya tuviera planes creados, el precio NO se edita; se documenta que hay
  que crear planes versionados con el bootstrap de f3.1»: [x] `progress/impl_plan-prices-35.md`
  §«PayPal: por qué esto NO sube el precio en la pasarela» —los tres pasos, incluida la trampa
  del sufijo `-v1` del `PayPal-Request-Id` (`scripts/paypal-bootstrap-catalog.ts:176`) como clave
  de idempotencia— más guion manual contra sandbox en 4 pasos (§«Verificación manual
  pendiente»), que es lo que exige CP4 para lo que depende de un tercero. Trasladado al producto
  en `docs/docker.md:205-215`. Apoyo automatizado:
  `src/lib/billing/paypal-bootstrap-catalog.test.ts` › "creates the product and six plans and
  stores their ids", cuya fixture pasa a 35/350 y espera `'35.00'`/`'350.00'` en los `createPlan`.
- C4 (extra, no pedido) «la revisión no reescribe la 041 ni toca los ids de PayPal»: [x]
  `plan-prices.test.ts` › "sube el precio con una migración nueva, sin reescribir la 041":
  exige el literal `'inicio', 'Inicio', 29, 290,` intacto en la 041 y
  `not.toMatch(/provider_plan_id_(month|year)\s*=/)` en la 059.

## Checkpoints

- CP1 Compuerta: [x] los cuatro pasos ejecutados por mí, verdes.
- CP2 Migraciones: [x] `059_plan_inicio_35.sql` con el número que fija el spec (058 era la
  última). Idempotente de verdad: `UPDATE` de valores absolutos, sin incrementos; §3 del SQL de
  checks lo ejerce tres veces, incluida una vuelta manual a 29/290, y converge. 0 filas y sin
  error si el catálogo no existe. Aserción en `verify-schema.sql` **dentro del único bloque
  `DO`** (verificado: un solo `DO $$` en la línea 14 y un solo `$$;` en la 963). Ningún `CASCADE`,
  ningún `DROP`, ninguna columna tocada fuera de las dos de precio.
- CP3 Aislamiento: n/a — el diff no añade ninguna consulta; `plans` es catálogo global sin
  `account_id`.
- CP4 Tests: [x] ver trazabilidad; SQL de base real y guion manual de PayPal, ambos presentes.
- CP5 Sin dependencias nuevas: [x] `git diff aed1d3b..HEAD -- package.json package-lock.json`
  vacío.
- CP6 i18n: n/a — ningún texto de UI nuevo; el test comprueba las claves existentes en `en` y
  `ko`, que son los dos catálogos del repo en esta rama (`es.json` llega en p6.4).
- CP7 Next 16: n/a — no se usa ninguna API de framework.
- CP8 Alcance: [x] 6 archivos, todos justificados por §3 (migración, aserción, dos tests) o por
  CP9 (`CHANGELOG.md`, `docs/docker.md`). La tabla «Diff» del informe coincide exactamente con
  `git diff --stat`. Lo roto fuera va como deuda, no arreglado.
- CP9 Documentación: [x] `CHANGELOG.md` con nota «Migration required» y entrada en `Changed`;
  sin variables de entorno nuevas; informe presente y fiel al diff (verifiqué los números de la
  compuerta y del replay por mi cuenta, no los leí).
- CP10 Git: [x] un commit en `saas/producto`, mensaje en español con prefijo `feat:` y
  `Co-Authored-By`; sin upstream, nada pusheado.
- CP11 Lo entrante nunca se bloquea: n/a — no se toca webhook, cuota ni suspensión.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Observaciones menores, todas ya anotadas por el implementer como deuda:

1. `src/lib/billing/plan-prices.test.ts:47` — el regex de siembra no acepta `public.plans` ni
   valores decimales (`29.00`); si una migración futura siembra con otra forma, el test no la
   vería y pasaría en verde por omisión. El `verify-schema.sql` sí la cazaría, así que el fallo
   se detecta igual, solo que en el replay en vez de en la compuerta. No exige cambio ahora.
2. `src/app/api/billing/plans/route.test.ts:68` y `src/app/api/billing/checkout/route.test.ts:75`
   siguen con `'29.00'`/`'290.00'` bajo ids reales (`inicio`). Son filas inventadas para el
   serializador y el 400 de ciclo no contratable —conviven con un plan `'oculto'` a `'9.00'`—, no
   pretenden reflejar la tabla, y tocarlas engordaría el diff (CP8). Se lee como si fuera el
   catálogo; un comentario de dos líneas lo cerraría. Deuda 3 del informe, correctamente
   clasificada.
3. `scripts/paypal-bootstrap-catalog.ts:176` — el sufijo `-v1` del `PayPal-Request-Id` escrito a
   mano es la pieza que hay que acordarse de subir en cada revisión de precio. Fuera de p6.3, hoy
   cubierto por `docs/docker.md`. Deuda 1 del informe.

## Cambios requeridos

Ninguno.

## Para el líder

El informe (deuda 4) señala que el árbol del checkout principal tiene `.env.local.example`
marcado como borrado junto a cambios sin commitear en `.claude/agents/*.md` y `CHECKPOINTS.md`.
Es ajeno a esta feature y no lo toqué, pero un borrado de la plantilla pública no parece
intencionado.
