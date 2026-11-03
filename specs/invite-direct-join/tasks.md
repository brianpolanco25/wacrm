# i12.1 `invite-direct-join` — tareas

Rama `feat/invitacion-directa` desde `main` @ 5f64211; worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/invitacion-directa`. Un implementer, en
serie. Informe en `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/impl_invite-direct-join.md`.
Migración `090_invite_direct_join.sql` (pregunta antes de tocarla: es la regla del repo, y el
spec aprobado es ese visto bueno). Sin dependencias nuevas, sin e2e, sin Playwright, sin
capturas.

Gate dirigido de cada task: `npm run lint`, `npm run typecheck`,
`TZ=UTC npx vitest run <rutas de la task>`. El worktree no trae `node_modules`: instálalo con
`npm ci` (no cambia `package.json`) antes de la primera task.

- [ ] **T1 Migración 090: asientos y `handle_new_user()` con invitación.** Crear
  `supabase/migrations/090_invite_direct_join.sql` con `account_seat_limit` y
  `assert_seat_available` (`design.md` §2.0) y la función de §2.1, con su cabecera (qué cambia,
  por qué el hash en SQL, por qué se aborta el alta, qué es un asiento). —
  **R1, R2, R3, R4, R5, R6, R7, R21, R30, R33** · Prueba: `progress/checks_invite-direct-join.sql`
  §0–§4 (ver T3) y `scripts/replay-migrations.sh` en T3.
- [ ] **T2 Migración 090: `redeem_invitation()` y `peek_invitation()`.** En el mismo archivo,
  `redeem_invitation` de `design.md` §2.2 copiada de `073_no_trial.sql` con sus cuatro cambios
  y `peek_invitation` de §2.2b copiada de `019_invitation_rpcs.sql`; bloque `-- 090` en
  `supabase/ci/verify-schema.sql` (§2.3). — **R13, R16, R31, R32** · Prueba: checks §5–§7 y
  `verify-schema.sql` vía replay.
- [ ] **T3 SQL de comprobación + replay.** Escribir
  `/mnt/nvme-big/Dev/apps/cabbity/wacrm/progress/checks_invite-direct-join.sql` (mismo formato
  que `checks_billing-emails.sql`: `BEGIN … ROLLBACK`, termina en
  `NOTICE: checks_invite_direct_join: OK`):
  §0 paridad `encode(sha256(convert_to('invite-token-abc','UTF8')),'hex')` =
  `51481b404112f61a4e1171ff116d52068c429737863181bef089df7cb607352f`;
  §1 dueño A + invitación `agent` → `INSERT auth.users` con `invite_token` → perfil en A como
  `agent`, sin `accounts` ni `subscriptions` propias, invitación aceptada por él, miembros +
  pendientes de A igual que antes;
  §2 segunda alta con el mismo token, token inexistente, invitación caducada y `invite_token`
  numérico → cada `INSERT` falla (bloque `BEGIN … EXCEPTION` que exige el error) y los
  conteos de `auth.users`/`accounts`/`profiles` no cambian;
  §3 rama de invitación con `profiles` ya ocupado para ese `user_id` → falla, sin cuenta
  personal;
  §4 alta sin `invite_token` y con `invite_token: null` → cuenta personal `owner` + semilla
  `incomplete`;
  §5 con `set_config('request.jwt.claims', …)` del usuario de §1: `redeem_invitation` devuelve
  A y no cambia `accepted_at`; usuario ya miembro de A con otra invitación pendiente → devuelve
  A y la invitación sigue pendiente;
  §6 rechazos: `used`, `expired`, `not_found`, `has_data`, `shared_account` con su `HINT`
  (`GET STACKED DIAGNOSTICS … PG_EXCEPTION_HINT`);
  §7 asientos: `account_seat_limit` sin suscripción (= límite de `inicio`), con plan numérico
  y con `ilimitado` (`NULL`); plan de 2 con 1 miembro + 1 pendiente → alta OK y miembros = 2;
  cambiar la suscripción a un plan de 1 con otra invitación pendiente → alta falla con
  `HINT no_seats`, la invitación sigue pendiente y los conteos no cambian; `peek` de esa
  invitación → `reason: no_seats`; `redeem` de un usuario existente con cuenta vacía → `22023`
  + `no_seats`; volver al plan de 2 y borrar un miembro → la misma invitación ya entra;
  una invitación caducada no cuenta en el conteo de emisión (miembros + pendientes con el
  filtro de `countSeats`) y su alta falla con `expired`; tras `DELETE` de una pendiente el
  conteo baja en 1.
  Correr `scripts/replay-migrations.sh <worktree>` (sale 0), luego con `KEEP=1` aplicar el
  checks y la 090 una segunda vez (idempotencia). Si Docker no está disponible, dejarlo
  escrito como «NO EJECUTADO» en la cabecera y en el informe, y avisar. —
  **R1–R7, R13, R16, R21, R23, R29–R33** · Prueba: salida del replay y del checks pegada en el
  informe.
- [ ] **T4 `redeem` devuelve `reason`.** `src/app/api/invitations/[token]/redeem/route.ts`
  (§3.3). — **R16, R31** · Prueba: `src/app/api/invitations/[token]/redeem/route.test.ts`
  (nuevo; mock de `@/lib/supabase/server` como `src/app/api/account/invitations/route.test.ts`):
  200 con `accountId`; 400 y 409 con `reason` del `hint` (incluido `no_seats`); 401 sin usuario; 500 en código
  desconocido; el RPC recibe `hashInviteToken(token)`.
- [ ] **T5 `resolveJoin`.** `src/lib/auth/join-flow.ts` (§3.1). — **R12, R14, R15, R17, R19,
  R23** · Prueba: `src/lib/auth/join-flow.test.ts`: con sesión y 200 → `redirect` y
  exactamente una llamada `POST`; 409 → `conflict` con mensaje y `peek` (y `peek: null` si el
  peek falla); 400 con cada `reason` (incluido `no_seats`) y con uno desconocido → `not_found`;
  sin sesión y peek `no_seats` → `fail: no_seats`; 401 → camino sin
  sesión; 500 y excepción de red → `server_error`; sin sesión → un `GET` de peek y ningún
  `POST`.
- [ ] **T6 i18n.** Namespaces `JoinPage` (con `fail.no_seats.*`) y `SignupInvite` y copy nuevo de
  `LoginPage.titleAccept`/`descAccept` en `messages/en.json` y `messages/es.json` (§4). —
  **R25, R26, R34** · Prueba: `src/i18n/messages.test.ts` y `src/i18n/icu-safety.test.ts`.
- [ ] **T7 `/join` sin botón.** `src/app/join/[token]/join-view.tsx` (nuevo) y
  `src/app/join/[token]/page.tsx` reescrito (§3.2), con guardia `useRef` contra el doble
  montaje. — **R12, R14, R15, R17, R25** · Prueba: `src/app/join/[token]/join-view.test.tsx`
  (nuevo; patrón de `src/app/(auth)/auth/callback/complete/page.test.tsx`): en `es` y `en`,
  cada estado (`null`, `signedOut`, `fail` ×5 incluido `no_seats`, `conflict` con y sin nombre)
  renderiza su copy;
  ninguno contiene «Accept invitation», «Accepting moves» ni sus traducciones; `signedOut`
  enlaza a `/signup?invite=` y `/login?invite=`; `conflict` enlaza a `/dashboard`.
- [ ] **T8 Alta ligada a la invitación.** `src/lib/auth/signup-invite.ts` (nuevo),
  `src/app/(auth)/signup/signup-invite-view.tsx` (nuevo) y `src/app/(auth)/signup/page.tsx`
  (§3.4). — **R8, R9, R10, R11, R26** · Prueba: `src/lib/auth/signup-invite.test.ts`
  (`signupInviteGate` para sin token / cargando / ok / cada motivo, `no_seats` incluido; `signupOptions` con y sin
  token — `invite_token` presente solo con token, `emailRedirectTo` =
  `authCallbackUrl(origin,{invite})`; `isInviteSignupRejection` para 500, «Database error saving
  new user», 400 de contraseña débil → `false`) y
  `src/app/(auth)/signup/signup-invite-view.test.tsx` (en `es` y `en`: título con la empresa,
  fallo por motivo — `no_seats` dice «no tiene asientos libres» —, «revisa tu correo» con
  empresa y correo). — también **R32, R34**.
- [ ] **T9 Salidas de `/auth/callback/complete`.** `callbackExitLinks` en
  `src/lib/auth/callback.ts` y su uso en `src/app/(auth)/auth/callback/complete/page.tsx`
  (§3.5). — **R18** · Prueba: `src/lib/auth/callback.test.ts` (con y sin `invite`, token con
  caracteres a escapar) y `src/app/(auth)/auth/callback/complete/page.test.tsx` (sigue en
  verde).
- [ ] **T10 Panel de operador.** `inviteToken` en `inviteAuthUser`
  (`src/lib/platform/provisioning.ts`) y en `src/app/api/platform/accounts/[id]/members/route.ts`
  (§3.6). — **R22, R24** · Prueba: `src/lib/platform/provisioning.test.ts` (`data` incluye
  `invite_token` solo cuando se pasa; con `fullName` y sin él),
  `src/app/api/platform/accounts/[id]/members/route.test.ts` (el token pasado es el del
  `url` devuelto) y `src/app/api/platform/accounts/route.test.ts` sin cambios y en verde.
- [ ] **T10b Asientos al emitir el enlace (sin cambios de código).** Tests nuevos que dejan
  probada la regla de emisión: `src/app/api/account/invitations/route.test.ts` («3 miembros + 0
  pendientes en plan de 3 → 402 y ningún `insert`», «2 miembros + 1 pendiente → 402», «el
  conteo de pendientes filtra `accepted_at IS NULL` y `expires_at > now`» — aserción sobre los
  filtros del mock, de modo que una caducada no ocupa asiento); `src/lib/platform/provisioning.test.ts`
  (`countSeats` con los mismos filtros); `src/app/api/platform/accounts/[id]/members/route.test.ts`
  (plan lleno → 402 sin invitación ni correo); `src/lib/billing/seat-limit-parity.test.ts`
  (nuevo: la 090 contiene `'${DEFAULT_PLAN_ID}'` dentro de `account_seat_limit` y lee
  `operators`). — **R28, R29, R33** · Prueba: esos tests.
- [ ] **T11 Onboarding del miembro.** Caso nuevo en `src/lib/onboarding/state.test.ts`: `agent`
  de una cuenta `active` con perfil de empresa incompleto → `done`; y citar l. 150-180 en el
  informe para el caso `incomplete`. Sin cambios de código. — **R20** · Prueba: ese test.
- [ ] **T12 Alcance.** En el informe: `git diff --stat` sin
  `src/app/api/whatsapp/webhook/route.ts`, sin `remove_member`, sin cambios en el conteo de
  asientos (`src/app/api/account/invitations/route.ts`, `countSeats`); guion manual S-M1…S-M3
  de `requirements.md` marcado «pendiente del humano»; deuda D1–D5 copiada. —
  **R21, R27 (CP8, CP11)** · Prueba: revisión del reviewer.
- [ ] **T13 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased) en
  español: «Los invitados entran directamente a la empresa que los invitó». Gate dirigido con
  todas las rutas de T4–T11:
  `npm run lint && npm run typecheck && TZ=UTC npx vitest run src/app/api/invitations src/lib/auth src/app/join src/app/\(auth\) src/lib/platform/provisioning.test.ts src/app/api/platform/accounts src/app/api/account/invitations src/lib/billing/seat-limit-parity.test.ts src/lib/onboarding src/i18n`
  y `scripts/replay-migrations.sh` de T3. El gate completo (`build` incluido) lo corre el
  humano. Commits en la rama, en español, con `Co-Authored-By`; sin push. —
  **todas** · Prueba: salida del gate en el informe.
