# p11.6 `free-entry-point-badge`: tareas

Rama: `pmd/free-entry-point-badge` desde `feat/precios-meta-directo` @ be8ca0f (ver `design.md`
§Rama). Worktree: `.claude/worktrees/pmd-free-entry-point-badge`. Sin red: los payloads de Meta
son sintéticos. Informe en
`/Users/brian/Documents/Dev/projects/wacrm/progress/impl_free-entry-point-badge.md`, que debe
incluir el guion manual de `requirements.md` y los supuestos S-E1…S-E5 sin verificar.

- [ ] **T1 Migración 082.** `supabase/migrations/082_conversation_entry_point.sql` (cuatro
  columnas sin default, dos CHECK `NOT VALID` en `DO`, `SET lock_timeout`/`RESET`, y una cabecera
  con los supuestos) y el bloque `-- 082 --` en `supabase/ci/verify-schema.sql`. Después,
  `progress/checks_free-entry-point-badge.sql` con el CHECK de origen, los dos casos de ventana que
  fallan, el caso de 72 h exactas que pasa y `convalidated = false`. — **R1, R2, R3, R4** · Prueba:
  `scripts/replay-migrations.sh` sale 0, aplicar la 082 dos veces no falla, y el checks SQL con
  `KEEP=1`.
- [ ] **T2 Lógica pura del referral.** `src/lib/whatsapp/entry-point.ts` con `parseReferral`,
  `computeEntryPoint`, las constantes (`FREE_WINDOW_HOURS`, `ENTRY_POINT_SOURCES`,
  `FREE_WINDOW_SOURCES`) y `recordEntryPoint` (filtros `id` + `account_id`, filtro optimista
  `.is`/`.eq` sobre `entry_point_at`, nunca lanza). — **R5, R6, R7, R8, R9, R10, R11 (librería),
  R14 (librería)** · Prueba: `src/lib/whatsapp/entry-point.test.ts`, un caso por rama, reloj
  inyectado y cliente falso.
- [ ] **T3 Enganche en el webhook.** `referral?: unknown` en `WhatsAppMessage` y la llamada en
  `processMessage` después de `bump_conversation_on_inbound`, dentro de `try/catch`, después de
  la frontera de `insertedRows`. — **R11, R12, R13, R14, R15** · Prueba:
  `src/app/api/whatsapp/webhook/route.test.ts`: referral `ad` guarda la ventana; referral más
  viejo no pisa; repetición sin escritura; sin referral no toca; `update` que falla deja el
  mensaje, el bump y el 200; cuenta en solo lectura guarda igual.
- [ ] **T4 Fuga A↔B.** Caso nuevo en `src/lib/security/tenant-isolation.test.ts`: un entrante con
  referral por el número de A no cambia conversaciones de B (mismo teléfono en las dos), y el
  audit no reporta consultas sin `account_id`. — **R16** · Prueba: ese test.
- [ ] **T5 Tipo y función de la insignia.** Campos opcionales en `Conversation`
  (`src/types/index.ts`) y `src/lib/inbox/free-window.ts` con `freeWindowUntil`. — **R17, R21** ·
  Prueba: `src/lib/inbox/free-window.test.ts` (futura, pasada, igual a `now`, NULL, inválida,
  `managed`, `undefined`).
- [ ] **T6 Reloj.** `src/hooks/use-minute-clock.ts` (`useMinuteClock`, `startMinuteClock`,
  `MINUTE_MS`), con el patrón de `use-presence.ts`. — **R20** · Prueba:
  `src/hooks/use-minute-clock.test.ts` con `vi.useFakeTimers()`.
- [ ] **T7 Componente e i18n.** `src/components/inbox/free-window-badge.tsx` y las claves
  `Inbox.freeWindow.badge` y `Inbox.freeWindow.tooltip` en `messages/en.json` y
  `messages/es.json`. — **R18, R19, R22** · Prueba:
  `src/components/inbox/free-window-badge.test.tsx` (`renderToStaticMarkup`: texto, `title`,
  `data-free-window`, icono, y paridad de claves y placeholder `{until}` en es/en), además de
  `src/i18n/messages.test.ts` e `icu-safety.test.ts` en verde.
- [ ] **T8 Montaje en la bandeja.** `ConversationList` y `ConversationItem` (prop
  `freeWindowLabel`, un reloj y `useBillingStatus` en el padre) en
  `src/components/inbox/conversation-list.tsx`, y la cabecera de
  `src/components/inbox/message-thread.tsx` junto al temporizador de sesión, con
  `hidden sm:inline-flex`. Sin tocar `src/app/(dashboard)/inbox/page.tsx`. — **R18, R19, R20,
  R21** · Prueba: los tests de T5–T7, más una revisión del diff (lint y typecheck en verde; en la
  revisión, `managed` o desconocido sin insignia).
- [ ] **T9 Alcance.** Comprobar que el diff no toca `src/lib/api/v1`, `enforce.ts`,
  `entitlements.ts`, `message-charges.ts`, automatizaciones, flujos ni IA. Anotar en el informe
  como deuda lo que se vea roto fuera (por ejemplo la `RangeError` de `route.ts:635`). — **R23** ·
  Prueba: `git diff --stat be8ca0f`.
- [ ] **T10 Compuerta en verde + CHANGELOG.** `npm run lint && npm run typecheck && TZ=UTC npm
  test && npm run build` (con las variables dummy de `docs/harness.md`) y
  `scripts/replay-migrations.sh` en verde. Entrada en `CHANGELOG.md` (Unreleased) con el aviso
  «migración 082: aplicar antes del código» (si el código va primero, el `UPDATE` falla con un
  `console.error` inocuo y el entrante sigue). Informe `progress/impl_free-entry-point-badge.md`
  con el guion manual y los supuestos. Commits en español con prefijo y `Co-Authored-By`, sin push.
  — **todos** · Prueba: la compuerta.
