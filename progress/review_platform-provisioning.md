# Review — s9.4 platform-provisioning

**Veredicto:** CHANGES_REQUESTED

Rama `platform/provisioning`, rango `ddc07f6..71bb414` (5 commits, 31 archivos, coincide con el informe).
Un único bloqueante (hallazgo 1). Todo lo demás está verde o es deuda no bloqueante.

## Compuerta (ejecutada por el reviewer en el worktree, HEAD 71bb414)
- lint: verde (0 errores, 35 warnings preexistentes, ninguno en archivos tocados)
- typecheck: verde
- `TZ=UTC npm test`: verde, 219 archivos, 2944 tests
- build (variables dummy de CI): verde; aparecen `/api/platform/accounts/[id]/{members,plan}`, `/api/platform/operators`, `/operators/[userId]`, `/plan-options`, `/platform/operators`
- replay-migrations: verde (`ok 071_platform_provisioning.sql`, `verify-schema.sql: OK`). Con `KEEP=1`:
  - `progress/checks_platform-provisioning.sql` sale 0, los 7 NOTICE en OK (incluido el control positivo de `has_open_support_session`)
  - 071 reaplicada sobre la base viva: sale 0 (idempotente); `verify-schema` vuelve a pasar
  - `platform_admins` sigue con una sola política, `platform_admins_select` (r): sin escritura
  - `has_open_support_session` en la base sigue con `l.action = 'impersonation'`
  - SQL propio: la misma cuenta en `negocio` da MRR 199.00 con `provider='paypal'` activo y 0.00 con `provider='manual'`. El MRR de s9.2 la excluye.
- Caché, en build de producción: con `next start` y variables dummy, `curl -I` da `Cache-Control: private, no-store` en `/platform`, `/platform/accounts` y `/platform/operators`. Sin sesión esas respuestas son 307 a `/login`, y la cabecera de `next.config.ts` va igual. `/login` y `/platformer` siguen con `public, max-age=0, s-maxage=300…`; `/api/platform/me` sigue con `no-store`. No se pudo probar un 200 con sesión de operador: no hay Supabase real.

