# s9.5 — `impersonation-write`

## Plan (antes de tocar código)

1. Migración `072_impersonation_actions.sql`: tabla `impersonation_actions` (+ `request_id`
   único para deduplicar por petición, + `source` http/db), índices, RLS solo lectura para
   `is_platform_admin()`; `can_write_account(acc, min_role)`; reescritura de las políticas de
   escritura de las tablas de inquilino (excluidas: accounts, account_invitations, api_keys,
   subscriptions, checkout_intents, platform_admins, impersonation_log, profiles,
   notifications); trigger `record_support_write()` en esas tablas para que las escrituras
   que el navegador manda directo a PostgREST también queden en la bitácora.
2. verify-schema: bloque `-- 072` al final.
3. `IMPERSONATED_ROLE = 'admin'`; `assertNotSupportSession(ctx)` en las rutas de owner/
   facturación/equipo/claves; `resolveEffectiveAccountId` para las rutas que resolvían la
   cuenta por el perfil del operador.
4. Middleware: mutaciones con cookie de soporte pasan (salvo lista corta bloqueada) y llevan
   cabeceras `x-wacrm-support-*` (quitadas siempre de la petición entrante) que
   `resolveSupportSession` usa para `recordSupportAction` (una fila por petición).
5. Cliente de navegador: `guardReadOnly` deja escribir en las tablas que la 072 abre; el resto
   (y rpc/storage) sigue rechazado.
6. Red de regresión ampliada a escrituras (navegador y servidor) + test de rutas mutantes.
7. Banner nuevo; `ImpersonationActions` + `GET /api/platform/accounts/[id]/support-actions`.
8. docs/security.md, CHANGELOG, i18n es/en/ko, checks SQL, compuerta.

## Rama y commits

- Rama `platform/impersonation`, worktree `.claude/worktrees/platform-impersonation`, base
  `feat/superadmin` @ 22cba4b.
- `b296ca3` feat: migración 072, la sesión de soporte escribe con rol admin y deja rastro
- `384f11d` feat: sesión de soporte con escritura auditada en servidor, middleware y navegador
  (el cuerpo dice «cinco rutas»: son cuatro que escribían —automations, flows, whatsapp/config,
  whatsapp/templates/[id]— más dos lecturas de WhatsApp —verify-registration, media—; la lista
  exacta está abajo).
- `cc78c35` feat: banner de soporte con escritura y sesiones de soporte en la ficha de cuenta
- HEAD = `cc78c35`. Nada pusheado.

## Punto 4: camino (a), y por qué

**(a): migración que amplía las políticas de escritura** (`can_write_account`), más un trigger de
auditoría. El camino (b) (rutas con `supabaseAdmin()` cuando `ctx.impersonated`) no cubre lo que
de verdad hay que cubrir: el inventario de escrituras del navegador da **47 llamadas
`insert/update/upsert/delete` en 17 archivos** que hablan con PostgREST directamente
(contactos, importación, notas, campos, etiquetas, pipelines y etapas, deals, difusiones y sus
destinatarios, bandeja, ajustes). Ninguna pasa por Next. Con (b) el operador seguiría sin poder
editar un contacto o una etiqueta, que es para lo que el humano pidió la escritura. Del lado
servidor, las rutas ya escriben con `ctx.supabase` (JWT del operador) filtrando por
`ctx.accountId` o con `supabaseAdmin()` filtrando por la cuenta efectiva: (a) las cubre sin
tocarlas.

Consecuencia de (a) que obliga a algo más: las escrituras del navegador no pasan por
`recordSupportAction`, así que «cada mutación en la bitácora» exige registrarlas en la base.
De ahí el trigger `record_support_write()` (fuente `db`), colgado de las 25 tablas abiertas.

- `can_write_account(acc, min_role)` = `is_account_member(acc, min_role) OR (min_role <> 'owner'
  AND has_open_support_session(acc))`. Rol efectivo `admin` también en la RLS.
