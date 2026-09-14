# Integración — `saas/fase-2-seguridad` → `saas/integracion`

**Rama:** `saas/integracion`, worktree `.claude/worktrees/integracion`.
**Base:** `96e02fa` (= `saas/fase-1-bandeja` completa, que ya trae fase 0).
**Fusionada:** `saas/fase-2-seguridad` (`2e2cfef`).

**Commits:**

| Commit | Qué |
|---|---|
| `9680b68` | `Merge branch 'saas/fase-2-seguridad' into saas/integracion` (mensaje por defecto + trailer `Co-Authored-By: Claude Fable 5.1`) |

No hubo commit `fix:`: la auditoría de fase 2 no destapó ninguna consulta de fase 1 sin
`account_id` (detalle abajo, sección «Auditoría»).

48 archivos, +6 865 / −321. `git status` limpio tras el commit. Sin `push`, sin PR.

## Conflictos y cómo se resolvieron

Los cuatro que el líder había visto en seco. En todos se conservaron **los dos lados**.

### 1. `CHANGELOG.md`

Las dos fases habían escrito bajo `## [Unreleased]` sus propios `### Added` y `### Fixed`,
así que git vio un conflicto de bloque entero.

Resuelto **unificando en un solo par de secciones**, no dejando dos `### Added` y dos
`### Fixed` seguidos (eso rompe la forma de Keep a Changelog que sigue el resto del
archivo). Dentro de cada sección, primero las entradas de fase 0/1 y después las de fase 2
— «ordenadas por fase», que es lo que pedía el encargo:

```
## [Unreleased]
  <intro de fase 0 + nota «Migration required» con 040, 041, 042, 043, 047, 051>
  ### Added
    <11 entradas de fase 0/1: handoff con agente disponible, aviso de handoff,
     «quién atiende» en la bandeja, modelo de facturación, entitlements, métrica de
     respuestas de IA, claves de plataforma, key_source, playground…>
    <3 entradas de fase 2: rotación de clave de cifrado (+ su aviso de formato
     irreversible), token de verificación de plataforma, adjuntos privados
     + la nota «Migration (apply last): 044…»>
  ### Fixed
    <entradas de fase 0/1: la automatización que silenciaba la IA, «probar clave»,
     guardar sin clave, asignaciones colgantes…>
    <3 entradas de fase 2: edición de flujos acotada por cuenta, edición de
     automatizaciones acotada por cuenta, ex-miembros y sus automatizaciones>
```

Ninguna entrada se reescribió ni se fusionó: están todas, literales. El párrafo de
cabecera de fase 0 («Fase 0 … **No user-visible behaviour changes**») se dejó tal cual
porque ya venía así de la rama de fase 1 (que sí trae cambios visibles): corregirlo es
redacción, no integración, y lo apunto como deuda menor abajo.

Las dos notas de migración conviven a propósito: la de cabecera lista 040–043, 047 y 051;
la de fase 2 está pegada a los adjuntos privados y dice, con razón, que **044 se aplica al
final**, después de confirmar que los adjuntos salientes siguen llegando.

### 2. `supabase/ci/verify-schema.sql`

Las dos fases habían añadido sus aserciones justo antes del `RAISE NOTICE 'schema
verification passed'`. Conflicto puramente de posición.

Resuelto **concatenando los dos bloques**: primero el de fase 0/1 (040, 041, 042, 043, 047,
051 — 28 aserciones) y después el de fase 2 (044 — 4 aserciones: los dos buckets privados,
las dos políticas de lectura acotadas por cuenta, y que ninguna política pública
sobreviviera). El archivo no estaba ordenado por número de migración ni antes (041 → 047 →
042 → 043), así que el orden por fase es el que ya tenía.

Detalle de la resolución: el `END IF;` que cerraba el último `IF` era una línea **común** a
los dos lados, así que hubo que **reintroducir un `END IF;`** al final del bloque de fase 1
para que los dos `IF` quedaran cerrados. Sin eso el `DO $$` no compila; lo comprobó el
replay.

