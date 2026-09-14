# Review — f3.5 subscription-settings-ui (ronda 2)

**Veredicto:** APPROVED

Rama `saas/fase-3-facturacion`, worktree `.claude/worktrees/fase-3`, rango `08bc791..adf72a0`
(2 commits, 23 archivos; la corrección es `adf72a0`, 10 archivos, +585 −130). Árbol limpio;
`main` en `46a0999`, `dev` en `7ecf644`, `feat/saas-multiempresa` en `593b92f`, intactos.
Nada pusheado.

El bloqueante de la ronda 1 está cerrado y lo he verificado yo con la función de decisión, no
leyéndolo del informe: **no queda ningún camino en que un cliente pague y no reciba servicio**.
Los seis cambios ejecutables están hechos; el séptimo (sandbox) queda pendiente del humano con
los tests de ruta que el líder aceptó como sustituto verificable. Lo que sigue abierto son tres
observaciones reales —una de ellas con consecuencia de dinero *a nuestro favor*, no del cliente—
que no bloquean la fase.

## Compuerta

Ejecutada por mí en el worktree, con las variables dummy de `docs/harness.md`.

- `npm run lint`: **verde** — 0 errores, 37 avisos (línea base exacta; ninguno en archivos de la feature).
- `npm run typecheck`: **verde**.
- `TZ=UTC npm test`: **verde** — **107 archivos, 1 290 pruebas**.
- `npm run build`: **verde** — `✓ Compiled successfully`, `○ /settings`, `ƒ /api/billing/subscription`.
- `scripts/replay-migrations.sh`: **verde**, salida 0 — aplica 040, 041, 045, 046, 047, 048, 049,
  050, 052 y **056**; `verify-schema.sql: OK`.
- `progress/checks_subscription-settings-ui.sql` re-ejecutado por mí contra ese contenedor
  (`KEEP=1`, `psql -v ON_ERROR_STOP=1`): `BEGIN/DO/ROLLBACK ×4`, sin error. El SQL no cambió en
  la ronda 2; la base sobre la que corre, tampoco.

## Reproducción propia del arreglo (no leída del informe)

`decideSubscriptionChange`, fila `status='active'`, `provider_subscription_id='I-OLD'`,
`cancel_at_period_end=true`, `cycle='year'`; intento `{plan_id:'pro', cycle:'month'}`:

| Evento de `I-NEW` | Resultado que obtuve |
|---|---|
| `BILLING.SUBSCRIPTION.ACTIVATED` | `kind:'apply'`, `provider_subscription_id:'I-NEW'`, `status:'active'`, `cancel_at_period_end:false`, `grace_until:null`, `cycle:'month'`, `intentStatus:'activated'` |
| `PAYMENT.SALE.COMPLETED` | idéntico, y `current_period_end` = evento **+1 mes** (2026-03-16 → 2026-04-16), no +1 año |
| ACTIVATED con la misma fila pero `cancel_at_period_end:false` | `kind:'error'` — la regla de f3.3 intacta |
| ACTIVATED con la fila cancelada pero **sin intento** | `kind:'error'` |

Las tres decisiones del líder quedan verificadas en su ejecución: el ensanche de `adopting`
(`webhook-events.ts:372`), el ciclo del intento al adoptar (`webhook-events.ts:703`) y el
`cycle` en el parche (`webhook-events.ts:737`). Que el intento resuelve siempre a la misma
cuenta no es una suposición: `resolveAccount` deriva `accountId` del intento y **relee la fila
por `account_id`** (`webhook/route.ts:377-405`), y corta con `conflict` si dueño e intento
discrepan.

## Trazabilidad criterio ↔ test

Criterios de §6, «Lo que PayPal no hace» y los dos de la lista de aceptación asignados a f3.5.
Los marcados **(r1)** los leí en la ronda 1 y no han cambiado; los demás los leí hoy.

- C1 «El consumo mostrado coincide con `usage_counters`»: [x] `subscription-view.test.ts` ›
  «shows the counter value verbatim, not a derived number», › «does NOT clamp the used figure to
  the limit» (3211 sobre tope 3000 → `used` 3211, solo `percent` se recorta), › «decodes a bigint
  that arrives as a string without changing it»; extremo a extremo `route.test.ts:403` › «shows
  the consumption of usage_counters, unchanged» y `:414` › «counts only the current period, never
  a previous one» (afirma el filtro `period_start`). Releídos hoy. En base real, parte B del SQL,
  re-ejecutada hoy.
