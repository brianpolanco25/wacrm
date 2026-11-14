# impl n13.6 integrations-support-manage

## Plan
1. Middleware: sacar `/api/account/integrations` de `SUPPORT_SESSION_BLOCKED` (pasa a `record`).
2. `support-actions.ts`: helper `labelSupportAction(session, {method, path, action, detail})` que
   anota la fila `http` de la petición con la acción y el slug (o la inserta si no hay etiqueta);
   falla cerrado (`SupportAuditError`, 503) — sin traza no hay escritura.
3. Rutas PUT/PATCH/DELETE y POST test: quitar `assertNotSupportSession`; en sesión de soporte,
   resolver el slug y anotar la acción antes de escribir. Nunca la credencial ni last4.
4. GET: `supportSession: boolean`; `canManage = admin+` (también en soporte).
5. UI: aviso `supportNotice` con `supportSession && canManage`; i18n es/en.
6. Tests: rutas (soporte → 200 + fila), support-scope, middleware, UI, CP3 en tenant-isolation.
7. Docs: spec D3/R32, docs/integrations/cabbity-health.md si aplica, CHANGELOG.

## Resultado

- Rama: `feat/integrations-support-manage` (worktree `.claude/worktrees/integrations-support-manage`), desde `main @ 6e5b819`.
- Commit: `7bc2fd2 feat: el soporte de plataforma gestiona las integraciones del cliente con traza (n13.6)`. Sin push.
- Compuerta: `npm run lint` (0 errores; 34 warnings preexistentes, ninguno en archivos tocados) · `npm run typecheck` verde · `TZ=UTC npm test` 364 archivos / 5586 tests verdes · `npm run build` (variables dummy) salida 0. Sin SQL, no aplica `replay-migrations.sh`.

## Qué cambió

- `src/lib/auth/support-scope.ts`: `/api/account/integrations` sale de `SUPPORT_SESSION_BLOCKED`; el middleware ya no lo bloquea, lo etiqueta (`record`) y `resolveSupportSession` escribe la fila `http` como en cualquier otra escritura de soporte.
- `src/lib/auth/support-actions.ts`: `labelSupportAction()` + `labelledSupportPath()`. Anota la fila de la petición (por `request_id` + `account_id` + `log_id`) con `<path> · <acción> · <slug>`; si la petición no trae etiqueta, inserta la fila ella misma. Falla cerrado: `SupportAuditError` (503) y la ruta no escribe.
- `src/lib/integrations/support-trace.ts` (nuevo): `traceIntegrationSupportAction()`; fuera de soporte no hace nada; dentro resuelve el slug (`findIntegrationSlug`, nuevo en `src/lib/integrations/account.ts`; `findActiveIntegration` ahora también devuelve `slug`) y anota antes de escribir. Id inexistente en el catálogo → 404 sin traza.
- Rutas `[integrationId]/route.ts` (PUT/PATCH/DELETE) y `[integrationId]/test/route.ts`: sin `assertNotSupportSession`; trazan `integration.enable` / `.ai_settings` / `.disable` / `.test`. Rol < admin y plan sin `integrations` intactos.
- `GET /api/account/integrations`: `canManage = admin+` (en soporte el rol efectivo es `admin`) y nuevo `supportSession: boolean`.
- UI `src/components/settings/integrations-settings.tsx`: con `canManage && supportSession`, aviso `Settings.integrations.supportNotice` (`role="note"`, `data-support-notice`), es/en.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| A1 PUT en soporte 200 + fila `integration.enable` + slug, sin credencial ni last4 | `src/app/api/account/integrations/[integrationId]/route.test.ts` › `n13.6: 200 inside a support session, with an integration.enable row and no credential` |
| A1 la fila etiquetada por el middleware se anota, no se duplica | ídem › `n13.6: labels the row the middleware-tagged request already has, instead of adding one` |
| A1 sin traza no hay escritura (503) | ídem › `n13.6: 503 and no write when the trail cannot be recorded` |
| A1 400 en soporte no escribe ni traza | ídem › `n13.6: a 400 in a support session writes nothing and labels nothing` |
| A1 PATCH → `integration.ai_settings` | ídem › `n13.6: 200 inside a support session, with an integration.ai_settings row` |
| A1 DELETE → `integration.disable`, sin last4 | ídem › `n13.6: 200 inside a support session, with an integration.disable row` |
| A1 id fuera del catálogo → 404 sin traza | ídem › `n13.6: 404 for an id that is not in the catalogue, without a trail row` |
| A1 sin soporte, sin fila de traza | ídem › `no trail row outside a support session`; `test/route.test.ts` › `no trail row outside a support session` |
| A1 POST test → `integration.test`, sin credencial ni last4 | `src/app/api/account/integrations/[integrationId]/test/route.test.ts` › `n13.6: 200 inside a support session, with an integration.test row and no credential` |
| A1 middleware deja pasar y etiqueta | `src/middleware.test.ts` › `n13.6: lets %s %s through, tagged to be recorded` (PUT/PATCH/DELETE/POST test); `src/lib/auth/support-scope.test.ts` › `records %s %s` (4 casos nuevos) |
| A1 formato y límite de 2048 del path | `src/lib/auth/support-actions.test.ts` › `labelledSupportPath (n13.6)` (2 casos) |
| A2 GET `canManage=true` + `supportSession` | `src/app/api/account/integrations/route.test.ts` › `n13.6: canManage is true inside a support session, and supportSession says so`, `supportSession is false outside a support session` |
| A2 UI controles + aviso es/en | `src/components/settings/integrations-settings.test.tsx` › `n13.6: a support session manages, with a notice that it is recorded`, `no support notice for the customer’s own admin`; paridad de claves › `es and en have the same keys and placeholders` |
| A3 CP3 | `src/lib/security/tenant-isolation.test.ts` › `(10, n13.6) a support session over A manages the integration of A and never touches the row of B` (operador = owner de B, cookie firmada real sobre A; GET/PUT/PATCH/test/DELETE; fila de B byte a byte igual; 4 filas de traza bajo A y su `log_id`; sin credencial; auditoría de consultas sin `account_id` vacía) |
| A4 rol < admin → 403, plan sin integrations → 402/403 | tests existentes intactos en los tres `route.test.ts` |

