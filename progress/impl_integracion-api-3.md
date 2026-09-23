# Integración a7.5 `exports-v1` → `api/recursos` (tercera tarea de integración, fase 7)

No es una feature de `feature_list.json`. Worktree
`/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/api-recursos`, rama
`api/recursos` (base `4327aa4`), entra `api/exports` @ `8ed0ecc` (base `6b0d768`, APPROVED en
`progress/review_exports-v1.md`).

**Estado: verde.** Compuerta ejecutada comando a comando en primer plano, replay 001–064 con
salida 0, y `feat/api-publica` adelantada por fast-forward a `a4ce30a`.

## Plan ejecutado

1. `git merge api/exports` — cuatro conflictos, todos de yuxtaposición. Commit del merge.
2. Cerrados los hallazgos 1, 3, 4 y 5 de la revisión. El 2 queda como deuda anotada.
3. Compuerta + `scripts/replay-migrations.sh` + los tres SQL de comprobación.
4. `git merge --ff-only api/recursos` desde el worktree `api-publica`.
5. Este informe, con el inventario de rutas `/api/v1/**` para a7.6.

## Commits

En `api/recursos` (worktree `api-recursos`), ninguno pusheado:

| Commit | Mensaje |
|---|---|
| `6fd8e6a` | `Merge branch 'api/exports' into api/recursos` |
| `a4ce30a` | `fix: cerrar los hallazgos baratos de la revisión de exports-v1` |

## 1. Conflictos y resolución

`git merge api/exports` dejó cuatro archivos en conflicto. Dos más (`CHANGELOG.md`,
`src/lib/security/tenant-isolation.test.ts`) se auto-fusionaron; comprobado a mano que en el
test de aislamiento conviven los bloques de exportaciones (`export síncrono: la conversación
de B → 404`, `encargos: la lista es de A…`, líneas ~1546-1640) y los de a7.2/a7.3
(`describe('/api/v1/tags …')` y `describe('/api/v1/templates …')`, líneas 3149 y 3339). No se
descartó ni un test.

| Archivo | Conflicto | Resolución |
|---|---|---|
| `src/lib/api-keys/scopes.ts` | Los cuatro scopes de tags/templates y `conversations:export` añadidos en el mismo punto de `API_SCOPES` y de `SCOPE_DESCRIPTIONS` | Ambos lados; `conversations:export` al final de la lista y de las descripciones. 12 scopes en total |
| `src/lib/rate-limit.ts` | `templatesSync` y `exports` añadidos al final de `RATE_LIMITS` | Ambas entradas, con su comentario íntegro |
| `supabase/ci/verify-schema.sql` | Bloque 063 (export_jobs + bucket) frente a bloque 064 (índice único de tags), ambos al final del `DO $$` | **Ambos, 063 antes de 064**, respetando el orden de las migraciones. El `END IF;` compartido que cerraba el conflicto se duplicó para que cada bloque cierre el suyo |
| `docs/public-api.md` | (a) tabla de scopes, (b) secciones de endpoints, (c) párrafo de Roadmap | (a) una sola tabla con los 12 scopes, columnas realineadas; (b) las secciones de tags y templates seguidas de las de exportaciones, sin reordenar nada; (c) frase única que nombra tags, plantillas y exportaciones |

`npx prettier --check` limpio en los cuatro. `npm run typecheck` verde antes de commitear el
merge.

## 2. Hallazgos de `progress/review_exports-v1.md`

### Cerrados

**(1) `runExportJob` capturando `ExportTooLargeError` no tenía test** — cerrado en
`src/lib/exports/jobs.test.ts`. El techo son 250 000 mensajes y no se puede alcanzar sembrando
filas en un doble, así que se simula donde nace: un `vi.mock('./conversations')` que delega en
el módulo real salvo cuando el interruptor `h.tooLarge` está puesto, en cuyo caso
`buildConversationsDocument` lanza un `ExportTooLargeError` auténtico
(`new actual.ExportTooLargeError(actual.ASYNC_MESSAGE_LIMIT)`). Lo que se prueba es el `catch`
de `runExportJob`, que es lo que faltaba. Añadido también su contrario, que no existía como
tal: un error inesperado (con una IP interna en el mensaje) tiene que quedarse en el log y
dejar la frase genérica en la fila.

