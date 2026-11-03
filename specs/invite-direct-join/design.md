# i12.1 `invite-direct-join` — diseño

Referencias: `requirements.md` (R1–R27). Guía del subproyecto: `AGENTS.md` (Next 16; docs en
`node_modules/next/dist/docs/` del checkout principal — el worktree no trae `node_modules`,
se instala o se enlaza antes del gate). Sin dependencias nuevas.

## 1. Forma de la solución

```
                    ┌─────────────── usuario nuevo (A1/A2/A3) ───────────────┐
/join/<t> ─ sin sesión → /signup?invite=<t> ─ peek ok → signUp(data.invite_token=<t>)
                                                      │
                     auth.users INSERT → handle_new_user() ─ invitación válida → profiles(account_id
                                                      │                         = empresa, role)
                                                      └─ inválida → EXCEPTION (no hay usuario)
  correo → /auth/callback?invite=<t> → /join/<t> → redeem (no-op R13) → /dashboard
  correo en otro navegador → /auth/callback/complete?invite=<t>&error_code=… → /login?invite=<t>
                     → /join/<t> → redeem (no-op) → /dashboard           (y sin ?invite=, igual: ya es miembro)

/join/<t> ─ con sesión ─ POST redeem una vez ─ 200 → /dashboard
                                             ├ 409 → modal de conflicto (actual)
                                             └ 400 → tarjeta con reason
/login?invite=<t> → postLoginDestination → /join/<t> → (igual que «con sesión»)
```

La clave es que el usuario nuevo **nunca** pasa por `redeem`: nace dentro de la empresa. `redeem`
queda para quien ya tenía cuenta (casos 2 y 3) y como no-op idempotente para quien llega a
`/join` ya siendo miembro (alta nueva tras confirmar el correo, invitado del panel tras
`/reset-password`).

## 2. Migración `supabase/migrations/090_invite_direct_join.sql`

Número: la última es `089_whatsapp_coexistence_batches.sql`. Idempotente: solo
`CREATE OR REPLACE FUNCTION` + `ALTER FUNCTION … OWNER` + `REVOKE/GRANT`. No toca tablas, ni
el trigger `on_auth_user_created` (sigue apuntando a `public.handle_new_user()`), ni RLS.

### 2.0 Asientos en SQL (R30–R33)

```sql
-- Límite `operators` del plan vigente; NULL = sin límite. Espejo de getEntitlements +
-- normalizeLimits (src/lib/billing/entitlements.ts): sin suscripción → 'inicio'
-- (DEFAULT_PLAN_ID); valor no numérico → NULL (normalizeLimits lo descarta).
CREATE OR REPLACE FUNCTION public.account_seat_limit(p_account_id UUID)
RETURNS INTEGER LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT CASE WHEN jsonb_typeof(p.limits->'operators') = 'number'
              THEN floor((p.limits->>'operators')::numeric)::int END
  FROM plans p
  WHERE p.id = COALESCE(
    (SELECT s.plan_id FROM subscriptions s WHERE s.account_id = p_account_id), 'inicio');
$$;

-- Lanza `no_seats` si un miembro más no cabe. Bloquea la fila de `accounts` para
-- serializar altas/canjes concurrentes en la misma cuenta.
CREATE OR REPLACE FUNCTION public.assert_seat_available(p_account_id UUID, p_errcode TEXT)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_limit INTEGER; v_members INTEGER;
BEGIN
  PERFORM 1 FROM accounts WHERE id = p_account_id FOR UPDATE;
  v_limit := account_seat_limit(p_account_id);
  IF v_limit IS NULL THEN RETURN; END IF;
  SELECT count(*) INTO v_members FROM profiles WHERE account_id = p_account_id;
  IF v_members + 1 > v_limit THEN
    RAISE EXCEPTION 'The account has no free seats on its plan'
      USING ERRCODE = p_errcode, HINT = 'no_seats';
  END IF;
END; $$;
```

