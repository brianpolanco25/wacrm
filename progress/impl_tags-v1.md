# a7.2 `tags-v1` — etiquetas en la API pública

Spec: `progress/spec_api-publica.md` §2, más «Seguridad transversal» y S-A1..S-A7.
Rama `api/recursos`, worktree `.claude/worktrees/api-recursos`, base @ 6b0d768
(a7.1 `api-hardening` + a7.4 `webhooks-durable` ya integradas). **Sin migración.**

## Plan (escrito antes de tocar código)

1. Scopes `tags:read` / `tags:write` al final de `API_SCOPES` y `SCOPE_DESCRIPTIONS`.
2. `src/lib/api/v1/tags.ts`: serializador, normalización de nombre/color,
   búsqueda por nombre insensible a mayúsculas, find-or-create.
3. Rutas:
   - `GET|POST /api/v1/tags` (paginado keyset + `?search=`; find-or-create 200/201).
   - `GET|PATCH|DELETE /api/v1/tags/{id}`.
   - `POST /api/v1/contacts/{id}/tags` `{tag_ids:[...]}`.
   - `DELETE /api/v1/contacts/{id}/tags/{tagId}`.
   Todas con `requireApiKey(request, scope)`, `ok`/`okList`/`fail`/`toApiErrorResponse`,
   cuerpo por `readJsonBody` o `withIdempotency`. Nunca `request.json()`.
4. Deuda de a7.4 (hallazgo 2 de `review_webhooks-durable.md`): `removeContactTag`
   pasa a devolver si borró fila; `removeContactTagAndDispatch` y el paso
   `remove_tag` del motor de automatizaciones solo emiten `contact.tag_removed`
   cuando de verdad se quitó algo. Simétrico a `tag_added`.
5. Tests vitest por criterio + casos de fuga al final de
   `src/lib/security/tenant-isolation.test.ts`.
6. SQL contra el Postgres del harness en `progress/checks_tags-v1.sql`
   (la cascada `contact_tags → tags` que sostiene el DELETE).
7. `docs/public-api.md` (contrato de hoy) y `CHANGELOG.md`.

El plan se cumplió entero. Lo que sigue es el informe final.

## Nota de continuidad

La primera sesión de implementación se colgó (watchdog de 600 s) con el trabajo
del punto 1–4 **sin commitear** en el worktree. Esta sesión lo rescató: leyó el
diff completo, comprobó que compilaba (`typecheck` limpio, 65 tests de los
archivos tocados en verde) y lo commiteó tal cual como primer hito
(`9530f4f … (WIP)`) antes de seguir. **No se descartó ni se reescribió nada de
ese trabajo**; los puntos 5–7 son los que faltaban.

## Rama y commits

Rama `api/recursos`, tres commits sobre 6b0d768:

| Commit    | Qué                                                                             |
| --------- | ------------------------------------------------------------------------------- |
| `9530f4f` | `feat:` scopes, `src/lib/api/v1/tags.ts`, las cuatro rutas y el arreglo de a7.4 (WIP rescatado) |
| `9de4cc4` | `test:` los dos archivos de ruta nuevos + el bloque de fuga de la suite de aislamiento |
| `9b6e6a9` | `docs:` `docs/public-api.md` y `CHANGELOG.md`                                     |

Archivos nuevos: `src/lib/api/v1/tags.ts`, `src/app/api/v1/tags/route.ts`,
`src/app/api/v1/tags/[id]/route.ts`, `src/app/api/v1/contacts/[id]/tags/route.ts`,
`src/app/api/v1/contacts/[id]/tags/[tagId]/route.ts` y sus dos archivos de test.
Modificados: `src/lib/api-keys/scopes.ts`, `src/lib/contacts/tag-write.ts`,
`src/lib/contacts/tag-events.ts`, `src/lib/automations/engine.ts`,
`src/app/api/contacts/[id]/tags/route.ts` (el del panel, que ahora devuelve
`removed`), sus tests, `src/lib/security/tenant-isolation.test.ts`,
`docs/public-api.md` y `CHANGELOG.md`.

Los cambios en `scopes.ts`, `CHANGELOG.md`, `docs/public-api.md` y
`tenant-isolation.test.ts` van **al final de sus listas** (filas de tabla,
viñetas, imports, bloque `describe`) porque `api/templates` crece en paralelo
por los mismos cuatro archivos.

## Criterio ↔ test

Los dos criterios del spec §2 son «tests de las 7 operaciones, incluido fuga» y
«asignar por API dispara el mismo evento que el panel».

