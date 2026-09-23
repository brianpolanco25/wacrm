# a7.6 `openapi-spec` — informe de implementación

Rama `api/openapi`, worktree `.claude/worktrees/api-openapi`, base `feat/api-publica` @ a4ce30a.
Spec: `progress/spec_api-publica.md` §6 + S-A3. Inventario: `progress/impl_integracion-api-3.md` §6.

> **Nota de continuidad.** Esta sesión retomó el trabajo tras un corte de sesión del
> implementer anterior (fallo de herramienta, no del trabajo). Los dos primeros hitos ya
> estaban commiteados y verdes; se continuó desde ahí con el hito 3 (mcp-server) y el 4
> (documentación), y se pasó la compuerta entera de nuevo sobre el conjunto.

## Plan (escrito antes de tocar código)

1. `src/lib/api/v1/openapi/types.ts` — tipos OpenAPI 3.1 mínimos + tipo de entrada del registro.
   Exportados para que a7.7 los consuma.
2. `src/lib/api/v1/openapi/schemas.ts` — esquemas compartidos (sobres, error, recursos).
3. Un archivo por recurso: `me, contacts, tags, conversations, messages, broadcasts, templates,
   exports, webhooks` con sus operaciones (37 en total).
4. `src/lib/api/v1/openapi/webhook-events.ts` — sección `webhooks` de OpenAPI, un esquema por
   evento de `src/lib/webhooks/events.ts` + cabeceras `X-Wacrm-*`.
5. `src/lib/api/v1/openapi/document.ts` — `buildOpenApiDocument()`: securitySchemes, scopes,
   errores, paginación, `Idempotency-Key`/`Idempotent-Replayed`, `X-Request-Id`, cubos y 429.
6. `src/app/api/v1/openapi.json/route.ts` — público, `Cache-Control` largo + `ETag` + 304.
7. `src/lib/api/v1/openapi/coverage.test.ts` — recorre `src/app/api/v1/**/route.ts` en ambos
   sentidos.
8. `src/lib/api/v1/openapi/validate-examples.ts` + test — comprobador estructural propio.
9. `mcp-server/`: cliente + tools de tags, templates y exports con las mismas guardas; README.
10. `CHANGELOG.md` y `docs/public-api.md` (sección «OpenAPI»).

Compuerta paso a paso, commits por hito. Los diez puntos están hechos.

## Commits

| Commit    | Hito                                                                   |
| --------- | ---------------------------------------------------------------------- |
| `dc259ac` | feat: generar el contrato OpenAPI 3.1 de /api/v1 y servirlo público     |
| `4da218e` | test: comprobar el contrato OpenAPI y sus ejemplos sin validador externo |
| `68e7da0` | feat(mcp-server): exponer etiquetas, plantillas y exportaciones          |
| `23bccb8` | docs: anunciar el contrato OpenAPI y las herramientas MCP nuevas         |
| `2fbc159` | fix: quitar el prefijo `/api/v1` duplicado (2.ª ronda — ver el final)   |

Archivos nuevos: 18 en `src/lib/api/v1/openapi/` + `src/app/api/v1/openapi.json/`.
Archivos tocados: `next.config.ts`, `mcp-server/src/{client,tools/{shared,read,write}}.ts`,
`mcp-server/README.md`, `CHANGELOG.md`, `docs/public-api.md`.

> **Errata en el mensaje de `68e7da0`.** Dice «tabla de las 27 herramientas»; son **28**
> (11 que había + 17 nuevas), que es lo que lista la tabla del README y lo que dicen el
> CHANGELOG y este informe. No se reescribió el commit: el árbol es correcto y reescribir
> historia ya commiteada por una cifra del cuerpo del mensaje cuesta más de lo que arregla.

## Criterios del spec §6 ↔ test

### Criterio 1 — «El test de cobertura pasa y protege las fases futuras»

`src/lib/api/v1/openapi/coverage.test.ts` lee **del disco**, no de un registro paralelo:
recorre `src/app/api/v1/**/route.ts`, saca los métodos que cada archivo *exporta* y convierte
`[id]` → `{id}`.

