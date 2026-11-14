# Review — n13.6 integrations-support-manage

**Veredicto:** APPROVED

Rama `feat/integrations-support-manage`, commit `7bc2fd2` sobre `main @ 6e5b819`. 22 archivos; el diff coincide con el informe.

## Compuerta
- lint / typecheck / test / build: verde (ejecutada por el reviewer en el worktree, variables dummy; lint 0 errores / 34 warnings preexistentes; `TZ=UTC npm test` 364 archivos, 5586 tests; build exit 0)
- replay-migrations: n/a (sin SQL)

## Trazabilidad criterio ↔ test
- A1 «soporte: PUT/PATCH/DELETE/POST test dejan de dar 403, fila en impersonation_actions con acción + slug, sin credencial ni last4»: [x]
  - `src/app/api/account/integrations/[integrationId]/route.test.ts` › "n13.6: 200 inside a support session, with an integration.enable row and no credential" (comprueba fila `… · integration.enable · health`, `not.toContain(CRED)` y `not.toContain('1234')` = last4 de `CRED`), "…integration.ai_settings row", "…integration.disable row" (sin last4), "labels the row the middleware-tagged request already has" (no duplica), "503 and no write when the trail cannot be recorded" (falla cerrado), "a 400 … writes nothing and labels nothing", "404 for an id that is not in the catalogue, without a trail row", "no trail row outside a support session".
  - `…/[integrationId]/test/route.test.ts` › "n13.6: 200 inside a support session, with an integration.test row and no credential" (sin `CRED_A` ni `7777`).
  - `src/middleware.test.ts` › "n13.6: lets %s %s through, tagged to be recorded" (4 casos); `src/lib/auth/support-scope.test.ts` › "records %s %s" (4 casos nuevos, retirados de la lista bloqueada).
- A2 «GET canManage = true en soporte; UI con controles y aviso es/en»: [x] `src/app/api/account/integrations/route.test.ts` › "n13.6: canManage is true inside a support session, and supportSession says so", "supportSession is false outside…"; `src/components/settings/integrations-settings.test.tsx` › "n13.6: a support session manages, with a notice that it is recorded" (recorre es y en, comprueba texto del catálogo y botones), "no support notice for the customer’s own admin". Clave `Settings.integrations.supportNotice` en ambos catálogos.
- A3 «CP3: soporte sobre A no toca B»: [x] `src/lib/security/tenant-isolation.test.ts` › "(10, n13.6) a support session over A manages the integration of A and never touches the row of B" — cookie firmada real, operador = owner de B, GET/PUT/PATCH/test/DELETE; fila de B idéntica byte a byte, `expectBUnchanged`, 4 filas de traza bajo A/LOG sin credencial ni last4.
- A4 «rol < admin → 403, plan sin integrations → 402 intactos; spec/docs/CHANGELOG»: [x] casos `403 for agent/viewer` y `402 without the plan feature` siguen en PUT/PATCH/DELETE/test; `specs/integrations-catalog/requirements.md` (D3 revertida), `docs/security.md`, `CHANGELOG.md` Unreleased.
- Verificación manual: guion en el informe (pasos 1–4). Sin base real necesaria (sin migración).

## Checkpoints
- CP1: [x] compuerta verde, ejecutada por mí.
- CP2: [x] n/a, sin SQL.
- CP3: [x] escrituras/lecturas de `account_integrations` siguen filtradas por `ctx.accountId` (en soporte = cuenta impersonada); `labelSupportAction` actualiza con `.eq('account_id', session.accountId).eq('log_id', …)` e inserta bajo `session.accountId`; `findIntegrationSlug` lee el catálogo global `integrations` (sin `account_id` por diseño). Test de fuga A/B nuevo.
- CP4: [x] ver trazabilidad.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] `supportNotice` en es/en, sin placeholders.
- CP7: [x] solo `headers()` / `unstable_rethrow` ya usados en el módulo; nada nuevo de framework.
- CP8: [x] sin cambios en `src/lib/integrations/execute.ts` ni en el modelo del catálogo (solo se añade `slug` al select de `findActiveIntegration`). Corrección de `accountCtx` en test-support justificada (forma de `SupportSession`).
- CP9: [x] CHANGELOG, informe coincide con diff; sin variables nuevas.
- CP10: [x] un commit en español con `feat:` y `Co-Authored-By`; sin push; árbol limpio.
- CP11: [x] no toca el webhook.

## Hallazgos (no bloqueantes; code-review high + manual)
1. `src/lib/integrations/support-trace.ts:48` — la fila se etiqueta antes de escribir y no se le estampa `status`; un DELETE/PATCH/test sobre una integración que la cuenta nunca activó (404 posterior) o un 429 del test deja `· integration.disable · …` con `status NULL`, legible como éxito. Decisión documentada en el informe; sugerencia: llamar a `markSupportActionStatus(ctx.impersonation, 404|429)` en esas salidas.
2. `src/lib/auth/support-actions.ts:225` — el insert de respaldo usa `request_id: null` aunque `write.requestId` exista (caso update con 0 filas). En producción no debería ocurrir (`resolveSupportSession` ya escribió la fila, falla cerrado), pero un `upsert` con `request_id = write?.requestId ?? null` evitaría dos filas para una petición.
3. `src/app/api/account/integrations/[integrationId]/route.ts:161` — ajustes de IA y credencial pegados por soporte sobreviven a la sesión (el motivo por el que webhooks/api-keys siguen bloqueados). Aceptado por decisión explícita del humano; se deja constancia.
4. `src/lib/integrations/account.ts:205` — `findIntegrationSlug` duplica `findActiveIntegration` salvo el filtro `is_active`; unificable.
5. `src/lib/integrations/support-trace.ts:37` — recibe `db` pero `labelSupportAction` crea su propio `supabaseAdmin()`; firma engañosa.
6. Acción/slug codificados en `path` (` · `) en vez de columnas; ya anotado como deuda en el informe.

## Cambios requeridos
Ninguno bloqueante. 1 y 2 recomendados como seguimiento.
