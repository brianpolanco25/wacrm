# i12.2 `member-direct-create` — diseño

Worktree: `/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/miembro-directo` (rama
`feat/miembro-directo`, `main` @ 0e9c956). Todas las rutas son relativas al worktree.

## 1. Vía elegida: invitación + `createUser` confirmado reutilizando el trigger 090

### (A) Recomendada — invitación efímera + `auth.admin.createUser`

1. Bitácora `member_create` (con el motivo del operador).
2. `generateInviteToken()` + `insertInvitation(...)` para la empresa de la ficha (la misma fila
   que ya escriben la pestaña Miembros y el POST de invitación), caducidad de 1 día.
3. `supabaseAdmin().auth.admin.createUser({ email, password, email_confirm: true,
   user_metadata: { full_name, invite_token } })`.
4. GoTrue inserta en `auth.users`; `handle_new_user()` (090 §2) encuentra la invitación por
   `sha256(token)`, pasa `assert_seat_available` (bloquea la fila de `accounts`), crea el perfil
   en la empresa con el rol, y marca la invitación aceptada, todo en la transacción del alta. Si
   algo falla, el alta entera se aborta y no queda usuario.
5. Si `createUser` falla, la ruta borra la invitación (que ya no reserva asiento).

Por qué: cero SQL de negocio nuevo (solo amplía un CHECK de la bitácora); la única regla de
«dónde nace un usuario» sigue en un sitio (`handle_new_user`, ya probada por i12.1 y su
`progress/checks_invite-direct-join.sql`); el asiento se comprueba dos veces con las mismas
semánticas que la invitación (TS reserva, SQL consume con bloqueo); `email_confirm: true` deja
`email_confirmed_at` puesto, así que `/login` con contraseña funciona sin correo. El token en
claro queda en `raw_user_meta_data` solo si el alta consumió la invitación (cabecera de la 090),
igual que con `inviteUserByEmail`.

### (B) Descartada — `createUser` sin token y mover el perfil después

`createUser` sin `invite_token` hace que la 017/090 cree una empresa propia (`accounts` +
`subscriptions` sembrada por `on_account_created_seed_trial` + `usage_counters`) que habría que
disolver después con el rol de servicio (mover `profiles`, borrar semilla, borrar `accounts`),
duplicando en TS lo que `redeem_invitation` hace en SQL, sin transacción entre GoTrue y
PostgREST: un fallo a mitad deja a la persona como dueña de una empresa vacía (justo el defecto
que i12.1 cerró). La variante «B'» —una RPC nueva `platform_create_member` que inserte en
`auth.users` desde SQL— reimplementa GoTrue (hash bcrypt, `identities`, `instance_id`, `aud`) y
se rompería con cualquier cambio de esquema de Auth. Ambas descartadas.

## 2. Archivos

| Archivo | Cambio |
|---|---|
| `supabase/migrations/093_platform_member_create.sql` | nuevo: CHECK con `member_create` (§3) |
| `supabase/ci/verify-schema.sql` | bloque `-- 093` (§3) |
| `src/lib/platform/audit.ts` | `PlatformAction` gana `'member_create'`; comentario «Mirrors the CHECK of … 087 and 093» |
| `src/lib/platform/password-rules.ts` | `MAX_MEMBER_NAME_LENGTH = 120` (módulo seguro para cliente) |
| `src/lib/platform/provisioning.ts` | re-export de `MAX_MEMBER_NAME_LENGTH`; `createConfirmedMember`, `deleteInvitation` (§4) |
| `src/lib/platform/provisioning.test.ts` | mock `auth.admin.createUser`; tests R20, R21, R14 |
| `src/app/api/platform/accounts/[id]/members/create/route.ts` | nuevo (§5) |
| `src/app/api/platform/accounts/[id]/members/create/route.test.ts` | nuevo, modelo `.../[userId]/password/route.test.ts` |
| `src/lib/security/tenant-isolation.test.ts` | mock de `createConfirmedMember` que simula el trigger; caso R25 |
| `src/components/platform/member-create-form.ts` | nuevo, puro: `validateMemberCreate`, `memberCreateErrorKey` |
| `src/components/platform/member-create-form.test.ts` | nuevo |
| `src/components/platform/member-create.tsx` | nuevo: `MemberCreate`, `MemberCreateResult` (§6) |
| `src/components/platform/member-create.test.tsx` | nuevo, modelo `member-password.test.tsx` |
| `src/components/platform/platform-account-detail.tsx` | monta `<MemberCreate>` en la cabecera de «Equipo (N)» |
| `src/components/platform/platform-account-detail.test.tsx` | aserción del botón en la ficha |
| `messages/es.json`, `messages/en.json` | claves `Platform.memberCreate*` (§7) |
| `progress/checks_member-direct-create.sql` (checkout principal) | SQL de R22–R24b |
| `CHANGELOG.md` | Unreleased |

