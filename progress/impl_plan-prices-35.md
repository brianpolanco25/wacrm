# p6.3 — `plan-prices-35` (Plan Inicio a 35 USD)

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `aed1d3b`.
Commit: **`d6088eb`** — `feat: subir el plan Inicio a 35 USD al mes`.
Spec: `progress/spec_producto.md` §3 y supuesto S-P2.

## Plan (el que se siguió)

1. Migración `059_plan_inicio_35.sql` idempotente: `UPDATE plans SET price_usd_month = 35,
   price_usd_year = 350 WHERE id = 'inicio'`. `pro` y `negocio` sin tocar.
2. Aserción en `supabase/ci/verify-schema.sql`, dentro del **único** bloque `DO`.
3. `progress/checks_plan-prices-35.sql` ejecutado contra el Postgres del harness (`KEEP=1`).
4. Grep del `29` fijo en `src`, `messages`, `docs`, `supabase`.
5. Tests vitest de los dos criterios.
6. Documentar el efecto sobre el catálogo de PayPal y actualizar el procedimiento de f3.1.
7. `CHANGELOG.md`, compuerta y replay.

## Diff

| Archivo | Qué |
|---|---|
| `supabase/migrations/059_plan_inicio_35.sql` | nuevo. 059 estaba libre (la última era 058). |
| `supabase/ci/verify-schema.sql` | +37 líneas dentro del `DO` existente: los tres niveles con su precio. |
| `src/lib/billing/plan-prices.test.ts` | nuevo. 4 tests. |
| `src/lib/billing/paypal-bootstrap-catalog.test.ts` | la fixture que dice ser «las tres filas del catálogo» pasa a 35/350 para Inicio (y los dos `createPlan` esperados, `35.00` / `350.00`). |
| `docs/docker.md` | §«PayPal catalogue»: qué hacer con una pasarela ya arrancada. |
| `CHANGELOG.md` | nota de «Migration required» + entrada en `Changed`. |

## Criterio ↔ test

| Criterio del spec | Dónde se prueba |
|---|---|
| Tras el replay, `plans` = inicio 35/350, pro 79/790, negocio 199/1990 | `supabase/ci/verify-schema.sql` (tres `IF NOT EXISTS … RAISE`, bloque «059: el precio vigente del catálogo»), ejecutado por `scripts/replay-migrations.sh`; y `progress/checks_plan-prices-35.sql` §1 |
| idem, adelantado a la compuerta (sin base) | `src/lib/billing/plan-prices.test.ts` → `it('cobra el plan Inicio a 35 USD/mes y 350 USD/año')` y `it('no mueve Pro ni Negocio de 79/790 y 199/1990')` (componen semilla 041 + UPDATE 059 leyendo `supabase/migrations/*.sql` en orden) |
| La revisión no reescribe la 041 ni toca los ids de PayPal | `plan-prices.test.ts` → `it('sube el precio con una migración nueva, sin reescribir la 041')` |
| `/billing` y Ajustes → Suscripción muestran 35 sin cambio de código | `plan-prices.test.ts` → `it('interpolan el importe en vez de llevarlo escrito')` (los `Billing.priceMonth` / `priceYear` de `en` y `ko` llevan `{price}` y ningún dígito) + `checks_plan-prices-35.sql` §4, que corre el mismo `SELECT` que `/api/billing/plans` y comprueba que devuelve 35 |
| El bootstrap de PayPal crearía los planes con el precio nuevo | `paypal-bootstrap-catalog.test.ts` → `it('creates the product and six plans and stores their ids')` con la fixture a 35/350 |

## Verificación contra base real

`scripts/replay-migrations.sh "$(pwd)"` → **exit 0**, `059_plan_inicio_35.sql ok`,
`verify-schema.sql: OK`.

`progress/checks_plan-prices-35.sql` contra el contenedor vivo (`KEEP=1`) → **exit 0**.
Comprueba, sobre las 59 migraciones aplicadas en orden:

1. tres filas, con sus precios (35/350, 79/790, 199/1990);
2. que de Inicio solo cambió el precio: `name`, `is_public`, `sort_order`, las ocho claves de
   `limits` y el array `features` siguen como los dejó la 041, y `provider_plan_id_month` /
   `_year` siguen en `NULL`;
