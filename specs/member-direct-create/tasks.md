# i12.2 `member-direct-create` — tareas

Rama `feat/miembro-directo` desde `main` @ 0e9c956; worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/miembro-directo`. Un implementer, en
serie. Informe en `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/impl_member-direct-create.md`.
Migración `093_platform_member_create.sql` (el spec aprobado es el visto bueno para tocarla).
Sin dependencias nuevas, sin e2e, sin capturas. Skill de dominio: ninguna (guía
`wacrm/AGENTS.md` + `node_modules/next/dist/docs/`).

Gate dirigido de cada task: `npm run lint`, `npm run typecheck`,
`TZ=UTC npx vitest run <rutas de la task>`. Si el worktree no trae `node_modules`, `npm ci`
antes de la primera task.

- [ ] **T1 Migración 093 + verify-schema.** Crear
  `supabase/migrations/093_platform_member_create.sql` (`design.md` §3) y el bloque `-- 093` en
  `supabase/ci/verify-schema.sql`. — **R22** · Prueba: `scripts/replay-migrations.sh` sale 0
  (en T9).
- [ ] **T2 Tipo de la bitácora y constante de nombre.** `PlatformAction` + `'member_create'` en
  `src/lib/platform/audit.ts` (comentario con 093); `MAX_MEMBER_NAME_LENGTH = 120` en
  `src/lib/platform/password-rules.ts` y re-export en `provisioning.ts`. — **R5, R13** ·
  Prueba: `npm run typecheck`.
- [ ] **T3 Helpers `createConfirmedMember` y `deleteInvitation`.** En
  `src/lib/platform/provisioning.ts` (`design.md` §4). Tests en
  `src/lib/platform/provisioning.test.ts`: argumentos exactos de `createUser` y
  `inviteUserByEmail` no llamado; mapeo `email_exists` / `user_already_exists` / mensaje
  «already registered» → `exists`; «Database error creating new user» → `rejected`; otro error y
  respuesta sin `user.id` → `failed`; `deleteInvitation` filtra `account_id`, `id`,
  `accepted_at IS NULL` y no lanza ante error; la contraseña no aparece en ningún
  `console.error` (espía). — **R14, R20, R21** · Prueba: `provisioning.test.ts`.
- [ ] **T4 Ruta `POST .../members/create`.** `src/app/api/platform/accounts/[id]/members/create/route.ts`
  (`design.md` §5, cabecera explicando la vía A y el orden). Test
  `.../members/create/route.test.ts`: 401/403 sin pasos; 429; 404 por id no UUID y por cuenta
  inexistente; cada 400 con su `code` (incluido `owner`, 7 y 73 caracteres, motivo de 9, nombre
  vacío y de 121); email normalizado y contraseña sin trim al helper; 409 `already_member`,
  `is_operator` (perfil en otra empresa de un operador), `email_exists` con cuerpo
  `{ error, code }` solamente; 402 con plan lleno; bitácora null → 500 sin invitación ni alta;
  orden `audit → invitation → create`; `details` = `{ email, role, full_name }`; hash insertado =
  `hashInviteToken(token enviado)`; 201 con `member` y sin `password`/token/url, `inviteAuthUser`
  no llamado; `exists` → `deleteInvitation` + 409; `rejected` → `deleteInvitation` + 409;
  `failed` → `deleteInvitation` + 502; excepción tras la invitación → `deleteInvitation` + 500;
  en 201/409/502/500 la contraseña no está en el cuerpo, ni en los params de la bitácora, ni en
  `console.error`/`console.warn`. —
  **R1–R19** · Prueba: `members/create/route.test.ts`.
- [ ] **T5 No regresión de la invitación.** No tocar `members/route.ts` ni su test; correrlo. —
  **R24** · Prueba: `members/route.test.ts` y `[userId]/password/route.test.ts` en verde sin
  cambios; `git diff --stat main` en el informe.
- [ ] **T6 Aislamiento.** En `src/lib/security/tenant-isolation.test.ts`: `createConfirmedMember`
  en el mock de provisioning simulando la 090 (`design.md` §8) y caso «crea un miembro en UNA
  empresa: perfil nuevo en T con su rol, invitación aceptada, A y B intactas, bitácora
  `member_create`», con `extraWaivers = [EMAIL_LOOKUP]`. — **R25** · Prueba: ese test.
- [ ] **T7 Lógica pura del formulario.** `src/components/platform/member-create-form.ts` con
  `validateMemberCreate` y `memberCreateErrorKey` (`design.md` §6.2) y
  `member-create-form.test.ts` (tabla: cada campo inválido → su clave y valores ICU; válido →
  null; cada par estado/código → su clave; desconocido → `memberCreateFailed`). —
  **R27, R29** · Prueba: `member-create-form.test.ts`.
- [ ] **T8 Componente, ficha e i18n.** `src/components/platform/member-create.tsx`
  (`MemberCreate`, `MemberCreateResult`), montaje en la cabecera de «Equipo (N)» de
  `platform-account-detail.tsx`, claves `Platform.memberCreate*` de `design.md` §7 en
  `messages/en.json` y `messages/es.json`. Tests: `member-create.test.tsx` (botón en es/en sin
  `<input>` cerrado; `MemberCreateResult` contiene email, contraseña y el aviso de una sola vez;
  paridad de claves `memberCreate*` y placeholders entre catálogos) y
  `platform-account-detail.test.tsx` (la ficha con detalle muestra «Crear miembro»). Para R27
  (sin `owner` en el selector) exportar la lista de roles del componente y testearla. —
  **R26, R27, R28, R30** · Prueba: esos tests + `src/i18n/messages.test.ts` e
  `icu-safety.test.ts`.
- [ ] **T9 SQL del harness.** Escribir
  `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/checks_member-direct-create.sql` (§0–§3 de
  `design.md` §8) y correr `scripts/replay-migrations.sh` con `KEEP=1` + el checks contra el
  contenedor; pegar la salida (`NOTICE: checks_member_direct_create: OK`) en el informe. —
  **R22, R23, R24b** · Prueba: salida del script.
- [ ] **T10 Guion manual.** Copiar S1 y S2 de `requirements.md` al informe marcados «pendiente
  del humano»; deuda D-1 (usuario de Auth sin perfil) anotada. — **S1, S2** · Prueba: revisión
  del reviewer.
- [ ] **T11 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased), en
  español: «El operador puede crear desde la ficha de una empresa un miembro ya validado, con
  contraseña y sin correo». Gate dirigido:
  `npm run lint && npm run typecheck && TZ=UTC npx vitest run src/app/api/platform/accounts src/lib/platform src/lib/security/tenant-isolation.test.ts src/components/platform src/i18n`
  y el replay de T9. El gate completo lo corre el humano. Commits en la rama, en español, con
  `Co-Authored-By`; sin push. — **todas** · Prueba: salida del gate en el informe.
