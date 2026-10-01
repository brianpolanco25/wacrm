# Review — s9.5 impersonation-write

**Veredicto:** CHANGES_REQUESTED

Rama `platform/impersonation`, rango `22cba4b..cc78c35` (3 commits), worktree
`.claude/worktrees/platform-impersonation`. Todo en local: Docker con la imagen
`supabase/postgres:17.4.1.075` ya presente, sin red.

## Compuerta (ejecutada por el revisor)
- lint: verde (0 errores; avisos preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde — 225 archivos, 3055 tests
- build (variables dummy de ci.yml): verde
- replay-migrations (`KEEP=1`): verde — `072` aplica, `verify-schema.sql: OK`
- 072 aplicada por segunda vez sobre la misma base: 0 políticas reescritas, 25 triggers
  recreados, verify-schema sigue en verde → idempotente
- `progress/checks_impersonation-write.sql`: `NOTICE: checks_impersonation-write: OK`

## Por qué se rechaza (lo que encontré en la base)

Dos formas de escribir en la cuenta del cliente **sin que quede rastro**, probadas con SQL
en la base replicada (rol `authenticated`, `request.jwt.claim.sub` = operador; el
`auth.uid()` de esta imagen solo lee `claim.sub`). Rompen la regla de la feature: toda
mutación queda en la bitácora; sin rastro no hay acto.

**H1. Un UPDATE que saca la fila de la cuenta del cliente no deja rastro.**
Hay sesión abierta sobre A.
`UPDATE contacts SET account_id = <cuenta propia del operador> WHERE id = <contacto de A>`
→ **1 fila movida, 0 filas en `impersonation_actions`.**
Por qué: `contacts_update` no tiene WITH CHECK, así que Postgres reutiliza la USING. La
USING sobre la fila vieja pasa gracias a `can_write_account(A)` (la sesión), y la
comprobación sobre la fila nueva pasa porque el operador es miembro de su propia cuenta.
El trigger solo mira `NEW` (`072_impersonation_actions.sql:212`,
`rec := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END)`) y como
`NEW.account_id` ≠ la cuenta de la sesión, sale en la línea 220 sin registrar nada. El
resultado es que el cliente pierde datos y esos datos acaban en la empresa del operador,
sin nada en la bitácora. Lo mismo vale para cualquier tabla abierta con `account_id`, y
para las hijas si se cambia la clave del padre (`contact_tags.contact_id`,
`messages.conversation_id`, …).

**H2. Con dos sesiones abiertas, las escrituras en la sesión más antigua no dejan rastro.**
El operador abre una sesión sobre A en un navegador y otra sobre B en otro navegador (o
en incógnito). `POST /api/platform/impersonate` solo cierra la sesión anterior si viene
en la cookie de ese mismo navegador (`src/app/api/platform/impersonate/route.ts:145-150`),
y no hay ninguna restricción en la base que lo impida. Con las dos filas abiertas:
`UPDATE contacts … WHERE id = <contacto de A>` → **1 fila editada, 0 filas registradas.**
Por qué: la RLS deja pasar la escritura (`has_open_support_session(A)` es verdadero), pero
el trigger se queda solo con la sesión más reciente del operador
(`072_impersonation_actions.sql:199-208`, `ORDER BY started_at DESC LIMIT 1` → B). Como la
fila es de A, no coincide y sale sin registrar. Un operador puede usar esto a propósito
para escribir en A sin dejar huella.

Lo demás del punto 1 y 2 se comporta como debe (mismo SQL, todo con ROLLBACK):
- Una fila `suspend` abierta sobre A (con `expires_at` NULL, y también con `expires_at`
  en el futuro) → `can_write_account(A)` = false.
- El owner de B: `can_write_account(A, viewer/owner)` = false; `can_write_account(B, owner)` = true.
- Un miembro normal que escribe en su propia cuenta → 0 filas en `impersonation_actions`
  (el trigger sale temprano).
- Si falla la escritura del rastro, la acción se bloquea: le añadí un CHECK a
  `impersonation_actions` que rechaza `source='db'` y el INSERT del operador en
  `contacts` de A abortó con la violación. Criterio correcto. En HTTP pasa lo mismo:
  `SupportAuditError` → 503, sin caer a la cuenta del operador
  (`impersonation.test.ts` › "refuses — never falls back…").
- Funciones: `can_write_account`, `has_open_support_session`, `can_read_account` e
  `is_account_member` son STABLE, SECURITY DEFINER y tienen `search_path=public`.
  `record_support_write` es VOLATILE, SECURITY DEFINER. El trigger tiene `tgtype` 29
  (ROW, AFTER, INSERT/UPDATE/DELETE) en las 25 tablas.
- `pg_policies`: 59 políticas de escritura con `can_write_account` en 25 tablas, que
  coinciden con `SUPPORT_WRITABLE_TABLES`. Siguen cerradas:
  - con `is_account_member`: `accounts_update`, `account_invitations_modify` y
    `api_keys_*`;
  - con `auth.uid() = user_id`: `profiles` y `notifications`;
  - sin política de escritura: `subscriptions`, `checkout_intents`, `platform_admins`,
    `impersonation_log` e `impersonation_actions`.

  Ninguna política de escritura usa `has_open_support_session` ni `can_read_account`.

## Trazabilidad criterio ↔ test
- C1 «rol efectivo `admin`, no `owner`»: [x] `src/lib/auth/account-impersonation.test.ts` › "acts as admin, never owner…", "refuses an owner-level guard…"; SQL bloque 2 (`can_write_account(A,'owner')` falso)
- C2 «no borrar cuenta / transferir / facturación-PayPal»: [x] `src/middleware.test.ts` › "still refuses %s %s during a support session" (12 casos) + `account-impersonation.test.ts` › "refuses inside a session, whatever the role…"; `support-session-view.test.ts` › "refuses: every route on the block list says no by itself too"; SQL bloque 2 (subscriptions/accounts/api_keys/invitations)
- C3 «el middleware deja pasar las mutaciones con cookie válida»: [x] `middleware.test.ts` › "lets a mutating API request through…", "tags %s for the server to record…", "never lets the client supply the tags itself"
- C4 «cada mutación registrada en `impersonation_actions`»: [ ] **parcial**. Por HTTP sí: `impersonation.test.ts` › "records a tagged mutation…" y `support-actions.test.ts` › "files the row… once per request". Por la base, `checks_…sql` bloque 3 cubre INSERT/UPDATE en la misma cuenta, pero **no cubre H1 ni H2**, y con esos dos casos el criterio falla.
- C5 «banner "actuando como soporte"»: [x] `impersonation-banner.test.tsx` › "says the session acts and is recorded…", "says so in Spanish…". `Impersonation.acting` existe en es, en y ko.
- C6 «la ficha muestra las acciones de cada sesión»: [x] `impersonation-actions.test.tsx` (4 `it`); la ruta: `support-actions/route.test.ts` › 401/403/404/"A↔B"/"never cached"; `support-activity.test.ts` › fuga A↔B y "scopes BOTH service-role queries…"
- C7 «las rutas de servidor usan la cuenta efectiva; la red se amplía a escrituras»: [x] `support-session-view.test.ts`. Tiene guardias de no-vacuidad (`browserWrites().length > 40`, `routeFiles().length > 40`), `WRITE_OP` cubre insert/update/upsert/delete y hay un test "would catch the lookup the four routes used to make". `tenant-isolation.test.ts` › "resolves the account context to the impersonated company…"; `submit/route.test.ts` cubre el 409 y el caso normal.
- CP11 (webhook): [x] `middleware.test.ts` › "NEVER blocks the WhatsApp webhook". En la base, `checks_…sql` bloque 5 (el rol de servicio escribe sin dejar filas) y el trigger sale en la primera línea si `auth.uid()` es NULL.

## Checkpoints
- CP1: [x] compuerta en verde, ejecutada por mí.
- CP2: [x] 072 es idempotente (verificado con una segunda pasada), sin CASCADE (FK RESTRICT) y con aserciones en verify-schema (≥59 políticas, tablas excluidas sin predicado, trigger en cada tabla abierta). Además del bloque 072, falta una aserción que cubra H1/H2 cuando se arreglen.
- CP3: [x] `support-activity.ts:61,95` y `support-actions.ts` (`markSupportActionStatus` filtra por request, cuenta y sesión) filtran por `account_id`, con test A↔B.
- CP4: [ ] el criterio C4 no queda probado: el SQL no ejercita un UPDATE que cambie de cuenta ni dos sesiones abiertas, y los dos casos fallan.
- CP5: [x] `package.json` no cambia.
- CP6: [x] es/en/ko con 1983 claves cada uno, sin diferencias; 17 claves en `Platform.support`.
- CP7: [x] `unstable_rethrow` y `headers()` existen en `node_modules/next/dist/docs/`.
- CP8: [x] alcance correcto. En `platform-account-detail.tsx` son dos líneas (import y montaje). No toca 071 ni el CHECK de `action` ni las columnas de `impersonation_log`.
- CP9: [x] CHANGELOG con aviso de migración y `docs/security.md` reescrito. Ojo: `docs/security.md` afirma «one row per table row the operator's JWT wrote on the impersonated account», y H1 y H2 lo desmienten.
- CP10: [x] 3 commits en español con prefijo y `Co-Authored-By`; nada pusheado.
- CP11: [x] ver arriba.

## Hallazgos (archivo:línea)
1. `supabase/migrations/072_impersonation_actions.sql:212-221` — en un UPDATE solo se evalúa `NEW`. Un cambio de `account_id` (o de la clave del padre) que saca la fila de la cuenta de la sesión no se registra (H1).
2. `supabase/migrations/072_impersonation_actions.sql:199-208` — la sesión se elige como la más reciente del operador, no como la de la cuenta de la fila. Con dos sesiones abiertas, las escrituras en la más antigua no se registran (H2). Causa de fondo: `src/app/api/platform/impersonate/route.ts:145-150` solo cierra la sesión que viene en la cookie de ese navegador.
3. `progress/checks_impersonation-write.sql` — faltan los casos H1 y H2.
4. (menor) `src/middleware.ts:188-190` — el matcher excluye las rutas que terminan en `.svg|.png|.jpg|…`. Una mutación a `/api/…/<id>.png` con una sesión válida llega a la ruta sin etiqueta, `readSupportWrite()` devuelve null y la fila `http` no se escribe. Si la ruta escribe con rol de servicio, no queda ningún rastro. Las rutas bloqueadas siguen protegidas por `assertNotSupportSession`. Conviene registrar según el método en el servidor (o dejar de excluir `/api` en el matcher) en vez de depender solo de la etiqueta.
5. (menor) `src/app/api/whatsapp/templates/submit/route.ts:145-152` — se ignora el `error` de la consulta previa: si falla, se sigue adelante con el upsert (falla abierto). Además, el informe dice que protege a quien cambió de cuenta por invitación, pero esa fila vieja no es visible por RLS para ese usuario, así que en ese caso no aplica. El 409 en sesión de soporte sí es correcto y el caso normal no se rompe (test "saves into the effective account otherwise").
6. (decisión del humano, no bloquea por sí sola) `webhook_endpoints` queda abierta al soporte. Es un canal de salida permanente de los eventos del cliente hacia una URL cualquiera, que sobrevive a la sesión de 30 minutos. Es el mismo motivo por el que se cerró `api_keys`. El informe lo marca como decisión 4. Hay que confirmarlo con el humano antes del merge.
7. (merge) `messages/*.json`: se quita `Impersonation.viewing`, pero `platform/provisioning` (s9.4) y `platform/invite-accept` (s9.8) todavía lo usan (`platform-shell.test.tsx:161`, `impersonation-banner.tsx:56`). Al integrar hay que quedarse con la versión de s9.5 de esos dos archivos; si no, typecheck o test fallan.

## Cambios requeridos
1. En `record_support_write()`:
   - resolver la cuenta de `OLD` y de `NEW` en los UPDATE;
   - buscar la sesión abierta del operador **cuya `account_id` sea la cuenta de la fila**
     (`WHERE l.actor_user_id = uid AND l.account_id = row_account AND l.action = 'impersonation' AND …`),
     sin `ORDER BY … LIMIT 1` global;
   - registrar si cualquiera de las dos cuentas tiene sesión abierta.

   Mejor todavía, además: impedir en la RLS que una sesión de soporte cambie el
   `account_id` de una fila (un WITH CHECK explícito, o un trigger BEFORE UPDATE que
   rechace el cambio de cuenta cuando no es miembro de la cuenta vieja), porque mover
   datos entre empresas no es una acción de soporte.
2. Cerrar H2 también en origen:
   - al abrir una sesión, cerrar **todas** las sesiones abiertas del operador en la base,
     no solo la que venga en la cookie;
   - o añadir un índice UNIQUE parcial `(actor_user_id) WHERE action='impersonation' AND ended_at IS NULL`,
     y que caducar la sesión la cierre.
3. Añadir a `progress/checks_impersonation-write.sql` los casos H1 (UPDATE de `account_id` de A a la cuenta del operador: o se rechaza o queda una fila) y H2 (dos sesiones abiertas: la escritura en la antigua queda registrada o se rechaza), y la aserción correspondiente en `verify-schema.sql` si el arreglo añade un objeto (índice o trigger).
4. Ajustar `docs/security.md` a lo que quede de verdad.
5. Hallazgos 4 y 5: arreglar o anotar como deuda explícita en el informe. El 6 se decide con el humano.

## Nota sobre `code-review`
Lancé el skill `code-review` a nivel high sobre `22cba4b..cc78c35`. Corre en segundo plano
y no había devuelto resultados cuando escribí este informe. Los hallazgos de arriba salen
de mi revisión manual y del SQL contra la base replicada.

## Addendum — resultado de `code-review` (high), contrastado
Confirma H2 (`072…sql`, trigger con `LIMIT 1` global). Además:
- **Sube a cambio requerido el hallazgo 6**: `POST /api/account/webhooks` pasa con rol efectivo `admin`
  (veredicto `record`, no está en `SUPPORT_SESSION_BLOCKED` de `src/lib/auth/support-scope.ts:139-148`) y devuelve
  el secreto de firma una vez (`src/app/api/account/webhooks/route.ts:105-130`). Es un acceso que sobrevive
  a la sesión, el mismo motivo por el que se cerró `api_keys`. Cambio requerido 6: cerrar
  `webhook_endpoints` en la 072 y en `SUPPORT_WRITABLE_TABLES`, bloquear `/api/account/webhooks` en el
  middleware y añadir `assertNotSupportSession` a esas rutas, salvo que el humano decida lo contrario por escrito.
- (menor) `src/lib/platform/support-activity.ts:101` — `ACTION_LIMIT` es global a las 20 sesiones. Si una
  difusión genera muchas filas `db`, las sesiones anteriores aparecen como «no se cambió nada»
  (`impersonation-actions.tsx:78`). Debe decir que el listado está truncado, no que no hubo cambios.
- (menor) `072…sql` path `'db:'||tabla||'/'||id`: las tablas sin `id` (`contact_tags`) quedan como
  `db:contact_tags` sin identificar la fila. Conviene añadir la clave del padre (`TG_ARGV[1]`).
- (menor) las filas `http` quedan con `status` NULL salvo en los 403, así que un 400 o un 500 aparece como
  un cambio hecho. Anotarlo como deuda o mostrar «estado desconocido».
- Coincide con la deuda 1 del informe: `GET /api/flows` y `GET /api/automations` mezclan cuentas durante
  la sesión, y ahora con escritura. Recomendado arreglarlo en esta feature.

---

# Segunda ronda — `cc78c35..fa13556` (2 commits), HEAD fa13556

**Veredicto:** APPROVED

Revisión manual y SQL contra la réplica local (imagen ya presente, sin red). El skill
`code-review` no se lanzó, por indicación del coordinador.

## Compuerta (ejecutada por el revisor)
- lint: 0 errores · typecheck: verde · `TZ=UTC npm test`: 225 archivos, 3064 tests en verde ·
  build con las variables dummy: verde
- `KEEP=1 replay-migrations.sh`: salida 0, `verify-schema.sql: OK`
- 072 aplicada otra vez: 0 políticas reescritas, 24 tablas con triggers; verify-schema sigue en verde (idempotente)
- `progress/checks_impersonation-write.sql`: `checks_impersonation-write: OK`

## `pg_policies` y triggers (contados por mí)
- 56 políticas de escritura con `can_write_account`, en 24 tablas.
- Ninguna tabla excluida la usa: `accounts`, `account_invitations`, `api_keys`,
  `webhook_endpoints`, `subscriptions`, `checkout_intents`, `platform_admins`,
  `impersonation_log`, `impersonation_actions`, `profiles` y `notifications`.
- Triggers:
  - `record_support_write`: 24 tablas, tgtype 29 (AFTER ROW, INSERT/UPDATE/DELETE).
  - `forbid_support_account_move`: 24 tablas, tgtype 19 (BEFORE ROW UPDATE).
  - Ninguno de los dos está en `webhook_endpoints`.
- `uq_impersonation_log_one_open_session`: UNIQUE `(actor_user_id)` WHERE
  `action='impersonation' AND ended_at IS NULL`.

## Escenarios, con SQL real (todo con ROLLBACK)
| # | Escenario | Resultado |
|---|---|---|
| H1 | Mi UPDATE exacto de la primera ronda: `contacts.account_id` de A a la cuenta del operador, con sesión sobre A | `42501 a support session cannot move rows between accounts`; la fila sigue en A |
| H2a | Abrir una segunda sesión con una ya abierta | `unique_violation` en el índice; sigue habiendo 1 sesión abierta |
| H2b | Sin el índice (defensa en profundidad): sesión A antigua y B reciente abiertas, editar un contacto de A | la fila de auditoría queda en la sesión de A |
| — | Cerrar la sesión (`ended_at`) y abrir otra | se abre (el índice lo permite) |
| — | DELETE de un contacto de A por el soporte | 1 fila `DELETE db:contacts/<id>` con el `log_id` de la sesión |
| — | UPDATE normal en A por el soporte | registrado como PATCH |
| — | INSERT en `webhook_endpoints` de A por el soporte | rechazado por RLS; 0 filas |
| — | Miembro normal (owner de B) edita su contacto | pasa; 0 filas en `impersonation_actions`; `forbid_*` no interviene |
| CP11 | Rol de servicio (`auth.uid()` nulo): cambia `account_id`, inserta en `messages` y actualiza `conversations` | pasa; ningún trigger bloquea ni registra |

Nota: el `auth.uid()` de esta imagen solo lee `request.jwt.claim.sub`. Para simular el rol de
servicio hay que vaciarlo explícitamente dentro de la misma transacción.

## Código revisado
- `src/lib/auth/support-session-store.ts` (`supersedeOpenSupportSessions`) cierra todas las
  sesiones abiertas del actor antes del INSERT y, si falla, devuelve 500 (falla cerrado). Filtra
  por `actor_user_id`, no por cuenta, porque son las filas del propio operador; la exención está
  documentada en `tenant-isolation.test.ts`. Test en `impersonate/route.test.ts`.
- `/api/account/webhooks*`: bloqueado en `SUPPORT_SESSION_BLOCKED` y con `assertNotSupportSession(ctx)`
  en las 5 rutas. Cubierto en `middleware.test.ts`, `support-scope.test.ts` y
  `support-session-view.test.ts` («refuses: every route on the block list…»).
- Matcher: se añade `'/api/:path*'`, la forma que documenta `node_modules/next/dist/docs/…/proxy.md`.
  Test «runs on every /api path, image-looking ones included».
- `templates/submit` falla cerrado cuando falla la consulta previa (500, sin upsert). Hay test.
- `GET /api/automations` y `GET /api/flows` usan `getCurrentAccount()` y filtran con `.eq('account_id', ctx.accountId)`.
- i18n: `Platform.support` tiene 19 claves en es, en y ko, incluidas `olderActionsHidden` y `statusUnknown`.
- `ended_reason='superseded'` lo admite el CHECK de la 055/058.

## Checkpoints (segunda ronda)
CP1 [x] · CP2 [x] (idempotente, índice y triggers con su aserción en verify-schema, sin CASCADE) ·
CP3 [x] · CP4 [x] (checks, bloques 7 y 8, y mis escenarios) · CP5 [x] · CP6 [x] · CP7 [x] ·
CP8 [x] · CP9 [x] (security.md y CHANGELOG pasan a 24 tablas y 56 políticas) · CP10 [x] (2 commits
en español con prefijo y Co-Authored-By, nada pusheado) · CP11 [x]

## Deuda que queda (no bloquea)
- Las filas `http` siguen sin el status final (salvo 403); la ficha muestra «resultado desconocido».
- Deudas 2, 3, 5, 7, 8 y 9 del informe de la primera ronda siguen vigentes.
- Al hacer el merge con s9.4 y s9.8, quedarse con la versión de s9.5 de `impersonation-banner.tsx`
  y de `platform-shell.test.tsx` (`Impersonation.viewing` ya no existe).
- No hay test del camino de error de `supersedeOpenSupportSessions`; el código falla cerrado.
