# Estado actual

## Tarea de integración: merge de `saas/fase-2-seguridad` en `saas/integracion`

Worktree `.claude/worktrees/integracion`, rama `saas/integracion` (HEAD `96e02fa` =
`saas/fase-1-bandeja`, que ya trae fase 0).

Plan:

1. `git merge --no-ff saas/fase-2-seguridad` y resolver los cuatro conflictos
   conservando ambos lados: `CHANGELOG.md`, `supabase/ci/verify-schema.sql`,
   `src/lib/automations/engine.ts`, `src/app/api/whatsapp/webhook/route.test.ts`.
2. Correr la suite de aislamiento de fase 2 sobre el código de fase 1 y arreglar con
   filtro de `account_id` (nunca con waiver) cualquier consulta de rol de servicio que
   destape: candidatas `reply-marker.ts`, `pick_available_agent`, `auto-reply.ts`.
3. Compuerta completa + `scripts/replay-migrations.sh` (040-044, 047, 051).
4. Commit de merge; si hubo arreglo de fase 1, commit `fix:` aparte.
5. Informe en `progress/impl_integracion-fase-2.md`.

Terminado. Merge `9680b68` (mensaje por defecto + trailer). Sin commit `fix:`: la
auditoría de fase 2 no destapó ninguna consulta de rol de servicio de fase 1 sin
`account_id` (revisadas a mano `reply-marker.ts`, `auto-reply.ts`, `engine.ts`,
`usage.ts`, `config.ts` y `entitlements.ts`; la única sin cuenta es
`claim_ai_reply_slot`, preexistente en `main`). Compuerta verde: lint 0 errores/37
warnings, typecheck limpio, `TZ=UTC npm test` 99 archivos / 1 168 tests,
build OK, `scripts/replay-migrations.sh` exit 0 con 040-044, 047 y 051.
Informe: `progress/impl_integracion-fase-2.md`.

Terminado. Commit `1446796` en `saas/fase-3-facturacion`. Compuerta verde (lint 0 errores /
37 warnings preexistentes, typecheck, 105 archivos y 1193 tests, build). Sin SQL tocado, así
que no se repitió el replay. Sin claves i18n nuevas (las correcciones no añaden texto de
interfaz; `en.json` y `ko.json` siguen en paridad). Informe actualizado en
`progress/impl_enforce-limits.md`. Pendiente de re-revisión.

---

Feature en curso: f3.4 — enforce-limits (ronda final, cierre de los tres defectos que el
reviewer dejó como trabajo de seguimiento tras aprobar `1446796`).

Plan:

1. **A — `numbers` bloquea cambiar de número.** `src/app/api/whatsapp/config/route.ts`: contar
   las filas de la cuenta excluyendo por **identidad de fila** (la fila que se está editando,
   resuelta antes del cheque), no por `phone_number_id`. Corregir el comentario y rehacer el
   test `:174` que canoniza el fallo: (1) editar la fila existente con `numbers: 1` → 200;
   (2) el 402 con un plan sin hueco, escenario alcanzable hoy; documentar que el tope por
   multi-fila es inalcanzable mientras viva `UNIQUE(account_id)` (lo retira f4.2).
2. **B — §5 no llega a flujos ni automatizaciones.** `assertWritable` junto al `assertQuota`
   ya presente en `src/lib/flows/meta-send.ts` (×3) y `src/lib/automations/meta-send.ts` (×1).
   Tests: cuenta `suspended` → no sale nada a Meta, nada se persiste, nada se cuenta; el
   motor se traga el rechazo (dispatch no lanza) y el entrante sigue guardándose antes de
   que se pregunte a ningún motor (CP11).
3. **C — contactos creados por una campaña rechazada.** `src/lib/whatsapp/broadcast-core.ts`:
   sanear, descartar inválidos y colapsar teléfonos repetidos **sin tocar la base**, pesar ahí
   (cota superior de la campaña) y solo después crear contactos. El cheque exacto posterior
   queda cubierto por el primero; comentario corregido.
4. Compuerta completa + informe (`Ronda final`) + CHANGELOG.

