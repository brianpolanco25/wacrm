# impl p11.1 `meta-payment-method-check`

## Plan (de `specs/meta-payment-method-check/tasks.md`)

1. T1 Migración 079 + bloque `-- 079` en verify-schema + checks SQL (CHECK, trigger authenticated/service_role, cambio de waba_id).
2. T2 `getWabaFundingInfo` en meta-api.ts + test.
3. T3 `payment-method.ts` (clasificación, fetch con timeout, record/checkAndRecord, interruptor, metaBillingOf, metaPaymentBanner) + tests.
4. T4 `sweepPaymentStatus` + bloque `payments` en `/api/webhooks/cron` (fallo aislado) + tests.
5. T5 Paso 10 en embedded-signup y POST config; `publicNumber` con los tres campos + tests.
6. T6 Ruta `POST /api/whatsapp/config/payment-status` + rate limit + tests (fuga A↔B, 409).
7. T7 `metaPayment`/`metaBilling` en `/api/billing/status` + hook + tests.
8. T8 `MetaPaymentAlert` + montaje en dashboard-shell + claves i18n + test.
9. T9 `PaymentStatusBadge` + botón en whatsapp-config + test.
10. T10 Ficha del superadmin + tests.
11. T11 Test de entrante con número `missing` (webhook sin tocar).
12. T12/T13 docs/docker.md, CHANGELOG, compuerta, commit.

## Estado: done (pendiente de reviewer)

- Rama `feat/precios-meta-directo` (worktree `.claude/worktrees/precios-meta-directo`), base `feat/facturacion-gestionada` @ 194e4e6.
- Commits:
  - `8022e28` chore: prettier en dashboard-shell antes de tocarlo (p11.1) — solo formato, el archivo no pasaba prettier en HEAD.
  - `be8ca0f` feat: comprobar el método de pago del WABA en Meta y avisar si falta (p11.1).
- Sin push.

## Compuerta (2026-10-01, en el worktree)

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores (34 warnings ya existentes; ninguno en archivos nuevos) |
| `npm run typecheck` | 0 |
| `TZ=UTC npm test` | 267 archivos, 3816 tests, todos verdes |
| `npm run build` (vars dummy de ci.yml) | 0; rutas nuevas `ƒ /api/whatsapp/config/payment-status` y `ƒ /api/platform/accounts/[id]/payment-status` |
| `scripts/replay-migrations.sh` | 0 (001–076 + 079, `verify-schema.sql: OK`) |
| 079 aplicada dos veces | 0 (solo NOTICE "already exists, skipping") |
| `progress/checks_meta-payment-method-check.sql` | 0, ROLLBACK; NOTICEs R1, R2 (x2), R3, índice |

## Criterio ↔ test