| Operación / criterio                          | Archivo                                                   | `it`                                                                        |
| --------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------- |
| 1. `GET /tags` (lista, orden, acotación)       | `src/app/api/v1/tags/route.test.ts`                        | `lista solo las etiquetas de la cuenta, de la más nueva a la más vieja`      |
| 1. `GET /tags?search=`                         | idem                                                       | `con ?search= devuelve la etiqueta de ESTA cuenta, no la homónima de la otra` |
| 1. `GET /tags` paginado keyset                 | idem                                                       | `pagina por cursor: una página por etiqueta y el cursor lleva a la siguiente` |
| 2. `POST /tags` crea (201)                     | idem                                                       | `crea una etiqueta nueva con 201, acotada a la cuenta`                       |
| 2. `POST /tags` find-or-create (200)           | idem                                                       | `un nombre que ya existe (en otra caja) devuelve 200 con la fila existente y no crea otra` |
| 2. `POST /tags` validación nombre/color        | idem                                                       | `rechaza un nombre vacío, ausente o demasiado largo sin escribir nada`, `rechaza un color que no es hexadecimal` |
| 3. `GET /tags/{id}`                            | idem                                                       | `devuelve la etiqueta propia`                                                |
| 4. `PATCH /tags/{id}`                          | idem                                                       | `renombra y repinta la etiqueta propia`, `rechaza con 409 renombrar sobre un nombre que la cuenta ya usa` |
| 5. `DELETE /tags/{id}`                         | idem                                                       | `borra la etiqueta propia`                                                   |
| 6. `POST /contacts/{id}/tags`                  | `src/app/api/v1/contacts/[id]/tags/route.test.ts`          | `ata las etiquetas y devuelve el contacto con ellas`                         |
| 7. `DELETE /contacts/{id}/tags/{tagId}`        | idem                                                       | `quita la etiqueta, emite contact.tag_removed y devuelve el contacto sin ella` |
| **Mismo evento que el panel**                  | idem                                                       | `dispara el MISMO evento que el panel: trigger tag_added y contact.tag_added` |
| **Fuga**: tag ajeno en GET/PATCH/DELETE        | `src/app/api/v1/tags/route.test.ts`                        | `con el id de otra cuenta responde 404, nunca 403 ni la fila`; `con el id de otra cuenta responde 404 y no toca su fila`; `con el id de otra cuenta responde 404 y la deja donde estaba` |
| **Fuga**: tag ajeno al asignar                 | `src/app/api/v1/contacts/[id]/tags/route.test.ts`          | `con una etiqueta de otra cuenta responde 404 y no escribe ni dispara nada`  |
| **Fuga**: contacto ajeno                       | idem                                                       | `con un contacto de otra cuenta responde 404 antes de tocar ninguna etiqueta`, `con un contacto de otra cuenta responde 404` |
| **Fuga**: find-or-create no reutiliza la ajena | `src/lib/security/tenant-isolation.test.ts`                | `POST /tags con un nombre que solo tiene B crea la etiqueta de A, no reutiliza la de B` |
| **Fuga**: suite de aislamiento, las 4 rutas    | idem                                                       | `GET /tags lista la etiqueta de A y nunca la homónima de B, ni con ?search=`; `GET/PATCH/DELETE /tags/{id} con el id de B son 404 y no tocan nada suyo`; `POST /contacts/{id}/tags rechaza con 404 la etiqueta de B y el contacto de B`; `DELETE /contacts/{id}/tags/{tagId} no desetiqueta a un contacto de B` |
| Guardas de cuerpo (415/413) de a7.1            | ambos archivos de ruta                                     | `exige Content-Type: application/json y respeta el tope de 1 MiB`            |
| Sobre de v1 (`no-store`, `X-Request-Id`)       | `src/app/api/v1/tags/route.test.ts`                        | `sirve el sobre de v1: Cache-Control no-store y X-Request-Id`                |
| Scopes exigidos                                | ambos                                                      | `pide el scope tags:read`, `pide el scope tags:write`                        |

Deuda de a7.4 cerrada (`contact.tag_removed` solo si se quitó algo):

| Capa                                         | Archivo                                       | `it`                                                              |
| -------------------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| Escritor (`removeContactTag` devuelve bool)   | `src/lib/contacts/tag-write.test.ts`          | `devuelve true cuando el DELETE alcanzó una fila`, `devuelve false cuando la etiqueta no estaba puesta`, `pide las filas de vuelta en la propia consulta de borrado` |
| Despachador                                   | `src/lib/contacts/tag-events.test.ts`         | `no emite contact.tag_removed si el DELETE no quitó ninguna fila`, `un segundo DELETE seguido solo emite una vez` |
| Paso `remove_tag` de automatizaciones         | `src/lib/automations/engine.test.ts`          | `emite contact.tag_removed cuando el DELETE alcanzó una fila`, `no emite nada cuando el contacto no llevaba esa etiqueta` |
| Ruta del panel                                | `src/app/api/contacts/[id]/tags/route.test.ts`| `dice que no quitó nada cuando la etiqueta no estaba puesta`       |
| Ruta pública                                  | `src/app/api/v1/contacts/[id]/tags/route.test.ts` | `repetido sigue siendo 200 pero NO vuelve a anunciar una retirada`, `una etiqueta que el contacto nunca tuvo tampoco emite nada` |

