# Review — a7.6 openapi-spec

**Veredicto:** CHANGES_REQUESTED

Rama `api/openapi`, worktree `.claude/worktrees/api-openapi`, base `a4ce30a`.
Commits revisados: `dc259ac`, `4da218e`, `68e7da0`, `23bccb8` (28 archivos, +6 173 / −89).
Sin skill `code-review`: revisión a mano.

## Compuerta

Ejecutada por el reviewer, paso a paso, en primer plano, en el worktree:

| Paso | Resultado |
| --- | --- |
| `npm run lint` | **verde** — 0 errores, 35 warnings, todas preexistentes (ninguna en `src/lib/api/v1/openapi/` ni en `mcp-server/`) |
| `npm run typecheck` | **verde** — sin salida |
| `TZ=UTC npm test` | **verde** — 191 archivos, 2 518 tests |
| `npm run build` (variables dummy de `docs/harness.md`) | **verde** — `ƒ /api/v1/openapi.json` en la tabla de rutas |

- replay-migrations: **n/a** (la feature no toca SQL; no hay migración ni `checks_<name>.sql`).
- `npm run typecheck` de la raíz **sí** compila `mcp-server/src/**`: verificado con
  `tsc --noEmit --listFiles`, los 8 archivos de `mcp-server/src/` entran y están limpios.

## Trazabilidad criterio ↔ test

Documento generado y volcado por el reviewer (test temporal sobre `buildOpenApiDocument()`,
borrado después): 25 `paths`, **37 operaciones**, 11 `webhooks`, 318 `$ref`, 334 ejemplos.

- **C1 «El test de cobertura pasa y protege las fases futuras (una ruta nueva sin documentar
  rompe CI)»**: [x] `src/lib/api/v1/openapi/coverage.test.ts`.
  Leído: recorre el disco (`src/app/api/v1/**/route.ts`), saca los métodos por
  `^export (async )?function METHOD(`, convierte `[id]`→`{id}` y compara en los dos sentidos.
  **Comprobado de verdad**: añadí `src/app/api/v1/zzreview/route.ts` con un `export async
  function GET` y fallaron dos `it` (`encuentra rutas en el disco` y `documenta TODA operación
  que existe en src/app/api/v1`, con el mensaje `GET /api/v1/zzreview`); archivo borrado después.
  La guarda del verde vacío (`toBe(37)`) está, y la exclusión está acotada a un único nombre
  de directorio (`openapi.json`) con `it` que falla si alguien la amplía (líneas 32 y 137-144).
  Contrastado aparte: 26 `route.ts` bajo `src/app/api/v1`, 38 handlers exportados, 38 − 1
  (`openapi.json`) = 37. Ninguna ruta usa la forma `export const GET = …` que el regex no vería.
- **C1-bis Inventario (método, ruta, scope, cubo)**: [x] verificado por el reviewer con un
  script sobre el JSON generado contra la tabla de `progress/impl_integracion-api-3.md` §6:
  **las 37 coinciden una a una** en método, ruta, `x-scopes` y `x-rate-limits`
  (`publicApi` en todas + `exports` / `templatesSync` / `webhookAction` con `per: account`
  donde toca). `operationId` único en las 37.
  Única discrepancia: la fila 23 del inventario marca `PATCH /templates/{id}` como
  idempotente y el documento no. **El documento tiene razón**: `withIdempotency` solo
  envuelve 6 rutas (`messages`, `broadcasts`, `tags`, `contacts/{id}/tags`, `exports`,
  `templates` POST; grep sobre `src/app/api/v1/**`), y `templates/[id]/route.ts:122` lo dice
  explícitamente. Es el inventario el que está desfasado — que el líder lo corrija.
- **C2 «`curl /api/v1/openapi.json` devuelve un documento que un cliente OpenAPI estándar
  importa»**: [ ] ← **falla por el hallazgo 1**. El documento es 3.1.0 y bien formado, pero
  `servers[0].url` y las claves de `paths` llevan los dos el prefijo `/api/v1`, así que la URL
  efectiva que compone cualquier cliente (Postman, `openapi-generator`, `openapi-typescript`)
  es `/api/v1/api/v1/…`. Se importa y no funciona.
