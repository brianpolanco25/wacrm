# Integración FINAL de la fase 7 — `feat/api-publica`

**Feature:** integración a7.6 (`api/openapi`) + a7.7 (`api/docs`) sobre `feat/api-publica`.
**Rama:** `feat/api-publica` · **Worktree:** `.claude/worktrees/api-publica`
**Estado:** terminado, pendiente de revisión. No se marca `done` aquí.

> Esta sesión **retoma** el trabajo de un implementer anterior que se colgó (watchdog de 600 s)
> justo después de dar la compuerta por verde y anunciar el commit. El trabajo principal estaba
> commiteado (`2341143`, `a3aa1c7`); quedaban sin commitear los dos archivos del paso 3 del
> encargo (`docs/mcp.md`, `mcp-server/README.md`) y faltaba el informe. Todo lo anterior se
> verificó contra el árbol antes de tocar nada; nada se rehízo.

---

## Plan de esta sesión (ejecutado)

1. Verificar punto por punto el encargo original contra el árbol (merges, puente `source.ts`,
   URLs/anclas, fixture, enlaces, cierre documental).
2. `git diff` de los dos archivos pendientes → prettier → commit `docs:`.
3. Compuerta completa, comando a comando, en primer plano.
4. `scripts/replay-migrations.sh` (001–064) y re-ejecución de los cinco `checks_*.sql` de la fase
   contra el Postgres del harness.
5. Este informe.

---

## Commits de la integración (desde `a4ce30a`)

`a4ce30a` es la punta de `api/recursos` = estado de `feat/api-publica` al cerrar la 3.ª
integración. Todo lo que sigue es la 4.ª y última.

| Commit        | Qué es                                                                                       |
| ------------- | -------------------------------------------------------------------------------------------- |
| `dc259ac`     | feat: generar el contrato OpenAPI 3.1 de `/api/v1` y servirlo público _(a7.6)_               |
| `4da218e`     | test: comprobar el contrato OpenAPI y sus ejemplos sin validador externo _(a7.6)_            |
| `68e7da0`     | feat(mcp-server): exponer etiquetas, plantillas y exportaciones _(a7.6)_                     |
| `23bccb8`     | docs: anunciar el contrato OpenAPI y las herramientas MCP nuevas _(a7.6)_                    |
| `2fbc159`     | fix: quitar el prefijo `/api/v1` duplicado del documento OpenAPI _(a7.6, 2.ª ronda)_         |
| `099aa79`     | feat: sección pública `/developers` con prosa en español e inglés _(a7.7)_                   |
| `6cb504a`     | feat: referencia de `/developers` generada desde el OpenAPI _(a7.7)_                         |
| `10bcc14`     | docs: enlazar `/developers` desde el panel y dejar `public-api.md` como puntero _(a7.7)_     |
| `5e996e7`     | style: deshacer el reformateo colateral de `middleware.test.ts` _(a7.7)_                     |
| `e653dd5`     | fix: declarar el idioma de la prosa en `/developers` _(a7.7, 2.ª ronda)_                     |
| `53dcb4e`     | docs: documentar el techo de 250 000 mensajes del encargo de exportación _(a7.7, 2.ª ronda)_ |
| `547aae2`     | fix: apuntar el enlace de webhooks del panel a la guía que promete _(a7.7, 2.ª ronda)_       |
| `489c261`     | feat: completar los once eventos de webhook en la referencia _(a7.7, 2.ª ronda)_             |
| `073ac07`     | fix: dar contraste AA a las etiquetas de `/developers` en modo oscuro _(a7.7, 2.ª ronda)_    |
| **`2341143`** | **Merge branch `api/docs` into `feat/api-publica`**                                          |
| **`a3aa1c7`** | **feat: la referencia de `/developers` pinta el contrato real** (el puente)                  |
| **`0be9815`** | **docs: apuntar la documentación del MCP a `/developers`** (esta sesión)                     |

Punta final: **`0be9815`**.

---

## Los dos merges y cómo se resolvieron los conflictos

### 1. `api/openapi` → `feat/api-publica`: **avance rápido, sin conflictos**