- 59 políticas reescritas (bucle sobre `pg_policies`, mismo método que la 057). Tablas abiertas
  (25): ai_configs, ai_knowledge_chunks, ai_knowledge_documents, automation_steps, automations,
  broadcast_recipients, broadcasts, contact_custom_values, contact_notes, contact_tags, contacts,
  conversations, custom_fields, deals, flow_nodes, flows, message_reactions, message_templates,
  messages, pipeline_stages, pipelines, quick_replies, tags, webhook_endpoints, whatsapp_config.
- Excluidas: accounts, account_invitations, api_keys, subscriptions, checkout_intents,
  platform_admins, impersonation_log, impersonation_actions, profiles, notifications.
- La lista TS (`SUPPORT_WRITABLE_TABLES` / `SUPPORT_REFUSED_TABLES` en
  `src/lib/auth/support-scope.ts`) está atada a la migración por test (`support-scope.test.ts`
  parsea el array `excluded` y el mapa `parents`) y por SQL (`checks_…sql` bloque 0 compara las
  tablas abiertas y con trigger con la lista literal).

## Qué se construyó

| Archivo | Qué es |
|---|---|
| `supabase/migrations/072_impersonation_actions.sql` | tabla, `can_write_account`, `record_support_write`, reescritura de políticas y triggers |
| `supabase/ci/verify-schema.sql` | bloque `-- 072` al final (tabla, columnas, FK RESTRICT, CHECKs, UNIQUE request_id, índices, RLS, ≥59 políticas, excluidas sin predicado, trigger en cada tabla abierta) |
| `src/lib/auth/support-scope.ts` | sin imports (Edge + navegador + servidor): tablas, cabeceras, `supportWriteVerdict` |
| `src/lib/auth/support-actions.ts` | `readSupportWrite`, `recordSupportAction`, `markSupportActionStatus`, `SupportAuditError` |
| `src/lib/auth/impersonation.ts` | `resolveSupportSession` registra la acción tras las 5 comprobaciones; si no puede, lanza (nunca cae a la cuenta del operador) |
| `src/lib/auth/account.ts` | `IMPERSONATED_ROLE = 'admin'` (exportado), `assertNotSupportSession`, `resolveEffectiveAccountId`, 503 para `SupportAuditError` |
| `src/middleware.ts` | quita siempre `x-wacrm-support-*`; `record` → etiqueta; `block` → 403 `support_session_forbidden`; `Cache-Control: private, no-store` intacto |
| `src/lib/supabase/client.ts` | `guardReadOnly` deja escribir las tablas abiertas; resto, rpc y storage rechazados (`support_session_forbidden`) |
| `src/hooks/use-auth.tsx` | `effectiveAccountRole` → `admin` con bandera de soporte |
| rutas | ver «Rutas corregidas» y «Rutas que exigen owner / quedan fuera» |
| `src/lib/platform/support-activity.ts` + `GET /api/platform/accounts/[id]/support-actions` | sesiones + acciones de una cuenta, rol de servicio, filtradas por `account_id` |
| `src/components/platform/impersonation-actions.tsx` | tarjeta «Sesiones de soporte», montada en UNA línea al final de `platform-account-detail.tsx` (+ su import) |
| `src/components/layout/impersonation-banner.tsx` | texto nuevo `Impersonation.acting` (sustituye a `viewing`), icono de soporte |
| `messages/{es,en,ko}.json` | `Impersonation.acting`; `Platform.support.*` (17 claves, mismas en los tres) |
| `docs/security.md`, `CHANGELOG.md` | sección de impersonación reescrita; entrada al final de Unreleased con aviso de migración |

## Rutas que exigen `owner` o quedan fuera de la sesión de soporte

Qué distingue `owner` de `admin` hoy: solo `POST /api/account/transfer-ownership`
(`requireRole('owner')` + RPC). Ninguna política de escritura pide `owner`. Pero varias rutas
`admin` son de las que el spec saca del soporte, así que se cierran aparte:

