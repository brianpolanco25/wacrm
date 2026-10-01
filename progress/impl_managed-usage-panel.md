# s10.5 `managed-usage-panel` — informe de implementación

## Plan

1. `src/lib/billing/meta-usage.ts` (puro + cargadores con rol de servicio filtrados por `account_id`):
   periodo en curso de una cuenta `managed` (desde el último corte / ancla − 1 mes hasta ahora),
   resumen para el cliente del `buildStatement` del ciclo (paquete usado/incluidos, % y aviso 80/100,
   excedente por categoría, estimado al corte = cuota + excedente), recuento del paquete sin tarifas
   para el caso `MetaRateMissingError`, costo estimado de Meta para cuentas `direct` (solo `billable`,
   sin multiplicador) y estimado de un broadcast.
2. `GET /api/billing/meta-usage` (admin+, `allowReadOnly`): `managed` → bloque «Consumo del ciclo»;
   `direct` → cuota gratis por número desde `loadServiceUsage`/`serviceCapState` (p11.3, sin segundo
   conteo) + costo estimado de Meta del mes.
3. `GET /api/billing/broadcast-estimate` (agent+, `allowReadOnly`): {n} × tarifa (`rateFor` en el
   mercado del número emisor); `managed`: cuántos entran en el paquete y cuántos a excedente y a qué
   precio. Tarifa ausente → `ratePending`, no bloquea.
4. UI: `MetaUsageCard` dentro de Ajustes → Suscripción; estimado en el paso 4 del broadcast con
   casilla de confirmación explícita cuando hay excedente (diálogo del cliente, no guarda de servidor).
5. i18n `es`/`en`; tests vitest de lib, rutas, componentes y fuga A↔B en `tenant-isolation.test.ts`.
6. CHANGELOG; lint, typecheck, test (sin build ni replay: Docker apagado, por orden del humano).

## Rama y commits

- Rama `pmd/managed-usage-panel` (worktree `.claude/worktrees/pmd-managed-usage-panel`), base `feat/precios-meta-directo` @ 74a5daa.
- `dc804ef` feat: consumo de Meta en vivo en el panel y estimado antes de cada broadcast (s10.5).

## Compuerta (ejecutada en esta sesión)

- `npm run lint`: 0 errores (34 warnings, todos preexistentes; el único mío —import sin uso— se quitó).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 298 archivos, 4.355 tests, verde.
- `npm run build`: NO ejecutado, por orden del humano (lo corre el líder sobre la rama integrada).
- `scripts/replay-migrations.sh`: no aplica (sin SQL) y Docker apagado.

## Diseño

- `src/lib/billing/meta-usage.ts` — puro + cargadores:
  - `currentCycle({anchor, lastStatementEnd, now})`: ancla (`statement_period_end`) por delante → del corte anterior (regla del cron, `statementPeriodStart`: nunca más de un mes atrás) hasta el ancla; ancla ya pasada (estado emitido esperando pago o cron sin correr) → el ciclo en curso empieza en el ancla y corta un mes después; sin ancla → desde el último estado o un mes atrás.
  - `managedUsageOf(accountId, cycle)`: `buildStatement` sobre `[inicio, ahora]` y `summarizeManaged` → solo lo que ve el cliente (sin `billable`, tarifa de Meta ni costo real; test que lo comprueba). Ante `MetaRateMissingError` → `pendingManaged`: `state: 'rate_pending'`, el paquete se sigue contando (`countPackage`, que no necesita tarifas) y los importes van a `null`. Política de precio inválida → `state: 'pricing_missing'`.
  - `directMetaCost`: solo `pricing_billable = true`, entregados, con categoría, a `rateFor` del día de entrega, sin multiplicador. Lanza `MetaRateMissingError` (nunca precio 0).
  - `packageAlert` / `freeTierAlert` / `percentOf`: aviso `warn` desde el 80 %, `full` al 100 %. Para direct, `full` = `exhausted` de `serviceCapState` (p11.3), así el panel y el aviso de la bandeja nunca discrepan.
  - `directBroadcastEstimate` / `managedBroadcastEstimate`.