- **Excepción del export**: [x] `document.test.ts:126` «el export directo NO envuelve: el
  cuerpo es el archivo» y `:136` «pero sus ERRORES sí van en el sobre». Verificado también
  sobre el JSON: el 200 ofrece `application/json` + `text/csv` y cabecera
  `Content-Disposition`; los 400/401/402/403/404/409/429/500 apuntan a `#/…/Error`.
- **`ApiErrorCode` completo, incluidos los de facturación**: [x] enum del documento = los 14
  de la unión `ApiErrorCode` (`src/lib/api/v1/respond.ts:65`) — con `account_read_only`,
  `feature_unavailable`, `quota_exceeded` y `plan_limit_reached` — más 3 de dominio
  (`whatsapp_not_configured`, `meta_error`, `template_malformed`), que existen de verdad
  (`whatsapp/send-message.ts:518`, `broadcast-core.ts:184`, `resolve-config.ts:177`).
  Comparación hecha por el reviewer, no por el test (ver hallazgo 2).
- **`security` legal en 3.1 + scopes en `x-scopes`**: [x] `document.test.ts:52`.
  `security: [{ bearer: [] }]` con lista **vacía** y `securitySchemes.bearer` de tipo
  `http`/`bearer`: correcto para 3.1 (los scopes con nombre solo son legales en `oauth2` /
  `openIdConnect`). La decisión 1 del informe es la buena.
- **`webhooks` de nivel superior con los 11 eventos**: [x] `document.test.ts:367-424`.
  Verificado además por el reviewer: las claves de `webhooks` son exactamente las 11 de
  `src/lib/webhooks/events.ts:15`, y el `data` de **los 11** (no solo los 2 del test) coincide
  campo a campo con `WEBHOOK_EVENT_DATA_FIELDS`, con `['string','null']` donde el dominio
  admite nulo (`text`, `assigned_agent_id`, `phone`, `wa_user_id`, `name`).
  `security: []` por entrada (la firma, no la clave) y las 5 cabeceras `X-Wacrm-*` en orden.
- **`components.schemas` sin `$ref` rotos**: [x] `validate-examples.test.ts` («todos los
  `$ref` del documento apuntan a un esquema que existe») **y** comprobación independiente del
  reviewer resolviendo los 318 `$ref` como punteros JSON contra el documento volcado: **0 rotos,
  ninguno externo**.
- **Comprobador estructural de ejemplos**: [x] `validate-examples.ts` +
  `validate-examples.test.ts`. Leído: comprueba `$ref` (y un `$ref` colgado es error, no
  aprobado por omisión, líneas 80-102), `allOf`/`oneOf`/`anyOf`, `const`, `type` (incluida la
  forma `['x','null']` y entero≠decimal), `enum`, `required`, `properties`,
  `additionalProperties: false` y objeto-esquema, `items` con índice, `minItems`/`maxItems`,
  `minimum`/`maximum`, `minLength`/`maxLength`. Probado en los dos sentidos antes de usarlo.
  **Cobertura real verificada**: conté los `example` del JSON — 315 en `paths`, 11 en
  `webhooks`, 8 en parámetros = 334, que es justo lo que recoge `collectExamples`; el único
  `example` restante del documento es una *propiedad* llamada `example` dentro del esquema
  `TemplateVariable`, no un ejemplo OpenAPI, y `text/csv` no lleva ejemplo. **Ningún ejemplo
  queda fuera.** Lo que NO comprueba: `format` y `pattern` (dicho en la cabecera del archivo)
  y `examples` en plural / `components.examples`, que hoy el documento no usa.
- **`GET /api/v1/openapi.json`**: [x] `src/app/api/v1/openapi.json/route.test.ts`.
  Leído: 200 sin credencial, cuerpo == `buildOpenApiDocument()`, `Cache-Control` público y sin
  `no-store`, `ETag` fuerte y entrecomillado, estable, 304 sin cuerpo, `W/` y lista y `*`,
  ETag viejo → 200, y un `it` que caza claves enteras (`wacrm_live_…`, `whsec_…`,
  `service_role`). El archivo **no mockea Supabase**, así que un `requireApiKey` o una consulta
  colada haría fallar la suite: el aislamiento está probado por construcción. El handler
  (`route.ts:65-85`) no importa `requireApiKey`, no toca `supabaseAdmin()` y no lee entorno.
