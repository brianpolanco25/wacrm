# Implementación — f0.4 `platform-ai-key` (fase 0, §4 · supuesto S1)

Rama `saas/fase-0-cimientos`, worktree
`/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/agent-a85d874ab350adc04`.
Spec: `docs/saas/fase-0-cimientos.md`, apartado 4 («Decisión a cerrar en esta fase»).
Revisión que se atiende: `progress/review_platform-ai-key.md` — **tres rondas**. La primera
(cinco cambios requeridos) se cerró en `8909d90`; la segunda (cuatro cambios requeridos, el
primero un bloqueante de pérdida de datos introducido por esa misma corrección) en `a0157a7`;
la tercera (**un** cambio requerido: el lector de `ai_usage_log` se quedó sin enterarse del
modo `'playground'` que la propia feature añadió) se cierra en `1c7ddab`.

Este informe cubre **toda** la feature, no solo la última corrección. Lo nuevo de cada ronda
está en su sección («Segunda ronda de correcciones», «Tercera ronda de correcciones»); las
tablas de commits, de criterio ↔ test y de compuerta están actualizadas.

> Nota de proceso (CP10): hay un conflicto de atribución sin resolver. El líder pide
> `Co-Authored-By: Claude Fable 5.1` y la configuración del harness fija
> `Co-Authored-By: Claude Opus 5 (1M context)` diciendo que reemplaza cualquier indicación
> previa. Los commits de las rondas 1 y 2 mezclan las dos formas; `a0157a7` y `1c7ddab` llevan
> `Claude Fable 5.1`, que es lo que el líder pidió explícitamente y lo que el revisor dio por
> bueno en CP10 de la ronda 3. El trailer existe en todos, que es lo que CP10 exige;
> homogeneizarlo es un `git commit --amend` de una línea por commit, y lo decide el humano.

## Commits

| Commit | Qué aporta a esta feature |
|---|---|
| `afbaecb` | `feat: permitir una clave de IA a nivel de plataforma (supuesto S1)` — `src/lib/ai/platform-key.ts` y su test; resolución cuenta → plataforma en `loadAiConfig`, `POST /api/ai/config` y `POST /api/ai/test`; `platform_key_available` en el `GET`; pista en la UI; `aiConfig.platformKeyHint` en `en`/`ko`. 11 archivos, +797 −207. |
| `8854c65` | `docs: documentar la fase 0 en CHANGELOG y las claves de IA de plataforma` — sección «Platform AI keys» en `docs/docker.md` y entradas Unreleased del `CHANGELOG.md`. 2 archivos, +54. |
| `324f087` (parte) | El commit es de f0.2, pero **la migración es de esta feature**: `supabase/migrations/047_ai_platform_key.sql` (30 líneas: `ai_configs.api_key` deja de ser `NOT NULL`) y su aserción en `supabase/ci/verify-schema.sql`. El `DROP NOT NULL` vivía en 041 y se sacó de ahí por alcance. |
| `8909d90` | `fix: contabilizar quién paga cada llamada de IA y poder volver a la clave de plataforma` — primera corrección (los cinco cambios requeridos de la ronda 1). 20 archivos, +461 −55. |
| `a0157a7` | `fix: no borrar la clave de la cuenta por enfocar el campo y contar el playground` — segunda corrección (los cuatro cambios requeridos de la ronda 2). 15 archivos. |
| `1c7ddab` | `fix: enseñar el modo 'playground' al único lector de ai_usage_log` — tercera corrección (el único cambio requerido de la ronda 3). 4 archivos, +192 −32. |

## Qué hace la feature, de punta a punta

1. `AI_PLATFORM_OPENAI_API_KEY` / `AI_PLATFORM_ANTHROPIC_API_KEY` (variables de servidor, una
   por proveedor porque la cuenta elige proveedor) se leen en `src/lib/ai/platform-key.ts`.
2. `resolveAiApiKey(provider, accountKey)` decide: clave propia → clave de plataforma → `null`
   («IA no configurada», el comportamiento de siempre), y **dice de cuál de las dos se trata**
   (`source`).
3. `loadAiConfig` lo traslada a `AiConfig.apiKey` + `AiConfig.keySource`; los dos sitios que
   llaman al proveedor de verdad (`dispatchInboundToAiReply` y `POST /api/ai/draft`) pasan
   `keySource` a `logAiUsage`, que escribe `ai_usage_log.key_source`.
4. `ai_configs.api_key` es `NULL` cuando la cuenta no trae la suya (migración 047). Nunca
   cadena vacía: «sin clave propia» y «clave vacía por error» siguen siendo distinguibles.
5. La UI solo ve booleanos: `platform_key_available: { openai, anthropic }`. La clave de la
   plataforma no sale del servidor por ninguna ruta.

## Ronda 1 — los cinco cambios requeridos

### 1. Hallazgo 1 — el uso con clave de plataforma es contabilizable (bloqueante)

- `AiKeySource` (`'account' | 'platform'`) se muda a `src/lib/ai/types.ts`, junto a `AiConfig`,
  que es la forma que lo transporta; `platform-key.ts` lo reexporta para no romper a quien lo
  importe de ahí.
- `AiConfig.keySource` es **obligatorio**, no opcional: cualquier productor futuro de un
  `AiConfig` tiene que declarar quién paga, y el compilador lo exige (los cinco sitios que
  construyen uno están actualizados). Igual en `LogAiUsageArgs.keySource`.