- `GET /api/billing/meta-usage` (admin+, `allowReadOnly`): `managed` → bloque del ciclo; `direct` → números con `loadServiceUsage` + `serviceCapState` (la misma RPC y regla que `/api/whatsapp/service-cap`, sin segundo conteo) más `percent`/`alert` y `metaCost` del mes UTC (`serviceMonthWindow`). Tarifa ausente → 200 con `state: 'rate_pending'`.
- `GET /api/billing/broadcast-estimate?recipients=&whatsappConfigId=&category=` (agent+, `allowReadOnly`): número pedido (404 si no es de la cuenta) o el por defecto/el más antiguo; mercado = país de su `display_phone_number`; direct → `n × rateFor`; managed → `remaining = incluidos − usados` del ciclo, `inPackage`, `overage`, `unitPriceUsd = priceFor` (importe fijo sin necesidad de tarifa). Tarifa ausente → `ratePending: true`, 200.
- UI: `src/components/billing/meta-usage-card.tsx` montado en `SubscriptionPanel` (Ajustes → Suscripción) tras «Consumo del ciclo» del plan; `src/components/broadcasts/broadcast-cost-estimate.tsx` en el resumen del paso 4 (`step4-schedule-send.tsx`) y casilla obligatoria en el diálogo de confirmación cuando hay excedente (se reinicia en cada apertura).
- i18n: `Billing.metaUsage.*` y `Broadcasts.wizard.scheduleSend.cost.*` en `es` y `en`; categorías reutilizan `Billing.statements.category.*`.

## Criterio ↔ test