Terminado. Commit `08bc791` en `saas/fase-3-facturacion` (12 archivos, sin SQL). Compuerta
verde: lint 0 errores / 37 warnings preexistentes, typecheck limpio, `TZ=UTC npm test` 105
archivos y 1 204 tests, build `Compiled successfully`. Sin replay: la ronda no toca SQL. Sin
claves i18n nuevas (`en.json` y `ko.json` intactos y en paridad). `CHANGELOG.md` actualizado
en las dos viñetas de la fase. Informe: sección «Ronda final» de
`progress/impl_enforce-limits.md`. Pendiente de revisión.

---

Feature en curso: f4.4 — impersonation-audit (fase 4, base de §2 «Panel de plataforma»).

Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4` (HEAD `9680b68`).

Plan:

1. `supabase/migrations/055_platform_admins.sql`: `platform_admins`, `impersonation_log`
   (sin FK hacia `accounts`/`auth.users` para que la bitácora sobreviva al borrado),
   `is_platform_admin(uuid)` SECURITY DEFINER, RLS de solo lectura para platform admins.
   Aserciones en `verify-schema.sql` y `progress/checks_impersonation-audit.sql`.
2. `src/lib/auth/platform.ts` — `requirePlatformAdmin()`; `src/lib/auth/admin-client.ts`.
3. `src/lib/auth/impersonation.ts` — cookie de soporte firmada con HMAC-SHA256 derivado de
   `ENCRYPTION_KEY`, 30 min de vida; `getCurrentAccount()` resuelve la cuenta impersonada
   con rol efectivo `viewer`.
4. Rutas `/api/platform/impersonate` (GET estado, POST inicio) y
   `/api/platform/impersonate/stop` (POST). Bitácora en inicio y fin.
5. Middleware: bloqueo global de escrituras mientras hay sesión de soporte (defensa en
   profundidad), con el webhook de WhatsApp y `/api/v1` explícitamente fuera (CP11).
6. Aviso persistente en la UI (`impersonation-banner.tsx`) + claves en `en.json`/`ko.json`.
7. Rutas nuevas añadidas a `src/lib/security/tenant-isolation.test.ts`.
8. Compuerta + replay; informe en `progress/impl_impersonation-audit.md`.

---

Feature en curso: f3.5 — subscription-settings-ui (fase 3, §6 «Área de suscripción»).

Rama `saas/fase-3-facturacion`, worktree `.claude/worktrees/fase-3` (HEAD `08bc791`).

Plan:

1. `supabase/migrations/056_subscription_cycle_and_receipts.sql`:
   `subscriptions.cycle` (nullable, CHECK month|year, backfill desde `checkout_intents`)
   — cierra la deuda 3 de `impl_paypal-webhook.md`, que la propia f3.3 dejó para f3.5 y
   que el cambio de plan de §6 vuelve obligatoria (un month→year renovaría por un mes) —
   más el índice de expresión que hace barata la consulta de recibos sobre
   `billing_events`. Aserciones en `verify-schema.sql`.
2. `paypal.ts`: `cancelSubscription`, `activateSubscription`, `reviseSubscription`
   (mocks en tests; nada real).
3. `src/lib/billing/subscription-view.ts` (puro): consumo contra límites, recibos a
   partir del payload de `PAYMENT.SALE.COMPLETED`, y qué acciones caben en cada estado.
4. `src/app/api/billing/subscription/route.ts` — GET (plan, estado, fechas, consumo,
   recibos) y POST (`cancel` | `reactivate` | `change_plan`), `requireRole('admin')` con
   `allowReadOnly: true`. Ninguna pone `status = 'active'`.
5. Webhook: `cycle` en el parche de ACTIVATED y UPDATED; la renovación lo prefiere al
   del intento.
6. UI: sección `subscription` en Ajustes (admin+), `subscription-panel.tsx`, claves en
   `messages/en.json` y `messages/ko.json`.
7. `progress/checks_subscription-settings-ui.sql` (RLS de `subscriptions` y
   `usage_counters`, el consumo sin transformar, la 056), compuerta, replay, informe,
   CHANGELOG y `docs/docker.md`.

Terminado. Commit `3c99804` en `saas/fase-4-plataforma`. Compuerta verde: lint 0 errores /
37 avisos preexistentes, typecheck limpio, `TZ=UTC npm test` 104 archivos y 1 250 tests,
build OK (aparecen `/api/platform/impersonate` y `/stop`), `scripts/replay-migrations.sh`
salida 0 con 055 y `verify-schema.sql: OK`. SQL de comprobación en
`progress/checks_impersonation-audit.sql` (`NOTICE: checks_impersonation-audit: OK`).
Sin variables de entorno nuevas. Informe: `progress/impl_impersonation-audit.md`.
Pendiente de revisión.

Terminado. Commit `4cd94a4` en `saas/fase-3-facturacion` (23 archivos, migración 056).
Compuerta verde: lint 0 errores / 37 avisos (línea base exacta), typecheck limpio,
`TZ=UTC npm test` 107 archivos y 1 276 pruebas, build `Compiled successfully` con
`ƒ /api/billing/subscription`, y `scripts/replay-migrations.sh` salida 0 con la 056 y
`verify-schema.sql: OK`. `progress/checks_subscription-settings-ui.sql` pasa en el Postgres
del harness (4 partes) con cuatro controles negativos que sí fallan al mutar el esquema, más
cuatro mutaciones de código que tumban sus pruebas. i18n: 48 claves nuevas en
`Billing.subscription` + `Settings.sections.subscription`, en `en.json` y `ko.json`, paridad
1 559/1 559. Sin variables de entorno nuevas. Informe:
`progress/impl_subscription-settings-ui.md`. Pendiente de revisión.

---

Feature en curso: f4.4 — impersonation-audit (segunda ronda, seis cambios requeridos por
`progress/review_impersonation-audit.md` y las decisiones del líder).

Plan:

1. Migración `057_support_session_reads.sql`: `has_open_support_session(uuid)` (STABLE,
   SECURITY DEFINER, fila abierta y no caducada de `impersonation_log` del actor) +
   `can_read_account(uuid, account_role_enum)` = `is_account_member(...) OR
   has_open_support_session(...)`, y un bloque `DO` que recorre `pg_policies` y recrea
   **solo** las políticas de SELECT de `public` sustituyendo el predicado. Nunca las de
   INSERT/UPDATE/DELETE/ALL.
2. `verify-schema.sql`: ninguna política de escritura contiene el predicado nuevo; ninguna
   política de SELECT sigue llamando a `is_account_member` directo; y arreglo de la
   aserción tautológica del motivo (hallazgo 10).
3. Bloqueo de escrituras del navegador: cookie compañera legible por JS y envoltura de
   `from()`/`rpc()` en `@/lib/supabase/client`.
4. Revocación: `resolveSupportSession` exige la fila abierta (`support-session-store.ts`).
5. Hallazgos 4, 5 y 6: cookie fuera en `signOut()`, 403 recuperable en el middleware,
   firma y `setSupportCookie` dentro del `try/catch`, barrido de filas caducadas.
6. Hallazgos 7 (cabecera de caché), 8 (`unstable_rethrow`) y CP9 (SQL de alta a `docs/`).
7. `progress/checks_impersonation-audit.sql` ampliado + compuerta + replay.

---

Feature en curso: f3.5 — subscription-settings-ui (ronda 2, CHANGES_REQUESTED de
`progress/review_subscription-settings-ui.md`).

Plan (7 cambios requeridos, decisiones del líder):

1. Hallazgo 1 (dinero): ensanchar `adopting` en `src/lib/billing/webhook-events.ts` para
   aceptar una fila `active` con `cancel_at_period_end = true` sobre otra suscripción; la
   fila viva sin cancelación programada se sigue rechazando. Test de ruta con la secuencia
   completa `ACTIVATED` + `PAYMENT.SALE.COMPLETED` de `I-NEW`.
2. Hallazgo 2 (dinero): `(adopting ? null : asBillingCycle(existing?.cycle)) ?? intent?.cycle`
   y `cycle` en el parche de adopción. Test `year` → adoptada por intento `month`.
3. Hallazgo 3: el guardián de «mismo plan» compara el `provider_plan_id` resultante con el
   vigente (catálogo si se conoce el ciclo, `checkout_intents.provider_plan_id` si es NULL).
4. Hallazgos 4 y 5 (UI): retornos de carga/error dentro de `RequireRole` (y sin disparar el
   `fetch` por debajo de admin); `readOnly` por delante de `cancelAtPeriodEnd` en la nota.
5. Cambio 6: el sandbox de PayPal NO se puede correr (sin credenciales). Los pasos 6, 7 y 8
   quedan marcados «pendientes de ejecutar por el humano» y se añaden tests de ruta con
   mocks que reproducen esas tres secuencias.
6. Cambio 7: revertir el reformateo de prettier ajeno a la feature (CP8).
7. Informe + CHANGELOG + compuerta + commit `fix:`.

Terminado. Commit `adf72a0` en `saas/fase-3-facturacion` (10 archivos). Los siete cambios
cerrados salvo el 6, que es el único imposible aquí: sin credenciales de sandbox de PayPal
y con `.env.local` bloqueado, los pasos 6, 7 y 8 quedan marcados «pendientes de ejecutar
por el humano» en el informe y se cubren con tests de ruta con mocks. Compuerta verde: lint
0 errores / 37 avisos (línea base), typecheck limpio, `TZ=UTC npm test` 107 archivos y
1 290 pruebas, build OK. Sin SQL tocado, así que no se repitió el replay. Sin claves i18n
nuevas (en/ko siguen en 1 559 y son conjuntos idénticos). Informe actualizado en
`progress/impl_subscription-settings-ui.md`. Pendiente de re-revisión.

Terminado. Commit `e45cbf9` en `saas/fase-4-plataforma`. Compuerta verde: lint 0 errores /
37 avisos preexistentes, typecheck limpio, `TZ=UTC npm test` 107 archivos y 1297 tests,
build OK. `scripts/replay-migrations.sh` salida 0 con 057 incluida y `verify-schema.sql: OK`;
`progress/checks_impersonation-audit.sql` ampliado con el bloque de RLS de la sesión de
soporte → `OK`. Clave i18n nueva `Impersonation.unknownAccount` en en y ko. Informe
actualizado en `progress/impl_impersonation-audit.md` (sección «Segunda ronda»), con la
lista de las 36 políticas de SELECT tocadas. Pendiente de re-revisión.

---

Feature en curso: f4.4 — impersonation-audit (tercera ronda: cierre de los 5 cambios
requeridos de `progress/review_impersonation-audit.md`).

Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4` (HEAD `e45cbf9`).

