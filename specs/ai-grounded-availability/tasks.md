# n13.7 `ai-grounded-availability` — tareas

Orden pensado para que cada paso deje la compuerta dirigida en verde
(`./init.sh feature n13.7 --test <ruta>...`). Tests vitest junto al código; nada de e2e ni
Playwright. Ninguna task reescribe tests existentes (R42): si uno se rompe, el código está mal
(salvo ampliar las aserciones de forma de fila de `integration_calls` y de `OPERATION_SYNCED`).

**Antes de T1:** n13.8 (`feat/health-document-normalize`) toca `types.ts`, `request.ts`,
`catalog-validate.ts`, `catalogs/cabbity-health.ts` y el bootstrap. Partir de `main` con n13.8 ya
fusionada; si aún no lo está, T6 y T7 se hacen al final y se rebasan (design §13).

- [ ] **T1 Migración 095** — `supabase/migrations/095_ai_grounding.sql` (design §2) y bloque
  `-- 095` en `supabase/ci/verify-schema.sql`. `scripts/replay-migrations.sh` aplicada dos veces
  sale 0. `progress/checks_ai-grounded-availability.sql`: insertar `ai_live_reads` objeto → falla;
  array de 4 → falla; default `[]`; `ai_policy` string → falla; borrar una conversación deja
  `integration_calls.conversation_id` a `NULL` y conserva la fila; `ai_preload` default `false`.
  Cubre **R1, R22, R27 (SQL)**.

- [ ] **T2 Plantillas y validación de lecturas (puro)** — `src/lib/ai/tools/live-templates.ts`.
  Cubre **R2 (parte pura), R3, R4, R5**. Test `live-templates.test.ts`: `{{today}}` a las
  2026-11-10T03:30Z en `America/Santo_Domingo` → `2026-11-09`; en `null` (UTC) → `2026-11-10`;
  `{{today+13d}}` cruzando fin de mes y un cambio de hora (`America/New_York`, 2026-11-01);
  plantilla embebida `desde {{today}}`; `{{today+0d}}`, `{{today+61d}}`, `{{now}}`, `{{ today`
  → inválidas; `validateLiveReads`: 4 entradas, operación inexistente, inactiva, `POST`, parámetro
  no declarado, requerido ausente, tipo erróneo, cabecera `auto`, `[]`/`null` → `[]`, caso válido
  de `find_availability`.

- [ ] **T3 Tipos, ejecutor y evidencia** — `src/lib/integrations/types.ts` (`OperationAiPolicy`,
  campos en `OperationWrite`/`OperationRow`), `execute.ts` (`conversationId`, `preload` en input y
  en `recordIntegrationCall`), `src/lib/ai/tools/types.ts` (design §3.3),
  `src/lib/ai/tools/evidence.ts` (`loadPriorEvidence`), `src/lib/ai/tools/policy.ts`
  (`checkRequiresPrior`). Cubre **R27 (V), R28, R29, R31, R34**. Tests: `execute.test.ts` (casos
  nuevos: fila con `conversation_id` y `ai_preload: true`; sin ellos, fila como hoy);
  `evidence.test.ts` (filtros `account_id`, `conversation_id`, `source`, `ai_preload=false`,
  `outcome='ok'`, 24 h; error → `[]`; dos cuentas con el mismo `conversation_id` no se cruzan);
  `policy.test.ts` (orden `list_appointments` → `find_availability` ok; orden inverso → falta el
  paso 2; `get_appointment` como alternativa; evidencia de otra integración no cuenta; sin
  evidencia → faltan ambos).

- [ ] **T4 Caché y ejecución de lecturas** — `src/lib/ai/tools/live.ts`. Cubre **R9, R11, R12,
  R13, R14, R15**. Test `live.test.ts` con `execute` inyectado y reloj falso: dos llamadas iguales
  en < 60 s → una ejecución; a los 60 001 ms → otra; `AI_LIVE_DATA_TTL_MS=5000` respetado; fallo
  → sin reintento en 10 s y reintento después; `invalidateLiveCache` fuerza nueva ejecución; 501
  claves → la más antigua desalojada; cuenta A no reutiliza la entrada de B; `execute` que lanza →
  bloque `ok:false` y el resto sigue; ejecución con `source:'ai'`, `preload:true` y plantillas
  resueltas; consola sin params ni datos (espía de `console.*`).

