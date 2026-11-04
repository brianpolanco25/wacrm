# i12.2 `member-direct-create` — requisitos

Rama `feat/miembro-directo` desde `main` @ 0e9c956; worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/miembro-directo`. Depende de i12.1
(`090_invite_direct_join.sql`, ya en `main`). Migración `093_platform_member_create.sql`
(la 092 la reserva n13.2 `integration-flow-call`, ver `design.md` §3).

## Pedido de origen (humano, 2026-11-04)

Un usuario invitado al equipo de una empresa no consigue terminar de crearse (el alta por enlace
se pierde: correo limitado, PKCE en otro navegador…). El superadmin, desde la ficha de la
empresa en el panel de plataforma (bloque «Equipo (N)», junto a «Cambiar contraseña»), debe
poder **crear** un miembro ya validado —nombre, email, contraseña y rol— que entre directamente
con esa contraseña, sin correo ni enlace.

`feature_list.json` no trae `acceptance` para i12.2: los criterios salen de la `note` de la
feature y se numeran A1–A11.

| Criterio | Contenido (de la `note`) | R |
|---|---|---|
| A1 | Crear desde la ficha un miembro con nombre, email, contraseña y rol admin/agent/viewer, nunca owner | R4–R8, R15, R26, R27 |
| A2 | Confirmado de entrada (`email_confirm`): entra con esa contraseña sin correo ni enlace | R15, R16, R20, S1 |
| A3 | No crea empresa propia: nace en la empresa de la ficha con su rol | R15, R23, R25, S1 |
| A4 | Límite de asientos del plan (`countSeats` / `assert_seat_available`) | R12, R18, R24b |
| A5 | Bitácora PRIMERO (`recordPlatformAction`, acción nueva `member_create`) con motivo | R8, R13, R22 |
| A6 | 409 si el email ya existe, ofreciendo el camino existente (invitación / cambio de contraseña) | R9, R11, R17, R29 |
| A7 | Email con usuario de Supabase pero sin perfil en esta empresa: decidido en el spec (409) | R11, R17 |
| A8 | Reglas de contraseña `OPERATOR_MIN/MAX_PASSWORD_LENGTH`; la contraseña nunca al log | R7, R14 |
| A9 | Rechazar el email de un operador de plataforma | R10 |
| A10 | No romper el POST actual de invitación (`/members`) | R24 |
| A11 | UI: diálogo «Crear miembro» con el patrón de `member-password.tsx` (generar/copiar, motivo, resultado una sola vez), i18n en todos los catálogos de `messages/` | R26–R30, S2 |

## Situación verificada (worktree @ 0e9c956)

- `POST /api/platform/accounts/[id]/members` (`src/app/api/platform/accounts/[id]/members/route.ts`)
  invita por enlace: `findProfileByEmail` → 409 `already_member` si ya está en la empresa →
  `assertStockLimit(getEntitlements(id), 'operators', countSeats(id))` (402) →
  `recordPlatformAction('member_invite')` → `insertInvitation` → `inviteAuthUser` con
  `inviteToken`. Rate limit `platform:member:<operador>` con `RATE_LIMITS.adminAction`.
- `POST .../members/[userId]/password` (`.../[userId]/password/route.ts`): contraseña de 8 a 72
  (`OPERATOR_MIN/MAX_PASSWORD_LENGTH`, `src/lib/platform/password-rules.ts`), motivo
  `MIN_REASON_LENGTH` (10), bitácora `password_set` primero, 409 `is_operator`.
- `handle_new_user()` (090, §2): con `raw_user_meta_data->>'invite_token'` válido el perfil nace
  en la empresa de la invitación con su rol, `assert_seat_available` dentro, invitación
  aceptada en la misma transacción; si el token no vale o no hay asientos, el alta entera se
  aborta (GoTrue: «Database error …»). Sin token crea empresa propia (017).
- `impersonation_log.action` tiene CHECK `impersonation_log_action_check` (última versión en
  `087_platform_password_set.sql`): `member_create` no cabe sin migración.
- `supabaseAdmin().auth.admin.createUser` no se usa en ningún sitio del repo; su tipo
  (`AdminUserAttributes`, `node_modules/@supabase/auth-js/dist/module/lib/types.d.ts`) admite
  `email`, `password`, `email_confirm` y `user_metadata`.
- Catálogos de `messages/`: `es.json` y `en.json` (CP6; el coreano se retiró en s9.9).
- El panel no tiene jsdom: los tests de componente son `renderToStaticMarkup`
  (`src/components/platform/member-password.test.tsx`).

## Requisitos (EARS)

Ruta nueva: `POST /api/platform/accounts/[id]/members/create`. «Nada escrito» significa: ni
`recordPlatformAction`, ni `insertInvitation`, ni `createConfirmedMember`, ni
`deleteInvitation` llamados (pasos registrados por los mocks del test de ruta).

### Acceso

- **R1** Cuando llegue una petición a la ruta sin sesión, o de un usuario que no está en
  `platform_admins`, el sistema debe responder 401 o 403 respectivamente (vía
  `requirePlatformAdmin`) sin escribir nada. *Verifica:* `members/create/route.test.ts`.
- **R2** Cuando el operador supere `RATE_LIMITS.adminAction` en la clave
  `platform:member:<operador>` (la misma del POST de invitación), el sistema debe responder 429
  sin escribir nada. *Verifica:* route test (mock de `checkRateLimit` devolviendo `success:false`).
- **R3** Cuando `[id]` no sea un UUID, o `loadAccountSummary(id)` devuelva null, el sistema debe
  responder 404 sin escribir nada. *Verifica:* route test.

### Validación (antes de cualquier lectura o escritura de datos)

- **R4** Cuando `email` no pase `normalizeEmail`, el sistema debe responder 400 con
  `code: 'invalid_email'`. El email aceptado se guarda normalizado (trim + minúsculas).
  *Verifica:* route test (incluye `' Ana@X.test '` → `ana@x.test` en `createConfirmedMember`).
- **R5** Cuando `fullName`, tras `trim`, esté vacío o supere `MAX_MEMBER_NAME_LENGTH` (120), el
  sistema debe responder 400 con `code: 'invalid_name'`. *Verifica:* route test.
- **R6** Cuando `role` no sea `admin`, `agent` ni `viewer` (en particular `owner`), el sistema
  debe responder 400 con `code: 'invalid_role'`. *Verifica:* route test.
- **R7** Cuando `password` no sea texto o su longitud quede fuera de
  `OPERATOR_MIN_PASSWORD_LENGTH`..`OPERATOR_MAX_PASSWORD_LENGTH`, el sistema debe responder 400
  con `code: 'invalid_password'`; la contraseña válida se usa tal cual, sin `trim`.
  *Verifica:* route test (7 y 73 caracteres → 400; `'  abcdefgh  '` llega intacta al helper).
- **R8** Cuando `reason`, tras `trim`, tenga menos de `MIN_REASON_LENGTH` caracteres, el sistema
  debe responder 400 con `code: 'invalid_reason'`. *Verifica:* route test.

### Personas que ya existen

- **R9** Cuando `findProfileByEmail(email)` devuelva un perfil con `accountId` igual a `[id]`,
  el sistema debe responder 409 con `code: 'already_member'` sin escribir nada.
  *Verifica:* route test.
- **R10** Cuando el perfil del email pertenezca a un usuario de `platform_admins`
  (`isPlatformAdmin`), el sistema debe responder 409 con `code: 'is_operator'` sin escribir
  nada, aunque esté en otra empresa. *Verifica:* route test.
- **R11** Cuando el email tenga perfil en otra empresa (y no sea operador), el sistema debe
  responder 409 con `code: 'email_exists'` sin escribir nada y sin revelar la empresa ni el
  `user_id` en el cuerpo. *Verifica:* route test (el cuerpo solo tiene `error` y `code`).

### Asientos

- **R12** Cuando `countSeats(id)` (miembros + invitaciones pendientes no caducadas) ya alcance
  el límite `operators` de `getEntitlements(id)`, el sistema debe responder 402 (vía
  `assertStockLimit` → `PlanLimitError` → `toErrorResponse`) sin escribir nada.
  *Verifica:* route test.

### Bitácora y contraseña

- **R13** Cuando la petición supere R1–R12, el sistema debe llamar a `recordPlatformAction` con
  `action: 'member_create'`, `accountId: id`, `accountName` de la ficha, `reason` del operador
  (trim) y `details: { email, role, full_name }` **antes** de `insertInvitation` y de
  `createConfirmedMember`; si devuelve null, el sistema debe responder 500 sin insertar
  invitación ni crear usuario. *Verifica:* route test (orden de `h.steps`; caso `auditId: null`).
- **R14** El sistema no debe incluir la contraseña en los parámetros de `recordPlatformAction`,
  en el cuerpo de ninguna respuesta (201, 4xx, 5xx) ni en ningún argumento de `console.error`
  o `console.warn` de la ruta o de `createConfirmedMember`. *Verifica:* route test y
  provisioning test (`JSON.stringify` de cada uno no contiene la contraseña, con espía sobre
  `console.error`/`console.warn`, en los caminos 201, 409, 502 y 500).

### Alta

- **R15** Cuando la bitácora esté escrita, el sistema debe insertar una fila de
  `account_invitations` (`insertInvitation`: `accountId: id`, `role`, `createdBy` = operador,
  `label` = email, caducidad `inviteExpiresAt(1)`) y después llamar a
  `createConfirmedMember({ email, password, fullName, inviteToken })` con el token en claro de
  esa invitación (`generateInviteToken`). *Verifica:* route test (orden
  `audit → invitation → create`; el hash insertado es `hashInviteToken(token)` del token enviado).
- **R16** Cuando `createConfirmedMember` devuelva `{ ok: true, userId }`, el sistema debe
  responder 201 con `{ member: { userId, email, fullName, role } }`, sin contraseña, sin token y
  sin URL de invitación, y sin enviar correo (`inviteAuthUser` no se llama). *Verifica:* route test.
- **R17** Cuando `createConfirmedMember` devuelva `reason: 'exists'` (usuario de Supabase Auth sin
  perfil visible, o carrera), el sistema debe borrar la invitación recién creada
  (`deleteInvitation(id, invitationId)`) y responder 409 con `code: 'email_exists'`.
  *Verifica:* route test.
- **R18** Cuando `createConfirmedMember` devuelva `reason: 'rejected'` (el trigger 090 abortó el
  alta, p. ej. asientos agotados por una carrera), el sistema debe borrar la invitación y
  responder 409 con `code: 'rejected'`. *Verifica:* route test.
- **R19** Cuando `createConfirmedMember` devuelva `reason: 'failed'`, o lance, el sistema debe
  borrar la invitación (si se llegó a crear) y responder 502 (`failed`) o 500 (excepción).
  *Verifica:* route test.

### Helpers (`src/lib/platform/provisioning.ts`)

- **R20** Cuando se llame a `createConfirmedMember`, el sistema debe llamar a
  `supabaseAdmin().auth.admin.createUser` exactamente con
  `{ email, password, email_confirm: true, user_metadata: { full_name, invite_token } }`, nunca
  a `inviteUserByEmail`, y devolver `{ ok: true, userId }` con el `user.id` de la respuesta;
  `{ ok: false, reason: 'exists' }` si el error trae `code` `email_exists` o
  `user_already_exists` o el mensaje casa con «already registered/exists»;
  `{ ok: false, reason: 'rejected' }` si el mensaje casa con `/database error/i`;
  `{ ok: false, reason: 'failed' }` en cualquier otro error o sin `user.id`.
  *Verifica:* `src/lib/platform/provisioning.test.ts`.
- **R21** Cuando se llame a `deleteInvitation(accountId, invitationId)`, el sistema debe borrar de
  `account_invitations` con filtros `account_id = accountId`, `id = invitationId` y
  `accepted_at IS NULL`, y no lanzar si falla (solo `console.error`). *Verifica:*
  provisioning test (filtros registrados por el mock; error → no lanza).

### Base de datos

- **R22** Cuando se apliquen las migraciones en limpio, el CHECK
  `impersonation_log_action_check` debe admitir `member_create` y seguir admitiendo todas las
  acciones de la 087; la migración debe poder aplicarse dos veces sin error.
  *Verifica:* bloque `-- 093` de `supabase/ci/verify-schema.sql` vía
  `scripts/replay-migrations.sh`; `progress/checks_member-direct-create.sql` §1 (insert de
  `member_create` pasa, acción inventada falla) y §0 (reaplicar el cuerpo de la 093).
- **R23** Cuando se inserte en `auth.users` un usuario con `email_confirmed_at` no nulo y
  `raw_user_meta_data = {"full_name": …, "invite_token": <token>}` de una invitación válida de la
  empresa E (lo que hace GoTrue con `createUser` + `email_confirm`), el sistema debe crear su
  perfil en E con el rol de la invitación y `full_name`, sin `accounts` propia, con la invitación
  aceptada por él. *Verifica:* `progress/checks_member-direct-create.sql` §2.

### No regresión y aislamiento

- **R24** El POST de invitación (`members/route.ts`) no debe cambiar: su archivo queda fuera del
  diff y `members/route.test.ts` pasa sin modificaciones. *Verifica:* gate dirigido + `git diff
  --stat` en el informe.
- **R24b** Cuando el plan de E esté lleno en el momento del `INSERT` en `auth.users` (asiento
  consumido entre la comprobación TS y el alta), el sistema debe abortar el alta sin dejar
  usuario, perfil ni cuenta. *Verifica:* checks §3 (comportamiento de la 090 reverificado para
  este camino).
- **R25** Cuando un operador cree un miembro en la empresa T, el sistema debe dejar las
  instantáneas de las empresas A y B intactas y el único perfil nuevo en T con el rol pedido; la
  única consulta sin `account_id` debe ser la de `findProfileByEmail` (waiver `EMAIL_LOOKUP`
  existente) y la de `platform_admins`. *Verifica:* caso nuevo en
  `src/lib/security/tenant-isolation.test.ts`.

### UI (`src/components/platform/member-create.tsx`)

- **R26** Cuando se pinte la ficha con detalle, el bloque «Equipo (N)» debe mostrar el botón
  «Crear miembro» / «Create member» y, cerrado, ningún `<input>` del formulario.
  *Verifica:* `member-create.test.tsx` y `platform-account-detail.test.tsx` (markup estático).
- **R27** Cuando el operador envíe el formulario, el sistema debe validarlo en cliente con
  `validateMemberCreate(input)` (`src/components/platform/member-create-form.ts`, función pura con
  las mismas cotas que la ruta: `OPERATOR_MIN/MAX_PASSWORD_LENGTH`, `MAX_MEMBER_NAME_LENGTH`,
  `MIN_REASON_LENGTH`, email con `@` y dominio con punto) y, si falla, mostrar el error sin
  llamar a `fetch`; el selector de rol solo debe ofrecer `admin`, `agent` y `viewer`. La ruta
  sigue siendo la autoridad (R4–R8).
  *Verifica:* `member-create-form.test.ts` (cada campo inválido → su clave i18n; válido → null)
  y `member-create.test.tsx` (markup abierto sin opción `owner`).
- **R28** Cuando la ruta responda 201, el sistema debe mostrar una sola vez el email y la
  contraseña con botón «Copiar», deshabilitar el envío y llamar a `onCreated()` para refrescar
  el equipo; al cerrar, debe olvidar contraseña y motivo. *Verifica:* markup estático de
  `MemberCreateResult` (contiene email, contraseña y el aviso «no se vuelve a mostrar») + guion
  S2 para el cierre.
- **R29** Cuando la ruta responda error, el sistema debe mostrar el texto que devuelva
  `memberCreateErrorKey(status, code)`: 409 `already_member` / `email_exists` (con la sugerencia
  de «Añadir miembro» o «Cambiar contraseña») / `is_operator` / `rejected`, 402 asientos, 400
  `invalid_*`, otro → genérico. *Verifica:* `member-create-form.test.ts` (tabla de casos).
- **R30** Cada clave nueva `memberCreate*` debe existir en `messages/es.json` y
  `messages/en.json` (namespace `Platform`) con los mismos placeholders ICU.
  *Verifica:* `member-create.test.tsx` (paridad de claves con prefijo `memberCreate`) y
  `src/i18n/messages.test.ts` / `icu-safety.test.ts` en verde.

## Guion manual (servicio externo: GoTrue real)

- **S1** En el entorno local con Supabase (o staging, nunca producción sin permiso): desde la
  ficha de una empresa con asientos libres, «Crear miembro» con rol `agent`; en una ventana
  privada, `/login` con ese email y contraseña → entra al dashboard de ESA empresa, sin correo
  enviado (Inbucket/Mailpit vacío), sin onboarding de empresa propia; `select account_id,
  account_role from profiles where email = …` = la empresa, `agent`; no hay fila en `accounts`
  con `owner_user_id` = ese usuario. Pendiente del humano.
- **S2** En el mismo diálogo: tras crear, la contraseña se ve una vez; «Cerrar» y reabrir →
  campos vacíos; el equipo muestra al nuevo miembro sin recargar. Comprobación por aserción en
  navegador (sin capturas). Pendiente del humano.

## Fuera de alcance

- Mover a la empresa a alguien que ya existe en otra (eso es la invitación por enlace y
  `redeem_invitation`, con sus guardas de datos).
- Reparar usuarios de Auth huérfanos sin perfil (deuda, ver `design.md` §9).
- Mostrar la acción `member_create` con etiqueta traducida en la bitácora (hoy la ficha pinta
  `entry.action` en crudo para todas las acciones).
