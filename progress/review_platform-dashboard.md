# Review — s9.2 platform-dashboard

**Veredicto:** APPROVED

Worktree `.claude/worktrees/platform-dashboard`, rama `platform/dashboard`, rango `785c3ae..461a144`
(4 commits). El diff (14 archivos) coincide con el informe del implementer.

## Compuerta
Ejecutada por el reviewer en el worktree, HEAD 461a144, comando a comando:
- `npm run lint`: verde (0 errores; 35 warnings, las mismas de antes; ninguna en archivos nuevos).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde, 211 archivos y 2794 tests.
- `npm run build` (variables dummy de CI): verde; aparece `ƒ /api/platform/metrics`.
- `KEEP=1 scripts/replay-migrations.sh <worktree>`: verde (`ok 069_platform_metrics.sql`,
  `verify-schema.sql: OK`, sale 0). Reaplicar la 069 sobre el contenedor vivo: sin errores (idempotente).
- `progress/checks_platform-dashboard.sql` contra ese contenedor: las 5 NOTICE en OK, sin ERROR
  (MRR +200, ARR +2400, comped +1, paying +3, `none` +1, WhatsApp +1, entrantes +2, salientes +8,
  `authenticated` y `anon` sin permiso).
- SQL extra del reviewer (transacción con ROLLBACK): `past_due` en un plan de 50/mes, `manual` en uno
  de 70, anual sin `price_usd_year` en uno de 70/mes y `suspended` en uno de 70 → ΔMRR = **120**
  (50 + 70 del anual que cae al mensual; el manual y el suspendido quedan fuera), Δcomped = 1,
  Δmorosos = 2. Así queda cubierto lo que el check del implementer no mira: su `past_due` tiene precio 0.

## Trazabilidad criterio ↔ test
- C1 «`platform_metrics()` solo `service_role`, misma guarda que `platform_account_list`»: [x]
  `verify-schema.sql` bloque 069 (no es SECURITY DEFINER, devuelve jsonb, sin EXECUTE para
  authenticated/anon, con EXECUTE para service_role) + checks §3. Migración: `SECURITY INVOKER`,
  `REVOKE ALL` de PUBLIC/anon/authenticated y `GRANT EXECUTE` a service_role.
- C2 «cuentas totales y por estado de suscripción»: [x] checks §1 (`total` +4, clave `active`), §2
  (`none` +1); `metrics.test.ts` › "keeps every status key, including `none` and ones it has never
  seen"; `platform-overview.test.tsx` › "lists accounts by status, translated, with unknown statuses verbatim".
- C3 «altas últimos 7/30 días»: [x] checks §1 (`last_7_days` +4); la UI, en › "shows comped apart,
  and the rest of the counts" (`2 / 9`). `last_30_days` no tiene aserción en SQL; es la misma
  expresión con otro intervalo, así que lo acepto.
- C4 «MRR = Σ active/past_due, mensual o anual/12 según ciclo; ARR = ×12; comped fuera»: [x] checks §1
  + SQL extra del reviewer (ver arriba); `metrics.test.ts` › "keeps comped apart from the revenue".
- C5 «ciclo leído de `subscriptions` (`billing_cycle` si no está)»: [x] desvío aceptado, ver D1.
- C6 «morosos (past_due, suspended)»: [x] checks §1 (`past_due` +1), SQL extra (+2 con suspended);
  UI › "shows comped apart, and the rest of the counts" (`1 past due · 2 suspended`).
- C7 «números de WhatsApp conectados»: [x] checks §2b (1 connected de 2 filas).
- C8 «mensajes salientes y entrantes del mes»: [x] checks §2b (entrantes +2 y el del mes pasado fuera;
  salientes = messages_out 5 + broadcast_recipients 3, sin ai_replies 7 ni el mes anterior).
- C9 «`GET /api/platform/metrics` con `requirePlatformAdmin()`»: [x] `route.test.ts` › "401s a visitor
  with no session, and never asks the database", "403s a company owner without filtering anything"
  (comprueba `rpcCalls == []`), "200s with the Resumen, from ONE call to platform_metrics()"
  (forma camelCase completa, `no-store`), "500s, without the database error…".
