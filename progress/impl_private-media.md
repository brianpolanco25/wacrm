# Implementación — f2.1 private-media (corrección de review)

- **Rama:** `saas/fase-2-seguridad`
- **Commits de la feature:** `526d9d0` y `3f105fe`
- **Estado:** lista para nueva revisión; no se aplicó ninguna migración ni se
  llamó a Supabase remoto.

## Corrección aplicada

La política `044_private_media_buckets.sql` ahora resuelve la cuenta del
uploader en una ruta heredada `<uid>/…` y permite leer el objeto a cualquier
miembro de esa cuenta mediante `is_account_member`. Antes sólo podía leerlo el
uid que lo subió. Se actualizaron el changelog y la guía de seguridad para
reflejar ese comportamiento.

## Criterios y evidencia

| Criterio | Evidencia |
| --- | --- |
| A no descarga media de B, autenticado ni directo | `progress/checks_private-media.sql` crea A/A-miembro/B, cambia a los roles `authenticated` y `anon`, y falla si B o anon ven un objeto de A. El guion de `docs/security.md` comprueba la URL pública directa y la descarga/firma de B en Storage real. |
| Los miembros de la cuenta ven sus adjuntos | El mismo SQL confirma que el segundo miembro de A ve objetos actuales de `chat-media` y `flow-media`, además de la ruta heredada. `outbound-media.test.ts` cubre que el envío usa un objeto legacy de otro miembro de la cuenta. |
| Los envíos salientes multimedia funcionan | `outbound-media.test.ts` y `meta-api.media.test.ts` cubren upload a Meta y envío por media id. El checklist manual de producción de `docs/security.md` exige verificar inbox, Flow y broadcast antes de aplicar 044. |
| Los adjuntos anteriores siguen visibles | La comprobación SQL inserta `flow-media/<uid-del-uploader>/legacy-flow.txt` y exige que lo lea el segundo miembro de A. |
| La URL firmada caduca con 403 | `signed-url.test.ts` cubre TTL de 600 s y renovación; el guion manual ejecutable de `docs/security.md` emite una URL de 1 s, comprueba su descarga y exige 403 tras esperar 2 s. |

## Verificaciones ejecutadas

- `npm test -- src/lib/whatsapp/outbound-media.test.ts src/lib/media/signed-url.test.ts`:
  2 archivos, 25 pruebas verdes.
- `scripts/replay-migrations.sh /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a4220e4b5ba8896fd`:
  migraciones 001–039 y 044, más `verify-schema.sql`, verdes.
- `progress/checks_private-media.sql` contra el Postgres local del replay:
  verde; el segundo miembro de A leyó los tres objetos y B/anon no leyeron
  ninguno.
- Compuerta CI: `npm run lint && npm run typecheck && TZ=UTC npm test && npm run build`:
  verde (37 warnings de lint preexistentes, 84 archivos / 928 pruebas). El build
  usó las variables dummy documentadas en `docs/harness.md`.

## Manual y despliegue

No se ejecutó el guion de Storage ni la prueba de WhatsApp contra un servicio
externo: requieren credenciales reales y la instrucción prohíbe remoto. El
guion completo, incluyendo los entornos requeridos y la comprobación 403, está
en `docs/security.md`.

La migración 044 sigue diferida en producción: aplicar sólo después de verificar
en el teléfono receptor los envíos por media id (inbox, `send_media` de Flow y
broadcast con cabecera multimedia), como exige `feature_list.json`.

## Ambigüedades y deuda fuera de alcance

- Se resolvió que «rutas heredadas siguen viéndose» significa todos los miembros
  de la cuenta del uploader, no sólo el uploader original.
- No hay variables de entorno nuevas; el build usó
  `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `ENCRYPTION_KEY`
  y `META_APP_SECRET` dummy.
- Se mantiene la deuda ya anotada: la API pública devuelve `media_url` en su
  forma almacenada y necesitará una URL firmada o proxy con alcance de cuenta.