### 3. `src/lib/automations/engine.ts`

Fase 1 reformateó el archivo (punto y coma, prettier) y trajo `round_robin` y la reserva
por mensaje; fase 2 acotó por `account_id` la lectura del paso encolado (f2.2). El
conflicto fue solo en `resumePendingExecution`, y era de estilo más que de fondo: el mismo
`const db = supabaseAdmin()` con y sin punto y coma.

Resuelto quedándome con **el comentario y el `.eq('account_id', pending.account_id)` de
fase 2, escritos en el estilo de fase 1** (con punto y coma). El diff completo del archivo
contra `96e02fa` es exactamente ese hunk y nada más:

```
   const db = supabaseAdmin();
+  // Service role: no RLS. The pending row carries the account it was
+  // queued for, so the automation is read under that account — an id
+  // that points anywhere else simply doesn't resolve.
   const { data: automation, error } = await db
     .from('automations')
     .select('*')
     .eq('id', pending.automation_id)
+    .eq('account_id', pending.account_id)
     .single();
```

Comprobado que **sobreviven los dos comportamientos**:

- fase 1: `claimInboundAutoReplyForAutomation` importado (`:34`), `reserveReplyToInbound`
  (`:414`) y sus tres puntos de honra (`:447`, `:471`, `:508`, `if (!(await
  reserveReplyToInbound(db, args))) …`), y el `round_robin` con
  `rpc('pick_available_agent', { p_account_id: args.automation.account_id })` (`:586`);
- fase 2: la lectura del paso encolado acotada por cuenta (`:169`), más las ~15
  `.eq('account_id', args.automation.account_id)` que ya venían de una y otra rama.

`src/lib/automations/engine.test.ts` (que fase 1 amplió) pasa entero.

### 4. `src/app/api/whatsapp/webhook/route.test.ts`

Las dos fases añadieron un `describe` al final del archivo. Mismo caso que el SQL:
conflicto de posición, resuelto **cerrando el `describe` de fase 1** (el `  })` / `})`
final era línea común) y pegando a continuación el de fase 2.

Quedan los dos:

- fase 1 — `inbound webhook: automations run before the AI (fase 1, §4)`: `dispatches AND
  awaits every automation before dispatchInboundToAiReply` y `hands the AI the inbound id
  the automations were given, so both reserve the same row` (el `inbound_message_id`);
- fase 2 — `webhook GET verification: platform token short path`: los 8 `it` del token de
  plataforma (f2.4), incluidos `vi.stubEnv('META_WEBHOOK_VERIFY_TOKEN', '')` y el de
  espacios en blanco.

El arnés (`h.state`) auto-fusionó bien: convive el `configVerifyTokens` / `fromCalls` de
fase 2 con el `automationsCompletedAtAiDispatch` de fase 1. La única línea de fase 2 que
**no** sobrevive es `h.dispatchInboundToAiReply.mockResolvedValue(undefined)`, sustituida
por el `mockImplementation` de fase 1 que cuenta cuántas automatizaciones habían terminado
en el momento del despacho — es el reemplazo deliberado de fase 1, no una pérdida: sin él
el test de orden no puede existir. Verificado corriendo el archivo: **62 tests en verde**
junto a `engine.test.ts`.

## Auditoría: la suite de fase 2 sobre el código de fase 1

`src/lib/security/tenant-isolation.test.ts` + `service-role-audit.ts` pasan **sin cambios
ni waivers nuevos**: 61 tests (52 de aislamiento + 9 de la auditoría), verdes a la primera
sobre el árbol fusionado. El archivo de la suite es byte a byte el de
`saas/fase-2-seguridad` (comprobado con `git diff --no-index`).