| Criterio (spec §s10.5 + decisiones del líder) | Test |
|---|---|
| managed: barra paquete usado/7.000, excedente por categoría, estimado = cuota + excedente con `buildStatement` | `src/lib/billing/meta-usage.test.ts` › «8.200 delivered (7.000 marketing + 1.200 service): package full, overage by category, estimate = fee + overage»; «is the same figure buildStatement gives for the period (no second count)»; `src/app/api/billing/meta-usage/route.test.ts` › «package used over the included messages, overage by category and the estimate at the cut-off» |
| aviso 80 % y 100 % del paquete | `meta-usage.test.ts` › «the package warns at 80 % and is full at 100 %», «warns at 80 % of the package with no overage»; `src/components/billing/meta-usage-card.test.tsx` › «package bar over the 7.000, 100 % notice…», «80 % notice before the package runs out» |
| periodo en curso (último corte o ancla − 1 mes, hasta ahora) | `meta-usage.test.ts` › describe «currentCycle» (4 its); `meta-usage/route.test.ts` › «the cycle starts at the last cut-off once the anchor has passed» |
| solo entregados con categoría dentro del ciclo | `meta-usage.test.ts` › «counts only delivered messages with a category, inside the cycle» |
| PayPal: cuota por PayPal, al corte solo excedente | `meta-usage.test.ts` › «PayPal: the estimate is fee + overage…»; `meta-usage-card.test.tsx` › «PayPal: says only the overage is billed at the cut-off» |
| `MetaRateMissingError` → aviso «tarifa pendiente», no rompe | `meta-usage.test.ts` › «a missing rate (MetaRateMissingError) is «tarifa pendiente»…»; `meta-usage/route.test.ts` › «a missing Meta rate is «tarifa pendiente»: 200…»; `meta-usage-card.test.tsx` › «a missing rate is a «tarifa pendiente» notice, the panel still renders» |
| el cliente no ve `billable`, tarifa de Meta ni costo real | `meta-usage.test.ts` › «never carries what is internal…»; `meta-usage/route.test.ts` (regex sobre el cuerpo) |
| managed sin barra de cuota gratis de Meta | `meta-usage/route.test.ts` (no llama a `service_quota_usage`); `meta-usage-card.test.tsx` › «no Meta free-quota bar for a managed account» |
| direct: cuota gratis 1.000 por número con barra y avisos 80/100, reutilizando `service_quota_usage`/`serviceCapState` | `meta-usage.test.ts` › «the free tier of a number uses p11.3's «exhausted» for 100 %»; `meta-usage/route.test.ts` › «per number from service_quota_usage (p11.3), 80 % warning…», «a number that exhausted the quota is at 100 %»; `meta-usage-card.test.tsx` › «a bar per number with the 80 % and 100 % notices…» |
| direct: costo estimado de Meta (solo `billable`, sin multiplicador) | `meta-usage.test.ts` › «only the billable deliveries, at Meta's rate, without multiplier», «throws MetaRateMissingError rather than price a message at 0»; `meta-usage/route.test.ts` (metaCost 7,40) y «a missing rate says «tarifa pendiente» and still shows the quota» |
| broadcast: «{n} destinatarios × tarifa de marketing = US$ {x}» con `rateFor` del mercado del número | `src/app/api/billing/broadcast-estimate/route.test.ts` › ««{n} destinatarios × tarifa de marketing» from rateFor in the market of the default number»; `src/components/broadcasts/broadcast-cost-estimate.test.tsx` › «direct: «{n} destinatarios × tarifa de marketing = US$ {x}»» |
| broadcast managed: cuántos al paquete, cuántos a excedente y a qué precio | `broadcast-estimate/route.test.ts` › «how many fit in the package and how many go to overage, at the account's price», «a fixed price per message needs no rate»; `meta-usage.test.ts` › describe «broadcast estimate»; `broadcast-cost-estimate.test.tsx` › «managed: how many fit…», «managed inside the package: no overage» |
| sin tarifa: el texto lo dice y no bloquea | `broadcast-estimate/route.test.ts` › «no rate loaded for the market of the number: 200 with ratePending…», «a multiplier with no rate loaded…»; `broadcast-cost-estimate.test.tsx` › «direct with no rate: says so…», «managed with the price pending a rate», «null on any failure: no line, nothing blocked» |
| confirmación explícita cuando genera excedente (diálogo del cliente) | `broadcast-cost-estimate.test.tsx` › «only a managed send with overage asks for the tick», «the tick carries the overage and its amount», «step 4 disables «Enviar» until the tick, and only in that case» |
| CP3 fuga A↔B en el panel de consumo | `src/lib/security/tenant-isolation.test.ts` › «Meta usage (s10.5, service role)» (3 its: direct, managed, broadcast estimate con número de B → 404) + auditoría global de consultas del rol de servicio; `meta-usage/route.test.ts` › «every read of the service role carries the account» |
| guardas de rol | `meta-usage/route.test.ts` › describe «the guard»; `broadcast-estimate/route.test.ts` › «asks for agent+…», «403s a viewer and reads nothing», «400s a recipients value…» |
| CP6 es/en mismas claves y placeholders | `meta-usage-card.test.tsx` › «es and en carry the same keys and placeholders for the new texts» |

## Verificaciones contra base real

Ninguna: sin SQL nuevo; la RPC `service_quota_usage` y las tablas (075/076/078) ya tienen sus checks en sus features. Docker apagado por orden del humano.

## Verificaciones manuales pendientes (guion)

1. Cuenta `managed` con cargos en `message_charges` del ciclo: Ajustes → Suscripción → bloque «Consumo del ciclo»: la barra cuadra con los entregados con categoría desde el último corte; con > 80 % aparece el aviso ámbar; con ≥ 7.000 el rojo y el excedente por categoría; el estimado = cuota + excedente. Borrar (en local) la tarifa de una categoría usada → aviso «Tarifa pendiente» y el panel sigue.
2. Cuenta `direct` con dos números: barras por número; el que pasó de 800 muestra aviso; el agotado coincide con el aviso de la bandeja (p11.3). Costo estimado = Σ billable × tarifa.
3. Nuevo broadcast → paso 4: aparece «Costo estimado». En cuenta gestionada con paquete casi lleno, «Enviar ahora» abre el diálogo con la casilla y el botón queda deshabilitado hasta marcarla.