- [ ] **T5 Render y prompt** — `src/lib/ai/tools/live-render.ts`, helper `offsetLabel` extraído en
  `prompt.ts`, `buildSystemPrompt` (`defaults.ts`) con `liveData`. Cubre **R16, R17, R18, R19, R20,
  R21**. Tests `live-render.test.ts`: respuesta tipo Health (`data[]` con `starts_at`/`ends_at`
  `-04:00`) → cabecera `2026-11-12 (Thursday, UTC-04:00)` y línea `- 09:00–09:30
  practitioner_name=…`; hueco a las 23:30Z agrupado en el día local correcto; lista vacía;
  `meta.truncated`; objeto sin fechas → JSON compacto; 2 000 huecos → ≤ 6 000 bytes con aviso de
  corte y días enteros; string de 500 caracteres cortado a 80; fallo → texto de prohibición, con
  `[[HANDOFF]]` solo en `auto_reply`. `defaults.test.ts` (casos nuevos): sin `liveData` o con `[]`
  el prompt es idéntico al de la llamada sin el parámetro.

- [ ] **T6 Política en catálogo, validación y bootstrap** — `catalog-validate.ts`
  (`ai_policy`), `catalogs/definition.ts`, `catalogs/cabbity-health.ts` (R24 y la frase de
  `cancel_appointment`), `scripts/integrations-bootstrap-catalog.ts` (`OPERATION_SYNCED`).
  Cubre **R23, R24, R25**. Tests: `catalog-validate.test.ts` (válidos, `null`, clave desconocida,
  `grounds: ['price']`, 4 pasos, paso vacío, 5 keys, key `Bad-Key`); `cabbity-health.test.ts`
  (las seis con `grounds` y `cancel_appointment.requires_prior` exacto; todas las políticas pasan
  `validateOperationInput`); `bootstrap.test.ts` (fila existente con `ai_policy` distinto →
  `updated ai_policy`; igual → `unchanged`).

- [ ] **T7 Carga del toolset y esquema** — `load.ts` (`ai_live_reads`, `ai_policy`), `schema.ts`
  (`policy`, frase de `requires_prior`). Cubre **R26** y la parte de carga de **R9**. Tests:
  `load.test.ts` (casos nuevos: `liveReads` leído; valor basura → `[]`; `ai_policy` propagado;
  la consulta sigue con `.eq('account_id', …)`); `schema.test.ts` (el JSON Schema no contiene
  `ai_policy`/`requires_prior`; descripción termina con «Requires a previous call … to:
  cabbity_health__list_appointments or …» y ≤ 1024).

- [ ] **T8 Detector de agenda** — `src/lib/ai/tools/grounding.ts`. Cubre **R35**. Test
  `grounding.test.ts` con `it.each`: positivos (`10:30`, `10.30`, `10h30`, `3 pm`, `3 p. m.`,
  `el Jueves`, `miércoles`/`miercoles`, `Monday`, `12/11`, `2026-11-12`, `12 de noviembre`,
  `November 12`, `12 nov`); negativos (`hoy`, `mañana`, `tomorrow`, `gracias`, `cédula
  001-1234567-8`, `3 citas`, un precio `RD$1,500.00`, un teléfono `809 555 1234`).