**No hubo nada que arreglar, pero el verde no basta como prueba**, y conviene decir por
qué. Instrumenté el `afterEach` para volcar `h.db.log` y miré qué consultas ve de verdad el
test del webhook (`an inbound on A's number lands in A's conversation…`): la
fan-out que recorre es `whatsapp_config` → `contacts` → `conversations` → `messages` →
`rpc:bump_conversation_on_inbound` → `broadcast_recipients` → el motor de **flujos**
(`flow_runs`, `flow_run_events`, `flow_nodes`, `flows`). En esa semilla hay un run de flujo
activo que consume la respuesta, así que **el despacho de automatizaciones y el de IA no
llegan a ejecutarse**: `inbound_auto_replies`, `ai_configs` y `pick_available_agent` no
aparecen en el registro. La instrumentación se revirtió (el archivo quedó idéntico al de
fase 2).

Es decir: la suite no auditó el código nuevo de fase 1 en esa ruta. Así que hice **la
revisión a mano** de todas las consultas con rol de servicio que fase 0/1 introdujo
(`git diff --name-only main...96e02fa`, 26 archivos de `src` sin tests), con el mismo
criterio que aplica `service-role-audit.ts`:

| Sitio | Consulta | Ámbito |
|---|---|---|
| `src/lib/automations/reply-marker.ts:48` | `upsert` en `inbound_auto_replies` | `account_id` **en el payload** ✅ |
| `src/lib/automations/reply-marker.ts:110` | `select` del titular de la reserva | `.eq('message_id')` **y** `.eq('account_id')` ✅ |
| `src/lib/ai/auto-reply.ts:67` | `select` de `conversations` | `.eq('id')` + `.eq('account_id', accountId)` ✅ |
| `src/lib/ai/auto-reply.ts:204` | `update` de `conversations` (handoff) | `.eq('account_id', accountId)` ✅ |
| `src/lib/ai/auto-reply.ts:313` | `rpc('pick_available_agent')` | argumento `p_account_id` ✅ |
| `src/lib/ai/auto-reply.ts:363` | `rpc('increment_usage')` | argumento `p_account_id` ✅ |
| `src/lib/automations/engine.ts:586` | `rpc('pick_available_agent')` (round_robin) | `p_account_id: automation.account_id` ✅ |
| `src/lib/automations/engine.ts:597` | `update` de `conversations` (asignación) | `.eq('account_id', …)` ✅ |
| `src/lib/ai/usage.ts:43` | `insert` en `ai_usage_log` | `account_id` en el payload ✅ (y **sí** lo audita la suite, vía `/api/ai/draft`) |
| `src/lib/ai/config.ts:42,119` | `select` de `ai_configs` | `.eq('account_id', accountId)` ✅ |
| `src/lib/billing/entitlements.ts:179,234` | `select` de `subscriptions` y `usage_counters` | `.eq('account_id', accountId)` ✅ |
| `src/lib/billing/entitlements.ts:193` | `select` de `plans` por `id` | `plans` es catálogo global, no tiene `account_id` — no es tabla de inquilino |
| `src/app/api/automations/engine/route.ts` | — | borra `context.inbound_message_id` del cuerpo antes de despachar (fuga ya cerrada en f1.4) |

**Conclusión: fase 1 no introdujo ninguna consulta de rol de servicio sin ámbito de
cuenta.** Por eso no hay commit `fix:`.

Un único punto sin `account_id` en toda la ruta de IA, `db.rpc('claim_ai_reply_slot', {
conversation_id, max_replies })` (`auto-reply.ts:262`), **es preexistente**: está en `main`
(`git show main:src/lib/ai/auto-reply.ts`) y su función viene de las migraciones 029/031,
mucho antes del programa. El `conversation_id` que recibe sale de la lectura de
`conversations` de la línea 67, que sí está acotada por cuenta. No lo toco: queda anotado
como deuda, porque si esa ruta llegara a auditarse tal cual la auditoría lo marcaría (pide
un argumento `*account_id` en todo `rpc`).

## Compuerta

En el worktree `.claude/worktrees/integracion`, en el orden de CI, sobre el árbol
fusionado y antes del commit:

| Paso | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 37 warnings (la línea base exacta de las dos ramas; ninguno nuevo) |
| `npm run typecheck` | **verde** — `tsc --noEmit` sin salida |
| `TZ=UTC npm test` | **verde** — **99 archivos, 1 168 tests** (fase 1 traía 93/1 022; fase 2 aporta 6 archivos y los suyos) |
| `npm run build` (4 dummies de `docs/harness.md`) | **verde** — compila y lista las rutas |
| `scripts/replay-migrations.sh "$(pwd)"` | **exit 0** — aplica 001…039, **040, 041, 042, 043, 044, 047, 051** en orden y `verify-schema.sql: OK` |

El replay es la prueba de que la resolución del SQL es correcta: si el `END IF;` extra
faltara, el `DO $$` ni siquiera compilaría; si se hubiera perdido un bloque de aserciones,
el verify pasaría igual pero por la razón equivocada — por eso además se comprobó a ojo que
las 32 aserciones (28 + 4) están todas en el archivo final.

### Prettier

`src/lib/automations/engine.ts` y `src/app/api/whatsapp/webhook/route.test.ts` **no** pasan
`prettier --check`, y **tampoco lo pasaban en ninguna de las dos ramas padre** (verificado
con `git show <rama>:<archivo> | npx prettier --stdin-filepath … --check`: los dos salen
marcados en `96e02fa` y en `saas/fase-2-seguridad`). Deuda preexistente de las dos fases;
un `prettier --write` reescribiría los archivos enteros y ahogaría la resolución del merge
en ruido. Se editaron en su estilo local, que es lo que hicieron los implementadores de
ambas fases. `CHANGELOG.md` sí pasa `--check`.

## Verificaciones manuales pendientes

Ninguna nueva de la integración. Las que ya arrastran las fases (Meta: adjuntos privados
saliendo por media id, rotación de `ENCRYPTION_KEY` en un despliegue real; PayPal, de fase
3) siguen en sus informes respectivos — la integración no cambia su guion.

Lo que sí conviene recordar al desplegar, porque ahora las dos notas viven en el mismo
`Unreleased`: **044 se aplica al final**, después de 040–043, 047 y 051 y después de
confirmar que los adjuntos salientes llegan.

## Variables de entorno

Ninguna nueva por la integración. Las de fase 2 (`ENCRYPTION_KEY_PREVIOUS`,
`META_WEBHOOK_VERIFY_TOKEN`) ya venían documentadas en `docs/docker.md` y `docs/security.md`,
que auto-fusionaron sin conflicto. `.env.local.example` no se tocó (bloqueado por permisos).

## Deuda detectada, fuera de alcance (no arreglada)

1. **`claim_ai_reply_slot` sin `account_id`** (`src/lib/ai/auto-reply.ts:262`).
   Preexistente a todo el programa. Es seguro hoy porque el `conversation_id` sale de una
   lectura acotada, pero es el único `rpc` de la ruta de IA que la auditoría marcaría.
   Arreglo natural: un `p_account_id` en la firma (migración nueva) o un waiver razonado.
2. **La suite de aislamiento no cubre la ruta de auto-respuesta.** En la semilla de
   `tenant-isolation.test.ts` un run de flujo activo consume el entrante, así que el
   webhook nunca llega al despacho de automatizaciones ni al de IA: `inbound_auto_replies`,
   `ai_configs` y `pick_available_agent` quedan fuera de la propiedad del `afterEach`. La
   revisión de arriba se hizo a mano porque la suite no puede hacerla. Cerrar el hueco es
   un caso nuevo (un entrante en una conversación **sin** run de flujo activo, con IA
   activa y una automatización de `keyword_match`) y merece su propia feature; añadirlo
   aquí habría sido meter una prueba nueva en un merge.
3. **El párrafo de cabecera de `Unreleased`** sigue diciendo «Fase 0 … **No user-visible
   behaviour changes**» cuando la sección ya recoge fases 1 y 2, con cambios bien visibles.
   Venía así de la rama de fase 1. Es redacción para cuando se corte la versión.
4. **Los dos archivos fuera de prettier** (`engine.ts`, `webhook/route.test.ts`) y los 37
   warnings de ESLint: preexistentes en las dos ramas.