## Trazabilidad criterio ↔ test
- C1 «Crear empresa: invitar al propietario, localizar la cuenta de `handle_new_user`, renombrarla, plan opcional»: [x] `src/app/api/platform/accounts/create.test.ts` › "audits, invites, attaches, renames — in that order — and answers 201", "gives the new company the plan by hand, with the same reason", "says so when the trigger did not create the company", "invites NOBODY when the trail cannot be written"; `tenant-isolation.test.ts` › "creates a company: a new account, renamed and on a manual plan — A and B untouched".
- C1b «409 con correo ya registrado»: [x] create.test › "409s an email that already has a user — before writing anything" y "409s when Supabase says the user exists (a race with a signup)". Revela si el correo existe, pero solo a un operador detrás de `requirePlatformAdmin()` (el 403 lo prueba el primer `it` de la suite s9.4 de aislamiento). Es aceptable.
- C2 «Plan a mano: provider manual, active, sin id ni ciclo, sin tocar `manual_hold_*`, motivo ≥10 (constante de la 058), 409 si PayPal cobra»: [x] `provisioning.test.ts` › "manualPlanRow › is manual and active, clears every gateway field, leaves the hold alone", "records from/to plan and provider, THEN upserts…", "changes nothing when the trail cannot be written"; `[id]/plan/route.test.ts` › "400s a reason shorter than the log minimum (the 058 constant)", "409s a subscription PayPal is still billing…". `audit.ts:50` reexporta `MIN_REASON_LENGTH` de `@/lib/auth/impersonation`. SQL: checks §4.
- C2b «Fuera del MRR / «Asignado a mano» en la ficha»: [x] checks §4 (`comped ≥ 1`) más el SQL del reviewer (MRR 199 → 0); `platform-provisioning.test.tsx` › "shows «Asignado a mano» for a manual plan (out of the MRR)" y "does not for a PayPal plan…".
- C3 «Bitácora: CHECK ampliado; `account_id` opcional solo para account_create y operator_*; `has_open_support_session` sin cambios»: [x] checks §1 (5 actos nuevos, `bogus` rechazado; impersonation, suspend, reactivate, plan_override y member_invite con NULL rechazados; caducidad de la 058 intacta) y §2 (plan_override y member_invite "abiertos" dan false; el control con impersonation da true). Además, aserciones `-- 071` en verify-schema.
- C3b «Bitácora ANTES del acto en las cuatro rutas»: [x] crear empresa (create.test, orden `audit → invite`), plan (provisioning.test, "records … THEN upserts"), miembro (`members/route.test.ts` › "invites NOBODY when the trail cannot be written"), operadores (en la función SQL la fila de bitácora va antes del INSERT/DELETE en la misma transacción; checks §5 "grant survived its failed log row").
- C4 «Operadores: solo service_role, bloqueo, nunca el último, no a uno mismo, inexistente → 404»: [x] checks §5 y el bloque final (authenticated → insufficient_privilege); verify-schema (sin SECURITY DEFINER y sin EXECUTE para anon/authenticated); `operators/route.test.ts` › "400s revoking oneself, without even asking the database", "400s revoking the last operator", "404s an email with no user: they must sign up first", "409s someone who is already an operator"; `provisioning.test.ts` › "maps %j to %s". El `LOCK TABLE … SHARE ROW EXCLUSIVE` choca consigo mismo y, en READ COMMITTED, la sentencia siguiente cuenta con un snapshot nuevo, así que dos revocaciones cruzadas no pueden dejar cero operadores.
- C5 «Añadir miembro reutilizando la invitación existente»: [x] en el servidor. `members/route.test.ts` › "audits, writes the invitation for THIS company, then emails a new person" comprueba `hashInviteToken(token) === tokenHash` sobre `account_invitations`, con el mismo `/join/<token>` y `redeem_invitation` sin tocar. Fuga A↔B: "invites a member to ONE company…". [ ] **En la UI no**: para un usuario existente el enlace de un solo uso se pierde (hallazgo 1) y ningún test lo cubre.
- C6 «Caché `private, no-store` en /platform*»: [x] `src/next-config.test.ts` (matcher de Next `getPathMatch`, gana la última regla, 6 rutas, `/platformer` excluida, resto de la app igual) más la comprobación del build arriba.
- C7 «CP3 en todas las rutas nuevas»: [x] `tenant-isolation.test.ts` › describe `/api/platform provisioning (s9.4, service role)`, 7 casos, con 403 del dueño de A en las 7 llamadas y snapshots de A, B y TARGET. Hay waivers por test, cada uno con su razón: búsqueda por correo, cuenta por `owner_user_id` sacado de la respuesta de Supabase, fila de bitácora sin cuenta, RPCs de operadores, lista de `platform_admins`. Todos razonables.
- C8 «`GET /api/platform/plan-options` con guarda»: [x] `plan-options/route.test.ts` › 401/403/200.
- C9 i18n: [x] `platform-provisioning.test.tsx` › "every key exists in es, en AND ko (CP6)". Comprobado aparte: 69 claves de `Platform.provisioning` y `Platform.operators` en los tres catálogos, 0 ausentes, placeholders ICU iguales.

## Checkpoints
- CP1: [x] compuerta en verde, ejecutada por el reviewer.
- CP2: [x] 071 con el número del spec; idempotente (reaplicada sin error); aserciones en verify-schema; replay sale 0; sin `CASCADE`.
- CP3: [x] cada consulta de rol de servicio filtra por cuenta o lleva waiver con razón; tests de fuga A↔B; `requirePlatformAdmin()` antes de tocar la base en las 7 rutas.
- CP4: [ ] falta cubrir C5 en la UI (hallazgo 1). El resto tiene su test o su SQL, y el guion manual está en el informe.
- CP5: [x] `package.json` y `package-lock.json` sin cambios.
- CP6: [x] es/en/ko en paridad.
- CP7: [x] reglas de `headers()` contrastadas con `node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/headers.md:47` ("the last header key will override the first"); en el build real gana la última.
- CP8: [x] nada de s9.3 tocado (ni `Platform.plans`, ni `/api/platform/plans*`, ni 070); `handle_new_user`, `redeem_invitation` y `has_open_support_session` intactos.
- CP9: [x] CHANGELOG (Unreleased) actualizado; sin variables de entorno nuevas; el informe coincide con el diff.
- CP10: [x] 5 commits en `platform/provisioning`, en español, con prefijo y `Co-Authored-By`; sin push.
- CP11: [x] no toca el webhook de WhatsApp ni la ruta de lo entrante.

