# Review — f4.3 platform-admins-panel

**Veredicto:** APPROVED

Rama `saas/fase-4-plataforma`, worktree `.claude/worktrees/fase-4`, HEAD `1ff573c`,
árbol limpio. Rango revisado `5ee13d5..1ff573c` (3 commits) + el merge `5ee13d5`.

## Compuerta (ejecutada por mí, comando a comando)

- `npm run lint`: **verde** — 0 errores, 35 avisos, todos preexistentes (`src/middleware.ts:72`
  entre ellos, anotado como deuda en el informe).
- `npm run typecheck`: **verde**, sin salida.
- `TZ=UTC npm test -- --reporter=dot`: **verde** — 138 archivos, 1871 tests, 5,36 s.
  Coincide con el informe.
- `npm run build` con las variables dummy de `docs/harness.md`: **verde**, 63 páginas,
  con `ƒ /platform`, `ƒ /platform/[id]`, `ƒ /api/platform/accounts`, `…/[id]`,
  `…/[id]/hold`, `ƒ /api/platform/me`.
- `scripts/replay-migrations.sh`: **verde**, salida 0 desde base limpia, 001→058
  (sin 054, hueco preexistente de la fase 4), `verify-schema.sql: OK`.
- `progress/checks_platform-admins-panel.sql`: ejecutado por mí con `KEEP=1` contra el
  contenedor del harness. 6 bloques, todos `OK`, salida 0.

## El merge `5ee13d5`

Comprobado en el árbol resultante, no en el informe:

- `src/lib/auth/account.ts` conserva los dos lados: `impersonatedContext`,
  `resolveSupportSession`, `IMPERSONATED_ROLE` (f4.4) **y** `assertWritable`,
  `allowReadOnly`, `billingErrorPayload` (f3.4).
- `dashboard-shell.tsx`: `ImpersonationBanner` en :62 fuera del scroll,
  `AccountAccessAlert` :71 y `BillingStatusAlert` :75 dentro del `<main>`.
- `inbox/page.tsx`: `accountId` de `useAuth` (:45), `.eq('account_id', accountId)` al
  hidratar (:157) y en `useRealtime` (:356) **y** la consulta de números conectados de
  f4.2 (`.eq('status','connected')`, :215-216).
- `tenant-isolation.test.ts`: waivers de `platform_admins`, `impersonation_log` (f4.4)
  **y** de `plans` (integración) presentes los tres.
- `verify-schema.sql`: un solo bloque `DO`, `IF`/`END IF` balanceados, con las
  aserciones de 045–053, 055, 056, 057 y las 11 nuevas de 058.

**La 057 detrás de 045–056**, verificado por mí con `pg_policies` sobre la base replicada:

| Consulta | Resultado | Informe |
|---|---|---|
| SELECT con `can_read_account` | 37 | 37 ✔ |
| ESCRITURA con `has_open_support_session`/`can_read_account` | **0** | 0 ✔ |
| SELECT que aún llaman `is_account_member` | 0 | 0 ✔ |
| ESCRITURA con `is_account_member` | 64 | 64 ✔ |
| políticas de escritura en `subscriptions` | **0** | 0 ✔ |

Ninguna política de escritura tocada. `verify-schema.sql` no afirma un número de
políticas (afirma las dos propiedades), y el conteo 37 sí queda fijado con su porqué
—`checkout_intents_select`, migración 048— en el bloque 6 de los checks, que falla con
`FALLO 6c` si cambia. El informe lo documenta correctamente (§«La 057 aplicada detrás
de 045–056»).

## Trazabilidad criterio ↔ test

Los cuatro criterios del spec §2 y los siete puntos añadidos por el encargo. Cada `it`
leído, no solo localizado.

**C1 «un platform admin ve todas las cuentas; un `owner` normal no ve más que la suya»**
- [x] `src/lib/security/tenant-isolation.test.ts` › `gives a platform admin every account, and the owner of A none` — con `makePlatformAdmin(USER_A)` el censo devuelve `Set([A, B])`; sin la fila, el test de al lado devuelve 403.
- [x] `…` › `403s the owner of A on the census, and tells him nothing about B` — 403 + `expectNoBIds(body)` + `expectBUnchanged`.
- [x] `…` › `403s the owner of A on B's file — and on his OWN account's file too` — el panel no es una segunda puerta a los datos propios.
- [x] `…` › `403s the owner of A trying to suspend anybody, including himself` — y comprueba que la bitácora queda vacía y ningún `manual_hold_at` se puso.
- [x] Rutas, una a una: `accounts/route.test.ts` › `403s a company owner…`, `leaks nothing about the service in the refusal`; `accounts/[id]/route.test.ts` › `403s a company owner asking about somebody else's company` y `…THEIR OWN company too`; `[id]/hold/route.test.ts` › `403s a company owner…` y `401s a visitor with no session, and holds nobody`.
- Las cuatro rutas nuevas abren con `requirePlatformAdmin()` (`accounts/route.ts:38`, `[id]/route.ts:37`, `[id]/hold/route.ts:65`, `me/route.ts:20`). No hay ninguna otra ruta nueva por la que un owner pueda listar cuentas ajenas.

