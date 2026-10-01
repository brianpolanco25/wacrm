# impl s9.4 `platform-provisioning`

## Plan
1. Migración `071_platform_provisioning.sql`: CHECK de `impersonation_log.action` ampliado (plan_override, account_create, member_invite, operator_grant, operator_revoke); `details jsonb`; `account_id` nullable solo para account_create/operator_*; comprobar `has_open_support_session`. Aserciones `-- 071` en verify-schema.
2. `src/lib/platform/provisioning.ts`: búsqueda de usuario por correo, invitación de Supabase, renombrar cuenta, plan manual, operadores. `audit.ts` gana las acciones nuevas y `details`.
3. Rutas: `POST /api/platform/accounts`, `POST /api/platform/accounts/[id]/plan`, `POST /api/platform/accounts/[id]/members`, `GET/POST /api/platform/operators`, `DELETE /api/platform/operators/[userId]`, `GET /api/platform/plan-options`.
4. UI: «Nueva empresa» en `/platform/accounts`, selector de plan + añadir miembro en la ficha («Asignado a mano»), `/platform/operators` con tabla/formulario/revocación.
5. Caché: regla `/platform/:path*` → `private, no-store` en `next.config.ts` + test.
6. i18n `Platform.provisioning` y `Platform.operators` es/en/ko.
7. Tests vitest por criterio + suite de aislamiento; SQL de base real en `progress/checks_platform-provisioning.sql`.
8. CHANGELOG, compuerta, commits.

## Estado: done (pendiente de reviewer) — con un riesgo funcional que el líder debe decidir (ver «Riesgo 1»)

Rama `platform/provisioning` (worktree `.claude/worktrees/platform-provisioning`), base `feat/superadmin` @ ddc07f6. Sin push.

| Commit | Qué |
|---|---|
| `1935628` | feat: migración 071 + aserciones `-- 071` en `verify-schema.sql` |
| `ca32b09` | feat: `src/lib/platform/provisioning.ts`, `audit.ts` ampliado, rutas `POST /api/platform/accounts`, `[id]/plan`, `[id]/members`, `/operators`, `/operators/[userId]`, `/plan-options`; tests de ruta, de lib y suite de aislamiento |
| `41ca8ab` | fix: `Cache-Control: private, no-store` en `/platform*` (`next.config.ts`) + `src/next-config.test.ts` |
| `aabf4a7` | feat: UI (Nueva empresa, plan a mano, añadir miembro, página de operadores) + i18n es/en/ko |
| `71bb414` | docs: CHANGELOG (al final del bloque Unreleased) |