| Ruta | Por qué | Quién la cierra |
|---|---|---|
| `POST /api/account/transfer-ownership` | owner | middleware, `requireRole('owner')`, `assertNotSupportSession` |
| `POST /api/billing/checkout`, `POST /api/billing/subscription` | facturación / PayPal del cliente (son `admin` en el código) | middleware, `assertNotSupportSession`; `subscriptions`/`checkout_intents` sin política de escritura |
| `PATCH /api/account` | renombrar la cuenta (`accounts` excluida) | middleware, `assertNotSupportSession`, RLS |
| `PATCH/DELETE /api/account/members/[userId]` | las RPC `set_member_role`/`remove_account_member` resuelven la cuenta por `auth.uid()` = la del OPERADOR | middleware, `assertNotSupportSession` |
| `POST /api/account/invitations`, `DELETE /api/account/invitations/[id]` | acceso que sobrevive a la sesión | middleware, `assertNotSupportSession`, RLS |
| `POST /api/account/api-keys`, `DELETE …/[id]`, `POST …/[id]/rotate` | credencial permanente | middleware, `assertNotSupportSession`, RLS |
| `POST /api/invitations/[token]/redeem` | mueve el perfil del propio operador | middleware (la ruta no resuelve contexto) |
| `POST /api/platform/impersonate` | no anidar sesiones (`/stop` sigue abierto) | middleware |
| borrar la cuenta | no existe ruta; `accounts` sin política DELETE | RLS |
| cualquier mutación fuera de `/api` (server actions) | nada la registraría | middleware |

Los GET de esas mismas pantallas (estado de facturación, miembros, invitaciones) siguen abiertos.

## Rutas corregidas (lo que la red encontró)

Resolvían la cuenta leyendo `profiles.account_id` del usuario autenticado — durante la sesión, la
empresa del OPERADOR — y hasta ahora lo tapaba el 403 del middleware:

- `POST /api/automations` y `POST /api/flows`: creaban la automatización/flujo en la cuenta del
  operador → usan `ctx` de `requireRole('agent')`.
- `GET/POST/DELETE /api/whatsapp/config`: conectaban/borraban el número en la cuenta del operador
  → `resolveEffectiveAccountId`.
- `PATCH/DELETE /api/whatsapp/templates/[id]` → `resolveEffectiveAccountId`.
- Lecturas: `GET /api/whatsapp/config/verify-registration`, `GET /api/whatsapp/media/[mediaId]`
  → `resolveEffectiveAccountId` (vista mal etiquetada, mismo arreglo de una línea).
- `POST /api/whatsapp/templates/submit`: el upsert va por el índice legado
  UNIQUE(user_id, name, language); si el operador tenía en su empresa una plantilla con el mismo
  nombre e idioma, el upsert la MOVÍA a la cuenta del cliente (la política UPDATE nueva lo
  permite: USING = su cuenta, WITH CHECK = la del cliente). Ahora 409 antes de llamar a Meta.
  Aplica también a quien cambió de cuenta por invitación (mismo bug, preexistente).

Del navegador, las 47 escrituras ya usaban `useAuth().accountId` (f4.4) y claves de fila; la red
lo fija ahora.

## Criterio ↔ test

