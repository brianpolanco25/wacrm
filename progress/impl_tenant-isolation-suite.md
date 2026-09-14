# Implementación — tenant-isolation-suite (f2.2)

**Estado:** listo para re-revisión (3ª ronda de correcciones aplicada)
**Rama:** `saas/fase-2-seguridad`
**Worktree:** `.claude/worktrees/agent-a4220e4b5ba8896fd`
**Commits:**

- `2323274 test: cubre aislamiento entre empresas` (implementación inicial)
- `8413526 fix: acota por cuenta las escrituras de flujos con rol de servicio`
  (corrección tras la 1ª ronda de CHANGES_REQUESTED)
- `313101b fix: acota por cuenta la edición de automatizaciones y estrecha su waiver`
  (corrección tras la 2ª ronda de CHANGES_REQUESTED)
- `2e2cfef fix: acota por cuenta lectura, borrado y clonado de automatizaciones`
  (corrección tras la 3ª ronda; sale de `66d7733`)

> La rama de fase avanzó entretanto con otras features (`0997adf`, `74834d7`);
> este commit sale de `74834d7`.

## Tercera ronda de CHANGES_REQUESTED — la fuga real

El revisor destapó que la premisa de los dos waivers de `automations`
—«`user_id` es más estrecho que la cuenta»— **es falsa**, y detrás había
un borrado entre cuentas vivo. Tenía razón: `remove_account_member`
(`018_account_member_rpcs.sql:186-197`) crea una cuenta personal y mueve
ahí el perfil del expulsado, y `redeem_invitation`
(`019_invitation_rpcs.sql:216-217`) lo mueve a la cuenta que invita. En
ambos casos **el perfil cambia de cuenta y las filas que creó se quedan
atrás** con `account_id = A, user_id = U`. Con la sesión aún válida,
`getCurrentAccount()` lee el perfil en vivo, el ex-miembro pasa el rol
como owner de su cuenta nueva, y un filtro `id + user_id` **seguía
casando la automatización de A**.

Se arregla aquí, no se difiere (decisión del líder; está en el corazón de
la sección 2).

### 1. Las tres consultas acotadas por cuenta

`src/app/api/automations/[id]/route.ts`:

- **GET** (`:23-60`): resuelve la cuenta con `getCurrentAccount()` y filtra
  `.eq('account_id', accountId).eq('user_id', userId)`. Se usa
  `getCurrentAccount` y no `requireRole('agent')` **a propósito**: la RLS
  `automations_select` (017:456) solo pide pertenencia, así que exigir
  `agent` para leer sería un cambio de producto (dejaría fuera a los
  `viewer`). Efecto colateral aceptado: un usuario autenticado cuyo perfil
  no tiene cuenta pasa de 401 a 403, que es lo que devuelven las demás
  rutas de la misma familia.
- **DELETE** (`:158-…`): `requireRole('agent')` aporta `accountId` y
  `userId`; se comprueba la pertenencia bajo la cuenta antes de borrar
  (mismo patrón que el PATCH y que el DELETE de flujos) y el `delete`
  lleva `.eq('account_id', accountId).eq('user_id', userId)`.
- **PATCH**: `userId` sale ahora del contexto de `requireRole` (hallazgo 5
  del revisor); desaparece el helper `requireUser()` y con él la segunda
  llamada a `auth.getUser()` con un cliente SSR nuevo.

`src/app/api/automations/[id]/duplicate/route.ts`: `requireRole('agent')`
aporta las dos cosas, la lectura del original lleva `account_id`, y el
clon se inserta con **la cuenta del llamante**, no con
`original.account_id`.

### 2. Cambio de comportamiento visible: el DELETE ya no miente

Antes devolvía `{ ok: true }` pasara lo que pasara — borrase o no. Ahora
devuelve **404** cuando la fila no es de la cuenta (o no es del autor).
Es lo que pedía el líder y lo que hace que el test distinga el arreglo del
estado anterior. La UI
(`src/app/(dashboard)/automations/page.tsx:124-133`) ya trata `!res.ok`
como error con su toast, así que no hay nada que adaptar; el 404 solo
puede salir en un caso que la UI no provoca.