Ambas `OWNER TO postgres`, `REVOKE ALL … FROM PUBLIC, anon, authenticated` (solo las llaman
las funciones SECURITY DEFINER de esta migración; no son RPC). Plan inexistente en el catálogo
→ `account_seat_limit` devuelve `NULL`: el TS lanza en ese caso, pero en SQL fallar abierto
evita que un plan borrado bloquee todas las altas; se anota en la cabecera. *(Si el reviewer
prefiere fallar cerrado, basta `RAISE` cuando no hay fila: no cambia ningún R.)*

Qué es un asiento y por qué solo miembros aquí: `countSeats`/`POST` de invitaciones cuentan
miembros + pendientes vigentes **para emitir** un enlace (R28) — una pendiente es una reserva.
Al **consumir** un enlace, la reserva que se convierte es la propia, así que la pregunta
correcta es «¿cabe un miembro más en el plan de hoy?»: miembros + 1 ≤ límite. Con el plan
intacto siempre cabe (la reserva lo garantizó); si el plan bajó, cabe el primero que llegue.
Caducadas y revocadas no cuentan en ningún lado: el filtro `expires_at > now()` las saca del
conteo de emisión y la revocación es un `DELETE` (R29); y no pueden consumirse (R4).

### 2.1 `public.handle_new_user()` (reemplaza la de 017)

```sql
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name  TEXT := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_invite     JSONB := NEW.raw_user_meta_data->'invite_token';
  v_token      TEXT;
  v_inv        account_invitations%ROWTYPE;
  v_account_id UUID;
BEGIN
  -- Rama de invitación (i12.1): fuera del bloque que traga errores.
  IF v_invite IS NOT NULL AND jsonb_typeof(v_invite) <> 'null' THEN
    IF jsonb_typeof(v_invite) <> 'string' THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;
    v_token := v_invite #>> '{}';
    IF length(v_token) NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;

    SELECT * INTO v_inv
    FROM account_invitations
    WHERE token_hash = encode(pg_catalog.sha256(convert_to(v_token, 'UTF8')), 'hex')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;
    IF v_inv.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'used';
    END IF;
    IF v_inv.expires_at <= NOW() THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'expired';
    END IF;

    PERFORM assert_seat_available(v_inv.account_id, 'P0001');   -- R30

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_inv.account_id, v_inv.role);

    UPDATE account_invitations
    SET accepted_at = NOW(), accepted_by_user_id = NEW.id
    WHERE id = v_inv.id;

    RETURN NEW;
  END IF;

  -- Rama de siempre (017), sin cambios de comportamiento (R6).
  BEGIN
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;
```

Notas:

- **Hash en SQL con `pg_catalog.sha256()`** (núcleo de Postgres ≥ 11; la imagen de CI es 17),
  no `pgcrypto.digest`: pgcrypto vive en el esquema `extensions` de Supabase, que no está en el
  `search_path = public` de la función, y ninguna migración del repo depende de él. Paridad con
  `hashInviteToken` (`src/lib/auth/invitations.ts`, `createHash('sha256').update(token)` =
  UTF-8): el vector fijo de `src/lib/auth/invitations.test.ts` l. 53-54
  (`invite-token-abc` → `51481b40…352f`) se comprueba también en SQL (checks §0).
- **Por qué el token en claro en `raw_user_meta_data` y no el hash calculado antes de
  `signUp`.** `signUp` se llama en el navegador (`src/app/(auth)/signup/page.tsx`); calcular el
  hash ahí obligaría a duplicar `hashInviteToken` con `crypto.subtle` (asíncrono, otra
  implementación que mantener en paridad) o a mover el alta a una ruta de servidor, lo que
  cambia el flujo PKCE de `@supabase/ssr`. El token en claro solo queda persistido en
  `auth.users` si el alta **consumió** la invitación (si la rechaza, la transacción entera se
  deshace), y una invitación consumida no se puede volver a canjear (`accepted_at`), así que
  la garantía de 017 («un volcado de la base no da invitaciones usables») se mantiene. El
  metadato es visible solo para el propio usuario (su JWT), que ya tenía el enlace.