`api/openapi` (punta `2fbc159`) nació de `a4ce30a` y nadie tocó `feat/api-publica` entre medias,
así que el merge fue un _fast-forward_: no hay commit de merge y los cinco commits de a7.6 quedan
lineales en el historial. Se confirma con `git log --merges a4ce30a..HEAD`, que solo devuelve
`2341143`.

### 2. `api/docs` → `feat/api-publica`: **dos conflictos**, ambos en documentación

Base común: `a4ce30a`. Commit de merge `2341143` (54 archivos, +8 265 / −1 028).

| Archivo              | El choque                                                                                                                                                                                                                | Resolución                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CHANGELOG.md`       | Las dos ramas añadieron viñetas en el mismo punto de `[Unreleased]` › «Added»: a7.6 metió el contrato OpenAPI y las tools MCP (`CHANGELOG.md:519`, `:532`); a7.7 metió `/developers` y la referencia generada.           | **Los dos lados, en orden de dependencia**: primero el contrato (a7.6), después la documentación que lo consume (a7.7), líneas 519–561. Nada se descartó.                                                                                                                                                                                                                                                                                 |
| `docs/public-api.md` | Conflicto de **contenido contra borrado**: a7.6 añadió una sección `## OpenAPI` de 38 líneas al final del documento de 1 023 líneas; a7.7 **sustituyó el documento entero** por un puntero de 41 líneas a `/developers`. | Gana el puntero de a7.7 (`git diff 073ac07 2341143 -- docs/public-api.md` es vacío: el archivo quedó byte a byte como lo dejó a7.7). No se perdió nada: la sustancia de la sección de a7.6 vive ahora en dos sitios mejores — la tabla del puntero, que nombra `/api/v1/openapi.json` como una de las dos direcciones, y la página `/developers/integrations`, que cuenta Postman/Insomnia/SDK con más detalle del que tenía el markdown. |

**El conflicto de verdad no estaba en ningún archivo**: las dos ramas fijaron **formas
incompatibles del documento OpenAPI**, y git no lo ve porque no hay solapamiento textual. Es lo
que cierra `a3aa1c7` (abajo).

---

## Regla final de URLs y anclas

Las dos ramas discrepaban:

- **a7.6** (el generador, `src/lib/api/v1/openapi/document.ts`): `servers[0].url` lleva el prefijo
  y las **claves de `paths` NO** (`/me`, `/contacts/{id}`…). Es lo que exige el estándar y lo que
  se publica en `GET /api/v1/openapi.json`.
- **a7.7** (el fixture del renderizador): `servers[0].url` = origen a secas y claves **con**
  prefijo (`/api/v1/me`). El renderizador concatenaba en crudo (`model.ts` ~L333) y derivaba el
  ancla de la clave (`operationAnchor`).

Sin arbitrar, el `curl` de la referencia habría salido `curl "/api/v1/me"` —relativo, incopiable—
y las anclas habrían pasado de `#get-api-v1-me` a `#get-me`.

**Regla adoptada** (la de a7.6, que es la que se publica):

```
URL mostrada = servers[0].url  +  clave de paths
               (origen + /api/v1)   (sin prefijo)
```

Tres piezas la sostienen:

1. **`serverBasePath(servers[0].url)`** (`src/components/developers/openapi/model.ts:327`) extrae
   la ruta del servidor y se la **devuelve a la ruta** solo para pintar y para el ancla. La página
   sigue diciendo `GET /api/v1/me` y el ancla sigue siendo `#get-api-v1-me`: **las anclas no
   cambian**, así que ningún enlace existente se rompe (además, `grep 'reference#'` sobre
   `src/content/developers/**` no devuelve nada: la prosa nunca enlazó a una operación concreta).
2. **El `curl` se compone con el servidor** (que ya trae el prefijo) **más la clave cruda**, nunca
   con la ruta ya reconstruida. Resultado: absoluto y con **un solo** `/api/v1`.
3. **El origen** sale de `NEXT_PUBLIC_SITE_URL` (la variable canónica de la instancia, la misma de
   las invitaciones y el checkout) y, si no está, de `EXAMPLE_ORIGIN =
'https://tu-dominio.example.com'`. Nunca de una URL relativa: un `curl` relativo no se puede
   copiar y pegar. El puente no escribe `/api/v1` en ningún sitio — lo pone `resolveServerUrl` del
   generador.