### 3. Los waivers retirados

`automations / select` y `automations / delete` salen **enteros** de
`GLOBAL_WAIVERS`. En su lugar queda una línea de comentario que dice por
qué no hay ninguno. La tabla `automations` vuelve a estar bajo la regla
general: cualquier consulta suya con rol de servicio sin `account_id` es
violación.

### 4. Tests nuevos (tres)

En el describe `/api/automations (service-role writes)`:

- `an ex-member of A cannot read, delete or clone A's automation from
  their new account` — **el caso que faltaba**. Empuja una cuenta `C`,
  mueve el perfil de `USER_A` ahí como owner (exactamente lo que hacen
  018/019) y deja sus filas en A; con `h.actor = { userId: USER_A,
  accountId: C }` ejercita GET, DELETE, PATCH y duplicate sobre `auto-a`:
  los cuatro 404, `auto-a` intacta, una sola automatización en A (nada
  clonado dentro) y `snapshot(A)` idéntico.
- `DELETE removes A's own automation and leaves B's alone` y
  `duplicate clones A's automation into A` — los caminos positivos. Sin
  ellos el `delete` y el `insert` **nunca llegan a ejecutarse** (los tests
  de 404 paran en la comprobación de pertenencia) y la auditoría del
  `afterEach` no tendría nada que juzgar: comprobado, quitando el
  `.eq('account_id', …)` del `delete` la suite seguía verde antes de
  añadirlos.

### 5. Barrido del mismo patrón en el resto de rutas (punto 5 del líder)

Repasados los 14 `.eq('user_id', …)` de `src/app/api` y `src/lib` fuera de
tests. **No queda ninguno más del patrón**: todos los demás son lecturas de
`profiles` con el cliente de sesión (RLS activa) para *resolver* la cuenta
—`flows/route.ts:70`, `whatsapp/config/route.ts:28`,
`whatsapp/templates/[id]/route.ts:74,265`,
`whatsapp/media/[mediaId]/route.ts:41`,
`whatsapp/config/verify-registration/route.ts:47`,
`lib/storage/upload-media.ts:114`, `lib/auth/account.ts:120`— o ya llevan
`account_id` junto al `user_id` (`ai/config/route.ts:111`,
`lib/whatsapp/outbound-media.ts:210`). Las automatizaciones eran el único
sitio donde el `user_id` hacía de frontera de inquilino con el cliente de
rol de servicio.

### 6. Lo que la suite NO distingue, dicho claro

Clonar con `accountId` en vez de con `original.account_id` es **defensa en
profundidad**, no un arreglo que la suite pueda detectar: mientras la
lectura de arriba lleve `account_id`, los dos valores coinciden siempre y
revertir esa línea deja los 52 tests en verde (comprobado). Lo que sí
detecta la suite es la pérdida del filtro en la lectura, que es la línea
que sostiene el arreglo.

## Comprobaciones de esta ronda (mutaciones, todas revertidas)

| Mutación | Resultado |
|---|---|
| GET sin `.eq('account_id', accountId)` | **rojo**, 2 tests: `select on automations without account_id (filters: id, user_id)` |
| Lectura de pertenencia del DELETE sin `account_id` | **rojo**, 2 tests: la auditoría + `expected 200 to be 404` en el test del ex-miembro (la sesión del ex-miembro volvía a pasar la puerta) |
| `delete` sin `account_id` | **rojo**: `delete on automations without account_id (filters: id, user_id)` en el DELETE positivo |
| Lectura del duplicate sin `account_id` | **rojo**, 2 tests: la auditoría + `expected 201 to be 404` (el ex-miembro clonaba dentro de A) |
| `account_id: original.account_id` en el clon | **verde** — ver punto 6 |