- **Rechazo en el alta, no después (R4).** Con `invite_token` presente y no válido se lanza
  excepción: GoTrue responde 500 «Database error saving new user» y no crea nada. Es la
  alternativa a «crear en silencio una empresa nueva»: el invitado ve el motivo (R10) y pide
  otro enlace. Sin `invite_token` se conserva el `RAISE WARNING` de 017 (R6) — cambiarlo está
  fuera de alcance y rompería altas hoy toleradas.
- **Caducidad entre alta y confirmación.** La invitación se evalúa y consume en el alta; desde
  ahí el usuario ya es miembro. La confirmación del correo no vuelve a mirar la invitación;
  manda la caducidad del enlace de Supabase. Ver «Riesgos aceptados» en `requirements.md`.
- **Asientos (R21, R30).** La invitación reservó el asiento al crearse (miembros + pendientes en
  `POST /api/account/invitations` y `countSeats`); el trigger la consume una sola vez
  (`FOR UPDATE` + `accepted_at IS NULL`) y además comprueba `assert_seat_available` contra el
  plan vigente (§2.0), así que los miembros nunca superan el límite aunque el plan haya bajado.
  El rechazo no consume la invitación (la transacción se deshace): si el admin libera un
  asiento o sube de plan, el mismo enlace vuelve a valer. Decisión marcada para el humano en
  `requirements.md`.
- **RLS / SECURITY DEFINER.** Igual que 017: corre como `postgres` (dueño de
  `account_invitations` y `profiles`), lo dispara `supabase_auth_admin`. `BEFORE UPDATE`
  `enforce_profile_privilege_columns` (034) no aplica a un `INSERT`. El `REVOKE` es higiene:
  una función `RETURNS TRIGGER` no se puede llamar por RPC de todos modos.
- `on_account_created_seed_trial` (073) no se dispara en la rama de invitación porque no hay
  `INSERT INTO accounts` (R2).

### 2.2 `public.redeem_invitation(text)` (reemplaza la de 073)

Cuerpo de 073 copiado con tres cambios:

1. Tras `IF NOT FOUND` (que pasa a llevar `HINT = 'not_found'`), **antes** de mirar
   `accepted_at`/`expires_at`, leer la cuenta del llamante; si
   `v_old_account_id = v_inv.account_id` → `RETURN v_inv.account_id` sin escribir nada (R13).
   Esto sustituye al `RAISE 'You are already a member of this account' (23505)` de 073.
   Una invitación pendiente que abre quien ya es miembro (p. ej. el propio admin probando su
   enlace) **no** se consume: sigue pendiente y revocable.
2. `HINT` en cada rechazo: `used`, `expired` (22023); `shared_account` (dueño distinto) y
   `has_data` (23505) (R16). Los mensajes se conservan.
3. Justo antes del `UPDATE profiles`, `PERFORM assert_seat_available(v_inv.account_id,
   '22023')` (R31). Va después del guardián de datos para que un 409 por datos siga
   ganando a un 400 por asientos (el usuario no podría entrar de todos modos).
4. Nada más: el guardián de datos, la limpieza de `checkout_intents`, `usage_counters`,
   `subscriptions` y el `DELETE FROM accounts` quedan idénticos (las aserciones 049/052 de
   `verify-schema.sql` lo vigilan).

`ALTER … OWNER TO postgres; REVOKE ALL … FROM PUBLIC; GRANT EXECUTE … TO authenticated;`
como en 073.

### 2.2b `public.peek_invitation(text)` (reemplaza la de 019)

Igual que 019 más una comprobación tras `expires_at`: si `account_seat_limit(cuenta)` no es
`NULL` y los miembros ya lo alcanzan → `json_build_object('ok', false, 'reason', 'no_seats')`
(R32). Solo lectura (sin `FOR UPDATE`; sigue `STABLE`). Revela a quien tiene el token que la
empresa está llena, nada más. Mismos `GRANT` a `anon, authenticated`.

