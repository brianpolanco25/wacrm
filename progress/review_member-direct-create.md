# Review — i12.2 member-direct-create

**Veredicto:** APPROVED

Rama `feat/miembro-directo` (`4577e66`, `6de5654`) sobre `main @ 0e9c956`. Worktree
`/mnt/nvme-big/Dev/apps/cabbity/wacrm/.claude/worktrees/miembro-directo`. 18 archivos, +1860/−11;
coincide con el informe.

## Compuerta (ejecutada por el reviewer)
- lint: verde (0 errores; 34 warnings preexistentes, ninguno en archivos tocados — `eslint` sobre los .ts/.tsx del diff sale limpio)
- typecheck: verde
- `TZ=UTC npm test`: verde — 345 archivos, 5250 tests
- build (variables dummy de docs/harness.md): verde; `ƒ /api/platform/accounts/[id]/members/create` en el build
- replay-migrations: verde (…090, 091, 093; `verify-schema.sql: OK`, exit 0)
- Base real, repetido por el reviewer con `KEEP=1`: `progress/checks_member-direct-create.sql` → `NOTICE: §3: alta rechazada con no_seats` / `checks_member_direct_create: OK`; reaplicar la 093 sobre la base migrada → `ALTER TABLE / ALTER TABLE / COMMENT`, exit 0; `verify-schema.sql` otra vez → `schema verification passed`.

## Trazabilidad criterio ↔ test
Tests leídos; `route.test.ts` = `src/app/api/platform/accounts/[id]/members/create/route.test.ts`.
- R1 401/403 sin escribir: [x] route.test › the guard › "401s without a session", "403s a company owner" (`h.steps` vacío)
- R2 429 con clave `platform:member:<op>`: [x] "429s past the rate limit, on the bucket of the invitation" (aserta `h.rateKey`)
- R3 404 id no UUID / cuenta inexistente: [x] "404s a malformed id and a missing company"
- R4–R8 400 por campo, `owner` incluido, 7/73 caracteres, motivo 9 y de espacios, nombre vacío/121: [x] "400s %s and writes nothing" (13 casos, cada `code`); cotas en "accepts the bounds…"; normalización email + contraseña sin trim en "normalizes the email, trims the name and the reason, but never the password"
- R9 `already_member`: [x] "409s someone already in this company"
- R10 `is_operator` desde otra empresa: [x] "409s a platform operator, even from another company" (vía `platform_admins` del mock)
- R11 `email_exists` sin filtrar empresa ni user_id: [x] "409s someone of another company without saying which one" (claves del cuerpo = `code,error`)
- R12 402 plan lleno sin escribir: [x] "402s a company whose plan is full, writing nothing" (`plan_limit_reached`, `h.steps` vacío)
- R13 bitácora primero, `details` exactos, null → 500 sin más: [x] "writes the audit first, then the invitation, then the signup" (`steps` = audit→invitation→create; `toEqual` de params), "does nothing when the audit cannot be written" (`steps` = ['audit'])
- R14 contraseña fuera de bitácora/respuesta/console: [x] `expectNoPasswordLeak` (cuerpo + params de bitácora + `console.error/warn`, serializando Errors con stack) en 201, 409 exists/rejected/validación, 502, 500×3; provisioning.test › "never logs the password (R14)" (también el token). Además tenant-isolation comprueba que `impersonation_log` no contiene la contraseña.
- R15 invitación de 1 día de ESTA empresa con hash del token enviado: [x] "writes a one-day invitation of THIS company, and signs up with its token"
- R16 201 sin contraseña/token/enlace, sin correo: [x] "201s the member — no password, no token, no link, no email" (`inviteAuthUser` no llamado, sin `/join/`)
- R17 exists → delete + 409: [x] "\"exists\": deletes the invitation and 409s email_exists"
- R18 rejected → delete + 409: [x] "\"rejected\": …"
- R19 failed → 502 / excepción → 500 con limpieza: [x] "\"failed\": deletes the invitation and 502s", "an exception after the invitation deletes it and 500s", "an exception writing the invitation deletes nothing and 500s"
- R20 `createUser` con args exactos, nunca invite, mapeo de errores: [x] `src/lib/platform/provisioning.test.ts` › createConfirmedMember (i12.2) (4 casos exists, rejected, failed con error y sin id)
- R21 `deleteInvitation` filtra account_id/id/accepted_at IS NULL y no lanza: [x] provisioning.test › deleteInvitation (i12.2) (filtros exactos; error devuelto y rechazo de promesa)
- R22 CHECK admite `member_create` y las de la 087, idempotente: [x] bloque `-- 093` de `verify-schema.sql` + checks §0/§1 + reaplicación (corridos por el reviewer). Lista de la 093 = lista de la 087 + `member_create` (comparada a mano).
- R23 alta confirmada con invite_token → perfil en E con rol, sin cuenta propia, invitación aceptada: [x] checks §2 (corrido)
- R24 POST de invitación y 090 sin cambios: [x] `git diff --stat 0e9c956..HEAD` vacío para `members/route.ts`, `members/route.test.ts`, `090_invite_direct_join.sql`; suite completa en verde
- R24b plan lleno al INSERT → alta abortada sin restos: [x] checks §3 (corrido; `assert_seat_available` cuenta solo `profiles`, así que la invitación efímera no se autobloquea)
- R25 aislamiento: [x] `src/lib/security/tenant-isolation.test.ts` › "i12.2: creates a member in ONE company…" (perfil en T con rol, sin cuenta nueva, invitación aceptada, A y B por instantánea intactas, `extraWaivers=[EMAIL_LOOKUP]`) y "i12.2: 403s the owner of A on «Crear miembro», and moves nothing"
- R26 botón en «Equipo», cerrado sin inputs: [x] `member-create.test.tsx` › "shows only the button until it is opened, in both languages"; `platform-account-detail.test.tsx` › "the team block offers «Crear miembro», closed, in both languages"
- R27 validación cliente + roles sin owner: [x] `member-create-form.test.ts` › validateMemberCreate (válido, cotas, 9 rechazos con clave y valores ICU), "offers admin, agent and viewer — never owner"; `member-create.tsx` mapea `MEMBER_CREATE_ROLES` en el `<select>` y `submit` corta antes de `fetch` si `validateMemberCreate` falla (leído)
- R28 resultado una vez: [x] `member-create.test.tsx` › MemberCreateResult (email, contraseña, aviso es/en); cierre/olvido → guion S2 (pendiente del humano). Ver hallazgo 1.
- R29 texto por estado/código: [x] `member-create-form.test.ts` › memberCreateErrorKey (15 casos)
- R30 i18n: [x] `member-create.test.tsx` › "every memberCreate* key is in both, with the same placeholders" (26 claves); `messages.test.ts`/`icu-safety.test.ts` verdes
- S1, S2 (GoTrue real / navegador): guion en el informe, marcados pendientes del humano; sin capturas.