- C2 «Un usuario autenticado no puede modificar su propia suscripción ni sus contadores»: [x]
  `checks_subscription-settings-ui.sql` parte A, re-ejecutada hoy: UPDATE/DELETE a 0 filas sobre
  `usage_counters`, INSERT con `insufficient_privilege`, `cancel_at_period_end` y `cycle` a 0
  filas desde `authenticated`, `billing_events` invisible, `agent` con 0 contadores.
- «Plan, estado y próxima fecha de cobro»: [x] `route.test.ts:426` › «reports plan, status, cycle
  and the next charge» (releído); `subscription-view.test.ts` › describe `nextChargeAt` **(r1)**.
- «Consumo por métrica contra el límite, con barras»: [x] `buildUsage` probado entero **(r1)**.
- «Recibos»: [x] describe `parseReceipt` (6 tests) + leak test de la ruta **(r1)**.
- «Cancelar»: [x] `route.test.ts:531` › «cancels at PayPal and only flags the end of the cycle»
  (el parche tiene **exactamente** `cancel_at_period_end`; `status`, `current_period_end` y
  `last_event_at` quietos) y `:553` › «never writes another account (leak test)». Releídos hoy.
- «Reactivar»: [x] › «asks PayPal to resume and writes absolutely nothing», › «sends a cancelled
  subscription to the checkout instead» **(r1)**.
- «Cambiar de plan sin dos suscripciones cobrándose»: [x] `route.test.ts:664` › «revises the same
  PayPal subscription, never opening a second one» (afirma `subscriptionId: 'I-SUB-A'`), `:680` ›
  «writes no plan of its own», `:688` › «hands back the approval link…» con 0 escrituras.
  Releídos hoy.
- «Los cambios de plan se aplican al renovar» (056): [x] describe `billing cycle` (6 tests) +
  `webhook/route.test.ts` › «learns the new billing cycle from the plan the update names (056)».
- **«Volver a contratar tras cancelar funciona» (el bloqueante de la ronda 1): [x]** —
  `webhook-events.test.ts` › describe `re-contracting after a cancellation`, 7 tests leídos uno a
  uno: «takes the row over when the new subscription activates» (afirma `I-NEW`,
  `cancel_at_period_end:false`, `grace_until:null`, `cycle:'month'`, `intentStatus:'activated'`),
  «takes the row over when the first payment arrives first», «charges the new cycle, not the one
  the dead subscription had» (fila `year`, intento `month` → periodo **un mes** y `cycle:'month'`),
  «still refuses a row that is alive with no cancellation scheduled» (`active` y `past_due`),
  «refuses even a scheduled-to-cancel row with no intent behind it», «is never treated as a late
  delivery», «does not adopt on an event that is not a purchase». Los dos tests de f3.3 siguen en
  su sitio y siguen exigiendo el rechazo (`webhook-events.test.ts:260` y `:309`).
- **Pasos 6, 7 y 8 del guion de sandbox, reproducidos con mocks: [x] existen y los leí** —
  `webhook/route.test.ts` › describe «the sandbox script, reproduced with mocks»:
  «step 6 — a month→year change is charged as a year, on one subscription» (`UPDATED` a
  `P-PRO-YEAR` + venta → `cycle:'year'`, periodo a 2027-03-20, **una sola** fila y el mismo `I-1`);
  «step 7 — the CANCELLED event changes nothing the panel already wrote» (`status` sigue `active`,
  bandera puesta, periodo intacto, intento `cancelled`); «step 8 — contracting again after
  cancelling is served, not refused» (200 `processed`, fila sobre `I-NEW`, intento `activated`,
  `scopesOf('subscriptions') === [ACCOUNT_A]`, una sola fila) y «step 8 — and the payment of the
  new subscription extends its own cycle» (periodo a un mes, `cycle:'month'`).
- «Todo el flujo probado en el sandbox de PayPal»: **[ ] pendiente del humano**, aceptado por el
  líder. El guion está en el informe (9 pasos, pasos 6-8 marcados «PENDIENTE DE EJECUTAR POR EL
  HUMANO») y lo que sí está de nuestro lado del cable queda fijado por los cuatro tests de arriba.
