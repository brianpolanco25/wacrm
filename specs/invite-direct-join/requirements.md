# i12.1 `invite-direct-join` — requisitos

Rama `feat/invitacion-directa` desde `main` @ 5f64211; worktree
`.claude/worktrees/invitacion-directa`. Migración `090_invite_direct_join.sql`.

## Decisión de origen (humano, 2026-11-03, textual)

> «los invitados que entran por el link de invitación no deben preguntar a qué empresa van a
> entrar, deben entrar directamente desde la empresa que fue invitado».

`feature_list.json` no trae `acceptance` para i12.1: los criterios de aceptación son los del
encargo del líder (A1–A9), que se citan abajo y se cubren con `R<n>`.

| Criterio | Contenido | R |
|---|---|---|
| A1 | Usuario nuevo desde el enlace nace dentro de la empresa con el rol del enlace, sin cuenta personal intermedia | R1–R6 |
| A2 | Alta rechazada al instante si la invitación no vale; nunca se crea una empresa nueva en silencio | R3, R4, R5, R7, R8, R10 |
| A3 | Al confirmar el correo en cualquier navegador acaba en el dashboard de la empresa | R13, R18, R19 |
| A4 | Con sesión abierta y cuenta personal vacía, /join canjea solo y redirige; 409 conserva el modal | R12–R17 |
| A5 | Usuario existente sin sesión: tras `/login?invite=` se canjea solo | R19 |
| A6 | `/auth/callback/complete` conserva `?invite=` en sus enlaces de salida | R18 |
| A7 | La puerta de onboarding no intercepta al miembro recién unido de una empresa que paga | R20 |
| A8 | Asientos: se siguen contando al crear la invitación; el alta no excede lo reservado | R21, R28–R34 |
| A9 | Panel de operador (`inviteUserByEmail`) sigue funcionando; /reset-password → /join es no-op | R22, R23, R24 |
| A10 | Textos: desaparece «Accepting moves your login into…»; copy en `messages/es.json` y `en.json` | R25, R26 |
| A11 | Humano (2026-11-03, textual): «la cantidad de usuarios invitados depende del plan que tenga el cliente». Con el alta directa el límite de asientos del plan nunca se supera | R21, R28–R34 |

## Situación verificada (main @ 5f64211)

- `handle_new_user()` solo se define en `supabase/migrations/017_account_sharing.sql` (l. 659-689):
  `accounts` + `profiles(owner)` y traga cualquier error con `RAISE WARNING`.
  `on_account_created_seed_trial` (073) siembra `subscriptions` en `incomplete`.
- `redeem_invitation(text)` vigente: `supabase/migrations/073_no_trial.sql` (l. 137-…).
  `peek_invitation(text)`: `019_invitation_rpcs.sql`. Ninguna de las dos sabe nada del alta.
- `/join/[token]` (`src/app/join/[token]/page.tsx`) muestra botón «Accept invitation»; textos
  en inglés en el propio archivo, sin `next-intl`.
- `src/lib/onboarding/state.ts` ya resuelve por la cuenta del perfil: un miembro de una cuenta
  que paga sale `done` (test en `src/lib/onboarding/state.test.ts` l. 150-180).
- El panel de operador inserta la fila de `account_invitations` **antes** de
  `inviteAuthUser` (`src/app/api/platform/accounts/[id]/members/route.ts`).

## Requisitos (EARS)

### Alta ligada a la invitación (trigger)

- **R1** Cuando se inserte una fila en `auth.users` cuyo `raw_user_meta_data` traiga
  `invite_token` (texto) que corresponda por `sha256` hex a una fila de `account_invitations`
  con `accepted_at IS NULL` y `expires_at > now()`, el sistema debe crear el `profiles` de ese
  usuario con `account_id` = la cuenta de la invitación y `account_role` = el rol de la
  invitación. *Verifica:* `progress/checks_invite-direct-join.sql` §1.