| Qué protege                                      | `it`                                                              |
| ------------------------------------------------ | ----------------------------------------------------------------- |
| El recorrido no está roto (dos listas vacías)     | `encuentra rutas en el disco (el recorrido no está roto)` (== 37)  |
| Ruta en el código sin documentar → CI roja        | `documenta TODA operación que existe en src/app/api/v1`            |
| Operación documentada sin ruta que la sirva       | `no documenta ninguna operación que ya no existe en el código`     |
| La exclusión de `openapi.json` no se amplía       | `no deja fuera la ruta del propio documento por accidente`         |
| Ninguna operación sin scopes ni cubo `publicApi`  | `cada operación documentada declara scopes y cubos de rate limit`  |
| La URL compuesta es la ruta real (2.ª ronda)      | `servers[0].url + la clave de paths reconstruye la URL del disco`   |

### Criterio 2 — «un cliente OpenAPI estándar lo importa»

Verificado en vivo contra el build de producción (ver «Verificaciones contra servidor real»).
Sin validador externo (S-A3): el comprobador es propio y está probado en los dos sentidos.

> **La primera ronda lo daba por bueno y no lo era** (hallazgo 1 del review): el prefijo
> `/api/v1` estaba en las claves de `paths` **y** en `servers[0].url`, así que la URL que
> compone un cliente era `/api/v1/api/v1/contacts`. Arreglado en `2fbc159`; ver «Segunda
> ronda» al final de este informe.

### Contenido del documento (lo que §6 exige que cubra)

Todos en `src/lib/api/v1/openapi/document.test.ts` salvo donde se indique.

| Exigencia de §6                          | `it`                                                                       |
| ---------------------------------------- | -------------------------------------------------------------------------- |
| OpenAPI 3.1                              | `declara 3.1.0 y un servidor`                                              |
| Seguridad `bearer`                       | `define UN esquema de seguridad, http/bearer, y lo exige por defecto`      |
| Scopes por operación                     | `cada operación lleva en x-scopes lo que exige su ruta`                     |
| …y su vocabulario                        | `publica el vocabulario de scopes con su descripción`, `todo scope declarado es uno de los 12 que existen` |
| La única operación sin scope             | `GET /me es la única operación sin scope`                                   |
| `GET /broadcasts/{id}` pide `broadcasts:send` | `el scope de /broadcasts es broadcasts:send también en el GET`         |
| Sobres (`data`, `data+meta`, crudo)      | `una lectura simple envuelve en { data }`, `una lista envuelve en { data, meta.next_cursor }` |
| **Excepción del export** (cuerpo = archivo) | `el export directo NO envuelve: el cuerpo es el archivo` + `pero sus ERRORES sí van en el sobre, como el resto` |
| Todos los `ApiErrorCode`                 | `el esquema ApiErrorCode enumera TODOS los códigos de respond.ts`           |
| Sobre de error con `request_id`          | `el sobre de error exige code, message y request_id`                        |
| Errores universales                      | `toda operación documenta 401, 402, 429 y 500`, `toda escritura documenta 400, 403 read-only, 413 y 415`, `una escritura SIN cuerpo no promete 415` |
| Cabeceras 429                            | `el 429 trae Retry-After y las tres X-RateLimit-*`                          |
| 402 con sobre de facturación             | `el 402 usa el sobre de facturación, con upgradeUrl`                        |
| `X-Request-Id` (y `Cache-Control`)       | `toda respuesta declara X-Request-Id y Cache-Control`                       |
| Paginación                               | `cada lista declara limit y cursor`, `el limit se documenta con el tope real de pagination.ts` |
| `Idempotency-Key` / `Idempotent-Replayed` | `las creaciones idempotentes son EXACTAMENTE las que envuelve withIdempotency`, `cada una acepta Idempotency-Key y puede responder Idempotent-Replayed`, `PATCH /templates/{id} NO se anuncia como idempotente` |
| Cubos de rate limit                      | `todas llevan publicApi por clave, con el límite real`, `las tres operaciones caras suman su cubo POR CUENTA`, `el cubo de exportaciones se documenta con su ventana de una hora` |
| Sección `webhooks`, un esquema por evento | `hay una entrada por evento de WEBHOOK_EVENTS, y ninguna de más`, `cada entrada es un POST con el sobre de entrega`, `cada entrada declara las cinco cabeceras X-Wacrm-*`, `la entrega no se autentica con la clave de API, sino con la firma`, `el `data` de cada evento cuadra con lo que emite el dominio` |
| Ningún secreto de más                    | `el secreto de firma solo aparece al crear y al rotar`, `listar y leer receptores usa el esquema SIN secreto` |