| Req | Archivo | Test (`it`) |
|---|---|---|
| R1 | `progress/checks_meta-payment-method-check.sql` + `verify-schema.sql` bloque `-- 079` | «R1 ok: CHECK rejects foo»; aserciones de columnas, CHECK, índice, disparador |
| R2 | checks SQL | «R2 ok: authenticated cannot write…» (UPDATE forjado → sigue `missing`; INSERT forjado → NULL; `label` sí cambia; A no ve ni toca la fila de B) y «R2 ok: service_role writes» |
| R3 | checks SQL | «R3 ok: waba_id/access_token changes from the browser reset the status» (incluye: la renovación de token con service_role NO resetea) |
| R4 | `src/lib/whatsapp/payment-method.test.ts` | `classifyFundingResponse (R4)` (ok / missing ×3 / unknown ×6); «una sola llamada GET al nodo WABA con el token en Authorization»; «2xx sin primary_funding_id → missing»; «2xx sin id → unknown»; «HTTP 403 sin cuerpo JSON»; «error de red / timeout»; «JSON inválido en un 2xx» |
| R4 | `src/lib/whatsapp/meta-api.test.ts` | `getWabaFundingInfo` «pide id y primary_funding_id…», «un error de Meta sale como MetaApiError con code y status» |
| R5 | `payment-method.test.ts` | «error de permisos de Meta (code %s) → unknown … una sola línea de warn» (10, 200, 100) |
| R6 | `payment-method.test.ts` | «trunca el mensaje a 500 caracteres y nunca escribe el token», «descifra el token de la fila… el token no llega a BD ni consola» |
| R7 | `src/app/api/whatsapp/embedded-signup/route.test.ts` | «ok: checks with the fresh token, scoped to the saved row, after the exchange» (orden `['exchange','payment']`), «missing: 200…», «Meta's check rejected → still 200, same success, payment_status unknown», «a check that throws outright…», «no check at all when the signup fails before saving» |
| R8 | `src/app/api/whatsapp/config/route.test.ts` | «ok: checks the saved row with the token of the form», «missing on an edited row», «Meta's check fails → … plus unknown», «a check that throws outright…», «nothing is checked when the save is refused» |
| R9 | `payment-method.test.ts` | «elige solo los vencidos según su último estado» (NULL, missing 59/61 min, unknown 5/6 h, ok 23/24 h, desconectado, sin WABA), «las cadencias son 1 h / 6 h / 24 h», «como mucho 25 por pasada» |
| R9 | `src/app/api/webhooks/cron/route.test.ts` | «drena y purga con el secreto correcto» (cuerpo completo con `payments`), «p11.1: el bloque payments es aditivo…», «p11.1: sin el secreto no comprueba…» |
| R10 | `payment-method.test.ts` | «la primera fila falla en Meta y la segunda sale ok», «un check que lanza no para el barrido», «una lectura que falla devuelve el resultado vacío sin lanzar» |
| R10 (líder 2) | `cron/route.test.ts` | «p11.1: si el barrido de pagos lanza, el cron responde 200 con el resto intacto» |
| R11 | `src/app/api/whatsapp/config/payment-status/route.test.ts` | «asks for the admin role», «401 without a session», «403 below admin», «200: checks the row with its own token…», «400 without config_id», «429 past 6 per minute…» |
| R12 | `payment-status/route.test.ts` | «404 for B's number from A's session: no fetch, no UPDATE (R12, leak A↔B)»; `payment-method.test.ts` «fila de otra cuenta → null…»; `src/lib/security/tenant-isolation.test.ts` «payment-status on B's number → 404 and B is untouched», «…on A's own number writes only A's row» (pasa el audit de rol de servicio sin waiver) |
| R13 | `payment-method.test.ts` | «isPaymentCheckDisabled — solo "1" apaga», «con el interruptor puesto no lee ni llama a Meta», «con el interruptor puesto no consulta nada» (barrido), «interruptor puesto → nada» (banner); `payment-status/route.test.ts` «409 with META_PAYMENT_CHECK_DISABLED=1…»; `billing/status/route.test.ts` «META_PAYMENT_CHECK_DISABLED=1 → banner null» |
| R14 | `src/app/api/billing/status/route.test.ts` | «reads whatsapp_config of the caller only and never calls Meta» (fetch espiado, filtro `account_id`) |
| R15 | `src/components/billing/meta-payment-alert.test.tsx` | «missing: red banner with the count and the Billing Hub link in a new tab», «missing with one number uses the singular»; `payment-method.test.ts` «números missing → banner rojo con el contador» |
| R16 | `meta-payment-alert.test.tsx` | «banner null, no metaPayment or no status: nothing at all»; `payment-method.test.ts` «todo ok o sin comprobar → nada» |
| R17 | `payment-method.test.ts` | «unknown con plataforma=%s y alta %s → %s» (4 combinaciones); `meta-payment-alert.test.tsx` «unknown: the soft notice…»; `billing/status` «platform mode + embedded number unknown → soft notice», «self-hosted with a token lacking permission → no global notice» |
| R18 | `payment-method.test.ts` | `metaBillingOf` (5 casos), «cuenta managed → nada»; `billing/status` «a managed account gets no banner even with a missing number», «no subscription row → direct» |
| R19 | `billing/status/route.test.ts` | «A never sees B's missing number (R19, leak A↔B)» |
| R20 | `src/components/settings/payment-status-badge.test.tsx` | cuatro estados, «missing is red», «shows when it was last checked…», botón habilitado / deshabilitado sin permiso o ocupado, «managed accounts see nothing», «nothing until it is known who pays Meta»; `config/route.test.ts` `GET … publicNumber` (dos casos) |
| R21 | `src/lib/platform/accounts.test.ts` | «p11.1 (R21): each number carries its payment-method state, scoped to the file» (columnas en el select, sin `access_token`, `.eq('account_id', A)`, B ausente), «a value outside the CHECK reads as never checked»; `src/components/platform/platform-account-detail.test.tsx` (missing en cuenta managed con fecha y botón, unknown con error, ok/pending, sin WABA, inglés); `src/app/api/platform/accounts/[id]/payment-status/route.test.ts` (403, escribe con id + account_id de la URL, 404 para B bajo la URL de A, 404/400, 409) |
| R22 | `src/app/api/whatsapp/webhook/route.test.ts` | «stores it when the number has meta_payment_status = %s (p11.1)» (missing, unknown); `webhook/route.ts` no está en el diff |
| R23 | `payment-method.test.ts` | «no lee ni devuelve readOnly…»; `enforce.ts`, `entitlements.ts`, `billing-status-alert.tsx` y rutas de envío no están en el diff |
| R24 | `meta-payment-alert.test.tsx` | `p11.1 keys exist in es and en with the same placeholders` (20 claves), «the placeholders are the ones the code passes», «no Korean catalogue came back» |

