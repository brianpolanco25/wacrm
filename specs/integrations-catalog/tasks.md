# n13.1 `integrations-catalog` — tareas

Rama `feat/integraciones` desde `main` @ 5f64211; worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/integraciones`. Un solo implementer, en
serie. Informe en `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/impl_integrations-catalog.md`;
SQL de comprobación en `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/checks_integrations-catalog.sql`.

Gate dirigido de cada task (no la suite completa): `npm run lint`, `npm run typecheck` y
`TZ=UTC npx vitest run <rutas de la task>`; o `./init.sh feature n13.1 --test <ruta>...` desde el
workspace. Sin e2e, sin Playwright, sin capturas: lo de UI se prueba con marcado estático
(`renderToStaticMarkup`) y funciones puras. Si el humano elige una alternativa en D1–D6, ajustar la
task señalada antes de empezar.

- [ ] **T1 Migración 091.** `supabase/migrations/091_integrations.sql` según `design.md` §2 (cuatro
  tablas, CHECK en bloques `DO`, índices, triggers `update_updated_at_column`, RLS sin políticas,
  `REVOKE`/`GRANT`, comentarios, marcador `Claves de \`features\` añadidas: integrations.`, nota de
  la 090 reservada). Bloque `-- 091` en `supabase/ci/verify-schema.sql`.
  `progress/checks_integrations-catalog.sql` con cada CHECK, permisos de `authenticated`, FK
  `RESTRICT` y planes sin `integrations`. — **R1, R2, R3, R12 (parte SQL)** · Prueba:
  `scripts/replay-migrations.sh` sale 0; la 091 aplicada dos veces sale 0; `KEEP=1` + checks SQL
  con resultados pegados en el informe.
- [ ] **T2 Validación del catálogo (pura).** `src/lib/integrations/types.ts` y
  `src/lib/integrations/catalog-validate.ts` (§4). — **R5, R6 (reglas), R7, R8, R9** · Prueba:
  `src/lib/integrations/catalog-validate.test.ts` (un caso por regla; URL `http://`, IP privada,
  `localhost`, `u:p@`, query; cabeceras prohibidas; `..`, `//`, `?`; marcadores ↔ params; `GET` con
  `body`; `enum` en no-string; update que combina con `existing`; ejemplo «crear cita» de Health).
- [ ] **T3 Catálogo: biblioteca y rutas de plataforma.** `src/lib/platform/integrations.ts` y las
  cuatro rutas de `src/app/api/platform/integrations/**` (§7, sin `DELETE`). — **R4, R5, R6, R7,
  R10, R11 (datos)** · Prueba: `route.test.ts` junto a cada ruta (401/403 sin escribir; 201/200;
  400 con `field`; 409; 404; slug inmutable; `isDeliverableUrl` simulado falso → 400;
  `DELETE === undefined`; `GET` con `operationsActive` y `accountsEnabled`).
- [ ] **T4 Catálogo: UI de plataforma.** `src/components/platform/integration-form.ts`,
  `platform-integrations.tsx`, `platform-integration-editor.tsx`, las dos páginas bajo
  `src/app/(platform)/platform/integrations/`, la entrada en `platform-shell.tsx`, claves
  `Platform.shell.nav.integrations` y `Platform.integrations.*` en es/en. — **R11, R34 (parte)** ·
  Prueba: `src/components/platform/integration-form.test.ts` (estado → cuerpo exacto de POST/PATCH,
  filas de params/outputs), `platform-integrations.test.tsx` y `platform-integration-editor.test.tsx`
  (marcado con los dos catálogos; paridad de claves), `platform-shell.test.tsx` (nav y
  `platformSectionFor('/platform/integrations/<uuid>') === 'integrations'`).
- [ ] **T5 Entitlement de plan.** `'integrations'` en `PLAN_FEATURES`; test de inventario leyendo
  041 ∪ marcador de 091; `Platform.plans.features.integrations` en es/en. — **R12** · Prueba:
  `src/lib/billing/plan-catalog.test.ts`, `src/components/platform/platform-plans.test.tsx` y
  `plan-form.test.ts` siguen en verde con la clave nueva.
- [ ] **T6 Núcleo HTTP.** `RATE_LIMITS.integrationCall` en `src/lib/rate-limit.ts`;
  `src/lib/integrations/http.ts` (§6). — **R22, R23, R24, R25, R26** · Prueba:
  `src/lib/integrations/http.test.ts` (resolutor privado → `blocked` sin `fetch`; 302 → `http_error`
  con un solo `fetch` y `redirect: 'manual'`; timeout; `content-length` grande; stream de 300 KiB
  con `cancel`; 61.ª llamada de A `rate_limited` y B pasa; JSON, texto y JSON inválido).
