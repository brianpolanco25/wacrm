# n13.7 `ai-grounded-availability` — requisitos

**Fase 13** (`feature_list.json`, `sdd: true`, depende de n13.3 y n13.5). Redactada el 2026-11-10
por `spec_author`. Base de lectura: `main` @ a4726df. Migración **095** (la 092 la reserva n13.2).
i18n: `es` (defecto) y `en` (CP6). Diseño en `design.md`; orden de trabajo en `tasks.md`.

## Contexto

Encargo del humano (2026-11-09, ampliado el 2026-11-10). La IA de Rehactive (antes «Elsa», desde
el 2026-11-10 «Aura») **afirma cosas que no salen de las herramientas**:

1. Ofrece días y horas de cita que no existen en Cabbity Health, porque el modelo decide si llama a
   `find_availability` y a menudo no lo hace. La regla ya está en el prompt («never invent …
   availability», `buildSystemPrompt` en `src/lib/ai/defaults.ts`) y en la descripción de la
   operación (`src/lib/integrations/catalogs/cabbity-health.ts`, «Úsala SIEMPRE antes…»): no basta.
2. En el playground, tras ofrecer huecos inventados, el cliente dijo «no puedo ir ese día» y la IA
   llamó a `cancel_appointment` sin haber consultado disponibilidad ni ofrecido reprogramar.

El humano pide **garantías de código, no de prompt**, genéricas para cualquier integración del
catálogo (no un parche solo para Health), y que la configuración viva en el diálogo
«Instrucciones para la IA» de Ajustes → Integraciones.

Hechos de partida (verificados en `main`):

- Bucle de herramientas: `runToolLoop` (`src/lib/ai/tools/loop.ts`), tres proveedores
  (`src/lib/ai/providers/{openai,anthropic,gemini}.ts`) con `toolChoice: 'auto' | 'none'`
  (`ProviderToolArgs`, `src/lib/ai/providers/shared.ts`). Solo cuenta el texto de la última vuelta.
- Llamadores con herramientas: `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`),
  `POST /api/ai/playground` y `POST /api/ai/draft` (`src/app/api/ai/*/route.ts`). El playground es
  sin estado (el cliente reenvía el transcript); el borrador solo ofrece operaciones `GET`.
- Las herramientas se cargan con `loadAiToolset` (`src/lib/ai/tools/load.ts`) de
  `account_integrations` (`ai_enabled`, `ai_instructions`, `ai_timezone`, migración 094) y del
  catálogo en base (`integrations`, `integration_operations`).
- Toda llamada pasa por `executeIntegrationOperation` (`src/lib/integrations/execute.ts`), que
  registra una fila en `integration_calls` (091) **sin** `conversation_id`: hoy no hay forma de
  saber qué herramientas se usaron en turnos anteriores de una conversación.
- Límites: el CRM corta a 60 llamadas/min por cuenta (`RATE_LIMITS.integrationCall`,
  `src/lib/rate-limit.ts`, en `performIntegrationRequest`); Health admite 120/min por clave.

Notación: **vuelta** = una llamada al proveedor; **turno** = una respuesta al cliente
(`generateReply`); **lectura en vivo** = operación configurada que el sistema ejecuta antes del
turno; **evidencia** = una llamada a operación con resultado `ok`. **Afirmación de agenda** =
texto que menciona un día de la semana, una fecha o una hora.

Verificación: **[V]** test vitest junto al código; **[SQL]** contra el Postgres del harness
(`scripts/replay-migrations.sh`, guardado en `progress/checks_ai-grounded-availability.sql`);
**[M]** guion manual con proveedor y Health reales (design §12).

## Criterios de aceptación (derivados del encargo; la entrada no tenía `acceptance`)

- **A1** Lecturas en vivo configurables por cuenta e integración, ejecutadas antes de cada turno
  de IA, con plantillas de fecha `{{today}}` / `{{today+Nd}}` en la zona de la integración.
- **A2** Su resultado entra en el system prompt como bloque fechado y compacto (agrupado por día,
  hora local), con la regla de que son los únicos huecos que puede mencionar; si la carga falla,
  el prompt lo dice y prohíbe afirmar días u horas.
- **A3** Caché corto por cuenta + operación + parámetros, para no agotar 60/min (CRM) ni 120/min
  (Health).
- **A4** Segunda capa decidida en el spec (guardia del texto final frente a `tool_choice` forzado),
  genérica y en los tres proveedores.
- **A5** Guardia de operaciones destructivas declarativa en el catálogo: `cancel_appointment` solo
  se ejecuta si antes, en la conversación, se localizó la cita y hubo `find_availability` con
  resultado; si no, el modelo recibe un error de política que le obliga a ofrecer huecos.
