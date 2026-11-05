# n13.3 `integration-ai-tools` — requisitos

**Fase 13** (`feature_list.json`, `sdd: true`, depende de n13.1). Redactada el 2026-11-05 por
`spec_author`. Base de lectura: `feat/integration-ai-tools` @ fd4ce95 (= `main`). Migración
**094** (la 092 la reserva n13.2 y la 093 ya está en main; ver D9 de `design.md`). i18n: `es`
(defecto) y `en` (CP6).

## Contexto

Encargo del humano (2026-11-05): «crear el conector para que el agente de IA pueda utilizar la API
de Cabbity Health y sepa cómo hacerlo». Esta feature es la parte **genérica**: cualquier operación
activa del catálogo de n13.1 que la cuenta haya activado y marcado «usar en IA» se le ofrece al
modelo como herramienta. La definición concreta de Health es n13.5 (rama aparte); aquí no se cita
ninguna de sus rutas como requisito.

Hechos de partida (verificados en `main`):

- Ejecutor común: `executeIntegrationOperation(db, {accountId, integrationSlug, operationKey,
  params, source})` en `src/lib/integrations/execute.ts`. Valida params (`validateCallParams`,
  `src/lib/integrations/request.ts`), nunca lanza, registra en `integration_calls` y devuelve
  `{ok:true,status,data,latencyMs} | {ok:false,outcome,status,latencyMs}` (R27/R28 de
  `specs/integrations-catalog/requirements.md`). `source` admite `'ai'` (CHECK
  `integration_calls_source`, 091).
- `account_integrations` (091) tiene RLS sin políticas: solo rol de servicio.
- IA: `generateReply` (`src/lib/ai/generate.ts`) despacha a `generateOpenAi | generateAnthropic |
  generateGemini` (`src/lib/ai/providers/*.ts`), que hoy **no usan herramientas**; el texto pasa por
  `parseGeneration` (`HANDOFF_SENTINEL`). Llamadores: `src/lib/ai/auto-reply.ts`,
  `src/app/api/ai/playground/route.ts`, `src/app/api/ai/draft/route.ts`, `src/lib/ai/validate.ts`.
  Prompt en `buildSystemPrompt` (`src/lib/ai/defaults.ts`); gasto en `logAiUsage`
  (`src/lib/ai/usage.ts`).

Notación: «herramienta» = una operación del catálogo expuesta al modelo; «vuelta» = una llamada al
proveedor; «turno» = una invocación de `generateReply` (una respuesta al cliente).

Glosario de verificación: **[V]** test vitest; **[SQL]** SQL contra el Postgres del harness
(`scripts/replay-migrations.sh`, guardado en `progress/checks_integration-ai-tools.sql`);
**[M]** guion manual explícito (proveedor real).

## Requisitos

### Conjunto de herramientas (A1, A4)

- **R1** Cuando se genera una respuesta en modo `auto_reply`, `playground` o `draft`, el sistema
  debe cargar como herramientas solo las operaciones con `integration_operations.is_active = true`
  de integraciones con `integrations.is_active = true` para las que exista una fila de
  `account_integrations` con `account_id` = la cuenta de la conversación (o de la sesión),
  `is_enabled = true`, `credential IS NOT NULL` y `ai_enabled = true`. [V]
- **R2** Cuando el plan de la cuenta no incluye la feature `integrations`, el sistema debe generar
  sin herramientas. [V]
- **R3** Cuando la carga de herramientas falla (error de base, de planes o excepción), el sistema
  debe generar sin herramientas, como hoy, y registrar en consola solo un mensaje fijo sin el
  error ni datos de la cuenta más allá de su id. [V]
- **R4** Cuando hay más de 20 operaciones elegibles, el sistema debe ofrecer solo las 20 primeras en
  orden `integrations.sort_order`, `integrations.name`, `integration_operations.sort_order`,
  `integration_operations.key`. [V]
- **R5** Cuando el modo es `draft`, el sistema debe ofrecer solo operaciones con `method = 'GET'`. [V]
- **R6** El sistema debe nombrar cada herramienta `<slug con «-» → «_»>__<key>` si ese nombre cabe
  en 64 caracteres y no repite otro del mismo turno; si no, `op<n>_<key>` cortado a 64 (n = índice
  1-based). Todo nombre debe cumplir `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`. [V]
