# p11.3 `service-cap-per-number` — tareas

Rama `pmd/service-cap` desde `feat/precios-meta-directo` @ be8ca0f; worktree
`.claude/worktrees/pmd-service-cap`. Sin red. Informe en
`/Users/brian/Documents/Dev/projects/wacrm/progress/impl_service-cap-per-number.md`.

- [ ] **T1 Migración 080.** `supabase/migrations/080_service_cap.sql` (columna, CHECK en `DO`,
  función `service_quota_usage`, REVOKE/GRANT, comentarios, `lock_timeout`) y bloque `-- 080` en
  `supabase/ci/verify-schema.sql`. `scripts/replay-migrations.sh` sale 0; la 080 aplicada dos veces
  no falla; aplicada con `psql --single-transaction` tampoco (como la corre `db push`).
  `progress/checks_service-cap-per-number.sql` con: default `warn`, CHECK, filas sintéticas de dos
  cuentas que cubren cada exclusión de R2 con resultado exacto, y `authenticated`/`anon` sin
  EXECUTE. — **R1, R2, R3** · Prueba: replay + checks SQL (`KEEP=1`).
- [ ] **T2 Lógica pura y carga.** `src/lib/billing/service-cap.ts`: `SERVICE_FREE_TIER_PER_NUMBER`,
  `asServiceCapAction`, `serviceMonthWindow`, `serviceCapState`, `loadServiceUsage`,
  `isAiPausedByServiceCap`. — **R4, R10, R11, R12, R13** · Prueba:
  `src/lib/billing/service-cap.test.ts` (umbral 999/1000, `billable > 0`, bordes de mes en UTC y año
  bisiesto, `warn` sin RPC, `managed` sin RPC, número sellado / NULL→por defecto / de otra cuenta,
  cada lectura fallando → `false` + `console.warn`, día 1 a las 00:00:01).
- [ ] **T3 Compuerta en la IA.** `src/lib/ai/auto-reply.ts`: `whatsapp_config_id` en el select y
  llamada a `isAiPausedByServiceCap` antes de `claimInboundAutoReply`; cabecera actualizada. —
  **R9, R10, R11** · Prueba: `src/lib/ai/auto-reply.test.ts` (pausa: ni reserva ni modelo ni envío
  ni `recordUsage`; `warn`/`managed`/no agotado/error → responde).
- [ ] **T4 Ruta.** `src/app/api/whatsapp/service-cap/route.ts` (`GET`, `PATCH`) y, si aplica,
  registro en `src/lib/security/service-role-audit.ts`. — **R5, R6, R7, R8** · Prueba:
  `src/app/api/whatsapp/service-cap/route.test.ts` (forma de la respuesta para un agente, sin
  `fetch`, `managed` sin RPC, 401/403, 400 en tres variantes, 200 del PATCH con `.eq('id', A)`, 500
  sin detalle) y caso A↔B en `src/lib/security/tenant-isolation.test.ts`.
- [ ] **T5 Hook y aviso de la bandeja.** `src/hooks/use-service-cap.ts`,
  `src/components/inbox/service-cap-alert.tsx` y montaje en `src/app/(dashboard)/inbox/page.tsx`.
  Claves `Inbox.serviceCap.*` en `messages/en.json` y `messages/es.json`. — **R8, R16, R19** ·
  Prueba: `src/components/inbox/service-cap-alert.test.tsx` (los seis casos de R16 y paridad de
  claves/placeholders es/en).
- [ ] **T6 Ajustes → WhatsApp.** `src/components/settings/service-cap-settings.tsx`
  (`ServiceUsageLine`, `ServiceCapCard`) y su uso en `src/components/settings/whatsapp-config.tsx`.
  Claves `Settings.whatsapp.serviceCap.*` en es/en. — **R17, R18, R19** · Prueba:
  `src/components/settings/service-cap-settings.test.tsx` (líneas por estado, PATCH con cuerpo
  exacto, revertir en error, deshabilitado sin permiso, oculto en `managed`).
- [ ] **T7 Lo entrante y los envíos no cambian.** Test en
  `src/app/api/whatsapp/webhook/route.test.ts`: cuenta `pause_ai` con número agotado → el entrante
  se guarda y no sale respuesta de IA. En el informe: `git diff --stat` sin `webhook/route.ts`,
  `enforce.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`, `whatsapp/send/route.ts`,
  `broadcast-core.ts`; y `grep -rn isAiPausedByServiceCap src` que solo muestre `auto-reply.ts`,
  `service-cap.ts` y sus tests. — **R14, R15 (CP11, CP8)** · Prueba: el test nuevo + salidas en el
  informe.
- [ ] **T8 Documentación.** En el informe, el guion manual de `requirements.md` con S-C1…S-C6
  pendientes, y la nota de despliegue: la 080 va tras 075–079 (si llega al remoto antes que 077/078,
  `db push --include-all`, decisión del humano). Sin variables de entorno nuevas
  (`docs/docker.md` no cambia). — **CP9** · Prueba: revisión del reviewer.
- [ ] **T9 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased, con aviso de
  migración 080); `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` (variables
  dummy de `ci.yml`) y `scripts/replay-migrations.sh` en verde; commits en español con prefijo y
  `Co-Authored-By`, sin push. — **CP1, CP2, CP9, CP10** · Prueba: salida de la compuerta en
  `progress/impl_service-cap-per-number.md`.