- [ ] **T7 Petición y ejecutor.** `src/lib/integrations/request.ts` (§5) y
  `src/lib/integrations/execute.ts` (§6: `executeIntegrationOperation`,
  `testIntegrationConnection`, registro). — **R20, R21, R27, R28, R29, R30** · Prueba:
  `src/lib/integrations/request.test.ts` (coerción, cada `problem`, path codificado con `../admin`
  y `@evil.com`, query en orden, cuerpo plano, cabeceras, ambos `authHeader`) y
  `src/lib/integrations/execute.test.ts` (los cinco `not_enabled`, `invalid_params` sin `fetch`,
  éxito, `http_error`, excepción → `error` sin lanzar, fila de registro exacta por `outcome`, fallo
  al registrar, mapeo de prueba 200/401/403/500/302/timeout/privado, espías de `console` sin
  credencial ni parámetro centinela).
- [ ] **T8 Activación: biblioteca y rutas de cuenta.** `src/lib/integrations/account.ts` y
  `src/app/api/account/integrations/route.ts`, `[integrationId]/route.ts`,
  `[integrationId]/test/route.ts` (§7). — **R13, R14, R15, R16, R17, R18** · Prueba: `route.test.ts`
  junto a cada ruta (forma exacta del `GET` sin credencial ni cifrado, `retired`, `planAllows`,
  `canManage`; `PUT` cifra y guarda last4, reemplaza sin duplicar, 400/404; `DELETE` idempotente y
  permitido sin plan; `test` 200 con `result`, 404 sin activación, 429; 402 sin plan en `PUT` y
  `test`; 403 para `agent`/`viewer` y con `ctx.impersonation`).
- [ ] **T9 Soporte, rotación de clave y docs.** `src/lib/auth/support-scope.ts` (bloqueo de
  `/api/account/integrations`), `src/lib/whatsapp/reencrypt.ts` (`ENCRYPTED_COLUMNS`), comentario de
  `src/lib/whatsapp/encryption.ts`, `docs/security.md`. — **R32, R33** · Prueba:
  `src/lib/auth/support-scope.test.ts` (`POST`/`PUT`/`DELETE` → `block`, `GET` → `pass`),
  `src/middleware.test.ts` si enumera rutas bloqueadas, `src/lib/whatsapp/reencrypt.test.ts`
  (entrada presente; `credential` NULL se salta).
- [ ] **T10 Ajustes → Integraciones.** `src/components/settings/integration-card-state.ts`,
  `integrations-settings.tsx`, `settings-sections.ts`, `src/app/(dashboard)/settings/page.tsx`,
  claves `Settings.sections.integrations` y `Settings.integrations.*` en es/en. — **R19, R34
  (parte)** · Prueba: `src/components/settings/integration-card-state.test.ts` (estado × rol →
  acciones; activar dispara PUT y luego POST test; error del PUT no lanza la prueba) y
  `integrations-settings.test.tsx` (marcado de las cuatro situaciones, solo lectura para `agent`,
  `••••<last4>`, paridad de claves es/en).
- [ ] **T11 Aislamiento entre cuentas.** Semillas, waivers y casos (1)–(6) de `design.md` §8 en
  `src/lib/security/tenant-isolation.test.ts`. — **R31, R4 (parte)** · Prueba: ese archivo en
  verde, con la auditoría de consultas sin alcance vacía; comprobar que quitar un
  `.eq('account_id', …)` de `src/lib/integrations/account.ts` lo pone en rojo (anotarlo en el
  informe y revertir).
- [ ] **T12 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased): catálogo de
  integraciones, activación por cuenta, migración 091 (con la nota de la 090 reservada por la fase
  12), entitlement `integrations` que ningún plan trae por defecto. Gate dirigido de todas las rutas
  de test tocadas en T1–T11 más `npm run lint` y `npm run typecheck`; `npm run build` con las
  variables dummy de `docs/harness.md` para ver la tabla de rutas (`/platform/integrations`,
  `/platform/integrations/[id]`). En el informe: guion manual de `requirements.md` (pendiente de
  humano), `git diff --stat` sin `src/app/api/whatsapp/webhook/route.ts`, `src/lib/flows/`,
  `src/lib/automations/`, `src/lib/ai/`, `package.json` (**R35**, CP5, CP8), salida de
  `grep -rn "decrypt(" src/lib/integrations src/app/api/account/integrations` (**R20**), y las
  decisiones D1–D6 tal como quedaron. — **R35, CP1, CP9** · Prueba: salidas pegadas en
  `progress/impl_integrations-catalog.md`.
