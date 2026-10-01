# impl s9.13 `support-readonly-rpcs`

## Plan
1. Inventario de `.rpc(` en `src/` (navegador vs servidor) y clasificación contra `supabase/migrations`.
2. `SUPPORT_READ_RPCS` / `SUPPORT_BLOCKED_RPCS` en `src/lib/auth/support-scope.ts` (módulo sin imports, junto a `SUPPORT_WRITABLE_TABLES`); `guardReadOnly` deja pasar solo las de lectura, el resto sigue con `SUPPORT_REFUSED_ERROR`.
3. Tests en `src/lib/supabase/client.test.ts`: filter_contacts_by_tags pasa / touch_presence lanza; recorrido de `rpc('…')` del código de navegador; cada RPC permitida es `STABLE` + `SECURITY INVOKER` en su última definición; llamada de la página de contactos.
4. Verificación contra la réplica (`progress/checks_support-readonly-rpcs.sql`).
5. docs/security.md, CHANGELOG, compuerta, commit.

## Rama y commits
`platform/support-readonly-rpcs` (worktree `.claude/worktrees/support-readonly-rpcs`), base `feat/superadmin` @ 56d50eb.
- `9a99cbc` chore: prettier en `src/lib/supabase/client.ts` antes de tocarlo (solo formato; el archivo no estaba formateado).
- `88e9944` feat: RPCs de lectura permitidas durante la sesión de soporte (s9.13).

Sin migración.

## Inventario de `.rpc(`

### Navegador (archivos que importan `@/lib/supabase/client`, pasan por `guardReadOnly`)
| RPC | Llamada | Definición vigente | Clase | Acota por cuenta efectiva | Decisión |
|---|---|---|---|---|---|
| `filter_contacts_by_tags` | `src/app/(dashboard)/contacts/page.tsx:154` | 060 (antes 025): `LANGUAGE sql STABLE SECURITY INVOKER`, solo SELECT | lectura | Sí, por RLS (057 `can_read_account` en contacts/contact_tags) + ids de etiqueta de A (la página los carga con `.eq('account_id', accountId)` y poda el resto). Residual: ver abajo | **permitida** (`SUPPORT_READ_RPCS`) |
| `touch_presence` | `src/components/presence/presence-heartbeat.tsx:143` | 024: `plpgsql SECURITY DEFINER`, UPSERT en `member_presence` para `auth.uid()` | escritura | No: resuelve la cuenta desde el perfil del operador | **bloqueada** (`SUPPORT_BLOCKED_RPCS`) |

«Marcar notificaciones» no es una RPC: es `from('notifications').update`, ya rechazada por la guarda de tablas (`notifications` fuera de `SUPPORT_WRITABLE_TABLES`).

### Servidor (no pasan por `guardReadOnly`; fuera del alcance de la guarda, solo para el registro)
| RPC | Dónde | Definición | Clase | Durante la sesión |
|---|---|---|---|---|
| `transfer_account_ownership` | `api/account/transfer-ownership` | 018 plpgsql DEFINER | escritura | middleware bloquea la ruta + `assertNotSupportSession` |
| `set_member_role`, `remove_account_member` | `api/account/members/[userId]` | 018 plpgsql DEFINER | escritura | middleware bloquea + `assertNotSupportSession` |
| `redeem_invitation` | `api/invitations/[token]/redeem` | 073 plpgsql DEFINER | escritura | middleware bloquea `/api/invitations/` |
| `peek_invitation` | `api/invitations/[token]/peek` | 019 STABLE DEFINER | lectura (por hash de token) | GET, pasa; no depende de la cuenta |
| `bump_conversation_on_inbound` | webhook (`supabaseAdmin`) | 037 sql DEFINER | escritura | exento (CP11) |
| `platform_grant_operator`, `platform_revoke_operator` | `lib/platform/provisioning.ts` (`supabaseAdmin`) | 071 plpgsql | escritura | rutas `/api/platform/*` |
| `platform_account_list` | `lib/platform/accounts.ts` | 058 sql STABLE | lectura | consola de plataforma |
| `platform_metrics` | `lib/platform/metrics.ts` | 069 sql STABLE INVOKER | lectura | consola de plataforma |
| `claim_ai_reply_slot`, `pick_available_agent`, `match_ai_knowledge_semantic`, `match_ai_knowledge_fts` | `lib/ai/*` (servidor) | varias (`pick_available_agent` STABLE DEFINER con `p_account_id`; `match_*` INVOKER desde 032) | lectura/escritura | motor de IA, servidor |
| `increment_automation_execution_count`, `pick_available_agent` | `lib/automations/engine.ts` | DEFINER | escritura/lectura | servidor |
| `increment_flow_execution_count` | `lib/flows/engine.ts` | 012 sql DEFINER | escritura | servidor |
| `record_webhook_failure` | `lib/webhooks/queue.ts` | 028 | escritura | servidor |
| `increment_usage` | `lib/billing/enforce.ts` | 041 sql DEFINER | escritura | servidor |
| `create_broadcast_with_recipients` | `lib/whatsapp/broadcast-core.ts` | DEFINER | escritura | servidor |

Ninguna RPC de lectura de navegador toma `account_id` como argumento, así que no hubo que rechazar ninguna por ese motivo.