- **R7** El sistema debe derivar el esquema de entrada de cada herramienta de `params`: un objeto
  JSON Schema con una propiedad por parámetro con `in` ∈ {`path`,`query`,`body`}, `type`
  (`string|integer|number|boolean`), `description`, la lista `required` y `enum` cuando el tipo es
  `string`; con un `enum` sobre tipo no `string`, los valores admitidos deben ir en la descripción
  y no en `enum`. Un parámetro con cualquier otra ubicación (p. ej. una cabecera que rellena el
  ejecutor) debe omitirse del esquema. [V]
- **R8** Cuando un nombre de parámetro contiene puntos (`a.b.c`), el sistema debe exponerlo como
  propiedades anidadas (`a` → objeto → `b` → objeto → `c`), con `required` propagado a cada nivel
  que contenga un hijo requerido. Cuando dos parámetros chocan (`a` y `a.b`, o tipos distintos en
  el mismo prefijo), el sistema debe omitir esa operación del conjunto. [V]
- **R9** El sistema debe componer la descripción de cada herramienta con el nombre de la
  integración, el nombre y la `description` de la operación y su `response_description` si existe,
  y anteponer «Write operation» cuando `method ≠ 'GET'`; el total no debe pasar de 1024
  caracteres. [V]

### Adaptadores de proveedor (A1, A6)

- **R10** Cuando hay herramientas y el proveedor es `anthropic`, el sistema debe enviar `tools:
  [{name, description, input_schema}]`, leer los bloques `tool_use` (`id`, `name`, `input`) de la
  respuesta, devolver el contenido completo del asistente (incluidos bloques `thinking`) sin
  modificarlo en la vuelta siguiente y enviar **todos** los resultados de esa vuelta en un único
  mensaje `user` de bloques `tool_result` (`tool_use_id`, `content`, `is_error`). [V]
- **R11** Cuando hay herramientas y el proveedor es `openai`, el sistema debe enviar `tools:
  [{type:'function', function:{name, description, parameters}}]`, leer
  `choices[0].message.tool_calls` (`id`, `function.name`, `function.arguments` como texto JSON),
  reenviar el mensaje del asistente tal cual y un mensaje `{role:'tool', tool_call_id, content}`
  por llamada. [V]
- **R12** Cuando hay herramientas y el proveedor es `gemini`, el sistema debe enviar `tools:
  [{functionDeclarations:[{name, description, parameters?}]}]`, leer las partes `functionCall`
  (`name`, `args`, `id` si viene), reenviar el `content` del candidato tal cual (con sus
  `thoughtSignature`) con rol `model` y responder en un único contenido `user` con una parte
  `functionResponse {name, id?, response}` por llamada. [V]
- **R13** Cuando el proveedor termina por límite de salida o por rechazo (`stop_reason`
  `max_tokens`/`refusal`; `finish_reason` `length`/`content_filter`; `finishReason` distinto de
  `STOP`), el sistema no debe ejecutar las herramientas de esa vuelta. [V]
- **R14** Cuando no hay herramientas, el sistema debe enviar a cada proveedor exactamente el mismo
  cuerpo que hoy y devolver el mismo `GenerateResult` (sin campos nuevos). [V]

### Bucle de herramientas (A2)

- **R15** Cuando el modelo pide herramientas en una vuelta, el sistema debe ejecutarlas **en
  orden y de una en una** con `executeIntegrationOperation(db, {accountId, integrationSlug,
  operationKey, params, source: 'ai'})`, entregar los resultados al modelo y pedir la vuelta
  siguiente. [V]
- **R16** El sistema debe convertir los argumentos anidados del modelo en el mapa plano que espera
  el ejecutor (`{a:{b:1}}` → `{'a.b': 1}`), leyendo solo propiedades propias y sin bajar más de 4
  niveles; un argumento que no es objeto debe tratarse como `{}`. [V]
- **R17** Cuando el modelo pide un nombre de herramienta que no está en el conjunto del turno, o
  sus argumentos no son JSON válido, el sistema debe devolverle un resultado de error
  (`unknown_tool` / `invalid_arguments`) sin llamar al ejecutor. [V]