- **R2** Cuando ocurra R1, el sistema no debe insertar ninguna fila en `accounts`, ni por tanto
  en `subscriptions` ni en `usage_counters`, para ese usuario. *Verifica:* checks §1 (conteos de
  `accounts` con `owner_user_id` = el usuario y de `subscriptions` antes/después).
- **R3** Cuando ocurra R1, el sistema debe marcar la invitación `accepted_at = now()`,
  `accepted_by_user_id = <usuario>` en la misma transacción, y una segunda alta con el mismo
  token debe fallar (R4). *Verifica:* checks §1 y §2.
- **R4** Cuando `invite_token` esté presente pero no corresponda a ninguna invitación, o la
  invitación ya esté aceptada, o haya caducado, o el valor no sea un texto de 1 a 128
  caracteres, el sistema debe abortar la inserción en `auth.users` con una excepción (no
  `RAISE WARNING`), de modo que no quede usuario, perfil ni cuenta. *Verifica:* checks §2
  (tres casos: inexistente, usada, caducada; más tipo inválido) — cada `INSERT` falla y
  `count(*)` de `auth.users`/`accounts`/`profiles` no cambia.
- **R5** Cuando la rama de invitación de R1 falle por cualquier otro motivo (p. ej. el
  `INSERT INTO profiles`), el sistema debe propagar el error y abortar el alta; nunca debe caer
  a la rama de cuenta personal. *Verifica:* checks §3 (perfil preexistente con el mismo
  `user_id` provocado a mano → la inserción falla y no aparece cuenta personal).
- **R6** Cuando se inserte un usuario sin `invite_token` (o con `invite_token` JSON `null`), el
  sistema debe comportarse exactamente como hoy: cuenta personal `owner`, semilla `incomplete`
  y errores tragados con `RAISE WARNING`. *Verifica:* checks §4.
- **R7** Cuando dos altas concurrentes usen el mismo token, el sistema debe aceptar como mucho
  una (bloqueo `FOR UPDATE` sobre la invitación). *Verifica:* checks §2 (segundo alta
  secuencial falla) y lectura del `FOR UPDATE` en la revisión; la concurrencia real no se
  prueba en CI.

### Formulario de alta (`/signup?invite=`)

- **R8** Cuando `/signup` se abra con `?invite=<token>`, el sistema debe consultar
  `GET /api/invitations/<token>/peek` antes de mostrar el formulario y, si la respuesta es
  `ok:false`, mostrar el motivo (`not_found` | `used` | `expired` | `no_seats` | `server_error`) en lugar del
  formulario, sin llamar a `signUp`. *Verifica:* `src/lib/auth/signup-invite.test.ts`
  (decisión pura `signupInviteGate(peek)`) y `src/app/(auth)/signup/signup-invite-view.test.tsx`
  (render en `es` y `en`).
- **R9** Cuando el formulario de alta con invitación válida se envíe, el sistema debe llamar a
  `supabase.auth.signUp` con `options.data.invite_token = <token>` además de `full_name`, y
  con `emailRedirectTo = authCallbackUrl(origin, { invite })`. *Verifica:*
  `src/lib/auth/signup-invite.test.ts` (`signupOptions`).
- **R10** Cuando `signUp` con invitación devuelva error de servidor (GoTrue responde
  «Database error saving new user» al abortar el trigger), el sistema debe volver a consultar
  `peek` y mostrar el motivo de la invitación, no el texto crudo de GoTrue. *Verifica:*
  `src/lib/auth/signup-invite.test.ts` (`isInviteSignupRejection`).
- **R11** Cuando el alta con invitación tenga éxito, la pantalla de «revisa tu correo» debe
  nombrar la empresa (`account_name` del peek) y decir que al confirmar se entra directamente
  en ella. *Verifica:* `signup-invite-view.test.tsx`.

### `/join/<token>` sin botón de aceptar

