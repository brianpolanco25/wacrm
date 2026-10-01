# impl s9.2 `platform-dashboard`

## Plan
1. Migración `069_platform_metrics.sql`: `platform_metrics()` jsonb, SECURITY INVOKER, solo `service_role`. Ciclo leído de `subscriptions.cycle` (ya existe desde la 056 y el webhook ya lo rellena) en vez de duplicarlo.
2. Aserciones en `supabase/ci/verify-schema.sql` (bloque `-- 069`).
3. `src/lib/platform/metrics.ts`: `loadPlatformMetrics()` (rpc + normalización camelCase) + tests.
4. `GET /api/platform/metrics` con `requirePlatformAdmin()` + tests 401/403/200.
5. Suite de aislamiento: fake RPC, waiver `rpc:platform_metrics`, tests 403 owner / 200 operador sin ids.
6. `PlatformOverview` (cliente): tarjetas + barras SVG propias; carga, error; USD con Intl.NumberFormat. `/platform` lo usa.
7. i18n `Platform.metrics` es/en/ko + tests de render.
8. SQL de base real en `progress/checks_platform-dashboard.sql`.
9. CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer)

Rama `platform/dashboard` (worktree `.claude/worktrees/platform-dashboard`), base `feat/superadmin` @ 785c3ae. Sin push.

| Commit | Qué |
|---|---|
| `73e0746` | feat: migración 069 `platform_metrics()` + aserciones `-- 069` en `verify-schema.sql` |
| `cf5461f` | feat: `src/lib/platform/metrics.ts`, `GET /api/platform/metrics`, tests de ruta y lib, suite de aislamiento (fake RPC, waiver, 2 tests) |
| `6898580` | feat: `PlatformOverview` en `/platform`, i18n `Platform.metrics` es/en/ko, tests de render |
| `461a144` | docs: CHANGELOG (al final del bloque Unreleased) |

## Compuerta (ejecutada en el worktree, HEAD 461a144)
- `npm run lint`: 0 errores (35 warnings, las mismas preexistentes; ninguna en archivos nuevos).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 211 archivos, **2794 tests** verdes (s9.1 dejaba 2770).
- `npm run build` con variables dummy: verde; aparece `ƒ /api/platform/metrics`.
- `scripts/replay-migrations.sh <worktree>`: salida 0 (`ok 069_platform_metrics.sql`, `verify-schema.sql: OK`). La 069 se reaplicó una segunda vez sobre el contenedor vivo sin error (idempotente).

## Archivos
- `supabase/migrations/069_platform_metrics.sql`: `platform_metrics()` jsonb, `SECURITY INVOKER`, `STABLE`, `search_path = public`; REVOKE PUBLIC/anon/authenticated, GRANT service_role.
- `supabase/ci/verify-schema.sql`: bloque `-- 069` antes del `RAISE NOTICE` final (existe, no es SECURITY DEFINER, devuelve jsonb; no ejecutable por authenticated/anon; sí por service_role).
- `src/lib/platform/metrics.ts`: `parsePlatformMetrics()` (pura) y `loadPlatformMetrics()` (`supabaseAdmin().rpc('platform_metrics')`).
- `src/app/api/platform/metrics/route.ts` (+ test).
- `src/components/platform/platform-overview.tsx`: `PlatformOverview` (fetch) + `PlatformOverviewView` (estados loading/error/ready) + `WeeklyBars` (SVG) + `formatUsd`.
- `src/app/(platform)/platform/page.tsx`: usa `PlatformOverview` en vez de `PlatformPlaceholder`.
- `src/lib/security/tenant-isolation.test.ts`: import, fake RPC `platform_metrics`, waiver `rpc:platform_metrics`, describe `/api/platform/metrics`.
- `messages/{es,en,ko}.json`: solo `Platform.metrics.*` (misma estructura y placeholders ICU en los tres).
- `CHANGELOG.md`.
- `/platform/accounts` y `platform-placeholder.tsx` sin tocar.