**(3) el cubo de 10/hora se cobraba antes de resolver la conversación** — cerrado en
`src/app/api/v1/conversations/[id]/export/route.ts`. El `checkRateLimit` se movió detrás del
`maybeSingle()` y del `if (!conv) return 404`, que es el orden del POST (decisión 8 del informe
de a7.5). Comentario de cabecera y párrafo de `docs/public-api.md` actualizados para que la
promesa documentada sea la del código.

**(4) el `{id}` interpolado en `Content-Disposition`** — cerrado. El `filename` ya no usa el
`id` de la URL sino el de la fila que devolvió la base, y aun así pasa por
`.replace(/[^A-Za-z0-9-]/g, '')`. Se hicieron las dos cosas y no solo la segunda porque el
nombre viaja **entrecomillado** dentro de una cabecera: el uuid lo garantiza hoy, el filtro lo
garantiza el día que la ruta acepte otro identificador.

**(5) línea larga del CHANGELOG** — cerrada. Aviso: el corte obvio (`Requires migration\n063.`)
**no pasa prettier**, porque una línea que empieza por `063.` es un ítem de lista ordenada en
markdown y prettier la renumera. El corte quedó tras `Requires migration 063.`, y el título de
la entrada se partió en su propia línea.

### Abierto (deuda, no tocado por instrucción)

**(2) `EXPORT_STALE_MS` = 10 min frente a `ASYNC_MESSAGE_LIMIT` = 250 000**
(`src/lib/exports/jobs.ts:70`). Un export en el techo puede pasar de diez minutos contra una
base real y el barrido lo reclamaría con el primer proceso todavía vivo: no hay fuga ni
corrupción (misma ruta, `upsert: true`, misma cuenta, cierre idempotente), solo trabajo
duplicado. Atar el plazo al tamaño del job es un cambio de diseño, no un arreglo de
integración.

## 3. Compuerta

Los cuatro comandos por separado, en primer plano, en el worktree `api-recursos` sobre
`a4ce30a`:

| Comando | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 35 avisos, todos preexistentes (ninguno en `src/lib/exports/**` ni en `src/app/api/v1/**`) |
| `npm run typecheck` | **verde**, sin salida |
| `TZ=UTC npm test` | **verde** — **187 archivos, 2 448 tests, 0 fallos** |
| `npm run build` con las variables dummy de `docs/harness.md` | **verde** — `Compiled successfully in 10.3s`; registra las 25 rutas de `/api/v1` del inventario de abajo |

Conteo de tests: 2 448 = 2 328 de `api/exports` + los de a7.2/a7.3 que ya estaban en
`api/recursos` + los 4 nuevos de esta integración (2 en la ruta síncrona, 2 en `jobs.test.ts`).

## 4. Replay de migraciones

`KEEP=1 scripts/replay-migrations.sh "$(pwd)"` sobre el worktree: **001–064 completas, salida 0**,
`ok 063_export_jobs.sql`, `ok 064_tags_unique_name.sql`, `verify-schema.sql: OK`. Es la primera
vez que 063 y 064 corren juntas y que el `verify-schema.sql` fusionado (bloque 063 + bloque 064)
se ejecuta: pasa entero.

Con el contenedor vivo (`wacrm-migrations-84394`, eliminado al terminar) se re-ejecutaron los
tres SQL de comprobación, todos con `ON_ERROR_STOP=1` y salida 0:

| SQL | Resultado |
|---|---|
| `progress/checks_exports-v1.sql` | 5/5 — A CHECKs y retención de 7 días, B RLS de lectura por cuenta y escritura solo del rol de servicio, C bucket privado con tope y cero políticas de `storage.objects`, D reclamo optimista exclusivo, E cascadas |
| `progress/checks_integracion-api-2.sql` | 5/5 — A tres homónimas → una (la más antigua), B uniones mudadas al superviviente, C automatizaciones/pasos/nodos apuntando a etiqueta viva, D 23505 en el homónimo, E re-ejecutar 064 es un no-op |
| `progress/checks_tags-v1.sql` | 4/4 — A `ON DELETE CASCADE` de `contact_tags`, B `UNIQUE(contact_id, tag_id)`, C `RETURNING` distingue quitar de no quitar, D un nombre por cuenta impuesto por 064 |