- **R12** Cuando `/join/<token>` cargue con sesión abierta, el sistema debe llamar una sola vez
  por carga de página a `POST /api/invitations/<token>/redeem` sin interacción del usuario y,
  si responde 200, navegar con recarga completa a `/dashboard`. No debe existir botón
  «Accept invitation» ni el texto «Accepting moves your login into…». *Verifica:*
  `src/lib/auth/join-flow.test.ts` (`resolveJoin`: una sola llamada a `fetch` con `POST`;
  destino `/dashboard`) y `src/app/join/[token]/join-view.test.tsx` (ningún estado contiene
  el botón ni el texto).
- **R13** Cuando `redeem_invitation` se invoque por un usuario cuyo perfil ya pertenece a la
  cuenta de la invitación (porque nació ahí por R1, o ya era miembro), el sistema debe devolver
  esa `account_id` sin modificar nada (ni perfil ni invitación) y la ruta debe responder 200.
  *Verifica:* checks §5 (aceptada por el propio usuario → devuelve la cuenta, `accepted_at`
  intacto; invitación pendiente y llamante ya miembro → devuelve la cuenta y la invitación
  sigue pendiente).
- **R14** Cuando la respuesta de `redeem` sea 409, el sistema debe mostrar el modal de conflicto
  actual (cerrar sesión y usar otro correo); su acción secundaria debe llevar a `/dashboard`
  en vez de dejar al usuario en una página sin acciones. *Verifica:* `join-flow.test.ts`
  (estado `conflict` con el mensaje) y `join-view.test.tsx`.
- **R15** Cuando la respuesta de `redeem` sea 400, el sistema debe mostrar la tarjeta de fallo
  con el motivo que la ruta devuelve en `reason` (`not_found` | `used` | `expired` | `no_seats`); un 401
  se trata como «sin sesión» y un 5xx o error de red como `server_error` con «Reintentar».
  *Verifica:* `join-flow.test.ts`.
- **R16** Cuando `redeem_invitation` rechace con `22023` o `23505`, el sistema debe adjuntar un
  `HINT` con el motivo (`not_found`, `used`, `expired`, `no_seats`; `has_data`, `shared_account`) y la ruta
  `POST /api/invitations/[token]/redeem` debe devolverlo como `reason` junto a `error`.
  *Verifica:* `src/app/api/invitations/[token]/redeem/route.test.ts` (nuevo) y checks §6.
- **R17** Cuando `/join/<token>` cargue sin sesión, el sistema debe mostrar (como hoy) la
  empresa y el rol con «Crear cuenta y entrar» → `/signup?invite=` y «Ya tengo cuenta» →
  `/login?invite=`. *Verifica:* `join-view.test.tsx`.

### Enlaces de vuelta

- **R18** Cuando `/auth/callback/complete` muestre un error y la URL traiga `?invite=`, los
  enlaces a `/login` y a `/forgot-password` deben llevar `?invite=<token>`. *Verifica:*
  `src/app/(auth)/auth/callback/complete/page.test.tsx` (función pura `exitLinks(search)`
  exportada desde `src/lib/auth/callback.ts`, más un render).
- **R19** Cuando un usuario existente sin sesión inicie sesión desde `/login?invite=`, el sistema
  debe llevarlo a `/join/<token>` (ya lo hace `postLoginDestination`) y de ahí aplicar R12 sin
  pantalla intermedia. *Verifica:* `src/lib/auth/post-login.test.ts` (caso existente, se cita)
  y `join-flow.test.ts`.

### Facturación, asientos y operador

- **R20** Cuando un miembro recién unido (por R1 o R12) entre al dashboard de una empresa cuya
  suscripción no es `incomplete`, la puerta de onboarding no debe redirigirlo; si la empresa
  está `incomplete`, debe comportarse como con cualquier otro miembro de esa empresa (lo manda
  la suscripción de la empresa, no la del usuario). *Verifica:* `src/lib/onboarding/state.test.ts`
  l. 150-180 (existente, se cita) + un caso nuevo «agent sin cuenta propia en cuenta `active` →
  `done`»; checks §1 confirma que no existe `subscriptions` propia.
