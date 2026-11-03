# impl i12.1 `invite-direct-join`

## Plan (de `specs/invite-direct-join/tasks.md`, en orden)

T1 migración 090: asientos + `handle_new_user()` · T2 090: `redeem_invitation()` + `peek_invitation()` + bloque
`verify-schema.sql` · T3 checks SQL + replay · T4 `redeem` devuelve `reason` · T5 `resolveJoin` · T6 i18n ·
T7 `/join` sin botón · T8 alta ligada a la invitación · T9 salidas de `/auth/callback/complete` · T10 panel de
operador · T10b asientos al emitir (tests) · T11 onboarding (test) · T12 alcance · T13 compuerta + CHANGELOG.

Estado: **todas hechas**. Compuerta completa en verde. Sin bloqueos.

## Rama y commits

Worktree `/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/invitacion-directa`, rama `feat/invitacion-directa`
desde `main` @ 5f64211. Sin push.

| Commit | Contenido |
|---|---|
| `be9cae6` docs(specs) | `specs/invite-direct-join/{requirements,design,tasks}.md` (el spec aprobado, sin commitear hasta ahora) |
| `d39bcd2` feat(db) | `supabase/migrations/090_invite_direct_join.sql`, bloque `-- 090` en `supabase/ci/verify-schema.sql` |
| `63a3ff9` feat(auth) | Código TS, tests, `messages/{es,en}.json`, `CHANGELOG.md` |

`node_modules` del worktree es un symlink al checkout principal (gitignoreado, no commiteado).

## Qué se hizo

- **090** (`supabase/migrations/090_invite_direct_join.sql`): `account_seat_limit(uuid)` y
  `assert_seat_available(uuid, text)` (SECURITY DEFINER, sin EXECUTE para `anon`/`authenticated`);
  `handle_new_user()` con rama de invitación fuera del bloque que traga errores (sha256 con
  `pg_catalog.sha256`, `FOR UPDATE`, HINT `not_found|used|expired|no_seats`, asientos, perfil en la empresa,
  invitación aceptada) y la rama 017 intacta; `redeem_invitation()` = cuerpo de 073 + no-op para el ya miembro
  (antes del chequeo `used/expired`) + HINT por rechazo + `assert_seat_available(…, '22023')` tras el guardián de
  datos; `peek_invitation()` = 019 + `no_seats`. Solo `CREATE OR REPLACE` / `ALTER OWNER` / `REVOKE/GRANT`.
- `POST /api/invitations/[token]/redeem`: `reason: err.hint` en 400 y 409. Prettier reformateó el archivo entero
  (estaba con comillas dobles, fuera del `.prettierrc`); la lógica solo cambia en `rpcErrorToResponse`.
- `src/lib/auth/join-flow.ts` (nuevo, puro): `resolveJoin`, `parsePeek`, `fetchPeek`, `toFailReason`.
- `/join/[token]`: `page.tsx` reescrito (guardia `useRef` contra el doble montaje, `window.location.replace` en
  200, sign-out con `endSupportSession` conservado) + `join-view.tsx` (presentacional, `useTranslations('JoinPage')`).
  Sin botón «Accept invitation», sin estado `accepting`, sin toast, sin «Accepting moves…».
- `/signup?invite=`: `src/lib/auth/signup-invite.ts` (nuevo) + `signup-invite-view.tsx` (nuevo) + `page.tsx`
  (peek antes del formulario, `signupOptions` con `invite_token`, re-peek tras rechazo del trigger, «revisa tu
  correo» con la empresa).
- `/auth/callback/complete`: `callbackExitLinks(search)` en `src/lib/auth/callback.ts`; la pantalla de fallo pasa
  a `complete/callback-failure.tsx` para poder renderizarla en test (la página solo llega a ella tras un efecto).
- Panel: `inviteAuthUser({ …, inviteToken })` y la ruta de miembros pasa `inviteToken: token`.
- i18n: namespaces `JoinPage` y `SignupInvite` (+2 claves de diseño propio: `SignupInvite.backToSignIn`,
  `SignupInvite.signupWithoutInvite`), copy nuevo de `LoginPage.titleAccept`/`descAccept`.

## Criterio ↔ test

