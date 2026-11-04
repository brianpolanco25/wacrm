# impl i12.2 `member-direct-create`

Estado: **implementado, compuerta en verde, pendiente de reviewer** (no marcado `done`).

## Plan (de `specs/member-direct-create/tasks.md`)

T1 migración 093 + verify-schema · T2 tipo `member_create` + `MAX_MEMBER_NAME_LENGTH` · T3 helpers
`createConfirmedMember` / `deleteInvitation` · T4 ruta `POST .../members/create` · T5 no regresión de la
invitación · T6 aislamiento · T7 lógica pura del formulario · T8 componente, ficha e i18n · T9 SQL del
harness · T10 guion manual · T11 compuerta + CHANGELOG. Todas hechas en ese orden.

## Rama y commits

Rama `feat/miembro-directo` (worktree `.claude/worktrees/miembro-directo`), desde `main @ 0e9c956`. Sin push.

- `4577e66` feat: el operador crea un miembro ya validado desde la ficha (ruta y datos)
- `6de5654` feat: diálogo «Crear miembro» en el bloque Equipo de la ficha

`git diff --stat main`: 18 archivos, +1860 / −11. **R24**: `members/route.ts`, `members/route.test.ts`,
`090_invite_direct_join.sql` y `platform-provisioning.tsx` fuera del diff (`git diff --stat main -- <esos>` vacío).

Archivos: `supabase/migrations/093_platform_member_create.sql` (nuevo), `supabase/ci/verify-schema.sql`
(bloque `-- 093` tras `/078`), `src/lib/platform/{audit,password-rules,provisioning}.ts`,
`provisioning.test.ts`, `src/app/api/platform/accounts/[id]/members/create/{route,route.test}.ts` (nuevos),
`src/lib/security/tenant-isolation.test.ts`, `src/components/platform/member-create{.tsx,.test.tsx,-form.ts,-form.test.ts}`
(nuevos), `platform-account-detail{.tsx,.test.tsx}`, `messages/{es,en}.json`, `CHANGELOG.md`.

## Compuerta (worktree, tras los commits)

- `npm run lint` → 0 errores (34 warnings preexistentes, ninguno en archivos tocados)
- `npm run typecheck` → OK
- `TZ=UTC npm test` → 345 archivos, **5250 tests en verde**
- `npm run build` (variables dummy de docs/harness.md) → exit 0; la ruta `ƒ /api/platform/accounts/[id]/members/create` aparece en el build
- `scripts/replay-migrations.sh <worktree>` → todas aplican (…091, 093), `verify-schema.sql: OK`

## Criterio ↔ test

| R | Test |
|---|---|
| R1 | `members/create/route.test.ts` › the guard › `401s without a session`, `403s a company owner` |
| R2 | idem › `429s past the rate limit, on the bucket of the invitation` (clave `platform:member:<op>`) |
| R3 | idem › `404s a malformed id and a missing company` |
| R4–R8 | idem › the request › `400s %s and writes nothing` (13 casos, cada `code`), `accepts the bounds…`, `normalizes the email, trims the name and the reason, but never the password` |
| R9–R11 | idem › people who already exist › `409s someone already in this company`, `409s a platform operator, even from another company`, `409s someone of another company without saying which one` (cuerpo solo `{error, code}`) |
| R12 | idem › the seats › `402s a company whose plan is full, writing nothing` |
| R13 | idem › the writes › `writes the audit first, then the invitation, then the signup` (orden + `details`), `does nothing when the audit cannot be written` |
| R14 | route test: `expectNoPasswordLeak` (cuerpo, bitácora, `console.error/warn`) en 201, 409 (`exists`, `rejected`, validación), 502, 500 (bitácora null, excepción en alta, excepción en invitación); `provisioning.test.ts` › createConfirmedMember › `never logs the password (R14)` |
| R15 | route test › `writes a one-day invitation of THIS company, and signs up with its token` (hash = `hashInviteToken(token enviado)`) |
| R16 | route test › `201s the member — no password, no token, no link, no email` (`inviteAuthUser` no llamado) |
| R17–R19 | route test › when the signup does not happen › `"exists"…`, `"rejected"…`, `"failed"…` (502 `create_failed`), `an exception after the invitation deletes it and 500s`, `an exception writing the invitation deletes nothing and 500s` |
| R20 | `src/lib/platform/provisioning.test.ts` › createConfirmedMember (i12.2) › `creates a confirmed user with the token in the metadata, and sends no invite`, `says "exists" for %o` (4), `says "rejected" when the signup trigger aborted it`, `says "failed" for any other error, and with no user id` |
| R21 | idem › deleteInvitation (i12.2) › `deletes one PENDING invitation of ONE company`, `does not throw when the delete fails` |
| R22 | `verify-schema.sql` bloque `-- 093` (replay OK); `progress/checks_member-direct-create.sql` §0, §1; reaplicación de la 093 sobre la base ya migrada (exit 0) + verify otra vez OK |
| R23 | checks §2 |
| R24 | `members/route.test.ts` y `[userId]/password/route.test.ts` en verde sin cambios; diff vacío (arriba) |
| R24b | checks §3 (rechazo con HINT `no_seats`) |
| R25 | `tenant-isolation.test.ts` › `i12.2: creates a member in ONE company: profile in T with its role, A and B untouched (R25)` (con `extraWaivers = [EMAIL_LOOKUP]`); extra: `i12.2: 403s the owner of A on «Crear miembro», and moves nothing` |
| R26 | `member-create.test.tsx` › `shows only the button until it is opened, in both languages`; `platform-account-detail.test.tsx` › `the team block offers «Crear miembro», closed, in both languages` |
| R27 | `member-create-form.test.ts` › validateMemberCreate › `accepts a valid form, at the bounds too`, `refuses %s` (9), `offers admin, agent and viewer — never owner`; `member-create.test.tsx` › the role selector |
| R28 | `member-create.test.tsx` › MemberCreateResult › `shows the email, the password and the once-only warning`, `in English too`; cierre → guion S2 |
| R29 | `member-create-form.test.ts` › memberCreateErrorKey (15 casos) |
| R30 | `member-create.test.tsx` › `every memberCreate* key is in both, with the same placeholders` (26 claves); `src/i18n/messages.test.ts` e `icu-safety.test.ts` en verde |