**C2 «suspender corta lo saliente y NO lo entrante»**
- [x] f3.4 lo respeta: `entitlements.test.ts` › `a manual hold makes a perfectly healthy account read-only` (status `active`, `readOnly` true, `readOnlyReason` `manual_hold`), `says manual_hold when both causes apply`, `reads the hold off the row it was already fetching` (asegura una sola consulta a `subscriptions`).
- [x] La escalera: `enforce.test.ts` › `refuses an account a platform operator suspended by hand (fase 4 §2)` — 403, `manualHold: true`, mensaje sin «settle».
- [x] En `requireRole`: `account.test.ts` › `refuses an OWNER of an account the PLATFORM suspended by hand` y `lets a manually suspended account keep READING — it is a hold, not a ban` (con `assertWritable` no llamado para `viewer`). Es retención, no ceguera.
- [x] Flows / automations / IA / API keys: los cinco caminos salientes pasan por
  `assertWritable` (`src/lib/flows/meta-send.ts:90,218,404`, `src/lib/automations/meta-send.ts:144`,
  `src/lib/ai/auto-reply.ts:93`, `src/lib/auth/api-context.ts:123`, `src/lib/auth/account.ts:334`),
  que ahora lanza con `e.manualHold`. La retención entra por `readOnly`, así que no hace
  falta tocar ninguno.
- [x] **CP11**: `src/app/api/whatsapp/webhook/route.test.ts` › `stores it while a PLATFORM OPERATOR holds the account suspended (fase 4 §2)` — con `assertWritable` cableado para rechazar con `new AccountLockedError('active', true)`, el upsert del entrante ocurre igual y `assertWritable` **no llega a llamarse**.

**C3 «la reactivación por webhook de PayPal NO levanta una retención manual»**
- [x] `src/app/api/billing/webhook/route.test.ts` › `does NOT lift a manual hold (fase 4 §2)` — tras un `ACTIVATED`, `status` pasa a `active` y `manual_hold_at`/`_reason` siguen puestos; **y además** recorre `writesTo('subscriptions')` afirmando que ningún parche menciona las tres columnas. Es la aserción fuerte que pedía el encargo.
- [x] Reactivar a mano: `accounts.test.ts` › `lifting clears all three columns, so nothing lingers`; `[id]/hold/route.test.ts` › `lifts the hold, with its own line in the trail`; `tenant-isolation.test.ts` › `reactivating clears the hold, and only on the company it names`.

**C4 «toda suspensión/reactivación queda en la bitácora de f4.4 con actor, cuenta, momento y motivo obligatorio»**
- [x] `src/lib/platform/audit.test.ts` › `records actor, account, moment and reason — the four the spec names`, `opens no session: a suspension carries no expiry at all`, `snapshots the name…`, `reports a failure instead of swallowing it`.
- [x] Bitácora ANTES del acto: `[id]/hold/route.test.ts` › `holds NOBODY when the trail cannot be written` — 500 y `holdCalls` vacío; y `records actor, account, moment and reason, and only then holds` fija el orden.
- [x] Motivo obligatorio: `400s a missing reason`, `400s a reason too short to mean anything`, `needs a reason too — lifting a suspension is an act, not an undo`, `trims the reason before it is stored`. El mínimo (10) es el mismo número en ruta y en el CHECK de 058, exportado desde `support-cookie.ts`.
- [x] Una fila de suspensión no es una sesión: `support-session-store.test.ts` › `never reads a suspend row as a session (migration 058)` (con control: una fila `suspend` **con caducidad futura** tampoco cuela) y `leaves the suspend / reactivate rows of 058 alone`.
- [x] Base real: bloque 3 de los checks (CHECK del `action`, caducidad obligatoria solo para `impersonation`, motivo de 2 caracteres rechazado, fila sin `action` sigue siendo sesión) y bloque 4 (una fila `suspend` abierta y con caducidad futura **no** concede lectura, con control positivo delante).