`git status` limpio tras cada una.

## Compuerta de esta ronda

En el worktree, en orden, tras los cambios:

- `npm run lint` — verde (0 errores, 37 warnings preexistentes).
- `npm run typecheck` — verde.
- `TZ=UTC npm test` — verde: **85 archivos, 960 tests** (52 en
  `tenant-isolation.test.ts`, antes 49; el resto ya venía de `66d7733`).
- `npm run build` con las cuatro variables dummy de CI — verde
  (`✓ Compiled successfully in 11.6s`).
- `scripts/replay-migrations.sh` — no aplica: sin SQL.
- Prettier: `tenant-isolation.test.ts` y `CHANGELOG.md` pasan `--check`.
  Las dos rutas de automatizaciones **ya estaban fuera de estilo en
  `66d7733`** (verificado con `git show HEAD:… | prettier --check`, las dos
  salen marcadas); se editaron en su estilo local, como en las rondas
  anteriores, para no ahogar el arreglo en un reformateo total.

## Segunda ronda de CHANGES_REQUESTED — los tres puntos

### 1. El waiver de `automations / select` era más ancho que su motivo

`by: ['id']` casaba por tabla + operación + columnas, no por ruta, así que
además del GET de `/api/automations/[id]` bendecía la lectura de
`src/lib/automations/engine.ts:146-150` — la misma que `8413526` había
acotado. Ahora es `by: ['id', 'user_id']`: solo casan las dos lecturas legacy
por autor (GET de `/api/automations/[id]` y `/api/automations/[id]/duplicate`,
ambas con `.eq('user_id', …)`), y cualquier otra lectura de una automatización
por id suelto vuelve a ser violación. El motivo lo dice explícitamente.

**Comprobado:** quitando `.eq('account_id', pending.account_id)` de
`engine.ts:149` la suite queda en **rojo** — falla
`automations cron: each pending execution runs against its own automation and
logs under its own account` con
`select on automations without account_id (filters: id)` (dos veces, una por
cuenta barrida). Archivo restaurado, `git status` limpio.

### 2. El PATCH de `/api/automations/[id]`: filtro de cuenta, no waiver

Resuelto como en flujos, con la opción preferida por el revisor. El PATCH ya
llamaba a `requireRole('agent')` por el rol; ahora se queda con el `accountId`
que devuelve y lo pasa a las dos consultas admin:

- la lectura de pertenencia (`:71-80`) → `.eq('id', id).eq('account_id', accountId)`;
- el `update` (`:126-131`) → `.eq('id', id).eq('account_id', accountId)`.

La comparación `existing.user_id !== user.id` se mantiene: es la regla vieja
por autor, más estrecha que la cuenta, y quitarla sería un cambio de producto
fuera de alcance. El límite de tenancy ahora es el filtro, no el `if` en JS.
`replaceSteps` escribe en `automation_steps`, tabla hija acotada por
`automation_id`, ya cubierta por `CHILD_TABLES`.

Test nuevo: `PATCH edits A's own automation and leaves B's alone`
(`tenant-isolation.test.ts`, describe `/api/automations (service-role writes)`).
Patchea la automatización **de A** con `is_active: false` para esquivar el
validador de activación y llegar de verdad al `UPDATE`; comprueba 200, la fila
de A modificada bajo su cuenta, la de B intacta, y `expectBUnchanged(before)`.

**Comprobado, dos experimentos** (archivos restaurados después):

1. Quitado `.eq('account_id', accountId)` del `update` → falla el test nuevo con
   `update on automations without account_id (filters: id)`.
2. Quitado el de la lectura de pertenencia → fallan **dos** tests
   (el nuevo y el 404 de la automatización de B) con
   `select on automations without account_id (filters: id)`.

O sea: el caso positivo es detector por partida doble.

### 3. El motivo del waiver `contacts / update / by:['id']`