3. idempotencia: el UPDATE dos veces, y una tercera tras devolver la fila a 29/290 a mano —
   converge a 35/350;
4. el camino de lectura de `/api/billing/plans` (primer plan público por `sort_order`) devuelve 35;
5. el plan de la prueba gratuita (`pro`, migración 046) sigue en el catálogo.

**Comprobación negativa de la aserción** (que no sea un tick decorativo): con el contenedor
vivo, `UPDATE plans SET price_usd_month = 29 WHERE id='inicio'` y `verify-schema.sql` de nuevo →
salida 3 con
`ERROR: plan 'inicio' is not priced 35/350 (migrations 041 + 059); found 29.00/350.00`.

## Compuerta

Paso a paso, en el worktree:

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 35 warnings (todos preexistentes, ninguno en archivos tocados) |
| `npm run typecheck` | limpio |
| `TZ=UTC npx vitest run --reporter=dot` | 148 archivos, **1988 tests**, todos verdes |
| `npm run build` (con las dummy de `ci.yml`) | OK |
| `scripts/replay-migrations.sh "$(pwd)"` | exit 0 |

## PayPal: por qué esto NO sube el precio en la pasarela (y qué haría falta)

En local no hay ningún plan de PayPal creado: tras el replay,
`plans.provider_plan_id_month` / `_year` de las tres filas están en `NULL` (lo comprueba el
§2 del SQL de checks). Por eso aquí no hay nada que reconciliar. En un despliegue que ya
hubiera corrido el bootstrap de f3.1 la situación es otra, y conviene que quede escrita:

1. **Un plan de PayPal es inmutable de hecho una vez tiene suscriptores.** La 059 no toca los
   ids guardados; el importe que se cobra a quien ya está suscrito lo fija su plan de PayPal,
   no esta fila. Nadie cambia de precio por aplicar la migración.
2. **Reejecutar el bootstrap tampoco lo publica.** `scripts/paypal-bootstrap-catalog.ts` salta
   todo ciclo cuyo `provider_plan_id_*` ya esté guardado (`already …, skipping`). Con los ids
   puestos, el script no crea nada y el precio nuevo se queda solo en la base.
3. **El reemplazo son tres pasos**, y ninguno cae dentro de esta feature:
   - una migración que ponga a `NULL` los dos ids del plan reprecificado (conservando los
     viejos anotados: siguen siendo los de quien está suscrito a ellos);
   - subir el sufijo `-v1` del `PayPal-Request-Id` en `scripts/paypal-bootstrap-catalog.ts`
     (línea 176, `wacrm-${env}-${plan.id}-${cycle}-v1`). Es una clave de idempotencia: con el
     mismo valor PayPal devolvería el plan viejo en vez de crear el nuevo. **Esta es la parte
     fácil de olvidar.**
   - correr el script y migrar a los suscriptores uno a uno (`revise`, ya implementado en
     `src/lib/billing/paypal.ts`), o dejarlos donde están.

   Queda documentado en `docs/docker.md`, §«PayPal catalogue», justo bajo el párrafo que ya
   decía «Do not edit a stored id to change a price».

### Verificación manual pendiente (depende de PayPal, no se puede automatizar)

Solo aplica a un despliegue con catálogo ya creado. Guion, contra **sandbox**:

1. `psql … -c "SELECT id, price_usd_month, provider_plan_id_month FROM plans;"` → confirmar
   que Inicio dice 35 y qué id tiene guardado.
2. `node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts` → debe imprimir seis
   `skipping` y no crear nada (confirma el punto 2 de arriba: la migración no llega a PayPal).
3. En el panel de PayPal sandbox, abrir el plan de Inicio mensual → sigue a 29.00 USD. Ese es
   el hecho que justifica los planes versionados.
4. Con la migración de limpieza de ids y el sufijo `-v2` puestos, correr el script otra vez →
   dos `created` para Inicio a `35.00` / `350.00`, y un checkout de Inicio en `/billing` que
   abra PayPal mostrando 35.00 USD.

## Decisiones donde el spec era ambiguo