Fuera del diff (R24): `src/app/api/platform/accounts/[id]/members/route.ts` y su test,
`supabase/migrations/090_invite_direct_join.sql`, `src/components/platform/platform-provisioning.tsx`.

## 3. Migración 093

Número: la última en `main` es `091_integrations.sql`; la 092 está reservada por n13.2
(`.claude/worktrees/integration-flow-call/specs/integration-flow-call/design.md` §2,
`092_flow_integration_call.sql`). Las dos tocan objetos distintos, así que el orden de merge no
importa; si n13.2 se abandona, el humano decide si se renumera (decisión abierta D5).

```sql
-- 093_platform_member_create.sql — bitácora: alta directa de un miembro (i12.2)
-- Un operador crea desde la ficha un miembro ya confirmado, con contraseña,
-- sin correo. Acto propio en la bitácora: `member_create`. Solo amplía el
-- CHECK de la 087; no toca datos. Idempotente (DROP IF EXISTS + ADD).
ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN (
    'impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite',
    'operator_grant', 'operator_revoke',
    'payment_confirmed', 'statement_void',
    'password_set', 'member_create'
  ));
COMMENT ON COLUMN impersonation_log.action IS '… (texto de la 087) …, member_create (093).';
```

Sin RLS nueva (la tabla no tiene política de escritura de cliente desde la 055 y no cambia). Sin
`ON DELETE CASCADE`.

`verify-schema.sql`, bloque `-- 093` tras el de la 078: `pg_get_constraintdef` de
`impersonation_log_action_check` contiene `member_create`, `password_set`, `member_invite`,
`statement_void` e `impersonation`; mensaje «impersonation_log.action must admit member_create
without dropping the earlier acts (migration 093)».

## 4. Helpers en `src/lib/platform/provisioning.ts`

```ts
export type CreateMemberOutcome =
  | { ok: true; userId: string }
  | { ok: false; reason: 'exists' | 'rejected' | 'failed' };

/** Alta confirmada con contraseña: sin correo. Con `inviteToken` el trigger
 *  090 hace nacer al usuario DENTRO de la empresa de la invitación; la fila de
 *  la invitación tiene que existir antes. Nunca registra la contraseña. */
export async function createConfirmedMember(params: {
  email: string;
  password: string;
  fullName: string;
  inviteToken: string;
}): Promise<CreateMemberOutcome>;

/** Borra una invitación PENDIENTE de UNA empresa (la que la ruta acaba de crear
 *  cuando el alta falló). Filtra por account_id, id y accepted_at IS NULL; no lanza. */
export async function deleteInvitation(
  accountId: string,
  invitationId: string
): Promise<void>;
```

Mapeo de errores de `createUser` (R20): `code` ∈ {`email_exists`, `user_already_exists`} o
mensaje `/already (been )?registered|already exists/i` → `exists` (misma regla que
`inviteAuthUser`); mensaje `/database error/i` → `rejected` (GoTrue responde «Database error
creating new user» cuando el trigger lanza); otro → `failed`. El `console.error` registra solo
`{ code, status, message }` del error, nunca `params` (R14).

## 5. Ruta `POST /api/platform/accounts/[id]/members/create`