- [ ] **T9 Bucle: guardia destructiva y guardia de texto** — `loop.ts`, `result.ts`
  (`policy_requires_prior`), `generate.ts`. Cubre **R29, R30, R33, R36, R37, R38, R39, R40, R41**
  y la invalidación de **R13** en el bucle. Tests en `loop.test.ts` (casos nuevos, proveedor
  simulado): `cancel_appointment` sin evidencia → payload `policy_requires_prior` con `required`,
  `execute` no llamado, `toolsUsed` con `blocked:'policy'`; con evidencia previa ordenada →
  ejecutado con `conversationId`; evidencia cargada una sola vez por turno; texto «el jueves a las
  10:00» sin lectura ni llamada → vuelta extra con la nota en el system prompt y `toolChoice:
  'auto'`; si la vuelta extra llama a `find_availability` ok → se devuelve su texto; si insiste →
  texto `[[HANDOFF]]`, `grounding:'handoff'` y `console.warn` sin texto; con lectura en vivo `ok`
  → sin vuelta extra; `mode:'draft'` → sin guardia; toolset sin `grounds` → mismas vueltas que hoy
  (R40); `AI_TOOL_MAX_CALLS` alcanzado → traspaso directo sin vuelta extra; ninguna llamada al
  proveedor recibe un `toolChoice` distinto de `'auto'|'none'`; `create_appointment` ok →
  `invalidateLiveCache` llamado. `generate.test.ts` existente sin tocar sigue verde.

- [ ] **T10 Llamadores** — `auto-reply.ts`, `playground/route.ts`, `draft/route.ts`,
  `tools-used.ts` (`readTrail`, `slug`, `blocked`). Cubre **R9, R10, R32, R33** y el cableado de
  **R16/R27**. Tests: `auto-reply.tools.test.ts` (casos nuevos: `loadLiveData` no se llama si se
  pierde la reserva o el rate limit; se llama tras ganarla y su bloque llega al system prompt;
  `conversationId` llega al bucle); test de la ruta del playground (`trail` válido → evidencia;
  > 50 entradas o mal formadas descartadas; `grounding` en la respuesta);
  `draft/route.tools.test.ts` (bloque en el prompt, `mode:'draft'`); `tools-used.test.ts`
  (`readTrail`). Flows y automatizaciones: un test en `execute.test.ts` de que `source:'flow'`
  ignora `ai_policy` (R33).

- [ ] **T11 Ajustes: vista, PATCH y diálogo** — `account.ts`, ruta
  `api/account/integrations/[integrationId]/route.ts`, `integration-live-reads.tsx`,
  `integrations-settings.tsx`, `ai-playground.tsx`, `ai-tools-used.tsx`, `messages/{es,en}.json`.
  Cubre **R2 (ruta), R5, R6, R7, R8**. Tests: test de la ruta (400 `field:'aiLiveReads'` por cada
  causa de R2; 200 guarda `[]` con `null`; usa la zona de ESTA cuenta); `account.test.ts` o el de
  la vista (`aiLiveReads` y `aiReadOperations` solo `GET` activas, vacíos si no activada);
  `integration-live-reads.test.tsx` (añadir hasta 3 y botón deshabilitado, quitar, input numérico
  para `integer`, select para `enum`, error en línea); `integrations-settings.test.tsx` (casos
  nuevos: el PATCH lleva `aiLiveReads`; 400 deja el diálogo abierto con el error); test de
  paridad de claves es/en (el existente del repo, o uno nuevo si no hay).

- [ ] **T12 Guion manual** — design §14 con Health y los tres proveedores; resultado en
  `progress/impl_ai-grounded-availability.md`. Cubre **R43**. Lo ejecuta el humano o el
  implementer con credenciales de la cuenta de pruebas (nunca de Rehactive en producción sin
  permiso).

- [ ] **T13 Compuerta en verde + CHANGELOG** — `./init.sh feature n13.7 --test <rutas de T2–T11>`
  en verde (lint, typecheck, `TZ=UTC` tests, build); `CHANGELOG.md` (Unreleased);
  `AI_LIVE_DATA_TTL_MS` en `docs/docker.md`; recordar en el informe que tras desplegar hay que
  correr `scripts/integrations-bootstrap-catalog.ts cabbity-health` para cargar `ai_policy` y
  aplicar la 095 en remoto (preguntar antes). Cubre **R42** y CP1/CP9.