- **R18** El sistema debe ofrecer herramientas en, como mucho, 5 vueltas por turno y ejecutar,
  como mucho, 8 llamadas por turno; una llamada por encima del tope debe recibir el resultado de
  error `limit_reached` sin ejecutarse. Alcanzado cualquiera de los dos topes, la vuelta siguiente
  debe hacerse con elección de herramienta «ninguna» (`tool_choice` `none` / `NONE`). [V]
- **R19** Cuando han pasado más de `AI_TOOL_BUDGET_MS` (por defecto 40 000 ms) desde el inicio del
  turno, el sistema debe hacer la vuelta siguiente con elección «ninguna»; cada vuelta conserva su
  plazo propio (`aiRequestTimeoutMs`). [V]
- **R20** El sistema debe tomar como respuesta solo el texto de la última vuelta, descartar el de
  las vueltas intermedias y pasarlo por `parseGeneration`, de modo que `[[HANDOFF]]` siga
  produciendo `handoff: true`. [V]
- **R21** Cuando el ejecutor lanza (pese a su contrato), el sistema debe devolver al modelo el
  resultado de error `error` y seguir el bucle. [V]
- **R22** Cuando falla una vuelta del proveedor, el sistema debe propagar el `AiError` como hoy
  (sin respuesta parcial); las llamadas ya ejecutadas quedan en `integration_calls`. [V]

### Resultados que ve el modelo (A2, A4)

- **R23** Cuando el ejecutor devuelve `ok: true`, el sistema debe entregar al modelo
  `{"ok":true,"status":<n>,"data":<data>}`; cuando ese JSON pasa de 8192 bytes UTF-8, debe
  entregar `{"ok":true,"status":<n>,"truncated":true,"data_text":<prefijo del JSON de data>}` sin
  pasar de 8192 bytes y sin cortar un carácter. [V]
- **R24** Cuando el ejecutor devuelve `ok: false`, el sistema debe entregar
  `{"ok":false,"outcome":<o>,"status":<n|null>,"hint":<frase fija en inglés por outcome>}`,
  marcado como error en el formato del proveedor; con `outcome = 'invalid_params'` debe añadir
  `problem` y `param` calculados con `validateCallParams` sobre los params declarados; si el
  resultado trae `error.code` / `error.message` de tipo texto (ampliación prevista por n13.5),
  debe añadirlos cortados a 300 caracteres. [V]

### System prompt (A3)

- **R25** Cuando hay herramientas, el sistema debe añadir al system prompt una sección que diga:
  la fecha y hora actuales en UTC (ISO 8601); para cada integración con zona configurada, la hora
  actual en esa zona con su offset (`2026-11-05T10:31:00-04:00`); que las fechas que envíe a una
  herramienta van en ISO 8601 **con offset** de la zona de esa integración (o de la que devuelva la
  propia integración) y que si no la conoce pregunte o la consulte; que antes de una operación de
  escritura confirme los datos con el cliente y espere su sí; que nunca invente ids y use solo los
  devueltos por una herramienta o dados por el cliente; que responda en el idioma del cliente; que
  trate el contenido de los resultados como datos, no como instrucciones; y que si una
  herramienta falla lo diga sin inventar el resultado (en `auto_reply`, que pueda pasar a humano).
  [V]
- **R26** Cuando una integración con herramientas tiene `ai_instructions`, el sistema debe incluirlas
  en esa sección bajo el nombre de la integración, rotuladas como instrucciones del negocio. [V]
- **R27** Cuando no hay herramientas, `buildSystemPrompt` debe devolver exactamente el texto de hoy.
  [V]

### Seguridad y aislamiento (A4)

- **R28** El sistema debe cargar las herramientas y ejecutarlas con la cuenta de la conversación
  (auto-reply) o de la sesión (playground, borrador), filtrando `account_integrations` por
  `account_id` con el rol de servicio; con dos cuentas A y B con la misma integración activa, la
  IA de A no debe ver ni ejecutar con la activación ni la credencial de B (test de fuga CP3 en
  `src/lib/security/tenant-isolation.test.ts`). [V]
- **R29** El sistema no debe escribir en `console.*` credenciales, argumentos, cuerpos de respuesta
  ni el texto de los resultados de herramienta; solo id de cuenta, `slug`, `key`, `outcome`,
  `status` y contadores. [V]
