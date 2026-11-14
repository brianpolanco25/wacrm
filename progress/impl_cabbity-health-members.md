# n15.4 cabbity-health-members (W5)

Rama `feat/cabbity-health-members` (desde main con n15.3). Sin migración (scopes = `text[]` libre).

## Contrato `GET /api/v1/members`

- Scope `members:read` (nuevo, en `API_SCOPES` y `SCOPE_DESCRIPTIONS`; aparece solo en la UI de claves).
- Sin scope: 403 (por `requireApiKey`).
- Paginado por cursor como el resto: `?limit` (1..100, 50) y `?cursor`; orden `created_at desc, id desc`.
- Respuesta: `{ "data": [{ "id": "<profiles.user_id>", "full_name": "...", "email": "...", "role": "owner|admin|agent|viewer" }], "meta": { "next_cursor": string|null } }`.
- `id` = `user_id` (el de `assigned_agent_id`). Solo perfiles con `account_id` = cuenta de la clave. SELECT explícito; nunca avatar, teléfono ni tokens.

## Cambios

route, `openapi/members.ts` (+ registro y tag en `document.ts`), fixture del reference, guías `core.ts` es/en (trece scopes + fila), `docs/public-api.md`, `docs/integrations/cabbity-health.md`, CHANGELOG. Conteos: operaciones 38→39, rutas 26→27, descubiertas 38→39 (coverage, model, real-document, openapi.json).

## Tests

`src/app/api/v1/members/route.test.ts`: forma y `user_id`, aislamiento entre dos cuentas, sin campos extra, scope pedido, paginación por cursor.

## Compuerta (en el worktree)

- `npm run lint`: 0 errores (34 warnings heredados)
- `npm run typecheck`: ok
- `TZ=UTC npm test`: 411 archivos ok, 6327 tests ok, 7 omitidos
- `npm run build` con las variables dummy de ci.yml: ok, `/api/v1/members` en el listado

## Desvíos

- La spec hablaba de `reference.ts` es/en: esos archivos no listan endpoints ni scopes; el texto de scopes vive en `content/developers/{es,en}/core.ts`, que es lo que actualicé. `reference.ts` sin cambios.
- `full_name`/`email` nulos se devuelven como `''` (columnas NOT NULL en BD; solo defensivo).
- No se tocó `mcp-server` (no expone members).