- `047_ai_platform_key.sql` (editada en sitio, no está desplegada) añade
  `ai_usage_log.key_source text NOT NULL DEFAULT 'account'` con
  `CHECK (key_source IN ('account','platform'))` y el índice
  `idx_ai_usage_log_account_source_created (account_id, key_source, created_at DESC)`, que es
  la consulta que la fase 3 va a hacer («cuánto le costé a la plataforma este mes»).
  Idempotente: `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` antes del `ADD
  CONSTRAINT`, `CREATE INDEX IF NOT EXISTS`, todo dentro de un `DO` guardado por
  `to_regclass`. Sin backfill: las filas anteriores son BYO por construcción (la columna
  `api_key` era `NOT NULL`), así que el `DEFAULT 'account'` las clasifica bien.
- Tres aserciones nuevas en `verify-schema.sql` (columna con su `NOT NULL` y su `DEFAULT`,
  el `CHECK`, el índice), dentro del único `DO` del archivo.

### 2. Hallazgo 2 — guardar ya no exige una clave que no hace falta

`POST /api/ai/config` calculaba `apiKeyPlain` (y devolvía `400 api_key is required`) **antes**
de saber si iba a validar. Una fila respaldada por la plataforma quedaba congelada en cuanto el
operador rotaba `AI_PLATFORM_*_API_KEY`: ni apagar el asistente. Ahora la resolución de clave
vive **dentro** de `if (credentialsChanged)`, que es el único sitio donde se necesita una clave
(para el viaje de validación al proveedor). `credentialsChanged` ya incluye `!existing`, así
que la creación de la fila sigue exigiendo clave.

Efecto lateral deliberado: un guardado que no toca credenciales tampoco intenta descifrar la
clave guardada, así que una fila con `api_key` corrupta se puede seguir apagando (antes
respondía 400). Tiene su test.

### 3. Hallazgo 3 — camino de vuelta BYO → plataforma

- El `POST` acepta `api_key: null` explícito como «olvida mi clave y usa la de la plataforma»,
  exactamente la convención que ya usaba `embeddings_api_key` (`clearEmbeddingsKey`):
  ausente = sin cambios, texto = fija, `null` = borra.
- `clearKey` entra en `credentialsChanged`: volver a la clave de plataforma **cambia** la clave
  con la que se va a llamar al proveedor, así que se revalida contra ella antes de guardar. Si
  no hay clave de plataforma para ese proveedor, el guardado se rechaza (`api_key is required`)
  en vez de dejar la cuenta sin ninguna clave; para eso está el `DELETE`.
- La UI mandaba `null` al vaciar el campo (`keyPayload()` pasó a
  `keyEdited ? apiKey.trim() || null : undefined`). **Esto estaba mal y la ronda 2 lo
  revierte**: `keyEdited` también lo activaba el `onFocus`, así que enfocar el campo sin
  escribir borraba la clave de la cuenta. Ver «Segunda ronda», cambio 1. La pista con
  `hasStoredKey` (`Settings.aiConfig.platformKeyStoredHint`, `en` + `ko`) sí se queda, con el
  texto reescrito.

### 4. Hallazgos 4, 5 y 6 — documentación y comentarios

- `docs/docker.md`: el orden de resolución se acota a la clave **de chat** y se dice
  explícitamente que la de **embeddings** no tiene respaldo de plataforma (una cuenta sin
  `embeddings_api_key` se queda en búsqueda léxica aunque el despliegue tenga
  `AI_PLATFORM_OPENAI_API_KEY`). Se documenta también el camino de vuelta y la columna
  `key_source`.
- `src/app/api/ai/config/route.ts`: el comentario del `insert` decía «nullable since migration
  041»; es 047.
- `src/lib/ai/types.ts`: el doc de `AiConfig.apiKey` decía «the plaintext BYO provider key».
  Ahora dice que puede ser la de la plataforma (que ni se guarda ni se cifra) y remite a
  `keySource`. Es el contrato que leen draft, playground y auto-reply.

### 5. Hallazgos 7 y 8 — deuda, por decisión del líder

Ver «Deuda detectada» abajo. No se tocan en esta feature.

## Segunda ronda de correcciones

La ronda 1 cerró los cinco cambios en el servidor, pero su cambio 3 metió en la interfaz una
**pérdida de datos**. Los cuatro cambios requeridos de la segunda revisión, con las decisiones
del líder:

### 1. Hallazgo 1 (bloqueante) — enfocar el campo ya no borra la clave

El problema: `keyEdited` significaba dos cosas a la vez. El `onFocus` del campo lo activaba
para quitar la máscara —gesto de «voy a escribir»— y `keyPayload()` lo leía como «el operador
decidió algo». Secuencia realista: admin con clave propia entra en Settings → IA, tabula sobre
el campo (se borra la máscara, como siempre), no escribe, cambia el prompt y guarda → el cuerpo
llevaba `api_key: null`. Con clave de plataforma la cuenta perdía su clave cifrada sin avisar y
sin deshacer; sin ella, el guardado quedaba bloqueado con `missingApiKey` hasta recargar.

Qué se hizo, siguiendo la decisión del líder (separar «se desenmascaró» de «pidió borrar»):