- **Convención de Next 16**: [x] comprobada en `node_modules/next/dist/docs/`, no de memoria.
  `01-app/03-api-reference/05-config/01-next-config-js/headers.md:45` «Header Overriding
  Behavior — if two headers match the same path and set the same header key, the last header
  key will override the first»: la excepción de `next.config.ts` va **después** de la regla
  general `/api/:path*`, que es lo correcto, y el comentario del archivo lo cita bien.
  El handler devuelve `Response` estándar del Web API, que es lo que documentan las route
  handlers de Next 16.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro pasos en verde, ejecutados por el reviewer.
- **CP2 Migraciones**: [x] n/a — sin SQL.
- **CP3 Aislamiento**: [x] la feature no añade ninguna consulta: `grep supabaseAdmin` sobre
  los 18 archivos nuevos no da nada. La única ruta nueva es un documento estático.
- **CP4 Tests**: [x] cada criterio tiene test leído por el reviewer (ver arriba), salvo C2,
  que está cubierto por el guion manual del informe pero **el documento no lo cumple**.
- **CP5 Sin dependencias nuevas**: [x] `git diff a4ce30a..HEAD -- package.json
  package-lock.json mcp-server/package.json` está **vacío**.
- **CP6 i18n**: [x] n/a — sin texto de interfaz nuevo; `messages/*.json` sin tocar.
- **CP7 Next 16**: [x] ver arriba (`headers.md` leído en `node_modules`).
- **CP8 Alcance**: [x] el diff no toca `src/app/(public)/**`, `src/components/developers/**`
  ni `messages/*.json` (a7.7 en paralelo). `docs/public-api.md` solo gana una sección
  «OpenAPI» al final (líneas 986-1023), nada del cuerpo. Reparo menor: `next.config.ts` viene
  reformateado entero de comillas dobles a simples (ver hallazgo 5).
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) con las dos entradas;
  sin variables de entorno nuevas, así que `docs/docker.md` no aplica; el informe existe y
  coincide con el diff salvo el punto del hallazgo 4.
- **CP10 Git**: [x] cuatro commits en `api/openapi`, en español con prefijo y
  `Co-Authored-By: Claude Opus 5 (1M context)`; nada pusheado.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a — no se toca el webhook de WhatsApp.

## Hallazgos (archivo:línea)

1. **BLOQUEANTE — el prefijo `/api/v1` está dos veces: la URL que compone un cliente es
   `/api/v1/api/v1/…`.** `src/lib/api/v1/openapi/document.ts:527` mete el prefijo en la clave
   de `paths` (`const fullPath = \`${API_BASE_PATH}${op.path}\``) y `:553` lo vuelve a poner
   como `servers[0].url`. En OpenAPI 3.1 la URL completa es *server url + path template*, así
   que el documento servido dice, para las 37 operaciones, `/api/v1` + `/api/v1/contacts` =
   **`/api/v1/api/v1/contacts`**. Cualquier colección de Postman o SDK generado del documento
   llama a una ruta que no existe. Esto es justo lo que promete `docs/public-api.md:1011`
   («Point a client at it… import the URL directly») y el `CHANGELOG`.
   La opción documentada tampoco salva: `buildOpenApiDocument({ serverUrl:
   'https://crm.example.com/api/v1' })` (`document.test.ts:45-50`) da
   `https://crm.example.com/api/v1/api/v1/me`.
   El comentario de `document.ts:511-515` deja claro cuál era la intención («URL base del
   servidor. Por defecto `/api/v1`»): entonces las claves de `paths` no deben llevar el
   prefijo. Ni los tests ni el chequeo en Python del informe componen las dos piezas, por eso
   pasó: todos comparan `${API_BASE_PATH}${op.path}` contra sí mismo.

2. **`src/lib/api/v1/openapi/schemas.ts:45` — `API_ERROR_CODES` es una copia a mano de la
   unión `ApiErrorCode`, sin ningún vínculo de tipo**, y `document.test.ts:145` («el esquema
   ApiErrorCode enumera TODOS los códigos de respond.ts») itera sobre esa misma constante:
   el test se comprueba a sí mismo. Hoy el contenido es correcto —lo he cotejado a mano con
   `src/lib/api/v1/respond.ts:65`, 14 de 14— pero un código nuevo en `respond.ts` no rompería
   nada. Un `satisfies readonly ApiErrorCode[]` más un `Record<ApiErrorCode, true>` de
   exhaustividad lo ataría al compilador. No bloqueante.

