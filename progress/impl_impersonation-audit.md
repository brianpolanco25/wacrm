# f4.4 — `impersonation-audit`

Base de `docs/saas/fase-4-plataforma.md` §2 «Panel de plataforma»: modelo de
administrador de plataforma, guarda de sus rutas e impersonación con bitácora.
El listado/ficha de cuentas y suspender/reactivar **no** entran aquí (f4.3/f4.1).

## Rama y commits

- Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4`, base `9680b68`.
- Commit: `3c99804` — «feat: añadir operador de plataforma e impersonación auditada».
- Commit: `e45cbf9` — «fix: hacer real y de solo lectura la sesión de soporte»
  (segunda ronda; cierra los seis cambios requeridos por el revisor y los
  hallazgos 7, 8, 9 y 10). **Lo que cuenta como estado actual está en la
  sección «Segunda ronda» del final de este informe**; lo de arriba se
  conserva como historia y algunas de sus afirmaciones quedaron superadas
  (en particular la decisión 3 y las deudas 1 y 2).

## Qué se construyó

| Archivo | Qué es |
|---|---|
| `supabase/migrations/055_platform_admins.sql` | `platform_admins`, `impersonation_log`, `is_platform_admin(uuid)`, RLS de solo lectura |
| `supabase/ci/verify-schema.sql` | 10 aserciones nuevas para 055 |
| `src/lib/auth/admin-client.ts` | cliente de rol de servicio para trabajo de plataforma |
| `src/lib/auth/platform-admins.ts` | `findPlatformAdmin` / `isPlatformAdmin` |
| `src/lib/auth/platform.ts` | **`requirePlatformAdmin()`** — la guarda |
| `src/lib/auth/support-cookie.ts` | nombre y TTL de la cookie, sin imports (lo lee el middleware, que corre en Edge) |
| `src/lib/auth/impersonation.ts` | firma/verificación HMAC, cookie, `resolveSupportSession` |
| `src/lib/auth/impersonation-log.ts` | cerrar la fila de bitácora, leer la sesión en curso |
| `src/lib/auth/support-view.ts` | lo que necesita el aviso de la interfaz |
| `src/lib/auth/account.ts` | `getCurrentAccount()` resuelve la cuenta impersonada; `requireRole` la rechaza para escrituras |
| `src/app/api/platform/impersonate/route.ts` | `GET` estado, `POST` inicio |
| `src/app/api/platform/impersonate/stop/route.ts` | `POST` fin |
| `src/middleware.ts` | bloqueo global de escrituras mientras hay sesión de soporte |
| `src/components/layout/impersonation-banner.tsx` | aviso persistente + botón de salida |
| `src/app/(dashboard)/layout.tsx`, `dashboard-shell.tsx` | montan el aviso encima de la cabecera |
| `messages/en.json`, `messages/ko.json` | clave `Impersonation` (3 cadenas, misma clave en los dos) |

## Decisiones donde el spec dejaba el cómo abierto

**1. Mecanismo de la sesión de soporte: cookie firmada, no fila con token ni
cambio de `profiles`.** El spec prohíbe mover `profiles.account_id` del actor y
deja el resto abierto. Se eligió una cookie `httpOnly` firmada con HMAC-SHA256
bajo una clave **derivada** de `ENCRYPTION_KEY`
(`HMAC(ENCRYPTION_KEY, "wacrm:support-session:v1")`, separación de dominio para
que una cookie no pueda usarse como oráculo del cifrado en reposo). Caduca a los
30 minutos y el `maxAge` de la cookie coincide, así que cerrar el navegador sin
pulsar «salir» no deja la sesión abierta indefinidamente. **Sin variable de
entorno nueva.**

La cookie por sí sola no concede nada: `resolveSupportSession()` vuelve a
comprobar en **cada** petición (1) la firma, en tiempo constante; (2) que no ha
caducado; (3) que el actor firmado **es** el usuario autenticado de esta sesión
de Supabase — una cookie copiada a otro navegador no vale; (4) que ese usuario
**sigue** en `platform_admins` — revocar a un operador termina sus sesiones
abiertas en la petición siguiente, sin perseguir cookies. Falla cerrado en todos
los casos.

**2. Rol efectivo `viewer`, y además bloqueo de escrituras en el middleware.**
El spec propone `viewer` salvo justificación; se mantiene. Pero `viewer` solo
detiene las rutas que preguntan `requireRole('agent')` o más. Una ruta que no
consulte el rol y escriba con el cliente de sesión **del operador** guardaría el
cambio en la empresa del operador mientras él cree estar mirando la del cliente
— el fallo exacto que hace peligrosa la impersonación. Por eso el middleware
rechaza con 403 **cualquier** petición mutante (POST/PUT/PATCH/DELETE, también a
rutas de página, que es por donde van las server actions) mientras la cookie
está presente. Exentos y comprobados con test: `/api/platform/*` (el botón de
salida vive ahí: bloquearlo encerraría al operador), `/api/whatsapp/webhook`
(**CP11**), `/api/v1/*` y los dos cron. El middleware **no** verifica la firma:
eso metería `node:crypto` en el bundle de Edge, y lo peor que consigue una
cookie falsificada es dejar a su propio portador en solo lectura.

**3. `ctx.supabase` sigue siendo el cliente de sesión del operador, no uno de
rol de servicio.** Es la decisión con consecuencia visible, así que va explícita:
entregar a rutas arbitrarias de la aplicación un cliente que salta la RLS solo
porque hay una cookie sería un agujero mayor que el que abre esta feature. El
efecto es que una ruta que lee por `ctx.supabase` (RLS) ve la vista del operador
— vacía de datos del cliente — mientras que una que lee por rol de servicio
filtrando por `ctx.accountId` (el patrón CP3 que este repo ya impone en todas
partes) ve la cuenta impersonada. La vista de soporte del panel (f4.3) se
construye sobre lo segundo. **Deuda anotada abajo.**

**4. Semántica de borrado.** `impersonation_log` **no tiene ninguna clave
foránea**, ni a `accounts` ni a `auth.users` — mismo criterio que
`billing_events` (041). Una bitácora que desaparece cuando se borra la cuenta
auditada no audita nada, justo en el caso en que alguien querría consultarla; y
`RESTRICT` convertiría «este cliente se dio de baja» en «no se puede dar de baja
a este cliente porque le dimos soporte una vez». Por eso guarda además
`account_name` como instantánea: un uuid huérfano no se lee seis meses después.
`platform_admins.user_id` sí va con `ON DELETE CASCADE`: es una **concesión** de
permiso, no un histórico, y dejar la fila colgando haría que un uuid reutilizado
heredase el permiso. No es dato de cliente, así que no choca con CP2.
`granted_by` va con `ON DELETE SET NULL`.

**5. Motivo obligatorio, mínimo 10 caracteres**, comprobado en la ruta (400) y en
la base (`CHECK (char_length(btrim(reason)) >= 10)`). La constante TS
`MIN_REASON_LENGTH` tiene un test que la ata al valor de la migración: si se
separan, un motivo que la API acepta revienta como 500 en el insert.

**6. La bitácora se escribe ANTES de entregar la cookie.** Si el insert falla no
hay sesión (500): una impersonación sin registrar es el único desenlace que esta
feature existe para impedir. Al reabrir sesión estando una abierta, la anterior
se cierra como `superseded`, así que la bitácora nunca muestra dos sesiones
solapadas del mismo operador.

## Criterio ↔ test

| Criterio (spec §2 / encargo) | Archivo | `it(...)` |
|---|---|---|
| Rutas de plataforma inaccesibles para quien no esté en `platform_admins` | `src/lib/auth/platform.test.ts` | «rejects an authenticated user with no platform_admins row with 403» |
| …incluido un `owner` normal | `src/lib/auth/platform.test.ts` | «rejects a company owner — owning a company is not operating the platform» |
| …en toda ruta nueva (GET, POST, stop) | `src/app/api/platform/impersonate/route.test.ts` | «403s a company owner who is not in platform_admins, on every verb» |
| …y sin filtrar nada de la cuenta ajena | idem | «leaks nothing about the target account in the 403 body» |
| Un `owner` normal no lista cuentas ajenas por ninguna ruta nueva | `src/lib/security/tenant-isolation.test.ts` | «403s the owner of account A, who is not in platform_admins» |
| Guarda falla cerrado si la base no responde | `src/lib/auth/platform.test.ts` | «fails closed when the lookup errors» |
| Sin motivo → 400 | `.../impersonate/route.test.ts` | «refuses without a reason» |
| Motivo trivial → 400 | idem | «refuses a reason too short to mean anything» |
| No admin → 403 | idem | «403s a company owner…», «writes nothing to the bitácora for a refused caller» |
| Toda impersonación registrada con actor, cuenta, momento y motivo | idem | «records actor, account, moment and reason, and only then hands out the cookie» |
| Fin registrado | idem | «closes the row as a manual exit and clears the cookie» |
| Caducidad registrada | idem | «closes the bitácora row and drops the cookie once the session has expired» |
| Sin bitácora no hay sesión | idem | «opens no session at all when the bitácora insert fails» |
| Cuenta inexistente → 404 sin sesión | idem | «404s an account that does not exist, without opening a session» |
| `getCurrentAccount()` resuelve la cuenta impersonada | `src/lib/auth/account-impersonation.test.ts` | «resolves the impersonated account, with the impersonated name» |
| …con rol efectivo `viewer` | idem | «downgrades the effective role to viewer, whatever the operator really is» |
| …solo con sesión válida y actor platform admin | `src/lib/auth/impersonation.test.ts` | «refuses once the actor is no longer a platform admin», «refuses a cookie copied into another user's browser» |
| …sin tocar nunca `profiles` del actor | `account-impersonation.test.ts` | «never reads or writes the operator's own profile» |
| Lecturas de la cuenta objetivo funcionan | `.../impersonate/route.test.ts`; `tenant-isolation.test.ts` | «reports the open session with the account it is looking at»; «resolves the account context to the impersonated company, read-only» |
| Escrituras rechazadas | `account-impersonation.test.ts`; `tenant-isolation.test.ts` | «refuses every write-level guard (%s)»; «resolves the account context to the impersonated company, read-only» |
| …y en toda ruta, consulte o no el rol | `src/middleware.test.ts` | «refuses a mutating API request…», «refuses %s, not just POST», «refuses a mutating page request too, not only /api» |
| Al expirar, vuelve a la cuenta propia | `account-impersonation.test.ts` | «goes back to the operator's own account and role once the session is gone» |
| Cookie caducada/forjada/truncada no concede nada | `impersonation.test.ts` | 8 casos bajo «signSupportSession / verifySupportSession» |
| Ninguna acción del actor toca su cuenta original | `tenant-isolation.test.ts` | «moves nothing of either seeded company…», «records the session under the impersonated account, never the actor's own», «resolves the account context…» |
| Toda consulta de rol de servicio filtra por cuenta (CP3) | `tenant-isolation.test.ts` | auditoría del `afterEach` global + «scopes every service-role query by the account it is about» y «scopes the closing update by the row id AND its account» |
| CP11: el webhook nunca se bloquea | `src/middleware.test.ts` | «NEVER blocks the WhatsApp webhook» |
| Aviso visible y persistente, con salida, en en/ko (CP6) | `src/components/layout/impersonation-banner.test.tsx` | 5 casos, incluido «is translated, not English-with-a-Korean-shell (CP6)» |

Rutas nuevas añadidas a `src/lib/security/tenant-isolation.test.ts` (imports,
tablas `platform_admins` / `impersonation_log` en la semilla, un `describe`
`/api/platform` con 7 casos y una exención con motivo escrito para el `select`
de `platform_admins`, que no es dato de inquilino y se consulta siempre por el
uid autenticado del propio llamante).

## Verificación contra base real

`progress/checks_impersonation-audit.sql`, sobre el Postgres de
`scripts/replay-migrations.sh` (`KEEP=1`, `psql … < checks_…sql`). Salida:
`NOTICE: checks_impersonation-audit: OK`. Comprueba, en una transacción que
termina en `ROLLBACK`:

1. `is_platform_admin` distingue operador / `owner` normal / uuid inexistente.
2. El `CHECK` del motivo rechaza en blanco y de dos caracteres.
3. Un `owner` normal **no lee** `platform_admins` ni `impersonation_log`.
4. El dueño de la cuenta impersonada tampoco lee la bitácora.
5. Un `owner` normal **no puede insertarse** en `platform_admins`
   (`insufficient_privilege`).
6. El operador **sí lee** las dos tablas, y **no puede** reescribir ni borrar la
   bitácora (0 filas afectadas: sin política de UPDATE/DELETE la RLS no lanza
   error, simplemente no afecta a nada).
7. La bitácora **sobrevive** al borrado de la cuenta auditada y del usuario
   auditor; el permiso de operador **no** sobrevive al borrado de su usuario.

`scripts/replay-migrations.sh .claude/worktrees/fase-4` desde limpio: salida 0,
`verify-schema.sql: OK`.

## Alta del primer administrador de plataforma (SQL manual)

No hay semilla: sembrar un correo o un uuid en una migración sería meter una
puerta trasera en el repositorio. El primer operador se da de alta a mano contra
la base, con el rol de servicio o desde el editor SQL de Supabase:

```sql
-- Sustituye el correo. Idempotente.
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT u.id, u.id, 'bootstrap del operador'
FROM auth.users u
WHERE u.email = 'operador@ejemplo.com'
ON CONFLICT (user_id) DO NOTHING;

-- Comprobación:
SELECT pa.user_id, u.email, pa.granted_at, pa.note
FROM platform_admins pa JOIN auth.users u ON u.id = pa.user_id;
```

Los siguientes, concedidos por uno ya existente:

```sql
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT nuevo.id, actual.id, 'soporte de guardia'
FROM auth.users nuevo, auth.users actual
WHERE nuevo.email = 'soporte@ejemplo.com'
  AND actual.email = 'operador@ejemplo.com'
ON CONFLICT (user_id) DO NOTHING;
```

Revocar:

```sql
DELETE FROM platform_admins WHERE user_id = (
  SELECT id FROM auth.users WHERE email = 'soporte@ejemplo.com'
);
```

Revocar termina también las sesiones de soporte que esa persona tuviera abiertas:
`resolveSupportSession` vuelve a consultar `platform_admins` en cada petición.

## Verificación manual (navegador)

No depende de ningún servicio externo, pero cubre lo que ningún test de vitest
ve: la cookie real, el aviso pintado y el recorrido completo.

1. Con la aplicación corriendo, da de alta tu usuario como operador con el SQL
   de arriba y anota el `id` de una cuenta ajena:
   `SELECT id, name FROM accounts;`.
2. Inicia sesión con tu usuario y abre la consola del navegador. Lanza:
   ```js
   await fetch('/api/platform/impersonate', {
     method: 'POST',
     headers: { 'content-type': 'application/json' },
     body: JSON.stringify({ account_id: '<uuid de la cuenta>', reason: 'ticket 1234: prueba manual de impersonación' })
   }).then(r => r.json())
   ```
   Esperado: `{ session: { account_id, account_name, expires_at } }`.
3. Recarga `/dashboard`. **Esperado:** franja ámbar encima de la cabecera, con
   «You are viewing \<nombre\> as support. Nothing you do here is saved.» y el
   botón «Exit support session». Cambia de página (Inbox, Contactos): la franja
   sigue ahí y no se va con el scroll. Cambia el idioma a coreano: el texto está
   traducido.
4. Intenta guardar cualquier cosa (crear una respuesta rápida, editar ajustes).
   **Esperado:** 403 con «A support session is read-only…». Comprueba en la base
   que no se creó nada ni en la cuenta objetivo ni en la tuya.
5. Envía un mensaje entrante de prueba al webhook (o espera uno real).
   **Esperado (CP11):** se guarda igual; la sesión de soporte no lo toca.
6. Pulsa «Exit support session». **Esperado:** recarga, la franja desaparece y
   vuelves a tu cuenta. En la base:
   ```sql
   SELECT actor_user_id, account_id, account_name, reason,
          started_at, ended_at, ended_reason
   FROM impersonation_log ORDER BY started_at DESC LIMIT 5;
   ```
   una fila con tu uuid, la cuenta objetivo, el motivo del paso 2 y
   `ended_reason = 'manual'`.
7. Caducidad: repite el paso 2, espera 30 minutos (o adelanta el reloj del
   servidor) y recarga. **Esperado:** la franja desaparece sola, vuelves a tu
   cuenta y la fila queda con `ended_reason = 'expired'` la próxima vez que
   llames a `GET /api/platform/impersonate`.
8. Con un usuario **sin** fila en `platform_admins`, repite el paso 2.
   **Esperado:** 403 y ninguna fila nueva en `impersonation_log`.

## Variables de entorno

**Ninguna nueva.** La cookie se firma con una clave derivada de `ENCRYPTION_KEY`
y la escritura de la bitácora usa `SUPABASE_SERVICE_ROLE_KEY`; ambas ya están
documentadas en `docs/docker.md`. `.env.local.example` no se tocó (bloqueado por
permisos) y tampoco hacía falta.

## Deuda detectada, fuera de alcance — NO arreglada

1. **La vista de soporte todavía no lee datos del cliente por RLS.** Como se
   explica en la decisión 3, durante una sesión de soporte `ctx.supabase` sigue
   siendo el cliente del operador, así que las rutas que leen por RLS
   (`/api/quick-replies` GET, `/api/automations` GET, `/api/flows` GET…) devuelven
   la vista del operador, no la de la cuenta impersonada. Lo que sí funciona es
   todo lo que lee por rol de servicio filtrando por `ctx.accountId`. Cerrar el
   hueco exige una decisión de diseño que no es de esta feature: o ampliar la RLS
   para administradores de plataforma (radio de impacto enorme: `is_account_member`
   la usan todas las políticas del esquema), o servir la vista de soporte desde
   rutas `/api/platform/*` propias. **Es trabajo de f4.3**, que es quien construye
   la vista, y debería decidirlo con su propia revisión.
2. **Filas de bitácora que quedan abiertas.** Si un operador nunca vuelve, su fila
   se queda con `ended_at` nulo hasta que él mismo llame a
   `GET /api/platform/impersonate` o abra otra sesión. `expires_at` está en la
   fila, así que la ventana real es auditable de todas formas; un barrido
   programado (`UPDATE … SET ended_reason='expired' WHERE ended_at IS NULL AND
   expires_at < now()`) sería más limpio y encaja en el cron de f4.3.
3. **Cookie tossing.** Cualquiera que consiga escribir la cookie
   `wacrm_support_session` en el navegador de otra persona la deja en solo lectura
   hasta 30 minutos (el middleware bloquea por presencia, no por firma). No da
   acceso a nada; es una molestia, no una fuga, y arreglarlo exigiría criptografía
   en el runtime Edge.
4. **`account_role_enum` en `verify-schema.sql`.** La aserción nueva falla si el
   enum crece con cualquier valor, no solo con uno que parezca de plataforma. Es
   deliberadamente estricta (el spec prohíbe mezclar los dos planos «bajo ningún
   concepto»), pero quien añada legítimamente un rol de empresa tendrá que
   actualizar esa lista a mano.
5. **`src/middleware.ts` arrastra un warning de lint preexistente**
   (`'options' is defined but never used`, línea 68). No se tocó.

## Compuerta

- `npm run lint` — 0 errores, 37 avisos (todos preexistentes).
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — 104 archivos, 1250 tests, todos en verde.
- `npm run build` con las variables dummy de CI — OK; en la salida aparecen
  `ƒ /api/platform/impersonate` y `ƒ /api/platform/impersonate/stop`.
- `scripts/replay-migrations.sh .claude/worktrees/fase-4` desde limpio — salida 0,
  `verify-schema.sql: OK`.
- `npx prettier --write` sobre los archivos nuevos. Los ya existentes
  (`account.ts`, `middleware.ts`, `middleware.test.ts`, `dashboard-shell.tsx`,
  `layout.tsx`) **no** se pasaron por prettier a propósito: no estaban formateados
  con la configuración del repo (comillas dobles) y hacerlo habría metido 130
  líneas de churn ajeno al cambio (CP8). Las líneas añadidas siguen el estilo del
  archivo que las rodea.

---

# Segunda ronda — commit `e45cbf9`

Cierra los diez «cambios requeridos» de `progress/review_impersonation-audit.md`
con las decisiones que fijó el líder. Este es el estado válido de la feature.

## El fondo, en una frase

La primera ronda defendió la sesión de soporte en el servidor, y en este panel
el servidor no es por donde pasa la mayor parte del tráfico: contactos, bandeja,
etiquetas, ajustes y pipelines hablan con Supabase **desde el navegador** con el
JWT del operador. Ni el middleware ni el rol efectivo ven esas peticiones. Por
eso el operador veía sus propios datos con el cartel del cliente (hallazgo 2) y
podía escribir en ellos (hallazgo 1). La capa que sí las ve es la RLS, y ahí es
donde está ahora el permiso.

## Qué se construyó (además de lo de la primera ronda)

| Archivo | Qué es |
|---|---|
| `supabase/migrations/057_support_session_reads.sql` | `has_open_support_session()`, `can_read_account()` y la reescritura de las 36 políticas de SELECT |
| `supabase/ci/verify-schema.sql` | 7 aserciones nuevas de 057 + arreglo de la tautológica de 055 |
| `src/lib/auth/support-session-store.ts` | `isSupportSessionOpen()` (revocación) y `sweepExpiredSupportSessions()` (barrido) |
| `src/lib/supabase/client.ts` | `guardReadOnly()`, `supportSessionActive()`, `endSupportSession()` |
| `src/lib/auth/support-cookie.ts` | `SUPPORT_ACTIVE_COOKIE` (bandera legible por JS) y `supportCookieActor()` (lectura sin verificar, solo para el middleware) |
| `src/lib/auth/support-view.ts` | banner de respaldo cuando la cuenta impersonada no se puede leer + `unstable_rethrow` |
| `src/middleware.ts` | cookie huérfana se borra en vez de bloquear; `Cache-Control: private, no-store` con sesión |
| `src/hooks/use-auth.tsx` | `signOut()` termina la sesión de soporte antes de la de Supabase |
| `docs/security.md` | «Platform operators and support sessions»: alta del primer operador, revocación, qué concede una sesión, cómo auditarla |
| tests nuevos | `src/lib/supabase/client.test.ts`, `src/lib/auth/support-session-store.test.ts`, `src/lib/auth/support-view.test.ts` |

## 1 y 2 — la lectura viene de la RLS; las escrituras del navegador, bloqueadas

**Migración 057.** `has_open_support_session(target_account_id)` es STABLE,
SECURITY DEFINER y exige cuatro cosas: fila de `impersonation_log` con
`actor_user_id = auth.uid()`, `account_id = target`, `ended_at IS NULL` y
`expires_at > now()`, **más** que el actor siga en `platform_admins` (revocar
corta la lectura en la consulta siguiente). `expires_at` ya existía en 055, así
que no hizo falta añadirla. Índice parcial nuevo
`idx_impersonation_log_open_actor_account (actor_user_id, account_id) WHERE
ended_at IS NULL`.

`can_read_account(acc, min_role)` = `is_account_member(acc, min_role) OR
has_open_support_session(acc)`, con la **misma firma** que `is_account_member`
para que la reescritura de políticas sea una sustitución de nombre y nada más.

La reescritura la hace un bloque `DO` que recorre `pg_policies` filtrando
`schemaname = 'public' AND cmd = 'SELECT' AND qual LIKE '%is_account_member(%'`,
sustituye el texto del `qual` y recrea la política conservando roles y
permisividad. **36 políticas** (el `NOTICE` lo dice al aplicar):

`account_invitations_select` (admin), `ai_usage_log_select` (admin),
`usage_counters_select` (admin), `accounts_select` (por `id`), `profiles_select`
(conserva `auth.uid() = user_id`), `ai_configs_select`,
`ai_knowledge_chunks_select`, `ai_knowledge_documents_select`, `api_keys_select`,
`automation_logs_select`, `automations_select`, `broadcasts_select`,
`contact_notes_select`, `contacts_select`, `conversations_select`,
`custom_fields_select`, `deals_select`, `flow_runs_select`, `flows_select`,
`member_presence_select`, `message_templates_select`, `pipelines_select`,
`quick_replies_select`, `subscriptions_select`, `tags_select`,
`webhook_endpoints_select`, `whatsapp_config_select`; y las nueve que llegan a la
cuenta por su tabla padre: `automation_steps_select` (→ `automations`),
`broadcast_recipients_select` (→ `broadcasts`), `contact_custom_values_select`
(→ `contacts`), `contact_tags_select` (→ `contacts`), `flow_nodes_select`
(→ `flows`), `flow_run_events_select` (→ `flow_runs`), `message_reactions_select`
(→ `messages`/`conversations`), `messages_select` (→ `conversations`),
`pipeline_stages_select` (→ `pipelines`).

**Ninguna** política de INSERT/UPDATE/DELETE/ALL se tocó: las 64 que llaman a
`is_account_member` siguen llamándolo.

**Fuera del alcance, a propósito:** las dos políticas de `storage.objects` (044).
Los adjuntos se sirven con URLs firmadas que genera el servidor con el rol de
servicio, ya acotadas por cuenta, así que la lectura directa del bucket no es la
vía por la que el panel pinta media; y mantiene 057 dentro de `public` sin tocar
políticas de un esquema que administra Supabase. Consecuencia visible: durante
una sesión de soporte, el media legado que se resolviera por lectura directa del
bucket no se vería. Anotado como deuda.

**Bloqueo de escrituras del navegador.** `setSupportCookie` escribe ahora dos
cookies: la firmada `httpOnly` de siempre y una bandera `wacrm_support_active=1`
legible por JS, con el mismo `maxAge`; `clearSupportCookie` borra las dos.
`@/lib/supabase/client` envuelve el cliente en un `Proxy`: con la bandera
presente, `from().insert/update/upsert/delete` devuelven un constructor encadenable
que resuelve a `{ data: null, error: { code: 'support_session_read_only' } }`
—no lanza, porque todas las llamadas del repo hacen `const { error } = await …`—
y `rpc()` se rechaza en bloque (casi todas las funciones del esquema son
SECURITY DEFINER; una «de lectura» respondería por la cuenta del operador, que es
la vista mal etiquetada otra vez). `auth`, `channel` y `storage` pasan intactos.

Es una barandilla, no una frontera: quien pueda borrar esa cookie en su propio
navegador recupera la escritura **sobre su propia cuenta**, que ya podía tener
saliendo de la sesión. La frontera para los datos del cliente es la RLS.

## 3 — revocación

`resolveSupportSession` añade una quinta comprobación: `isSupportSessionOpen()`
lee la fila por `id` + `account_id` + `actor_user_id` + `ended_at IS NULL` (todo
sale de la cookie firmada, nada del cuerpo de la petición) y comprueba el
`expires_at` **de la fila**. Falla cerrado ante error de base. Es una consulta
más solo en la vía rara (hay cookie de soporte). La misma condición está en el
predicado de la RLS, así que «salir» corta las dos vías a la vez.

## 4, 5 y 6

- **Cookie huérfana (hallazgo 4).** El middleware lee el actor del payload
  **sin verificar la firma** (`supportCookieActor`, Edge no tiene `node:crypto`).
  Si no coincide con el usuario autenticado —o no hay usuario— la cookie no es
  de nadie: no bloquea y se borra en esa misma respuesta, las dos. Confiar en una
  afirmación sin verificar sería un error si **concediera** algo; aquí solo quita
  un bloqueo a quien no era su dueño. Al operador que sí nombra le sigue
  bloqueando (test).
- **`signOut()` (hallazgo 4).** Llama a `endSupportSession()` antes de
  `supabase.auth.signOut()`: si hay bandera, `POST /api/platform/impersonate/stop`.
  Cierra la fila (la salida más común) y borra la cookie `httpOnly`, que JS no
  podría borrar. Nunca bloquea el cierre de sesión.
- **Firma y cookie dentro del `try/catch` (hallazgo 5).** Si `signSupportSession`
  o `setSupportCookie` lanzan, se cierra la fila con `expired` y se responde 500.
  Antes quedaba una fila abierta para siempre que nadie podría cerrar.
- **Barrido (hallazgo 6).** `sweepExpiredSupportSessions()` cierra **todas** las
  filas con `ended_at IS NULL AND expires_at < now()`, en los tres momentos en que
  un operador toca el panel: `GET` y `POST /api/platform/impersonate` y
  `POST …/stop`. **Por qué ahí y no en un cron:** las filas solo aparecen porque
  un operador abrió una; la consulta es un índice parcial; y un cron nuevo
  significaría un secreto compartido y una ruta sin autenticar más que defender.
  Límite honesto, escrito: si ningún operador vuelve a abrir el panel, la última
  fila rancia se queda abierta — y `expires_at` está en la fila igualmente, así
  que la ventana real es auditable aunque `ended_at` sea nulo.

## 7, 8, 9 y 10 (los que el revisor pedía y el líder no listó)

- **Cabecera de caché (7): confirmada la fuga y cerrada.** Contra un build de
  producción (`next start`), `/join/abc` —ruta **ƒ dinámica**— devuelve
  `Cache-Control: public, max-age=0, s-maxage=300, stale-while-revalidate=86400`:
  la de `next.config.ts` gana sobre la que Next pone a una página dinámica. Con
  la cookie de soporte presente el middleware fuerza `private, no-store`, y se
  comprobó con `curl` sobre el mismo build que esa sí gana. Test en
  `middleware.test.ts`. **Deuda mayor que destapa esto, fuera de alcance:** esa
  regla de `next.config.ts` marca como cacheable por caché compartida **todo** el
  panel autenticado, no solo la sesión de soporte.
- **`unstable_rethrow` (8)** en `readSupportCookie` y en `supportBanner`
  (`next/navigation`, documentado en
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/unstable_rethrow.md`).
- **Hallazgo 9** (cuenta impersonada borrada a media sesión): `supportBanner`
  ya no devuelve `null`. Si el contexto falla pero hay sesión en vigor, pinta la
  franja con `accountName: null` y el componente usa la clave nueva
  `Impersonation.unknownAccount` (en/ko). El aviso y la salida son el mismo
  control: tiene que sobrevivir al fallo del que avisa.
- **Aserción tautológica (10)**: ahora exige `char_length` **y** `btrim` **y**
  `reason` en la definición del CHECK. Comprobado que falla al quitar la
  restricción (abajo).
- **CP9**: el alta del primer operador, la revocación y la auditoría están en
  `docs/security.md` § «Platform operators and support sessions», no solo en
  `progress/`.

## Criterio ↔ test (segunda ronda)

| Criterio | Archivo | `it(...)` |
|---|---|---|
| El cliente de navegador rechaza un `delete()` durante la sesión | `src/lib/supabase/client.test.ts` | «refuses a delete — the exact call contacts/page.tsx makes» |
| …y `insert/update/upsert/delete` encadenados | idem | «refuses %s, and keeps the chain refusing» |
| …y `rpc` | idem | «refuses rpc wholesale» |
| …sin tocar las lecturas ni `auth` | idem | «leaves reads alone…», «still lets auth through…» |
| …y sin cambiar nada fuera de la sesión | idem | «writes exactly as before» |
| La bandera es la del servidor y solo esa | idem | «is true only for the flag the server sets», «is not fooled by a cookie whose name merely ends the same way» |
| `signOut()` termina la sesión de soporte | idem | «asks the server to stop the session before signing out», «does nothing at all when there is no session», «never blocks the sign-out when the network is gone» |
| Cookie repuesta tras `stop` no concede nada | `src/lib/auth/impersonation.test.ts` | «refuses a cookie put back after stop — the closed row revokes it» |
| …y se pregunta por la fila que nombra la cookie | idem | «asks about the row named by the cookie, not one from a request» |
| …sin consulta extra en la vía barata | idem | «does not query the bitácora for a cookie that already failed» |
| Revocación: fila cerrada / caducada / de otro actor o cuenta | `src/lib/auth/support-session-store.test.ts` | «says no once the row is closed…», «says no past the ROW's own deadline…», «says no for a row belonging to another actor or another account» |
| CP3 en la comprobación de la fila | idem | «scopes the lookup by account, actor AND row id (CP3)» |
| Falla cerrado | idem | «fails closed when the database errors» |
| Barrido de filas caducadas | idem | «closes the rows nobody came back to close», «leaves a live session and an already-closed row alone», «filters on the deadline and on being open, and nothing else», «reports zero and does not throw when the sweep fails» |
| …en la ruta | `src/app/api/platform/impersonate/route.test.ts` | «closes rows nobody came back for, on the paths an operator uses», «leaves a session that is still running alone» |
| Cookie huérfana no encierra a nadie | `src/middleware.test.ts` | «does not strand a different user who inherited the cookie», «drops the orphan cookies on that same response, both of them», «drops them for a signed-out browser too», «drops a cookie whose payload is not even readable» |
| …pero sigue bloqueando a su dueño | idem | «keeps blocking the operator the cookie actually names» |
| Nada de caché compartida con sesión | idem | «forbids shared caching of any page carrying the customer's name», «leaves the cache header alone when nobody is impersonating» |
| Fila cerrada si la cookie no se puede emitir | `.../impersonate/route.test.ts` | «closes the bitácora row when the cookie cannot be issued» |
| La bandera se pone y se quita con la sesión | idem | «tells the browser bundle there is a session, in a cookie it can read» |
| Franja con la cuenta ilegible, con salida, en en/ko | `src/components/layout/impersonation-banner.test.tsx` | «still renders, with the way out, when the account cannot be named», «names the missing account in Korean too (CP6)» |
| `supportBanner` no cuesta nada sin cookie y no inventa sesiones | `src/lib/auth/support-view.test.ts` | «costs nothing when there is no support cookie», «does not invent a banner for a failure that is not a session», «never throws, even when the fallback cannot find a user» |
| CP3: el barrido es cross-account con waiver escrito | `src/lib/security/tenant-isolation.test.ts` | waiver `impersonation_log/update` en `GLOBAL_WAIVERS` + auditoría del `afterEach` |

## Verificación contra base real

`scripts/replay-migrations.sh` desde limpio (040–044, 047, 051, 055, **057**):
salida 0, `verify-schema.sql: OK`. Re-aplicar 057 sobre la misma base:
`057: 0 políticas de SELECT ampliadas` y el verify sigue pasando — idempotente.

`progress/checks_impersonation-audit.sql` ampliado con el **bloque 6**, que es lo
único que comprueba la vía del navegador. Salida `NOTICE:
checks_impersonation-audit: OK`. Comprueba, como rol `authenticated` con
`request.jwt.claim.sub` puesto a mano:

1. **Con sesión abierta**: el operador LEE el contacto de la cuenta objetivo y
   LEE la cuenta (el nombre del cartel), y **no puede** hacer `UPDATE`, `DELETE`
   ni `INSERT` sobre los contactos del cliente (0 filas afectadas / privilegio
   insuficiente).
2. **Tras cerrar la fila** (`ended_at`): 0 filas visibles.
3. **Con la fila reabierta pero caducada**: 0 filas visibles.
4. **Con el operador revocado** de `platform_admins`: 0 filas visibles.
5. Un `owner` ajeno: 0 filas visibles, con o sin bitácora.
6. Ninguna política de escritura lleva el predicado nuevo.

Las tres aserciones nuevas de `verify-schema.sql` se probaron **fallando** a
propósito contra el contenedor: una tabla temporal con política de UPDATE que usa
`can_read_account` («a write policy … carries the support-session predicate»), la
misma con política de SELECT que usa `is_account_member` («a SELECT policy still
calls is_account_member() directly») y `impersonation_log` sin su CHECK del motivo
(«reason has no minimum-length CHECK»). Las tres levantaron la excepción; al
deshacerlo, `schema verification passed`.

## Verificación manual (navegador) — añadidos a la lista de la primera ronda

Los pasos 1–8 de arriba siguen valiendo. Cuatro más, todos sin servicio externo:

9. **La vista es la del cliente.** Con la sesión abierta, abre Contactos y la
   bandeja. **Esperado:** los contactos y conversaciones de la empresa objetivo,
   no los tuyos. Compáralo con `SELECT count(*) FROM contacts WHERE account_id =
   '<objetivo>';` contra la base.
10. **No se puede escribir, ni ahí ni en tu cuenta.** Selecciona contactos y pulsa
    borrar. **Esperado:** un error de solo lectura y **cero** filas borradas en las
    dos cuentas (`SELECT count(*) FROM contacts WHERE account_id IN (…);` antes y
    después). Prueba también crear una etiqueta desde Ajustes.
11. **Salir revoca de verdad.** Antes de pulsar «salir», copia el valor de
    `wacrm_support_session` de la pestaña Application de devtools. Pulsa salir,
    vuelve a escribir la cookie a mano y recarga. **Esperado:** ninguna franja,
    tu propia cuenta, y `GET /api/platform/impersonate` devuelve
    `{ session: null }`.
12. **Cerrar sesión no deja a nadie encerrado.** Con la sesión de soporte abierta,
    pulsa «cerrar sesión»; entra con otro usuario en el mismo navegador.
    **Esperado:** puede guardar sin 403, no hay cookie `wacrm_support_session` en
    devtools, y la fila de la bitácora quedó con `ended_reason = 'manual'`.

## Variables de entorno

**Ninguna nueva**, otra vez. `.env.local.example` no se tocó (bloqueado por
permisos) y no hacía falta; `docs/docker.md` tampoco cambia.

## Deuda detectada, fuera de alcance — NO arreglada

1. **`next.config.ts` marca todo el panel autenticado como cacheable por caché
   compartida** (`public, s-maxage=300, stale-while-revalidate=86400` en todo lo
   que no sea `/api`), y esa cabecera gana sobre la de Next para páginas
   dinámicas — comprobado con `curl` contra un build de producción. Esta feature
   solo cierra el caso de la sesión de soporte. El caso general (el HTML de
   `/dashboard`, `/inbox`, `/contacts` de cualquier usuario) es anterior y más
   grande, y merece su propia decisión.
2. **`storage.objects` queda fuera de 057.** Durante una sesión de soporte, media
   que se resolviera por lectura directa del bucket (rutas legadas
   `<uid>/…`) no sería visible. Lo servido por URL firmada sí.
3. **Alcance de lectura de la sesión de soporte = todo el de la cuenta**, incluidas
   las tres políticas que piden `admin` (`account_invitations`, `ai_usage_log`,
   `usage_counters`). Es deliberado y está escrito en la cabecera de 057: son
   justo las que se consultan para atender un ticket, y el operador ya las alcanza
   por el rol de servicio desde `/api/platform/*`. Si se quisiera un soporte de
   «solo lo que ve un viewer», habría que separar dos predicados.
4. **`middleware` → `proxy`** (deuda de CP7, ya anotada por f3.2 y por el revisor):
   migrar permitiría verificar la **firma** de la cookie en el bloqueo en vez de
   su mera presencia, lo que cerraría el *cookie tossing*.
5. **`SUPPORT_SESSION_EXEMPT` compara con `startsWith` sin barra final** en
   `/api/whatsapp/webhook`. Cosmético; hoy no existe ninguna ruta que herede la
   exención.
6. **`src/middleware.ts` arrastra un warning de lint preexistente** (`'options' is
   defined but never used`). No se tocó.

## Compuerta (segunda ronda)

- `npm run lint` — 0 errores, 37 avisos, todos preexistentes.
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — **107 archivos, 1297 tests**, todos en verde.
- `npm run build` con las variables dummy de CI — OK; `ƒ Proxy (Middleware)` y las
  dos rutas de `/api/platform` dinámicas.
- `scripts/replay-migrations.sh` desde limpio — salida 0, `verify-schema.sql: OK`.
- `progress/checks_impersonation-audit.sql` — `NOTICE: checks_impersonation-audit: OK`.
- `npx prettier` sobre lo nuevo y sobre lo que ya estaba formateado. `middleware.ts`,
  `use-auth.tsx`, `account.ts`, `middleware.test.ts` y `client.ts` **ya estaban sin
  formatear en `HEAD`** (comprobado archivo por archivo contra `git show HEAD:…`);
  pasarlos ahora metería churn ajeno al cambio (CP8). Las líneas nuevas siguen el
  estilo del archivo que las rodea.

---

# Tercera ronda — cierre de los cinco cambios requeridos

Commit: `fb95a3e` — «fix: enseñar al navegador qué cuenta mira durante una
sesión de soporte» (37 archivos).

Cierra `progress/review_impersonation-audit.md` (segunda revisión) con las
decisiones que fijó el líder. **Este es el estado válido de la feature**; lo de
arriba se conserva como historia y hay afirmaciones superadas (en particular la
deuda 2 sobre `storage`, corregida abajo).

## El fondo, en una frase

La segunda ronda amplió la RLS (057) y con eso dejó de ser un filtro de **una**
cuenta: un operador con sesión abierta pasa `is_account_member(acc) OR
has_open_support_session(acc)`, así que un `select()` sin filtro devuelve las
filas de las dos empresas mezcladas bajo el cartel de una sola, y un `select()`
filtrado por el `accountId` del operador devuelve la empresa equivocada. Lo que
faltaba no era permiso: era que **el navegador supiera qué cuenta mira**.

## Cambio 1 (hallazgo 1) — salida A: el navegador sabe la cuenta

**La bandera lleva el `account_id`.** `SUPPORT_ACTIVE_COOKIE`
(`wacrm_support_active`) ya no vale `'1'`: vale el uuid de la cuenta
impersonada. `setSupportCookie(token, expiresAt, accountId)` la escribe junto a
la firmada y `clearSupportCookie` sigue borrando las dos a la vez.

Sigue sin conceder nada, y ahora se puede decir por qué con precisión: quien
reescriba esa cookie en su propio navegador solo consigue añadir
`account_id = <uuid>` a **sus propias** consultas; un `WHERE` de más solo puede
**quitar** filas, y la RLS sigue decidiendo cuáles vuelven (para una cuenta sin
sesión abierta, ninguna). Está escrito en `support-cookie.ts`.

**El `accountId` efectivo.** `src/hooks/use-auth.tsx`:

- `effectiveAccountId(own, flag)` — función pura: la cuenta propia si no hay
  bandera, la impersonada si la bandera nombra un uuid, y **`null` si la bandera
  está pero no nombra ninguno**. Ese último caso falla cerrado a propósito:
  caer a la cuenta propia es exactamente el fallo que esto viene a cerrar.
- `useEffectiveAccountId(own)` — el mismo cálculo con `useSyncExternalStore`
  (la cookie es estado fuera de React; el *server snapshot* devuelve `null`
  porque en el servidor no hay `document`). Se re-lee al volver a la pestaña
  (`visibilitychange` / `focus`): las cookies no emiten eventos, y ese es el
  momento en que una sesión cerrada en otra pestaña o caducada se nota aquí.
- `useAuth().accountId` pasa a ser ese valor, y el resumen `account`
  (nombre y moneda del cartel) se carga por el id efectivo, no por
  `profile.account_id`.
- **El rol efectivo NO se degrada a `viewer` en el navegador**, y es deliberado:
  soporte existe para ver lo que ve el administrador del cliente
  (invitaciones, uso, facturación), y degradar la interfaz escondería justo las
  pantallas por las que se abre un ticket. No abre nada: la RLS no deja escribir
  en la cuenta del cliente y `guardReadOnly` no deja escribir en la del
  operador.

**Inventario de consultas del navegador** (`grep` sobre los 44 archivos que
importan `@/lib/supabase/client`): 133 llamadas a `.from(...)`, **113 sin
`account_id`**. Repartidas:

| Grupo | Qué se hizo |
|---|---|
| Listas de tablas con `account_id` (30 consultas) | `.eq('account_id', accountId)` explícito + guarda `if (!accountId) return` |
| Escrituras (`insert/update/upsert/delete`, 40) | **sin tocar**: 057 no amplió ninguna política de escritura, así que para ellas la RLS *sigue* siendo filtro de una cuenta; y durante la sesión el cliente las rechaza antes de salir |
| Lecturas claveadas por id de fila o de padre (`.eq('id'`, `.eq('contact_id'`, `.eq('conversation_id'`, `.eq('pipeline_id'`, `.eq('broadcast_id'`, `.eq('automation_id'`) | **sin tocar**: devuelven filas de una sola cuenta por construcción, y el id viene de una lista que ahora sí está filtrada |
| Tablas hijas sin columna `account_id` (`contact_tags`, `contact_custom_values`, `messages`, `message_reactions`, `broadcast_recipients`, `pipeline_stages`, `automation_logs`) | **no pueden** filtrar por cuenta: no la tienen. Todas se leen por el id del padre. La única que se leía entera —`pipeline_stages` en `automation-builder.tsx`— pasa a `.in('pipeline_id', <ids de los pipelines ya filtrados>)` |

Archivos con filtro nuevo: `contacts/page.tsx` (tags + contactos + `count`),
`broadcasts/page.tsx`, `pipelines/page.tsx`, `automations/page.tsx`,
`inbox/page.tsx` (el estado de WhatsApp ya no se resuelve por el perfil del
operador), `conversation-list.tsx` (conversaciones, tags, perfiles),
`message-thread.tsx` (perfiles asignables), `template-picker.tsx`,
`step1-choose-template.tsx`, `step2-select-audience.tsx`,
`step3-personalize.tsx`, `step4-schedule-send.tsx`, `deal-form.tsx`
(contactos + perfiles), `automation-builder.tsx` (tags, plantillas, campos,
pipelines, etapas), `contact-detail-view.tsx` (catálogos de tags y campos),
`custom-fields-manager.tsx`, `contact-form.tsx`, `settings-overview.tsx`
(los cuatro contadores), `tag-manager.tsx`, `template-manager.tsx`,
`use-total-unread.ts`, `use-unread-notifications.ts`,
`use-broadcast-sending.ts` (audiencia «todos» y búsqueda de CSV).

**Tres listas quedan vacías durante una sesión de soporte, y se decidió así.**
`tag-manager.tsx`, `template-manager.tsx` y tres de los contadores de
`settings-overview.tsx` filtran además por `user_id` desde antes de esta fase.
Se **añadió** `account_id` sin **quitar** `user_id`: cambiar ese filtro por el
de cuenta alteraría lo que ve un usuario normal en un equipo compartido, que no
es asunto de esta feature. La consecuencia es que el operador ve esos tres
listados vacíos en lugar de ver los suyos etiquetados con el nombre del
cliente. Es la opción que el propio revisor marcó como aceptable («una vista
vacía es mejor que la mezcla»). Anotado como deuda.

**El filtro por tags de contactos usa un RPC** (`filter_contacts_by_tags`) y
`guardReadOnly` rechaza **todos** los RPC durante la sesión, así que filtrar por
tag dentro de soporte muestra un error en vez de una lista. Se mantiene el
rechazo en bloque: casi todas las funciones del esquema son SECURITY DEFINER y
una «de lectura» respondería por la cuenta del operador — la vista mal
etiquetada otra vez. Anotado como deuda.

## Cambio 2 (hallazgo 2) — lo escrito sobre `storage.objects`

Corregido en la cabecera de `057_support_session_reads.sql` con la redacción
real: **la URL firmada la pide el navegador con el JWT del propio usuario**
(`src/lib/media/signed-url.ts:12-22` lo explica y `:103-110` lo implementa), no
el servidor con el rol de servicio. Como las políticas del bucket no se
ampliaron, durante una sesión de soporte `createSignedUrl` sobre un objeto del
cliente falla y **el operador no ve NINGÚN adjunto** suyo — no solo el media
legado de rutas `<uid>/…`, que era lo único que declaraba la deuda 2 de la
segunda ronda. La exclusión se mantiene (`storage` es un esquema que administra
Supabase y el alcance de un bucket no se revisa con los mismos ojos que una
tabla); lo que cambia es que ahora está dicho lo que cuesta. También está en
`docs/security.md` y en el `CHANGELOG.md`.

## Cambio 3 (hallazgo 3) — `guardReadOnly` bloquea `storage`

`supabase.storage` pasa por el mismo `Proxy`. En un bucket solo sobreviven las
operaciones de lectura —`createSignedUrl`, `createSignedUrls`, `getPublicUrl`,
`download`, `list`, `exists`, `info`—; `upload`, `remove`, `move`, `copy`,
`createSignedUploadUrl` y la administración de buckets devuelven el mismo
`{ data: null, error: { code: 'support_session_read_only' } }` que el resto.
`createSignedUrl` tenía que quedar abierto: es como el panel resuelve cada
adjunto.

Cierra el caso concreto del revisor: `profile-form.tsx:124` sube el avatar
**antes** del `update` de `profiles`, así que el objeto se escribía de verdad y
solo después se rechazaba la fila — un huérfano en el bucket y un guardado a
medias bajo una franja que prometía que nada se guardaba. Igual en
`uploadAccountMedia` / `deleteAccountMedia`.

## Cambio 4 (hallazgo 4) — el otro `signOut()`

`src/app/join/[token]/page.tsx` llama a `endSupportSession()` antes de
`auth.signOut()`, como hace `useAuth().signOut()`. Era la única salida de sesión
que dejaba la fila de bitácora abierta y las dos cookies vivas para el
siguiente usuario del navegador.

## Cambio 5 — CHANGELOG y paso manual 9

- `CHANGELOG.md`: la viñeta ya no dice solo «ve los datos de ese cliente». Dice
  que **cada lista muestra las filas de ese cliente y solo esas, nunca las
  propias ni las dos mezcladas**, que tampoco puede escribir (subidas
  incluidas) y que **los adjuntos son lo único que una sesión de soporte no
  ve**.
- Paso manual 9 reescrito abajo, con la comprobación que lo hace verificable.

## Criterio ↔ test (tercera ronda)

| Criterio | Archivo | `it(...)` |
|---|---|---|
| La lista fusionada: contactos en dos cuentas, sesión sobre T, solo salen los de T | `src/lib/security/support-session-view.test.ts` | «shows only the customer, not both companies merged» (incluye el `count` de la paginación) |
| …y el test no es vacío: sin filtro salen 3 filas de 2 empresas | idem | «would show three rows from two companies without the filter» |
| …y al terminar la sesión vuelven los del operador | idem | «shows the operator's own contacts again once the session ends» |
| `useAuth().accountId` es T durante la sesión | `src/hooks/use-auth.test.tsx` | «returns the impersonated account while the support session is open» |
| …y el propio después | idem | «returns the operator's own account once the session is over» |
| …y `null` (falla cerrado) si la bandera no nombra cuenta | idem | «shows nothing at all when the flag names no account» |
| …sin confundirse con una cookie de nombre parecido, ni en el servidor | idem | «does not invent an account for a cookie that merely looks similar», «answers null on the server, where there is no cookie jar» |
| `effectiveAccountId` en sus cuatro casos | `support-session-view.test.ts` | 4 casos bajo «effectiveAccountId» |
| La bandera lleva la cuenta y solo un uuid cuenta como tal | idem; `src/lib/supabase/client.test.ts` | «carries the impersonated account…», «refuses a value that is not a uuid, while still reporting a session»; «supportSessionAccountId» (3 casos) |
| El servidor escribe en la bandera la cuenta de la bitácora y ninguna otra | `.../impersonate/route.test.ts` | «tells the browser bundle WHICH account it is showing…», «never names an account it did not open a session on» |
| La bandera se pone y se quita con la cookie firmada | `src/lib/auth/impersonation.test.ts` | «writes the token under the support cookie and clears it again» |
| **Ninguna lista del navegador vuelve a confiar en la RLS como filtro** | `support-session-view.test.ts` | «holds across the whole client bundle» (auditoría estática de todo `src/`) |
| …y esa auditoría detecta de verdad la consulta que causó esta ronda | idem | «would catch the query that caused this round» |
| Las tablas hijas se leen por el id del padre | idem | «are reached through a parent id, which is where the account comes from» |
| `storage` bloqueado salvo lecturas | `src/lib/supabase/client.test.ts` | «refuses storage.%s …» (5 operaciones), «refuses the avatar upload profile-form.tsx makes, before it can orphan an object», «refuses bucket administration too» |
| …y las firmas siguen saliendo | idem | «still signs urls — attachments are what the operator came to see», «leaves the other read operations alone» |
| …y fuera de la sesión no cambia nada | idem | «uploads exactly as before» |

La auditoría estática es el aporte que más dura: recorre todo `src/`, toma cada
cadena `.from('<tabla con account_id>') … .select(`, y exige `account_id` o una
clave de fila/padre. Es lo que impide que la próxima lista nazca sin filtro.

## Verificación contra base real

`scripts/replay-migrations.sh` desde limpio: salida 0, aplicadas 040–044, 047,
051, 055 y 057, `verify-schema.sql: OK`. Esta ronda **solo toca comentarios**
de 057 (ninguna sentencia), así que las sondas de
`progress/checks_impersonation-audit.sql` siguen valiendo sin cambios; se
volvieron a ejecutar igualmente contra el contenedor: `NOTICE:
checks_impersonation-audit: OK`.

## Verificación manual (navegador) — paso 9 reescrito y dos nuevos

Los pasos 1–8 y 10–12 siguen valiendo. El 9 pasa a ser:

9. **La vista es la del cliente, y solo la del cliente.** Antes de abrir la
   sesión, crea un contacto en tu propia cuenta con un nombre reconocible
   («MIO»). Abre la sesión sobre la empresa objetivo y entra en Contactos.
   **Esperado:** aparecen los contactos de la empresa objetivo, **«MIO» no
   aparece**, y el total de la paginación coincide con
   `SELECT count(*) FROM contacts WHERE account_id = '<objetivo>';`. Lo mismo en
   la bandeja (conversaciones), Pipelines (embudos) y Campañas. En la cabecera,
   el nombre de la empresa es el del cliente.
13. **Los adjuntos no se ven, y es lo esperado.** Abre una conversación del
    cliente con una imagen. **Esperado:** el adjunto no carga (la política de
    `storage.objects` no se amplió). Es la limitación documentada, no un fallo.
14. **Nada se sube.** En Ajustes → Perfil, elige una foto y guarda.
    **Esperado:** error de solo lectura, y **ningún objeto nuevo** en el bucket
    `avatars` (compruébalo en el panel de Storage de Supabase).

## Deuda detectada, fuera de alcance — NO arreglada

Las seis de la segunda ronda siguen, con la 2 **corregida** (arriba), más:

7. **Tres listas vacías durante el soporte**: gestor de tags, gestor de
   plantillas y tres contadores de Ajustes filtran también por `user_id`
   (anterior a esta fase). Cambiar ese filtro por el de cuenta es una decisión
   de producto: hoy esos catálogos ya se ven completos en el resto del panel
   (selector de plantillas, filtro de contactos), así que la incoherencia es
   anterior y merece su propio cambio.
8. **El filtro por tags de Contactos no funciona durante el soporte**: usa el
   RPC `filter_contacts_by_tags` y los RPC están rechazados en bloque. Abrirlos
   uno a uno exigiría auditar qué cuenta responde cada función SECURITY
   DEFINER; el camino limpio es que el RPC acepte `p_account_id` y se compruebe
   contra la sesión, lo que es una migración nueva.
9. **Adjuntos invisibles durante el soporte** (hallazgo 2): ampliar las
   políticas de `storage.objects` con el mismo predicado cerraría el hueco. Es
   un esquema administrado por Supabase y se dejó fuera a propósito.
10. **Hallazgos 5 y 6 del revisor**, marcados por él como no bloqueantes y
    dejados como deuda por decisión del líder: el caso `null == null` del
    middleware (una cookie ilegible en un navegador sin sesión ni bloquea con
    motivo ni se borra) y la respuesta de `/stop` que nadie mira (a un operador
    revocado a mitad de sesión le desaparece la franja pero le queda la cookie).
11. **La semilla del pipeline por defecto se intenta durante el soporte** si la
    cuenta del cliente no tiene ninguno: el `insert` se rechaza y queda un
    `console.error`. No escribe nada; es ruido.

## Compuerta (tercera ronda)

- `npm run lint` — 0 errores, **34 avisos**, todos preexistentes (tres de los 37
  anteriores desaparecieron: las guardas nuevas satisfacen reglas que antes
  avisaban).
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — **109 archivos, 1 329 tests**, todos en verde.
- `npm run build` con las variables dummy de CI — OK, `ƒ Proxy (Middleware)`.
- `scripts/replay-migrations.sh` desde limpio — salida 0, `verify-schema.sql: OK`.
- `npx prettier --write` sobre los archivos tocados **que ya estaban formateados
  en `HEAD`** (comprobado uno a uno aplicando la configuración del repo a la
  versión de `HEAD`): `CHANGELOG.md`, `docs/security.md`, los dos de
  `/api/platform/impersonate`, `impersonation.ts(+test)`, `support-cookie.ts`,
  `client.test.ts` y los dos archivos de test nuevos. Los 23 restantes ya
  estaban sin formatear antes de tocarlos; pasarlos ahora metería cientos de
  líneas de churn ajeno al cambio (CP8).

## Variables de entorno

**Ninguna nueva**, otra vez. `.env.local.example` no se tocó (bloqueado por
permisos) y no hacía falta; `docs/docker.md` tampoco cambia.

## CP6

Sin claves de interfaz nuevas: esta ronda no añade texto. `messages/en.json` y
`messages/ko.json` siguen intactos y en paridad (`Impersonation` con las mismas
cuatro claves en los dos).

---

# Cuarta ronda — cierre de los tres cambios requeridos

Commit: `7533aae` — «fix: acotar realtime y el resumen de cuenta a la
cuenta efectiva durante el soporte» (10 archivos). Es un *amend* sobre el WIP
`8590794`, que solo existía en esta rama.

Cierra `progress/review_impersonation-audit.md` (tercera revisión), que dejó
**tres** cambios requeridos: la vía de eventos (realtime), el resumen `account`
congelado y los tres agujeros de la red de regresión. **Este es el estado válido
de la feature.**

## El fondo, en una frase

La tercera ronda enseñó al navegador qué cuenta mira y filtró **todas las
lecturas `.from(...).select(...)`**; lo que quedó fuera fue el otro camino por
el que este panel lee de Supabase desde el navegador —las suscripciones de
`postgres_changes`, que seguían confiando en la RLS como filtro de cuenta— y el
**cartel** sobre esas filas, que se resolvía una sola vez mientras el
`accountId` se movía solo. Las dos son la misma clase de fallo que motivó la
ronda anterior, por las dos puertas que el inventario no miraba.

## Cambio 1 (hallazgo 1) — realtime deja de confiar en la RLS

Módulo nuevo `src/lib/realtime/account-scope.ts` con `eventBelongsToAccount(row,
accountId)`: pura, falla cerrado ante `accountId` nulo, ante una fila sin
`account_id` y ante una fila de otra empresa. **Dos cinturones, porque ninguno
basta solo:**

1. `filter: account_id=eq.<id>` en la suscripción — el servidor tira el evento
   antes de que llegue al socket. Es el arreglo real y el patrón que ya existía
   en el repo (`use-presence.ts`), pero es **silenciosamente inútil en los
   DELETE** de tablas sin `REPLICA IDENTITY FULL`: el registro viejo solo lleva
   la clave primaria, así que no hay `account_id` que casar.
2. la comprobación en el manejador — la fila del evento tiene que nombrar la
   cuenta que la pestaña está mostrando, o no llega al estado.

Aplicado en los cuatro sitios que el revisor listó, más el que él encontró de
rebote:

| Archivo | Qué cambia |
|---|---|
| `src/hooks/use-realtime.ts` | `useRealtime({ accountId })` es ahora obligatorio; **no se suscribe a nada mientras sea `null`**. `conversations` lleva `filter:` y su manejador se extrajo a `conversationPayloadHandler(accountId, emit)` para poder probarlo sin DOM. |
| `src/app/(dashboard)/inbox/page.tsx` | pasa el `accountId` efectivo al hook y **`hydrateConversation` añade `.eq("account_id", accountId)`** (y sale temprano si no hay cuenta). |
| `src/hooks/use-total-unread.ts` | `filter:` en la suscripción + `applyUnreadEvent(counts, accountId, payload)` extraída: descarta lo ajeno y devuelve `null` cuando no hay nada que repintar. |
| `src/hooks/use-unread-notifications.ts` | `filter:` + `applyNotificationEvent(count, accountId, payload)`. Es el caso que **contradecía a `docs/security.md`**: la RLS de `notifications` es `auth.uid() = user_id`, o sea el **operador**, así que la insignia subía con una notificación que `/notifications` no enseñaba. |
| `src/app/(dashboard)/notifications/page.tsx` | `filter:` + comprobación de la fila; el efecto depende ahora de `accountId`. |

**`hydrateConversation` es la pieza que cierra el camino de `messages`.**
`messages` no tiene `account_id` propio —llega a la cuenta por su conversación—
así que ni `filter:` ni comprobación de fila sirven ahí: la suscripción sigue
abierta a propósito, y el mensaje de una conversación que la lista (ya filtrada)
no conoce va a `hydrateConversation`, que lee la fila **con** el filtro de cuenta
y no encuentra nada si es de otra empresa. El evento muere ahí. Es la única
suscripción sin acotar que queda, y el test estático la nombra una a una con su
justificación.

`message_reactions` (`message-thread.tsx`) es el otro caso sin `account_id`, y ya
iba filtrada por `conversation_id`, cuyo id sale de la bandeja filtrada.

## Cambio 2 (hallazgo 3) — el resumen `account` se recalcula

El nombre y la moneda que pinta la cabecera se resolvían **dentro de
`fetchProfile`**, que solo vuelve a correr al cambiar el estado de autenticación;
el `accountId`, en cambio, se re-lee de la bandera en cada `visibilitychange` /
`focus`. En cuanto discrepaban volvía la vista mal etiquetada: la sesión caduca
con la pestaña abierta y las listas recargan las filas del operador bajo el
nombre del cliente; o se abre una sesión desde otra pestaña y salen las filas del
cliente bajo el nombre del operador y sin franja.

Dos piezas en `src/hooks/use-auth.tsx`:

- **`fetchAccountSummary(supabase, accountId)`** — la lectura, sacada de
  `fetchProfile` a su propio efecto que depende de `[userId, effectiveAccount,
  accountRefreshTick]`: **el mismo disparador que la bandera**. Sigue siendo un
  *point lookup* por id y no un *embed* de PostgREST, por lo de siempre (issue
  #294, caché de esquema rancia → PGRST200 y perfil en blanco).
- **`accountSummaryFor(summary, effectiveAccountId)`** — pura: devuelve el
  resumen **solo si es de esa misma cuenta**, y `null` en cualquier otro caso.
  Es la barandilla de la ventana en la que la lectura aún no ha llegado: la
  respuesta honesta es «todavía no lo sé», no el nombre de la cuenta anterior.
  `account` y `defaultCurrency` del contexto salen ya de ahí.

`accountRefreshTick` existe porque el resumen dejó de viajar con el perfil:
`refreshProfile()` lo incrementa para que un cambio de nombre o de moneda hecho
en Ajustes se vea sin recargar (`deals-settings.tsx` guarda y refresca).

Decisión donde el spec no decía nada: **no se degrada a la moneda por defecto
global mientras el resumen no case**; `defaultCurrency` cae a `DEFAULT_CURRENCY`
(USD), no a la moneda del resumen viejo, porque poner el EUR del cliente sobre
los negocios del operador es el mismo fallo de etiqueta con otra ropa.

## Cambio 3 (hallazgo 2) — la red de regresión, por los tres agujeros

`src/lib/security/support-session-view.test.ts`, reescrita la parte estática:

1. **`ACCOUNT_SCOPED` se deriva de `supabase/migrations`**, no de una lista a
   mano. Se leen las dos formas que el esquema usa de verdad —`ALTER TABLE … ADD
   COLUMN [IF NOT EXISTS] account_id` (así retrofiteó 017) y `CREATE TABLE … (…
   account_id …)`— con emparejado de paréntesis para que un `numeric(10,2)` o un
   `CHECK` no corten el cuerpo, y el `account_id` anclado a principio de línea
   para que un `contact_id` o un `REFERENCES` no cuelen. Grep, no un parser de
   SQL: no se añade dependencia. `accounts` se siembra a mano, porque es la única
   tabla cuyo **propio `id`** es la cuenta. La lista vieja se dejaba **siete**
   tablas que sí tienen la columna (`account_invitations`, `ai_knowledge_chunks`,
   `api_keys`, `automation_pending_executions`, `impersonation_log`,
   `inbound_auto_replies`, `webhook_endpoints`); hoy ninguna se lee desde el
   navegador, pero la primera lista sobre `account_invitations` habría pasado en
   silencio.
2. **La exención por `account_id` mira el argumento de `.eq`/`.in`**
   (`FILTERS_BY_ACCOUNT`), no la cadena suelta. El viejo
   `/account_id/.test(chain)` dejaba pasar
   `from('contacts').select('id, account_id, name').order(…)`: *seleccionar* la
   columna no es filtrar por ella.
3. **`user_id` deja de contar como clave** (`isKeyedRead`). La exención vieja
   (`\w*_?id`) casaba con él, y durante una sesión de soporte «el usuario actual»
   es el **operador**: es exactamente la forma que `tag-manager.tsx` y
   `template-manager.tsx` tuvieron que arreglar a mano la ronda pasada. Las dos
   lecturas que legítimamente van por `user_id` solo (`use-auth.tsx`, la fila del
   propio usuario; `upload-media.ts`, su propio avatar) quedan **fijadas por
   archivo** en `OWN_USER_ROW_READS`, con un test que exige que la lista sea
   exactamente esa: una tercera hay que argumentarla ahí, no aparece sola.
4. **Bloque nuevo para `postgres_changes`**: extrae el objeto de opciones de cada
   `.on('postgres_changes', …)` de los archivos que importan el cliente del
   navegador (escaneando llaves, porque en `use-realtime.ts` hay un comentario
   entre el nombre del evento y las opciones) y exige `filter: account_id=eq.…`
   en toda tabla con `account_id`. Con su guardia de no-vacuidad (la lista
   literal de las cinco suscripciones acotadas) y con el inventario explícito de
   las dos que no lo pueden estar y por qué.

El nombre del `describe` también deja de prometer de más: «every browser SELECT
of a tenant table names its account» y, aparte, «every browser subscription…».

## Criterio ↔ test (cuarta ronda)

| Criterio | Archivo | `it(...)` |
|---|---|---|
| Una fila de otra empresa no pasa el filtro; falla cerrado sin cuenta y sin `account_id` | `src/lib/realtime/account-scope.test.ts` | «accepts a row of the account the tab is showing», «rejects a row of the operator's own company», «fails closed with no account to compare against», «fails closed on a payload that carries no account at all» |
| **La bandeja no se mueve** con una conversación del operador durante la sesión | idem | «does not move for a conversation of the operator's own company» |
| …y sí con las del cliente (no está simplemente congelada) | idem | «still moves for the customer's own conversations» |
| …y no se suscribe a nada mientras no se sepa la cuenta | idem | «listens to nothing while the effective account is unknown» |
| …y vuelven las del operador al terminar la sesión | idem | «goes back to the operator's own conversations after the session» |
| **La insignia de no leídos** no cuenta las del operador | idem | «does not count the operator's own unread conversation», «counts the customer's, so the badge is not simply frozen» |
| …y el DELETE sin `account_id` se descarta por no estar en el mapa | idem | «ignores a DELETE for a conversation it never counted», «applies a DELETE of the customer's own conversation» |
| **La insignia de notificaciones** no sube con las del operador (la que contradecía a `docs/security.md`) | idem | «does not rise for the operator's own notification», «rises for the customer's» |
| …ni baja cuando el operador lee una suya; sí con las del cliente; nunca negativa | idem | «does not fall when the operator reads one of their own», «falls when the customer's is marked read», «ignores a DELETE of the operator's own unread notification», «applies a DELETE of the customer's unread notification», «never goes negative» |
| **El cartel nombra al cliente durante la sesión y al operador fuera** | `src/hooks/use-auth.test.tsx` | «names the customer's company during the session», «names the operator's own company with no session open» |
| …y **se queda en blanco** al caducar la sesión bajo la pestaña | idem | «goes blank the moment the session expires under it» |
| …y al abrirse una sesión desde otra pestaña (la otra dirección) | idem | «goes blank the moment a session opens from another tab» |
| …y con una bandera que no nombra cuenta, y antes de que llegue la lectura | idem | «stays blank while the flag names no account», «prints nothing before the fetch lands» |
| `accountSummaryFor` en aislamiento | idem | «hands back the summary only when it is about that same account», «withholds it while there is no effective account at all» |
| **Toda suscripción del navegador a una tabla con `account_id` nombra su cuenta** | `src/lib/security/support-session-view.test.ts` | «holds for every `postgres_changes` channel in the client bundle» |
| …y la auditoría encuentra las suscripciones de verdad (no es vacía) | idem | «finds the subscriptions at all, comments in the way included» |
| …y detectaría la suscripción sin filtro que esta ronda quitó | idem | «would catch the unfiltered subscription this round removed» |
| …y las dos sin `account_id` están inventariadas y justificadas | idem | «accounts for the subscriptions to tables with no account_id» |
| `ACCOUNT_SCOPED` sale de las migraciones, con las siete que faltaban | idem | «are read off supabase/migrations, not off a list kept by hand» |
| …y no se cuela una tabla hija | idem | «leave out the child tables, which have no account of their own» |
| La red cazaría una lista que solo **selecciona** `account_id` | idem | «would catch a list that merely selects the account_id column» |
| …y una acotada solo al usuario actual | idem | «would catch a list narrowed only to the current user» |
| …y sigue dejando pasar una lectura claveada de verdad | idem | «still lets a genuinely keyed read through» |
| …y las lecturas por `user_id` son exactamente las dos de fila propia | idem | «lists the reads narrowed only by the current user, all of them own-row» |
| Lo anterior sigue en pie (SELECT del navegador) | idem | «holds for every `.from(table).select(…)` in the client bundle», «would catch the query that caused this round» |

## Verificación contra base real

**Esta ronda no toca SQL**: ni una migración, ni `verify-schema.sql`. El diff es
solo `src/`. Las sondas de `progress/checks_impersonation-audit.sql` y el replay
de la tercera ronda (salida 0, `verify-schema.sql: OK`) siguen valiendo sin
cambios, así que no se repitió.

Los dos hechos de la base de los que depende este cambio se comprobaron ya
contra el contenedor en rondas anteriores y los deja escritos el revisor:
`conversations`, `messages` y `notifications` están en la publicación
`supabase_realtime`; la política de `notifications` es `auth.uid() = user_id`;
`notifications` es `REPLICA IDENTITY FULL` (027) y `conversations` no lo es —de
ahí los dos cinturones y el trato distinto del DELETE en cada una.

## Verificación manual (navegador) — dos pasos nuevos

Los pasos 1–14 siguen valiendo. Se añaden, porque el canal de replicación no se
puede sembrar sin dos sesiones vivas:

15. **Nada del operador entra en vivo.** Con una sesión de soporte abierta sobre
    la empresa objetivo, deja la bandeja del cliente a la vista. Desde otro
    navegador (o el teléfono) haz que llegue un WhatsApp **a tu propia empresa**.
    **Esperado:** la conversación **no** aparece en la lista, la insignia verde
    del menú lateral **no** cambia y la campana **no** sube. Repite con un
    mensaje a la empresa del cliente: ese sí tiene que entrar en vivo.
16. **El cartel no se queda colgado.** Con la sesión abierta y la pestaña a la
    vista, cierra la sesión desde **otra** pestaña (botón «salir») y vuelve a la
    primera. **Esperado:** al recuperar el foco, las listas vuelven a tus filas y
    la cabecera **deja de nombrar al cliente** (queda vacía hasta que resuelve la
    tuya); en ningún momento se ve el nombre del cliente sobre tus contactos.

## Deuda detectada, fuera de alcance — NO arreglada

Las once de las rondas anteriores siguen igual (la 2 corregida en la tercera),
más lo que esta ronda deja abierto a propósito:

12. **`CHANGELOG.md:152` nombra «settings»** entre las listas que muestran las
    filas del cliente, y en Ajustes el gestor de tags y el de plantillas salen
    **vacíos** (deuda 7). El revisor lo marcó como cosmético y el líder acotó
    esta ronda a los tres cambios requeridos, así que no se tocó.
    `docs/security.md` sí lo cuenta bien.
13. **Lecturas claveadas por parámetro de URL** (hallazgo 5 del revisor):
    `automations/[id]/logs/page.tsx:45`, `broadcasts/[id]/page.tsx:172` e
    `inbox/page.tsx:141` leen por `id` sin acotar por cuenta. No hay fuga entre
    clientes (la RLS solo admite la propia y la soportada), pero un enlace
    guardado abre la ficha **del operador** bajo el cartel del cliente. La red de
    regresión los exime a propósito (`isKeyedRead`): cerrarlo es otro cambio.
14. **La ventana en blanco del cartel.** Mientras la lectura del resumen viaja,
    la cabecera no pone nombre. Es deliberado (mejor nada que el nombre
    equivocado), pero un *skeleton* explícito se vería mejor que el hueco. UI,
    fuera de alcance.

## Compuerta (cuarta ronda)

Ejecutada en el worktree, cada comando por separado:

- `npm run typecheck` — limpio.
- `TZ=UTC npx vitest run` — **110 archivos, 1 366 tests**, todos en verde
  (+1 archivo y +37 tests sobre la tercera ronda).
- `npm run lint` — **0 errores, 34 avisos**, los mismos preexistentes de la
  ronda anterior.
- `npm run build` con las variables dummy de CI — OK, `ƒ Proxy (Middleware)`.
- `scripts/replay-migrations.sh` — **no aplica**: esta ronda no toca SQL.
- `npx prettier --check` sobre los cuatro archivos de esta tanda
  (`use-auth.test.tsx`, `account-scope.ts(+test)`, `support-session-view.test.ts`)
  — limpios. Los seis restantes (`inbox/page.tsx`, `notifications/page.tsx`,
  `use-auth.tsx`, `use-realtime.ts`, `use-total-unread.ts`,
  `use-unread-notifications.ts`) **ya estaban sin formatear antes de tocarlos**
  —comprobado archivo a archivo contra su versión previa— y se mantienen así,
  por la misma razón que en la tercera ronda: pasarlos ahora metería cientos de
  líneas de churn ajeno al cambio (CP8).

## Variables de entorno

**Ninguna nueva.** `.env.local.example` sigue sin tocarse (bloqueado por
permisos) y no hacía falta; `docs/docker.md` tampoco cambia.

## CP6 e i18n

Sin claves de interfaz nuevas: esta ronda no añade texto visible.
`messages/en.json` y `messages/ko.json` intactos y en paridad.

## Nota de proceso

Las tres rondas anteriores las dejó a medias un agente que se cortó; el WIP
`8590794` traía ya el código y `account-scope.test.ts`, y faltaban el test del
resumen de cuenta y la red de regresión, que son los cuatro archivos que esta
sesión termina. Se cierran con `--amend` sobre ese WIP porque no estaba en
ninguna otra rama.
