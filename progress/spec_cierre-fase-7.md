# Spec a7.8 — cierre de deudas baratas de la fase 7

Rama `chore/cierre-fase-7`, worktree `.claude/worktrees/cabos`, base `main` @ 9c8d5d9 (fase 7 ya en
producción). Origen: `progress/impl_integracion-api-4.md` §«Deudas abiertas al cerrar la fase». De esa
lista ya estaban cerradas en `main` las nº 1, 4 y 5 (test de `ExportTooLargeError`, cubo `exports`
cobrado tras resolver la conversación, `Content-Disposition` saneado). Las nº 2, 3, 6, 9 y 13 son
diseño o producto y quedan fuera. Esta feature cierra el resto. **Sin migraciones. Sin dependencias
nuevas. Sin tocar `progress/current.md` ni `feature_list.json`** (los lleva el líder).

## Alcance

1. **Tope de cuerpo en `/api/account/api-keys`.** `POST /api/account/api-keys` y
   `POST /api/account/api-keys/{id}/rotate` leen con `request.json()` sin tope. Deben leer con
   `readJsonBody` de `src/lib/api/v1/body.ts` (1 MiB → 413, Content-Type → 415, JSON inválido → 400) y
   traducir el `ApiError` que lanza al sobre `{ error }` de `/api/account` con su `status` (mira
   `toErrorResponse` en `src/lib/auth/account.ts`; puede bastar con capturar `ApiError` en la ruta o
   enseñárselo a `toErrorResponse`). Comportamiento con cuerpo vacío: el de hoy (equivale a `{}`),
   así que usa `allowEmpty: true` o el equivalente. Tests: 413 con 1 MiB + 1, 415 con `text/plain`,
   y que el camino feliz no cambia.
2. **`PATCH /api/conversations/{id}` valida el destinatario.** Si `assigned_agent_id` no es `null`,
   debe ser miembro de la cuenta: fila de `profiles` con `id = assigned_agent_id` y
   `account_id = ctx.accountId` (la pertenencia vive en `profiles.account_id` + `account_role`, no
   hay tabla `account_members`). Si no lo es → 400 `"'assigned_agent_id' is not a member of this
   account"`, sin UPDATE y sin evento `conversation.assigned`. Comprueba si `assignConversation` de
   `src/lib/conversations/status-events.ts` la usa también `/api/v1` (si hay una ruta v1 que asigna,
   aplícale la misma guarda con `fail('bad_request', …)` o `validation_error` según lo que ya use esa
   capa). Tests: miembro OK, ajeno → 400, `null` desasigna.
3. **Tests 413/415 en `PATCH /api/v1/webhooks/{id}`.** La ruta ya usa `readJsonBody`; falta la
   prueba por ruta (como en `src/app/api/v1/webhooks/route.test.ts` L179–206). Crea
   `src/app/api/v1/webhooks/[id]/route.test.ts` con al menos: 413 sin escribir nada, 415 con
   `text/plain`, y el camino feliz de un PATCH mínimo.
4. **Test propio de `src/app/api/whatsapp/templates/sync/route.ts`.** Cubre: sin sesión/rol → 401/403,
   éxito con Meta simulada (mock de `fetch` o del cliente que use), y que el error de Postgres no se
   filtra al cliente (es lo que arregló el commit «no filtrar el texto de Postgres en el sync de
   plantillas», 80e0e9d — mira su diff para saber qué rama probar).
5. **`stripComments` del test de cobertura** (`src/lib/api/v1/openapi/document.test.ts`) borra un `//`
   dentro de una cadena. Hazlo consciente de comillas (simples, dobles y backticks) o sustitúyelo por
   una estrategia que no dependa de quitar comentarios. Añade un caso que lo demuestre.
6. **MCP: versión y catálogo.** `mcp-server/src/index.ts` declara `VERSION = '0.1.0'` y
   `mcp-server/package.json` dice `0.1.1`: léela del `package.json` en tiempo de ejecución
   (`createRequire(import.meta.url)` o `import … with { type: 'json' }`; `tsconfig` ya tiene
   `resolveJsonModule`, `module: NodeNext`) y quita el comentario «kept in sync manually». Comprueba
   que `npm run build` del paquete `mcp-server/` sigue pasando (`cd mcp-server && npm run build`, sin
   instalar nada nuevo; si `node_modules` no está, dilo en el informe y no instales). En
   `docs/mcp.md` §«What it exposes» actualiza la lista a los grupos reales de
   `mcp-server/README.md` (tags, templates, exports, además de contactos, conversaciones, mensajes y
   difusiones); mantén `prettier --check docs/mcp.md` verde.

## Compuerta y entrega

`npm run lint && npm run typecheck && TZ=UTC npm test && npm run build` en el worktree (build con las
variables dummy de `ci.yml`, ver `docs/harness.md`). Un commit por punto (o por pareja de puntos
afines), mensaje imperativo en español como los del historial. Informe en
`progress/impl_cierre-fase-7.md` **dentro del worktree** (no en el checkout raíz): qué se cerró,
qué no y por qué, salida resumida de la compuerta, y una entrada en `CHANGELOG.md` bajo Unreleased
si el repo la usa así (mira las últimas entradas).