| Criterio | Archivo | `it(...)` |
|---|---|---|
| Rol efectivo `admin`, nunca `owner` | `src/lib/auth/account-impersonation.test.ts` | «acts as admin, never owner, whatever the operator really is (s9.5)» |
| `agent`/`admin` pasan sobre la cuenta impersonada, con la puerta de facturación del CLIENTE | idem | «lets a %s-level guard through on the impersonated account (s9.5)» |
| `owner` rechazado y la fila marcada 403 | idem | «refuses an owner-level guard, and says why» |
| Facturación/equipo/claves rechazados en sesión, sea cual sea el rol | idem | «refuses inside a session, whatever the role, and stamps the 403»; «is a no-op for an ordinary request» |
| Rutas manuales usan la cuenta efectiva | idem | «is the impersonated account in a session, without reading the operator's profile»; «is the caller's own account otherwise» |
| Sin fila de bitácora no hay escritura (503, no cae a la cuenta propia) | `src/lib/auth/impersonation.test.ts` | «refuses — never falls back to the operator's own account — when it cannot record»; `account-impersonation.test.ts` «answers 503 and says nothing was changed» |
| Se registra cada mutación con sesión verificada | `src/lib/auth/impersonation.test.ts` | «records a tagged mutation under the signed session, before resolving»; «records nothing for a read»; «records nothing for a session that does not verify, tags or not» |
| Una fila por petición (request_id único) | `src/lib/auth/support-actions.test.ts` | «files the row under the signed session, once per request» |
| Estado 403 filtrado por request/cuenta/sesión (CP3) | idem | «stamps this request's row, scoped by request, account and session (CP3)» |
| Middleware deja pasar y etiqueta las mutaciones | `src/middleware.test.ts` | «lets a mutating API request through…», «tags %s for the server to record, with a fresh request id», «gives every request its own id…» |
| El cliente no puede falsificar las etiquetas | idem | «never lets the client supply the tags itself» |
| Lista corta sigue bloqueada | idem | «still refuses %s %s during a support session» (12 casos); «refuses a mutating page request, which nothing would record» |
| …pero sus lecturas no | idem | «lets the same routes be READ…» |
| CP11 webhook y exentos | idem | «NEVER blocks the WhatsApp webhook», «does not block the public API or the cron sweeps», «does not block the operator's own way out» |
| `Cache-Control: private, no-store` se conserva | idem | «forbids shared caching of any page carrying the customer's name» |
| Veredicto por ruta | `src/lib/auth/support-scope.test.ts` | «records %s %s», «blocks %s %s», «passes %s %s untouched» |
| Tablas TS = migración | idem | «refuses exactly what migration 072 keeps closed», «includes every child table the audit trigger knows how to resolve», «keeps billing, ownership, membership, API keys and the trail closed» |
| Navegador escribe tablas abiertas, rechaza el resto | `src/lib/supabase/client.test.ts` | «lets the delete contacts/page.tsx makes through…», «lets %s through on a table the session may write», «refuses writes to %s, and keeps the chain refusing», «refuses the profile save profile-form.tsx makes» |
| Red de regresión, escrituras del navegador | `src/lib/security/support-session-view.test.ts` | «goes to a table whose support-session fate was decided», «creates rows in the effective account, never the operator's», «never names the account from the profile or the user», «updates and deletes by row id (or account), never by the current user» |
| Red, servidor | idem | «no server file resolves the account from the operator's profile», «would catch the lookup the four routes used to make», «guards every upsert keyed by user_id…» |
| Toda ruta mutante o registra o rechaza | idem | «records: every route the middleware lets through resolves the session», «refuses: every route on the block list says no by itself too» |
| Rol efectivo en el navegador | idem | «is admin during a support session…», «is the operator's own role otherwise» |
| Una escritura de ruta durante la sesión cae en la cuenta del cliente, no en la del operador | `src/lib/security/tenant-isolation.test.ts` | «resolves the account context to the impersonated company, acting as admin (s9.5)» |
| Plantilla no se mueve entre cuentas | `src/app/api/whatsapp/templates/submit/route.test.ts` | «409s, and upserts nothing, when the same user has this template in another account»; «saves into the effective account otherwise» |
| Banner nuevo (es/en/ko) con salida | `src/components/layout/impersonation-banner.test.tsx` | «says the session acts and is recorded…», «says so in Spanish, the default locale (CP6)», resto de casos previos |
| Ficha: sesiones y acciones desplegables | `src/components/platform/impersonation-actions.test.tsx` | «lists every session…», «folds each session's actions under a disclosure», «tells a request from a row, and marks what the server refused», «is translated in %s (CP6)» |
| Ruta de acciones: guarda, 404, A↔B | `src/app/api/platform/accounts/[id]/support-actions/route.test.ts` | «401s…», «403s a company owner…», «404s…», «answers for the account in the URL and no other (A↔B)», «is never cached by a shared cache» |
| Lectura con rol de servicio sin fuga A↔B (CP3) | `src/lib/platform/support-activity.test.ts` | «shows A's sessions and actions, and nothing of B's», «and B's file shows B's…», «scopes BOTH service-role queries by the account asked about (CP3)» |