## Criterio ↔ test
| Criterio | Test |
|---|---|
| Con sesión, `rpc('filter_contacts_by_tags')` pasa | `src/lib/supabase/client.test.ts` › `the browser client during a support session` › `runs filter_contacts_by_tags — a STABLE, SECURITY INVOKER read (s9.13)` |
| Con sesión, `rpc('touch_presence')` (y cualquier no listada) se rechaza con el mensaje actual | idem › `refuses rpc %s — only the read-only allow-list runs` (`touch_presence`, `some_function_nobody_listed`) |
| Listas disjuntas | idem › `keeps the allow-list and the block-list apart` |
| Sin sesión, rpc igual que antes | `the browser client with no support session` › `runs any rpc exactly as before` |
| Ninguna `rpc('…')` del navegador sin decidir | `every rpc the browser makes is decided (s9.13)` › `finds the calls it is meant to police`, `names each function literally, so it can be decided`, `puts each one in SUPPORT_READ_RPCS or SUPPORT_BLOCKED_RPCS` |
| Cada permitida es lectura según su última migración | idem › `allows %s only because its latest migration is a STABLE, SECURITY INVOKER read` (sin INSERT/UPDATE/DELETE/TRUNCATE en el cuerpo, sin DEFINER) |
| El filtro por etiqueta de la página de contactos ya no cae en error durante la sesión | `the browser client during a support session` › `lets the tag filter of contacts/page.tsx through, with the call the page makes` (extrae la llamada de la página, la reproduce por el cliente guardado; fija además el filtro por `account_id` de la página) |

El mock de `rpc` en el test lee `this` (como `this.rest.rpc` de supabase-js) para que una guarda que la llamara sin enlazar falle en vitest.

Mutación comprobada: quitar `touch_presence` de `SUPPORT_BLOCKED_RPCS` hace fallar `puts each one in …`.

## Verificación contra base real
`KEEP=1 scripts/replay-migrations.sh .claude/worktrees/support-readonly-rpcs` → 001–074 ok, `verify-schema.sql: OK`. Después
`docker exec -i <contenedor> psql … < progress/checks_support-readonly-rpcs.sql` → `NOTICE: checks_support-readonly-rpcs: OK` (transacción con ROLLBACK; contenedor borrado al terminar). Comprueba:
0. En `pg_proc`: `filter_contacts_by_tags` STABLE y no DEFINER; `touch_presence` VOLATILE y DEFINER.
1. Operador (miembro de su empresa O) con sesión sobre A, con la etiqueta de A: devuelve exactamente los 2 contactos etiquetados de A, todos con `account_id = A`, `total_count = 2`; con búsqueda, el correcto.
2. Con la etiqueta de B: nada.
3. Contacto de B enlazado a la etiqueta de A, y combinando etiquetas de A, B y O: ningún contacto de B.
4. Sesión cerrada: nada de A.
5. Residual (ver decisiones): un contacto de O enlazado a la etiqueta de A sí sale del RPC.

## Decisiones donde el spec era ambiguo
- **Dónde viven las listas**: en `src/lib/auth/support-scope.ts` (módulo sin imports, junto a `SUPPORT_WRITABLE_TABLES`), importadas por `client.ts`. Es el mismo patrón de s9.5.
- **Lista de permitidas, no de bloqueadas**: la guarda deja pasar solo `SUPPORT_READ_RPCS`; `SUPPORT_BLOCKED_RPCS` es documental y existe para el test de «sin decidir». Una RPC nueva no listada se rechaza.
- **Residual de `filter_contacts_by_tags`**: no toma cuenta; la acotan la RLS y los ids de etiqueta. Durante la sesión la RLS de lectura responde «mis empresas ∪ A», y la política de `contact_tags` solo mira la cuenta del contacto, no la de la etiqueta. Así, un contacto de la empresa del OPERADOR enlazado a mano a una etiqueta de A (hace falta conocer su uuid) aparecería. No es una fuga hacia terceros (B nunca sale: el operador no lee B), pero se vería una fila suya bajo el banner del cliente. Lo cierro en la página: `contacts/page.tsx` descarta las filas con `account_id !== accountId`. En ese caso de datos corruptos, `total_count` podría contar de más. Lo permito igual porque la alternativa era seguir rompiendo el filtro.
- `presence-heartbeat.tsx` e `impersonation.ts`: solo comentarios actualizados (decían «refuses every rpc»).

## Verificaciones manuales pendientes
Ninguna obligatoria (no depende de Meta ni PayPal). Si se quiere ver en el navegador: con `npm run dev`, abrir una sesión de soporte sobre una cuenta con etiquetas, ir a Contactos, filtrar por una etiqueta → lista de la cuenta, sin el toast «No se pudieron cargar los contactos»; en la consola, ningún `support_session_forbidden` por `filter_contacts_by_tags`.

## Variables de entorno nuevas
Ninguna.

## Compuerta
`npm run lint` (0 errores; 34 warnings preexistentes, ninguno en archivos tocados) · `npm run typecheck` ok · `TZ=UTC npm test` 252 archivos / 3518 tests ok · `npm run build` con variables dummy ok · réplica 001–074 + verify-schema ok · checks SQL ok.

## Deuda fuera de alcance
- La política `contact_tags_modify` (017/072) no comprueba que la etiqueta sea de la misma cuenta que el contacto (el FK no pasa por RLS). Es lo que permite el residual de arriba, también fuera de las sesiones de soporte (enlaces entre cuentas si se conoce el uuid). Pediría un CHECK/trigger en una migración propia.
- `filter_contacts_by_tags` podría aceptar `p_account_id` y filtrar por él (con la RLS como límite), para no depender del filtro del cliente ni de `total_count`. Pediría una migración.