## Hallazgos (archivo:línea)
1. **Bloqueante.** `src/components/platform/platform-provisioning.tsx:473-477` con `src/components/platform/platform-account-detail.tsx:128` y `:204`. `AddMemberForm` guarda el enlace de un solo uso con `setLink(url)` y justo después llama a `onInvited()`, que es el `load()` de la ficha. `load()` hace `setLoading(true)`, la ficha pasa a pintar solo el spinner (`if (loading) return …`), `AddMemberForm` se desmonta y el enlace se pierde. Para un usuario que ya existe (`emailed: false`) ese enlace es la única forma de entregar la invitación, y el token no vuelve a salir: la plaza queda ocupada 7 días y en la bitácora queda un `member_invite`. Ningún test lo cubre: el render de «Añadir miembro» solo comprueba las traducciones.
2. No bloqueante. `src/app/api/platform/accounts/[id]/members/route.ts:170` y `src/app/api/platform/accounts/route.ts:212` usan `resolveAppOrigin` (`src/lib/billing/checkout.ts:147`), que no aplica `ALLOWED_INVITE_HOSTS` como el `getBaseUrl` de la pestaña Equipo (`src/app/api/account/invitations/route.ts:95`). La cabecera la pone la propia petición del operador y Supabase filtra `redirectTo` contra su lista de redirecciones, así que el riesgo es bajo. Aun así, la ruta no "reutiliza el flujo" del todo y diverge en el origen del enlace.
3. No bloqueante. `src/app/api/platform/accounts/[id]/members/route.ts:126`: con un usuario existente solo se rechaza "ya es miembro de esta cuenta". Los otros rechazos de `redeem_invitation` (049: "already in a shared account", "account already contains data") no se anticipan: se emite un 201 con un enlace que no se podrá canjear y se ocupa una plaza. Es lo mismo que pasa hoy en la pestaña Equipo (que no conoce el correo); aquí sí se conoce y se podría avisar.
4. No bloqueante. `src/lib/platform/provisioning.ts:248-259`: `manualPlanRow` deja `current_period_end` (y `addons`) de la suscripción PayPal anterior. Lo único que se ve es una fecha de renovación rancia en la vista de facturación; `addons` solo lo lee el webhook.
5. No bloqueante. `src/lib/platform/provisioning.ts:218-224` y `:283-309`: se lee y luego se hace el upsert, sin escritura condicional. Un webhook de activación de PayPal que llegue entre medias acaba pisado. La ventana es pequeña y el 409 cubre el caso normal. Una `suspended` de PayPal con id se sobrescribe; es una decisión documentada en el informe, y reactivarla es cosa del comercio, no del cliente.
6. No bloqueante. `src/app/api/platform/accounts/route.ts:249-251`: si `renameAccount` lanza después de invitar, la respuesta es 500 "Failed to create the company" aunque la empresa y el usuario existen, y un reintento da 409. Si el invite falla, la línea `account_create` queda con `account_id` NULL (está anotado como deuda en el informe).
7. Menor. `supabase/migrations/071_platform_provisioning.sql:126`: ningún código lee todavía `idx_impersonation_log_operator_target`, que queda como índice para la bitácora futura de operadores. `accounts/route.ts:177` hace `planExists` y `overridePlan` lo vuelve a hacer (`provisioning.ts:279`).
8. Fuera de alcance, ya asignado a s9.8: `inviteUserByEmail` sin PKCE y sin `/auth/callback` ni `/reset-password` (Riesgo 1 del informe). No es motivo de rechazo aquí.

## Cambios requeridos
1. Que el enlace de invitación sobreviva a la recarga de la ficha. Por ejemplo, no llamar a `onInvited()` cuando `emailed` es false (o llamarlo sin pasar la ficha a estado de carga), o subir `link` a `PlatformAccountDetail`, o recargar sin el spinner a pantalla completa. Hace falta un test de render o de comportamiento que, tras un 201 con `emailed: false`, siga mostrando la URL después de `onInvited`.
2. (Opcional, recomendado) Hallazgo 2: resolver el origen del enlace con la misma función que la pestaña Equipo (`ALLOWED_INVITE_HOSTS`), movida a `src/lib/auth/invitations.ts`.

---

# Segunda ronda — HEAD b06eb36 (rango 71bb414..b06eb36, 2 commits)

**Veredicto:** APPROVED

Commits: `0da44ea` (hallazgo 1), `b06eb36` (hallazgos 2 y 4). 13 archivos, todos justificados por los hallazgos. La sección «Segunda ronda» de `impl_platform-provisioning.md` coincide con el diff. Todo se hizo sin red: tests con `fetch` mockeado, Docker con `supabase/postgres:17.4.1.075` ya descargada y nada fuera de localhost.