| R | Test (archivo › `it`) |
|---|---|
| R1 R2 R3 R21 | checks §1 |
| R4 R7 | checks §2 (usado, inexistente, caducado, numérico, 129 caracteres, vacío; conteos intactos). `FOR UPDATE` presente: aserción en `verify-schema.sql` |
| R5 | checks §3 |
| R6 | checks §4 |
| R8 | `src/lib/auth/signup-invite.test.ts` › `signupInviteGate (R8)` (5 `it`); `src/app/(auth)/signup/signup-invite-view.test.tsx` › `checking the invitation before the form (R8)`, `every reason shows its copy and no form (R8, R32)` |
| R9 | `signup-invite.test.ts` › `with a token: invite_token in data, and the callback keeps ?invite=`, `without a token: no invite_token key at all` |
| R10 | `signup-invite.test.ts` › `isInviteSignupRejection (R10)` (500, texto de GoTrue, 400 contraseña → false, 429 → false) |
| R11 | `signup-invite-view.test.tsx` › `"check your email" names the email and the company (R11)` |
| R12 | `src/lib/auth/join-flow.test.ts` › `redeems with exactly ONE POST and goes to /dashboard on 200 (R12)`; `src/app/join/[token]/join-view.test.tsx` › `nothing says "accept" any more (R12, R25)`, `loading and redirect show the waiting state` |
| R13 | checks §5 |
| R14 | `join-flow.test.ts` › `409 → conflict with the message and the company from peek (R14)`, `409 with a failing peek → conflict without a name…`; `join-view.test.tsx` › `conflict modal with and without the company name (R14)` (enlace a `/dashboard`) |
| R15 | `join-flow.test.ts` › `400 with reason %s → that failure (R15, R31)`, `400 with an unknown reason → not_found`, `401 → the signed-out path`, `500 → server_error`, `a network error → server_error` |
| R16 | `src/app/api/invitations/[token]/redeem/route.test.ts` › `400 with reason %s from the HINT (22023)`, `409 with reason %s from the HINT (23505)`; checks §6 |
| R17 | `join-flow.test.ts` › `one GET of peek and no POST at all`; `join-view.test.tsx` › `signed out names company and role, links to signup and login` |
| R18 | `src/lib/auth/callback.test.ts` › `callbackExitLinks (i12.1, R18)` (3 `it`); `src/app/(auth)/auth/callback/complete/page.test.tsx` › `the failure screen keeps ?invite= on its links (i12.1, R18)` |
| R19 | `src/lib/auth/post-login.test.ts` (existente: invite → `/join/<token>`) + `join-flow.test.ts` › `the already-member no-op (200) also lands on /dashboard (R19, R23)` |
| R20 | `src/lib/onboarding/state.test.ts` › `i12.1 (R20): a member born inside a paying company…` (nuevo); existentes l. 150-158 `gates every member of an incomplete account, %s included` y l. 173-181 `a manual plan (s9.4) … only shows step 1 to the owner` |
| R22 | `src/lib/platform/provisioning.test.ts` › `i12.1: passes invite_token so the trigger makes them a member (R22)`; `src/app/api/platform/accounts/[id]/members/route.test.ts` › `audits, writes the invitation for THIS company, then emails a new person` (`inviteArgs.inviteToken === token` del `url`) |
| R23 | checks §5 + `join-flow.test.ts` (no-op → `/dashboard`). Correo real: guion S-M1 |
| R24 | `provisioning.test.ts` › `without a token nor a name, no data at all (a new company owner, R24)`; `src/app/api/platform/accounts/route.test.ts` sin cambios, en verde |
| R25 R26 | `join-view.test.tsx` (render es/en), `signup-invite-view.test.tsx` › `the form title and description name the company and role (R26)`, `says you go straight into the company`; `src/i18n/messages.test.ts`, `src/i18n/icu-safety.test.ts` en verde |
| R28 | `src/app/api/account/invitations/route.test.ts` › `i12.1 (R28): 3 members and no pending link on a 3-seat plan → 402, nothing written`, `i12.1 (R28): 2 members + 1 pending link…`; `members/route.test.ts` › `refuses past the seat limit of the plan…` (+ sin invitación ni correo) |
| R29 | `provisioning.test.ts` › `an expired or accepted invitation does not hold a seat (R29)`; `account/invitations/route.test.ts` › `i12.1 (R29): only open, unexpired invitations take a seat`; checks §7 (caducada no cuenta, alta con caducada → `expired`, `DELETE` baja el conteo, revocada → `not_found`) |
| R30 | checks §7 (plan 2: alta OK; plan 1: `no_seats`, conteos e invitación intactos; vuelta a 2 + quitar miembro → entra; `ilimitado` → 3 altas sin límite) |
| R31 | checks §7 (`22023:no_seats` sin mover al usuario; con sitio → canje y cuenta personal borrada); `redeem/route.test.ts` (`no_seats` → 400) |
| R32 | checks §7 (peek `no_seats`; peek con sitio → ok); `join-flow.test.ts` › `peek %s → that failure (R32)`; `signup-invite.test.ts` (`no_seats`) |
| R33 | checks §7 (sin suscripción = `inicio`, plan de 2, `ilimitado` NULL, `operators` no numérico NULL); `src/lib/billing/seat-limit-parity.test.ts` (2 `it`) |
| R34 | `join-view.test.tsx` › `no_seats tells the person the team is full and to ask an admin (R34)`; `signup-invite-view.test.tsx` › `no_seats says the company has no free seats (R34)` |
| R27 | Ver «Alcance» |