## Verificación contra base real

`progress/checks_impersonation-write.sql` sobre `KEEP=1 scripts/replay-migrations.sh` (imagen ya
descargada, sin red). Salida `NOTICE: checks_impersonation-write: OK`. En una transacción con
ROLLBACK comprueba:

0. Tablas con política `can_write_account` = tablas con trigger = las 25 de `SUPPORT_WRITABLE_TABLES`.
1. Con sesión abierta sobre A, el operador (rol `authenticated`, `sub` = operador) inserta y
   actualiza `contacts`, inserta `tags` y `contact_tags` (hija, por su padre) en A; en B el
   INSERT da `insufficient_privilege` y UPDATE/DELETE afectan 0 filas.
2. Con sesión: `subscriptions` (INSERT rechazado, UPDATE 0 filas), `accounts` (UPDATE 0),
   `api_keys` y `account_invitations` (INSERT rechazado); `can_write_account(A,'owner')` falso.
3. 4 filas `source='db'` en `impersonation_actions` con el `log_id` de la sesión, método y ruta
   (`POST db:contacts/<id>`, `PATCH …`); ninguna de B ni de la empresa propia del operador (en la
   que escribe como miembro sin dejar rastro de soporte).
4. Sin sesión —caducada, cerrada, operador revocado— el operador no escribe en A; el dueño de B
   tampoco (control).
5. El rol de servicio escribe sin dejar filas (CP11).
6. El operador lee la bitácora pero no la escribe ni la borra; el dueño de A no la lee; la sesión
   con acciones no se puede borrar (FK RESTRICT).

`scripts/replay-migrations.sh` desde limpio: salida 0, `verify-schema.sql: OK`. La 072 aplicada
dos veces: la segunda reescribe 0 políticas y recrea los 25 triggers (idempotente). Se comprobó
que dos aserciones nuevas de verify-schema fallan de verdad (quitando el trigger de `contacts`;
añadiendo una política con `can_write_account` a `api_keys`).

## Verificación manual pendiente (navegador; todo local, sin servicios externos salvo lo marcado)

1. Operador abre sesión desde `/platform/<id>` con motivo. Banner: «Estás actuando como soporte en
   <cuenta>. Cada cambio que hagas queda registrado.» y botón de salida.
2. Contactos: crear, editar, borrar uno. Etiquetas (Ajustes): crear una. Pipelines: mover un deal.
   Todo se guarda en la cuenta del cliente; en la del operador no aparece nada.
3. `/platform/<id>` → «Sesiones de soporte»: la sesión «En curso» con N cambios; desplegar →
   filas `Fila POST db:contacts/…`, `PATCH db:deals/…`, y `Petición POST /api/…` para lo que fue
   por ruta (p. ej. respuestas rápidas).
4. Facturación → elegir plan: 403. Ajustes → Equipo → invitar: 403. Claves de API → crear: 403.
   Transferir propiedad: 403 y en la ficha la petición aparece «Rechazada (403)» si llegó a la ruta
   (las que corta el middleware no llegan: ver deuda).
5. Perfil → cambiar nombre: error «Not available during a support session» (es el perfil del
   operador). Subir un adjunto en la bandeja: mismo error.
6. Salir: vuelve a `/dashboard` propio; repetir una escritura en la cuenta del cliente desde otra
   pestaña que conserve la bandera → RLS la rechaza.
7. (Servicio externo) Conectar un número de WhatsApp o enviar una plantilla a Meta durante la
   sesión: se guarda en la cuenta del cliente. Requiere Meta real: queda manual.

## Decisiones donde el spec era ambiguo