### Comprobador estructural de ejemplos (S-A3: sin validador externo)

`src/lib/api/v1/openapi/validate-examples.ts` + `validate-examples.test.ts`. El comprobador se
prueba **antes** de usarlo, en los dos sentidos: acepta lo correcto y caza `required` ausente,
tipo cambiado, `null` donde no se admite, enum roto, propiedad de más con
`additionalProperties: false`, decimal donde se pidió `integer`, índices de array, `minItems`/
`maxItems`, `const`, `$ref` resuelto y `$ref` colgado (que es error, no aprobado por omisión),
y `oneOf`. Después:

- `hay ejemplos que comprobar (el recorrido no está roto)` — la guarda contra el verde vacío.
- `cada `example` respeta su `schema`` — todos los ejemplos del documento real.
- `todos los $ref del documento apuntan a un esquema que existe`.

### `GET /api/v1/openapi.json`

`src/app/api/v1/openapi.json/route.test.ts`: `responde 200 SIN credencial alguna`,
`devuelve el documento que genera buildOpenApiDocument`, `sirve JSON`,
`se cachea largo: no es `no-store` como el resto de /api/v1`, `lleva un ETag fuerte y
entrecomillado`, `el ETag es estable entre llamadas`, `con el ETag correcto responde 304 y sin
cuerpo`, `acepta el ETag debilitado por un intermediario`, `acepta una lista de ETags y el
comodín`, `con un ETag viejo devuelve el documento entero`, `no filtra ninguna credencial`.

El archivo **no mockea Supabase a propósito**: que los tests pasen sin mock es la prueba de que
la ruta no toca datos de nadie.

## Verificaciones contra servidor real

No hay SQL en esta feature, así que no hubo `replay-migrations.sh` ni
`progress/checks_openapi-spec.sql`. Lo que sí se comprobó en vivo, contra el build de
producción (`npx next start -p 3987` con las variables dummy de `docs/harness.md`), porque la
cabecera de caché la decide `next.config.ts` y eso los tests unitarios no lo ven:

```
GET /api/v1/openapi.json            → 200
Cache-Control: public, max-age=3600, stale-while-revalidate=604800   (NO no-store)
Content-Type: application/json; charset=utf-8
etag: "CU273MIM7Vwh1gKAuHHtvxqbExp1YLslqFns2oatf_c"   (fuerte, sin W/)
GET con If-None-Match: <ese etag>   → 304 Not Modified, sin cuerpo
Cuerpo: 682 326 bytes, sin cabecera Authorization en la petición
```

Esto confirma lo que dice el commit `dc259ac`: la regla general `/api/:path*` de
`next.config.ts` pone `no-store` y en Next **gana la última regla que casa**, así que la
excepción para esta ruta tenía que ir después. Si alguien reordena ese array, el documento
deja de cachearse y esta comprobación lo enseña (los tests unitarios no, porque el header de
`next.config.ts` no pasa por el handler).

Sobre el criterio «un cliente OpenAPI estándar lo importa», y sin validador externo (S-A3), se
corrió además un chequeo estructural independiente sobre el documento servido — escrito en
Python, fuera del repo, precisamente para no depender del mismo código que genera el documento:

- todos los `$ref` resuelven dentro del propio documento y ninguno es externo;
- `openapi`, `info.title`, `info.version` y `paths` presentes;
- 37 operaciones, `operationId` único en todas;
- toda respuesta tiene `description` y un código `[1-5]XX` o `default`;
- todo parámetro de ruta del template `{...}` está declarado y es `required: true`;
- cada entrada de `webhooks` es un path item con al menos una operación;
- el `security` de raíz referencia un esquema definido.

**0 errores.** Cifras del documento: OpenAPI 3.1.0, 25 `paths`, 37 operaciones, 11 eventos en
`webhooks`, 23 esquemas en `components`, 10 `tags`.