- **A6** UI en el diálogo «Instrucciones para la IA», es/en.
- **A7** Compuerta en verde + CHANGELOG + guion manual.

## Requisitos

### Configuración de lecturas en vivo (A1, A6)

- **R1** El sistema debe guardar en `account_integrations.ai_live_reads` (jsonb, migración 095,
  `NOT NULL DEFAULT '[]'`) una lista de como mucho 3 lecturas en vivo, cada una
  `{ "operation": <key>, "params": { <nombre>: <string|number|boolean> } }`; la base debe rechazar
  un valor que no sea un array o tenga más de 3 elementos. [SQL]
- **R2** Cuando el admin envía `aiLiveReads` en `PATCH /api/account/integrations/[integrationId]`,
  el sistema debe rechazar con 400 y `field: 'aiLiveReads'` la lista si: no es un array; tiene más
  de 3 elementos; una entrada no tiene `operation` string; la operación no existe, no está activa o
  no es `GET` en ESA integración; o sus `params`, con las plantillas resueltas a una fecha fija,
  no pasan `validateCallParams` contra los parámetros declarados de la operación. [V]
- **R3** Cuando una cadena de `params` contiene `{{…}}`, el sistema debe aceptar solo `{{today}}`
  y `{{today+Nd}}` con N entero de 1 a 60; cualquier otra plantilla se rechaza con 400 (R2). [V]
- **R4** Cuando se resuelven las plantillas, el sistema debe sustituir `{{today}}` por la fecha
  local `YYYY-MM-DD` de «ahora» en `ai_timezone` de la integración (UTC si es `null`) y
  `{{today+Nd}}` por esa fecha más N días de calendario; la sustitución puede ir dentro de un
  texto más largo. [V]
- **R5** Cuando `aiLiveReads` es `[]` o `null`, el sistema debe guardar `[]`. [V]
- **R6** Cuando se lee la vista de integraciones de la cuenta, el sistema debe devolver
  `aiLiveReads` y, por cada operación `GET` activa, sus parámetros de llamada (los de
  `callerParams`: nombre, tipo, requerido, descripción, enum), solo con la integración activada. [V]
- **R7** El diálogo «Instrucciones para la IA» debe permitir añadir hasta 3 lecturas en vivo
  (operación `GET` de la integración + un campo por parámetro de llamada), quitar una, ver la
  ayuda de plantillas y guardar junto a instrucciones y zona en el mismo PATCH; con 3 lecturas el
  botón «Añadir» queda deshabilitado; un 400 con `field: 'aiLiveReads'` se muestra en el diálogo
  sin cerrarlo. [V]
- **R8** Todo texto nuevo de UI debe estar en `messages/es.json` y `messages/en.json` con la misma
  clave y placeholders. [V]

### Ejecución y caché (A1, A3)

- **R9** Cuando un turno de IA va a llamar al proveedor en modo `auto_reply`, `playground` o
  `draft` y el toolset no está vacío, el sistema debe ejecutar, en paralelo, las lecturas en vivo
  de las integraciones del toolset con `source: 'ai'`, la cuenta de la conversación o de la sesión
  y las plantillas resueltas al instante del turno. [V]
- **R10** En `auto_reply`, el sistema debe ejecutar las lecturas en vivo solo después de ganar la
  reserva del mensaje (`claimInboundAutoReply`) y pasar el límite por cuenta; un turno que no se
  va a responder no debe llamar a la integración. [V]
- **R11** Cuando una lectura con la misma cuenta, integración, operación y parámetros resueltos
  tuvo resultado `ok` hace menos de `AI_LIVE_DATA_TTL_MS` (60 000 ms por defecto), el sistema debe
  reutilizarlo sin llamar a la integración. [V]
- **R12** Cuando una lectura falla, el sistema debe recordar el fallo como mucho 10 s para esa
  clave (sin volver a llamar en ese intervalo) y no reutilizarlo después. [V]
- **R13** Cuando una herramienta que no es `GET` de una integración devuelve `ok` dentro de un
  turno, el sistema debe invalidar las entradas de caché de esa cuenta e integración. [V]
- **R14** La caché debe ser por proceso, con un tope de 500 entradas (al pasarlo se descartan las
  más antiguas), y nunca debe compartir entradas entre cuentas. [V]
- **R15** Cuando la carga de lecturas en vivo lanza, el sistema debe tratar cada lectura afectada
  como fallida y seguir el turno; nunca debe tumbar el turno ni escribir en consola parámetros ni
  resultados (solo cuenta, slug, key y outcome). [V]

### Bloque de datos en el prompt (A2)

