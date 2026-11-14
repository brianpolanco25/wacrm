# impl n13.8 `health-document-normalize`

## Plan

1. `types.ts`: `ParamNormalize = 'compact'`, `PARAM_NORMALIZES`, `OperationParam.normalize?`.
2. `request.ts` (`validateCallParams`): antes de comprobar ausencia/tipo, un parámetro con
   `normalize: 'compact'` y valor string pierde guiones (ASCII y Unicode), espacios y puntos.
   Si queda vacío cuenta como ausente. Tests A1 en `request.test.ts`.
3. `catalog-validate.ts`: acepta `normalize` (solo `'compact'`, solo `type: 'string'`, nunca en
   cabecera); rechaza valores desconocidos. Tests.
4. Formulario del panel (`integration-form.ts`): conservar `normalize` al abrir y guardar (si no,
   editar la operación desde el panel borraría el campo). Sin control de UI nuevo.
5. `schema.ts`: no cambia (solo emite type/enum/description); test que lo afirma.
6. Catálogo Health: `normalize` en `document_number` de `lookup_patient`, `list_patients`,
   `create_patient` (no hay `update_patient`: fuera por D1); descripciones nuevas (A2). Tests.
7. Bootstrap: `params` ya está en `OPERATION_SYNCED`; test de que una fila previa sin
   `normalize` recibe `params` y `description`.
8. CHANGELOG, compuerta, commit.

## Rama y commits

- Rama `feat/health-document-normalize` (worktree `.claude/worktrees/health-document-normalize`), base `main @ a4726df`.
- `d469db8` feat: normaliza el documento en el ejecutor y quita la pregunta de consentimiento (n13.8). Sin push.

## Qué se hizo

- `src/lib/integrations/types.ts`: `ParamNormalize = 'compact'`, `PARAM_NORMALIZES`, `OperationParam.normalize?`.
- `src/lib/integrations/request.ts`: `normalizeParamValue()` exportada; `validateCallParams` la aplica al
  valor crudo ANTES de `isAbsent`/`coerce`/`enum`. Quita `\s`, `.`, `-` y los guiones Unicode
  U+2010–U+2015 y U+2212 (teclados de móvil / autocorrector). Solo toca strings; un número pasa por
  `coerce` como antes. Si queda vacío cuenta como ausente (requerido → `missing`). Es el único punto de
  entrada de valores al ejecutor (`execute.ts` L245; `ai/tools/result.ts` lo reusa para el detalle del error).
- `src/lib/integrations/catalog-validate.ts`: acepta `normalize`; solo `'compact'`, solo `type: 'string'`,
  nunca en `in: 'header'`; un param sin `normalize` no gana la clave (forma n13.1 intacta).
- `src/components/platform/integration-form.ts`: `ParamRowForm.normalize` (sin control de UI) para que
  abrir y guardar una operación en el panel no borre el campo; se cae si el tipo deja de ser string.
- `src/lib/ai/tools/schema.ts`: sin cambios (solo emite `type`/`enum`/`description`); test lo afirma.
- `src/lib/integrations/catalogs/cabbity-health.ts`: helper `DOCUMENT_NUMBER(where, required)` con
  `normalize: 'compact'` y la descripción pedida; usado en `lookup_patient`, `list_patients`,
  `create_patient`. No existe `update_patient` (fuera por D1). Descripción de `create_patient`,
  `consent.accepted` («true siempre…»), `consent.accepted_at` («fecha y hora actual…»),
  `consent.reference` («Canal y fecha…») reescritas; `lookup_patient` ya no sugiere rebotar el formato;
  `response_description` de `create_patient`: el 422 `consent_required` dice «reenvía con
  consent.accepted = true, sin preguntar al cliente».
- `scripts/integrations-bootstrap-catalog.ts`: sin cambios; `OPERATION_SYNCED` ya incluye `description`
  y `params` (diff por `stableStringify`). Test nuevo lo cubre.
- `docs/integrations/cabbity-health.md` (guía propia, no el OpenAPI): notas de `normalize` y consentimiento.
  `docs/integrations/cabbity-health-openapi.json` intacto.

## Criterio ↔ test