## Verificaciones manuales pendientes (dependen de servicios externos)

1. **Importar en una herramienta OpenAPI real.** Ni Postman ni Insomnia ni
   `openapi-generator` están —ni pueden estar— en este entorno.

   *Guion:* levantar la instancia, `curl -o openapi.json https://<host>/api/v1/openapi.json`,
   e importarlo en Postman (`Import → File`) o en Insomnia. Debe aparecer una colección con las
   37 operaciones agrupadas en los 10 tags. Comprobar en concreto: (a) que
   `GET /conversations/{id}/export` muestra dos tipos de medio de respuesta
   (`application/json` y `text/csv`) y no un sobre; (b) que las operaciones idempotentes
   ofrecen `Idempotency-Key` como cabecera opcional; (c) que la sección de webhooks se ve —
   Postman todavía ignora `webhooks` de 3.1, así que ahí la ausencia es de la herramienta, no
   del documento, y basta con verificar que no rompe la importación.

2. **Las herramientas MCP contra una instancia viva.** `mcp-server/` no tiene runner de tests
   (ver deuda), y las tools nuevas tocan Meta en `sync_templates`, `create_template`,
   `update_template` y `delete_template`.

   *Guion:* con `WACRM_BASE_URL`, `WACRM_API_KEY` (scopes `tags:*`, `templates:*`,
   `conversations:export`) y `WACRM_ENABLE_WRITES=true`, desde un cliente MCP:
   - `list_tags` → ids; `create_tag {name:"mcp-prueba"}` → 201; repetir → misma etiqueta, 200.
   - `add_contact_tags` con un id inventado junto a uno válido → `not_found` y el contacto
     **sin ninguna** etiqueta nueva (todo o nada).
   - `delete_tag` **sin** `confirm` → se niega con el texto de `requireConfirm`; con
     `confirm:true` → borra y la etiqueta desaparece de los contactos que la llevaban.
   - `sync_templates` sin `confirm` → se niega; con `confirm:true` → resumen de Meta.
   - `export_conversation` sin `confirm` → se niega; con `confirm:true` → el archivo llega como
     texto (no como JSON escapado) con su `Content-Disposition`.
   - `create_export {confirm:true}` → 202; `get_export` hasta `done` → `download_url` que
     caduca a los 15 minutos.
   - Sin `WACRM_ENABLE_WRITES`: ninguna de las diez tools de escritura aparece en la lista de
     herramientas, y las siete de lectura sí.

## Decisiones donde el spec era ambiguo

1. **Los scopes van en `x-scopes`, no en `security` por operación.** El esquema es
   `http`/`bearer` y en OpenAPI 3.1 un requisito de seguridad de tipo `http` debe llevar la
   lista de scopes **vacía** (los scopes con nombre solo son legales en `oauth2` y
   `openIdConnect`). Ponerlos en `security` habría producido un documento inválido que muchas
   herramientas aceptan igual, que es la peor de las dos opciones. `x-scopes` es explícito,
   legal, y es de donde a7.7 los lee para la tabla de la referencia.

2. **`GET /api/v1/openapi.json` no se documenta a sí mismo.** Es la ruta que *sirve* el
   contrato, no una operación del contrato; documentarla obligaría además a modelar una
   respuesta que no es el sobre. La exclusión está acotada a un nombre y hay un test que falla
   si alguien la amplía.

3. **El `Cache-Control` de la ruta y el de `next.config.ts` son el mismo string en dos sitios.**
   El header de Next es el que ve el cliente; el de la ruta hace que el valor siga siendo
   correcto si alguien sirve la app sin la configuración de Next (por ejemplo, tras un proxy
   que no aplique `headers()`). Duplicarlo es feo pero honesto: quitar cualquiera de los dos
   deja un caso real sin cubrir.