## Compuerta (ejecutada por el reviewer, logs propios, HEAD b06eb36)
- lint: verde (0 errores y 35 warnings preexistentes; ninguno en un archivo tocado por la feature, lo he cruzado con `git diff ddc07f6..HEAD --name-only`)
- typecheck: verde
- `TZ=UTC npm test`: verde, 219 archivos y 2958 tests
- build (variables dummy de CI): verde
- replay-migrations: verde (`ok 071`, `verify-schema.sql: OK`). La migración no cambia en esta ronda. `checks_platform-provisioning.sql` sale 0 con los 7 OK. Con SQL propio, el upsert de la fila manual con `current_period_end = NULL` pisa una fecha previa (OK); la columna es nullable (041:74).

## Hallazgo 1 (bloqueante): cerrado
- El enlace pasa a vivir en `PlatformAccountDetail` (`inviteLink`, `platform-account-detail.tsx:147`) y `AddMemberForm` lo recibe por prop. Recargar la ficha ya no desmonta el formulario: `fileScreen()` devuelve `ready` en cuanto hay ficha, así que el spinner a pantalla completa queda solo para la primera carga.
- **El test de regresión falla sin el arreglo.** Lo comprobé en un worktree temporal en `b06eb36`, no en el del implementer. Deshice solo el arreglo (`if (screen === 'loading')` → `if (loading)`) y `platform-provisioning.test.tsx` › "and the file, reloading after it, still shows that link" falló (1 failed | 32 passed). Con el arreglo pasa. Después borré el worktree temporal.
- **Carga inicial:** `loading` arranca en `true` y no hay ficha, así que sale el spinner, como antes (`fileScreen` › `{loading:true, hasDetail:false}` → `loading`).
- **Error en la primera carga:** sin ficha y con `failed`, sale la pantalla de error o de «no encontrada» de siempre (`:250`, casos `error` y `notFound` → `failed`).
- **Error en una recarga:** la ficha se conserva y aparece el banner `Platform.provisioning.refreshFailed`, con la clave en es, en y ko.
- `sendMemberInvite` se prueba con un `fetch` inyectado: 201 `emailed:false` → `link`, 201 `emailed:true` → `emailed`, 409, 402 y 500.
- Queda un detalle menor, no bloqueante: si la cuenta devuelve 404 en una recarga con la ficha ya en pantalla, el aviso dice «no se pudo actualizar» en lugar de «no encontrada».

## Hallazgo 2: cerrado
- `resolveInviteBaseUrl` (`src/lib/auth/invitations.ts`) es el `getBaseUrl` de antes, movido tal cual. Lo comprobé con `diff` del cuerpo contra `71bb414`: solo cambian el nombre y el prefijo de los dos `console.warn`.
- La pestaña Equipo (`/api/account/invitations/route.ts:200`) la llama con el mismo `request`, así que su comportamiento no cambia.
- La usan también `[id]/members` (`/join/<token>`) y el `redirectTo` del propietario en `POST /api/platform/accounts`. El panel ya no usa `resolveAppOrigin`.
- Tests en `invitations.test.ts`: NEXT_PUBLIC_SITE_URL primero, cabeceras del proxy, y host fuera de `ALLOWED_INVITE_HOSTS` → fallback, con un host permitido como control. La ruta de la pestaña Equipo sigue sin test propio de URL, pero esa carencia es anterior a esta feature.

## Hallazgo 4: cerrado (en parte)
- `manualPlanRow` pone `current_period_end: null`; `provisioning.test.ts` › "manualPlanRow…" lo fija. `addons` se conserva y está anotado como deuda: solo lo lee el webhook.

## Checkpoints (actualizados)
- CP1 [x] · CP2 [x] · CP3 [x] (en esta ronda no cambia ninguna consulta de rol de servicio) · CP4 [x] (C5 en la UI ya tiene test, y he comprobado que falla sin el arreglo) · CP5 [x] · CP6 [x] (`refreshFailed` en es/en/ko) · CP7 [x] · CP8 [x] (lo tocado responde a los hallazgos de la review; nada de s9.3) · CP9 [x] (el informe coincide; el CHANGELOG no necesita cambios, ya describe la feature) · CP10 [x] (2 commits en español con prefijo y `Co-Authored-By`, sin push) · CP11 [x]

## Deuda que se arrastra (no bloqueante, anotada en el informe)
Hallazgos 3, 5, 6 y 7 de la primera ronda y `addons`. El flujo de aceptar la invitación sin PKCE va a s9.8.
