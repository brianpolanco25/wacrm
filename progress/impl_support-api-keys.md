# impl_support-api-keys

Rama `feat/support-api-keys`. Sin migración.

## Qué cambió
- `support-scope.ts`: `/api/account/api-keys` sale de `SUPPORT_SESSION_BLOCKED` (verdict `record`). Billing, ownership, members, invitations, webhooks y sesión anidada siguen en `block`.
- Rutas `api-keys` (GET, POST, DELETE `[id]`, POST `[id]/rotate`): sin `assertNotSupportSession`. En soporte usan service role (`apiKeysDb`, `src/lib/api-keys/support-trace.ts`) porque `api_keys` sigue cerrada por RLS (072); siempre filtran `account_id = ctx.accountId` (cuenta impersonada).
- Auditoría: `labelSupportAction` ANTES de escribir, fila `impersonation_actions` con `<path> · api_key.create|revoke|rotate · <prefijo|uuid>` (nunca la clave); si falla, 503 y no escribe. Actor = operador (columna `actor_user_id` de la sesión).
- Atribución sin migración: `created_by` ya guarda al operador; GET marca `created_by_support` (consulta `platform_admins`) y no expone ids; UI muestra «created by support» / «creada por soporte» (`messages/en.json`, `es.json`).
- Texto del bloqueo (middleware y `account.ts`): «billing, ownership and team members stay with the customer». Estaba hardcodeado en inglés; no hay copia en `messages/`.
- Docs: `docs/security.md`.
- UI: `api-keys-settings.tsx` ya dejaba crear/revocar (rol efectivo `admin` en soporte); solo se añadió la etiqueta.

## Tests
| Criterio | Test |
|---|---|
| Crear permitido, auditado, sin clave en el rastro | `api-keys/support-session.test.ts` «mints the key…» |
| Sin rastro no hay escritura | «writes nothing when the trail cannot be saved (503)» |
| Revocar auditado y aislamiento entre empresas | «revokes only the impersonated account key…» |
| Atribución a soporte, sin fuga | «lists the account keys, flagging…» |
| Billing/ownership/members/invitations/webhooks siguen bloqueados; api-keys `record` | `support-session.test.ts` (verdicts), `support-scope.test.ts` |
| Ajustados | `middleware.test.ts` y `support-scope.test.ts` (quitadas las filas de api-keys de «bloquea») |
| RLS intacto | 072 no tocada; `support-session-view.test.ts` sigue verde |

## Compuerta
`npm run lint && npm run typecheck && TZ=UTC npm test` verde (6372 passed, 7 skipped; una corrida mostró 1 fallo intermitente, no reproducible en 3 reruns); `npm run build` con las variables dummy de ci.yml OK.

## Desvíos
- Rotar (`/rotate`) también queda permitido en soporte (es crear+revocar). Si no se quiere, hay que añadir un matcher por sufijo en el middleware.
- La revocación audita el uuid de la clave (no el prefijo) para no añadir una lectura previa.
- `created_by` del operador se identifica como soporte por pertenecer a `platform_admins`.
- El middleware seguía mostrando el texto sin API keys solo para los bloqueos restantes.