- **R21** Cuando el trigger consuma una invitación con asientos libres, el conteo miembros +
  pendientes de esa cuenta no debe cambiar (una pendiente pasa a ser un miembro). La
  comprobación al crear la invitación sigue igual (R28) y el alta y el canje la vuelven a
  aplicar contra el plan vigente (R30, R31). *Verifica:* checks §1 (conteo antes/después).
- **R22** Cuando el panel de operador invite por correo a alguien sin cuenta
  (`POST /api/platform/accounts/[id]/members`), el sistema debe pasar `invite_token` en
  `options.data` de `inviteUserByEmail`, de modo que el invitado nace en la empresa por R1.
  *Verifica:* `src/app/api/platform/accounts/[id]/members/route.test.ts` y
  `src/lib/platform/provisioning.test.ts` (argumentos de `inviteUserByEmail`).
- **R23** Cuando ese invitado del panel complete `/auth/callback` → `/reset-password` →
  `/join/<token>`, el canje automático debe ser un no-op (R13) y terminar en `/dashboard`.
  *Verifica:* checks §5 + `join-flow.test.ts`. Guion manual S-M1 (abajo) para el correo real.
- **R24** Cuando el panel cree una empresa nueva (`POST /api/platform/accounts`,
  `inviteAuthUser` sin token), el comportamiento no debe cambiar: el invitado sigue naciendo
  dueño de su cuenta. *Verifica:* `src/app/api/platform/accounts/route.test.ts` (existente,
  en verde sin cambios).

### Asientos según el plan (A11)

Definiciones (las de hoy, que no cambian): **límite** = `plans.limits->'operators'` del
`plan_id` de la `subscriptions` de la cuenta (sin fila → plan `inicio`,
`DEFAULT_PLAN_ID` de `src/lib/billing/entitlements.ts`); `null` o ausente = sin límite (plan
`ilimitado`, 074). **Asientos usados** = filas de `profiles` con ese `account_id` + filas de
`account_invitations` de la cuenta con `accepted_at IS NULL` y `expires_at > now()`
(`countSeats` en `src/lib/platform/provisioning.ts` y el `POST` de
`src/app/api/account/invitations/route.ts`, ambos con `assertStockLimit` de
`src/lib/billing/enforce.ts`).

- **R28** Cuando un admin (pestaña Miembros) o un operador (panel) cree una invitación y
  miembros + invitaciones pendientes no caducadas + 1 supere el límite, el sistema debe
  rechazarla con `PlanLimitError` (402) sin insertar fila. Sin cambios de código: se deja
  probado. *Verifica:* `src/app/api/account/invitations/route.test.ts` (casos existentes l.
  153-… más: «3 miembros + 0 pendientes en plan de 3 → 402», «2 miembros + 1 pendiente → 402»)
  y `src/app/api/platform/accounts/[id]/members/route.test.ts` (ídem con `countSeats`).
- **R29** Cuando una invitación caduque (`expires_at <= now()`) o se revoque (`DELETE` de
  `src/app/api/account/invitations/[id]/route.ts`), el sistema debe dejar de contarla como
  asiento, de modo que se pueda emitir otra en su lugar; y esa invitación caducada o borrada no
  debe poder consumirse después (R4). *Verifica:* `src/lib/platform/provisioning.test.ts`
  (`countSeats` filtra `accepted_at IS NULL` y `expires_at > now`: aserción sobre los filtros
  del mock) y checks §7 (plan de 2: 1 miembro + 1 caducada → `account_seats_used` = 1; el alta
  con la caducada falla con `expired`; tras borrar una pendiente, el conteo baja).