- C10 «tarjetas + serie de altas por semana (12)»: [x] › "has every card of the Resumen", "draws
  twelve weekly bars in its own SVG, heights proportional to the count" (12 `data-week`, 11 barras
  porque una semana vale 0, altura máxima 116); checks §1 (la serie tiene 12 semanas y la actual
  lleva las 4 altas).
- C11 «sin librerías de gráficas (CP5)»: [x] SVG propio; `package.json` no se toca.
- C12 «el censo en `/platform/accounts`, `/platform` es el Resumen»: [x] el censo ya estaba en
  `/platform/accounts` desde s9.1; `page.tsx` cambia `PlatformPlaceholder` por `PlatformOverview`
  y mantiene `guardPlatformPage()`; `platform-guard.test.ts` sigue en verde.
- Extra del líder «la UI arranca en carga, no en ceros»: [x] › "opens on the loading state — no card,
  no zero, no «$0»" renderiza el contenedor real `PlatformOverview` (no la vista con un estado
  inyectado); el `useState` inicial es `{ kind: 'loading' }`. El error sale explícito y sin cifras:
  › "says so out loud when the load failed…".

## Desvíos declarados
- **D1 `cycle` en lugar de `billing_cycle`: aceptado.** `056` añade `subscriptions.cycle` con
  `CHECK (cycle IS NULL OR cycle IN ('month','year'))`; `webhook-events.ts:539` la escribe al activar
  (`...(intent ? { cycle: intent.cycle } : {})`) y `:576-577` la actualiza en UPDATED. `platform_metrics()`
  la lee (`acc.cycle = 'year'`), y NULL cuenta como mes. Una segunda columna sería duplicar la misma verdad.
- **D2 precio del catálogo vigente: aceptado.** Comprobado: `provider <> 'manual'` saca a los comped
  (`provider` es NOT NULL desde la 041, así que `<>` no pierde filas con NULL), y `past_due` suma al
  MRR con su precio (SQL extra: +50).
- **D3 entrantes/salientes: aceptado.** `messages.sender_type` tiene CHECK `customer|agent|bot` (001)
  y no hay columna de dirección. Las llamadas a `recordUsage`: `messages_out` en `send-message.ts:623`,
  `flows/meta-send.ts` y `automations/meta-send.ts`; `broadcast_recipients` en `broadcast-core.ts:485`
  y `api/whatsapp/broadcast/route.ts:398`, que envían con `sendTemplateMessage` y no pasan por
  `send-message`, así que nada se cuenta dos veces; `ai_replies` en `auto-reply.ts:343`, y el propio
  código dice que el `messages_out` va aparte, en `engineSendText`. El periodo usa el mismo anclaje que
  `increment_usage` (`date_trunc('month', now())::date`, 041).
- **D4 sin índice en `messages(created_at)`: aceptado como deuda.** `EXPLAIN` en la réplica:
  `Seq Scan on messages` filtrando por `sender_type` y `created_at`, o sea que recorre la tabla
  **entera**, no solo el mes. Con la cardinalidad real (miles de filas) el recorrido cuesta
  milisegundos, y la función solo corre cuando un operador abre el Resumen: no afecta al webhook.
  Empieza a notarse hacia el millón de filas (del orden de 100 ms o más por carga). Entonces la salida
  es la que propone el informe: `CREATE INDEX CONCURRENTLY` fuera de la migración, o un contador
  `messages_in` en `usage_counters`. Crearlo dentro de una migración transaccional bloquearía los
  INSERT del webhook (CP11), así que no crearlo es correcto.

## Checkpoints
- CP1: [x] compuerta en verde, ejecutada por el reviewer.
- CP2: [x] `069_platform_metrics.sql` (el número que fija el spec); `CREATE OR REPLACE` + REVOKE/GRANT,
  reaplicable; aserción en `verify-schema.sql`; replay sale 0; sin DDL de tablas ni CASCADE.
- CP3: [x] única consulta con rol de servicio: `supabaseAdmin().rpc('platform_metrics')`. Es entre
  cuentas por definición y solo devuelve agregados. El waiver `rpc:platform_metrics` en
  `tenant-isolation.test.ts` sigue el precedente de `rpc:platform_account_list`: la acotan el GRANT
  solo a service_role, que no sea SECURITY DEFINER y `requirePlatformAdmin()`. Tiene dos tests: el
  owner de A recibe 403 sin cifras y con B intacta; el operador recibe 200 sin ids de A ni de B y las
  dos cuentas quedan sin tocar.