## Verificación contra base real

`progress/checks_invite-direct-join.sql` (BEGIN … ROLLBACK, §0–§7):

```
KEEP=1 scripts/replay-migrations.sh .claude/worktrees/invitacion-directa
  … ok 089_whatsapp_coexistence_batches.sql / ok 090_invite_direct_join.sql / verify-schema.sql: OK
docker exec -i <c> psql … < progress/checks_invite-direct-join.sql
  NOTICE:  checks_invite_direct_join: OK
# idempotencia: 090 aplicada por segunda vez → sin error; checks otra vez → OK; verify-schema otra vez →
  NOTICE:  schema verification passed
scripts/replay-migrations.sh .claude/worktrees/invitacion-directa   (sin KEEP, final)
  ok 090_invite_direct_join.sql / verify-schema.sql: OK
```

Nota del checks: la imagen local define `auth.uid()` sobre `request.jwt.claim.sub`, no sobre
`request.jwt.claims`; el ayudante `pg_temp.redeem` fija los dos. §3 provoca el fallo del `INSERT INTO profiles`
con un trigger `BEFORE INSERT` temporal (el spec decía «perfil preexistente con el mismo user_id», imposible por la
FK `profiles.user_id → auth.users` no diferible).

## Compuerta (una vez, al final)

- `npm run lint`: 0 errores, 34 warnings (todos preexistentes; ninguno en archivos tocados).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 326 archivos, 4860 tests, todos en verde (18 s).
- `npm run build` (variables dummy de CI): OK.
- Gate dirigido de T13 (`src/app/api/invitations src/lib/auth src/app/join src/app/(auth) …`): 48 archivos, 723 tests.
- Replay de migraciones: OK (arriba).

## Navegador

No se levantó la app en navegador: el flujo depende de Supabase Auth real (alta, correo, sesión) y no hay entorno
local con GoTrue. Lo verificable sin él se comprobó con render estático (`renderToStaticMarkup`) y aserciones de
texto: estado de espera con `role="status"` y `aria-busy="true"`; botón de cerrar sesión `disabled` con
«Cerrando sesión…» mientras `signingOut`; ningún estado contiene «Accept invitation», «Accepting moves» ni sus
traducciones, y el catálogo `JoinPage` no contiene «accept/acept». Sin capturas.

## Verificación manual pendiente (humano)

Guiones S-M1, S-M2 y S-M3 de `requirements.md`, **pendientes del humano**:

- **S-M1** Panel → «Añadir miembro» con correo nuevo → correo → definir contraseña → `/dashboard` de la empresa;
  en `profiles` el `account_id` es el de la empresa y no hay `accounts` con `owner_user_id` = él.
- **S-M2** Pestaña Miembros → enlace → `/signup?invite=` en navegador A → abrir la confirmación en navegador B →
  «Volver a iniciar sesión» conserva `?invite=` → iniciar sesión → `/dashboard` de la empresa.