4. **Qué tools MCP piden `confirm: true`.** El spec dice «las mismas guardas de escritura que
   hoy», y hoy la única guarda por llamada era la de difusiones. Se generalizó a
   `requireConfirm()` con una regla de dos ramas, escrita en el README para que la siguiente
   tool sepa dónde cae:
   - **no se puede deshacer y alcanza más de lo que nombras**: `delete_tag` (la quita de todos
     los contactos), `delete_template` (borra en Meta, y cualquier envío que la nombre empieza
     a fallar), `send_broadcast` (ya la tenía);
   - **gasta un presupuesto de la cuenta**: `export_conversation` y `create_export` (el mismo
     cubo de 10/hora), `sync_templates` (6/min, y deja que Meta pise los datos locales).

   `create_tag`, `update_tag`, `add_contact_tags`, `remove_contact_tag`, `create_template` y
   `update_template` **no** lo piden: son reversibles y de alcance acotado, y pedir confirmación
   para todo entrena al modelo a confirmarlo todo.

5. **`export_conversation` vive en el grupo de lectura pese a pedir `confirm`.** No cambia nada,
   así que un despliegue de solo lectura debe poder usarla; la confirmación no es por mutación
   sino por coste (el cubo compartido de 10/hora). Está dicho en el README para que no parezca
   una inconsistencia.

6. **`export_conversation` devuelve el archivo como texto plano, no dentro de un JSON.** Un CSV
   pasado por `JSON.stringify` es ilegible para el modelo y para el usuario que ve la
   herramienta. Se antepone una línea con el nombre de archivo y el tipo de medio.

7. **La sección «OpenAPI» de `docs/public-api.md` va al final del documento.** La rama paralela
   `api/docs` (a7.7) convierte ese archivo en un puntero a `/developers`; tocar el cuerpo habría
   hecho el merge más caro sin ganar nada. Es lo único que se añadió ahí.

## Variables de entorno nuevas

**Ninguna.** Ni la ruta ni el registro leen nada del entorno, y el servidor MCP sigue con las
cuatro que ya tenía (`WACRM_BASE_URL`, `WACRM_API_KEY`, `WACRM_ENABLE_WRITES`,
`WACRM_ENABLE_BROADCASTS`). Por eso no se tocó `docs/docker.md`.

`mcp-server/.env.example` está **bloqueado por permisos** en este entorno (como
`.env.local.example`). No hacía falta cambiarlo —no hay variables nuevas—, pero queda anotado.

## Compuerta

Los cuatro pasos, cada uno por separado y en primer plano, sobre el árbol final:

| Paso        | Resultado                                                             |
| ----------- | --------------------------------------------------------------------- |
| `npm run lint`      | 0 errores, 35 warnings — **todas preexistentes**, ninguna en `mcp-server/` ni en `src/lib/api/v1/openapi/` |
| `npm run typecheck` | limpio                                                        |
| `TZ=UTC npm test`   | **191 archivos, 2 518 tests, todos verdes** (70 de ellos de esta feature) |
| `npm run build`     | limpio; `ƒ /api/v1/openapi.json` en la tabla de rutas         |

Sin SQL ⇒ sin `scripts/replay-migrations.sh`.

**Compuerta de `mcp-server/`.** Su `package.json` no declara `test`: su compuerta es
`typecheck` + `build` (`tsc`). Aquí hay un matiz que el reviewer debe conocer:
`npx tsc -p mcp-server/tsconfig.json --noEmit` **falla en este entorno, y ya fallaba antes de
tocar nada**: todos los errores son de globals ambientales (`fetch`, `URL`, `Response`,
`process`, `console`), porque `mcp-server/node_modules` no está instalado y su `tsconfig` no
hereda los `@types/node` de la raíz. No se instaló nada (regla del repo).

> **Corrección (segunda ronda, hallazgo 4 del review).** La primera versión de este informe
> decía «exactamente los mismos 13 errores». La cifra estaba mal: el reviewer lo midió
> extrayendo `mcp-server` de `a4ce30a` dentro del worktree, para que resolviera el mismo
> `node_modules`, y salen **10 errores en la base y 13 en HEAD**. Los **3 nuevos** están en
> `mcp-server/src/client.ts` (`URL`, `Response`, `fetch` del `exportConversation` nuevo) y son
> de la **misma causa ambiental**, no de un tipo mal puesto: ninguno cae en `tools/read.ts` ni
> en `tools/write.ts`, y el `typecheck` de la raíz —que sí cubre esos archivos— está verde. El
> fondo del párrafo se sostiene; la cifra era falsa y queda corregida.