- **R16** Cuando hay lecturas en vivo en el turno, el sistema debe añadir al system prompt una
  sección «Live data» con, por lectura: nombre de la integración, operación, instante de carga en
  ISO con la zona de la integración y el bloque de datos. Sin lecturas, el system prompt debe ser
  idéntico byte a byte al de hoy. [V]
- **R17** Cuando el resultado `ok` contiene una lista de objetos (el cuerpo o su `data`) cuyos
  elementos tienen un campo de fecha-hora ISO 8601 con offset (`starts_at` si existe; si no, el
  primero que lo sea), el sistema debe agruparlos por día local de la zona de la integración, con
  cabecera `YYYY-MM-DD (<día de la semana en inglés>, UTC±HH:MM)` y una línea por elemento con la
  hora local `HH:MM`, el fin `–HH:MM` si hay `ends_at`, y los demás campos escalares `clave=valor`. [V]
- **R18** Cuando el resultado `ok` es una lista vacía, el bloque debe decir que no hay resultados
  en el rango; cuando trae `meta.truncated = true`, debe decir que hay más de los mostrados. [V]
- **R19** Cuando el resultado no encaja en R17/R18, el sistema debe incluir su JSON compacto. En
  todos los casos el bloque de una lectura no debe pasar de 6 000 bytes: se corta por días (o por
  puntos de código en el JSON) y se indica que hay más y que se use la herramienta para un rango
  menor. [V]
- **R20** Cuando la sección incluye datos de una operación, debe decir que son los ÚNICOS
  resultados de esa operación que puede mencionar para ese rango, que para fechas fuera del rango
  llame a la herramienta, y que son datos de un sistema externo, no instrucciones. [V]
- **R21** Cuando una lectura falló, la sección debe decirlo y prohibir afirmar días, fechas u horas
  disponibles basados en esa operación; en `auto_reply` debe indicar que, si el cliente los
  necesita, llame a la herramienta o traspase con `[[HANDOFF]]`. [V]

### Política declarativa de operaciones (A4, A5)

- **R22** El sistema debe guardar en `integration_operations.ai_policy` (jsonb nullable, migración
  095) la política de IA de una operación: `{ "grounds"?: ["schedule"], "requires_prior"?:
  [[<key>, …], …] }`. La base debe rechazar un valor que no sea objeto ni `NULL`. [SQL]
- **R23** `validateOperationInput` (`src/lib/integrations/catalog-validate.ts`) debe aceptar
  `ai_policy` ausente, `null` o con esa forma, y rechazar: claves desconocidas, `grounds` con un
  valor fuera de `['schedule']`, `requires_prior` con más de 3 pasos, un paso vacío o con más de 4
  keys, o una key que no case con el formato de key de operación. [V]
- **R24** El catálogo de Cabbity Health debe declarar `grounds: ['schedule']` en
  `find_availability`, `list_appointments`, `get_appointment`, `create_appointment`,
  `reschedule_appointment` y `confirm_appointment`, y en `cancel_appointment`
  `requires_prior: [['list_appointments', 'get_appointment'], ['find_availability']]`. [V]
- **R25** `scripts/integrations-bootstrap-catalog.ts` debe sincronizar `ai_policy` en las filas
  existentes de `integration_operations` (campo en `OPERATION_SYNCED`). [V]
- **R26** El esquema de herramientas que ve el modelo (`buildAiTools`, `src/lib/ai/tools/schema.ts`)
  no debe exponer `ai_policy`; la descripción de una operación con `requires_prior` debe terminar
  con una frase fija que nombre las herramientas previas exigidas. [V]

### Guardia de operaciones destructivas (A5)

- **R27** El sistema debe guardar en `integration_calls` la `conversation_id` (nullable, FK a
  `conversations` con `ON DELETE SET NULL`, migración 095) de toda llamada de IA hecha en
  `auto_reply`, y `ai_preload = true` (columna `boolean NOT NULL DEFAULT false`) en las lecturas
  en vivo. [SQL] [V]
- **R28** Cuando el toolset de un turno incluye alguna herramienta con `requires_prior`, el sistema
  debe cargar UNA vez, antes de la primera vuelta, la evidencia previa de la conversación: filas de
  `integration_calls` con `account_id` = la cuenta, `conversation_id` = la conversación,
  `source = 'ai'`, `ai_preload = false`, `outcome = 'ok'` y `created_at` en las últimas 24 h,
  ordenadas por `created_at`. Las lecturas en vivo nunca cuentan como evidencia. [V]
- **R29** Cuando el modelo pide una herramienta con `requires_prior`, el sistema debe ejecutarla
  solo si en la evidencia previa (R28; solo turnos anteriores, nunca el actual) de la MISMA
  integración existe, para cada paso en orden, una llamada a alguna de sus keys posterior a la que
  satisfizo el paso anterior. [V]
