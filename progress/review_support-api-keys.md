# Review — support-api-keys

**Veredicto:** CHANGES_REQUESTED

## Compuerta
- Comandos corridos: `npm run lint && npm run typecheck && TZ=UTC npm test` (lint 0 errores/34 warnings; typecheck ok; 6372 passed, 7 skipped); `npm run build` con las variables dummy de ci.yml.
- Todo verde. Build OK.

## Seguridad (foco pedido)
- Service role acotado: `apiKeysDb(ctx)` solo usa `supabaseAdmin()` si `ctx.impersonation`; todas las consultas (GET, DELETE, rotate: lectura, insert, update y el delete de rollback) filtran `account_id = ctx.accountId`, que sale de la cookie firmada (`impersonatedContext`), no de parámetros. Sin IDOR en DELETE/rotate por id. Correcto.
- Bypass solo para sesión de soporte válida: `ctx.impersonation` solo lo produce `resolveSupportSession` (cinco comprobaciones); un miembro normal sigue con su cliente RLS. Correcto.
- Auditoría antes de escribir: `traceApiKeySupportAction` va antes del insert/update en POST, DELETE y rotate; el detalle es prefijo o uuid, nunca la clave; fallo → `SupportAuditError` 503 sin escritura (probado en create). Correcto.
- Bloqueos: billing, ownership, members, invitations, webhooks siguen en `block` (test); sesión anidada no tocada. Correcto.
- Token en claro solo en la respuesta 201 de POST/rotate, como antes. `created_by` no sale en el GET; `created_by_support` es un booleano; `platformAdminIds` consulta `platform_admins` solo por los `created_by` de las claves de la propia cuenta, sin fuga entre cuentas.
- RLS de `api_keys`: sin migración, 072 intacta.
- Rotar en soporte: aceptable. Equivale a crear+revocar con gracia de 24 h, auditado, acotado a la cuenta y con plan `api` exigido.

## Trazabilidad criterio ↔ test
- Crear permitido/auditado/sin clave: [x] `src/app/api/account/api-keys/support-session.test.ts` › «mints the key…»
- 503 sin rastro, sin escritura: [x] › «writes nothing when the trail cannot be saved (503)»
- Revocar auditado + aislamiento entre cuentas: [x] › «revokes only the impersonated account key…»
- Atribución sin fuga: [x] › «lists the account keys, flagging…»
- Siguen bloqueados / api-keys `record`: [x] › «what a support session still cannot do» y `support-scope.test.ts`
- Rotar en soporte (auditoría, aislamiento, 503): [ ] ← solo se prueba el veredicto `record` de la ruta; ningún test ejecuta el handler de rotate en sesión de soporte.

## Checkpoints
- CP1 [x] · CP2 n/a (sin SQL) · CP3 [ ] rotate usa service role sin test de fuga entre dos cuentas · CP4 [ ] mismo hueco · CP5 [x] · CP6 [x] (es/en) · CP7 n/a · CP8 [x] · CP9 [ ] `CHANGELOG.md` (Unreleased) sin actualizar · CP10 [x] · CP11 n/a

## Diseño
No se invocaron `evaluate`/`impeccable`: el cambio de UI es solo una etiqueta de texto («creada por soporte») en `api-keys-settings.tsx`, sin pantalla nueva; no se rechaza por esto.

## Hallazgos
1. `src/app/api/account/api-keys/[id]/rotate/route.ts` — ruta con service role en soporte sin test del handler (CP3/CP4). El código es correcto en la lectura, pero el pedido exige test de fuga.
2. `CHANGELOG.md` — falta entrada en Unreleased (CP9).
3. Deuda menor: la revocación audita el uuid antes de validar que pertenece a la cuenta (también anota intentos sobre uuid ajenos; es aceptable, deja rastro).

## Cambios requeridos
1. Añadir en `support-session.test.ts` un test del handler `POST [id]/rotate` en sesión de soporte: crea la clave nueva en la cuenta impersonada, estampa la vieja (gracia), deja una fila `api_key.rotate` con uuid y sin plaintext, devuelve 404 para la clave de otra cuenta sin tocarla, y 503 sin escrituras si falla el rastro.
2. Añadir la entrada en `CHANGELOG.md` (Unreleased).