3. **`src/lib/api/v1/openapi/document.test.ts:267` — «las seis creaciones idempotentes son las
   que envuelve `withIdempotency`» compara contra una lista escrita a mano**, no contra el
   disco, al revés que `coverage.test.ts`. He verificado con grep que las seis son las
   correctas, pero si mañana alguien envuelve una séptima ruta el test seguirá verde y el
   documento mentirá. No bloqueante.

4. **El informe se equivoca al describir el `tsc` de `mcp-server`.**
   `progress/impl_openapi-spec.md:261-266` dice «13 errores, y ya fallaba antes de tocar nada
   … exactamente los mismos 13 errores». Medido por el reviewer extrayendo `mcp-server` de
   `a4ce30a` dentro del worktree (para que resuelva el mismo `node_modules`):
   **base 10 errores, HEAD 13**. Los 3 nuevos son de `mcp-server/src/client.ts` (`URL`,
   `Response`, `fetch` en el `exportConversation` nuevo) y son de la misma causa ambiental
   —`mcp-server/tsconfig.json` sin `@types/node` y sin dependencias instaladas—, ninguno en
   `tools/read.ts` ni `tools/write.ts`, y el `typecheck` de la raíz sí los cubre y está verde.
   O sea: el fondo del informe se sostiene, la cifra no. Corregir la frase.

5. **`next.config.ts` viene reformateado entero** (comillas dobles → simples en ~40 líneas)
   cuando el cambio real son las 20 líneas del bloque `headers()`. Es lo que impone
   `.prettierrc` (`singleQuote: true`), así que no es un error, pero infla el diff de un
   archivo de configuración compartido y encarece cualquier merge. No bloqueante; queda como
   nota, no lo deshagas si ya está.

6. **`mcp-server/`, verificado tool a tool** (no es un hallazgo, es la constancia de la
   comprobación): `tools/index.ts:18` registra `write.ts` solo con `config.enableWrites`;
   `read.ts` usa **exclusivamente** métodos GET del cliente (`me`, `list*`, `get*`,
   `exportConversation`), y todos los métodos que hacen POST/PATCH/DELETE del cliente
   (`mcp-server/src/client.ts:131-288`) se invocan **solo** desde `write.ts`. Ninguna tool
   nueva puede escribir sin `WACRM_ENABLE_WRITES`. `requireConfirm()`
   (`tools/shared.ts:28-46`) está aplicado en `delete_tag` (write.ts:240), `delete_template`
   (:354), `sync_templates` (:388), `create_export` (:436) y `export_conversation`
   (read.ts:330), que es exactamente la regla de dos ramas escrita en `mcp-server/README.md`.
   `export_conversation` queda disponible en un despliegue de solo lectura y gasta el cubo de
   10/hora: cambia nada, sí, pero saca una transcripción entera; está justificado en el README
   y lo dejo anotado, no lo pido.

## Cambios requeridos

1. Quitar la duplicación del prefijo en `src/lib/api/v1/openapi/document.ts`. Lo más limpio es
   dejar las claves de `paths` **sin** prefijo (`document.ts:527` → `op.path`) y que
   `servers[0].url` siga siendo `/api/v1`, que es lo que dice el comentario de `:511-515` y lo
   que espera el `serverUrl` absoluto. Arrastra `coverage.test.ts:67` (que debe comparar la
   ruta del disco **sin** el prefijo) y los `${API_BASE_PATH}${op.path}` de `document.test.ts`.
   La alternativa —dejar `paths` como está y poner `servers[0].url` en el origen— también vale,
   pero rompe el `serverUrl` documentado; elige una y que sea una sola.
2. Añadir un test que componga las dos piezas, que es lo que faltó: para una operación
   conocida, `servers[0].url + <clave de paths>` debe ser exactamente `/api/v1/contacts`
   (y con `serverUrl: 'https://crm.example.com'`, `https://crm.example.com/api/v1/contacts`).
   Sin él, el mismo fallo vuelve a colarse por la misma rendija.
3. Corregir en `progress/impl_openapi-spec.md` la frase de los «mismos 13 errores» del `tsc` de
   `mcp-server`: son 10 antes y 13 después, con los 3 nuevos en `client.ts` por la misma causa
   ambiental (hallazgo 4).