- **`src/lib/ai/secret-field.ts`** (nuevo): la máquina de estados del campo, pura y probada.
  Estado `{ value, typed, clearRequested }` y cinco transiciones —`secretFieldLoaded`,
  `secretFieldFocused`, `secretFieldTyped`, `secretFieldCleared`, más `secretFieldPayload` y
  `secretFieldWillHaveValue`—. Reglas:
  - `focused` solo quita la máscara; **no** marca `typed` ni `clearRequested`;
  - `payload` devuelve `null` **solo** con `clearRequested`;
  - vaciar el campo tras haber escrito devuelve `undefined` («no toques la clave»), que es el
    comportamiento anterior a `8909d90`;
  - escribir cancela un borrado pendiente.
- **`ai-config.tsx`**: los dos campos de clave (chat y embeddings) pasan a usarla; el
  componente ya no decide nada por su cuenta. `keyEdited`/`embeddingsKeyEdited` desaparecen.
- **Petición explícita**: enlace «Use the platform's key instead», visible **solo** cuando
  `hasStoredKey` **y** `platform_key_available[provider]` (la ruta ya expone el booleano por
  proveedor). Al pulsarlo el campo se deshabilita, el marcador pasa a «Using the platform's
  key» y aparece «Keep my key» para deshacer sin recargar. Las guardas del guardado se
  reescriben sobre el payload, no sobre `keyEdited`.
- **Campo de embeddings**: mismo patrón (era preexistente, el líder pidió arreglarlo a la vez).
  No tiene respaldo de plataforma, así que su acción explícita es «Remove this key», visible
  con `hasStoredEmbeddingsKey`, y su aviso dice que la búsqueda vuelve a ser léxica. Con esto
  `AiKnowledgeCard` recibe `hasEmbeddingsKey` de `secretFieldWillHaveValue`, que ya no
  confunde «enfocado» con «vaciado». `handleRemove` además limpia el estado de embeddings, que
  antes se quedaba obsoleto tras borrar la configuración.
- **CP6**: seis claves nuevas en `messages/en.json` y `messages/ko.json`, mismo orden y misma
  posición (`usePlatformKey`, `platformKeyPending`, `platformKeyPlaceholder`, `keepMyKey`,
  `removeEmbeddingsKey`, `embeddingsKeyPending`), y reescritura de `platformKeyStoredHint` y
  `embeddingsHint`, que decían «vacía el campo para…».

Por qué la prueba es de módulo y no de componente: el repo **no tiene jsdom ni
testing-library** (`vitest.config.ts` usa `environment: 'node'`; el único `*.test.tsx` que
existe usa `renderToStaticMarkup`, que no dispara eventos) y no se pueden añadir dependencias.
Todo el criterio del campo vive por eso en `secret-field.ts`, y `secret-field.test.ts` replica
las secuencias de gestos en el mismo orden en que el DOM las dispararía, incluyendo el cuerpo
que sale por el cable (`JSON.parse(JSON.stringify(...))`, que es lo que hace `fetch`). El
componente solo cablea `onFocus`/`onChange`/los enlaces a esas transiciones. Es el mismo
patrón que f1.2 usó con `handoff-message.ts`.

### 2. Hallazgo 2 — el playground ya no es un grifo sin contador

`POST /api/ai/playground` llama a `generateReply` con un `AiConfig` que puede traer la clave de
plataforma y no registraba nada, mientras `docs/docker.md` afirmaba «every LLM call is logged».
Ahora registra igual que `draft/route.ts`: `logAiUsage(supabaseAdmin(), …)` con
`config.keySource`, `conversationId: null`, envuelto en `try/catch` (construir el cliente de
servicio lanza sin `SUPABASE_SERVICE_ROLE_KEY`) y con `void` para no retener la respuesta.

Decisión: **`mode: 'playground'`**, valor nuevo, en vez de contarlo como `'draft'` o
`'auto_reply'`. Falsear el modo ensuciaría las dos métricas que ya existen. Eso obliga a
ampliar el `CHECK` de 033, y se hace **en la propia 047** (que no está desplegada y ya toca esa
tabla), con el patrón drop-then-add idempotente y una aserción nueva en `verify-schema.sql`
(`pg_get_constraintdef(...) LIKE '%playground%'`). Ampliar el dominio no invalida ninguna fila
existente.

### 3. Hallazgo 3 — «Test key» prueba la clave que se va a usar

`POST /api/ai/test` distingue ahora los tres casos, igual que el guardado: texto → esa clave;
**ausente** → la guardada (y si no hay, la de plataforma, como antes); **`null` explícito** →
la de plataforma, sin leer siquiera la fila guardada. La UI manda `null` únicamente cuando el
operador pulsó el enlace, así que ya no puede decir «tu clave funciona» sobre la clave que el
guardado siguiente va a borrar. Si no hay clave de plataforma para ese proveedor, responde
`400 Enter an API key to test.`

### 4. Hallazgo 4 — `keySource` deja de ser un predicado duplicado

En `POST /api/ai/config` el `keySource` que viajaba a `validateAiCredentials` repetía en línea
la escalera `if/else if/else` que acababa de elegir la clave. Ahora se asigna **dentro de cada
rama** (`let keySource: AiKeySource`), así que no hay dos copias que puedan divergir. Sin test
nuevo: es mecánico y el compilador exige que las tres ramas lo fijen.

### Hallazgo 5 (menor) — `.env.local.example`

Sigue bloqueado por permisos. Repetido abajo, en «Pendiente para el humano».

## Tercera ronda de correcciones (`1c7ddab`)