La cobertura real de tipos del código nuevo viene del
`npm run typecheck` de la raíz, que —verificado con `tsc --listFiles`— compila los ocho
archivos de `mcp-server/src/` y está verde.

## Deuda detectada (fuera de alcance, no tocada)

1. **`mcp-server/` no tiene runner de tests.** Ni script `test`, ni vitest, ni nada: su única
   red es `tsc`. Con este cambio pasa de 11 a 28 herramientas y gana una guarda de seguridad
   (`requireConfirm`) que no tiene ni un test. Meterlo en el `vitest.config.ts` de la raíz
   significaría ampliar el `include` —hoy `src/**`— y hacer que CI corra código de un paquete
   publicable con resolución `NodeNext`; es una decisión de infraestructura, no un arreglo al
   paso, y §6 no la pide.

2. **`mcp-server` no se puede typecheckear solo sin `npm install` dentro.** Ver arriba. Lo
   arreglaría un `"types": ["node"]` en su `tsconfig.json` más tener sus dependencias
   instaladas, pero tocar el `tsconfig` de un paquete que se publica a npm no es algo que se
   haga de pasada en una feature de documentación.

3. **`VERSION` en `mcp-server/src/index.ts` está a `'0.1.0'` y su `package.json` a `0.1.1`.**
   Preexistente; el comentario dice «kept in sync manually» y no lo está. Con 17 tools nuevas
   el paquete pide un bump, pero versionar y publicar no entra aquí (CLAUDE.md: preguntar antes
   de publicar).

4. **`docs/public-api.md` (985 líneas + la sección nueva) y el documento OpenAPI dicen lo mismo
   dos veces.** Es justo el problema que §6 viene a resolver, y a7.7 lo cierra convirtiendo el
   archivo en un puntero a `/developers`. Hasta que esa rama se integre, siguen conviviendo.

5. **`EXPORT_STALE_MS`** — deuda heredada de a7.5, ya anotada en `a4ce30a`. Sigue abierta.

---

# Segunda ronda — respuesta a `progress/review_openapi-spec.md`

Veredicto atendido: **CHANGES_REQUESTED**. Commit nuevo sobre `api/openapi`, encima de
`23bccb8`; los cuatro anteriores quedan intactos.

| Commit    | Qué                                                                |
| --------- | ------------------------------------------------------------------ |
| `2fbc159` | fix: quitar el prefijo `/api/v1` duplicado del documento OpenAPI    |

Archivos tocados (5, todos en `src/lib/api/v1/openapi/`): `document.ts`, `document.test.ts`,
`coverage.test.ts`, `schemas.ts`, `validate-examples.ts` (una línea de comentario).
**No** se tocó `src/app/(public)/**` ni `src/components/developers/**` (a7.7 en paralelo).

## La regla de composición, final — para a7.7

Esto es lo que la integración final necesita para ajustar
`src/components/developers/openapi/fixture.ts` y el renderizador si hiciera falta:

> **`servers[0].url` lleva el prefijo; las claves de `paths`, no.**
> URL de una operación = `servers[0].url` + clave de `paths`.
>
> - Claves de `paths`: la ruta **sin** prefijo, tal como la declara cada `OperationDef` —
>   `/contacts`, `/me`, `/contacts/{id}/tags`, `/conversations/{id}/export`.
> - `servers[0].url`: termina **siempre en exactamente un** `/api/v1`. Sin opciones es
>   `/api/v1` (relativo, que es lo que se sirve en `GET /api/v1/openapi.json`); con
>   `buildOpenApiDocument({ serverUrl: 'https://crm.example.com' })` es
>   `https://crm.example.com/api/v1`.
> - `serverUrl` se pasa como **origen**, sin ruta. Si alguien le mete ya el prefijo
>   (`https://crm.example.com/api/v1`) o una barra final, `resolveServerUrl` lo normaliza en
>   vez de duplicarlo: el resultado es el mismo. Una sola regla, una sola función
>   (`resolveServerUrl` en `document.ts`), documentada en su docblock.
>
> Traducido a lo que a7.7 pinta: para mostrar `GET /api/v1/contacts` hay que **concatenar** el
> servidor con la clave; la clave sola dice `/contacts`. Si el fixture de a7.7 se copió del
> documento de la primera ronda, sus claves llevan el prefijo y hay que quitárselo.

