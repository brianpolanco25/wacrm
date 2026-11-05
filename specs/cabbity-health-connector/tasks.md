# n13.5 `cabbity-health-connector` — tasks

Rama `feat/cabbity-health-connector`, worktree `.claude/worktrees/cabbity-health-connector`. En serie;
cada task termina con su test en verde con el gate dirigido
(`./init.sh feature n13.5 --test <ruta>`), nunca el gate completo. Sin migraciones (R25), sin
dependencias nuevas (CP5), sin capturas. La clave real de Health no aparece en ningún archivo,
comando guardado ni informe.

- [ ] **T1 Tipos.** `src/lib/integrations/types.ts`: `ParamLocation` + `'header'`,
  `PARAM_LOCATIONS`, `ParamAuto`/`PARAM_AUTOS`, `OperationParam.auto?`, `RemoteError`,
  `INTEGRATION_MAX_ERROR_BYTES` (design §2.1). `npm run typecheck` señala los `switch`/mapas que
  hay que completar (editor del panel): no se arreglan aquí más allá de compilar.
  *Cubre:* base de R9–R20. *Test:* `npm run typecheck`.

- [ ] **T2 Validación del catálogo.** `src/lib/integrations/catalog-validate.ts` según design §2.2:
  cabeceras `auto: 'uuid'`, nombres con punto en `body`, hoja/prefijo, `auto` fuera de `header`.
  *Cubre:* R9, R13, R18. *Test:* `src/lib/integrations/catalog-validate.test.ts` (casos nuevos:
  cabecera válida; sin `auto`; `auto` en query; `type` integer; `required:false`; `enum`; nombre
  `Authorization`/`content-type`; dos cabeceras iguales sin mayúsculas; `consent.accepted` en body
  ok y en query ko; 4 segmentos; `consent` + `consent.accepted`; los casos previos sin tocar).

- [ ] **T3 Construcción de la petición.** `src/lib/integrations/request.ts` según design §2.3:
  `callerParams`, aplanado en `validateCallParams`, cuerpo anidado, cabeceras `auto` con
  `BuildOptions.uuid`, `withAuthHeader`.
  *Cubre:* R10, R11, R14, R15, R18. *Test:* `src/lib/integrations/request.test.ts` (`Idempotency-Key`
  en `given` → `unknown`; `callerParams` sin la cabecera; generador inyectado y `values` ignorado;
  dos llamadas sin inyectar → UUID v4 distintos; cuerpo `{"consent":{…}}`; padre omitido sin hojas;
  `constructor.x` → propiedad propia; entrada como objeto ≡ entrada con punto; doble vía →
  `unknown`; `withAuthHeader` con `x-api-key`/`X-Api-Key`; tests previos intactos).

- [ ] **T4 Error remoto.** `src/lib/integrations/remote-error.ts` (nuevo) y rama no-2xx de
  `src/lib/integrations/http.ts` (design §2.4–2.5).
  *Cubre:* R19. *Test:* `src/lib/integrations/remote-error.test.ts` (forma de Health completa;
  `code` inválido o ausente → `null`; mensaje con control y > 300 → saneado y cortado; `details`
  fuera; JSON roto → `null`) y `src/lib/integrations/http.test.ts` (422 JSON → `remoteError`; 500
  `text/html` → sin; `content-length` 9000 → sin y cuerpo cancelado; stream > 8 KiB sin
  `content-length` → sin; 302 con JSON → sin; 2xx sin cambios).

- [ ] **T5 Ejecutor.** `src/lib/integrations/execute.ts` (design §2.6): `remoteError?` en
  `ok:false`, `ExecuteDeps.uuid`, `withAuthHeader` en las dos llamadas; `integration_calls` igual.
  *Cubre:* R10, R11, R12, R20, R21. *Test:* `src/lib/integrations/execute.test.ts` (`it.each`
  409 `idempotency_mismatch` / 422 `validation_failed` / 401 `api_key_expired` / 401
  `api_key_revoked` / 429 `rate_limited` → `remoteError.code` y `message`, fila de
  `integration_calls` con las mismas claves que n13.1, `console.error` sin el mensaje; `Idempotency-Key`
  en params → `invalid_params` sin `fetch`; dos ejecuciones → dos claves distintas; credencial
  única con `auth_scheme: 'header'`; `testIntegrationConnection` 401 `api_key_revoked` →
  `auth_failed`).