Un solo cambio requerido: el efecto colateral de ampliar el dominio de `ai_usage_log.mode`.

### Hallazgo 1 (bloqueante) — el único lector de la tabla no conocía `'playground'`

**El problema, reproducido.** 047 amplió el `CHECK` a tres valores y `playground/route.ts:109`
ya escribe esas filas, pero `GET /api/ai/usage` indexaba un objeto literal con solo dos
casillas (`byMode[r.mode].calls += 1`). Una fila de banco de pruebas →
`TypeError: Cannot read properties of undefined (reading 'calls')` → `catch` →
`toErrorResponse` → **500** → la tarjeta de consumo sin datos durante toda la ventana. Lo
confirmé antes de tocar nada: el test nuevo salía en rojo con `expected 500 to be 200` en sus
dos primeros `it`.

**Los tres sitios del informe, cerrados:**

1. `src/app/api/ai/usage/route.ts:23-26` — `UsageRow.mode` pasa de `'auto_reply' | 'draft'` a
   `string`, con el comentario de por qué: la unión cerrada era justo lo que impedía a `tsc`
   ver el problema (el `as UsageRow[]` de la línea 87 lo tapaba). Ahora el tipo describe la
   columna, no una suposición sobre los escritores.
2. `src/app/api/ai/usage/route.ts:89-98,115-120` — `byMode` es un
   `Record<string, { calls, tokens }>` sembrado con `KNOWN_MODES`
   (`['auto_reply','draft','playground']`, constante en `:17`) y el acumulado es
   `const tally = (byMode[r.mode] ??= { calls: 0, tokens: 0 })`. La siembra conserva los
   mosaicos fijos de la tarjeta aunque estén a cero; el `??=` garantiza que un cuarto modo
   añadido al `CHECK` en el futuro se cuente en vez de provocar otro 500. **Ninguna llave
   añadida por una fila desconocida sale de los datos de la petición**: son los valores que la
   base ya aceptó en `mode`, no entrada libre del cliente.
3. `src/components/agents/ai-usage.tsx:36-39,51-58,111-116,161-175` — `by_mode` se tipa como
   `Record<string, {...} | undefined>` (el mismo contrato abierto de la ruta), los mosaicos por
   modo salen de `MODE_TILES` (auto-reply, borradores, playground) y lo que la API cuente fuera
   de esa lista aparece como un mosaico **«Other»** calculado por diferencia contra el total
   (`otherTokens`), visible solo si es > 0. Con eso, **«Total tokens» es siempre la suma del
   desglose** —el hallazgo 2— y lo sigue siendo con modos que este build no conoce. La rejilla
   pasa de `sm:grid-cols-4` a `grid-cols-2 sm:grid-cols-3 lg:grid-cols-5` para las cinco (o
   seis) casillas.

**El test que faltaba** — `src/app/api/ai/usage/route.test.ts`, nuevo, tres `it`, patrón de
mocks encadenados del repo (`requireRole` simulado + cadena
`from().select().eq().gte().order().limit()`), con `toErrorResponse` imitando al real (500)
para que un fallo se vea como lo vería el navegador:

| `it` | Qué asevera |
|---|---|
| «summarises auto_reply, draft and playground rows without dropping any tokens» | 200; `by_mode.auto_reply/draft/playground` exactos; `totals.total_tokens === 180`; **suma del desglose === total**; `totals.calls === 3`. **Rojo antes del arreglo** (500). |
| «tallies a mode it has never heard of instead of failing the request» | Una fila `future_mode`: 200, casilla propia y suma === total. **Rojo antes del arreglo** (500). |
| «keeps the summary scoped to the caller account» | La consulta filtra `['account_id','acct-1']` (CP3 sobre la ruta que no tenía test). |

Texto de interfaz nuevo: «Playground», «Other» y la descripción de la tarjeta. **No van a
`messages/`** y es deliberado: `ai-usage.tsx` no usa `next-intl` en ninguna de sus ~20 cadenas
(no hay `useTranslations` ni namespace `AiUsage` en `en.json`/`ko.json`). Traducir dos rótulos
de veinte habría dejado la tarjeta a medias y era ampliar el alcance; queda anotado como deuda
(punto 7). Las claves que **sí** añadió esta feature (`Settings.aiConfig`, seis) están en los
dos catálogos, sin cambios en esta ronda.

**Ruido de formato evitado.** `prettier --write` sobre `route.ts` y `ai-usage.tsx` reescribía
136 y 86 líneas (punto y coma en `route.ts`, reordenación de clases de Tailwind en el `.tsx`):
ambos archivos son preexistentes y no cumplen `.prettierrc` (punto 4 de la deuda). Se revirtió
y se editó **en el estilo de cada archivo**, como en la ronda 2; el diff quedó en +59 −29 sin
una sola línea ajena tocada. El archivo nuevo, `route.test.ts`, sí pasó por prettier.

### Hallazgos 3, 4 y 5 (observaciones del revisor)

No eran de una línea, así que **no se tocan** y quedan anotados:

- **3 — la máscara no vuelve al perder el foco** (`src/lib/ai/secret-field.ts:50`). Arreglarlo
  pide una transición nueva (`secretFieldBlurred`) con sus casos en `secret-field.test.ts` y
  un `onBlur` en dos campos de `ai-config.tsx`: código de producto nuevo, no una línea. El dato
  está a salvo (es lo que cerró la ronda 2); lo que engaña es la pantalla. Deuda, punto 8.