- **R30** Cuando el trigger de alta (R1) vaya a consumir una invitación, el sistema debe
  comprobar en la misma transacción, con la cuenta bloqueada (`SELECT … FOR UPDATE` sobre
  `accounts`), que los **miembros** actuales de la cuenta + 1 no superan el límite; si lo
  superan, debe abortar el alta con `HINT = 'no_seats'` sin crear usuario, perfil ni cuenta.
  Así el número de miembros nunca supera el límite del plan, aunque el plan haya bajado entre
  la creación del enlace y el alta. *Verifica:* checks §7 (plan con `operators` = 2, 1 miembro +
  1 pendiente → alta OK; bajar el plan a 1 con otra invitación pendiente → alta falla con
  `no_seats`, conteos intactos; plan `ilimitado` → sin límite).
- **R31** Cuando `redeem_invitation` mueva a un usuario existente a la cuenta (casos 2 y 3), el
  sistema debe aplicar la misma comprobación de R30 y rechazar con `22023` +
  `HINT = 'no_seats'` (la ruta responde 400 con `reason: 'no_seats'`). El no-op de R13 (ya
  miembro) no la aplica: no añade a nadie. *Verifica:* checks §7 y
  `src/app/api/invitations/[token]/redeem/route.test.ts`.
- **R32** Cuando `peek_invitation` reciba una invitación pendiente y vigente de una cuenta cuyos
  miembros ya alcanzan el límite, el sistema debe responder `ok:false, reason:'no_seats'`, de
  modo que `/join` sin sesión y `/signup?invite=` muestren «la empresa no tiene asientos libres»
  antes de pedir datos, y `/signup` lo muestre también tras el rechazo del trigger (R10).
  *Verifica:* checks §7 (peek) y `src/lib/auth/signup-invite.test.ts` /
  `src/lib/auth/join-flow.test.ts` (motivo `no_seats`).
- **R33** Cuando se calcule el límite en SQL, el sistema debe usar una única función
  `public.account_seat_limit(uuid)` (plan de la suscripción, `inicio` si no hay fila, `NULL` si
  `operators` es `null`, ausente o no numérico — igual que `normalizeLimits`), y el plan por
  defecto de esa función debe coincidir con `DEFAULT_PLAN_ID`. *Verifica:* checks §7 (tres
  casos: sin suscripción, plan con número, plan `ilimitado`) y
  `src/lib/billing/seat-limit-parity.test.ts` (nuevo: lee
  `supabase/migrations/090_invite_direct_join.sql` y exige el literal `'${DEFAULT_PLAN_ID}'` en
  `account_seat_limit`).
- **R34** Cuando el alta o el canje se rechacen por `no_seats`, la pantalla debe decir que la
  empresa no tiene asientos libres y que hay que pedir al administrador que libere uno o mejore
  el plan (claves `JoinPage.fail.no_seats.*`). *Verifica:* `join-view.test.tsx` y
  `signup-invite-view.test.tsx` en `es` y `en`.

### Textos

- **R25** Cuando se muestre `/join/<token>`, todos sus textos deben salir del namespace nuevo
  `JoinPage` de `messages/en.json` y `messages/es.json` (mismas claves y placeholders ICU), y
  ninguno debe hablar de «aceptar» ni de mover la cuenta. *Verifica:*
  `join-view.test.tsx` (render en ambos catálogos) y `src/i18n/messages.test.ts`.
- **R26** Cuando `/signup?invite=` y `/login?invite=` se muestren, sus títulos y descripciones
  de invitación deben decir que se entra a la empresa (namespace nuevo `SignupInvite`; claves
  `LoginPage.titleAccept`/`descAccept` con copy nuevo, mismas claves). *Verifica:*
  `signup-invite-view.test.tsx` y `src/i18n/messages.test.ts`.

### Alcance