El documento generado, volcado y comprobado tras el cambio: `servers[0].url = /api/v1`,
25 `paths`, 37 operaciones, 11 `webhooks`, **0 claves de `paths` que empiecen por `/api/v1`**,
y `servers[0].url + '/contacts'` = `/api/v1/contacts`.

## Cambios requeridos, uno a uno

### 1 (bloqueante) — el prefijo estaba dos veces

`document.ts` ya no compone `${API_BASE_PATH}${op.path}` para la clave de `paths`: usa
`op.path` a secas (antes L527, ahora L563/L570), y `servers[0].url` pasa por
`resolveServerUrl(options.serverUrl)` (L553 → la función nueva, L529-548). El comentario de
`BuildOpenApiOptions` (el de L511-515 del review) se reescribió: dice que `serverUrl` es el
**origen** y que el prefijo lo pone el documento. `API_BASE_PATH` conserva su constante y gana
un docblock que explica dónde va y dónde no.

Arrastres hechos:

- `coverage.test.ts` — `routePathFromFile` devuelve la ruta **sin** prefijo (L83).
- `document.test.ts` — los 20 y pico `${API_BASE_PATH}${op.path}` / `${API_BASE_PATH}/x` de las
  llamadas a `operation()` pasan a `op.path` / `'/x'`.
- `validate-examples.ts` — el ejemplo del docblock de `location` decía
  `paths./api/v1/tags.get…`; ahora `paths./tags.get…`.

Se eligió la opción que el review llama «lo más limpio» (claves sin prefijo), no la alternativa,
para no romper el `serverUrl` documentado.

### 2 — el test que faltaba: componer las dos piezas

| Dónde | `it` | Qué compone |
| --- | --- | --- |
| `document.test.ts` | `la URL de una operación es el servidor + la clave de paths` | `servers[0].url + '/contacts'` === `/api/v1/contacts` |
| `document.test.ts` | `con un origen absoluto compone la URL de esa instancia` | con `serverUrl: 'https://crm.example.com'` → `https://crm.example.com/api/v1/contacts` |
| `document.test.ts` | `ninguna clave de paths repite el prefijo /api/v1` | ninguna clave empieza por `/api/v1` |
| `document.test.ts` | `el prefijo no se duplica si el origen ya lo trae (ni con barra final)` | las 4 formas del origen dan la misma URL; `resolveServerUrl(undefined \| '')` = `/api/v1` |
| `coverage.test.ts` | `servers[0].url + la clave de paths reconstruye la URL del disco` | las 25 claves compuestas == las URLs que salen del árbol `src/app/api/v1/**` |

El de `coverage.test.ts` es el que cierra la rendija de verdad, porque el prefijo con el que
compara lo saca de **dónde viven las rutas en el disco** (`relative('src/app', ROUTES_ROOT)`),
no de `API_BASE_PATH`: así la comprobación no se mide con su propia vara, que era el vicio que
dejó pasar el fallo.

**Comprobado en los dos sentidos.** Se volvió a meter el prefijo en las claves de `paths` y se
corrió `coverage.test.ts`: **3 tests en rojo**, incluido el nuevo. Con el árbol restaurado,
verde.

### 3 — la cifra del `tsc` de `mcp-server`

Corregida en la sección «Compuerta» de este mismo informe, con una nota explícita: **10 errores
en la base y 13 en HEAD**, los 3 nuevos en `mcp-server/src/client.ts` por la misma causa
ambiental. La frase «exactamente los mismos 13 errores» ya no está.

## Opcionales (hallazgos 2 y 3), hechos también

### `API_ERROR_CODES` atado al compilador

`schemas.ts` importa `type { ApiErrorCode }` de `@/lib/api/v1/respond` y la lista se **deriva**
de un objeto con `satisfies Record<ApiErrorCode, true>`. Falla `tsc` por los dos lados —
verificado quitando y añadiendo una clave:

- sin `internal`: `TS1360 … Property 'internal' is missing in type … but required in type
  'Record<ApiErrorCode, true>'`;