## Forma del jsonb (`platform_metrics()`)
`generated_at`, `accounts{total, by_status{<status>|none: n}}`, `signups{last_7_days, last_30_days, weekly[12]{week_start, count}}`, `revenue{mrr_usd, arr_usd, paying_accounts}`, `comped`, `delinquent{past_due, suspended, total}`, `whatsapp{connected}`, `messages_month{period_start, inbound, outbound}`. La API lo devuelve en camelCase (`PlatformMetrics`).

## Criterio ↔ test
| Criterio | Test |
|---|---|
| `platform_metrics()` solo `service_role`, misma guarda que 058 | `verify-schema.sql` bloque 069; `progress/checks_platform-dashboard.sql` §3 (`authenticated denied`, `anon denied`) |
| MRR = Σ active/past_due no manual; año/12; ARR = ×12; comped fuera | `checks_platform-dashboard.sql` §1: month 100 + year 1200 + manual → MRR 200, ARR 2400, comped 1, paying 3 (incluye un past_due de precio 0 con `cycle` NULL) |
| Cuentas totales y por estado, `none` sin fila | checks §1 (`total`, `by_status.active`), §2 (`by_status.none` +1); `metrics.test.ts` › `keeps every status key, including none and ones it has never seen` |
| Altas 7/30 y serie de 12 semanas | checks §1 (`last_7_days`, 12 semanas, semana actual con las altas); `metrics.test.ts` › `keeps the weekly series in order and drops entries with no week` |
| Morosos past_due + suspended | checks §1 (`delinquent.past_due`); `platform-overview.test.tsx` › `shows comped apart, and the rest of the counts` |
| WhatsApp conectados; mensajes entrantes/salientes del mes | checks §2b (1 conectado de 2; 2 entrantes del mes, no el del mes pasado; salientes = messages_out 5 + broadcast_recipients 3, sin ai_replies ni el mes anterior) |
| `GET /api/platform/metrics`: 401 sin sesión | `src/app/api/platform/metrics/route.test.ts` › `401s a visitor with no session, and never asks the database` |
| 403 owner de inquilino sin filtrar nada | › `403s a company owner without filtering anything`; `tenant-isolation.test.ts` › `/api/platform/metrics (the Resumen, service role)` › `403s the owner of A, and tells him nothing about the service` |
| 200 operador con la forma del jsonb | route.test › `200s with the Resumen, from ONE call to platform_metrics()`; isolation › `gives a platform admin the whole service in aggregate, with no ids` |
| Error de base → 500 sin filtrar el mensaje | route.test › `500s, without the database error, when the function fails` |
| Normalización robusta (numeric como texto, payload roto) | `src/lib/platform/metrics.test.ts` › `reads numeric strings as numbers…`, `turns a missing or malformed payload into zeros…`, `keeps comped apart from the revenue` |
| Resumen: carga primero, nunca «0» | `src/components/platform/platform-overview.test.tsx` › `opens on the loading state — no card, no zero, no «$0»` |
| Estado de error explícito | › `says so out loud when the load failed, and shows no figures` |
| Tarjetas: cuentas, MRR, ARR, comped, altas, morosos, WhatsApp, mensajes, por estado, semanal | › `has every card of the Resumen`, `shows comped apart, and the rest of the counts`, `lists accounts by status, translated, with unknown statuses verbatim` |
| Dinero en USD con Intl.NumberFormat | › `shows the money in USD (MRR, ARR), in the operator locale`; `formatUsd` › `formats USD whatever the locale…` |
| Barras SVG propias (CP5), 12 semanas | › `draws twelve weekly bars in its own SVG, heights proportional to the count`, `says there is no data rather than drawing an empty chart` |
| i18n es/en/ko (CP6) | › `is translated in %s (CP6)` (3), `every key the component asks for exists in es, en AND ko`; `src/i18n/messages.test.ts` (paridad) |
| Guarda 404 de `/platform` intacta | `src/app/(platform)/platform-guard.test.ts` (sin cambios, verde) |