| Criterio | Test |
|---|---|
| A1 `'001-1234567-8'`→`'00112345678'`, `'001 1234567 8'`, puntos, guiones Unicode, `'AB 123456'`→`'AB123456'`, limpio sin cambios | `src/lib/integrations/request.test.ts` › `validateCallParams with normalize: compact (n13.8, A1)` › `it.each '%j → %j'` |
| A1 parámetro sin normalize intacto | idem › `a parameter without normalize is not touched` |
| A1 solo separadores = ausente; número se coerce igual | idem › `a value that is only separators counts as missing`; `a number is coerced to text as before` |
| A1 el valor limpio es el que viaja | idem › `the cleaned value is what travels in the body`; `cabbity-health.execute.test.ts` › `lookup_patient: a cédula with dashes travels as 11 digits`, `list_patients: the document filter is cleaned too`, `create_patient: a cédula with dashes travels as 11 digits` (pasan por `executeIntegrationOperation`) |
| A2 normalize en todo `document_number` + texto «con o sin guiones… no le pidas que lo repita sin guiones» | `cabbity-health.test.ts` › `every document_number is normalized and says the system cleans it` |
| A2 sin «consentimiento expreso» / «sin ese sí» en ningún texto | `cabbity-health.test.ts` › `no text asks for express consent` |
| A2 create_patient: no pedir consentimiento, `consent.accepted = true`, sigue requerido | `cabbity-health.test.ts` › `create_patient wants lookup_patient first and no question about consent` |
| A2 el catálogo sigue pasando `validateOperationInput` y fiel al OpenAPI | tests existentes de `cabbity-health.test.ts` (R1–R4) en verde |
| A3 validador acepta `compact` y lo conserva | `catalog-validate.test.ts` › `validateOperationInput: normalize (n13.8, A3)` › `accepts normalize: compact…`, `a param without normalize keeps its shape` |
| A3 validador rechaza valor desconocido / no string / null / integer / header | idem › `it.each 'rejects normalize with %s'` |
| A3 IA no ve normalize | `src/lib/ai/tools/schema.test.ts` › `buildParameterSchema with normalize (n13.8)` › `does not expose normalize to the model` |
| A3 bootstrap sincroniza params+description en filas previas | `catalogs/bootstrap.test.ts` › `syncs params and description into rows loaded before n13.8` |
| (extra) panel conserva normalize | `integration-form.test.ts` › `operationFormToBody with normalize (n13.8)` › `round-trips normalize: compact unchanged`, `drops normalize if the row stops being text` |

## Compuerta (worktree, d469db8)

- `npm run lint`: 0 errores (warnings preexistentes; ninguno en archivos tocados).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 364 archivos / 5732 tests en verde, **2 fallos PREEXISTENTES ajenos a esta feature**:
  `src/app/api/media/sign/route.test.ts` › `403s an object of another account…` y
  `src/lib/security/tenant-isolation.test.ts` › `no path form under A's folder reaches B's objects…`
  (esperan 403 y reciben 400). Fallan idénticos en el checkout principal `main @ a4726df` sin mis
  cambios: los tests de m14.1 no se ajustaron tras m14.3 (`a4726df`), que rechaza antes con 400 las
  rutas no canónicas. No toco ese alcance.
- `npm run build` (variables dummy): salida 0. Nota: el symlink `node_modules` del worktree apuntaba a
  `/mnt/nvme-big/Dev/apps/wacrm/node_modules` (symlink del repo) y Turbopack lo rechazaba («points out
  of the filesystem root»); lo re-apunté a la ruta canónica `/mnt/nvme-big/Dev/apps/cabbity/wacrm/node_modules`
  (mismo directorio, gitignoreado) y compila.
- Sin SQL ni migración: no aplica `replay-migrations.sh`.

## Verificación manual pendiente

- Tras merge, cargar el catálogo en la base real:
  `node --env-file=.env.local scripts/integrations-bootstrap-catalog.ts cabbity-health` → debe reportar
  `updated` en `lookup_patient`, `list_patients`, `create_patient`.
- Por WhatsApp con Aura: dar la cédula `001-1234567-8` → la IA no pide repetirla; en `integration_calls`
  la llamada a `lookup_patient` sale `ok` (Health no responde 422). En registro nuevo, la IA no pregunta
  por autorización y `create_patient` sale `ok`. El prompt de Aura lo aplica el humano aparte.

## Decisiones donde la nota era ambigua

- «Guiones» incluye los guiones Unicode (‐ ‑ ‒ – — ― −) además de `-`; «espacios» es `\s` (incluye NBSP y tabs).
- Un valor que tras limpiar queda vacío se trata como ausente (requerido → `invalid_params`/`missing`)
  en vez de mandar `""` a Health.
- `normalize` se rechaza en cabeceras y en tipos no string; se permite junto a `enum` (se normaliza antes del `enum`).
- `consent.reference`: «canal y fecha (p. ej. «WhatsApp, conversación del 2026-11-10»)», según el encargo del líder.
- Se actualizó `docs/integrations/cabbity-health.md` (guía propia), no el OpenAPI.

## Variables de entorno nuevas

Ninguna.

## Deuda fuera de alcance

- Los 2 tests de `/api/media/sign` rojos en `main @ a4726df` (ver compuerta).
- El panel de plataforma no tiene control para `normalize` (solo lo conserva); si el operador quiere
  declararlo en otra integración, hoy es por el catálogo en código + bootstrap.