- Cambio 3 (guardián de «mismo plan»): [x] con salvedad — `route.test.ts` › «refuses the plan in
  force even when the cycle column is NULL» (409, `reviseSubscription` sin llamar, y afirma
  `['account_id', ACCOUNT_A]` en **todas** las lecturas de `checkout_intents`), › «still lets a
  NULL cycle move to the other cycle of the same plan», › «lets the change through when nothing
  records the plan in force». Ver observación 2: el test monta un estado que la 056 descarta.
- Cambios 4 y 5 (interfaz): [x] verificados leyendo el diff, sin test de runner — el repositorio
  no tiene jsdom ni testing-library y CP5 prohíbe añadirlos; mismo criterio que f3.2 aceptó para
  `plan-picker.tsx`. Los tres retornos van dentro de `RequireRole` con un único `adminOnly`
  (`subscription-panel.tsx:279-308`), el `fetch` está gateado por `canManage`
  (`:148,172,215`) y la cadena de `note` pone `readOnly` por delante (`:323-331`).
- Cambio 7 (prettier): [x] revertido de verdad. `git diff 08bc791..HEAD` de
  `settings-rail.tsx`, `settings-sections.ts` y `settings/page.tsx` es **+27 −1** y **todo** es
  §6: import, `'subscription'` en la lista, `adminOnly` en `SectionMeta` y su entrada, el filtro
  del raíl con `canManageMembers` y el panel en el mapa. Ni una línea de reformateo ajeno.

## Checkpoints

- CP1 Compuerta: [x] las cuatro órdenes verdes, ejecutadas por mí.
- CP2 Migraciones: [x] la 056 no se toca en la ronda 2; replay 0 con la secuencia completa y
  `verify-schema.sql: OK`, re-ejecutado hoy. Idempotente (`ADD COLUMN IF NOT EXISTS`, restricción
  en drop-then-add, `CREATE INDEX IF NOT EXISTS`, backfill acotado a `cycle IS NULL`). Sin
  `CASCADE`.
- CP3 Aislamiento: [x] la ronda 2 **no añade una sola consulta con `supabaseAdmin()`**
  (`git diff 4cd94a4..HEAD | grep supabaseAdmin` → vacío). La única consulta nueva,
  `providerPlanIdInForce` (`subscription/route.ts:206-231`), va por el cliente del usuario y
  filtra `.eq('account_id', ctx.accountId)`, con aserción de ello en el test.
- CP4 Tests: [x] los criterios de §6 tienen test leído; la base real tiene su SQL, re-ejecutado;
  lo que depende de PayPal tiene guion manual **y** los tests de ruta con mocks de los pasos 6-8.
- CP5 Sin dependencias nuevas: [x] `package.json`, `package-lock.json` y `mcp-server/package.json`
  sin una línea de diff en todo el rango.
- CP6 i18n: [x] 1 559 claves en `en.json` y 1 559 en `ko.json`, **conjuntos idénticos** (0
  huérfanas en cada lado, comprobado aplanando los dos catálogos). La ronda 2 no añade claves y
  `Billing.adminOnly` y `Billing.lockedBody` están en los dos. No hay `es.json`.
