# Review — f2.1 private-media (corrección)

**Veredicto: APPROVED**

## Evidencia

- Se leyeron `CLAUDE.md`, `AGENTS.md`, `CHECKPOINTS.md`,
  `docs/harness.md`, `docs/saas/fase-2-seguridad.md#1`, el informe de
  implementación, el review previo y todos los tests/guiones citados abajo.
- El `git log --oneline feat/saas-multiempresa..HEAD` contiene `526d9d0`
  (feature) y `3f105fe` (corrección), además de commits de las otras features
  de la fase. El `git diff feat/saas-multiempresa..HEAD --stat` confirma que
  el diff agregado de fase mezcla esas features; se contrastaron por separado
  `526d9d0` (28 archivos, 1.981 inserciones, 69 borrados) y `3f105fe` (4
  archivos, 66 inserciones, 20 borrados). La corrección cambia la política
  legacy, su test, `CHANGELOG.md` y el runbook, tal como declara el informe.
  `git diff --check` pasó y el worktree estaba limpio; no se hizo push, PR ni
  merge.
- **Compuerta:** PASS, ejecutada por el reviewer en el worktree:
  `npm run lint && npm run typecheck && TZ=UTC npm test &&` build con las
  cuatro variables dummy de `docs/harness.md`. Lint terminó sin errores (37
  warnings preexistentes); typecheck PASS; Vitest 84 archivos / 928 tests
  PASS; build Next 16.2.12 PASS.
- **Migraciones:** PASS. `scripts/replay-migrations.sh
  "/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a4220e4b5ba8896fd"`
  aplicó 001–039 y `044_private_media_buckets.sql`; `verify-schema.sql: OK`.
  Después ejecuté `progress/checks_private-media.sql` en ese Postgres local:
  PASS para el segundo miembro de A, B y `anon`.

## Trazabilidad de aceptación

| Criterio | Cobertura leída y resultado |
| --- | --- |
| A no descarga adjunto de B, autenticado ni por URL directa | La migración hace ambos buckets privados y limita SELECT a miembros en `supabase/migrations/044_private_media_buckets.sql:56-109`. El SQL ejecutado en `progress/checks_private-media.sql:13-75` verifica que B y `anon` no ven ninguno de los tres objetos de A. El guion manual de Storage en `docs/security.md:163-204` verifica además URL pública directa, intento de firma de B y descarga firmada. |
| Los miembros de A ven sus adjuntos | El SQL ejecutado, `progress/checks_private-media.sql:29-51`, inserta objetos actuales de ambos buckets y uno legacy, y prueba que el segundo miembro de A lee los tres. La corrección usa `is_account_member(legacy_uploader.account_id)` en la política legacy (`044_private_media_buckets.sql:83-87,103-107`), consistente con la función SECURITY DEFINER de `017_account_sharing.sql:136-167`. |
| Multimedia saliente sigue funcionando | `src/lib/whatsapp/outbound-media.test.ts:92-112,168-208,283-369` prueba descarga autorizada, subida y envío por id, rechazo antes de descargar datos de B y cabeceras de plantilla. `src/lib/whatsapp/meta-api.media.test.ts:80-100,123-150` prueba el payload `{ id }` y `POST /{phone_number_id}/media`. El guion de producción en `docs/security.md:141-156` exige comprobar inbox, Flow y broadcast en el teléfono antes de aplicar 044. |
| Adjuntos legacy siguen visibles | La prueba SQL ejecutada inserta `flow-media/<uid-del-uploader>/legacy-flow.txt` y confirma su lectura por otro miembro de A (`checks_private-media.sql:38-51`). `outbound-media.test.ts:180-208` también cubre el envío permitido/denegado de rutas legacy por el cliente de servicio. |
| URL firmada caduca con 403 | `src/lib/media/signed-url.test.ts:61-96,129-136` cubre TTL de 600 s y renovación previa. Para el comportamiento propio del servicio Storage, `docs/security.md:163-204` incluye un guion manual ejecutable que emite una URL de 1 s, comprueba 200 y exige 403 tras dos segundos; no se ejecutó contra un servicio externo por la prohibición de usar remoto. |

## Checkpoints

- **CP1 Compuerta:** PASS (ejecutada arriba por reviewer).
- **CP2 Migraciones:** PASS. 044 es reejecutable (`UPDATE` condicional y
  `DROP POLICY IF EXISTS` antes de crear políticas), no incorpora `CASCADE`,
  tiene aserciones de buckets/policies en
  `supabase/ci/verify-schema.sql:45-75`, replay PASS y SQL RLS ejecutado.
- **CP3 Aislamiento:** PASS. Todo nuevo acceso `supabaseAdmin()` para media
  verifica la ruta antes de descargar: consulta `profiles` con ambos
  `user_id` y `account_id` en `src/lib/whatsapp/outbound-media.ts:206-246`;
  la fuga A→B está probada en `outbound-media.test.ts:168-178`. Todos los
  llamadores pasan el `accountId` contextual (por ejemplo,
  `send-message.ts:345-373`, `flows/meta-send.ts:207-219` y
  `broadcast-core.ts:267-278`).
- **CP4 Tests / SQL / manual:** PASS. Se leyeron y ejecutaron los tests y SQL
  anteriores; el comportamiento de Meta y la expiración real de Storage tienen
  guiones manuales concretos.
- **CP5 Dependencias:** PASS; `package.json` y lockfile no cambian en el
  commit de la feature.
- **CP6 i18n:** N/A; no se añadió texto de UI ni claves de mensajes.
- **CP7 Next 16:** N/A; no se añadió una API de framework.
- **CP8 Alcance:** PASS; envío por media id, URLs firmadas, sus consumidores,
  RLS y el runbook corresponden al orden explícito del spec.
- **CP9 Documentación:** PASS; existen `progress/impl_private-media.md`, el
  changelog Unreleased y `docs/security.md`; no hay variables nuevas.
- **CP10 Git:** PASS; commits en `saas/fase-2-seguridad`, prefijo español y
  `Co-Authored-By`; ninguna rama remota contiene `HEAD`.
- **CP11 Entrante no bloqueado:** N/A; no se añadió lógica de facturación,
  cuotas o suspensión.

## Hallazgos

No hay hallazgos bloqueantes ni cambios requeridos. Se mantiene como deuda ya
documentada `docs/security.md:206-215`: la API pública aún devuelve la forma
almacenada de `media_url`; tras 044 un integrador necesitará una URL firmada
con alcance de cuenta o un proxy en una feature posterior.
