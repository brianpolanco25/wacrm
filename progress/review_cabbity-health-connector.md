# Review — n13.5 cabbity-health-connector

**Veredicto:** APPROVED

Rama `feat/cabbity-health-connector`, base `main @ fd4ce95`, commits 254316a, ea868d7, 5b33da6, 80942a2, 69d67dd (+ spec 34c3fd2). Diff coincide con el informe.

## Compuerta (ejecutada por el reviewer en el worktree)
- lint: verde (0 errores, 34 avisos previos fuera de lo tocado)
- typecheck: verde
- `TZ=UTC npm test`: verde — 349 archivos pasan, 1 saltado (vivo); 5421 tests, 7 saltados
- build (variables dummy de `docs/harness.md`): verde, exit 0
- replay-migrations: n/a (`git diff fd4ce95..HEAD --stat -- supabase/` vacío, R25)

## Trazabilidad criterio ↔ test (tests leídos)
- R1: [x] `catalogs/cabbity-health.test.ts` › "has the Health slug…", "passes validateIntegrationInput unchanged", "is registered under its slug" (y base_url = `servers[0].url` del OpenAPI)
- R2: [x] idem › "declares exactly the 16 operations" (lista exacta clave/método/ruta), validación una a una, "leaves out %s %s" (y comprueba que sí existen en el OpenAPI)
- R3: [x] idem › contrato por operación contra el JSON del OpenAPI (path/query/body con punto, required con la única desviación `list_appointments.patient_id`, tipos, enum ⊆, `Idempotency-Key` ⇔ declarada en OpenAPI, path/query obligatorios presentes) + "every OpenAPI path is either in the catalog or left out"
- R4: [x] idem › longitudes ≤ 1000, consentimiento + lookup_patient, find_availability + offset + 3 citas, 13 días, next_cursor
- R5: [x] `catalogs/bootstrap.test.ts` › "creates the integration inactive and the 16 operations…"
- R6: [x] idem › segunda ejecución sin escrituras (almacén que reordena claves como jsonb), is_active del operador conservado, parche de un campo, huérfana avisada sin escritura
- R7: [x] idem › `resolveCatalog` con undefined/''/nope/constructor/__proto__; variables: comprobado a mano por el implementer (informe) y leído en el script (`requireEnv` solo imprime el nombre)
- R8: [x] idem › sin `@/`, imports de valor solo `./*.ts`, `import type` con `.ts`, sin `/chk_(live|test)_[A-Za-z0-9]{8,}/` en catálogo, script y doc
- R9: [x] `catalog-validate.test.ts` › "header params (n13.5, R9)"
- R10: [x] `request.test.ts` › callerParams / `Idempotency-Key` → unknown; `execute.test.ts` › "Idempotency-Key from the caller → invalid_params, no request" (fetch no llamado, fila invalid_params)
- R11: [x] `request.test.ts` › generador inyectado e ignora `values[name]`, dos UUID v4; `execute.test.ts` › dos ejecuciones con claves distintas UUID v4
- R12: [x] `execute.test.ts` › "a header named like the credential never travels twice"; `request.test.ts` › withAuthHeader
- R13: [x] `catalog-validate.test.ts` › "dotted body names (n13.5, R13)"
- R14: [x] `request.test.ts` › consent anidado, padre omitido, `constructor.x` como propiedad propia
- R15: [x] `request.test.ts` › objeto ≡ punto, misma hoja por dos vías → unknown con nombre con punto
- R16: [x] contingencia del propio R16 aplicada tras §M1 (422 con `status=`): `cabbity-health.test.ts` › "does not declare status; the URL carries only what was sent", "tells the AI to filter by status"; vigilado en el test vivo (422 `field=status`). Deuda anotada en doc e informe.
- R17: [x] `integration-form.test.ts` › ida y vuelta con `auto: 'uuid'` y fila header normalizada; `platform-integration-editor.test.tsx` › controles deshabilitados + texto de ayuda en es/en
- R18: [x] los tests previos solo reciben líneas añadidas (`--numstat`: 0 borradas en todos los `*.test.*`) y pasan
- R19: [x] `http.test.ts` › 422 JSON → remoteError; 500 text/html; content-length 9000 cancelado sin `getReader`; stream > 8 KiB cortado; 302 sin leer; 2xx sin cambios. `remote-error.test.ts` para el saneado
- R20: [x] `execute.test.ts` › it.each de los 5 cuerpos reales: resultado exacto, fila con las mismas claves de n13.1, código/mensaje ausentes en `integration_calls` y en console.error/warn/log
- R21: [x] `execute.test.ts` › "api_key_revoked → auth_failed, same result shape"
- R22: [x] `catalogs/cabbity-health.execute.test.ts` › las 8 operaciones por `executeIntegrationOperation`: URL completa, método, `Authorization: Bearer <cred>` (en el helper), Idempotency-Key presente/ausente, cuerpo anidado, sin cuerpo ni Content-Type en confirm y cancel sin motivo
- R23: [x] `catalogs/cabbity-health.live.test.ts` (`describe.skipIf(!KEY)`, saltado en la compuerta); 7/7 en verde contra el servicio real según el líder tras 69d67dd. La clave no se imprime (solo nombre del centro y recuentos)
- R24: [x] guion §M1 de solo lectura ejecutado por el líder; resultado en el informe sin la clave. Pasos 1–4 (carga en local, /platform, prueba de conexión desde Ajustes) no constan como ejecutados: quedan para Brian antes de cargar en remoto
- R25: [x] sin cambios en `supabase/`
- R26: [x] `bootstrap.test.ts` › "has the load command, the limits and the error codes"; doc leído: carga, activación, tabla con las dos apagadas y por qué, límites (120/60, 3 citas, 13/31 días, sin datos clínicos), códigos de error y deuda
- R27: [x] compuerta verde (arriba) y CHANGELOG Unreleased