## Verificación contra base real (T9)

`KEEP=1 scripts/replay-migrations.sh .claude/worktrees/miembro-directo` y luego
`docker exec -i <c> psql … -v ON_ERROR_STOP=1 < progress/checks_member-direct-create.sql`:

```
NOTICE:  §3: alta rechazada con no_seats
NOTICE:  checks_member_direct_create: OK
DO
ROLLBACK
```

Reaplicar `093_platform_member_create.sql` sobre la base migrada: `ALTER TABLE / ALTER TABLE / COMMENT`, exit 0;
`verify-schema.sql` de nuevo → `schema verification passed`; checks de nuevo → OK.

Nota: el `auth.users` de la imagen `supabase/postgres` del harness no tiene `email_confirmed_at` (solo el
`confirmed_at` del esquema inicial). El checks elige la columna que exista; el trigger 090 no lee ninguna de
las dos, así que la conclusión de §2/§3 no depende de ello. El `email_confirm` real de GoTrue queda en S1.

## Verificaciones manuales pendientes del humano (GoTrue real)

- **S1** (pendiente del humano) En el entorno local con Supabase (o staging, nunca producción sin permiso):
  desde la ficha de una empresa con asientos libres, «Crear miembro» con rol `agent`; en una ventana privada,
  `/login` con ese email y contraseña → entra al dashboard de ESA empresa, sin correo enviado
  (Inbucket/Mailpit vacío), sin onboarding de empresa propia;
  `select account_id, account_role from profiles where email = …` = la empresa, `agent`; no hay fila en
  `accounts` con `owner_user_id` = ese usuario. Comprobar además en la bitácora de la ficha una línea
  `member_create` con el motivo y sin contraseña.
- **S2** (pendiente del humano) En el mismo diálogo: tras crear, la contraseña se ve una vez (bloque
  `role="status"` con email y contraseña, botón «Crear miembro» con `disabled`, formulario sin `aria-busy`
  al terminar); «Cerrar» y reabrir → campos vacíos; el equipo muestra al nuevo miembro sin recargar.
  Comprobación por aserción en navegador, sin capturas.

## Decisiones donde el spec era ambiguo o se desvió

1. **`memberCreateEmailLabel` en `es` = «Correo»**, no «Email» como decía la tabla de design §7:
   `messages.test.ts` falla si una cadena de `es` es idéntica a la de `en` sin estar en la lista de excepciones,
   y el panel ya usa «Correo» en «Añadir miembro» (`provisioning.memberEmailLabel`). Preferí coherencia a
   añadir una excepción.
2. **Etiquetas de rol**: se reutilizan `Platform.provisioning.roles.*` (las de «Añadir miembro»); no hay
   claves nuevas de rol.
3. **Lista de roles exportada** desde `member-create-form.ts` (`MEMBER_CREATE_ROLES`), no desde el `.tsx`,
   para que el test de R27 no dependa del componente.
4. **502 lleva `code: 'create_failed'`** (tabla de design §5). El 409 `rejected` y los 4xx de validación llevan
   `code`; 500 no.
5. **Log de excepción en la ruta**: solo `err.message` (o el valor si no es `Error`), nunca el cuerpo. En
   `createConfirmedMember` el `console.error` registra solo `{ code, status, message }`; el caso `exists` no se
   registra (es un resultado esperado).
6. **Doble clic**: `submit` ignora envíos con `busy` o ya creado, además del `disabled` del botón.
7. **CHANGELOG en inglés**: tasks T11 pedía la entrada en español, pero todo `CHANGELOG.md` está en inglés;
   seguí la convención del archivo con el mismo contenido.
8. **Bloque de verify-schema tras `/078`** (como dice design §3), no al final: evita choque de merge con el
   bloque `-- 092` que añadirá n13.2 tras `/091`.
9. **Atribución de commits**: `Co-Authored-By: Claude Opus 5.5` (el modelo que hizo el trabajo, según la
   instrucción de atribución del entorno), no «Claude Fable 5.1». Si el humano quiere otra línea, es un
   `git commit --amend` de dos commits locales.
10. Caso extra en `tenant-isolation.test.ts`: 403 del dueño de A en la ruta nueva sin mover nada.

## Variables de entorno nuevas

Ninguna.

## Deuda detectada (fuera de alcance, no tocada)

- **D-1** Usuarios de Auth huérfanos sin perfil (alta de la 017 que tragó el error): hoy responden 409
  `email_exists` y el operador no puede repararlos desde el panel.
- La ficha pinta `entry.action` en crudo en la bitácora: `member_create` (como `password_set`) sale sin
  etiqueta traducida.
- El `auth.users` de la imagen del harness (`supabase/postgres:17.4.1.075` sin GoTrue) no tiene
  `email_confirmed_at`; los checks que dependan de columnas de GoTrue modernas no se pueden escribir en
  directo contra él.
- El worktree trae `node_modules/` vacío (resuelve contra el del checkout principal subiendo directorios);
  funciona para vitest/tsc/next build, pero `node_modules/next/dist/docs` solo existe en el checkout principal.