Reescrito. Antes nombraba solo el refresco de nombre del webhook; ahora dice
que casa por tabla + operación + columnas y por tanto cubre **toda** escritura
a un contacto por id suelto: el webhook, el `working phone` de los dos
`meta-send` (flujos y automatizaciones) y —hoy no lo necesita porque sí lleva
`account_id`, pero lo cubriría si se perdiera— el PATCH de
`/api/v1/contacts/[id]`. Deja escrito cuál es el precio (un filtro perdido en
un `update` de `contacts` por id no salta; lo que la auditoría sigue vigilando
es la lectura previa) y cómo se retira el waiver (deuda 2).

## Compuerta de esta ronda

En el worktree, en orden, tras los cambios:

- `npm run lint` — verde (0 errores, 37 warnings preexistentes).
- `npm run typecheck` — verde.
- `TZ=UTC npm test` — verde: **85 archivos, 955 tests** (antes 945; +1 test de
  aislamiento y el resto de otras features de la rama).
- `npm run build` con las cuatro variables dummy de CI — verde
  (`Compiled successfully`).
- `scripts/replay-migrations.sh` — no aplica: sin SQL.
- Prettier: `tenant-isolation.test.ts` y `CHANGELOG.md` pasan `--check`.
  `src/app/api/automations/[id]/route.ts` **ya estaba fuera de estilo antes**
  (verificado con `git show HEAD:… | prettier --check`): mismo caso que las
  rutas de flujos, se editó en su estilo local para no ahogar el cambio.

## Respuesta a los hallazgos del reviewer

### Hallazgo 1 (CRÍTICO) — consultas de rol de servicio sin `account_id`

`src/app/api/flows/[id]/route.ts` y `src/app/api/flows/[id]/activate/route.ts`
escribían con `supabaseAdmin()` filtrando solo por id de fila.

- Se añadió `requireWritableFlow(flowId)` en `[id]/route.ts`: `requireRole('agent')`
  resuelve la cuenta del llamante y la pertenencia del flujo se comprueba con el
  cliente admin **y** `.eq('account_id', accountId)`. Devuelve 404 igual que antes
  para un flujo ajeno, pero ahora el 404 lo produce el filtro de cuenta, no la RLS
  (que ese cliente no aplica). PUT y DELETE lo usan; GET sigue con el cliente de
  sesión y su RLS.
- Toda consulta admin sobre `flows` en PUT (update y relectura) y DELETE lleva
  `.eq('account_id', accountId)`.
- `flow_nodes` **no tiene columna `account_id`** (migración 010; la 017 la scopea
  vía `flows`). Sus operaciones se acotan por `flow_id`, y ese id se prueba
  perteneciente a la cuenta antes de borrar/insertar. Está comentado en el código.
- `activate/route.ts`: `requireRole('agent')` aporta la cuenta; la lectura de
  pertenencia pasó al cliente admin con filtro de cuenta (y se eliminó el
  `createClient()` + `auth.getUser()` redundante, que daba el mismo 401), la
  recarga para el validador y el `update` de estado llevan `account_id`, y la
  lectura de `flow_nodes` va por el `flow_id` ya validado.

Fuera de esos dos handlers, la auditoría (hallazgo 2) destapó dos lecturas más de
rol de servicio por id suelto sobre tablas que **sí** tienen `account_id`, con la
cuenta ya en la mano en el sitio de la llamada. Se arreglaron por ser del mismo
tipo y de una línea:

- `src/lib/flows/engine.ts` — `loadFlow(db, flowId)` → `loadFlow(db, flowId, accountId)`,
  con `run.account_id` en su única llamada.
- `src/lib/automations/engine.ts` — la automatización de un paso encolado se lee
  con `.eq('account_id', pending.account_id)`.

### Hallazgo 2 (ALTO) — la regla como propiedad, no como caso

- `fake-supabase.ts` registra ahora, además de tabla/operación/filtros/actor, las
  **filas escritas** (`payload`) y los **argumentos de `rpc()`**. Un `insert` no se
  juzga por sus filtros sino por lo que escribe.