**El puente es un único archivo**, `src/components/developers/openapi/source.ts`: exporta
`getOpenApiDocument()`, que llama a `buildOpenApiDocument({ serverUrl: docsServerOrigin() })`. El
renderizador sigue probándose contra un documento cualquiera (`fixture.ts`), así que no hereda las
suposiciones del generador.

**Menciones a `/api/v1/openapi.json` → enlace.** En «Referencia» e «Integraciones», es (×2 por
idioma, `es` y `en`). El enlace se pinta con un `<a>` pelado y no con `<Link>`: el prefetch de
`<Link>` pediría una versión RSC que un JSON no tiene.

---

## Criterio ↔ test

Los criterios de las siete features ya tienen su tabla en cada `progress/impl_*.md`. Aquí solo lo
que añade la integración.

| Criterio de la integración                                                          | Test                                                                                                    |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| La referencia sale del generador real, no del fixture (25 `paths`, 37 operaciones)  | `src/components/developers/openapi/real-document.test.ts` › «sale del generador real, no del fixture»   |
| Ninguna clave de `paths` trae el prefijo                                            | ídem › «ninguna clave de `paths` trae el prefijo»                                                       |
| El servidor termina en exactamente un `/api/v1`                                     | ídem › «el servidor termina en exactamente un /api/v1»                                                  |
| La página enseña la ruta completa de cada operación                                 | ídem › «enseña la ruta completa de cada operación»                                                      |
| **El `curl` de cada operación es absoluto y con un solo `/api/v1`**                 | ídem › «el curl de cada operación es absoluto y con un solo /api/v1»                                    |
| **Las anclas conservan la ruta completa** (`#get-api-v1-me`)                        | ídem › «las anclas conservan la ruta completa»                                                          |
| Los **11** eventos de `WEBHOOK_EVENTS`, en su orden                                 | ídem › «describe los once eventos de `WEBHOOK_EVENTS`, en su orden»                                     |
| El origen usa `NEXT_PUBLIC_SITE_URL` cuando está                                    | `real-document.test.ts` › «usa el dominio canónico de la instancia cuando está configurado»             |
| Sin variable cae a un dominio de ejemplo, **nunca** a una URL relativa              | ídem › «sin variable cae a un dominio de ejemplo, nunca a una URL relativa»                             |
| **Fixture ↔ documento real: las mismas 37 operaciones, misma ruta y mismos scopes** | ídem › «cubre las mismas 37 operaciones, con la misma ruta y los mismos scopes»                         |
| **Fixture ↔ documento real: los mismos eventos, en el mismo orden**                 | ídem › «cubre los mismos eventos, en el mismo orden»                                                    |
| Fixture y documento comparten forma (servidor con prefijo, claves sin)              | ídem › «comparte la forma: servidor con prefijo, claves sin prefijo»                                    |
| `serverBasePath` (servidor absoluto, relativo, barra final, origen a secas)         | `src/components/developers/openapi/model.test.ts` › `serverBasePath` › 4 `it`                           |
| El contrato se enlaza como archivo, no como página (`<a>`, no `<Link>`)             | `src/components/developers/inline.test.tsx` › «enlaza el contrato OpenAPI como archivo, no como página» |
| El comprobador de enlaces rotos reconoce manejadores de ruta además de páginas      | `src/content/developers/links.test.ts` (ampliado en `a3aa1c7`)                                          |

---

## Compuerta

Cuatro comandos, **por separado y en primer plano**, en el worktree:

| Comando             | Resultado                                                                                                           |
| ------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `npm run lint`      | **0 errores**, 35 avisos (todos preexistentes: `exhaustive-deps` y `no-unused-vars` de módulos ajenos a la fase)    |
| `npm run typecheck` | limpio                                                                                                              |
| `TZ=UTC npm test`   | **198 archivos, 2 626 tests, todos en verde** (8,5 s)                                                               |
| `npm run build`     | compila; `ƒ Proxy (Middleware)`; las 26 rutas de `/api/v1` y las 12 páginas de `/developers` salen en el manifiesto |