## Decisiones donde el spec era ambiguo

- **Categoría del estimado del broadcast**: se usa la categoría de la plantilla (`Marketing`/`Utility`/`Authentication`), por defecto marketing. El spec dice «tarifa de marketing» pensando en este cliente; una plantilla de utilidad estimada a tarifa de marketing exageraría ×6,5 en RD.
- **Mercado del broadcast**: el del número emisor (`display_phone_number`), como fijó el líder; Meta cobra por el país del destinatario, así que con audiencias internacionales es aproximado (el texto dice «estimado»).
- **Managed en el broadcast**: no se muestra la tarifa de Meta (dato interno, igual que en el estado de cuenta), sino el precio del excedente de la cuenta. Se muestran entrantes en el paquete, a excedente, precio unitario e importe.
- **Estimado al corte con PayPal**: se muestra cuota + excedente (texto del spec) y una nota con lo que factura de verdad el corte (solo excedente, `plan_fee_usd = 0`).
- **Ciclo en curso con ancla vencida** (estado emitido sin pagar): lo que se entrega ahora es del próximo estado, así que el ciclo empieza en el ancla.
- **Mes de Meta para direct**: mes natural UTC (`serviceMonthWindow` de p11.3), también para el costo estimado.
- **Rol**: el panel es admin+ (dinero, como `/api/billing/*`); el estimado del broadcast es agent+ (quien puede crear broadcasts). Ambos `allowReadOnly` (son lecturas).
- **Avisos**: `warn` desde el 80 % (incluido), `full` al llegar al 100 %.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` sin cambios; `.env.local.example` no tocado.

## Deuda detectada fuera de alcance

- Durante una sesión de soporte, `src/lib/auth/support-scope.ts` bloquea por ruta todo `/api/billing/`, así que el operador no ve el estimado del broadcast ni el bloque (el fetch falla → no se pinta nada, el envío no se bloquea). Si se quiere que soporte lo vea, habría que exceptuar `/api/billing/meta-usage` y `/api/billing/broadcast-estimate` en esa lista.
- El diálogo de confirmación del paso 4 tiene textos en inglés sin i18n («Confirm Broadcast», «You are about to send…») y «Estimated Reach»/«Language» del resumen, preexistentes.
- `CHANGELOG.md` ya no pasaba `prettier --check` antes de este cambio; no se reformateó.
- El estimado de un broadcast `managed` cuenta el paquete en el momento; dos broadcasts programados seguidos no se descuentan entre sí hasta que Meta confirme las entregas.

## Segunda ronda (review_managed-usage-panel.md, CHANGES_REQUESTED)

Commit `5349031` fix: la confirmación del broadcast espera al estimado y no inventa paquete sin precio (s10.5).

### Cambios

1. **Estado del estimado en el paso 4** (hallazgo 1). `broadcast-cost-estimate.tsx` gana `EstimateState` (`loading | ready | failed`), `estimateKey({recipients, whatsAppConfigId, category})`, `estimateStateFor(answer, currentKey, reachLoading)` y `canConfirmSend(state, consent)`. `step4-schedule-send.tsx` guarda la última respuesta con la clave con que se pidió; una respuesta de otra clave (otro número, otro alcance) cuenta como `loading`, así que el estimado anterior queda invalidado sin `setState` síncrono en el efecto. «Enviar ahora» del diálogo: `disabled={!canSend}`; en carga no confirma (y el diálogo dice «Calculando el costo del envío…»); con excedente solo tras la casilla; `failed` (fetch nulo) envía como hoy (CP11).
2. **Cuenta gestionada sin precio** (hallazgo 2). `broadcast-estimate/route.ts` con `cycle.pricing === null` devuelve `ManagedPricingMissingEstimate` `{metaBilling:'managed', recipients, category, market, pricingMissing:true}` sin `remaining/inPackage/overage`. `ManagedBroadcastEstimate` lleva `pricingMissing:false`. `needsOverageConsent` → `false` en ese caso; el paso 4 pinta `cost.managedPricingMissing` («El precio de tu plan aún no está configurado…»).
3. **Ancla a más de un mes** (hallazgo 3, decisión del líder). `managedUsageOf` captura el `RangeError` de `buildStatement` y devuelve `state: 'no_period'` (incluidos y cuota de la política, sin importes); la tarjeta pinta `metaUsage.noPeriod`. En el estimado del broadcast ese caso deja el paquete entero disponible (`countPackage` no cuenta nada en un periodo futuro), ahora con test.
4. i18n nuevas (es/en, mismas claves): `Billing.metaUsage.noPeriod`, `Broadcasts.wizard.scheduleSend.cost.loading`, `…cost.managedPricingMissing`.

### Tests nuevos

| Requisito | Test |
|---|---|
| en carga / reach contándose → no confirma | `src/components/broadcasts/broadcast-cost-estimate.test.tsx` › «when the dialog may send (step 4)» › «while the estimate of this send is in flight: no» |
| cambio de número/alcance invalida el estimado | idem › «an answer for another number or reach is stale: loading, not the old figure» |
| excedente sin casilla → no; con casilla → sí | idem › «with overage: only after the tick» |
| fallido → envía (CP11) | idem › «a failed estimate never blocks (CP11)» |
| sin excedente / direct / sin precio → envía | idem › «without overage, direct, or pricing not set up: sends as today» |
| cableado del diálogo | idem › «step 4 wires the dialog to canConfirmSend» |
| sin precio: sin reparto, sin casilla, texto | `broadcast-cost-estimate.test.tsx` › «a managed account without a price set up: no invented split, no tick, says so»; `src/app/api/billing/broadcast-estimate/route.test.ts` › «no valid price policy: pricingMissing, without an invented split» |
| ancla > 1 mes: sin periodo, no 500 | `src/lib/billing/meta-usage.test.ts` › «a cycle that starts in the future (anchor more than a month ahead) is «sin periodo en curso», not a 500»; `src/components/billing/meta-usage-card.test.tsx` › «no cycle in progress yet: says so instead of a bar» |
| ancla > 1 mes en el broadcast: paquete entero | `broadcast-estimate/route.test.ts` › «an anchor more than a month ahead: no cycle in progress, the whole package is available» |

### Verificación

- `npm run lint`: 0 errores (34 warnings preexistentes, ninguno en archivos del diff).
- `npm run typecheck`: verde.
- `npx vitest run` sobre `meta-usage.test.ts`, las dos rutas, `meta-usage-card.test.tsx`, `broadcast-cost-estimate.test.tsx` y `src/lib/security/tenant-isolation.test.ts`: 6 archivos, 202 tests, verde.
- Sin build, sin Docker, sin red (condiciones del humano).
- Prettier tocó por accidente `step1/2/3-*.tsx` al formatear con glob; revertidos, no están en el commit.

### Deuda anotada (hallazgos no bloqueantes 4–7, sin tocar por decisión del líder)

- H4 `src/lib/billing/meta-usage.ts` `countPackage` ordena solo por `delivered_at`, sin el desempate por `wamid`/`id` de `buildStatement`: en «tarifa pendiente», dos entregas en el mismo milisegundo en el borde del paquete pueden repartirse por categoría distinto que en el corte.
- H5 `templateCategory` (`broadcast-cost-estimate.tsx`) duplica `asBroadcastCategory` (`meta-usage.ts`).
- H6 `broadcast-estimate/route.ts` pagina todas las filas de `message_charges` del ciclo para un solo número (el paquete usado) y carga `loadAccountNumbers` sin usarlo.
- H7 el tipo `DirectUsage` se declara solo en el cliente (`meta-usage-card.tsx`); la ruta devuelve un literal sin tipar.
