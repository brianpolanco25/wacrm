# Review — i12.1 invite-direct-join

**Veredicto:** APPROVED

Rama `feat/invitacion-directa` (be9cae6, d39bcd2, 63a3ff9 sobre main @ 5f64211). Diff real = el que declara el informe (32 archivos; sin `package.json`, sin webhook, sin `countSeats`/`assertStockLimit`/POST de invitaciones).

## Compuerta (ejecutada por el reviewer)
- lint: verde (0 errores, 34 warnings preexistentes, ninguno en archivos tocados)
- typecheck: verde
- vitest dirigido (`TZ=UTC`, rutas tocadas: api/invitations, (auth), join, lib/auth, lib/billing, lib/platform, lib/onboarding, api/account/invitations, api/platform, i18n): 86 archivos, 1445 tests, verde
- build / suite completa: no corridos por instrucción del líder (gate dirigido). Pendiente para el humano con `./init.sh wacrm` + build.
- replay-migrations: verde (`ok 090_invite_direct_join.sql`, `verify-schema.sql: OK`)
- `progress/checks_invite-direct-join.sql`: `checks_invite_direct_join: OK`
- Idempotencia: 090 reaplicada sobre sí misma → sin error; checks y verify-schema otra vez → OK
- Prueba propia bajo `SET ROLE authenticated`: peek y redeem funcionan (SECURITY DEFINER), `account_seat_limit` → `permission denied` (ACL correcta: solo postgres/service_role).

## Decisiones del humano verificadas
- Invitado nuevo nace en la empresa, sin cuenta personal: `090:126-161` (rama de invitación fuera del `EXCEPTION WHEN OTHERS`), checks §1 (perfil en A como agent, sin `accounts` ni `subscriptions` propias).
- No se crea empresa en silencio si venía invitado: token inválido/usado/caducado/tipo raro/>128 → `RAISE EXCEPTION` (checks §2, conteos intactos); fallo del INSERT de perfil → aborta y no cae a la rama personal (checks §3).
- Hash sha256 en SQL = `hashInviteToken` (checks §0, vector de `invitations.test.ts`); `FOR UPDATE` sobre la invitación (`090:138`) y sobre `accounts` (`090:92`).
- Auto-canje con sesión: `join-flow.ts:114-166` + `page.tsx` (guardia `useRef`, una sola POST), sin botón ni «Accepting moves…» (`join-view.test.tsx` › BANNED + catálogo sin «accept/acept»).
- Plan del cliente manda (R28–R34): alta y canje rechazan con `no_seats` (checks §7), caducadas/revocadas liberan asiento y no se consumen (checks §7, `provisioning.test.ts`, `account/invitations/route.test.ts`).
- `/auth/callback/complete` conserva `?invite=`: `callback.ts:259-266`, `callback.test.ts`, `complete/page.test.tsx`.
- Redeem no-op si ya es miembro, antes de used/expired y sin chequeo de asientos: `090:226-228`, checks §5.
- Panel de operador: `inviteToken` en `options.data` (`members/route.ts:185`, `provisioning.ts:110-118`); crear empresa (`inviteAuthUser` sin token) sin cambios (R24).

## Trazabilidad requisito ↔ test (leídos)
- R1 R2 R3 R21: [x] checks §1
- R4 R7: [x] checks §2 (6 casos + conteos); `FOR UPDATE` asertado en `verify-schema.sql`
- R5: [x] checks §3 (trigger temporal; desviación del spec justificada por la FK)
- R6: [x] checks §4
- R8: [x] `signup-invite.test.ts` › signupInviteGate; `signup-invite-view.test.tsx`
- R9: [x] `signup-invite.test.ts` › signupOptions (con y sin token)
- R10: [x] `signup-invite.test.ts` › isInviteSignupRejection
- R11: [x] `signup-invite-view.test.tsx` › "check your email" names … company
- R12: [x] `join-flow.test.ts:39` (una POST, `/dashboard`); `join-view.test.tsx:201-214`
- R13 R23: [x] checks §5 + `join-flow.test.ts:52`
- R14: [x] `join-flow.test.ts:61,89`; `join-view.test.tsx:157-198` (enlace `/dashboard`)
- R15: [x] `join-flow.test.ts:96-141`
- R16: [x] `redeem/route.test.ts` (400/409 con `reason` del HINT, 401, 500 sin fuga) + checks §6
- R17: [x] `join-flow.test.ts:145`; `join-view.test.tsx:114-125`
- R18: [x] `callback.test.ts`, `complete/page.test.tsx`
- R19: [x] `post-login.test.ts` (existente; `post-login.ts:30`) + `join-flow.test.ts:52`
- R20: [x] `onboarding/state.test.ts` (caso nuevo + existentes)
- R22: [x] `provisioning.test.ts`, `members/route.test.ts:223-225`
- R24: [x] `provisioning.test.ts` (sin token → sin data); `platform/accounts/route.test.ts` verde
- R25 R26: [x] render es/en en `join-view.test.tsx` / `signup-invite-view.test.tsx`; paridad de claves `JoinPage`/`SignupInvite` es=en comprobada
- R27: [x] diff --stat
- R28: [x] `account/invitations/route.test.ts` (3+0 y 2+1 → 402 sin insertar); `members/route.test.ts:174-179`
- R29: [x] filtros `accepted_at is null` + `expires_at > now` asertados; checks §7
- R30 R31: [x] checks §7; `redeem/route.test.ts` (`no_seats` → 400)
- R32: [x] checks §7 (peek); `join-flow.test.ts:164`
- R33: [x] checks §7 (4 casos); `seat-limit-parity.test.ts`
- R34: [x] `join-view.test.tsx:148`, `signup-invite-view.test.tsx`
- Guion manual S-M1/S-M2/S-M3: [x] presente, pendiente del humano (Supabase Auth + correo reales). Comprobar además que GoTrue responde 500 / «Database error saving new user» al abortar el trigger.