1. **Columnas extra en `impersonation_actions`**: `source` ('http'|'db') y `request_id uuid UNIQUE`.
   La tabla es de esta feature; `request_id` es lo que deduplica por petición (`React.cache` no
   memoiza en Route Handlers y no cruza instancias) y `source` distingue las dos vías.
2. **`status`**: la fila HTTP se escribe ANTES de que la ruta responda (es la condición para que
   actúe), así que nace NULL; se marca 403 cuando el propio servidor rechaza (`requireRole`
   owner, `assertNotSupportSession`). No hay API en Next para leer el status final de la
   respuesta desde ahí. Las filas `db` no llevan status: un trigger AFTER solo existe si la
   escritura se hizo.
3. **Excluidas además de las que pidió el líder**: `account_invitations` y `api_keys` (acceso que
   sobrevive a la sesión de 30 minutos; los miembros se añaden desde el panel en s9.4), `profiles`
   y `notifications` (claveadas por `auth.uid()`: serían filas del operador).
4. **`webhook_endpoints` y `ai_configs` sí se abren**: son configuración `admin` que un ticket de
   soporte puede necesitar tocar; todo queda en la bitácora. Si el humano prefiere cerrarlas, es
   quitarlas de la lista de la 072 y de `SUPPORT_WRITABLE_TABLES`.
5. **Rol efectivo en el navegador**: `admin` durante la sesión (antes se mostraba el rol propio del
   operador), para no ofrecer controles de owner que el servidor rechaza.
6. **Mutaciones fuera de `/api` siguen bloqueadas** con cookie: no hay server actions en el repo y
   nada las registraría.
7. **Clave i18n del banner**: `Impersonation.viewing` se sustituye por `Impersonation.acting` (el
   significado cambió; mantener el nombre invitaba a leerlo como «solo mirar»).

## Variables de entorno

Ninguna nueva. `.env.local.example` no se tocó.

## Deuda detectada, fuera de alcance — NO arreglada

1. `GET /api/automations` y `GET /api/flows` listan con RLS sin filtro de cuenta: durante una
   sesión devuelven las filas de las dos empresas mezcladas (vista mal etiquetada del lado
   servidor, mismo fallo que f4.4 cerró en el navegador).
2. Las mutaciones que corta el middleware (403 en Edge) no quedan en `impersonation_actions`: el
   middleware no puede verificar la cookie ni escribir con garantías. Solo constan las que llegan
   a la ruta.
3. En el navegador siguen rechazados durante la sesión: `rpc()` (filtro por etiquetas en
   contactos, `touch_presence`) y `storage` (adjuntos: ni se ven ni se suben). Enviar un mensaje
   con adjunto desde la bandeja en soporte falla.
4. El índice legado `message_templates(user_id, name, language)` sigue siendo la raíz del 409 de
   submit (TODO ya anotado en la ruta); la migración que lo cambie a `account_id` lo elimina.
5. Borrados en cascada de tablas hijas no dejan fila `db` propia (queda la del padre). Operaciones
   masivas (importar miles de contactos en soporte) dejan una fila por fila.
6. `POST /api/whatsapp/config` devuelve 500 (no 503) si no puede registrar la acción: su catch
   propio no usa `toErrorResponse`. Rechaza igual.
7. La aserción de la 057 en verify-schema dice «support sessions are READ ONLY»: sigue siendo
   cierta para el predicado de LECTURA en políticas de escritura, pero el mensaje ya engaña. No se
   tocó para no chocar en el merge.
8. Merge con s9.4: los bloques de `verify-schema.sql` (`-- 071` / `-- 072`), `CHANGELOG.md` y
   `Platform.*` en los catálogos quedan adyacentes → conflicto trivial de «añadir ambos».
   `platform-account-detail.tsx`: dos líneas (import + montaje).
9. `src/middleware.ts` sigue con el nombre deprecado de Next 16 (`proxy.ts`); preexistente.

## Compuerta