- [ ] **T6 Panel.** `src/components/platform/integration-form.ts` y
  `platform-integration-editor.tsx` (design §2.7); claves `Platform.integrations.params.in_header`
  y `.autoUuid` en `messages/en.json` y `messages/es.json`.
  *Cubre:* R17. *Test:* `src/components/platform/integration-form.test.ts` (ida y vuelta conserva
  `auto: 'uuid'`; fila `header` → `type: 'string'`, `required: true`, sin `enum`) y
  `src/components/platform/platform-integration-editor.test.tsx` (elegir `header` deshabilita tipo,
  obligatorio y enum; aparece el texto `autoUuid`).

- [ ] **T7 Definición del catálogo.** `src/lib/integrations/catalogs/definition.ts`,
  `cabbity-health.ts` (16 operaciones, textos de design §3) e `index.ts`.
  *Cubre:* R1–R4, R16. *Test:* `src/lib/integrations/catalogs/cabbity-health.test.ts`
  (validación con `validateIntegrationInput`/`validateOperationInput`; lista exacta de claves y
  excluidas; contrato contra `docs/integrations/cabbity-health-openapi.json` con la desviación de
  `list_appointments.patient_id`; textos mínimos de R4; URL de `list_appointments` con
  `status=confirmed`).

- [ ] **T8 Peticiones del catálogo con fetch simulado.**
  *Cubre:* R22. *Test:* `src/lib/integrations/catalogs/cabbity-health.execute.test.ts` (siembra
  las filas de `CABBITY_HEALTH_CATALOG` en el doble de `integrations.test-support.ts`; por
  operación: URL, método, `Authorization`, `Idempotency-Key` presente/ausente, cuerpo).

- [ ] **T9 Script de carga.** `scripts/integrations-bootstrap-catalog.ts` (design §4).
  *Cubre:* R5–R8. *Test:* `src/lib/integrations/catalogs/bootstrap.test.ts` (almacén en memoria:
  primera carga; segunda sin escrituras y todo `unchanged`; `is_active` del operador conservado;
  campo cambiado → solo ese en el patch; huérfana → aviso sin escritura; jsonb con claves
  reordenadas → `unchanged`; `resolveCatalog` con slug desconocido; lectura como texto de
  `catalogs/*.ts` no-test y del doc sin `@/` ni forma de clave).

- [ ] **T10 Test vivo opcional.** `src/lib/integrations/catalogs/cabbity-health.live.test.ts`
  (`describe.skipIf(!process.env.CABBITY_HEALTH_KEY)`).
  *Cubre:* R23. *Test:* en la compuerta sale `skipped`; Brian lo corre en §M1 paso 5.

- [ ] **T11 Documentación.** `docs/integrations/cabbity-health.md` (design §6).
  *Cubre:* R26. *Test:* aserciones de contenido en `bootstrap.test.ts` (T9).

- [ ] **T12 Guion manual §M1** (design §8) con Brian: él teclea la clave. Resultado, sin la clave,
  en `progress/impl_cabbity-health-connector.md`; si `status=confirmed` diera 422, quitar `status`
  de la definición, ajustar T7 y anotarlo.
  *Cubre:* R7 (variables), R16, R23, R24.

- [ ] **T13 Coordinación.** Según design §2.8: si n13.2 ya está en `main`, cambiar su lista de
  parámetros a `callerParams` (formulario y validador del nodo) con test; si no, nota en
  `progress/current.md` para n13.2 y n13.3. Comprobar `git diff main --stat -- supabase/` vacío.
  *Cubre:* R10 (consumidores), R25.

- [ ] **T14 Compuerta en verde + CHANGELOG.** Entrada en `CHANGELOG.md` (Unreleased) según design
  §6; `./init.sh feature n13.5` con los tests de T2–T10 y lint de los archivos tocados; informe
  `progress/impl_cabbity-health-connector.md` que coincida con el diff (decisiones D1–D7, deuda,
  resultado de §M1).
  *Cubre:* R27.