## Checkpoints
- CP1: [x] compuerta verde ejecutada por el reviewer
- CP2: [x] n/a, sin SQL
- CP3: [x] sin consultas nuevas con `supabaseAdmin()` en `src/`. El script de carga usa rol de servicio sobre `integrations`/`integration_operations`, catálogo global sin `account_id` (modelo de n13.1); no aplica filtro por cuenta
- CP4: [x] ver trazabilidad
- CP5: [x] `package.json`/lock sin cambios
- CP6: [x] `Platform.integrations.params.in_header` y `.autoUuid` en es y en, sin placeholders
- CP7: [x] no se usa ninguna API nueva de Next; el componente solo añade props `disabled` y un `<p>`
- CP8: [x] todo lo tocado está justificado por design (modelo, panel, catálogo, script, doc). Tocar `request/http/execute/types/catalog-validate` es aditivo: firmas de `executeIntegrationOperation` y `validateCallParams` y forma de `ok:true` sin cambios; `buildIntegrationRequest` gana un 4.º argumento opcional; `remoteError?` opcional en `ok:false`
- CP9: [x] CHANGELOG, doc del conector, informe coincide con el diff; sin variables de entorno nuevas de la app (`CABBITY_HEALTH_KEY` solo para el test vivo, documentada en el doc)
- CP10: [x] commits en español con prefijo y `Co-Authored-By`; sin push; `main` en fd4ce95
- CP11: [x] no toca webhook ni facturación

## Puntos de atención del líder
- Clave: `git grep -n "chk_live_"` (sin el OpenAPI) solo muestra la forma genérica `chk_live_`/`chk_live_…` en el doc, el spec y `credential_help`. `git log -p` del rango no tiene nada con `chk_(live|test)_[A-Za-z0-9]{8,}`.
- Guardias de n13.1: la cabecera auto se rellena después de leer `values` y `callerParams` la deja fuera de lo aceptado; `remoteError` solo va en el valor devuelto por `finish`, no a `recordIntegrationCall` ni a `console.*`; el cuerpo de error lee como mucho 8 KiB y solo con JSON; SSRF/host prohibido/`redirect: 'manual'`/plazo/256 KiB sin cambios; 3xx sigue descartado sin leer.
- Catálogo frente al OpenAPI: 16 operaciones, `list_patients`/`get_patient` inactivas, `list_appointments` con `patient_id` obligatorio y sin `status`, `Idempotency-Key` auto en todas las escrituras que el OpenAPI declara (el test de contrato lo exige en ambos sentidos). Las descripciones dicen cuándo usar cada operación, qué pedir antes y los 409/422 relevantes.
- Script: idempotente (diff por `stableStringify`, nunca toca `slug` ni `is_active`), sin clave, solo imprime nombres de variables.

## Hallazgos (archivo:línea) — no bloqueantes
Del skill `code-review` (high) y revisión manual. Ninguno contradice el spec; quedan como deuda o pulido:
1. `src/lib/integrations/http.ts:179` — si el plazo vence mientras se lee el cuerpo de un no-2xx, devuelve `http_error` y no `timeout` (la rama 2xx sí mira `controller.signal.aborted`). R19 lo acepta («cualquier otro caso… sigue siendo http_error»), pero no es coherente.
2. `src/lib/integrations/remote-error.ts:43` — `.slice(0, 300)` puede partir un par sustituto (emoji en la posición 300). `CONTROL_RE` solo quita C0 y DEL, no C1 (`\u0080-\u009f`) ni bidi/U+2028. Conviene endurecerlo antes de que n13.3 enseñe `message` a la IA.
3. `src/components/platform/platform-integration-editor.tsx:702` — al cambiar de `header` a otra ubicación la fila conserva el nombre `Idempotency-Key` (no cumple `PARAM_NAME_RE`) y `required: true`; el guardado falla con error de servidor sin pista en la fila.
4. `src/lib/integrations/catalog-validate.ts:558` — el control «valor y objeto» solo mira `body`: una query `consent` junto a body `consent.accepted` se acepta y `flattenGiven` decide por la forma del valor en tiempo de ejecución. Contrived; anotar.
5. `src/lib/integrations/request.ts:51,67` — `MAX_DEPTH` y `isPlainRecord` duplican `MAX_PARAM_DEPTH` e `isPlainObject` de `catalog-validate.ts`; riesgo de deriva si cambia la profundidad.
6. `src/lib/integrations/request.ts:339` — clave de idempotencia nueva por llamada: un reintento tras `timeout` de una escritura puede duplicar cita/paciente. Está en «Fuera de alcance» del spec y en la doc; lo recojo para n13.2/n13.3 (reintentos de flow/IA).
7. Descartados del skill: cabecera auto con el mismo nombre que `auth_header_name` eliminada por `withAuthHeader` (es exactamente R12); misma hoja por dos vías → `unknown` (lo exige R15); `field`/`requestId` > 100 → `null` (lo exige R19).

## Cambios requeridos
Ninguno. Pendiente para el humano: pasos 1–4 de §M1 (carga en local, activación en `/platform`, prueba de conexión desde Ajustes) antes de cargar el catálogo en remoto; y la nota de coordinación de T13 (n13.2/n13.3 deben usar `callerParams`) que el informe pide al líder transmitir.