## Verificaciones contra base real

No aplica: sin migración ni RPC nuevos; la tabla `impersonation_actions` (072) ya existe y solo se usan `insert`/`update` con columnas existentes (el `path` cabe en el CHECK de 1–2048, acotado en `labelledSupportPath`).

## Verificación manual pendiente (guion)

1. Como operador de plataforma, abrir sesión de soporte sobre una cuenta con `integrations` en el plan.
2. Ajustes → Integraciones: se ve el aviso «Actúas como soporte…» y los botones.
3. Activar Cabbity Health pegando la credencial, Probar, activar «Usar en IA», Desactivar.
4. Panel de plataforma → la cuenta → actividad de soporte: cuatro filas cuyo `path` termina en `· integration.enable · cabbity-health`, `· integration.test · …`, `· integration.ai_settings · …`, `· integration.disable · …`; ninguna contiene la credencial ni sus últimos 4.

## Decisiones donde el spec era ambiguo

- **Dónde va la acción y el slug.** `impersonation_actions` no tiene columna de acción/detalle y la orden fue «sin migración». Se anexan al `path` de la fila `http` de la petición (`<path> · <acción> · <slug>`), que el panel de plataforma ya muestra tal cual. Si el humano prefiere columnas propias (`action`, `detail`), es una migración aparte.
- **Momento de la traza.** Se anota ANTES de escribir (tras validar entrada y localizar la integración) y falla cerrado (503), coherente con «sin bitácora no hay acción» de s9.5. Un 404 posterior (p. ej. desactivar algo que la cuenta nunca activó) deja la fila anotada: registra el intento, igual que las filas `http` existentes, que nacen antes de que la ruta responda.
- **Petición sin etiqueta del middleware** (no debería pasar en producción): el helper inserta la fila él mismo (`request_id` NULL) en vez de fallar.
- `accountCtx(..., { impersonated: true })` de `integrations.test-support.ts` tenía una forma de sesión incorrecta (`operatorId`); corregida a `SupportSession` (`actorUserId`, `logId`, `expiresAt`).
- `tenant-isolation.test.ts`: `impersonation_actions: []` declarada en la semilla para que la primera fila de traza no aparezca como tabla nueva en el snapshot de B.

## Docs

- `specs/integrations-catalog/requirements.md`: D3 tachada «Revertida por n13.6», alternativa vigente; R14 y R32 anotados; paso 4 del guion manual actualizado.
- `docs/security.md`: párrafo de credenciales actualizado (D3 revertida, traza, 503).
- `docs/integrations/cabbity-health.md`: no menciona la restricción; sin cambios.
- `CHANGELOG.md` (Unreleased): entrada nueva; y la línea de n13.3 «outside support sessions» corregida.

## Variables de entorno nuevas

Ninguna.

## Deuda fuera de alcance

- `specs/integrations-catalog/design.md` (líneas ~145, 201, 437) y `tasks.md` T9 siguen describiendo el bloqueo D3 como diseño histórico de n13.1; no se tocaron.
- `assertNotSupportSession` conserva su mensaje genérico («billing, ownership, team members and API keys…»), ya no aplica a integraciones; sin cambio.
- Si se quiere filtrar/consultar la bitácora por acción, convendría una columna `action`/`detail` en `impersonation_actions` (migración).