- con un `codigo_inventado`: `TS2353 Object literal may only specify known properties`.

El `it` de `document.test.ts` que enumera los códigos sigue, pero ahora comprueba lo que le
toca —que el esquema publicado los lleva—, y lo dice en un comentario: la exhaustividad la
garantiza el tipo, no el test.

### Las creaciones idempotentes, leídas del disco

`document.test.ts` recorre `src/app/api/v1/**/route.ts`, **quita los comentarios** (varias rutas
nombran `withIdempotency` en prosa, incluida `templates/[id]`, que explica por qué NO lo usa),
busca las llamadas `withIdempotency(` y las atribuye al handler exportado que las contiene. El
`it` compara esa lista con la del documento. La lista escrita a mano se queda solo como guarda
contra el verde vacío, igual que el `toBe(37)` de `coverage.test.ts`.

**Comprobado en los dos sentidos**: se inyectó una llamada falsa a `withIdempotency(` en
`templates/[id]/route.ts` y el `it` se puso rojo (`expected [ 'GET /templates/{id}', …(6) ] to
deeply equal [ 'POST /broadcasts', …(5) ]`); archivo restaurado después.

### Hallazgo 5 (`next.config.ts` reformateado)

No se deshace, como pide el review.

## Compuerta (segunda ronda)

Los cuatro pasos, cada uno por separado y en primer plano, en el worktree:

| Paso | Resultado |
| --- | --- |
| `npm run lint` | 0 errores, **35 warnings — las mismas preexistentes**, ninguna en `src/lib/api/v1/openapi/` |
| `npm run typecheck` | limpio, sin salida |
| `TZ=UTC npm test` | **191 archivos, 2 522 tests, todos verdes** (2 518 + 4: cuatro `it` nuevos, uno borrado) |
| `npm run build` (variables dummy de `docs/harness.md`) | `✓ Compiled successfully`, `ƒ /api/v1/openapi.json` en la tabla |

Sin SQL ⇒ sin `scripts/replay-migrations.sh` (igual que en la primera ronda).

## Verificación del documento generado

Sin levantar servidor esta vez: se volcó `buildOpenApiDocument()` a un archivo con un test
temporal (borrado) y se inspeccionó con Python fuera del repo. `route.test.ts` ya prueba que el
cuerpo que sirve `GET /api/v1/openapi.json` **es** ese objeto, así que la cadena está cerrada.
Resultado: `servers[0].url = /api/v1`, 25 `paths` / 37 operaciones / 11 `webhooks`, todas las
claves empiezan por `/`, ninguna por `/api/v1`, y las tres comprobadas a mano componen
`/api/v1/contacts`, `/api/v1/me` y `/api/v1/conversations/{id}/export`.

Las verificaciones manuales de la primera ronda (importar en Postman/Insomnia, y las tools MCP
contra una instancia viva) **siguen pendientes**, con el mismo guion — y ahora además son la
única forma de cerrar del todo el criterio C2 en una herramienta real. Nota para quien lo haga:
lo que hay que mirar primero es que la colección importada llame a `/api/v1/contacts` y no a
`/api/v1/api/v1/contacts`.

## Documentación

- `CHANGELOG.md`: **sin línea nueva**. La entrada de Unreleased que anuncia
  `GET /api/v1/openapi.json` sigue siendo exacta —esto arregla código que nunca se publicó—, y
  añadir un «fix» de algo que no llegó a salir ensucia el changelog del usuario.
- `docs/public-api.md`: sin cambios; su sección «OpenAPI» no describe `servers`.
- Sin variables de entorno nuevas ⇒ `docs/docker.md` intacto. `.env.local.example` y
  `mcp-server/.env.example` siguen **bloqueados por permisos**; no hacía falta tocarlos.

## Deuda nueva detectada (fuera de alcance, no tocada)

6. **`API_BASE_PATH` se exporta y nadie fuera de `src/lib/api/v1/openapi/` lo usa.** Las rutas
   reales viven donde las pone el App Router, así que la constante y el árbol de archivos
   podrían divergir sin que nada falle… salvo el `it` nuevo de `coverage.test.ts`, que es quien
   los ata. Queda anotado por si alguien se plantea derivarla del disco directamente.