Opcionales, para cuando toque (no condicionan la aprobación): hallazgos 2 y 3.

---

# Segunda ronda — `2fbc159` sobre `23bccb8`

**Veredicto:** APPROVED

Diff revisado: `git diff 23bccb8..2fbc159` — 5 archivos, todos en `src/lib/api/v1/openapi/`
(`document.ts`, `document.test.ts`, `coverage.test.ts`, `schemas.ts`, `validate-examples.ts`),
+271 / −69. Coincide con lo que dice la sección «Segunda ronda» del informe.

## Compuerta

Ejecutada por el reviewer, cada comando por separado y en primer plano, en el worktree:

| Paso | Resultado |
| --- | --- |
| `npm run lint` | **verde** — 0 errores, 35 warnings, las mismas preexistentes |
| `npm run typecheck` | **verde** — salida vacía, exit 0 |
| `TZ=UTC npm test` | **verde** — 191 archivos, **2 522** tests (191/2 518 en la 1.ª ronda: +4) |
| `npm run build` (variables dummy de `docs/harness.md`) | **verde** — `.next/server/app/api/v1/openapi.json/route.js` generado |

- replay-migrations: **n/a** — sin SQL (el diff no toca `supabase/`).

## Lo que pedía el review, uno a uno

### 1 (bloqueante) — el prefijo duplicado: **arreglado**

`document.ts:562-571` usa `op.path` a secas como clave de `paths`; `:588` pasa por
`resolveServerUrl(options.serverUrl)` (`:529-548`). Documento generado por el reviewer
(test temporal borrado después, árbol limpio):

- `servers[0].url` === `/api/v1` ✔
- claves de `paths` que empiezan por `/api/v1`: **0** ✔ (`/broadcasts`, `/contacts`, …)
- 25 `paths`, **37 operaciones**, **11 `webhooks`** ✔
- `servers[0].url + '/contacts'` === `/api/v1/contacts` ✔
- `resolveServerUrl` con `https://crm.example.com`, `https://crm.example.com/api/v1`,
  `https://crm.example.com/` y `https://crm.example.com/api/v1/` → **siempre**
  `https://crm.example.com/api/v1`, y lo mismo por `buildOpenApiDocument({ serverUrl })` ✔
- de paso: 22 `$ref`, **0 rotos**, ninguno externo; `ApiErrorCode.enum` sigue con 17 códigos
  (los 14 de la unión + `whatsapp_not_configured`, `meta_error`, `template_malformed`).

### 2 — el test que componía las dos piezas: **existe y funciona**

- `document.test.ts:119` «la URL de una operación es el servidor + la clave de paths»:
  afirma `document.paths['/contacts']` definido y `` `${servers[0].url}/contacts` `` === `/api/v1/contacts`. Leído.
- `document.test.ts:124` con `serverUrl: 'https://crm.example.com'` → `https://crm.example.com/api/v1/contacts`.
- `document.test.ts:133` ninguna clave empieza por `API_BASE_PATH`.
- `document.test.ts:140` las cuatro formas del origen dan la misma URL + `resolveServerUrl(undefined|'')`.
- `coverage.test.ts:153` es el que cierra la rendija: compone `servers[0].url` con cada clave y
  lo compara contra las URLs del árbol de archivos, con el prefijo sacado de
  `relative('src/app', ROUTES_ROOT)` (`:32-37`), no de `API_BASE_PATH` — deja de medirse con su
  propia vara.
  **Verificado al revés por el reviewer**: volví a meter `${API_BASE_PATH}${op.path}` en las
  claves de `paths` de `document.ts` y `coverage.test.ts` se puso **rojo en 3 `it`**, incluido el
  nuevo; `git checkout` después, árbol limpio.

### 3 — la cifra del `tsc` de `mcp-server`: **corregida**

`progress/impl_openapi-spec.md:274-281`: «**10 errores en la base y 13 en HEAD**», los 3 nuevos
en `client.ts` por causa ambiental. La frase «exactamente los mismos 13» solo sobrevive dentro
de la nota que la cita para corregirla, que es lo correcto.

### Opcionales (hallazgos 2 y 3): hechos, y comprobados