Archivo `src/app/api/platform/accounts/[id]/members/create/route.ts`. Next 16: Route Handler
con `context: { params: Promise<{ id: string }> }` y `await context.params`
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md`, l. 82-113).
El segmento estático `create` convive con el hermano dinámico `[userId]`: un segmento estático
casa por literal antes que uno dinámico (`dynamic-routes.md`, l. 12) y `[userId]` solo tiene
`password/`, así que `/members/create` no cae en él. Se elige una ruta propia y no un
`mode` en el body del POST actual para dejar ese archivo intacto (R24).

Body: `{ email, fullName, role, password, reason }`.

Orden (cada paso corta):

1. `requirePlatformAdmin()` → 401/403 (R1).
2. `checkRateLimit('platform:member:' + ctx.userId, RATE_LIMITS.adminAction)` → 429 (R2).
   Clave compartida con la invitación a propósito: las dos añaden gente a una empresa.
3. `UUID_RE.test(id)` → 404 (R3).
4. Validación R4–R8 con `code` por campo; contraseña sin `trim`.
5. `loadAccountSummary(id)` → 404 (R3).
6. `findProfileByEmail(email)`: misma empresa → 409 `already_member` (R9);
   `isPlatformAdmin(existing.userId)` → 409 `is_operator` (R10); otro perfil → 409
   `email_exists` (R11). Un operador siempre tiene perfil (017), así que R10 no necesita mirar
   Auth.
7. `assertStockLimit(await getEntitlements(id), 'operators', await countSeats(id))` → 402 (R12).
8. `recordPlatformAction({ action: 'member_create', actorUserId, accountId: id, accountName,
   reason, details: { email, role, full_name } })`; null → 500 «Could not record the action;
   nothing was changed» (R13).
9. `generateInviteToken()`; `insertInvitation({ accountId: id, tokenHash: hash, role,
   createdBy: ctx.userId, label: email, expiresAt: inviteExpiresAt(1) })` (R15).
10. `createConfirmedMember({ email, password, fullName, inviteToken: token })`.
    - ok → 201 `{ member: { userId, email, fullName, role } }` (R16).
    - `exists` → `deleteInvitation` → 409 `email_exists` (R17).
    - `rejected` → `deleteInvitation` → 409 `rejected` (R18).
    - `failed` → `deleteInvitation` → 502 (R19).
11. `catch`: `PlanLimitError` → `toErrorResponse`; si la invitación existe, `deleteInvitation`;
    500 «Failed to create the member». El log de la excepción no incluye el body (R14).

Tabla de respuestas:

| Estado | `code` | Cuándo |
|---|---|---|
| 201 | — | creado |
| 400 | `invalid_email` / `invalid_name` / `invalid_role` / `invalid_password` / `invalid_reason` | R4–R8 |
| 401 / 403 | — | R1 |
| 402 | (cuerpo de `PlanLimitError`) | R12 |
| 404 | — | R3 |
| 409 | `already_member` / `is_operator` / `email_exists` / `rejected` | R9–R11, R17, R18 |
| 429 | — | R2 |
| 500 | — | bitácora no escrita, excepción |
| 502 | `create_failed` | R19 |

Aislamiento (CP3): todas las consultas con rol de servicio son las de helpers existentes
filtradas por `account_id` (`loadAccountSummary`, `countSeats`, `insertInvitation`,
`deleteInvitation` nuevo con `.eq('account_id', …)`), más dos que resuelven personas y ya
tienen waiver o no tienen cuenta: `findProfileByEmail` (`EMAIL_LOOKUP`,
`tenant-isolation.test.ts` l. 3856) e `isPlatformAdmin` (`platform_admins`, sin `account_id`).
`createUser` es la API de Auth, no PostgREST.

## 6. UI

### 6.1 `src/components/platform/member-create.tsx`

```ts
export function MemberCreate(props: { accountId: string; onCreated: () => void }): JSX.Element;
export function MemberCreateResult(props: {
  email: string; password: string; onCopy: () => void;
}): JSX.Element;
```

Mismo patrón que `member-password.tsx`: botón (`UserPlus` de `lucide-react`, ya dependencia)
que abre un formulario en línea; campos nombre, email, rol (`<select>` nativo como
`AddMemberForm` en `platform-provisioning.tsx` l. 626-639, opciones `admin`/`agent`/`viewer` con
`t('roles.<r>')`), contraseña con «Generar» (`generatePassword()`) y «Copiar», motivo
(`MIN_REASON_LENGTH` de `@/lib/auth/support-cookie`, como `member-password.tsx`). Envío:
`validateMemberCreate` → si hay error, `toast.error(t(key, vars))` sin `fetch`; si no,
`POST /api/platform/accounts/${accountId}/members/create`. 201 → estado `created` con
`{ email, password }`, `MemberCreateResult` visible, envío deshabilitado, `onCreated()`. Error →
`toast.error(t(memberCreateErrorKey(status, code)))`. «Cerrar» resetea todo el estado (la
contraseña no se guarda en ningún otro sitio). `aria-busy` en el formulario mientras `busy`.

En `platform-account-detail.tsx` (bloque `members`, l. 481-500) la cabecera pasa a
`flex items-center justify-between` con el `<h2>` y `<MemberCreate accountId={accountId}
onCreated={() => void load()} />`. `load()` no desmonta el contenido mientras recarga
(`fileScreen` devuelve `ready` si ya hay detalle, l. 125-133), así que el resultado no se pierde.

### 6.2 `src/components/platform/member-create-form.ts` (puro, sin I/O)

```ts
export type MemberCreateInput = {
  fullName: string; email: string; role: string; password: string; reason: string;
};
export type MemberCreateError = { key: string; values?: Record<string, number> } | null;
export function validateMemberCreate(input: MemberCreateInput): MemberCreateError;
export function memberCreateErrorKey(status: number, code: string | undefined): string;
```

No importa `normalizeEmail` (vive en `provisioning.ts`, que importa `supabaseAdmin`); usa un
chequeo laxo propio (`/^[^\s@]+@[^\s@]+\.[^\s@]+$/` tras `trim`); la ruta decide.

`memberCreateErrorKey`: 409+`already_member` → `memberCreateAlreadyMember`; 409+`email_exists`
→ `memberCreateEmailExists`; 409+`is_operator` → `memberCreateIsOperator`; 409+`rejected` →
`memberCreateRejected`; 402 → `memberCreateNoSeats`; 400+`invalid_password` →
`memberCreatePasswordInvalid`; 400 otro → `memberCreateInvalid`; resto → `memberCreateFailed`.

## 7. Claves i18n (`Platform`, en `messages/en.json` y `messages/es.json`)

| Clave | es | en |
|---|---|---|
| `memberCreateButton` | Crear miembro | Create member |
| `memberCreateTitle` | Crear miembro ya validado | Create a verified member |
| `memberCreateHelp` | Entra con esta contraseña al momento. No se envía ningún correo. Pásasela por un canal seguro y pídele que la cambie. | Signs in with this password right away. No email is sent. Share it over a safe channel and ask them to change it. |
| `memberCreateNameLabel` | Nombre | Name |
| `memberCreateEmailLabel` | Email | Email |
| `memberCreateRoleLabel` | Rol | Role |
| `memberCreatePasswordLabel` | Contraseña | Password |
| `memberCreateGenerate` | Generar | Generate |
| `memberCreateCopy` | Copiar | Copy |
| `memberCreateCopied` | Contraseña copiada | Password copied |
| `memberCreateReasonLabel` | Motivo (queda en la bitácora) | Reason (kept in the audit log) |
| `memberCreateReasonPlaceholder` | Ej.: el invitado no pudo terminar el alta por enlace | E.g.: the invitee could not finish signing up from the link |
| `memberCreateSubmit` | Crear miembro | Create member |
| `memberCreateCancel` | Cerrar | Close |
| `memberCreateDone` | Miembro creado. Copia la contraseña ahora: no se vuelve a mostrar. | Member created. Copy the password now: it will not be shown again. |
| `memberCreateNameInvalid` | El nombre es obligatorio y admite hasta {max} caracteres. | The name is required, up to {max} characters. |
| `memberCreateEmailInvalid` | Escribe un email válido. | Enter a valid email. |
| `memberCreatePasswordInvalid` | La contraseña debe tener entre {min} y {max} caracteres. | The password must be {min} to {max} characters. |
| `memberCreateReasonShort` | El motivo debe tener al menos {min} caracteres. | The reason must be at least {min} characters. |
| `memberCreateInvalid` | Revisa los datos del formulario. | Check the form. |
| `memberCreateAlreadyMember` | Esa persona ya es miembro de esta empresa. Usa «Cambiar contraseña». | That person is already a member of this company. Use “Change password”. |
| `memberCreateEmailExists` | Ese email ya tiene cuenta. Usa «Añadir miembro» para enviarle un enlace de invitación. | That email already has an account. Use “Add member” to send an invitation link. |
| `memberCreateIsOperator` | Ese email es de un operador de la plataforma. | That email belongs to a platform operator. |
| `memberCreateRejected` | No se pudo dar de alta: la empresa no tiene asientos libres o la invitación se rechazó. | Could not create it: the company has no free seats or the invitation was refused. |
| `memberCreateNoSeats` | El plan de la empresa no tiene asientos libres. Cambia el plan primero. | The company's plan has no free seats. Change the plan first. |
| `memberCreateFailed` | No se pudo crear el miembro. | Could not create the member. |

`en` es la fuente de verdad (CP6); placeholders idénticos en los dos.

## 8. Tests

- `members/create/route.test.ts`: mocks como `password/route.test.ts` (`@/lib/supabase/server`,
  `@/lib/auth/admin-client` para `platform_admins`, `@/lib/rate-limit`, `@/lib/platform/accounts`,
  `@/lib/platform/audit`, `@/lib/platform/provisioning` con `findProfileByEmail`,
  `countSeats`, `insertInvitation`, `createConfirmedMember`, `deleteInvitation`,
  `inviteAuthUser` (espía: nunca llamado), y `@/lib/billing/enforce` `getEntitlements`), con
  `h.steps` para el orden. Espía `console.error`/`console.warn` para R14.
- `provisioning.test.ts`: añadir `createUser` al mock `auth.admin` existente (l. 84-90) y
  `delete` al builder si falta.
- `tenant-isolation.test.ts`: en el `vi.mock('@/lib/platform/provisioning')` (l. 216) añadir
  `createConfirmedMember` que simula la 090: busca la invitación pendiente por
  `token_hash = hashInviteToken(inviteToken)`, empuja el perfil en su `account_id` con su rol y
  pone `accepted_at`. Caso «crea un miembro en UNA empresa» con `extraWaivers = [EMAIL_LOOKUP]`.
- `member-create-form.test.ts`, `member-create.test.tsx`, `platform-account-detail.test.tsx`.
- `progress/checks_member-direct-create.sql` (`BEGIN … ROLLBACK`, termina en
  `NOTICE: checks_member_direct_create: OK`, formato de `checks_invite-direct-join.sql`):
  §0 reaplicar el cuerpo de la 093 sin error; §1 insert de `member_create` en
  `impersonation_log` pasa y `'member_nope'` falla con 23514; §2 empresa E con plan con hueco +
  invitación `viewer` → `INSERT auth.users (… email_confirmed_at = now(),
  raw_user_meta_data = '{"full_name":"Ana","invite_token":"…"}')` → perfil en E `viewer`
  `full_name = 'Ana'`, sin `accounts` propia, invitación aceptada; §3 mismo con E llena →
  falla y los conteos de `auth.users`/`profiles`/`accounts` no cambian.

## 9. Errores, riesgos y deuda

- **Usuario de Auth sin perfil** (alta de la 017 que tragó el error): `findProfileByEmail` no lo
  ve, `createUser` responde `email_exists` → 409 `email_exists` y se borra la invitación. No se
  repara aquí (D-1).
- **Invitación aceptada visible**: queda una fila `account_invitations` aceptada con
  `label = email` y `created_by_user_id` = operador. Es el rastro del alta y coincide con lo que
  deja la invitación por enlace; no se oculta.
- **Correo**: `createUser` con `email_confirm: true` no envía correo (GoTrue solo envía en
  `invite`/`signUp`/`generateLink` con envío). Se comprueba en S1.
- **Contraseña**: no se guarda en estado de servidor, ni en la bitácora, ni en la respuesta; el
  cliente la tiene en memoria hasta «Cerrar».
- **Carrera de asientos**: la 090 bloquea `accounts … FOR UPDATE` en `assert_seat_available`;
  el perdedor recibe 409 `rejected` y su invitación se borra.

## 10. Decisiones abiertas para el humano

- **D1** Vía (A) invitación efímera + `createUser` con el trigger 090 (recomendada) frente a (B).
- **D2** Email que ya tiene perfil en otra empresa → 409 `email_exists` y el operador usa
  «Añadir miembro» (no se mueve a nadie desde aquí).
- **D3** Usuario de Auth sin perfil → mismo 409 `email_exists`; sin reparación.
- **D4** Motivo obligatorio (≥ 10) para crear, a diferencia de la invitación, que no lo pide.
- **D5** Migración `093` (la 092 la reserva n13.2).
- **D6** Bucket de rate limit compartido con la invitación (`platform:member:<operador>`).