Nota operativa para quien repita esto: `checks_integracion-api-2.sql` hace
`\i /tmp/064_tags_unique_name.sql`, así que hay que copiar la migración al contenedor antes
(`docker cp <worktree>/supabase/migrations/064_tags_unique_name.sql <contenedor>:/tmp/`). Sin
eso, psql falla al incluirla pero **devuelve 0**: hay que leer la salida, no solo el código de
salida.

## 5. Estado de ramas

| Rama | Commit | Nota |
|---|---|---|
| `main` | `3b82698` | intacta, no se tocó |
| `api/recursos` | `a4ce30a` | a7.1 + a7.2 + a7.3 + a7.5, migraciones 061, 063, 064 |
| `feat/api-publica` | `a4ce30a` | **fast-forward limpio** desde `api/recursos` (`git merge --ff-only`, salida 0) |
| `api/exports` | `8ed0ecc` | ya integrada (ancestro de `a4ce30a`) |
| `api/templates` | `80e0e9d` | ya integrada |
| `api/webhooks` | `170d73e` | ya integrada (a7.4, migración 062) |

Nada pusheado, ningún PR, `main` sin tocar. Los cuatro worktrees de trabajo de la fase quedan
convergidos en `a4ce30a`: a7.6 puede partir de `feat/api-publica` sin más integraciones
pendientes.

## 6. Inventario de rutas `/api/v1/**` (para el OpenAPI de a7.6)

**25 archivos de ruta, 37 operaciones.** Scope tomado del segundo argumento de `requireApiKey`,
que es el único sitio donde se decide; los cubos, de los `RATE_LIMITS.*` que aparecen en cada
archivo.

| # | Método y ruta | Scope | Cubo de rate limit | Idempotency-Key |
|---|---|---|---|---|
| 1 | `GET /api/v1/me` | *(ninguno — autentica y ya)* | `publicApi` | — |
| 2 | `GET /api/v1/contacts` | `contacts:read` | `publicApi` | — |
| 3 | `POST /api/v1/contacts` | `contacts:write` | `publicApi` | — |
| 4 | `GET /api/v1/contacts/{id}` | `contacts:read` | `publicApi` | — |
| 5 | `PATCH /api/v1/contacts/{id}` | `contacts:write` | `publicApi` | — |
| 6 | `POST /api/v1/contacts/{id}/tags` | `tags:write` | `publicApi` | sí |
| 7 | `DELETE /api/v1/contacts/{id}/tags/{tagId}` | `tags:write` | `publicApi` | — |
| 8 | `GET /api/v1/tags` | `tags:read` | `publicApi` | — |
| 9 | `POST /api/v1/tags` | `tags:write` | `publicApi` | sí |
| 10 | `GET /api/v1/tags/{id}` | `tags:read` | `publicApi` | — |
| 11 | `PATCH /api/v1/tags/{id}` | `tags:write` | `publicApi` | — |
| 12 | `DELETE /api/v1/tags/{id}` | `tags:write` | `publicApi` | — |
| 13 | `GET /api/v1/conversations` | `conversations:read` | `publicApi` | — |
| 14 | `GET /api/v1/conversations/{id}` | `conversations:read` | `publicApi` | — |
| 15 | `GET /api/v1/conversations/{id}/messages` | `messages:read` | `publicApi` | — |
| 16 | `GET /api/v1/conversations/{id}/export` | `conversations:export` | **`exports`** (10/h por cuenta) | — |
| 17 | `POST /api/v1/messages` | `messages:send` | `publicApi` | sí |
| 18 | `POST /api/v1/broadcasts` | `broadcasts:send` | `publicApi` | sí |
| 19 | `GET /api/v1/broadcasts/{id}` | `broadcasts:send` | `publicApi` | — |
| 20 | `GET /api/v1/templates` | `templates:read` | `publicApi` | — |
| 21 | `POST /api/v1/templates` | `templates:write` | `publicApi` | sí |
| 22 | `GET /api/v1/templates/{id}` | `templates:read` | `publicApi` | — |
| 23 | `PATCH /api/v1/templates/{id}` | `templates:write` | `publicApi` | sí |
| 24 | `DELETE /api/v1/templates/{id}` | `templates:write` | `publicApi` | — |
| 25 | `POST /api/v1/templates/sync` | `templates:write` | **`templatesSync`** (6/min por cuenta) | — |
| 26 | `GET /api/v1/exports` | `conversations:export` | `publicApi` | — |
| 27 | `POST /api/v1/exports` | `conversations:export` | **`exports`** (10/h por cuenta) | sí |
| 28 | `GET /api/v1/exports/{id}` | `conversations:export` | `publicApi` | — |
| 29 | `GET /api/v1/webhooks` | `webhooks:manage` | `publicApi` | — |
| 30 | `POST /api/v1/webhooks` | `webhooks:manage` | `publicApi` | — |
| 31 | `GET /api/v1/webhooks/{id}` | `webhooks:manage` | `publicApi` | — |
| 32 | `PATCH /api/v1/webhooks/{id}` | `webhooks:manage` | `publicApi` | — |
| 33 | `DELETE /api/v1/webhooks/{id}` | `webhooks:manage` | `publicApi` | — |
| 34 | `GET /api/v1/webhooks/{id}/deliveries` | `webhooks:manage` | `publicApi` | — |
| 35 | `POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry` | `webhooks:manage` | **`webhookAction`** | — |
| 36 | `POST /api/v1/webhooks/{id}/test` | `webhooks:manage` | **`webhookAction`** | — |
| 37 | `POST /api/v1/webhooks/{id}/rotate-secret` | `webhooks:manage` | **`webhookAction`** | — |