- **4 — comentarios de borrador en el bloque de carga** (`ai-config.tsx:279-281`) y
  `t('loadFailed')` usado como texto de «cargando». Preexistente, ajeno a esta feature y a este
  archivo del diff. Deuda, punto 9.
- **5 — `.env.local.example`** sigue sin las dos variables. Bloqueado por permisos; pendiente
  del humano. Repetido por cuarta vez, ver «Variables de entorno nuevas».

## Criterio ↔ test

Criterios del apartado 4 del spec (S1) y los cinco cambios requeridos por la revisión.

| Criterio / cambio | Archivo | `it(...)` |
|---|---|---|
| C1 Clave de plataforma por variable de entorno, usada cuando la cuenta no trae la suya | `src/lib/ai/platform-key.test.ts` | «reads one variable per provider», «falls back to the platform key when the account has none» |
| C1 (camino real de uso) | `src/lib/ai/config.test.ts` | «uses the platform key when the account has no stored key» |
| C2 `ai_configs.api_key` opcional | `supabase/ci/verify-schema.sql` (aserción) + `progress/checks_platform-ai-key.sql` parte A | — (SQL) |
| C3 Resolución en ambos sentidos y por proveedor | `src/lib/ai/platform-key.test.ts` | «prefers the account key when present», «does not let one provider's platform key serve another provider» |
| C3 (en `loadAiConfig`) | `src/lib/ai/config.test.ts` | «prefers the stored key over the platform key», «does not use another provider's platform key» |
| C3 (al guardar) | `src/app/api/ai/config/route.test.ts` | «prefers a typed key over the platform key and stores it encrypted», «prefers the stored key over the platform key on update», «does not fall back to another provider's platform key», «updates a platform-backed row (stored api_key null) using the platform key» |
| C3 (al probar la clave) | `src/app/api/ai/test/route.test.ts` | las cuatro precedencias («tests the platform key when nothing is typed or stored», etc.) |
| C4 La clave de plataforma nunca vuelve a la interfaz | `src/app/api/ai/config/route.test.ts` | «reports per-provider availability without exposing the keys (unconfigured)», «reports availability alongside a configured row and never returns the stored key» |
| **C5 El uso con clave de plataforma es contabilizable por cuenta** (cambio requerido 1) | `src/lib/ai/usage.test.ts` | **«tells a call paid by the platform apart from one paid by the account, both scoped to their account»**, «keeps the account key as the source even when a platform key exists», «inserts a row mapping normalized usage to the log columns» (ahora asevera `key_source`) |
| C5 (origen en el config) | `src/lib/ai/config.test.ts` | «uses the platform key…» y «prefers the stored key…» aseveran `keySource` |
| C5 (contra base real) | `progress/checks_platform-ai-key.sql` parte B | B1–B5 |
| C5 (**el gasto además se puede ver**: ronda 3) | `src/app/api/ai/usage/route.test.ts` | «summarises auto_reply, draft and playground rows without dropping any tokens», «tallies a mode it has never heard of instead of failing the request» |
| C6 (sobre la ruta de consumo, que no tenía test) | `src/app/api/ai/usage/route.test.ts` | «keeps the summary scoped to the caller account» |
| C6 Ninguna consulta de rol de servicio pierde el `account_id` | `src/app/api/ai/config/route.test.ts` | «scopes every ai_configs query to the caller account» |
| C7 `docs/docker.md` documenta las variables | `docs/docker.md` §«Platform AI keys» | — (doc) |
| **Cambio requerido 2** (guardado no bloqueado) | `src/app/api/ai/config/route.test.ts` | **«saves a toggle on a platform-backed row after the platform key is gone (no key required)»**, «does not touch a corrupt stored key when the save changes nothing that needs validating» |
| **Cambio requerido 3** (ida y vuelta) | `src/app/api/ai/config/route.test.ts` | **«round trip: BYO key, then back to the platform key»** (incluye el tercer tramo: la fila resultante la lee `loadAiConfig` y resuelve a la clave de plataforma), «an explicit api_key: null clears the stored key and validates with the platform one», «refuses to clear the key when there is no platform key to fall back to», «an absent api_key still leaves the stored key alone» |
| **Ronda 2, cambio 1** (enfocar no borra) | `src/lib/ai/secret-field.test.ts` | **«leaves the stored key alone when the field was only focused (no typing)»**, **«keeps api_key out of the body when a focused-but-untouched field is saved with another change»**, **«does not block a save after focusing the key field on a deployment with no platform key»** |
| Ronda 2, cambio 1 (las otras transiciones) | `src/lib/ai/secret-field.test.ts` | «sends the typed key», «treats deleting what you typed as a change of mind, not as "erase my key"», «sends null only on an explicit clear request», «cancels a pending clear as soon as a new key is typed», «does not re-mask a field that is already being edited», «sends nothing from an untouched field on an account with no stored key», «restores the mask when the clear request is undone» |
| Ronda 2, cambio 1 (guardas del guardado) | `src/lib/ai/secret-field.test.ts` | «still asks for a key on a first save with nothing typed and no platform key», «refuses to drop the stored key when there is no platform key to land on» |
| Ronda 2, cambio 1 (campo de embeddings / tarjeta de conocimiento) | `src/lib/ai/secret-field.test.ts` | «follows the pending decision, falling back to what is stored» |
| **Ronda 2, cambio 2** (el playground se contabiliza) | `src/app/api/ai/playground/route.test.ts` | **«logs a platform-funded turn to ai_usage_log, scoped to the account»**, «records the account as the payer when the account brought its own key», «still answers when the usage log cannot be written», «writes nothing when the provider reported no usage», «logs nothing when the provider call fails» |
| Ronda 2, cambio 2 (contra base real) | `progress/checks_platform-ai-key.sql` parte C | C1–C3 |
| **Ronda 2, cambio 3** («Test key» prueba lo que se va a usar) | `src/app/api/ai/test/route.test.ts` | **«tests the platform key on an explicit api_key: null, not the stored one»**, «tests the stored key when api_key is absent, even with a platform key around», «refuses an api_key: null when the provider has no platform key» |

