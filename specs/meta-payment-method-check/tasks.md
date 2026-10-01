# p11.1 `meta-payment-method-check` — tareas

Rama: `feat/precios-meta-directo` desde `feat/superadmin` @ 4ad530f (ver `design.md` §Rama).
Worktree: `.claude/worktrees/precios-meta-directo`. Sin red: todo `fetch` a Meta mockeado.
Informe en `/Users/brian/Documents/Dev/projects/wacrm/progress/impl_meta-payment-method-check.md`.

- [ ] **T1 Migración 079.** `supabase/migrations/079_meta_payment_status.sql` (columnas, CHECK en
  `DO`, índice parcial, disparador `whatsapp_config_guard_meta_payment`, comentarios) y bloque
  `-- /079 --` en `supabase/ci/verify-schema.sql` dentro del único `DO`.
  `scripts/replay-migrations.sh` sale 0, y aplicar la 079 dos veces no falla.
  `progress/checks_meta-payment-method-check.sql` con los guiones de CHECK, rol `authenticated`
  frente a `service_role`, y cambio de `waba_id`. — **R1, R2, R3** · Prueba: replay + checks SQL
  (`KEEP=1`).
- [ ] **T2 Helper de Meta.** `getWabaFundingInfo` en `src/lib/whatsapp/meta-api.ts` con el patrón
  del archivo (`throwMetaError`, `MetaApiError`, `signal`). — **R4** · Prueba:
  `meta-api.test.ts` (URL `…/{waba}?fields=id,primary_funding_id`, `Authorization`, error con `code`).
- [ ] **T3 Lógica pura y comprobación.** `src/lib/whatsapp/payment-method.ts`:
  `classifyFundingResponse`, `fetchWabaPaymentStatus` (timeout 5 s, nunca lanza),
  `recordPaymentStatus` y `checkAndRecordPaymentStatus` (filtro `id` + `account_id`),
  `isPaymentCheckDisabled`, `metaBillingOf`, `metaPaymentBanner`, `META_BILLING_HUB_URL`. —
  **R4, R5, R6, R12 (parte de librería), R13, R15–R18, R23** · Prueba:
  `payment-method.test.ts` (una prueba por rama de la tabla de errores; token de prueba ausente de
  logs y escrituras; combinaciones de banner).
- [ ] **T4 Barrido en el cron.** `sweepPaymentStatus` en `payment-method.ts` y bloque `payments` en
  `src/app/api/webhooks/cron/route.ts` (aditivo, tras `tokens`; cabecera actualizada). Waiver con
  motivo en el audit de rol de servicio si la ruta está cubierta. — **R9, R10, R13** · Prueba:
  `payment-method.test.ts` (reloj inyectado: NULL, `missing` 59 min/61 min, `unknown` 6 h, `ok`
  24 h; límite 25; fallo de una fila) y `webhooks/cron/route.test.ts`.
- [ ] **T5 Alta y guardado manual.** Paso 10 en `src/app/api/whatsapp/embedded-signup/route.ts`
  (tras el upsert, `try` propio, `payment_status` en el JSON) y en `POST` de
  `src/app/api/whatsapp/config/route.ts`; `publicNumber()` con los tres campos. — **R7, R8, R20
  (API)** · Prueba: `embedded-signup/route.test.ts` y `config/route.test.ts` (ok, missing, fallo
  de Meta sin cambiar el código HTTP; comprobación después del intercambio del código).
- [ ] **T6 Ruta «Comprobar de nuevo».** `src/app/api/whatsapp/config/payment-status/route.ts` y
  `RATE_LIMITS.metaPaymentCheck` en `src/lib/rate-limit.ts`. — **R11, R12, R13** · Prueba:
  `payment-status/route.test.ts` (sin sesión, rol bajo, 429, 200, fuga A↔B: 404 sin `fetch` ni
  UPDATE, interruptor 409).
- [ ] **T7 Estado en `/api/billing/status` y hook.** `metaPayment` y `metaBilling` en
  `src/app/api/billing/status/route.ts` (sin `fetch`, fallo de lectura → banner null) y tipo en
  `src/hooks/use-billing-status.ts`. — **R14, R18, R19, R13** · Prueba:
  `billing/status/route.test.ts` (fetch espiado sin llamadas, `managed` con número `missing` →
  null, fuga A↔B, interruptor).
- [ ] **T8 Banner.** `src/components/billing/meta-payment-alert.tsx` y montaje en
  `src/app/(dashboard)/dashboard-shell.tsx` tras `BillingStatusAlert`. Claves
  `Billing.metaPayment.*` en `messages/en.json` y `messages/es.json`. — **R15, R16, R17, R24** ·
  Prueba: `meta-payment-alert.test.tsx` (missing con contador y enlace `_blank`/`noopener`,
  unknown suave, null vacío, paridad de claves y placeholders es/en).
- [ ] **T9 Ajustes → WhatsApp.** `src/components/settings/payment-status-badge.tsx` y su uso en la
  tarjeta de número de `whatsapp-config.tsx`, botón «Comprobar de nuevo» con `canEditSettings`,
  oculto para `managed`. Claves `Settings.whatsapp.payment*` en es/en. — **R11 (UI), R20, R24** ·
  Prueba: `payment-status-badge.test.tsx` (cuatro estados, fecha, botón deshabilitado sin permiso,
  oculto en `managed`).
- [ ] **T10 Ficha del superadmin.** `AccountNumber` y `loadNumbers` en
  `src/lib/platform/accounts.ts`; badge, fecha y error en
  `src/components/platform/platform-account-detail.tsx`. Claves `Platform.payment*` en es/en. —
  **R21, R24** · Prueba: `accounts.test.ts` (select con los campos, `.eq('account_id', id)`, sin
  `access_token`) y render de la ficha con un número `missing` en cuenta `managed`.
- [ ] **T11 Lo entrante y los envíos no cambian.** Test en
  `src/app/api/whatsapp/webhook/route.test.ts`: entrante a un número `missing` se guarda.
  Comprobar que el diff no toca `webhook/route.ts`, `enforce.ts`, `entitlements.ts` ni las rutas de
  envío. — **R22, R23 (CP11, CP8)** · Prueba: el test nuevo + `git diff --stat` en el informe.
- [ ] **T12 Documentación.** `META_PAYMENT_CHECK_DISABLED` en `docs/docker.md` (tabla de
  variables, junto a `WEBHOOK_CRON_SECRET`); en el informe, el guion manual de `requirements.md`
  con los supuestos S-M1…S-M8 pendientes y la nota de `db push --include-all` si 079 llega al
  remoto antes que 075–078. — **CP9** · Prueba: revisión del reviewer.
- [ ] **T13 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased);
  `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` (con las variables dummy
  de `ci.yml`) y `scripts/replay-migrations.sh` en verde; commits en español con prefijo y
  `Co-Authored-By`, sin push. — **CP1, CP2, CP9, CP10** · Prueba: salida de la compuerta en
  `progress/impl_meta-payment-method-check.md`.