Tasks T1–T11: todas hechas (CHANGELOG en inglés por convención del archivo, desviación anotada en el informe y aceptable).

## Checkpoints
- CP1 Compuerta: [x] ejecutada por el reviewer, verde
- CP2 Migraciones: [x] 093 (número del spec), DROP IF EXISTS + ADD, aserción en verify-schema, replay exit 0, sin CASCADE ni cambios de datos
- CP3 Aislamiento: [x] consultas nuevas con rol de servicio: `deleteInvitation` filtra `account_id`; el resto son helpers existentes filtrados; únicas sin `account_id` = `findProfileByEmail` (waiver `EMAIL_LOOKUP`) e `isPlatformAdmin`; test de fuga A/B/T
- CP4 Tests: [x] R1–R30 con test leído; R22/R23/R24b con SQL corrido; S1/S2 con guion
- CP5 Sin dependencias: [x] `package.json`/lock fuera del diff
- CP6 i18n: [x] 26 claves en es y en, mismos placeholders; sin `ko`
- CP7 Next 16: [x] Route Handler con `params: Promise<…>` + `await`, como `route.md` citado en design §5; segmento estático `create` junto a `[userId]`
- CP8 Alcance: [x] todos los archivos justificados por design §3–§8
- CP9 Documentación: [x] CHANGELOG Unreleased; sin variables de entorno nuevas; informe coincide con el diff
- CP10 Git: [x] 2 commits en español con prefijo y `Co-Authored-By`; árbol limpio; sin rama remota; `main` = `0e9c956`
- CP11 Entrante: [x] no toca webhook ni facturación

## Hallazgos (archivo:línea) — ninguno bloquea
Contrastados con `code-review high` (10 hallazgos, ninguno bloqueante; los de duplicación/latencia se omiten).
1. `src/components/platform/member-create.tsx:320` — «Cerrar» sigue habilitado con `busy`. Si el operador cierra mientras la petición vuela, `close()` vacía el formulario y el 201 llega después: el miembro queda creado y la contraseña no se ve (se recupera con «Cambiar contraseña», sin fuga). Recomendado: `disabled={busy}` en «Cerrar» o ignorar la respuesta tras cerrar. Cubrir en S2.
2. `src/lib/platform/provisioning.ts:~186` — cualquier error de GoTrue que no sea exists/«Database error» cae en `failed` → 502 genérico, incluido `weak_password` si la política de Auth del proyecto exige símbolos (`generatePassword` es alfanumérico) o una contraseña de ≤72 caracteres que supere 72 bytes. Conforme a R20; anotar como deuda o mapear `weak_password` en una iteración.
3. `src/lib/platform/provisioning.ts:~186` — `rejected` se detecta por `/database error/i`: cualquier fallo del trigger se presenta como «sin asientos / invitación rechazada». Es lo que fija R20; deuda conocida.
4. `src/app/api/platform/accounts/[id]/members/create/route.ts:~200` — la línea `member_create` queda en la bitácora aunque el alta falle después (exists/rejected/failed). Es el patrón «bitácora primero» exigido por R13 y el resto de acciones de plataforma; sin cambio requerido.
5. `src/components/platform/member-create-form.ts:96` — 400 distintos de `invalid_password` y 429 caen en textos genéricos. Conforme a R29.
6. `supabase/ci/verify-schema.sql:2269` — la aserción 093 no filtra `conrelid = 'public.impersonation_log'::regclass` como hacen otros bloques del archivo. Riesgo bajo (nombre único); endurecible.

## Cambios requeridos
Ninguno. Hallazgo 1 recomendado antes del merge si el humano lo quiere; 2–6 como deuda.