Los tests nuevos son **detectores**, comprobado revirtiendo el código y viéndolos rojos:

Ronda 1:

- quitar `key_source: args.keySource` del `insert` de `usage.ts` → 3 rojos;
- quitar la rama `else if (clearKey) shared.api_key = null` → 2 rojos;
- volver a exigir la clave siempre (`if (true)` en lugar de `if (credentialsChanged)`) → 2 rojos.

Ronda 2 (cada uno reproduce exactamente el código anterior a esta corrección):

- devolver a `secret-field.ts` la semántica de `8909d90` (`secretFieldFocused` marcando
  `typed`, y `payload` devolviendo `null` con el campo vacío) → **5 rojos** de 13 en
  `secret-field.test.ts`, entre ellos los tres marcados en negrita arriba;
- que `/api/ai/test` vuelva a leer siempre la fila guardada (`if (true)` en lugar de
  `if (!clearKey)`) → **2 rojos** de 7;
- quitar el bloque `logAiUsage` del playground → **2 rojos** de 5.

## Verificación contra base real

`progress/checks_platform-ai-key.sql`, ejecutado contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh <worktree>`, imagen `supabase/postgres:17.4.1.075`).
Todo va dentro de una transacción con `ROLLBACK`, y cada aserción hace `RAISE`: una corrida
silenciosa es una corrida que pasa.

- **A** — `ai_configs` acepta una fila con `api_key = NULL` (antes de 047 fallaba) y sigue
  aceptando la clave cifrada de una cuenta BYO.
- **B1** — dos inquilinos, dos llamadas cada uno: la suma de tokens de la cuenta A sale entera
  por `key_source = 'platform'` y la de B por `'account'`; ninguna se cuela en la otra.
- **B2** — ninguna fila sin `account_id`; las filas de plataforma pertenecen a una sola cuenta.
- **B3** — un `INSERT` al estilo 033 (sin `key_source`) queda como `'account'`.
- **B4/B5** — controles negativos: `key_source = 'vendor'` lo rechaza el `CHECK` y `NULL` lo
  rechaza el `NOT NULL`.
- **C1** (ronda 2) — una fila `mode = 'playground'` con `key_source = 'platform'` se acepta y
  cae en el mismo cubo por cuenta y por origen que las demás.
- **C2** — el playground no tiene conversación: la fila con `conversation_id = NULL` entra
  (si no, el gasto se perdería justo donde paga la plataforma).
- **C3** — control negativo: ampliar el dominio no lo abrió; `mode = 'sandbox'` lo sigue
  rechazando el `CHECK`.

Controles del propio SQL y de la migración, en el mismo contenedor:

- al hacer `ALTER TABLE ai_usage_log DROP COLUMN key_source`, el archivo de comprobación
  **falla** y `verify-schema.sql` **falla** con el mensaje de 047 (ronda 1);
- devolver el `CHECK` de `mode` a su forma de 033 (`IN ('auto_reply','draft')`) hace fallar
  `verify-schema.sql` con `ai_usage_log_mode_check does not accept 'playground' (migration
  047)`; reaplicar 047 lo repara (ronda 2);
- reaplicar 047 dos veces más no cambia nada (idempotente, solo `NOTICE ... skipping`) y
  `verify-schema.sql` sigue en verde.

## Compuerta

Ejecutada entera en el worktree, en orden:

- `npm run lint` — 0 errores, 37 warnings preexistentes (`react-hooks/exhaustive-deps`,
  `no-unused-vars`), ninguno en archivos de esta feature. Es la línea base de la rama.
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — `Test Files 86 passed (86)`, `Tests 905 passed (905)`
  (ronda 1: 83 / 881; ronda 2: 85 / 902; la ronda 3 añade `src/app/api/ai/usage/route.test.ts`
  con tres `it`).
- `npm run build` (con las cuatro variables dummy de `ci.yml`) — compila.
- `scripts/replay-migrations.sh "$(pwd)"` — salida 0, `ok 047_ai_platform_key.sql`,
  `verify-schema.sql: OK`. La ronda 3 no toca SQL (es agregación en proceso, como decía el
  informe del revisor); el replay se corrió igualmente tras el cambio y sigue en verde.

## Verificaciones manuales pendientes

Nada depende de Meta ni de PayPal aquí, pero **el viaje real al proveedor no se puede probar
en CI**: `validateAiCredentials` está simulado en los tests. Guion, en un despliegue con
`AI_PLATFORM_OPENAI_API_KEY` puesta:

1. Settings → AI, cuenta sin configurar: el campo de clave muestra la pista «Optional on this
   deployment…». Guardar sin escribir clave → éxito; en base, `ai_configs.api_key IS NULL`.
2. Mandar un mensaje entrante que dispare la respuesta automática. En base:
   `SELECT account_id, key_source, total_tokens FROM ai_usage_log ORDER BY created_at DESC
   LIMIT 1` → `key_source = 'platform'` y el `account_id` de esa cuenta.
3. Escribir la clave propia de la cuenta y guardar. La pista cambia a «This account is using
   its own key…». Repetir el paso 2 → `key_source = 'account'`.
4. Pulsar «Use the platform's key instead» y guardar → 200; `api_key` vuelve a `NULL` y el
   paso 2 vuelve a dar `'platform'`. Antes de guardar, «Test key» debe validar la clave de
   **plataforma** (con una clave propia inválida guardada, el test tiene que seguir dando
   verde). Contraprueba del bloqueante de la ronda 2: con una clave propia guardada, hacer
   clic en el campo de clave, **no escribir nada**, cambiar el prompt y guardar → la clave
   propia sigue ahí (`ai_configs.api_key IS NOT NULL`) y el paso 2 sigue dando `'account'`.
5. Abrir el playground y mandar un mensaje de prueba. En base:
   `SELECT mode, key_source, conversation_id FROM ai_usage_log ORDER BY created_at DESC
   LIMIT 1` → `('playground', 'platform', NULL)`. **Acto seguido** (contraprueba del
   bloqueante de la ronda 3, que es donde se veía el 500): recargar Settings → AI con un
   usuario `admin` y mirar la tarjeta «Token usage». Debe cargar —no «Failed to load usage»— y
   enseñar un mosaico «Playground» con los tokens de ese turno; «Total tokens» tiene que ser
   exactamente la suma de «Auto-reply» + «Drafts» + «Playground» (+ «Other», si apareciera).
   Con las tres ventanas (7 / 30 / 90 días).
6. Quitar `AI_PLATFORM_OPENAI_API_KEY` del entorno y reiniciar, con una cuenta sin clave
   propia: apagar el asistente desde Settings → AI debe responder 200 (esto es el hallazgo 2;
   antes daba `400 api_key is required`). El enlace «Use the platform's key instead» no debe
   aparecer en ese estado, y el campo de embeddings debe ofrecer «Remove this key» solo cuando
   la cuenta tenga una guardada.

## Decisiones donde el spec era ambiguo

- **Una variable por proveedor**, no una sola clave: la cuenta elige proveedor y una clave de
  OpenAI no le sirve a quien eligió Anthropic. El spec dice «una clave del proveedor de
  modelos», en singular; se interpretó como «una por proveedor».
- **`keySource` obligatorio** en `AiConfig` y `LogAiUsageArgs`, no opcional con valor por
  defecto: un default silencioso `'account'` es justo la forma en que el gasto de la plataforma
  volvería a perderse.
- **Borrar la clave propia sin clave de plataforma se rechaza.** Alternativa descartada:
  aceptarlo y dejar la cuenta con la IA apagada de hecho. El `DELETE /api/ai/config` ya existe
  para eso y es explícito.
- **Nada de respaldo de plataforma para embeddings.** El spec habla de «la clave del proveedor
  de modelos»; extenderlo a embeddings cambiaría el coste (indexar toda la base de conocimiento
  de cada inquilino) sin que el spec lo pida. Queda documentado como límite, no como olvido.
- **El periodo/cuota no se toca**: la métrica `ai_replies` empieza a contar en la fase 1 y el
  límite se aplica en la fase 3, tal cual dice el apartado 4.
- **Ronda 2 — borrar la clave es un acto explícito, no la ausencia de texto.** Alternativa
  descartada: mantener «vacía el campo y guarda» pero solo cuando el operador hubiera escrito
  algo antes. Se descartó porque un borrado accidental (seleccionar todo y pulsar Supr) seguiría
  pareciéndose demasiado al gesto de escribir; con un enlace propio la intención es inequívoca
  y además se puede deshacer sin recargar.
- **Ronda 2 — `mode = 'playground'` en vez de reutilizar `'draft'`.** Reutilizar habría evitado
  tocar SQL, pero `ai_usage_log` es la tabla sobre la que la fase 3 va a facturar: meter ahí
  llamadas etiquetadas como algo que no son es peor que ampliar un dominio en una migración que
  todavía no está desplegada.
- **Ronda 2 — el enlace de vuelta a la plataforma solo aparece con respaldo.** Si el despliegue
  no tiene clave para ese proveedor no hay adónde volver, y la acción sería una trampa; la
  guarda del guardado se mantiene igualmente por si el operador cambia de proveedor después de
  pulsarlo.

## Variables de entorno nuevas

| Variable | Obligatoria | Dónde está documentada |
|---|---|---|
| `AI_PLATFORM_OPENAI_API_KEY` | No | `docs/docker.md` §«Platform AI keys (optional)» |
| `AI_PLATFORM_ANTHROPIC_API_KEY` | No | idem |

Las dos son secretos de servidor en tiempo de ejecución; nunca `NEXT_PUBLIC_*`. Sin ninguna de
las dos, el comportamiento es exactamente el de antes (clave obligatoria al configurar la IA).

La ronda 2 **no** añade ninguna variable nueva.

**Pendiente para el humano:** `.env.local.example` está bloqueado por permisos
(`.claude/settings.json`) y le faltan las dos variables. No se ha tocado (hallazgo 5 de la
segunda revisión, repetido aquí para que no se pierda al fusionar).

## Deuda detectada (fuera de alcance, no arreglada)

1. **Hallazgo 7 — gasto de plataforma sin techo.** `model` es texto libre por diseño
   (`src/lib/ai/defaults.ts`: «never a hard allow-list») y `system_prompt` no tiene límite de
   longitud, así que cualquier admin de cualquier cuenta puede dirigir la clave de la
   plataforma a un modelo caro; `POST /api/ai/test` es un segundo grifo sobre la misma clave,
   acotado solo por `RATE_LIMITS.adminAction`. La cuota es de la fase 3 y el spec de la fase 0
   dice explícitamente «sin aplicar límites todavía». Lo que sí cambia con esta feature: ya
   existe la **señal** para medirlo (`ai_usage_log.key_source` + el índice por
   `(account_id, key_source, created_at)`), que era la objeción de fondo del reviewer. Al
   cablear la fase 3 conviene: techo de `system_prompt`, lista de modelos permitidos **solo**
   cuando la clave es de plataforma, y cuota de `ai_replies` por plan.
2. **Hallazgo 8 — numeración 047 por delante de 042-046.** 042/043 son de la fase 1, 044 de la
   fase 2 y 045/046 de la fase 3, y aterrizan **después**. En CI da igual (`supabase db reset`
   reconstruye en orden léxico y `replay-migrations.sh` también), pero `supabase db push`
   rechaza insertar migraciones anteriores a la última aplicada en remoto. **Decisión del
   humano pendiente** sobre la vía de aplicación en producción antes de fusionar; no se
   renumera nada aquí porque tocaría cuatro ramas de fase a la vez.
3. **`console.error(err)` crudo del proveedor** en `src/app/api/ai/config/route.ts` y
   `src/app/api/ai/test/route.ts`: si un SDK futuro incluyera la clave en el error, acabaría en
   los logs. Es preexistente (ya pasaba con la clave BYO), pero con la clave de plataforma el
   radio de daño es todo el despliegue, no una cuenta. Merece un `fix:` propio que registre
   solo `code`/`status`.
4. **Formato.** `src/lib/ai/types.ts`, `usage.ts`, `auto-reply.ts`, `draft/route.ts`,
   `playground/route.ts`, `CHANGELOG.md`, `docs/docker.md`, `messages/en.json` y varios
   `*.test.ts` vecinos no cumplen `.prettierrc` desde antes de esta feature (comprobado con
   `git stash` + `prettier --check`: los avisos son idénticos sin mis cambios). Las ediciones
   se hicieron **en el estilo de cada archivo** para no repetir el ruido que el reviewer marcó
   en CP8; `prettier --write` solo se pasó a los archivos ya limpios que mis ediciones habrían
   ensuciado. Reformatear el resto es un `chore:` propio.
5. **No hay prueba de componente de verdad.** `secret-field.test.ts` cubre todo el criterio del
   campo, pero no el cableado `onFocus`/`onChange` → transición dentro de `ai-config.tsx`: un
   futuro `onFocus={() => setKeyField(secretFieldCleared())}` pasaría la compuerta. Cerrarlo
   pide jsdom + testing-library, que es una decisión de dependencias para el humano y afecta a
   todo el repo (hoy solo hay un `*.test.tsx`, con `renderToStaticMarkup`). Mitigación mientras
   tanto: el componente no tiene ninguna lógica de clave propia — todo pasa por las cinco
   funciones del módulo, así que la superficie sin cubrir son cinco líneas de JSX.
6. **`POST /api/ai/test` sigue sin contarse en `ai_usage_log`.** Es una llamada real al
   proveedor con la clave de plataforma (acotada por `RATE_LIMITS.adminAction`), pero no
   produce tokens de generación ni tiene `usage` que registrar: `validateAiCredentials` no
   devuelve uso. Queda anotado con el hallazgo 7 (techo del gasto de plataforma), que es de la
   fase 3.

7. **`src/components/agents/ai-usage.tsx` no está traducida.** Ninguna de sus ~20 cadenas pasa
   por `next-intl` (no hay `useTranslations` en el archivo ni namespace suyo en `messages/`);
   es preexistente y la ronda 3 se limitó a seguir el estilo del archivo con «Playground» y
   «Other». Internacionalizar la tarjeta entera es un `chore:` propio: ~20 claves nuevas en
   `en.json` y `ko.json`, incluida la pluralización de `call`/`calls`.
8. **La máscara del campo de clave no vuelve al perder el foco** (hallazgo 3 de la ronda 3,
   `src/lib/ai/secret-field.ts:50`). Tras tabular por el formulario, el campo queda vacío con
   el placeholder `sk-…`, visualmente idéntico a «no hay clave guardada», mientras el texto de
   ayuda afirma lo contrario. El dato no corre peligro. Cierre: una transición
   `secretFieldBlurred` (reponer `secretFieldLoaded(hasStoredKey)` si `!typed &&
   !clearRequested`), sus casos en `secret-field.test.ts` y un `onBlur` en los dos campos.
9. **Comentarios de borrador en el bloque de carga de `ai-config.tsx:279-281`** y `t('loadFailed')`
   mostrado como texto de «cargando». Preexistente y ajeno a esta feature (hallazgo 4 de la
   ronda 3); se anota para que no se pierda.