`git diff --stat 194e4e6..HEAD` no incluye `src/app/api/whatsapp/webhook/route.ts`, `src/lib/billing/enforce.ts`, `src/lib/billing/entitlements.ts`, `src/components/billing/billing-status-alert.tsx` ni ninguna ruta de envío (CP8, CP11).

## Verificación contra base real

`KEEP=1 scripts/replay-migrations.sh` + `progress/checks_meta-payment-method-check.sql` (una transacción, ROLLBACK). Dos dueños con su cuenta (handle_new_user), una fila por cuenta sembrada como `postgres` en `missing`. Comprobado: CHECK rechaza `foo`; `authenticated` (claims del dueño de A) no puede poner `ok` ni error ni en UPDATE ni en INSERT, y sí cambia `label`; A no ve ni actualiza la fila de B (RLS 017); `service_role` sí escribe; cambiar `waba_id` o `access_token` desde `authenticated` pone las tres columnas a NULL; una renovación de token con `service_role` no las toca; el índice parcial tiene el predicado esperado. La 079 aplicada dos veces sale 0.

## Verificaciones manuales pendientes (exigen Meta real; las hace el humano)

Supuestos sin verificar, todos de `design.md`: **S-M1** (el nodo WABA expone `primary_funding_id` legible con el token de Embedded Signup), **S-M2** (sin método de pago la respuesta es 2xx con `id` y sin el campo; riesgo principal: Graph omite campos que el token no ve), **S-M3** (`payment_configurations` no sirve; no se usa), **S-M4** (URL del Billing Hub `https://business.facebook.com/billing_hub/payment_settings/`), **S-M5** (un token de usuario de sistema con `whatsapp_business_management` lee el mismo campo; sin permiso, error 10/200 → `unknown`), **S-M6** (desde el 2026-10-01 Meta no entrega sin método de pago; condiciona el texto del banner), **S-M7** (la línea de crédito de Cabbity en cuentas `managed` cuenta como `primary_funding_id`), **S-M8** (`account_review_status` no es el pago; no se usa).

Guion (de `requirements.md`):
1. Graph API Explorer, token de un número conectado por Embedded Signup: `GET /v21.0/{waba_id}?fields=id,primary_funding_id` en un WABA **con** tarjeta y en otro **sin** ella. Anotar aquí las dos respuestas literales. Si no se comportan como R4 (S-M1/S-M2): `META_PAYMENT_CHECK_DISABLED=1` en producción y volver al spec.
2. Repetir con un token de usuario de sistema (configuración manual) — S-M5.
3. Repetir con un WABA en el portafolio de Cabbity (cuenta `managed`) — S-M7.
4. Abrir el enlace del banner y comprobar que lleva al Billing Hub — S-M4.
5. Añadir la tarjeta en el WABA sin pago, pulsar «Comprobar de nuevo» y ver que el banner desaparece en ≤ 30 s (TTL de `useBillingStatus`).

Además (S-M6): el humano aprueba los textos finales de `Billing.metaPayment.missingBody` en es/en.

## Decisiones donde el spec era ambiguo o el líder pidió más