Variables del build: `NEXT_PUBLIC_SUPABASE_URL=https://ci.example.supabase.co`,
`NEXT_PUBLIC_SUPABASE_ANON_KEY=ci-dummy-anon-key`, `ENCRYPTION_KEY=<64 ceros>`,
`META_APP_SECRET=ci-dummy-meta-secret`.

Progresión de la fase: 2 348 tests (2.ª integración) → 2 448 (3.ª) → **2 626** (esta).

### Prettier

`npx prettier --check mcp-server/README.md` → limpio.
`docs/mcp.md` **ya fallaba `--check` antes de esta sesión** (verificado con `git stash`): el
motivo es un bloque ` ```jsonc ` de ejemplo de configuración MCP al que prettier le añade comas
finales (`trailingComma: "es5"` + dialecto jsonc). Se aplicó `--write`, se comprobó que el único
cambio ajeno a la prosa era ese bloque y **se revirtió el bloque**, siguiendo el precedente de
`5e996e7` («deshacer el reformateo colateral»): una coma final en lo que mucha gente pega en un
`claude_desktop_config.json` de JSON estricto es un error de parseo. Confirmado que
`diff <(npx prettier docs/mcp.md) docs/mcp.md` solo difiere en ese bloque preexistente; la prosa
que sí toqué es estable bajo prettier. Anotado como deuda cosmética abajo.

---

## Replay de migraciones y comprobaciones contra base real

`scripts/replay-migrations.sh "$(pwd)"` → **salida 0**, `001`…`064` (64 archivos) todas `ok`,
**`verify-schema.sql: OK`**. Esta integración no añade ni modifica SQL: 061 (a7.1), 062 (a7.4),
063 (a7.5) y 064 (2.ª integración) vienen de rondas anteriores.

Con `KEEP=1` se re-ejecutaron los cinco `checks_*.sql` de la fase contra el mismo contenedor:

| Archivo                                 | Salida                                                                                                                                                             |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `progress/checks_api-hardening.sql`     | 7 `NOTICE … OK`, exit 0                                                                                                                                            |
| `progress/checks_webhooks-durable.sql`  | 5 bloques A–E `OK` + `checks_webhooks-durable: OK`, exit 0                                                                                                         |
| `progress/checks_tags-v1.sql`           | 4 bloques A–D `OK`, exit 0                                                                                                                                         |
| `progress/checks_exports-v1.sql`        | 5 bloques A–E `OK`, exit 0                                                                                                                                         |
| `progress/checks_integracion-api-2.sql` | 5 bloques A–E `OK`, exit 0 — requiere `docker cp .../supabase/migrations/064_tags_unique_name.sql <contenedor>:/tmp/` antes, tal como documenta su propia cabecera |

`progress/checks_templates-v1.sql` **no existe**: a7.3 no añadió SQL (su informe lo dice
explícitamente), así que no hay nada que re-ejecutar.

Contenedor eliminado al terminar.

---

## Rutas nuevas de la fase 7

### API pública — 26 manejadores bajo `/api/v1` (37 operaciones en el contrato)

| Feature                   | Rutas                                                                                                                                                                                                                                                                                  |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **a7.1** api-hardening    | endurece las preexistentes (`X-Request-Id`, `Idempotency-Key`, 413/415); sin rutas nuevas en `/api/v1`. Panel: `POST /api/account/api-keys/[id]/rotate`                                                                                                                                |
| **a7.2** tags-v1          | `GET`/`POST /tags`, `GET`/`PATCH`/`DELETE /tags/{id}`, `POST /contacts/{id}/tags`, `DELETE /contacts/{id}/tags/{tagId}`                                                                                                                                                                |
| **a7.3** templates-v1     | `GET`/`POST /templates`, `GET`/`PATCH`/`DELETE /templates/{id}`, `POST /templates/sync`                                                                                                                                                                                                |
| **a7.4** webhooks-durable | `GET /webhooks/{id}/deliveries`, `POST /webhooks/{id}/deliveries/{deliveryId}/retry`, `POST /webhooks/{id}/test`, `POST /webhooks/{id}/rotate-secret`. Fuera de v1: `GET /api/webhooks/cron`, `PATCH /api/conversations/{id}`, y el espejo en `/api/account/webhooks/**` para el panel |
| **a7.5** exports-v1       | `GET /conversations/{id}/export`, `POST /exports`, `GET /exports/{id}`                                                                                                                                                                                                                 |
| **a7.6** openapi-spec     | `GET /api/v1/openapi.json` (público, sin clave, cacheado 1 h con `ETag` fuerte)                                                                                                                                                                                                        |

### Documentación pública — 12 páginas bajo `/developers` (a7.7)

`/developers`, `/developers/authentication`, `/developers/conventions`, `/developers/guides`,
`/developers/guides/templates`, `/developers/guides/contacts-tags`, `/developers/guides/exports`,
`/developers/guides/webhooks`, `/developers/reference`, `/developers/webhooks`,
`/developers/integrations`, `/developers/changelog`.

---

## Cierre documental (verificado, no rehecho)

| Encargo                                                                | Estado                                                                                                                                                                                                             |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `docs/public-api.md` es un puntero que menciona `/api/v1/openapi.json` | ✅ 41 líneas, tabla con las dos direcciones (`/developers` y `/api/v1/openapi.json`), y remite a `docs/docker.md` para el cron                                                                                     |
| CHANGELOG con entrada por feature a7.1–a7.7                            | ✅ a7.1 → `:112`, `:120`, `:126`, `:565`, `:570`, `:577`; a7.2 → `:467`, `:479`, `:486`; a7.3 → `:504`, `:512`; a7.4 → `:128`, `:138`, `:144`, `:163`; a7.5 → `:149`; a7.6 → `:519`, `:532`; a7.7 → `:542`, `:552` |
| `README.md` apunta a `/developers`                                     | ✅ líneas 51–54                                                                                                                                                                                                    |
| `docs/mcp.md` apunta a `/developers`                                   | ✅ commit `0be9815` de esta sesión                                                                                                                                                                                 |
| `mcp-server/README.md` apunta a `/developers`                          | ✅ commit `0be9815`; ya nombraba `GET /api/v1/openapi.json`                                                                                                                                                        |
| `docs/docker.md` con `WEBHOOK_CRON_SECRET` y el cron                   | ✅ líneas 346–375: qué es, tabla de la variable, 503 sin ella, `* * * * *` con `x-cron-secret`, y la nota de que el mismo barrido termina exportaciones cortadas y purga a los 7 días con cupo aparte              |

---

## Variables de entorno

**Una nueva en toda la fase: `WEBHOOK_CRON_SECRET`** (a7.4). Documentada en `docs/docker.md`.
Sin ella, `GET /api/webhooks/cron` responde **503** y nada se reintenta nunca (el primer intento
de cada webhook sí ocurre).

`NEXT_PUBLIC_SITE_URL` la usa ahora también `/developers/reference` para el origen de los `curl`,
pero **no es nueva**: ya la usaban las invitaciones y el checkout, y su ausencia degrada a un
dominio de ejemplo, no a un fallo.

**`.env.local.example` está bloqueado por permisos y no se tocó.** Lo añade el humano:
`WEBHOOK_CRON_SECRET=`.

---

## Verificaciones manuales pendientes (consolidadas de las siete features)

### Dependen de un servicio externo

1. **Meta / plantillas (a7.3).** Alta, aprobación, sync, cubo de 6/min y edición con herencia del
   pie de página. Guion completo en `progress/impl_templates-v1.md` §«Verificación manual
   pendiente (depende de Meta)» — seis pasos con `curl`, incluido el `Idempotent-Replayed: true`
   del repetido y el `429` en la séptima llamada.
2. **Herramientas OpenAPI reales (a7.6).** Importar `openapi.json` en Postman/Insomnia o pasarlo
   por `openapi-generator`. Guion en `progress/impl_openapi-spec.md` §5 punto 1. Lo primero que
   hay que mirar: que la colección diga `/api/v1/contacts` y **no** `/api/v1/api/v1/contacts`.
3. **Las 17 tools nuevas del MCP contra una instancia viva (a7.6).** `mcp-server/` no tiene runner
   de tests. Guion en `progress/impl_openapi-spec.md` §5 punto 2 (find-or-create de etiquetas,
   todo-o-nada de `add_contact_tags`, `confirm` obligatorio en las destructivas, invisibilidad de
   las tools de escritura sin `WACRM_ENABLE_WRITES`).
4. **Supabase Storage: caducidad real de la firma a los 15 min (a7.5).** Guion de cinco pasos en
   `progress/impl_exports-v1.md` §«Verificaciones manuales pendientes».

### No dependen de terceros, pero no hay runner (no hay e2e en el repo)

5. **Panel → Ajustes → API (a7.1):** selector de caducidad (nunca/30/90/365), rotación con
   revelación única e insignia ámbar «En rotación», «Revocar ya», los tres idiomas sin texto
   crudo, y que en una clave ya en rotación **no** aparezca «Rotar» (409 si se llega por otra vía).
   Cinco puntos en `progress/impl_api-hardening.md`.
6. **Cron de webhooks en un despliegue (a7.4):** que `scanned/attempted/delivered/purged` avancen;
   503 sin la variable.
7. **Ida y vuelta con un receptor real (a7.4):** «Probar» contra webhook.site, verificar la firma a
   mano, apagar el receptor, ver la entrega `failed` con `next_attempt_at` a +1 min, encenderlo y
   ver que el barrido la entrega.
8. **SSRF con DNS cambiante (a7.4):** dominio que resuelva público y se repunte a 10.x entre el
   alta y la entrega → `failed` con «delivery target does not resolve to a public address» y cero
   peticiones salientes. Cubierto con mock, conviene verlo una vez con DNS real.
9. **`/developers` a 375 px y el botón «Copiar» (a7.7):** los únicos dos puntos del guion de a7.7
   que siguen abiertos; necesitan un navegador con manos. El resto del guion (incluida la medición
   de accesibilidad con Lighthouse) ya se ejecutó en la 2.ª ronda.

---

## Deudas abiertas al cerrar la fase

### Heredadas de `progress/current.md` §«Fase 7 — deuda acumulada»: qué quedó cerrado y qué no

| Deuda                                                                                                       | Estado                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| Mover `WEBHOOK_ACTION_RATE_LIMIT` a `RATE_LIMITS` y tipar `fail('conflict', …)` con `ApiErrorCode.conflict` | **cerrado** en la 1.ª integración (`impl_integracion-api.md`)                                                                               |
| `contact.tag_removed` emitido aunque el DELETE no quite nada                                                | **cerrado** en a7.2 (`CHANGELOG.md:479`)                                                                                                    |
| Índice único `tags(account_id, lower(name))`, lote todo-o-nada, `findTagByName` sin `.limit()`              | **cerrado** en la 2.ª integración (migración 064)                                                                                           |
| Suposiciones incompatibles de `source.ts` entre a7.6 y a7.7                                                 | **cerrado** aquí (`a3aa1c7`)                                                                                                                |
| `.env.local.example` sin `WEBHOOK_CRON_SECRET`                                                              | **abierto** — bloqueado a los agentes, lo añade el humano                                                                                   |
| `PATCH /api/conversations/{id}` no valida que `assigned_agent_id` sea miembro de la cuenta                  | **abierto** — preexistente, declarado fuera de la fase 7                                                                                    |
| Tests de 413/415 por ruta en `webhooks`                                                                     | **abierto** — es cobertura, no comportamiento                                                                                               |
| El gestor de etiquetas del panel (`tag-manager.tsx`) lista por `user_id`, no por cuenta                     | **abierto** — **decisión de producto para el humano**: desde la 064 una etiqueta de un compañero es invisible y además colisiona por nombre |

### De los reviews de esta ronda

1. **`src/lib/exports/jobs.ts:367-380`** — la rama que convierte `ExportTooLargeError` en `failed`
   con texto accionable no tiene test propio; sus dos mitades sí. _(review_exports-v1 §1)_
2. **`src/lib/exports/jobs.ts:70`** — `EXPORT_STALE_MS = 10 min` frente a un techo de 250 000
   mensajes: contra una base real el barrido puede reclamar un export que sigue vivo y construirlo
   dos veces. Sin fuga ni corrupción, solo trabajo duplicado. _(review_exports-v1 §2)_
3. **Un export asíncrono se construye entero en memoria**; lo correcto a futuro es escribir en
   streaming al bucket. _(impl_exports-v1)_
4. **`GET /conversations/{id}/export`** cobra el cubo de 10/hora **antes** de resolver la
   conversación (diez 404 seguidos dejan a la cuenta sin exportaciones esa hora); el POST hace lo
   contrario. Incoherencia menor. _(review_exports-v1 §3)_
5. **`Content-Disposition` interpola el `{id}` sin sanear** (hoy inalcanzable). _(review_exports-v1 §4)_
6. **`resolveServerUrl` decide con `endsWith(API_BASE_PATH)`**: un proxy montado en `…/algo/api/v1`
   se deja como está. Comportamiento deseado hoy, solo anotado. _(review_openapi-spec §1)_
7. **`stripComments` del test de cobertura borra un `//` dentro de una cadena.** Hoy no cambia
   ningún resultado; futura fuente de falsos negativos. _(review_openapi-spec §2)_
8. **`src/app/api/whatsapp/templates/sync/route.ts` sigue sin test propio.** _(review_templates-v1 §1)_
9. **Deuda de a7.3 elevada al líder:** WABA por plantilla, `WHATSAPP_TEMPLATES_DRY_RUN` sin
   documentar, `/messages type=template` sin comprobar el estado local, botones OTP/FLOW
   descartados en el sync.
10. **`POST /api/account/api-keys/[id]/rotate` lee con `request.json()` sin tope propio**: las
    rutas de `/api/account` no tienen el límite de 1 MiB de `/api/v1`. Preexistente y transversal.
    _(impl_api-hardening)_
11. **El comentario de `mcp-server/` que dice «kept in sync manually» no lo está**, ahora con 17
    tools nuevas. _(impl_openapi-spec)_
12. **`docs/mcp.md` no pasa `prettier --check`** por el bloque ` ```jsonc ` (ver §Compuerta).
    Preexistente a la fase. Arreglarlo bien es decidir si el ejemplo se declara `json` (y prettier
    deja de añadir comas) o se acepta jsonc; no es un parche de una línea y no toca a esta feature.
    No afecta a la compuerta: `npm run lint` no corre prettier.
13. **El barrido y la purga de `export_jobs` corren sin filtro de cuenta**, como los de
    `webhook_deliveries`: son barridos entre cuentas por definición. Sin waiver hoy.

---

## Estado de ramas

| Rama               | Punta         | Situación                                                                                           |
| ------------------ | ------------- | --------------------------------------------------------------------------------------------------- |
| `main`             | `3b82698`     | base de toda la fase 7; **sin tocar**                                                               |
| `feat/api-publica` | **`0be9815`** | **fase 7 completa**: 0be9815 ⊃ a3aa1c7 ⊃ 2341143 ⊃ (a7.6, a7.7, y por a4ce30a las cinco anteriores) |
| `api/recursos`     | `a4ce30a`     | fusionada (a7.1+a7.2+a7.3+a7.5); worktree se puede retirar                                          |
| `api/webhooks`     | `170d73e`     | fusionada en `api/recursos` en la 1.ª integración                                                   |
| `api/templates`    | `80e0e9d`     | fusionada en `api/recursos` en la 2.ª integración                                                   |
| `api/exports`      | `8ed0ecc`     | fusionada en `api/recursos` en la 3.ª integración                                                   |
| `api/openapi`      | `2fbc159`     | fusionada (avance rápido)                                                                           |
| `api/docs`         | `073ac07`     | fusionada (`2341143`)                                                                               |

`feat/api-publica` contiene las siete features. **No se hizo push, ni PR, ni se tocaron `main`,
`dev` ni `feat/saas-multiempresa`**, según las reglas del harness. El merge de `feat/api-publica`
a `main` o a `feat/saas-multiempresa` queda para el humano.

Nota de higiene para el líder: seis worktrees de la fase 7 (`api-recursos`, `api-webhooks`,
`api-templates`, `api-exports`, `api-openapi`, `api-docs`) ya no tienen trabajo vivo y se pueden
retirar con `git worktree remove` cuando el humano dé por buena la fase.