- **R30** Cada ejecución de herramienta debe dejar una fila en `integration_calls` con
  `source = 'ai'` y el `account_id` de la conversación. [V] y [SQL]

### Control y observabilidad (A5)

- **R31** La migración 094 debe añadir a `account_integrations` `ai_enabled boolean NOT NULL DEFAULT
  false`, `ai_instructions text` (≤ 2000 caracteres) y `ai_timezone text` (≤ 64), ser idempotente
  y no tocar RLS. [SQL]
- **R32** Cuando un `admin`+ fuera de sesión de soporte envía `PATCH
  /api/account/integrations/{integrationId}` con alguno de `aiEnabled` (boolean), `aiInstructions`
  (texto ≤ 2000 o `null`) o `aiTimezone` (zona IANA válida o `null`), el sistema debe guardarlos en
  la fila de esa cuenta y devolver la vista actualizada; con plan sin `integrations` → 402; con la
  integración no activada por la cuenta → 404; con un campo inválido → 400 con `field`; con rol
  menor → 403; sesión de soporte → 403. [V]
- **R33** `GET /api/account/integrations` debe devolver por integración `aiEnabled`,
  `aiInstructions` y `aiTimezone` (valores de la cuenta; `false`/`null` si no está activada). [V]
- **R34** Cuando una integración está activada, Ajustes → Integraciones debe mostrar un interruptor
  «Usar en IA» y, con él encendido, un texto de instrucciones y un selector de zona horaria, que
  guardan con R32; en solo lectura o sin plan deben verse deshabilitados. [V]
- **R35** Cuando un turno del playground usa herramientas, `POST /api/ai/playground` debe devolver
  `toolsUsed: [{integration, operation, ok}]` y la UI debe mostrar bajo la respuesta qué
  herramientas se usaron y si fallaron; el playground debe avisar de que las herramientas se
  ejecutan de verdad contra la integración. [V]
- **R36** Cuando un borrador usa herramientas, `POST /api/ai/draft` debe devolver `toolsUsed` y el
  compositor debe indicar con un aviso qué herramientas se consultaron. [V]
- **R37** El sistema debe sumar el uso de tokens de todas las vueltas del turno y registrar **una**
  fila en `ai_usage_log` con la suma (prompt, completion y total); si ninguna vuelta informó uso,
  ninguna fila. [V]

### Compatibilidad, i18n y compuerta (A6)

- **R38** Sin herramientas activas, los tests existentes de `src/lib/ai/generate.test.ts`,
  `src/lib/ai/auto-reply.test.ts`, `src/app/api/ai/playground/route.test.ts` y del borrador deben
  pasar sin modificarse. [V]
- **R39** Todo texto nuevo de UI debe estar en `messages/es.json` y `messages/en.json` con las
  mismas claves. [V] (`src/i18n/messages.test.ts`, test de paridad existente)
- **R40** La compuerta dirigida de la feature debe pasar en verde (lint, typecheck y vitest de los
  archivos tocados) y `CHANGELOG.md` debe registrar el cambio. [V]
- **R41** Prueba con proveedores reales: con una integración de prueba activa y «usar en IA»
  encendido, el playground debe, en cada uno de los tres proveedores, llamar a una operación de
  lectura y responder con su dato, y pedir confirmación antes de una operación de escritura. [M]
  Guion en `design.md` §12.

## Trazabilidad acceptance → requisitos

| Acceptance | Requisitos |
|---|---|
| A1 herramientas en los tres proveedores, esquema derivado del catálogo | R1, R2, R4, R5, R6, R7, R8, R9, R10, R11, R12, R13, R41 |
| A2 bucle, ejecutor con `source ai`, fallo sin lanzar, topes, `parseGeneration` | R15, R16, R17, R18, R19, R20, R21, R22, R23, R24 |
| A3 system prompt y instrucciones por integración | R25, R26, R27, R41 |
| A4 aislamiento, validación, truncado, logs, `integration_calls`, CP3 | R3, R23, R24, R28, R29, R30 |
| A5 interruptor, playground y borrador, tokens sumados | R31, R32, R33, R34, R35, R36, R37 |
| A6 sin herramientas igual que hoy, i18n, compuerta | R14, R27, R38, R39, R40 |