### 2.3 `supabase/ci/verify-schema.sql`

Bloque `-- 090` dentro del `DO` único (antes de `RAISE NOTICE 'schema verification passed'`):

- `pg_get_functiondef('public.handle_new_user()'::regprocedure)` contiene `invite_token`,
  `sha256(` y `FOR UPDATE`, y es `prosecdef`.
- `on_auth_user_created` sigue existiendo en `auth.users` y apunta a `handle_new_user`
  (`pg_trigger` + `tgfoid`).
- `pg_get_functiondef('public.redeem_invitation(text)'::regprocedure)` contiene `HINT` y
  `assert_seat_available` (además de las aserciones 049/052 ya existentes, que siguen pasando);
  `handle_new_user()` también contiene `assert_seat_available`; `peek_invitation(text)`
  contiene `no_seats`.
- `public.account_seat_limit(uuid)` y `public.assert_seat_available(uuid, text)` existen, son
  `prosecdef`, y ni `anon` ni `authenticated` tienen `EXECUTE`
  (`has_function_privilege`).

## 3. Código TypeScript

### 3.1 `src/lib/auth/join-flow.ts` (nuevo, puro)

```ts
export type JoinFailReason = 'not_found' | 'used' | 'expired' | 'no_seats' | 'server_error';
export interface InvitePeek { account_name: string; role: 'admin' | 'agent' | 'viewer'; expires_at: string }
export type JoinState =
  | { kind: 'redirect'; to: '/dashboard' }
  | { kind: 'conflict'; message: string; peek: InvitePeek | null }
  | { kind: 'fail'; reason: JoinFailReason }
  | { kind: 'signedOut'; peek: InvitePeek };

export async function resolveJoin(opts: {
  token: string;
  isSignedIn: () => Promise<boolean>;
  fetchImpl?: typeof fetch;
}): Promise<JoinState>;
```

Orden: con sesión → **un** `POST /api/invitations/<t>/redeem`; 200 → `redirect`; 409 → `GET
peek` para el nombre de la empresa (si falla, `peek: null`) → `conflict`; 400 → `fail` con
`body.reason` validado contra la unión (otro valor → `not_found`); 401 → sigue como sin sesión;
5xx/excepción → `fail: server_error`. Sin sesión → `GET peek` → `signedOut` o `fail`.

### 3.2 `src/app/join/[token]/page.tsx` (reescrito) + `join-view.tsx` (nuevo)