- Nuevo `src/lib/security/service-role-audit.ts`: recorre el registro y devuelve
  toda consulta con `rls: null` sin ámbito de cuenta. Considera con ámbito:
  filtro `account_id` (o `<embed>.account_id`), `account_id` en todas las filas
  insertadas, clave del padre en las tablas sin esa columna (`CHILD_TABLES`:
  `messages`, `message_reactions`, `contact_tags`, `flow_nodes`,
  `automation_steps`, `broadcast_recipients`, `flow_run_events`), `id` en
  `accounts` (donde el id **es** la cuenta) y un argumento `*account_id` en un
  `rpc()`.
- `tenant-isolation.test.ts` corre esa auditoría en un `afterEach`, es decir en
  **los 48 tests**, no en uno. Lo que no puede llevar ámbito está declarado en
  `GLOBAL_WAIVERS` con su motivo escrito, uno por uno y tan estrecho como la
  consulta (tabla + operación + columnas que la hacen segura):
  resolutores de inquilino (`api_keys` por `key_hash`, `whatsapp_config` por
  `phone_number_id`), barridos de cron entre cuentas (`flow_runs`,
  `automation_pending_executions` por `status`), y escrituras sobre una fila cuyo
  id salió de una lectura ya acotada (`contacts`, `conversations`, `broadcasts`,
  `broadcast_recipients`, `flow_runs`). Cada test puede añadir los suyos
  (`extraWaivers`); lo usa el test que demuestra la fuga a propósito.
- Rutas de lifecycle de plantillas cubiertas:
  `whatsapp/templates/[id]` (PATCH/DELETE) y `whatsapp/templates/submit`, que pasan
  `supabaseAdmin()` (storage + db) a `ensureImageHeaderHandle`. Los tests corren
  **fuera** de `WHATSAPP_TEMPLATES_DRY_RUN` a propósito: el atajo de dry-run se
  salta justo el trozo que usa el rol de servicio.

## Criterios de aceptación y pruebas

| Criterio del spec | Prueba |
|---|---|
| Una prueba de fuga por ruta con rol de servicio | `src/lib/security/tenant-isolation.test.ts`, 48 tests. Cubre `/api/v1` (me, contacts, conversations, messages, broadcasts, webhooks), webhook de WhatsApp, send/broadcast/resume, config, los dos crons, automations, flows, quick replies, IA y —nuevo— el lifecycle de plantillas. Los `it` nuevos: `PUT rewrites A's flow and its node graph, leaving B's alone`; `DELETE removes A's flow and no other account's`; `activate validates and flips A's flow; B's stays active`; `PATCH on B's template → 404, nothing sent to Meta`; `PATCH refuses a header image that belongs to B, before calling Meta`; `PATCH accepts A's own attachment and edits only A's row`; `DELETE leaves B's template alone and removes A's`; `submit refuses B's attachment and, with A's, submits under A` |
| Quitar un `.eq('account_id', …)` hace fallar la suite | Propiedad en `afterEach` de `tenant-isolation.test.ts` (los 52 tests, sin waiver ya para `automations`) + los 9 tests de `src/lib/security/service-role-audit.test.ts` (`reports a read that carries no account filter`, `accepts the same read once the account filter is back`, `judges a write by the rows it inserts, not by its filters`, `reports an update or delete that only matches on the row id`, `requires an account argument on an rpc call`, `silences exactly the waived query and nothing else`, …). Verificado además a mano contra el código real, ver abajo |
| La suite corre en el `npm test` de CI | `TZ=UTC npm test`: 85 archivos, 960 tests (antes 84 / 928) |
| Fuga por cambio de cuenta del perfil (018 / 019) | `tenant-isolation.test.ts`, `it("an ex-member of A cannot read, delete or clone A's automation from their new account")`; caminos positivos que hacen ejecutable la propiedad: `it("DELETE removes A's own automation and leaves B's alone")` y `it("duplicate clones A's automation into A")` |