- **`API_ERROR_CODES` atado por tipos** (`schemas.ts:50-65`): `satisfies Record<ApiErrorCode, true>`
  con la lista derivada por `Object.keys`. **Verificado por el reviewer**: añadí
  `| 'codigo_nuevo_reviewer'` a la unión de `respond.ts` y `tsc` falló con
  `TS1360 … Property 'codigo_nuevo_reviewer' is missing … in type 'Record<ApiErrorCode, true>'`
  apuntando a `schemas.ts(65,3)`; restaurado.
- **Idempotencia leída del disco** (`document.test.ts:26-95` + `:378`): recorre los `route.ts`,
  quita comentarios y atribuye cada `withIdempotency(` al handler exportado que la contiene; la
  lista escrita a mano se queda solo como guarda contra el verde vacío.
  **Verificado al revés**: inyecté una llamada en `GET` de `templates/[id]/route.ts` y el `it` se
  puso rojo (`expected [ 'GET /templates/{id}', …(6) ] to deeply equal [ 'POST /broadcasts', …(5) ]`);
  restaurado.

### Documentación de la composición antigua: nada que corregir

`docs/public-api.md` (sección «OpenAPI», al final) y `mcp-server/README.md:17` solo dicen que el
documento existe y cómo obtenerlo; **ninguno describe `servers` ni las claves de `paths`**, así
que no quedó prosa desfasada. `CHANGELOG.md` sin línea nueva: correcto, el fallo nunca se
publicó. `validate-examples.ts:269` corrigió su ejemplo de `location` (`paths./tags.get…`).

## Checkpoints (segunda ronda)

- **CP1 Compuerta**: [x] los cuatro pasos en verde, ejecutados por el reviewer.
- **CP2 Migraciones**: [x] n/a — sin SQL.
- **CP3 Aislamiento**: [x] el diff no añade ninguna consulta; ni `supabaseAdmin` ni Supabase
  aparecen en los 5 archivos tocados.
- **CP4 Tests**: [x] C2 queda cubierto: los 5 `it` de composición leídos y probados en los dos
  sentidos. Los demás criterios siguen con la trazabilidad de la primera ronda (los cambios son
  de `${API_BASE_PATH}${op.path}` a `op.path` en las llamadas a `operation()`, mismo `it`).
- **CP5 Sin dependencias nuevas**: [x] `git diff 23bccb8..HEAD -- package.json package-lock.json
  mcp-server/package.json` **vacío**.
- **CP6 i18n**: [x] n/a — `messages/*.json` sin tocar.
- **CP7 Next 16**: [x] sin API de framework nueva; el handler no cambió.
- **CP8 Alcance**: [x] 5 archivos, todos en `src/lib/api/v1/openapi/`. `src/components/developers`
  no existe en esta rama y `src/app/(public)/**` no se toca (a7.7 en paralelo).
- **CP9 Documentación**: [x] el informe tiene su sección «Segunda ronda» y coincide con el diff;
  `CHANGELOG.md` justificadamente intacto; sin variables de entorno nuevas.
- **CP10 Git**: [x] `2fbc159` en `api/openapi`, mensaje en español con prefijo `fix:` y
  `Co-Authored-By: Claude Opus 5 (1M context)`; `git branch -r --contains 2fbc159` vacío → **nada
  pusheado**.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a.

## Hallazgos (no bloqueantes, para cuando toque)

1. `src/lib/api/v1/openapi/document.ts:545` — `resolveServerUrl` decide con
   `trimmed.endsWith(API_BASE_PATH)`, así que un origen con ruta propia que termine en `/api/v1`
   por otro motivo (un proxy montado en `…/algo/api/v1`) se deja como está. Es el
   comportamiento deseado hoy y está documentado; solo queda anotado.
2. `src/lib/api/v1/openapi/document.test.ts:55` — `stripComments` borra también un `//` dentro de
   una cadena (una URL en el código de una ruta se come el resto de su línea). Hoy no cambia
   ningún resultado —verificado: el `it` da las 6 rutas correctas y falla si se inyecta una
   séptima—, pero es una fuente de falsos negativos si alguien pone un `export async function
   POST(` detrás de una URL en la misma línea.
3. Sigue pendiente lo que no se puede hacer aquí: importar el documento en Postman/Insomnia y
   probar las tools MCP contra una instancia viva. El guion está en el informe y ahora dice
   explícitamente qué mirar primero (`/api/v1/contacts`, no `/api/v1/api/v1/contacts`).

## Cambios requeridos

Ninguno.