- CP4: [x] ver trazabilidad; SQL en `checks_platform-dashboard.sql` y guion manual en el informe.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] `Platform.metrics` tiene 33 claves hoja en es, en y ko, las mismas en los tres, con los
  mismos placeholders (`count`, `pastDue`, `suspended`, `week`). ko usa `=0`/`other`, que es la regla
  CLDR del coreano. Test › "every key the component asks for exists in es, en AND ko". Las claves
  dinámicas `status.*` no las coge esa regex, pero las 8 están en los tres catálogos.
- CP7: [x] `GET()` sin argumentos y página de servidor async, como en
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`.
- CP8: [x] de s9.1 solo se toca `src/app/(platform)/platform/page.tsx`; `platform-placeholder.tsx` y
  `/platform/accounts` quedan igual. Todo lo demás es nuevo o bloques añadidos (isolation, i18n,
  verify-schema, CHANGELOG).
- CP9: [x] CHANGELOG Unreleased con aviso de migración; no hay variables de entorno nuevas; el
  informe coincide con el diff.
- CP10: [x] 4 commits en español con prefijo y `Co-Authored-By`; nada pusheado; `main` sigue en 005f85a.
- CP11: [x] la migración solo crea una función; no hay índice ni bloqueo sobre `messages`; el webhook
  no se toca.

## Hallazgos (archivo:línea)
Ninguno bloqueante.
1. `progress/checks_platform-dashboard.sql` (seed D): el `past_due` de la prueba tiene precio 0, así
   que el check no demuestra que `past_due` sume al MRR. Lo he comprobado yo con el SQL extra (+50).
   Si se quiere dejar fijado, añadir un caso con precio distinto de 0.
2. `supabase/migrations/069_platform_metrics.sql:166-171`: el recuento de entrantes recorre `messages`
   entera (ver D4). Es deuda, no un defecto.
3. Merge: `feat/superadmin` avanzó a 82f0d0c después de la base 785c3ae (fix de s9.1). De esta rama
   solo coincide `CHANGELOG.md`, en otra zona del bloque Unreleased; el conflicto, si sale, es trivial.

4. `supabase/migrations/069_platform_metrics.sql:132,151-154` (code-review): comped y la exclusión
   del MRR dependen de `provider = 'manual'`, y hoy nada escribe ese valor (llega con s9.4). Una
   suscripción puesta a mano en SQL sin cambiar `provider` se queda con el valor por defecto `'paypal'`
   y cuenta como MRR. El spec define comped exactamente así (`provider = 'manual'`), así que no bloquea.
   Queda anotado para s9.4 y para quien asigne planes a mano antes de que exista esa feature (ponerle
   `provider='manual'`).
5. `supabase/migrations/069_platform_metrics.sql:148-149` (code-review): el ARR sale de
   `round(mrr * 12, 2)` sobre el MRR sin redondear. Con un anual de 1000/año, la tarjeta de MRR marca
   83,33 y la de ARR 1000, y 83,33 × 12 da 999,96. Es consistente con la base (Σ precio anualizado),
   pero no con «MRR×12» leído en pantalla. Es cosmético; se puede ajustar sin coste en una migración
   posterior.
6. `069_platform_metrics.sql:152-154` (code-review): un comped `past_due`/`suspended` cuenta a la vez
   en Comped y en Morosos. Es un caso raro (el plan manual no depende de PayPal), sin impacto en el MRR.
7. Otros puntos del code-review que valoro sin exigir cambios:
   - `Stat` y `formatUsd` duplican `MetricCard` y `src/lib/currency.ts`: es mejora de reutilización.
   - La serie semanal hace 12 subconsultas correladas: con miles de cuentas es despreciable.
   - `PlatformPlaceholder` con `section="overview"` y las claves `Platform.placeholder.overview/cards`
     quedan muertas: ya figura como deuda en el informe, y el spec dice que las limpien s9.3 y s9.4.
   - `s-maxage=300` de `next.config.ts` sobre `/platform`: viene de s9.1 y está fuera del alcance de
     s9.2 (la página es dinámica: `guardPlatformPage()` lee la sesión).
   - La posición de la entrada del CHANGELOG la pidió el líder.

## Cambios requeridos
Ninguno.