- `npm run lint`: 0 errores (35 avisos preexistentes; el de `src/middleware.ts:67` ya estaba).
- `npm run typecheck`: limpio.
- `TZ=UTC npm test`: 225 archivos, 3055 tests en verde.
- `npm run build` con variables dummy: salida 0.
- `scripts/replay-migrations.sh`: salida 0, `verify-schema.sql: OK`; checks SQL: OK.
- Sin red externa: Docker con la imagen ya presente, `fetch` mockeado en tests.

# Segunda ronda — cierre de `progress/review_impersonation-write.md`

Commits `c2bbf88` (migración + verify-schema) y `fa13556` (código, tests, docs). HEAD = `fa13556`.
**Este es el estado válido**; lo de arriba se conserva como historia y queda superado en: 25→24
tablas y 59→56 políticas (`webhook_endpoints` cerrada), la decisión 4 y las deudas 1 y 6
(resueltas o reformuladas abajo). Todo en local, sin red.

## H1 — mover una fila fuera de la cuenta del cliente

- **Impedirlo**: `forbid_support_account_move()`, trigger BEFORE UPDATE en las 24 tablas abiertas.
  Si cambia `account_id` (o, en las hijas, la clave del padre y con ella la cuenta) y el operador
  tiene sesión abierta sobre la cuenta vieja **o** la nueva → `42501`. Un miembro sin sesión no
  cambia en nada; la salida es inmediata cuando la clave no cambia (todos los UPDATE de la app).
  Se eligió trigger y no `WITH CHECK (account_id = OLD.account_id)`: una política no ve OLD, y el
  trigger cubre también las tablas hijas con una sola pieza.
- **Registrarlo**: `record_support_write()` resuelve la cuenta de OLD y de NEW y escribe una fila
  por cada una con sesión abierta del operador **sobre esa cuenta**. Un DELETE se apunta por OLD.
- Check SQL, bloque 7: el UPDATE exacto del revisor falla con `insufficient_privilege` y la fila
  sigue en A; mover una `contact_tags` a un contacto del operador falla; meter en A un contacto
  del operador falla; ninguna sentencia rechazada deja rastro; el DELETE en A queda apuntado.

## H2 — dos sesiones abiertas

- Índice `uq_impersonation_log_one_open_session` (UNIQUE parcial `(actor_user_id) WHERE action =
  'impersonation' AND ended_at IS NULL`). La migración cierra antes como `superseded` las
  duplicadas que pudiera haber (se queda la más reciente de cada operador).
- `POST /api/platform/impersonate`: tras el barrido de caducadas y el cierre de la de la cookie,
  `supersedeOpenSupportSessions(actor)` cierra TODAS las abiertas del operador antes del INSERT;
  si falla, 500 y no hay sesión. Exención documentada en `tenant-isolation.test.ts` (filtra por el
  actor, no por cuenta: son las sesiones del operador).
- El trigger busca la sesión por la cuenta de la fila (H1b), así que aunque existieran dos filas
  abiertas la escritura se apunta a la sesión correcta.
- Check SQL, bloque 8: la segunda sesión da `unique_violation`; con el índice quitado a mano y dos
  sesiones (A antigua, B reciente), editar A deja la fila en la sesión de A y ninguna en la de B.

## Decisión del líder aplicada: `webhook_endpoints` cerrada

En la 072 (array `excluded`; una base con la 072 anterior vuelve a `is_account_member` y pierde los
triggers — probado aplicando la versión vieja y luego la nueva), en `SUPPORT_WRITABLE_TABLES` /
`SUPPORT_REFUSED_TABLES`, bloqueo de `/api/account/webhooks*` en el middleware y
`assertNotSupportSession` en las cinco rutas (crear, editar/borrar, rotar secreto, reintentar
entrega, probar). verify-schema: ≥56 políticas, excluida sin predicado. Check SQL: el INSERT del
operador en `webhook_endpoints` de A da `insufficient_privilege`.

## Menores

- `templates/submit`: la consulta previa falla cerrado (500, sin upsert). Test «fails closed when
  the lookup itself fails». Corregida la afirmación del informe sobre usuarios que cambiaron de
  cuenta (esa fila no les es visible por RLS: solo aplica a la sesión de soporte).