- **R27** El diff no debe tocar `src/app/api/whatsapp/webhook/route.ts`, ni `remove_member`, ni
  la lógica de conteo de asientos en TypeScript (`countSeats`, el `POST` de invitaciones,
  `assertStockLimit`). *Verifica:* `git diff --stat` en el informe (CP8, CP11).

## Guion manual (servicio externo: Supabase Auth + correo)

- **S-M1** Panel de operador → «Añadir miembro» con un correo nuevo → abrir el correo → definir
  contraseña → se aterriza en `/dashboard` de esa empresa; en `profiles` el usuario tiene el
  `account_id` de la empresa y no existe `accounts` con `owner_user_id` = él.
- **S-M2** Pestaña Miembros → enlace → `/signup?invite=` en navegador A → abrir el correo de
  confirmación en navegador B (PKCE falla) → «Volver a iniciar sesión» conserva `?invite=` →
  iniciar sesión → `/dashboard` de la empresa.
- **S-M3** Usuario con sesión y cuenta personal vacía abre el enlace → sin botón, acaba en
  `/dashboard` de la empresa. Con una cuenta con contactos → modal de conflicto.

## Decisión para el humano: plan que baja entre el enlace y el alta (R30)

Propuesta del spec: **el alta (y el canje) se rechazan** si los miembros ya llenan el plan
vigente, con «la empresa no tiene asientos libres». Motivo: la frase del humano ata el número
de usuarios al plan del cliente, y fiarse de la reserva dejaría entrar a más miembros de los
que el plan paga tras un cambio a un plan menor (de `crecimiento`/10 a `inicio`/3, con 7
enlaces pendientes, entrarían 7 de más). Coste: un enlace emitido de buena fe puede quedar
inservible; el admin libera un asiento o sube de plan y el mismo enlace vuelve a valer (no se
consume al rechazarse). Solo se cuentan **miembros** en esa comprobación, no las otras
pendientes: con el plan ya bajado, entra el primero que llega mientras quepa.
Alternativa descartada (confiar en la reserva): no exige leer el plan en SQL, pero permite
superar el límite. Si el humano prefiere la reserva, se eliminan R30–R32 y R34 y el resto del
spec no cambia.

## Riesgos aceptados por la decisión del humano

- **Canje sin confirmación.** Con R12, abrir un enlace con sesión abierta mueve al usuario sin
  preguntar. Lo acota el guardián existente de `redeem_invitation` (solo cuentas personales
  vacías y propias); es la decisión textual del humano.
- **Membresía antes de confirmar el correo.** Con R1 el perfil nace en la empresa al pulsar
  «Crear cuenta», antes de confirmar. Un alta con correo ajeno ocupa el asiento sin poder
  entrar (no puede iniciar sesión sin confirmar). El admin lo quita con «Quitar del equipo».
  La caducidad de la invitación se evalúa solo en el alta: entre alta y confirmación ya no
  cuenta (la invitación ya está consumida); cuenta la caducidad del enlace de confirmación de
  Supabase.

## Fuera de alcance (deuda, no se especifica)

- **D1** Rescatar a usuarios ya afectados (mover a mano una cuenta existente con datos a otra
  empresa).
- **D2** Invitaciones ligadas a correo para quien se registra en `/signup` sin el enlace.
- **D3** Marcar en la pestaña Miembros a los miembros con correo sin confirmar, y excluirlos de
  los selectores de asignación.
- **D4** Pantalla de `otherBrowser` en `/auth/callback/complete`: para una confirmación de alta
  el correo ya quedó confirmado y la acción principal debería ser «Iniciar sesión», no «Pedir
  un enlace nuevo».
- **D5** Los textos de `/signup` que no son de invitación (etiquetas del formulario, errores de
  contraseña) siguen en inglés en el propio archivo: solo se internacionaliza lo que esta
  feature cambia. `/join` sí pasa entero a `JoinPage` (R25) porque se reescribe.