**Por qué estos tests significan algo.** Los dos archivos de ruta corren sobre
`src/lib/security/fake-supabase.ts` (la base en memoria que evalúa las consultas
de verdad), no sobre cadenas de `vi.fn()`. Las dos cuentas están sembradas con
etiquetas **homónimas** y las de B van primero: a una ruta a la que se le caiga
el `.eq('account_id', …)` le vuelven aquí las filas de B y el test falla. Con un
mock encadenado, el mismo fallo pasaría inadvertido porque el doble nunca tuvo
filas ajenas que devolver.

En el archivo de asignación **no** se dobla `tag-events.ts`: el criterio es que
la API dispare lo mismo que el panel, así que corre el escritor real y lo único
doblado es la frontera observable (`runAutomationsForTrigger` y
`emitWebhookEvent`). Doblar `addContactTagAndDispatch` habría dejado pasar una
ruta que escribiera la fila a mano sin disparar nada.

## Verificación contra base real

`progress/checks_tags-v1.sql`, ejecutado contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh <worktree>`, las 62 migraciones aplicadas
y `verify-schema.sql` OK; luego el archivo por `psql -v ON_ERROR_STOP=1`).
Salida: cuatro `NOTICE OK` y ningún `ERROR`.

- **A.** `contact_tags.tag_id → tags(id) ON DELETE CASCADE` (migración 001):
  borrar la etiqueta se lleva sus uniones y no toca el contacto ni el resto del
  catálogo. Es lo que sostiene la promesa de `DELETE /api/v1/tags/{id}` («quita
  también sus `contact_tags`») sin una segunda consulta en la ruta — y lo único
  que la hace atómica.
- **B.** `UNIQUE (contact_id, tag_id)`: el 23505 del que vive
  `addContactTagIfAbsent`, que no lee antes de insertar. Sin él habría dos filas
  y dos `contact.tag_added` por la misma etiqueta.
- **C.** `DELETE … RETURNING id` devuelve 1 fila la primera vez y 0 la segunda:
  es el `.select('id')` que añade esta feature y de esa diferencia cuelga que
  salga o no `contact.tag_removed`.
- **D.** La base **no** impide `vip` y `VIP` en la misma cuenta: la unicidad por
  nombre es regla de aplicación (`findOrCreateTag` + el 409 del PATCH), no
  restricción. Queda escrito por si algún día se añade el índice único.

No se tocó ningún `.sql` del repo, así que no hay migración nueva ni aserción
nueva en `supabase/ci/verify-schema.sql`. El replay se corrió igualmente y
terminó en 0.

## Verificaciones manuales pendientes

Ninguna. Nada de esta feature depende de un servicio externo: no habla con Meta
ni con PayPal, y el único efecto observable fuera del proceso —el webhook
saliente— se comprueba en el emisor, que a7.4 ya cubre de punta a punta.

## Compuerta

Los cuatro comandos, en primer plano y por separado, en el worktree:

| Comando                | Resultado                                                 |
| ---------------------- | --------------------------------------------------------- |
| `npm run lint`         | 0 errores (35 warnings preexistentes, ninguno en lo tocado) |
| `npm run typecheck`    | limpio                                                     |
| `TZ=UTC npm test`      | 174 archivos, **2285 tests**, todos en verde                |
| `npm run build`        | compila; las seis rutas nuevas salen en el manifiesto (`/api/v1/tags`, `/api/v1/tags/[id]`, `/api/v1/contacts/[id]/tags`, `/api/v1/contacts/[id]/tags/[tagId]`) |

Más `scripts/replay-migrations.sh` con salida 0 (arriba).

## Decisiones donde el spec era ambiguo

1. **Comparación de nombres en Node, no con `ilike`.** El spec pide
   «insensible a mayúsculas». Se hace leyendo las etiquetas de la cuenta y
   comparando `name.trim().toLowerCase()`, no con `.ilike('name', name)`:
   `ilike` recibe un **patrón**, así que una etiqueta llamada `50%` o `a_b`
   casaría con filas que no le tocan, y PostgREST no ofrece cláusula `ESCAPE`
   para arreglarlo. El catálogo de etiquetas es de clase «ajustes» (un puñado de
   filas por cuenta), así que leerlo entero es barato. El `?search=` del listado
   sí usa `ilike`, pero sobre un término saneado (se cae todo lo que no sea
   letra, número o `+@.-`), igual que hace `GET /api/v1/contacts`.
2. **Tope de 64 caracteres para el nombre** (`MAX_TAG_NAME_LENGTH`). El spec no
   fija ninguno y la columna es `TEXT`. El tope de 1 MiB del cuerpo ya frena el
   caso absurdo; este frena el meramente inservible (la etiqueta se pinta como
   píldora junto al contacto). Se devuelve `bad_request` nombrando el campo.
3. **Color validado como hexadecimal** (`#rgb` o `#rrggbb`, guardado en
   minúsculas). El spec solo dice `color?`. El valor se interpola en estilos en
   línea por todo el panel, así que no se guarda como texto libre.