- Hueco del matcher (hallazgo 4): el matcher de páginas excluye rutas que acaban en
  `.svg|.png|…`; una mutación a `/api/…/<x>.png` llegaba sin etiqueta y sin fila `http`. Arreglado
  añadiendo `'/api/:path*'` al matcher (test «runs on every /api path, image-looking ones
  included»). `recordSupportAction` sigue dependiendo de la etiqueta porque en un Route Handler no
  hay API para leer el método desde `getCurrentAccount`; con el matcher todo `/api` pasa por el
  middleware, que es lo que hacía falta.
- `ACTION_LIMIT` global: una sesión sin acciones visibles con el listado truncado ya no dice «no
  se cambió nada» sino que sus cambios quedan fuera del listado (`Platform.support.olderActionsHidden`).
- `status` NULL en filas `http`: la ficha muestra «resultado desconocido»
  (`Platform.support.statusUnknown`). Sigue siendo deuda que el status final no se conozca.
- Filas sin `id`: el `path` usa la clave del padre (`db:<tabla>/<fk>=<valor>`).
- Deuda 1 de la primera ronda resuelta: `GET /api/automations` y `GET /api/flows` filtran por la
  cuenta efectiva (`getCurrentAccount()` + `.eq('account_id', …)`).

## Criterio ↔ test (segunda ronda)

| Criterio | Dónde |
|---|---|
| H1 rechazado y sin rastro fantasma; DELETE por OLD | `progress/checks_impersonation-write.sql` bloque 7 |
| H2 imposible en la base; atribución por cuenta | checks bloque 8 |
| Trigger BEFORE en cada tabla abierta; índice único; trigger AFTER mira OLD y busca por cuenta | `verify-schema.sql` bloque 072 (fallan al quitar el trigger o el índice: comprobado) |
| Tablas abiertas = tablas con los dos triggers = `SUPPORT_WRITABLE_TABLES` (24) | checks bloque 0 |
| Abrir sesión cierra todas las del operador antes del INSERT | `src/app/api/platform/impersonate/route.test.ts` › «closes every other open session of the operator before opening one (s9.5)» |
| Webhooks bloqueados | `src/middleware.test.ts` › «still refuses POST /api/account/webhooks…», «…DELETE /api/account/webhooks/w-1…»; `support-scope.test.ts` › «blocks …webhooks…»; `support-session-view.test.ts` › «refuses: every route on the block list says no by itself too» |
| Matcher cubre /api | `src/middleware.test.ts` › «runs on every /api path, image-looking ones included» |
| submit falla cerrado | `src/app/api/whatsapp/templates/submit/route.test.ts` › «fails closed when the lookup itself fails» |
| Truncado / resultado desconocido | `src/components/platform/impersonation-actions.test.tsx` › «does not claim "nothing changed"…», «says a request row does not know its outcome» |

## Merge (hallazgo 7)

Al integrar con s9.4/s9.8 quedarse con la versión de s9.5 de `impersonation-banner.tsx` y
`platform-shell.test.tsx` (usan `Impersonation.acting`; `viewing` ya no existe).

## Deuda que queda

Deudas 2, 3, 4, 5 (salvo el `path` sin id, resuelto), 7, 8 y 9 de la primera ronda siguen
vigentes. Nueva: si `supersedeOpenSupportSessions` no se puede ejecutar el operador no puede abrir
sesión (500) hasta que la base responda; es el comportamiento buscado (falla cerrado), no hay test
de ese camino de error.

## Compuerta (segunda ronda)

lint 0 errores (35 avisos preexistentes) · typecheck limpio · `TZ=UTC npm test` 225 archivos /
3064 tests · build con variables dummy salida 0 · `replay-migrations.sh` salida 0,
`verify-schema.sql: OK` · 072 aplicada dos veces más (y sobre la 072 anterior): idempotente ·
checks SQL con `KEEP=1`: `checks_impersonation-write: OK`.
