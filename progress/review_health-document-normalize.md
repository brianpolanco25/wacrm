# Review — n13.8 health-document-normalize

**Veredicto:** APPROVED

Rama `feat/health-document-normalize` @ `d469db8` sobre `main @ a4726df`. Un commit, 14 archivos; coincide con el informe.

## Compuerta (ejecutada por el revisor en el worktree, variables dummy de CI)
- lint: verde (0 errores; 34 warnings preexistentes, ninguno en archivos tocados: `eslint` sobre los .ts del diff sale limpio)
- typecheck: verde
- `TZ=UTC npm test`: 5732 ok / 2 fallos, ambos los preexistentes de m14.3 indicados por el líder
  (`src/app/api/media/sign/route.test.ts` › «403s an object of another account…»,
  `src/lib/security/tenant-isolation.test.ts` › «no path form under A's folder…»). Ningún otro fallo.
- build: verde (exit 0)
- replay-migrations: n/a (sin SQL; `supabase/` intacto)

## Trazabilidad criterio ↔ test
- A1 normalización declarativa en el ejecutor: [x] `src/lib/integrations/request.test.ts` › `validateCallParams with normalize: compact (n13.8, A1)`:
  `it.each` cubre `001-1234567-8`, `001 1234567 8`, puntos, guiones Unicode, `AB 123456`→`AB123456`, valor limpio sin cambio;
  «a parameter without normalize is not touched» (`note` con guiones y puntos sale intacto); «the cleaned value is what travels in the body».
  End-to-end por `executeIntegrationOperation`: `cabbity-health.execute.test.ts` › lookup_patient / list_patients (query) / create_patient.
  Vive en `validateCallParams` (`request.ts:219`), único punto de entrada de `execute.ts:245` → aplica a IA, flows y automatizaciones.
- A2 catálogo Health: [x] `cabbity-health.test.ts` › «every document_number is normalized and says the system cleans it» (las 3 operaciones con `document_number`; no existe `update_patient`),
  «no text asks for express consent» (recorre description, response_description y params de todas las operaciones: ni «consentimiento expreso» ni «sin ese sí»),
  «create_patient wants lookup_patient first and no question about consent» (`consent.accepted` sigue requerido, «true siempre»).
  OpenAPI `docs/integrations/cabbity-health-openapi.json` sin cambios (git diff vacío).
- A3 validador: [x] `catalog-validate.test.ts` › `validateOperationInput: normalize (n13.8, A3)`: acepta `compact`, no añade la clave si falta; rechaza valor desconocido, no string, null, tipo integer y cabecera.
- A3 schema IA: [x] `src/lib/ai/tools/schema.test.ts` › «does not expose normalize to the model» (`toEqual` exacto + regex sin `normalize|compact`). `schema.ts` sin cambios.
- A3 bootstrap: [x] `catalogs/bootstrap.test.ts` › «syncs params and description into rows loaded before n13.8» (escribe `description,params`, la fila queda con `normalize: 'compact'`). `OPERATION_SYNCED` ya incluía ambos campos.
- A4 compuerta + CHANGELOG + sin migración: [x] (ver arriba; entrada en `[Unreleased]` con el comando de bootstrap).

## Checkpoints
- CP1 Compuerta: [x] (salvo los 2 fallos preexistentes ajenos)
- CP2 Migraciones: [x] n/a
- CP3 Aislamiento: [x] n/a (no hay consultas nuevas con rol de servicio)
- CP4 Tests: [x]
- CP5 Sin dependencias nuevas: [x] `package.json` intacto
- CP6 i18n: [x] n/a (sin texto de UI nuevo; las descripciones del catálogo son datos para la IA)
- CP7 Next 16: [x] n/a (no toca APIs de framework)
- CP8 Alcance: [x] `integration-form.ts` justificado (sin él, guardar una operación desde el panel borraría `normalize`; con test); `docs/integrations/cabbity-health.md` es guía propia, no el OpenAPI
- CP9 Documentación: [x] CHANGELOG; sin variables de entorno nuevas
- CP10 Git: [x] commit en español con prefijo y `Co-Authored-By`; sin push
- CP11 Entrante: [x] n/a

## Hallazgos (archivo:línea)
Ninguno bloqueante. Revisión manual del diff (pequeño); no se lanzó el skill `code-review` por indicación del líder de no correr nada aparte del gate.
1. Nota menor: `normalize` se permite en `in: 'path'` (`catalog-validate.ts:519` solo excluye cabecera). Inocuo: el valor limpio sigue pasando por el codificado de path.
2. Pendiente manual tras merge (lo declara el informe): `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health` debe reportar `updated` en `lookup_patient`, `list_patients`, `create_patient`; y prueba por WhatsApp con Aura con `001-1234567-8`.