**C5 CP3 — rol de servicio acotado por la cuenta objetivo, con test de fuga**
- [x] `accounts.test.ts` › `scopes EVERY service-role query by the account it is about (CP3)` — recorre las 8 tablas de inquilino (`accounts`, `subscriptions`, `profiles`, `whatsapp_config`, `usage_counters`, `conversations`, `checkout_intents`, `impersonation_log`), exige ≥1 consulta por tabla y que **todas** lleven `account_id`/`id` = A, y remata con `expect(scopedAccountIds()).not.toContain(B)`.
- [x] `reaches billing_events only through THIS account subscription ids` — las dos consultas llevan `in:` con `I-AAA`/`I-AAA-OLD` y nunca `I-BBB`; `does not query the gateway log at all when the account never paid` cubre el caso vacío.
- [x] `scopes the write to the account it names, and touches no other (CP3)` — `update.filters` es exactamente `[['account_id', A]]` y B no se mueve.
- [x] Auditoría automática de la suite: waivers nuevos `rpc:platform_account_list` (censo por definición, acotado por GRANT + no-DEFINER + `requirePlatformAdmin`) y `billing_events` (sin `account_id` en 041). **Comprobé el supuesto del segundo contra la base**: `subscriptions_provider_subscription_id_key` y `checkout_intents_provider_subscription_key` son UNIQUE, así que un id de la lista no puede pertenecer a otra cuenta. El waiver no es una excusa, es un argumento cierto.
- [x] El agregado del listado no mezcla cuentas al renderizar: cada fila sale de
  `platform_account_list()`, que calcula miembros / consumo / última actividad con
  subconsultas correlacionadas `WHERE … = p.id` (058:238, 248, 255), y
  `platform-accounts.tsx` solo mapea `page.accounts`. La ficha con varios números:
  `lists every WhatsApp number, not one (f4.2)`.
- [x] Control negativo del implementer verificado como plausible y documentado (quitar
  `.eq('account_id')` de `loadMembers` rompe 2 tests).

**C6 Migración 058**
- [x] Idempotente: `ADD COLUMN IF NOT EXISTS` (×3 y `action`), FK/CHECKs en drop-then-add,
  `CREATE INDEX IF NOT EXISTS` (×2), `CREATE OR REPLACE` en las dos funciones.
- [x] Sin `CASCADE`: la única FK nueva, `subscriptions_manual_hold_by_fkey`, es
  `ON DELETE SET NULL`, con aserción `confdeltype = 'n'` en `verify-schema.sql` y control
  negativo en base real (bloque 2: borrar al operador deja la retención en pie).
- [x] 11 aserciones nuevas en `verify-schema.sql`, una por objeto: las tres columnas, la FK,
  el CHECK del motivo (afirma el *contenido*, no solo la existencia), el índice parcial,
  `action` NOT NULL, su CHECK con los tres valores, el CHECK de caducidad,
  `has_open_support_session` filtrando por `action`, `platform_account_list` (existe,
  `prosecdef = false`, no ejecutable por `authenticated`/`anon`, sí por `service_role`) y el
  índice de `billing_events`. Más la aserción defensiva de que `subscriptions` sigue sin
  política de escritura — la que hace que la retención signifique algo.
- [x] Bloque 5 de los checks, ejecutado por mí: el inquilino lee su suscripción y su
  `UPDATE … SET manual_hold_at = NULL` afecta a 0 filas.

**C7 UI y convenciones**
- [x] Ruta propia `/platform` y `/platform/[id]`, **componentes de servidor** con
  `requirePlatformAdmin()` + `notFound()`. No es un `useEffect` que esconde un enlace.
- [x] CP7 contra `node_modules/next/dist/docs/`: `notFound` en
  `01-app/03-api-reference/04-functions/not-found.md` (se lanza sin `return`, tipo `never`);
  `params: Promise<…>` en `03-file-conventions/page.md:13` y `route.md:87`. Ambas páginas
  y las dos rutas dinámicas lo cumplen, y el `notFound()` va **en el `catch`**, no dentro
  del `try`, así que no se lo traga nadie.