1. **`meta_billing` se lee directamente** (instrucción del líder: la columna existe desde la 076 en esta base). `/api/billing/status` selecciona la columna explícita en vez de `select('*')`; `metaBillingOf()` sigue normalizando (cualquier cosa que no sea `managed` → `direct`). Si se hace cherry-pick sobre una rama sin la 076, esa consulta fallaría con 500: allí habría que volver a `select('*')` como decía el diseño.
2. **Ruta del superadmin nueva**: `POST /api/platform/accounts/[id]/payment-status` (el líder pidió «Comprobar de nuevo» en la ficha; el spec solo pedía mostrar el estado). `requirePlatformAdmin`, `RATE_LIMITS.adminAction`, UUID de la URL, lectura y escritura con `id` + `account_id` de la URL, 409 con el interruptor. **Sin entrada en la bitácora** (`impersonation_log`): no cambia nada del cliente, solo refresca una columna de diagnóstico que el barrido reescribe solo, y añadir una acción al CHECK de la 071 exigiría tocar otra migración. Lo revisa el reviewer.
3. **Filtro del barrido**: el diseño filtraba en SQL solo «comprobado hace más de 1 h» y luego en JS por estado. Con eso, 25 números `ok` comprobados hace 2 h ocupan el lote y un `missing` vencido espera. El `.or()` lleva ya las tres cadencias (`and(meta_payment_status.eq.missing,meta_payment_checked_at.lte.<now-1h>)`, etc., más `checked_at IS NULL` y `status IS NULL`); el filtro JS por `PAYMENT_RECHECK_MS` se mantiene como defensa. Sintaxis `or(... and(...))` de PostgREST, la misma que entiende `fake-supabase`; no verificada contra un PostgREST real (el harness no lo tiene).
4. **`checkAndRecordPaymentStatus` con el interruptor puesto** devuelve `null` sin leer: el alta y el guardado manual responden `payment_status: null` (no es un fallo, es «apagado»); la ruta del botón responde 409 antes de llegar ahí.
5. **Cron**: además de que `sweepPaymentStatus` no lanza, el cron lo envuelve en `try/catch` y, si lanzara, devuelve `payments` vacío con `enabled:false` (punto 2 del líder).
6. **`/api/billing/status`**: la lectura de `whatsapp_config` va en su propio `try`; cualquier fallo (error de PostgREST o excepción) → `banner: null`, nunca 500. En cuentas `managed` o con el interruptor puesto ni siquiera se lee la tabla.
7. **`PaymentStatusBadge`** no pinta nada mientras `metaBilling` no es `'direct'` (también mientras carga o si falla `/api/billing/status`), para que un cliente `managed` no vea ni un instante «Sin método de pago». Solo se muestra en tarjetas con `waba_id`.
8. **Botón del cliente** con `requireRole('admin')` sin `allowReadOnly`: una cuenta en solo lectura recibe 403 del botón (el barrido sigue comprobando). Es la lectura literal del spec; si se quiere que una cuenta suspendida pueda refrescar, sería `allowReadOnly: true` (escribe solo columnas de sistema).
9. **Claves i18n extra**: `Platform.paymentRecheck` y `Platform.paymentRecheckFailed` (el botón de la ficha). En `en.missingBody` el plural cubre también «that number / those numbers».
10. `fetchWabaPaymentStatus` con un 2xx que clasifica `unknown` guarda un mensaje fijo propio («Meta answered without the WABA id…») para que el operador vea por qué.
11. `Settings.whatsapp.paymentCheckedAt` y la ficha formatean la fecha con `toLocaleString()` del dato (sin `Date.now()` en render).

## Variables de entorno nuevas

- `META_PAYMENT_CHECK_DISABLED` (opcional; `1` apaga la comprobación entera). Documentada en `docs/docker.md` junto a `WEBHOOK_CRON_SECRET`, con la nota de los supuestos. **`.env.local.example` no se tocó** (bloqueado por permisos): falta añadir allí `# META_PAYMENT_CHECK_DISABLED=1` comentada.

## Migración en remoto

El remoto está en la 066. Si la 079 se aplica antes que 075–078, el siguiente `supabase db push` encontrará migraciones locales anteriores a la última remota y exigirá `--include-all`. Lo decide y ejecuta el humano. Nota también en `CHANGELOG.md`.

## Deuda detectada fuera de alcance (no arreglada)

- `src/app/(dashboard)/dashboard-shell.tsx` no pasaba prettier en la base; se formateó en un commit aparte (`8022e28`) antes de tocarlo, como en s9.13. `docs/docker.md` tampoco pasa prettier en la base (tabla de redirect URLs, ~línea 350); solo se formateó la tabla nueva.
- Durante una sesión de soporte, `/api/billing/status` lee `whatsapp_config` con el cliente de la sesión; si la RLS no deja ver los números de la cuenta suplantada, el operador verá el CRM sin banner (falla a «nada», no a un falso rojo). No verificado contra la base de soporte de s9.13.
- La señal más fiable sería el código de error de pago en el webhook de estados (§Alternativas 4 del diseño, `131042` sin verificar): seguimiento p11.x propuesto por el spec.