Plan (decisiones del líder):

1. **Hallazgo 1, salida A — que el navegador sepa qué cuenta mira.**
   - `SUPPORT_ACTIVE_COOKIE` deja de valer `'1'` y pasa a llevar el `account_id`
     impersonado (sigue sin conceder nada: filtrar solo puede estrechar).
   - `src/lib/auth/support-cookie.ts`: `supportFlagValue(cookieString)` puro.
   - `src/lib/supabase/client.ts`: `supportSessionAccountId()`.
   - `src/hooks/use-auth.tsx`: `useEffectiveAccountId()` con `useSyncExternalStore`;
     `accountId` efectivo = cuenta impersonada mientras dure la sesión, propia al
     terminar, `null` (falla cerrado) si la bandera está pero es ilegible. El resumen
     `account` (nombre/moneda) se carga por el id efectivo.
   - Inventario de consultas del navegador sin `.eq('account_id')` y filtro explícito
     en toda lista; las consultas ya claveadas por id de fila/padre se justifican.
2. **Hallazgo 2** — cabecera de 057 y deuda 2 del informe: la firma la pide el
   navegador con el JWT del usuario (`src/lib/media/signed-url.ts`); consecuencia
   real: durante el soporte no se ve **ningún** adjunto del cliente.
3. **Hallazgo 3** — `guardReadOnly` bloquea `storage` salvo lecturas
   (`createSignedUrl(s)`, `getPublicUrl`, `download`, `list`), con test.
4. **Hallazgo 4** — `endSupportSession()` en `src/app/join/[token]/page.tsx`.
5. `CHANGELOG.md`, paso manual 9 e informe: que digan la verdad. CP6 en/ko.
6. Compuerta completa + replay (se toca SQL solo en comentarios de 057).