- **S-M3** Usuario con sesión y cuenta personal vacía abre el enlace → sin botón, `/dashboard` de la empresa. Con
  una cuenta con contactos → modal de conflicto.
- Comprobar además que GoTrue de producción responde «Database error saving new user» (o 500) cuando el trigger
  aborta: `isInviteSignupRejection` se apoya en eso.

## Decisiones donde el spec era ambiguo

1. **Orden en `redeem_invitation`**: el no-op del ya miembro va antes de `used/expired` (lo pide el spec) y el
   `42501 Caller has no profile` queda después de ellos (antes iba antes de comprobar la cuenta).
2. **Modal de conflicto**: muestra el mensaje del RPC (inglés, como antes); solo usa `conflict.fallback` si la
   ruta no mandó `error`. Es lo que fija `design.md` §3.1.
3. **Modal bloqueante**: `Dialog open` sin botón de cerrar; las salidas son «Ir a mi cuenta» (`/dashboard`) y
   cerrar sesión. Se quitó «Stay signed in» (spec §7).
4. **Fallo en `/signup?invite=`**: tarjeta con el copy de `JoinPage.fail.*`, botón «Crear una cuenta sin la
   invitación» → `/signup` y enlace a `/login`; para `server_error`, «Reintentar» que repite el peek. Claves
   nuevas `SignupInvite.backToSignIn` y `SignupInvite.signupWithoutInvite`.
5. **Re-peek tras rechazo que dice `ok`** (rechazo transitorio): se muestra `SignupInvite.rejected` sobre el
   formulario.
6. **`signupOptions` solo lleva `invite_token` si el peek dijo `ok`**: el formulario solo se muestra en ese caso,
   así que es equivalente; evita mandar un token que el usuario manipuló tras un fallo.
7. **CHANGELOG en inglés**: tasks.md pedía la entrada en español, pero todo `CHANGELOG.md` está en inglés; se
   siguió la convención del archivo (sección «Invitations: invitees go straight into the company that invited
   them», con aviso de migración requerida).
8. **R29 «account_seats_used»**: no existe esa función; el checks calcula el conteo de emisión con el mismo filtro
   que `countSeats` (`pg_temp.seats`).
9. **R18 render**: la pantalla de fallo se extrajo a `callback-failure.tsx` porque la página solo llega a ese
   estado tras un efecto, que `renderToStaticMarkup` no ejecuta.

## Variables de entorno nuevas

Ninguna.

## Alcance (R27, CP8, CP11)

`git diff --stat 5f64211..HEAD`: 32 archivos, +3394 −500 (incluye 852 líneas del spec). No aparecen
`src/app/api/whatsapp/webhook/route.ts`, `remove_member`, `src/app/api/account/invitations/route.ts`,
`src/lib/billing/enforce.ts` ni `countSeats` (en `provisioning.ts` solo cambia `inviteAuthUser` y comentarios).
`src/app/api/platform/accounts/route.ts` (crear empresa) sin cambios.

## Deuda (fuera de alcance, no arreglada)

- **D1** Rescatar usuarios ya afectados (cuenta existente con datos que debería estar en otra empresa).
- **D2** Invitaciones ligadas a correo para quien se registra en `/signup` sin el enlace.
- **D3** Marcar en Miembros a los miembros con correo sin confirmar y excluirlos de los selectores de asignación.
- **D4** `otherBrowser` en `/auth/callback/complete`: para una confirmación de alta la acción principal debería
  ser «Iniciar sesión», no «Pedir un enlace nuevo».
- **D5** Textos de `/signup` que no son de invitación siguen en inglés en el propio archivo.
- **Nueva**: los mensajes del modal de conflicto vienen del RPC en inglés; traducirlos por `reason`
  (`has_data`/`shared_account`) sería trivial ahora que la ruta devuelve `reason`.
- **Nueva**: `/forgot-password` ignora `?invite=` (ya lo anota el diseño §3.5); el enlace lo conserva sin efecto.
- **Nueva**: `auth.uid()` de la imagen local de replay lee `request.jwt.claim.sub`; los checks antiguos que solo
  fijan `request.jwt.claims` podrían no estar probando lo que creen (no revisado).
- `.env.local.example` no se tocó (no hay variables nuevas).