El commit `313101b` lleva el trailer `Co-Authored-By: Claude Fable 5.1`, que es
el que pide el harness; los dos anteriores (`2323274`, `8413526`) llevan otro y
quedan como están — reescribir su historia no compensa (anotado por el revisor
como no bloqueante).

Los tests nuevos de flujos son también detectores de fuga, no solo caminos
felices: las dos cuentas tienen un nodo con `node_key = 'start'`, así que si la
lectura de `flow_nodes` en `activate` perdiera su filtro, el validador vería un
`node_key` duplicado y devolvería 422 en vez de 200. El caso de plantillas apunta
a un adjunto legacy `<uid>/…` de la cuenta B: probar que no es de A exige una
consulta de `profiles` con el rol de servicio, y esa consulta lleva `account_id`.

## Verificaciones

Compuerta completa en el worktree, en orden:

- `npm run lint` — verde (0 errores, 37 warnings preexistentes).
- `npm run typecheck` — verde.
- `TZ=UTC npm test` — verde: 85 archivos, 945 tests.
- `npm run build` con las cuatro variables dummy de CI — verde (`Compiled successfully`).
- `scripts/replay-migrations.sh` — **no aplica**: el cambio no toca SQL ni
  migraciones. Tampoco hay `progress/checks_tenant-isolation-suite.sql`: no hay
  nada que dependa de una base real.
- Servicios externos (Meta, PayPal): ninguno. No hay verificación manual pendiente.

Comprobación manual del criterio 2, hecha y revertida (dos experimentos):

1. Quitar `.eq('account_id', accountId)` del `update` de `flows` en
   `src/app/api/flows/[id]/route.ts` → falla
   `PUT rewrites A's flow and its node graph, leaving B's alone` con
   `update on flows without account_id (filters: id)`.
2. Quitar `.eq('account_id', ctx.accountId)` de `src/app/api/v1/contacts/route.ts`
   → falla `GET /contacts lists A's contacts and never B's…` con
   `select on contacts without account_id (filters: none)`.

Ambos archivos quedaron restaurados (`git status` limpio salvo lo commiteado).

## Decisiones donde el spec era ambiguo

- **Alcance de la propiedad.** El spec pide que «añadir una ruta sin filtro rompa
  la suite». Una regla absoluta («toda consulta admin lleva `account_id`») es
  falsa: el webhook resuelve la cuenta *a partir* del `phone_number_id` y los
  crons barren todas las cuentas por diseño. La propiedad implementada es la
  versión honesta: ámbito o excepción declarada con motivo. La lista de excepciones
  es el inventario que el revisor puede auditar de un vistazo.
- **La regla de ESLint del spec ("complemento barato")** sigue sin añadirse, por lo
  ya dicho en la versión anterior de este informe: la condición textual
  (`supabaseAdmin()` en un archivo sin `account_id`) da falsos positivos en rutas
  que acotan por helper o cliente SSR, y falsos negativos en cuanto la consulta
  vive en `src/lib`. La auditoría de este commit cubre el mismo objetivo con
  precisión real (evalúa la consulta ejecutada, no el texto del archivo) y corre en
  el mismo `npm test`.
- **Prettier.** `src/app/api/flows/[id]/route.ts` y `[id]/activate/route.ts` ya
  estaban fuera de estilo antes de tocarlos (el repo no tiene semicolons en esos
  archivos y `.prettierrc` pide `semi: true`). Se editaron **en su estilo local**
  y no se reformatearon: un `prettier --write` cambiaría casi todas las líneas de
  ambos archivos y ahogaría una corrección de seguridad en ruido. Los archivos
  nuevos y los de `src/lib/security/` sí pasan `prettier --check`.
- **UUIDs en la semilla.** `USER_A`/`USER_B` y los ids de plantilla pasaron a UUID
  reales: la ruta `templates/[id]` rechaza un id que no lo sea, y un path de
  storage legacy solo se reconoce como tal si su primer segmento parsea como UUID.