- [x] CP6: comprobado por mí aplanando los dos catálogos — **1645 claves en `en.json`,
  1645 en `ko.json`, conjuntos idénticos** (0 en uno y no en el otro). No hay `es.json`.
  `platform-panel.test.tsx` › `every key %s asks for exists in en AND ko` (con guarda
  `keys.length > 10` contra un regex que no case nada), `is translated, not English with
  a Korean shell (CP6)`, `the manual-hold notice exists in both catalogues` (y afirma
  `en.Billing.heldBody !== ko.Billing.heldBody`), `the sidebar entry exists in both`.
- [x] `opens on the loading state, never on "no customers"` — un censo caído no se lee
  como «no hay clientes». Verificado también en el código (`setFailed(true); setPage(null)`).

**C8 «Impersonar» reutiliza f4.4**
- [x] `platform-account-detail.tsx:176` llama a `POST /api/platform/impersonate`, la ruta de
  f4.4, con el mismo cuerpo `{ account_id, reason }`. No hay ruta ni cookie nuevas. El único
  cambio en esa ruta es escribir `action: 'impersonation'` explícito en el insert
  (`impersonate/route.ts:166`), que es obligado por la 058 y está probado.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro pasos ejecutados por mí, verdes.
- **CP2 Migraciones**: [x] 058 idempotente, 11 aserciones, sin CASCADE, replay 0.
- **CP3 Aislamiento**: [x] toda consulta con rol de servicio filtrada; las dos excepciones
  (censo y `billing_events`) razonadas, waivadas por escrito y la segunda verificada contra
  los UNIQUE de la base. Tests de fuga A↔B en cuatro sitios.
- **CP4 Tests**: [x] cada criterio con su `it` leído; SQL de base real ejecutado por mí;
  guion manual de 11 pasos para lo que depende de Meta / PayPal (§5 del informe).
- **CP5 Sin dependencias**: [x] `package.json` y `package-lock.json` sin cambios en el rango.
- **CP6 i18n**: [x] 1645 = 1645, conjuntos idénticos.
- **CP7 Next 16**: [x] `notFound` y `params: Promise` comprobados en los docs del paquete.
- **CP8 Alcance**: [x] 41 archivos, todos justificados por la §2 o por la 058 (la sidebar,
  el hook, `fake-supabase.not()`, `action` explícito en la ruta de f4.4). Nada arreglado
  fuera; siete deudas anotadas y **no** tocadas.
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) con el bloque del panel y el aviso
  de migración; `docs/security.md` § «Suspending an account by hand»; ninguna variable de
  entorno nueva, por eso `docs/docker.md` no se toca; el informe coincide con el diff en
  los 41 archivos y en los números que verifiqué (1871 tests, 37 políticas, 1645 claves).
- **CP10 Git**: [x] tres commits en `saas/fase-4-plataforma`, en español con prefijo y
  `Co-Authored-By: Claude Opus 5 (1M context)`. Nada pusheado. `main` sigue en `46a0999` y
  `feat/saas-multiempresa` en `593b92f`. La discrepancia de atribución que el informe señala
  (§8) es de configuración del entorno, no de contenido; no bloquea.
- **CP11 Lo entrante nunca se bloquea**: [x] test leído, con el error exacto de la retención.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Tres notas, todas menores:

1. `src/components/platform/platform-account-detail.tsx:119-141` y
   `src/components/platform/platform-accounts.tsx:66-89` — `load()` no secuencia ni aborta
   las peticiones en vuelo. Dos navegaciones rápidas entre fichas pueden resolver fuera de
   orden y pintar la ficha anterior bajo el id nuevo. **No es fuga entre inquilinos**: las
   dos cuentas son visibles para el mismo operador, y `setLoading(true)` al entrar evita
   mostrar el `detail` viejo mientras carga. Un `AbortController` o un contador de
   generación lo cerraría.
2. `src/app/(dashboard)/platform/page.tsx:19-23` y `[id]/page.tsx:19-23` — el `catch {}`
   convierte en 404 cualquier fallo de `requirePlatformAdmin()`, incluido uno de
   infraestructura. Falla cerrado, que es lo correcto, y `unstable_rethrow` no hace falta
   porque el `notFound()` se lanza desde el `catch`, no dentro del `try`. Solo cuesta
   diagnóstico: un 404 puede ser «no eres operador» o «la base no respondió».
3. `supabase/migrations/` no tiene `054`. Hueco **preexistente** de la fase 4, ajeno a esta
   feature; `replay-migrations.sh` no se inmuta. Lo anoto para que el líder lo confirme
   antes de integrar.

## Cambios requeridos

Ninguno.