Notas para el generador de OpenAPI:

- **`GET /api/v1/me` es la única operación sin scope.** Todas las demás lo exigen.
- **`GET /api/v1/conversations/{id}/export` es la única que NO devuelve el sobre `{data}`**:
  el cuerpo es el archivo (`application/json` o `text/csv`) con `Content-Disposition`. Los
  errores sí van en el sobre. Hay que modelarla aparte o el esquema mentirá.
- Los scopes de `/broadcasts` son `broadcasts:send` **también en el `GET`** — no existe
  `broadcasts:read`.
- `publicApi` es el cubo por defecto, lo aplica `requireApiKey` a toda operación y va **por
  clave** (`apikey:${keyId}`, `src/lib/auth/api-context.ts:100`). Los tres cubos en negrita
  (`exports`, `templatesSync`, `webhookAction`) son propios, van **por cuenta** y se suman al
  general: dos claves de la misma empresa comparten esos tres y no el `publicApi`.
- Los 12 scopes válidos, en el orden de `API_SCOPES`: `messages:send`, `messages:read`,
  `contacts:read`, `contacts:write`, `conversations:read`, `broadcasts:send`,
  `webhooks:manage`, `tags:read`, `tags:write`, `templates:read`, `templates:write`,
  `conversations:export`.

## Variables de entorno

Ninguna nueva. `.env.local.example` no se tocó (está bloqueado por permisos y, además, no había
nada que añadir).

## Deuda detectada fuera de alcance

1. **`EXPORT_STALE_MS` vs. el techo de 250 000** — hallazgo 2, arriba. No tocado por
   instrucción.
2. **`docs/public-api.md` va camino de ser inmantenible**: 1 000 líneas y creciendo con cada
   feature de la fase, y S-A5 dice que pasa a ser un puntero a `/developers`. Cada integración
   resuelve conflictos en él que a7.7 va a borrar. No lo he adelantado porque no es mi alcance.
3. **El barrido y la purga del cron de exportaciones son entre cuentas por definición** (igual
   que los de `webhook_deliveries` de a7.4): consultas de rol de servicio sin
   `.eq('account_id', …)`, justificadas pero sin cobertura en la suite de aislamiento, que no
   sabe expresar "esto debe cruzar cuentas". Ya anotado por el implementer de a7.5.
4. **`checks_integracion-api-2.sql` depende de un `\i /tmp/…` que hay que preparar a mano** y no
   avisa si falta. Un `\set ON_ERROR_STOP` no basta: conviene que el propio SQL falle ruidosamente
   si el archivo no está.