## Variables de entorno

Ninguna nueva. `.env.local.example` no se tocó (bloqueado por permisos; tampoco
haría falta).

## Documentación

- `CHANGELOG.md` (Unreleased → Fixed): la entrada del ámbito de cuenta en la
  edición de flujos, la de la edición de automatizaciones (2ª ronda) y —nueva en
  esta— la del ex-miembro que podía borrar o clonar las automatizaciones de la
  empresa que dejó, con el cambio de `ok` a `404` en el DELETE.
- `docs/docker.md`: sin cambios (no hay variables nuevas).
- `.env.local.example`: bloqueado por permisos y sin necesidad de tocarlo.

## Deuda detectada fuera de alcance (no arreglada)

1. **`/api/automations/[id]` sigue scopeando *además* por `user_id`.** Cerrado lo
   que era fuga: las cuatro operaciones llevan ya `account_id` y los waivers se
   retiraron. Lo que queda es la regla vieja por autor: un compañero de equipo
   sigue sin poder ver, editar, borrar ni clonar la automatización de otro, aunque
   la RLS de la 017 (`is_account_member`) diga que sí. Es **producto**, no
   seguridad —el filtro extra solo cierra, nunca abre—, y alinearlo (quitar el
   `user_id` de las cuatro consultas, o convertirlo en «el autor o un admin»)
   merece su propia feature con decisión de producto detrás. Lo mismo pasa en el
   GET de lista (`/api/automations`), que sí lista toda la cuenta vía RLS: hoy la
   lista y el detalle no coinciden para un equipo.
2. **Escrituras por id de fila sin `account_id` redundante.** `contacts`,
   `conversations`, `broadcasts`, `broadcast_recipients`, `flow_runs` y
   `automation_pending_executions` se actualizan por `id` después de una lectura ya
   acotada. Es correcto hoy y depende de que la lectura anterior siga estando
   acotada. Añadir el filtro de cuenta a esos ~15 sitios (motores de flujos y
   automatizaciones, `broadcast-core`, webhook) sería defensa en profundidad barata,
   pero toca archivos que la sección 2 no justifica.
3. Los 37 warnings de ESLint y el aviso de raíz de Turbopack en el build son
   preexistentes y ajenos a esta feature.
4. **Hallazgos 4-7 del informe de la 3ª ronda, no bloqueantes, no tocados** (el
   líder acotó esta pasada a los tres bloqueantes más el hallazgo 3):
   - `service-role-audit.ts:106-111` — omitir `by` waivea todas las consultas de
     la tabla y omitir `op` todas las operaciones, al revés de lo que documenta
     `:63-67`. Hoy afecta a `rpc:bump_conversation_on_inbound` y al `extraWaivers`
     del test de demostración. Arreglo: exigir `by`/`op` explícitos, o documentar
     la semántica real.
   - `service-role-audit.ts:77-81` — `filterColumns` cuenta `is` como operador de
     ámbito, así que `.is('account_id', null)` pasaría por acotado. Ningún sitio
     del código lo hace hoy.
   - `fake-supabase.ts:114` — `ai_knowledge_chunks` modelada como hija de
     `ai_knowledge_documents` pese a tener `account_id` propio (030:111-112); un
     chunk huérfano se cae de `snapshot(B)`. Latente: `@/lib/ai/knowledge` está
     mockeado.
   - `fake-supabase.ts:415+` — el stub de `storage` no escribe en `db.log`, así
     que `upload/download/createSignedUrl/remove` con rol de servicio son
     invisibles a la auditoría. Es el hueco más grande que queda en la propiedad.
5. **`automations.user_id` como frontera en la UI.** La lista
   (`/api/automations` GET, cliente de sesión + RLS) muestra toda la cuenta, el
   detalle solo lo del autor. No es fuga, pero es el síntoma visible de la deuda 1.