- CP7 Next 16: [x] `GET()` sin argumentos y `POST(request: Request)` son las firmas de
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:9,31`,
  releído hoy en el árbol. La ronda 2 solo añade hooks de cliente (`useAuth`) en un componente que
  ya era `'use client'`.
- CP8 Alcance: [x] ahora sin el pero de la ronda 1: los tres archivos ajenos vuelven a su
  contenido de `08bc791` salvo las líneas de §6.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased → Fixed) gana tres entradas que describen los
  tres arreglos; `docs/docker.md` no cambia porque la ronda 2 no añade variables;
  `progress/impl_subscription-settings-ui.md` coincide con el diff archivo a archivo (dos
  imprecisiones menores, observación 5).
- CP10 Git: [x] dos commits en la rama de la fase, en español con prefijo y `Co-Authored-By`;
  nada pusheado; `main`, `dev` y `feat/saas-multiempresa` en sus SHAs de partida.
- CP11 Lo entrante nunca se bloquea: [x] el diff no toca `src/app/api/whatsapp/**`.

## Observaciones (no bloquean)

1. **`src/lib/billing/webhook-events.ts:433` — el periodo del cliente que re-contrata no baja, y
   eso ahora se nota.** El clamp de `laterIso` se aplica también al adoptar. Antes daba igual
   (solo se adoptaban filas `cancelled`/`expired`, cuyo periodo ya había pasado); una fila con
   `cancel_at_period_end` tiene por construcción el periodo **en el futuro** (el manejador de
   `CANCELLED` solo deja `status='active'` cuando `paidThrough`). Reproducido por mí: fila anual
   pagada hasta `2027-01-01` que cancela y re-contrata mensual el 2026-03-16 → el parche sale
   **sin `current_period_end`** y la fila conserva 2027-01-01. Consecuencias: (a) el panel dice
   «próximo cobro 2027-01-01» mientras PayPal cobra el 2026-04-16 — la fecha que enseñamos es
   falsa; (b) si luego cancela la mensual, `paidThrough` le regala servicio hasta 2027 por un mes
   de dinero. **No es el daño que la fase persigue** —el cliente nunca recibe menos de lo que
   pagó, y conservar lo pagado es la regla explícita del módulo— pero la fecha del panel sí
   miente. Merece feature propia o una nota: al adoptar, `current_period_end` debería venir de la
   suscripción nueva y el periodo sobrante de la vieja tratarse aparte.
2. **`src/app/api/billing/subscription/route.ts:216-224` — el ramal de `cycle` NULL del guardián es,
   en la práctica, inalcanzable.** El backfill de la 056
   (`056_…sql:68-75`) casa por `(provider, provider_subscription_id)` y `checkout_intents.cycle`
   es `NOT NULL CHECK (cycle IN ('month','year'))` (`048_checkout_intent.sql:47`), que es
   exactamente la clave y la columna que consulta el fallback. Es decir: tras la 056, `cycle IS
   NULL` con `provider_subscription_id` puesto implica que **no hay intento que casar**, el
   fallback devuelve `null` y el `revise` pasa igual que antes. El test que lo cubre siembra a la
   vez un intento y un `cycle` NULL, combinación que el esquema descarta. El cambio 3 sigue siendo
   una mejora real (compara `provider_plan_id` en vez de un `===` de ciclos, que era falso
   siempre), pero para esas filas residuales el 409 sigue sin darse. Efecto: un `revise` redundante
   sobre el plan vigente; PayPal no cobra por ello. Sigue siendo «menor», como en la ronda 1.
3. **`src/components/settings/subscription-panel.tsx:279` — el admin legítimo ve «solo
   administradores» antes que el panel.** `RequireRole` renderiza el `fallback` mientras
   `profileLoading` (`require-role.tsx:41`), y el fallback es ahora la tarjeta `adminOnly`. El
   arreglo del cambio 4 es correcto para el `agent`; para el `owner`/`admin` cambia un spinner por
   un mensaje equivocado durante la carga del perfil. Un placeholder neutro (o el spinner como
   fallback) conservaría las dos propiedades.
4. **Deuda de orden, estrecha.** Ensanchar la adopción también abre, en teoría, que un evento
   **nunca procesado** de la suscripción muerta llegue después de una cancelación posterior y
   vuelva a apropiarse de la fila. Está acotado por la idempotencia de `billing_events` (una
   reentrega del mismo evento no se reprocesa) y por la exigencia de intento, y el periodo nunca
   retrocede; pero conviene tenerlo anotado junto a la deuda 2 del informe.
5. **Dos imprecisiones del informe** (CP9, sin efecto): dice «+28 −1» en los tres archivos de
   Ajustes y el diff real es **+27 −1**; y «48 claves» en `Billing.subscription` cuando son **50**.

Contrasté con `code-review` a nivel `high` sobre `4cd94a4..adf72a0`: sus tres hallazgos son mis
observaciones 1, 2 y 3, y los verifiqué yo mismo —el 1 con reproducción propia de
`decideSubscriptionChange`, el 2 leyendo el backfill de la 056 y el `NOT NULL` de la 048—. No
encontró nada en aislamiento, i18n, idempotencia ni en la regla de adopción, y confirma por su
lado que el ensanche no abre doble cobro (`availableActions` devuelve `reactivate:'checkout'`
siempre que `cancelAtPeriodEnd`, y el `POST` exige `'activate'`), que es también mi lectura.

## Cambios requeridos

Ninguno. Queda pendiente **del humano**, no del implementer: correr los pasos 6, 7 y 8 del guion
de sandbox de `progress/impl_subscription-settings-ui.md` contra PayPal antes de poner la fase en
producción —lo que un mock no puede contestar es si `revise` acepta mover una suscripción entre
planes de distinta frecuencia (deuda 1 del informe)—, y decidir si la observación 1 se arregla
ahora o se abre como feature.