- `page.tsx` (`'use client'`, `useParams` como hoy —
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/use-params.md`): un
  `useRef` `started` como en `src/app/(auth)/auth/callback/complete/page.tsx` para que el
  doble montaje de StrictMode no lance dos `POST`; llama `resolveJoin`; en `redirect` hace
  `window.location.replace('/dashboard')` (recarga completa: el `AuthProvider` relee el
  perfil); conserva `handleSignOutAndRetry` (con `endSupportSession`) para el modal.
- `join-view.tsx`: `export function JoinView(props: { state: JoinState | null; token: string;
  onRetry(): void; onSignOut(): void; signingOut: boolean })`, presentacional, con
  `useTranslations('JoinPage')`. Estados: `null`/`redirect` → «Entrando a tu empresa…»
  (spinner, `role="status"`); `fail` → tarjeta actual con copy traducido; `signedOut` →
  cabecera empresa/rol + dos enlaces (R17); `conflict` → tarjeta de cabecera + `Dialog`
  abierto (R14), botón secundario «Ir a mi cuenta» → `<Link href="/dashboard">`. Desaparecen el
  botón «Accept invitation», el estado `accepting`, el `toast.success` y el párrafo
  «Accepting moves your login into…».
- Se actualiza el comentario de cabecera (ya no «We deliberately do NOT redeem automatically»).

### 3.3 `src/app/api/invitations/[token]/redeem/route.ts`

`rpcErrorToResponse` añade `reason: err.hint ?? undefined` al JSON de 400 y 409 (R16). Sin
otros cambios (rate limit, `getUser`, códigos). Comentario de cabecera: «canje automático
desde /join; no-op si ya es miembro».

### 3.4 `src/lib/auth/signup-invite.ts` (nuevo, puro) + `src/app/(auth)/signup/page.tsx`

```ts
export type SignupInviteGate =
  | { kind: 'none' }                                  // sin ?invite=
  | { kind: 'loading' }
  | { kind: 'ok'; peek: InvitePeek }
  | { kind: 'fail'; reason: JoinFailReason };
export function signupInviteGate(token: string | null, peek: unknown | undefined): SignupInviteGate;
export function signupOptions(opts: { fullName: string; inviteToken: string | null; origin: string }):
  { data: { full_name: string; invite_token?: string }; emailRedirectTo: string };
export function isInviteSignupRejection(err: { status?: number; message?: string } | null): boolean;
```

- `signupOptions` usa `authCallbackUrl(origin, { invite })` (`src/lib/auth/redirects.ts`) y
  solo añade `invite_token` si hay token (R9).
- `isInviteSignupRejection`: `status >= 500` o mensaje que contiene
  `Database error saving new user` (texto de GoTrue cuando el trigger aborta) (R10).
- `page.tsx`: con `?invite=` hace `GET peek` al montar; `loading` → spinner; `fail` → vista de
  fallo (mismo copy que `JoinPage.fail.*`) con enlace a `/signup` sin invitación; `ok` →
  formulario con título/descripción de `SignupInvite` nombrando empresa y rol. En error de
  `signUp`, si `isInviteSignupRejection` → repite el peek y pasa a `fail`. Éxito → pantalla
  «revisa tu correo» con `SignupInvite.checkEmail*` (R11). Sin `?invite=` el formulario es el
  de hoy.
- La vista de invitación va en `src/app/(auth)/signup/signup-invite-view.tsx` (presentacional,
  testeable con `renderToStaticMarkup` como `complete/page.test.tsx`).

### 3.5 `src/lib/auth/callback.ts` + `src/app/(auth)/auth/callback/complete/page.tsx`

```ts
export function callbackExitLinks(search: string): { login: string; forgotPassword: string };
```

Lee `invite` de `search` y devuelve `/login?invite=<t>` y `/forgot-password?invite=<t>` (sin
`invite` → `/login`, `/forgot-password`), con `encodeURIComponent`. La página usa esos `href`
(R18). `/forgot-password` hoy ignora `?invite=`; queda inofensivo y documentado (el correo de
recuperación ya lleva al usuario por `/reset-password`, que sí lo respeta si se le pasa —
fuera de alcance cablearlo).

### 3.6 Panel de operador

- `src/lib/platform/provisioning.ts` · `inviteAuthUser(params: { email; fullName?; redirectTo;
  inviteToken?: string })`: `data` = `{ full_name?, invite_token? }` solo con lo presente.
  Cabecera del archivo y JSDoc: el invitado con token nace en la empresa (ya no «a company of
  their own»).
- `src/app/api/platform/accounts/[id]/members/route.ts`: pasa `inviteToken: token`. Como la
  fila se inserta antes de `inviteAuthUser`, el trigger la encuentra. Si el trigger aborta
  (no debería: la invitación es de hace milisegundos), `inviteAuthUser` devuelve
  `failed` → `emailed: false` y el operador comparte el `url` como hoy. Comentario de cabecera
  actualizado (ya no «cleans up their empty personal one»).
- `src/app/api/platform/accounts/route.ts` (crear empresa) no cambia (R24).

### 3.7 Login y onboarding

- `src/app/(auth)/login/page.tsx`: sin cambios de lógica; solo cambia el copy de
  `LoginPage.titleAccept`/`descAccept`. `postLoginDestination` ya manda a `/join/<t>` (R19).
- `src/lib/onboarding/gate.ts` / `state.ts`: sin cambios. `loadOnboardingState` resuelve por la
  cuenta del perfil (`ctx.accountId`): el miembro nacido por R1 hereda el estado de la empresa
  (R20). Solo se añade un test.
- `src/middleware.ts`: sin cambios (ya manda `/login?invite=` y `/signup?invite=` con sesión a
  `/join/<t>`).

## 4. Claves i18n (`messages/en.json` fuente, `messages/es.json` traducción)

Namespace nuevo `JoinPage`:

| Clave | en | es |
|---|---|---|
| `loading` | Taking you to your team… | Entrando a tu empresa… |
| `invitedTo` | You're invited to {account} | Te invitaron a {account} |
| `joinAs` | You'll join as {role}. Link valid until {date}. | Entrarás como {role}. El enlace vale hasta el {date}. |
| `roles.admin` / `roles.agent` / `roles.viewer` | Admin / Agent / Viewer | Administrador / Agente / Observador |
| `createAndJoin` | Create account & join | Crear cuenta y entrar |
| `haveAccount` | I already have an account | Ya tengo cuenta |
| `fail.not_found.title` / `.body` | (copy actual de `FAIL_COPY`) | traducción |
| `fail.used.*`, `fail.expired.*`, `fail.server_error.*` | ídem | ídem |
| `fail.no_seats.title` / `.body` | This team is full / This team has no free seats on its plan. Ask an admin to free a seat or upgrade the plan, then open this link again. (sin placeholder: `peek` no devuelve el nombre en los fallos) | Este equipo está completo / La empresa no tiene asientos libres en su plan. Pide a un administrador que libere uno o mejore el plan y vuelve a abrir este enlace. |
| `tryAgain` | Try again | Reintentar |
| `createNewAccount` | Create a new account instead | Crear una cuenta nueva |
| `signIn` | Sign in | Iniciar sesión |
| `conflict.title` | Can't join {account} with this account | No puedes entrar a {account} con esta cuenta |
| `conflict.titleNoName` | Can't join this team with this account | No puedes entrar a este equipo con esta cuenta |
| `conflict.fallback` | You are already in another account. Sign in with a different email to join this one. | Ya perteneces a otra cuenta. Entra con otro correo para unirte a esta. |
| `conflict.hint` | To join, sign out and sign up again with a different email address. The invite link stays valid until it expires. | Para entrar, cierra sesión y regístrate con otro correo. El enlace sigue valiendo hasta que caduque. |
| `conflict.goToMyAccount` | Go to my account | Ir a mi cuenta |
| `conflict.signOut` | Sign out & use a different email | Cerrar sesión y usar otro correo |
| `conflict.signingOut` | Signing out… | Cerrando sesión… |
| `signOutError` | Could not sign out. Try refreshing the page. | No se pudo cerrar la sesión. Recarga la página. |

Namespace nuevo `SignupInvite`: `title` («Create your account at {account}» / «Crea tu cuenta en
{account}»), `description` («You'll go straight into {account} as {role} once you confirm your
email.» / «Al confirmar tu correo entrarás directamente a {account} como {role}.»), `checking`
(«Checking your invitation…» / «Comprobando tu invitación…»), `checkEmailTitle`,
`checkEmailBody` («We've sent a confirmation link to {email}. Open it and you'll land in
{account}.» / «Te enviamos un enlace de confirmación a {email}. Ábrelo y entrarás a
{account}.»), `rejected` («This invitation is no longer valid. Ask for a new link.» / «Esta
invitación ya no es válida. Pide un enlace nuevo.»). Los motivos de fallo reutilizan
`JoinPage.fail.*` y los roles `JoinPage.roles.*`.

`LoginPage.titleAccept` / `descAccept` cambian de copy (mismas claves): en «Sign in to join your
team» / «Sign in and you'll go straight into your team.»; es «Inicia sesión para entrar a tu
empresa» / «Inicia sesión y entrarás directamente a tu empresa.»

Si alguna traducción es idéntica al inglés (p. ej. ninguna prevista), se añade a
`IDENTICAL_TO_SOURCE_OK` de `src/i18n/messages.test.ts` con su motivo. Los mensajes ICU pasan
`src/i18n/icu-safety.test.ts`.

## 5. Manejo de errores

| Punto | Fallo | Respuesta |
|---|---|---|
| Trigger, rama invitación | token inválido/usado/caducado, sin asientos (`no_seats`), error del `INSERT` | `EXCEPTION` → alta abortada, GoTrue 500; `/signup` re-peek y muestra el motivo (R4, R5, R10) |
| Trigger, rama personal | cualquier error | `RAISE WARNING` como 017 (R6) |
| `redeem` | ya miembro | 200 no-op (R13) |
| `redeem` | 22023 / 23505 | 400 / 409 con `reason` (HINT; incluye `no_seats`) (R16, R31) |
| `/join` | `peek` falla tras 409 | modal con `conflict.titleNoName` |
| `/join` | red / 5xx | `fail: server_error` + «Reintentar» (re-ejecuta `resolveJoin`, que vuelve a hacer como mucho un `POST`) |
| Panel | `inviteUserByEmail` falla | `emailed: false`, el operador comparte el enlace (como hoy) |

## 6. Alternativas descartadas

- **Auto-canje sin tocar el trigger** (crear cuenta personal y canjear al confirmar). Es lo de
  hoy con un clic menos: sigue dejando empresa intermedia, se rompe con PKCE cruzado, con la
  allowlist de Redirect URLs (`docs/docker.md` l. 352) y con el 409 tras el onboarding. El
  objetivo pide que el usuario nuevo nunca tenga cuenta personal.
- **`pgcrypto.digest`.** Ver 2.1: vive en `extensions`, fuera del `search_path`, y el núcleo ya
  trae `sha256()`.
- **Hash calculado antes de `signUp`** (navegador o ruta de servidor). Ver 2.1.
- **Seguir tragando el error y crear empresa personal si la invitación falla.** Es justo el
  síntoma que se corrige: el invitado acabaría en una empresa vacía sin saberlo.
- **Confiar solo en la reserva de la invitación** (no leer el plan en SQL). Más simple, pero
  si el plan baja con enlaces pendientes, entran más miembros de los que el plan permite: choca
  con «la cantidad de usuarios invitados depende del plan». La duplicación con
  `getEntitlements` se acota a una función de una consulta (`account_seat_limit`) con test de
  paridad del plan por defecto (R33).
- **Comprobar asientos en `/signup` (TS) antes de `signUp`.** Llega tarde a la carrera (dos
  altas a la vez) y no cubre `inviteUserByEmail`; el trigger es el único punto por el que pasan
  todas las altas. `/signup` solo lo **muestra** vía `peek` (R32).
- **Membresía al confirmar el correo (trigger `AFTER UPDATE OF email_confirmed_at`).** Obliga a
  que el usuario exista sin perfil hasta confirmar, y todo el código asume perfil desde el
  alta (`findProfileByEmail`, `getCurrentAccount`). Se acepta el riesgo de R1 (ver
  requisitos).
- **Borrar `peek`/`redeem`.** `peek` lo necesitan `/join` sin sesión y `/signup?invite=`;
  `redeem` lo necesitan los usuarios existentes (casos 2 y 3).

## 7. Qué sobrevive y qué se elimina

| Pieza | Destino |
|---|---|
| `peek_invitation` + `GET …/peek` | Sobrevive; nuevo motivo `no_seats` |
| `redeem_invitation` + `POST …/redeem` | Sobrevive; no-op para miembros, `HINT`/`reason` |
| Botón «Accept invitation», estado `accepting`, toast «Welcome to the team», párrafo «Accepting moves your login into…» | Se eliminan |
| Modal de conflicto 409 | Sobrevive, traducido; «Stay signed in» → «Ir a mi cuenta» (`/dashboard`) |
| `?invite=` por callback / reset-password / login | Sobrevive (lleva a `/join`, que ahora es no-op o canje automático) |