## Checkpoints
- CP1: [~] lint/typecheck/vitest dirigido verdes; build y suite completa no corridos por instrucción del líder → humano.
- CP2: [x] 090 solo `CREATE OR REPLACE`/`ALTER OWNER`/`REVOKE/GRANT`; aserciones en `verify-schema.sql`; replay 0; sin CASCADE nuevo.
- CP3: [x] Sin consultas nuevas con `supabaseAdmin()` salvo `inviteUserByEmail` (no consulta tablas). Funciones nuevas SECURITY DEFINER sin EXECUTE para anon/authenticated (verificado con ACL y `SET ROLE`).
- CP4: [x] ver trazabilidad.
- CP5: [x] `package.json` intacto.
- CP6: [x] `JoinPage`/`SignupInvite` en es y en con mismas claves; `messages.test.ts`/`icu-safety.test.ts` verdes.
- CP7: [x] `useParams`/`useSearchParams` (con Suspense) contrastados con `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/`.
- CP8: [x] alcance acorde al spec; deuda anotada en el informe.
- CP9: [x] CHANGELOG (Unreleased) con aviso de migración; sin env nuevas; informe coincide con el diff.
- CP10: [x] commits en español con prefijo y `Co-Authored-By`; sin push; `main` en 5f64211.
- CP11: [x] webhook de WhatsApp no tocado.

## Hallazgos (no bloqueantes, priorizados)
`code-review high` sobre 5f64211..63a3ff9 contrastado a mano.

1. **Media — riesgo aceptado, pero con un caso nuevo para el humano.** `src/lib/auth/join-flow.ts:132` / `src/app/join/[token]/page.tsx:63-74`: el canje sin clic convierte `/join/<t>` en una acción que cambia datos al cargar (tipo CSRF). Lo acota el guardián de `redeem_invitation` (solo dueño único de cuenta personal vacía) y está en «Riesgos aceptados» del spec. Caso no previsto allí: un **operador de plataforma** con cuenta personal vacía que abre el enlace que el panel le devuelve «para probarlo» queda movido a la empresa del cliente, consume la invitación y pierde su cuenta personal. Sugerencia de follow-up: no auto-canjear si `/api/platform/me` responde 200 (o guardián en el RPC).
2. **Media.** `src/app/api/platform/accounts/[id]/members/route.ts:130-139`: tras el primer alta del panel, el invitado ya es miembro (090) aunque no haya fijado contraseña; reinvitarlo devuelve 409 `already_member` y no hay reenvío del correo. Recuperable con `/forgot-password` (igual que antes, cuando el reintento devolvía un enlace pero tampoco correo). Follow-up: botón «reenviar invitación» o mensaje que indique «puede usar ¿Olvidaste la contraseña?».
3. **Baja — riesgo aceptado.** `supabase/migrations/090_invite_direct_join.sql:152-158`: la invitación se consume y el asiento se ocupa antes de confirmar el correo; un correo mal escrito deja el enlace `used` y un asiento ocupado hasta que el admin quite al miembro (deuda D3).
4. **Baja.** `src/lib/auth/signup-invite.ts:72`: cualquier 5xx de GoTrue (p. ej. fallo SMTP) se trata como rechazo de la invitación; si el re-peek dice `ok` se muestra `SignupInvite.rejected` en vez del error real. Cumple R10 tal como está escrito.
5. **Baja — ya en deuda del informe.** `src/lib/auth/callback.ts:265`: `/forgot-password` ignora `?invite=`. Inocuo con 090 (el invitado ya es miembro). Mensaje del modal 409 en inglés del RPC (`join-flow.ts:154`) pese a que la ruta ya manda `reason`.
6. **Baja.** `090_invite_direct_join.sql:67`: `floor()` de `operators` fraccionario vs. valor crudo en TS; irrelevante con el catálogo actual (enteros).
7. **Limpieza.** `src/app/(auth)/signup/page.tsx:51` duplica `fetchPeek` de `join-flow.ts:89`; `signup-invite-view.tsx:58` duplica `JoinFailCard`; `090:389-396` repite la cuenta de asientos de `assert_seat_available`.

## Cambios requeridos
Ninguno bloqueante. Los puntos 1 y 2 se recomiendan como follow-up antes de producción; el 1 necesita decisión del humano.
