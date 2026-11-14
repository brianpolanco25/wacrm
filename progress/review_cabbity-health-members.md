# Review — n15.4 cabbity-health-members

**Veredicto:** APPROVED

## Compuerta
- Corridos en el worktree: `npm run lint` (0 errores, 34 warnings heredados), `npm run typecheck` (ok), `TZ=UTC npm test` (411 archivos, 6327 tests ok, 7 omitidos), `npm run build` con las variables dummy de ci.yml (ok; `/api/v1/members` en el listado).

## Trazabilidad
- Aislamiento por `account_id`: [x] `route.ts` filtra `.eq('account_id', ctx.accountId)`; test con dos cuentas (`route.test.ts`: «lista solo los miembros de la cuenta…», «con la clave de la otra cuenta ve solo la suya», «nunca devuelve… datos de otra cuenta»).
- Sin datos sensibles: [x] SELECT explícito (`id, created_at, user_id, full_name, email, account_role`); test con `avatar_url` sembrado que no sale.
- Scope `members:read`: [x] `requireApiKey(request, 'members:read')`, test lo verifica; está en `API_SCOPES`, por lo que la UI de claves (`api-keys-settings.tsx` mapea `API_SCOPES`) lo ofrece al crear.
- Paginación keyset: [x] orden `created_at desc, id desc` coherente con `keysetFilter`; el filtro de cuenta se aplica siempre, así que un cursor no cruza cuentas; test de dos páginas.
- OpenAPI/fixtures: [x] operaciones 38→39, rutas 26→27 actualizadas; coverage, document, model, real-document y openapi.json en verde.
- Compatibilidad con Health 1.5.1 (D2): [x] `{data:[{id: user_id, full_name, email, role}], meta:{next_cursor}}` coincide con design §14 W5; `role` incluye `viewer` y Health decide no ofrecerlo (el filtrado es de su lado).

## Checkpoints
- CP1 [x] · CP2 n/a (sin SQL; scopes es `text[]` libre) · CP3 [x] · CP4 [x] · CP5 [x] (sin cambios en package.json) · CP6 n/a · CP7 n/a · CP8 [x] · CP9 [x] (CHANGELOG, docs e informe) · CP10 [x] (un commit en español, rama de la feature) · CP11 n/a

## Hallazgos (deuda, no bloquean)
1. `core.ts` en lugar de `reference.ts`: desvío justificado; ese archivo no lista scopes.
2. Nulos devueltos como `''`: aceptable (columnas NOT NULL).
3. El test de cursor usa el doble en memoria; la semántica real de `.or()` de PostgREST está cubierta por el helper compartido `keysetFilter`, usado ya por otras rutas.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