## Compuerta (worktree, HEAD 71bb414)
- `npm run lint`: 0 errores, 35 warnings (las mismas preexistentes; ninguna en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 219 archivos, **2944 tests** verdes (la base dejaba 2794 + lo de s9.2).
- `npm run build` con variables dummy: verde; aparecen `ƒ /api/platform/accounts/[id]/members`, `/plan`, `/api/platform/operators`, `/operators/[userId]`, `/api/platform/plan-options`.
- `scripts/replay-migrations.sh <worktree>`: `ok 071_platform_provisioning.sql`, `verify-schema.sql: OK`. La 071 se reaplicó sobre la base viva sin error (idempotente) y `verify-schema` volvió a pasar.

## Archivos
- `supabase/migrations/071_platform_provisioning.sql`, `supabase/ci/verify-schema.sql` (bloque `-- 071` antes del `RAISE NOTICE` final).
- `src/lib/platform/provisioning.ts` (+ test), `src/lib/platform/audit.ts` (+ test), `src/lib/platform/accounts.ts` (solo añade `provider` a la ficha).
- Rutas: `src/app/api/platform/accounts/route.ts` (POST nuevo; GET intacto) + `create.test.ts`; `accounts/[id]/plan/route.ts` (+ test); `accounts/[id]/members/route.ts` (+ test); `operators/route.ts` + `operators/[userId]/route.ts` (+ `operators/route.test.ts`); `plan-options/route.ts` (+ test).
- `next.config.ts`, `src/next-config.test.ts`.
- UI: `src/components/platform/platform-provisioning.tsx`, `platform-operators.tsx` (+ `platform-provisioning.test.tsx`), cambios mínimos en `platform-accounts.tsx` (monta `NewAccountButton`) y `platform-account-detail.tsx` (`provider`, insignia «Asignado a mano», `PlanAssignment` y `AddMemberForm`); `src/app/(platform)/platform/operators/page.tsx` usa `PlatformOperators`.
- `src/lib/security/tenant-isolation.test.ts`: imports, mock de `inviteAuthUser` que simula `handle_new_user`, `h.invitedEmails`, y describe `/api/platform provisioning (s9.4, service role)` (antes del bloque de etiquetas). Waivers por test (`extraWaivers`), ninguno global.
- `messages/{es,en,ko}.json`: solo `Platform.provisioning.*` y `Platform.operators.*`.
- `CHANGELOG.md`.
- NO tocado: nada de `Platform.plans`, `/api/platform/plans*`, `/platform/plans`, `plan-catalog.ts`, `paypal-catalog.ts`, migración 070; `handle_new_user()`, `redeem_invitation()`, `has_open_support_session()`.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| CHECK de `action` ampliado (5 actos) sin perder los de la 058 | `verify-schema.sql` bloque 071; `checks_platform-provisioning.sql` §1 «widened CHECK + account rule» (inserta los 5, rechaza `bogus`) |
| Caducidad obligatoria solo para `impersonation` | checks §1 (impersonation sin `expires_at` → check_violation) |
| `account_id` NULL solo para account_create/operator_* | checks §1 (impersonation/suspend/reactivate/plan_override/member_invite con NULL → rechazadas); `verify-schema` (`impersonation_log_account_required`) |
| `has_open_support_session` ignora `plan_override` | checks §2 (fila plan_override/member_invite «abierta» → false; control con impersonation → true); `verify-schema` (prosrc con `action = 'impersonation'`) |
| El inquilino no puede escribir su `subscriptions` (ni la bitácora) | checks §3 (UPDATE 0 filas, DELETE 0/denegado, upsert e INSERT en `impersonation_log` → insufficient_privilege; la fila sigue en `pro`) |
| Plan manual como service_role, comped y fuera del MRR | checks §4 (upsert, `platform_metrics().comped ≥ 1`) |
| Operadores: grant/revoke atómicos, no a uno mismo, nunca el último, no dos veces, usuario inexistente, motivo corto revierte el alta; `authenticated` no ejecuta | checks §5 y final |
| `details` jsonb en la bitácora; account_create sin cuenta; rellenar la cuenta una sola vez | `src/lib/platform/audit.test.ts` › `stores what the act needs to remember in details (071)`, `writes an account_create row before the company exists, with no account`, `attachAccountToAuditRow` › `fills the account of that row only, and only while it has none`, `hands back the details of the s9.4 acts…` |
| **Crear empresa**: 401/403 | `src/app/api/platform/accounts/create.test.ts` › `401s a visitor with no session, and invites nobody`, `403s a company owner` |
| 400 nombre/correo/motivo (<10)/plan desconocido | › `400s %s, and writes nothing` (8 casos) |
| 409 correo con usuario, antes de escribir nada | › `409s an email that already has a user — before writing anything`; carrera con Supabase › `409s when Supabase says the user exists` |
| Bitácora ANTES de invitar; invite → attach → rename; `redirectTo` absoluto | › `audits, invites, attaches, renames — in that order — and answers 201`, `builds the redirect from NEXT_PUBLIC_SITE_URL when it is set`, `invites NOBODY when the trail cannot be written` |
| Plan opcional al crear | › `gives the new company the plan by hand, with the same reason`, `still reports the company when the plan could not be given` |
| Invite falla / trigger no creó cuenta | › `502s when the invitation could not be sent…`, `says so when the trigger did not create the company` |
| **Plan a mano**: 401/403, 400 motivo (misma constante que la 058), 400 plan, 404 | `src/app/api/platform/accounts/[id]/plan/route.test.ts` › `401s without a session`, `403s a company owner — including on his own company`, `400s a reason shorter than the log minimum (the 058 constant)`, `400s a missing plan`, `400s a plan that is not in the catalogue`, `404s a malformed id and an account that does not exist` |
| 409 si PayPal sigue cobrando (no cancela) | › `409s a subscription PayPal is still billing: cancel it there first`; lib › `refuses a subscription PayPal is still billing, and writes nothing`; `isLivePayPalSubscription` (6 casos) |
| Fila manual: provider manual, active, sin id/ciclo/trial/gracia, cancel_at_period_end=false, sin tocar `manual_hold_*` | `src/lib/platform/provisioning.test.ts` › `manualPlanRow` › `is manual and active, clears every gateway field, leaves the hold alone` |
| Bitácora antes del upsert con `{from_plan,to_plan,from_provider}` | lib › `records from/to plan and provider, THEN upserts the manual row for that account only`, `changes nothing when the trail cannot be written` |
| Ficha: «Asignado a mano» con `provider='manual'` | `src/components/platform/platform-provisioning.test.tsx` › `shows «Asignado a mano» for a manual plan (out of the MRR)`, `does not for a PayPal plan…`; `platform-panel.test.tsx` (la clave `provisioning.manualBadge` de la ficha existe en en/ko) |
| Selector de plan con confirmación | `PlanAssignment` usa `window.confirm` (repo precedent); render › `offers every plan and cannot assign before choosing one with a reason` |
| **Añadir miembro**: 401/403, 400 correo/rol (nunca owner), 404, 409 ya miembro, límite de puestos | `src/app/api/platform/accounts/[id]/members/route.test.ts` › guard, `400s %s` (4), `404s…`, `409s someone who is already in this company`, `refuses past the seat limit of the plan, like the Members tab` (402), `lets an unlimited plan invite past any number` |
| Reutiliza la invitación (`account_invitations` + `/join/<token>` con hash) y bitácora `member_invite` antes | › `audits, writes the invitation for THIS company, then emails a new person` (comprueba `hashInviteToken(token) === tokenHash`), `does not email someone who already has a user…`, `still hands back the link when the email could not be sent`, `invites NOBODY when the trail cannot be written` |
| **Operadores**: 401/403 en GET/POST/DELETE | `src/app/api/platform/operators/route.test.ts` › `401s without a session`, `403s a company owner — he cannot promote himself` |
| GET lista con correo/nombre | › `lists the operators and says who is asking`; lib › `lists platform_admins with their names from profiles` |
| POST: usuario existente; 404 «primero debe registrarse»; 400; 409 | › `grants an existing user…`, `404s an email with no user: they must sign up first`, `400s a bad email or a short note`, `409s someone who is already an operator` |
| DELETE: no a uno mismo (400), no al último (400), 404, motivo | › `400s revoking oneself, without even asking the database`, `400s revoking the last operator`, `400s when the database says self`, `404s someone who is not an operator, and a malformed id`, `400s a missing or short reason`; lib › `maps %j to %s` (7 códigos) |
| UI operadores: tabla, «Tú», sin revocar la fila propia, formulario | render › `lists every operator, marks you, and offers «revoke» on the others only`, `opens on the loading state…`, `says so when the list could not be loaded` |
| CP3 fuga A↔B | `tenant-isolation.test.ts` › `/api/platform provisioning (s9.4, service role)` › `403s the owner of A on every s9.4 route, and moves nothing`, `creates a company: a new account, renamed and on a manual plan — A and B untouched`, `409s an email that already has a user, and creates nothing`, `assigns a plan by hand to ONE company…`, `409s a company PayPal is still billing…`, `invites a member to ONE company…`, `grants and revokes an operator: platform_admins moves, no company does` (+ la auditoría automática de consultas de rol de servicio tras cada test) |
| Caché `/platform*` → `private, no-store` | `src/next-config.test.ts` › `%s is private, no-store — never public` (6 rutas, con el matcher de Next y «gana la última»), `keeps the security headers…`, `leaves the rest of the app as it was`, `does not catch a page that merely starts with the word` |
| i18n es/en/ko (CP6) | `platform-provisioning.test.tsx` › `is translated in %s (CP6)` (×3 piezas), `every key exists in es, en AND ko (CP6)`; `src/i18n/messages.test.ts` (paridad + «es traducido») |
| `/plan-options` 401/403/200 | `src/app/api/platform/plan-options/route.test.ts` |

## Verificaciones contra base real
`KEEP=1 scripts/replay-migrations.sh <worktree>` y
`docker exec -i <c> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < progress/checks_platform-provisioning.sql`
→ salida 0 (transacción con ROLLBACK):
```
NOTICE:  widened CHECK + account rule: OK
NOTICE:  has_open_support_session ignores plan_override: OK
NOTICE:  control (impersonation opens it): OK
NOTICE:  tenant cannot write subscriptions / the log: OK
NOTICE:  manual plan as service_role (comped, not MRR): OK
NOTICE:  operator grant/revoke functions: OK
NOTICE:  authenticated denied on operator functions: OK
```
Hallazgo durante la verificación: `service_role` no tiene SELECT sobre `auth.users` en la imagen de Supabase (`permission denied for table users`). Las funciones de operadores leen el correo de `profiles` (todo usuario tiene perfil desde la 017). Nota: en esta imagen `auth.uid()` lee `request.jwt.claim.sub`; el SQL fija ese y `request.jwt.claims`.

## Riesgo 1 (funcional, fuera de alcance; decide el líder): aceptar la invitación de Supabase
`inviteUserByEmail` no admite PKCE (lo dice su propio `.d.ts`: el enlace vuelve con los tokens en el fragmento `#access_token=…`, flujo implícito). El cliente del navegador del repo (`createBrowserClient` de `@supabase/ssr`) es PKCE y **rechaza** ese fragmento (`AuthPKCEGrantCodeExchangeError: Not a valid PKCE flow url`). Y no hay página para poner contraseña: `/auth/callback` y `/reset-password`, a los que apunta `forgot-password`, no existen en el repo (deuda preexistente). Consecuencia: el propietario invitado (y el miembro nuevo invitado por correo) recibe el correo, pero al pulsarlo aterriza en `/login` (o en `/join/<token>`) **sin sesión y sin contraseña**. Hoy puede entrar solo si un operador le da una contraseña desde el panel de Supabase, o si se añade una página que canjee el invite (`verifyOtp({ type: 'invite', token_hash })` con una plantilla de correo que envíe `token_hash`, o `setSession` desde el fragmento) y pida contraseña. No lo construí: no está en la sección del spec y toca auth/plantillas de correo de Supabase (CP8). Recomiendo una feature corta «aceptar invitación / fijar contraseña» antes de usar esto en producción.

## Verificación manual pendiente (guion)
Requiere Supabase con SMTP (no hay e2e):
1. Como operador, `/platform/accounts` → «Nueva empresa»: nombre, correo nuevo, plan `negocio`, motivo ≥10 → aviso «Empresa creada…» y enlace a la ficha; la ficha muestra el nombre, `negocio · active` y «Asignado a mano»; la bitácora de la ficha tiene `account_create` y `plan_override`.
2. Repetir con un correo que ya tenga usuario → aviso de 409, no se crea nada.
3. Llega el correo de Supabase al propietario; comprobar que el enlace apunta a `<NEXT_PUBLIC_SITE_URL>/login` (y ver el Riesgo 1).
4. Ficha de una cuenta con suscripción PayPal activa → «Asignar plan» → 409 «cancélala en PayPal primero»; la fila no cambia.
5. Ficha → «Añadir miembro» con correo nuevo → correo con enlace a `/join/<token>`; con un correo de usuario existente → aparece el enlace para copiar; `/join/<token>` lo canjea (flujo actual de invitaciones).
6. `/platform/operators`: conceder a un correo existente (nota ≥10) → aparece en la tabla; a un correo inexistente → «primero debe registrarse»; revocar a otro (prompt con motivo) → desaparece; la fila propia no tiene botón; con dos operadores, que uno revoque al otro y luego intente revocarse → 400.
7. `curl -I <host>/platform/accounts` (con sesión) → `Cache-Control: private, no-store`; `curl -I <host>/dashboard` sigue `public, max-age=0, s-maxage=300…` (build de producción; el test ya lo fija con el matcher de Next).
8. Como inquilino: `POST /api/platform/accounts`, `/api/platform/operators` → 403.

## Decisiones donde el spec era ambiguo
- **Cuenta al crear empresa: ni NULL permanente ni `INSERT INTO accounts`.** `inviteUserByEmail` crea el `auth.users` en el acto (sin confirmar), así que `handle_new_user()` (017) crea la cuenta y el perfil `owner` **en la misma llamada**, no «al aceptar» como dice el spec. La ruta busca la cuenta por `owner_user_id` y la renombra ya. No hace falta tocar `handle_new_user()` ni `redeem_invitation()` ni un `platform_account_id` en metadatos. `accounts.owner_user_id` es NOT NULL → `auth.users`, así que crear la cuenta antes que el usuario era imposible sin relajar eso.
- **`account_id` nullable solo para `account_create`, `operator_grant`, `operator_revoke`** (CHECK `impersonation_log_account_required`). `account_create`: la bitácora va ANTES del acto y en ese momento no hay cuenta; se rellena después con `.is('account_id', null)` (una sola vez). Operadores: el rol está por encima de las cuentas; atarlo a la cuenta de inquilino del afectado ensuciaría su ficha. El afectado va en `details.target_user_id`/`target_email` (índice parcial para buscarlo).
- **Funciones `platform_grant_operator` / `platform_revoke_operator`** (sin SECURITY DEFINER, solo `service_role`): simplifican porque bitácora + acto son atómicos y la regla «no el último» se comprueba con `LOCK TABLE platform_admins IN SHARE ROW EXCLUSIVE MODE` (sin carrera entre dos revocaciones cruzadas). La ruta además rechaza «a uno mismo» sin ir a la base.
- **Motivo para operadores**: el POST pide `{ email, note }`; la nota es el motivo de la bitácora y la `note` de `platform_admins`, mínimo 10 (el CHECK de la 055 lo exige). El DELETE lleva `{ reason }` en el cuerpo (mismo mínimo); la UI lo pide con `window.prompt`, que es a la vez la confirmación.
- **Motivo de `member_invite`**: el spec no pide motivo al añadir miembro; la línea se escribe con `member invite: <correo> as <rol>` para cumplir el CHECK.
- **`ownerName` opcional** en el POST de empresa: se pasa como `data.full_name` al invite (nombre del perfil del propietario).
- **Añadir miembro**: si el correo ya tiene usuario en otra cuenta, no se envía correo (Supabase no invita a usuarios existentes) y se devuelve el enlace `/join/<token>` para compartir, como la pestaña Equipo; si ya es miembro de esa cuenta → 409. Se aplica el límite de puestos del plan (miembros + invitaciones abiertas), igual que la pestaña Equipo → 402; para más puestos, primero plan mayor.
- **Plan desconocido** → 400; se aceptan planes privados (p. ej. el futuro `ilimitado` de s9.7).
- **409 PayPal** solo con `provider_subscription_id` no nulo y `status` active/past_due; una suscripción PayPal `cancelled`/`suspended` se puede sobrescribir (su historial sigue visible por `checkout_intents`).
- **Planes para los selectores**: ruta propia `GET /api/platform/plan-options`, para no pisar `/api/platform/plans*` de s9.3.
- **`redirectTo`** del propietario = `resolveAppOrigin(request) + '/login'` (`NEXT_PUBLIC_SITE_URL` primero, misma resolución que el checkout de PayPal); del miembro = la URL `/join/<token>`.
- **Caché** en `next.config.ts` (no en el middleware): regla `/platform/:path*` después de la general; `:path*` es «cero o más», cubre `/platform`. El middleware se deja como estaba.

## Variables de entorno nuevas
Ninguna. (`NEXT_PUBLIC_SITE_URL`, ya existente, fija la URL del correo de invitación; `.env.local.example` no se tocó.)

## Deuda detectada fuera de alcance
- Riesgo 1 (página de aceptar invitación / fijar contraseña; `/auth/callback` y `/reset-password` no existen aunque `forgot-password` redirige ahí).
- Un invitado por correo que nunca acepta deja en el censo una cuenta personal vacía (la crea `handle_new_user` al invitar; `redeem_invitation` solo la disuelve al aceptar). Lo mismo con los correos de Supabase al crear empresa: si el propietario nunca acepta, la empresa queda con un usuario sin confirmar.
- Si el invite de Supabase falla tras escribir la línea `account_create`, la línea queda con `account_id` NULL (verdadero: se intentó). No hay limpieza.
- La bitácora de la ficha muestra `action` y motivo pero no `details` (plan de/a, correo); la API ya lo devuelve.
- `Platform.placeholder.operators` y la rama `operators` de `PlatformPlaceholder` quedan sin uso desde `/platform/operators` (su test sigue verde); limpiar junto con el resto del placeholder.
- Merge con s9.3: los tres `messages/*.json` ganan `Platform.provisioning`/`Platform.operators` al final de `Platform`, justo donde s9.3 añade `Platform.plans` → conflicto trivial de JSON adyacente. `verify-schema.sql`: bloque `-- 071` antes del `RAISE NOTICE` final, igual que el `-- 070` de s9.3 → conflicto trivial de orden. `tenant-isolation.test.ts`: bloque nuevo tras `/api/platform/metrics`.
- `supabase/ci/verify-schema.sql` sigue sin aserciones para 067/068 (ya anotado en s9.2).

## Segunda ronda (respuesta a review_platform-provisioning.md, CHANGES_REQUESTED)

Commits: `0da44ea` (hallazgo 1, bloqueante), `b06eb36` (hallazgos 2 y 4). HEAD `b06eb36`. Sin push.

| Hallazgo | Cambio | Test |
|---|---|---|
| 1. Enlace de un solo uso perdido al recargar la ficha (bloqueante) | El enlace deja de vivir en `AddMemberForm`: lo guarda `PlatformAccountDetail` (`inviteLink`) y el formulario lo recibe por prop. La lógica del POST pasa a `sendMemberInvite()` (sin React), que devuelve `emailed` / `link` / `error`. `fileScreen()` decide qué se pinta: con una ficha en pantalla, una recarga (o una recarga fallida) mantiene la ficha montada, y el fallo se avisa con un banner `Platform.provisioning.refreshFailed` (es/en/ko). El spinner a pantalla completa queda solo para la primera carga. Esto también cubre suspender/reactivar/asignar plan, que llamaban al mismo `load()`. | `platform-provisioning.test.tsx` › `«Añadir miembro»: the one-time link survives the reload…` › `a 201 with emailed:false comes back as the link to share`; `and the file, reloading after it, still shows that link`: toma el enlace que devuelve `sendMemberInvite` con un 201 `emailed:false`, pinta la ficha en su estado `loading` (la recarga en curso) y exige la URL, el texto `inviteLink` y el formulario, sin el spinner. Antes del cambio ese estado pintaba solo el spinner. Además `HTTP %s → %j` (4 casos) y `fileScreen(%j) → %s` (5 casos). |
| 2. Origen del enlace sin `ALLOWED_INVITE_HOSTS` | `getBaseUrl` (y `parseAllowedHosts`/`isHostAllowed`) se mueve tal cual de `/api/account/invitations/route.ts` a `src/lib/auth/invitations.ts` como `resolveInviteBaseUrl`. Lo usan la pestaña Equipo (sin cambio de comportamiento), `[id]/members` (`/join/<token>`) y el `redirectTo` del propietario en `POST /api/platform/accounts`. Ya no se usa `resolveAppOrigin` en el panel. | `src/lib/auth/invitations.test.ts` › `resolveInviteBaseUrl…` › `prefers NEXT_PUBLIC_SITE_URL…`, `uses the proxy headers when no site URL is set`, `refuses a host outside ALLOWED_INVITE_HOSTS`. Los tests de ruta (`create.test.ts`, `members/route.test.ts`) siguen verdes con los mismos orígenes esperados. |
| 4. `current_period_end` rancio | `manualPlanRow` pone `current_period_end: null`. | `provisioning.test.ts` › `manualPlanRow › is manual and active, clears every gateway field, leaves the hold alone` (ahora incluye `current_period_end: null`). |

Solo se reformateó con prettier lo nuevo. `invitations.ts`, `invitations.test.ts` y la ruta de la pestaña Equipo no estaban formateados con prettier (comillas dobles) y se editaron a mano, para no reformatear archivos enteros.

### Compuerta (HEAD b06eb36)
- lint: 0 errores (35 warnings preexistentes).
- typecheck: verde.
- `TZ=UTC npm test`: 219 archivos, **2958 tests** verdes.
- build con variables dummy: verde.
- `scripts/replay-migrations.sh`: salida 0 (`ok 071`, `verify-schema.sql: OK`). `progress/checks_platform-provisioning.sql` sobre la base recién replicada: salida 0, los 7 NOTICE en OK. La migración no cambió en esta ronda.

### Deuda anotada, sin tocar (hallazgos 3, 5, 6 y 7)
- 3: con un usuario existente solo se anticipa «ya es miembro de esta cuenta». Los otros rechazos de `redeem_invitation` («already in a shared account», «account already contains data») no se avisan: se emite un 201 con un enlace que no se podrá canjear y se ocupa una plaza durante 7 días. El panel conoce el correo y podría avisar.
- 4 (resto): `addons` de la suscripción anterior se conserva en la fila manual (solo lo lee el webhook).
- 5: `overridePlan` lee y después hace el upsert, sin escritura condicional. Un webhook de activación de PayPal que llegue entre medias queda pisado. La ventana es pequeña y el 409 cubre el caso normal. Una suscripción PayPal `suspended` con id se sobrescribe (decisión documentada).
- 6: si `renameAccount` falla después de invitar, la respuesta es 500 aunque la empresa y el usuario existen, y un reintento da 409. Si el invite falla, la línea `account_create` queda con `account_id` NULL.
- 7: `idx_impersonation_log_operator_target` no tiene todavía ningún lector (queda para la futura bitácora de operadores). `POST /api/platform/accounts` hace `planExists` y `overridePlan` lo repite.
- 8 (Riesgo 1): aceptar la invitación sin PKCE y sin `/auth/callback` ni `/reset-password`. Asignado a s9.8.