## Verificaciones contra base real
`KEEP=1 scripts/replay-migrations.sh <worktree>` y luego
`docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < progress/checks_platform-dashboard.sql`
→ salida 0, todo en una transacción con ROLLBACK:
```
NOTICE:  platform_metrics numbers: OK ({"arr_usd": 2400.00, "mrr_usd": 200.00, "paying_accounts": 3})
NOTICE:  by_status.none: OK
NOTICE:  whatsapp + messages of the month: OK
NOTICE:  authenticated denied: OK
NOTICE:  anon denied: OK
```
Las cifras se comprueban como delta sobre una línea base, así que no dependen de una base vacía.

## Verificación manual pendiente (guion)
1. `npm run dev` y entrar como operador → `/platform` muestra «Cargando las métricas…» y después las tarjetas.
2. Comparar MRR con una consulta a mano sobre la base local (`set role service_role; select public.platform_metrics();`).
3. Pasar el ratón por las barras: tooltip nativo «Semana del …: N altas».
4. Cortar la red (DevTools offline) y pulsar «Actualizar» → aviso de error, sin cifras.
5. Revisar contraste de las barras (`fill-primary`, ámbar de marca) en claro y oscuro (no hay test visual).
6. Con un usuario inquilino: `GET /api/platform/metrics` → 403.

## Decisiones donde el spec era ambiguo
- **No se añade `subscriptions.billing_cycle`.** El spec dice «añadir columna `billing_cycle` … si no está»; el encargo del líder la pedía explícitamente. Ya existe `subscriptions.cycle` (056) con exactamente ese significado y CHECK (`month`/`year`, nullable), y el webhook ya la escribe al activar (`webhook-events.ts` activación: `...(intent ? { cycle: intent.cycle } : {})`, test `webhook-events.test.ts` › `billing cycle` › `records the contracted cycle when the subscription activates`), al cambiar de plan (UPDATED) y al renovar. Una segunda columna serían dos verdades. Por tanto tampoco se tocó el checkout ni el webhook. `cycle` NULL cuenta como mensual.
- **Precio del catálogo vigente.** La base no guarda el precio con el que se contrató cada suscripción; el MRR usa `plans.price_usd_*` de hoy. Un suscriptor que conserva un precio anterior (065, decisión 5) cuenta al precio nuevo. s9.3 crea `plan_provider_history` con precios por id de PayPal: un MRR exacto podría leerlo más adelante.
- **Anual sin `price_usd_year`** → cae a `price_usd_month`.
- **Comped** = `provider = 'manual'` con estado distinto de `cancelled`/`expired` (sin exigir `active`).
- **Salientes** = `usage_counters` `messages_out` + `broadcast_recipients` del mes (las difusiones no suman a `messages_out`; las respuestas de IA sí, al enviarse). **Entrantes** = `messages.sender_type = 'customer'` del mes (no hay columna `direction` en `messages`).
- **Morosos** por `status` (`past_due`, `suspended`), sin contar retenciones manuales (`manual_hold_at`), que son otro eje.
- Semanas y mes: `date_trunc` en la zona de la sesión de Postgres (UTC en Supabase), mismo anclaje que `increment_usage`.
- CHANGELOG añadido al final del bloque Unreleased, como pidió el líder (la entrada de s9.1 está arriba).
- `PlatformPlaceholder` se deja intacto (lo siguen usando Planes y Operadores); sus claves `Platform.placeholder.overview`/`cards` quedan sin uso desde `/platform` pero su test sigue verde.

## Variables de entorno nuevas
Ninguna.

## Deuda detectada fuera de alcance
- `messages` no tiene índice por `created_at`: el recuento de entrantes del mes es un recorrido de la tabla. Crear el índice en una migración transaccional bloquearía las escrituras del webhook entrante mientras se construye (CP11); si hace falta, `CREATE INDEX CONCURRENTLY` fuera de migración o un contador `messages_in` en `usage_counters`.
- Cuando s9.3 (Planes) y s9.4 (Operadores) sustituyan sus placeholders, `Platform.placeholder.cards.*` y `overview` quedarán muertas; limpiar junto con `PlatformPlaceholder`.
- `supabase/ci/verify-schema.sql` no tiene aserciones para 067 y 068 (termina en 066 antes de este bloque).
- `.env.local.example`: sin cambios necesarios.