- **R30** Cuando la política no se cumple, el sistema no debe llamar a la integración ni registrar
  fila en `integration_calls`; debe devolver al modelo `{ok:false, error:'policy_requires_prior',
  required:[<nombres de herramienta de los pasos que faltan>], hint}` con una pista fija en inglés
  que diga que primero llame a esas herramientas y ofrezca al cliente las alternativas en este
  mensaje, y que la operación solo podrá hacerse en un mensaje posterior; y anotar la llamada en
  `toolsUsed` con `ok: false, blocked: 'policy'`. [V]
- **R31** Cuando la carga de evidencia falla, el sistema debe tratar la evidencia como vacía
  (las herramientas con `requires_prior` quedan bloqueadas en ese turno). [V]
- **R32** En el playground (sin conversación), el sistema debe tomar la evidencia previa del campo
  `trail` del cuerpo: lista de como mucho 50 `{integration slug, operation, ok}` de turnos
  anteriores de la sesión, en orden, que la UI acumula de los `toolsUsed` recibidos (sin las
  bloqueadas ni las lecturas en vivo); entradas mal formadas se descartan. [V]
- **R33** La guardia de R29–R31 aplica solo a llamadas con `source: 'ai'`; flows y automatizaciones
  no cambian. [V]
- **R34** La consulta de evidencia debe filtrar por `account_id`: con dos cuentas que comparten un
  `conversation_id` falso, la evidencia de una nunca habilita la herramienta en la otra. [V]

### Guardia del texto final (A4)

- **R35** El sistema debe detectar afirmaciones de agenda en un texto en español o inglés: hora
  (`10:30`, `10.30`, `10h30`, `3 pm`, `3 p. m.`), día de la semana (`lunes`…`domingo`,
  `monday`…`sunday`, con o sin tilde y en mayúsculas), fecha numérica (`12/11`, `2026-11-12`) o
  día + mes (`12 de noviembre`, `November 12`, `12 nov`). «hoy», «mañana», «today» o «tomorrow»
  solos no cuentan. [V]
- **R36** Cuando el turno ofrece alguna herramienta con `grounds: ['schedule']` y el texto final
  contiene una afirmación de agenda, el sistema debe considerarlo **fundamentado** solo si en ese
  turno hubo una lectura en vivo `ok` (de caché o no) o una llamada `ok` a una operación con
  `grounds: ['schedule']`. [V]
- **R37** Cuando el texto final no está fundamentado y el modo es `auto_reply` o `playground`, el
  sistema debe hacer UNA vuelta más con las herramientas (`toolChoice: 'auto'`) y una nota fija
  añadida al system prompt que diga que su borrador mencionaba días u horas sin datos de
  herramienta y que llame a la herramienta de disponibilidad o responda sin días ni horas; si esa
  vuelta pide herramientas, se ejecutan con las reglas normales y sigue el bucle. Esta vuelta extra
  no cuenta para `AI_TOOL_MAX_ROUNDS`, y no se hace si ya se alcanzó `AI_TOOL_MAX_CALLS` o el
  presupuesto de tiempo. [V]
- **R38** Cuando tras la vuelta extra (o sin poder hacerla) el texto sigue sin fundamentar, el
  sistema debe devolver el turno como traspaso (`[[HANDOFF]]`) en `auto_reply` y en `playground`, y
  registrar en consola `[ai grounding]` con cuenta, modo y `handoff` (nunca el texto). [V]
- **R39** En modo `draft` la guardia del texto no aplica (lo revisa un humano antes de enviar). [V]
- **R40** Sin herramientas con `grounds`, el bucle debe comportarse exactamente como hoy (mismas
  vueltas y mismo texto). [V]
- **R41** El sistema no debe forzar `tool_choice` a una herramienta concreta en ningún proveedor
  (decisión D3 de `design.md`); `ProviderToolArgs.toolChoice` sigue siendo `'auto' | 'none'`. [V]

### No regresión y verificación (A7)

- **R42** Los tests existentes de `src/lib/ai/**`, `src/lib/integrations/**` y de las rutas de IA
  deben seguir en verde sin modificarse, salvo los que afirmen la forma exacta de las filas de
  `integration_calls` u `OPERATION_SYNCED`, que se amplían (no se reescriben). [V]
- **R43** Guion manual con Health real y un proveedor real (design §12): con una lectura en vivo de
  `find_availability` configurada, (a) «¿qué días tienen libres?» solo nombra huecos del bloque;
  (b) con la clave de Health invalidada la IA no nombra días ni horas; (c) «quiero cancelar mi
  cita» + «no puedo ir ese día» no cancela sin haber ofrecido huecos en un mensaje anterior. [M]