4. **Repetir un nombre no repinta.** `POST /tags` con un nombre existente
   devuelve 200 con la etiqueta tal cual, ignorando el `color` enviado: quien
   repite un nombre está nombrando, no pintando. Para cambiar el color está el
   PATCH.
5. **Renombrar sobre un nombre ya usado es 409, no un merge.** Fusionar dos
   etiquetas (mover sus uniones y borrar una) es una operación destructiva que el
   spec no pide; el 409 deja la decisión en el llamante. Cambiar solo la caja del
   propio nombre sí se permite.
6. **Tope de 50 ids por llamada en `POST /contacts/{id}/tags`.** Cada id es una
   verificación de propiedad + inserción + despacho de automatizaciones, así que
   una lista sin tope es un handler sin tope. No está en el spec.
7. **`DELETE /contacts/{id}/tags/{tagId}` es idempotente**: quitar una etiqueta
   que el contacto no lleva es 200 con el contacto intacto, no 404. El llamante
   pidió un estado y ese estado se cumple. Lo que no es, es un evento.
8. **La ruta del panel `DELETE /api/contacts/{id}/tags` ahora devuelve
   `removed`** en el cuerpo (`{ok:true, removed:false, reason:'absent'}`). Es
   aditivo —nada del panel lee ese campo— y evita que la respuesta mienta sobre
   si hubo cambio, que es exactamente lo que decide el webhook.
9. **Reutilización de `resolveAuditUserId`** (de `src/lib/api/v1/contacts.ts`)
   para `tags.user_id`, que es `NOT NULL REFERENCES auth.users`. Una llamada de
   API no tiene usuario conectado; se atribuye al dueño de la configuración de
   WhatsApp y, si no hay, al dueño de la cuenta — la misma convención que ya usa
   la creación de contactos por API.

## Variables de entorno nuevas

Ninguna. `docs/docker.md` no cambia. `.env.local.example` está bloqueado por
permisos y no se tocó (tampoco haría falta).

## Traducciones

Sin textos de interfaz nuevos, así que `messages/{es,en,ko}.json` no cambian. Las
descripciones de los dos scopes nuevos viven en `SCOPE_DESCRIPTIONS`
(`src/lib/api-keys/scopes.ts`), en inglés, porque es de ahí de donde el panel
las pinta hoy para los siete scopes que ya existían — ver deuda 1.

## Deuda detectada fuera de alcance (no arreglada)

1. **Los nombres de scope del panel no pasan por i18n.**
   `src/components/settings/api-keys-settings.tsx` pinta
   `SCOPE_DESCRIPTIONS[scope]` directamente, así que la lista de permisos al
   crear una clave está en inglés en los tres idiomas. Es anterior a esta
   feature (afectaba ya a los siete scopes); los dos nuevos siguen la convención
   existente en vez de introducir una segunda. Arreglarlo es mover las siete —
   ahora nueve— cadenas a los tres catálogos con clave por scope, y toca un
   componente que no es de esta feature.
2. **No hay índice único sobre `(account_id, lower(name))` en `tags`.** La
   unicidad por nombre la sostiene solo la aplicación (`findOrCreateTag` y el 409
   del PATCH), así que dos `POST /tags` simultáneos con el mismo nombre pueden
   crear dos filas. La ventana es estrecha y el daño es cosmético (dos píldoras
   iguales, que el panel ya permite crear hoy), pero la cura real es una
   migración con índice único funcional + tratamiento del 23505 como
   find-or-create — migración que el spec de esta feature excluye
   explícitamente («sin migración»). El comportamiento de la base queda
   documentado en `checks_tags-v1.sql`, bloque D.
3. **`contact_tags` no tiene `account_id` propio.** La acotación es por
   `contact_id`, verificado antes contra la cuenta (`assertContactAndTagOwnership`).
   La auditoría de la suite de aislamiento lo da por bueno vía `CHILD_TABLES`,
   igual que `messages` o `broadcast_recipients`. Es coherente con el resto del
   esquema; se anota porque significa que una consulta futura a `contact_tags`
   que no pase por ese verificador no tendría red.

## Estado

Implementación y compuerta completas. **No marco `done`**: queda a la espera del
reviewer.