- **UPDATE, no resiembra.** El spec dicta el `UPDATE`; lo anoto porque la alternativa natural
  era repetir el `INSERT … ON CONFLICT DO UPDATE` de la 041, y ese bloque reescribe también
  `limits`, `features`, `is_public` y `sort_order`. El UPDATE deja fuera de riesgo lo demás y,
  en particular, no roza los `provider_plan_id_*`.
- **Alcance de la aserción en `verify-schema.sql`.** El spec pedía «aserción»; puse las tres
  (inicio, pro y negocio) porque el fallo realista no es que la 059 no corra, sino que una
  migración futura resiembre el catálogo y pise el UPDATE en silencio — y ese mismo fallo se
  llevaría por delante a Pro y Negocio. Van dentro del bloque `DO` que ya existía: el archivo
  tiene que seguir siendo **una sola** sentencia (está avisado en su propio pie).
- **Qué fixtures de test con `29` se actualizan.** Solo `paypal-bootstrap-catalog.test.ts`,
  porque su comentario afirmaba ser «las tres filas del catálogo sembradas por la 041» y con la
  059 esa afirmación pasaba a ser falsa; ese test alimenta el script que crea los planes de
  PayPal con el precio del catálogo, así que el número importa. Se dejaron como estaban las
  fixtures de `src/app/api/billing/plans/route.test.ts` y
  `src/app/api/billing/checkout/route.test.ts` (`'29.00'`, `'290.00'`): son filas inventadas
  para ejercitar el serializador y el 400 de un ciclo no contratable —conviven con un plan
  `'oculto'` a `'9.00'` que no existe en ningún catálogo—, no pretenden reflejar la tabla, y
  cambiarlas solo habría engordado el diff (CP8).
- **Test del criterio «la UI muestra 35 sin cambio de código».** No había ningún precio fijo en
  `src/`, así que el test no podía ser «se actualizó el texto». Lo que se fija es la propiedad
  que hace cierto el criterio: los textos de precio (`Billing.priceMonth` / `priceYear`, únicos
  sitios donde la UI pinta un importe de plan) interpolan `{price}` y no contienen dígitos; el
  resto del camino (`/api/billing/plans` → `plan-picker.tsx`) ya venía probado.

## Variables de entorno

Ninguna nueva. `.env.local.example` no se tocó (está bloqueado por permisos) y tampoco haría
falta.

## i18n

Ningún texto de UI nuevo (CP6 no aplica): el precio es un dato, y las claves que lo enseñan ya
existían en `en` y `ko`. El nuevo test las verifica en ambos catálogos.

## Deuda detectada fuera de alcance (no arreglada)

1. **El sufijo `-v1` del `PayPal-Request-Id` está escrito a mano** en
   `scripts/paypal-bootstrap-catalog.ts:176`. Es la pieza que hay que recordar subir en cada
   revisión de precios y nada la ata a la fila del plan (podría derivarse del precio, o vivir
   en una columna). Hoy es una nota en `docs/docker.md`.
2. **No hay camino de producto para migrar a los suscriptores a un plan versionado nuevo**:
   `revisePlan` existe en `src/lib/billing/paypal.ts` y lo usa el cambio de plan del cliente,
   pero no hay operación de plataforma que lo haga en lote ni panel que avise de quién quedó
   en un plan retirado. Fuera de p6.3.
3. `src/app/api/billing/plans/route.test.ts` y `checkout/route.test.ts` inventan filas de
   catálogo sin marcar que son ficticias (ids reales `inicio`/`pro` con precios que ya no son
   los del producto). Se lee como si fuera la tabla. Un comentario de dos líneas lo arreglaría.

4. **Ajeno a esta feature, para el líder**: el árbol de trabajo del checkout principal tiene
   `.env.local.example` marcado como **borrado** (`D`), junto a cambios sin commitear en
   `.claude/agents/*.md` y `CHECKPOINTS.md`. No lo toqué (está bloqueado por permisos y mi
   trabajo fue en el worktree); lo apunto porque un borrado de la plantilla pública no parece
   intencionado.

## Estado

Compuerta y replay en verde, commit `d6088eb` en `saas/producto`. Sin push. `feature_list.json`
sin tocar: el paso a `done` lo decide el reviewer.
