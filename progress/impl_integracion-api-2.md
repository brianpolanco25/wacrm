# Integración 2 de la fase 7 — `api/templates` dentro de `api/recursos` + deudas de a7.2

Worktree `.claude/worktrees/api-recursos`, rama `api/recursos`, base común `6b0d768`
(= `feat/api-publica`). No es una feature de `feature_list.json`.

## Commits

| Commit | Qué |
| --- | --- |
| `0fec43b` | `merge: integrar las plantillas de la API pública en api/recursos` — une `api/templates` @ `80e0e9d` |
| `4327aa4` | `feat: un nombre de etiqueta por cuenta, impuesto por la base` — deudas 1, 2 y 3 de `progress/review_tags-v1.md` |

Estado de ramas al terminar:

- `api/recursos` @ `4327aa4`
- `feat/api-publica` @ `4327aa4` (**`git merge --ff-only api/recursos` en
  `.claude/worktrees/api-publica`: salió 0**, avance limpio desde `6b0d768`)
- `api/templates` @ `80e0e9d`, `api/webhooks` @ `170d73e`, `api/exports` @ `8ed0ecc`, `main` @
  `3b82698`: intactas. Nada pusheado.

## 1. El merge: conflictos y resolución

Cinco archivos tocados por las dos mitades de la fase. `src/lib/rate-limit.ts` **fusionó solo**
(el cubo `templatesSync` no roza nada de etiquetas). Los otros cuatro dieron conflicto, todos de
yuxtaposición —las dos ramas añadieron al final de la misma lista—, así que en los cuatro se
conservan **ambos lados** y no se descartó ni un test:

| Archivo | Conflicto | Resolución |
| --- | --- | --- |
| `src/lib/api-keys/scopes.ts` | `API_SCOPES` y `SCOPE_DESCRIPTIONS` | Los cuatro scopes nuevos y sus cuatro descripciones, en orden `tags:*` → `templates:*` |
| `CHANGELOG.md` | Dos entradas de a7.2 contra dos de a7.3 en Unreleased | Las cuatro, en ese orden |
| `docs/public-api.md` | Tabla de scopes + las secciones nuevas (ambas ramas insertaron tras `GET /broadcasts/{id}`) + el párrafo Roadmap | Reconstruido con las tres versiones (`git show :1/:2/:3`) en vez de a mano sobre los marcadores: tabla con las cuatro filas, secciones de etiquetas y luego las de plantillas, Roadmap citando ambas. 21 secciones `###`, ninguna perdida |
| `src/lib/security/tenant-isolation.test.ts` | Los imports de rutas y los dos bloques de fuga al final | Los siete imports bajo un comentario único y los dos `describe` completos (`/api/v1/tags` y `/api/v1/templates`) |

Comprobación de que no se perdió nada: `npm test` tras el merge dio **178 archivos / 2333
tests**, exactamente la suma de las dos ramas.

## 2. Deudas de `progress/review_tags-v1.md` cerradas

### Hallazgo 2 — carrera de doble inserción (migración + 23505 como find-or-create)

`supabase/migrations/064_tags_unique_name.sql` (**064**, no 063: la 063 vive en `api/exports`,
en paralelo, y esta no depende de ella — el replay corre 001–062 + 064 y pasa).

- Índice único funcional `tags_account_lower_name_idx ON tags (account_id, lower(name))`,
  `IF NOT EXISTS`.
- **Antes** de crearlo, un bloque `DO` fusiona los homónimos que ya existan, porque en una base
  con un `Moroso`/`moroso` dentro el `CREATE UNIQUE INDEX` fallaría y dejaría la migración —y el
  despliegue— a medias. Regla: superviviente la fila **más antigua** (`created_at ASC NULLS
  LAST, id`), sus `contact_tags` se mudan con `INSERT … ON CONFLICT (contact_id, tag_id) DO
  NOTHING` conservando el `created_at` más antiguo de la unión, y solo entonces se borran las
  demás.
- Aserción en `supabase/ci/verify-schema.sql`: el índice existe, es `indisunique` y su `indexdef`
  contiene `lower(name)` (sin la expresión, «Moroso» y «moroso» volverían a convivir).

En `src/lib/api/v1/tags.ts`, `findOrCreateTag` trata el `23505` del INSERT como find-or-create:
relee y devuelve la fila ganadora con `created: false` (→ 200). Si la relectura no la alcanza
—solo posible con un catálogo más largo que el límite de lectura— lanza `TagError` 409 en vez de
reintentar el INSERT, que volvería a chocar. `POST /api/v1/tags` publica ese 409 como código
`conflict` (antes su `catch` lo habría llamado `internal`), y `PATCH /api/v1/tags/{id}` mapea
también el `23505` del UPDATE a `conflict` 409, misma respuesta que ya daba su comprobación
previa.

### Hallazgo 3 — `findTagByName` sin `.limit()`

`.limit(TAG_ROSTER_SCAN_LIMIT)` (1000) explícito y exportado. Sin él mandaba el `db-max-rows` de
PostgREST en silencio; ahora el techo es visible y, pasado, el índice atrapa lo que se escape.

### Hallazgo 1 — lote de etiquetas aplicado a medias

`src/app/api/v1/contacts/[id]/tags/route.ts` resuelve los ≤50 ids en **una** consulta
(`.select('id').eq('account_id', …).in('id', tagIds).limit(50)`) antes de la primera escritura.
Un id ajeno o inexistente responde 404 sin atar nada ni emitir ningún `contact.tag_added`. El
error no dice **cuál** id falló, a propósito: distinguir «no existe» de «es de otra cuenta»
confirmaría un id ajeno.

El test que prometía «no escribe ni dispara nada» ya era cierto en su caso (un único id ajeno);
lo que faltaba era el caso mixto, y está añadido.

### El panel (comprobado, como pedía el encargo)

`src/components/settings/tag-manager.tsx` inserta directo contra Supabase desde el navegador y
**sí** permitía duplicados por caja; con el índice recibe 23505. Manejo mínimo: se reconoce el
código (`isDuplicateTagNameError`, extraído para poder probarlo — no hay jsdom en el repo) y se
muestra `tagAlreadyExists`, clave nueva en **es/en/ko**. El genérico «no se pudo crear» seguía
siendo falso y encima invitaba a reintentar.

### Fuera del encargo pero consecuencia directa del índice

`src/lib/contacts/resolve-import-tags.ts` (importación de CSV) crea las etiquetas que faltan en
**un solo INSERT**: con el índice, un choque aborta el lote entero y la importación moría por una
etiqueta que ya existe. Ahora, ante 23505, relee el catálogo, resuelve lo que haya y reporta como
omitido lo que nadie llegó a crear. Cualquier otro error sigue propagándose. Lo anoto aquí
porque el encargo solo mencionaba el panel: si se prefiere revertirlo, es un cambio aislado
(`resolve-import-tags.ts` + su test).

## 3. Criterio ↔ test

| Qué | Archivo | `it` |
| --- | --- | --- |
| 23505 → find-or-create (200 con la fila ganadora) | `src/lib/api/v1/tags.test.ts` | «trata el 23505 del INSERT como find-or-create: relee y devuelve la existente» |
| Sin bucle de reintentos: 409 honesto | id. | «si tras el 23505 la relectura no ve la fila, responde 409 en vez de insistir» |
| Otros errores siguen siendo 500 | id. | «cualquier otro error del INSERT sigue siendo un 500» |
| Alta normal intacta | id. | «crea la etiqueta cuando nadie la tiene» |
| `.limit()` explícito y acotado por cuenta | id. | «acota la lectura con un .limit() explícito y por cuenta» |
| El 409 sale como `conflict`, no `internal` | `src/app/api/v1/tags/route.test.ts` | «un choque irrecuperable con el índice único sale como conflict 409, no como internal» |
| Lote mixto no ata nada | `src/app/api/v1/contacts/[id]/tags/route.test.ts` | «una lista mixta no ata NADA: el 404 llega antes de la primera escritura» |
| Id inexistente tampoco | id. | «un id que no existe en ninguna cuenta tampoco ata las etiquetas buenas que iban delante» |
| Una sola consulta de resolución, acotada | id. | «resuelve los ids en UNA consulta acotada por cuenta, no una por id» |
| Panel: 23505 → «ya existe» | `src/components/settings/tag-manager.test.tsx` | «reconoce el 23505 del índice único como "ya existe"», «no confunde otros fallos con un duplicado» |
| Mensaje en los tres catálogos | id. | «tiene el mensaje en los tres catálogos (CP6)» |
| Importación: 23505 no la tumba | `src/lib/contacts/resolve-import-tags.test.ts` | «un 23505 del lote no tumba la importación: relee y resuelve con lo que hay» (+ los otros dos `it`) |

Los tests que no pueden vivir en vitest (fusión de duplicados, cascadas, el 23505 de verdad) van
contra Postgres real, abajo.

## 4. Verificaciones contra base real

`progress/checks_integracion-api-2.sql` (nuevo). Tira el índice para recrear una base **como las
que ya están en producción**, siembra tres homónimas (`Moroso` 2026-01, `moroso` 2026-02,
`MOROSO` 2026-03, en desorden de inserción), dos contactos —uno con la superviviente **y** una
duplicada, para forzar el choque con `UNIQUE(contact_id, tag_id)`—, una etiqueta sin homónimo, y
referencias por id en `automations.trigger_config`, `automation_steps.step_config` y
`flow_nodes.config`. Luego ejecuta la migración **tal cual está en el repo** (`\i`, con la
migración copiada al contenedor con `docker cp`: así el check no duplica el SQL y no puede
desviarse de él).

Resultado, ejecutado por mí: cinco `NOTICE OK`, ningún `ERROR`, salida 0.

- **A** — tres homónimas → una, y es la más antigua (`Moroso`); la etiqueta sin homónimo sigue ahí.
- **B** — cada contacto queda con exactamente una unión, ninguna huérfana, y la unión mudada
  conserva su fecha original.
- **C** — disparador, paso y nodo de flujo apuntan al superviviente (si no, un «se añadió la
  etiqueta X» quedaría mirando a una fila borrada: la FK no protege ids dentro de un `jsonb`).
- **D** — ya con el índice, un cuarto «MoRoSo» es `unique_violation`, y otra cuenta sí puede
  llamar igual a la suya.
- **E** — re-ejecutar la migración entera no falla ni cambia nada (idempotencia).

`progress/checks_tags-v1.sql`: **re-ejecutado, y su bloque D reescrito**. Ese bloque afirmaba que
la base *no* impide homónimos y dejaba escrito «si algún día se añade un índice único sobre
(account_id, lower(name)), este bloque es el que hay que cambiar». Ese día es hoy: ahora afirma
lo contrario (el INSERT homónimo es `unique_violation` y queda una sola fila). Cuatro `NOTICE OK`,
salida 0.

`progress/checks_templates-v1.sql` **no existe** (a7.3 no dejó SQL de comprobación: no toca
esquema). Corrí en su lugar `progress/checks_api-hardening.sql`, que sí existe y comparte base:
siete `NOTICE OK`, salida 0.

## 5. Compuerta

Cada comando en primer plano, por separado, en el worktree:

| Comando | Resultado |
| --- | --- |
| `npm run lint` | verde — 0 errores, 35 warnings (todos preexistentes; el que introduje lo quité) |
| `npm run typecheck` | verde, sin salida |
| `TZ=UTC npm test` | verde — **181 archivos, 2348 tests, 0 fallos** (178/2333 tras el merge, +3 archivos y +15 tests por las deudas) |
| `npm run build` | verde con las variables dummy de `docs/harness.md`; las cinco rutas nuevas de ambas mitades salen en `.next/routes-manifest.json` (`/api/v1/tags`, `/api/v1/tags/[id]`, `/api/v1/templates`, `/api/v1/templates/[id]`, `/api/v1/templates/sync`) |
| `scripts/replay-migrations.sh "$(pwd)"` | **salida 0**, 001–062 + **064**, `verify-schema.sql: OK` |

## 6. Decisiones donde el encargo o el spec dejaban margen

1. **`lower(name)`, no `lower(trim(name))`.** Todas las escrituras del repo ya guardan el nombre
   recortado y el índice sobre una expresión solo se usa si la consulta escribe esa misma
   expresión; `lower(name)` es la forma que ya usa `tagKey`.
2. **Filas con `account_id` nulo** (la columna quedó nullable en 017) se saltan en la fusión: en
   un índice único NULL nunca colisiona con NULL, así que no hay nada que fusionar.
3. **Reapuntar las referencias en `jsonb`** (automatizaciones, pasos, flujos, nodos) no estaba
   en el encargo, que solo pedía mover `contact_tags`. Lo añadí porque un `tag_id` dentro de un
   `jsonb` no lo protege ninguna FK: borrar la duplicada dejaría un disparador o un paso mirando
   a una fila inexistente, y eso falla **en silencio**. Está cubierto por el bloque C del check.
4. **El 409 de `findOrCreateTag`** (relectura fallida) en vez de un bucle de reintentos: un
   reintento chocaría igual, y un 500 invitaría al cliente a insistir.
5. **El 404 del lote no dice qué id falló**: nombrarlo confirmaría la existencia de un id ajeno.
6. **`isDuplicateTagNameError` exportado** del componente del panel: no hay jsdom ni
   testing-library en el repo y no se añaden dependencias, así que esa rama solo es comprobable
   como función.

## 7. Variables de entorno y documentación

- **Ninguna variable de entorno nueva** → `docs/docker.md` sin cambios y `docs/security.md`
  tampoco. `.env.local.example` está bloqueado por permisos: **no se ha tocado** y no hacía falta.
- `CHANGELOG.md` (Unreleased): entrada nueva «One tag per name, enforced by the database» con su
  nota de migración (`064`, y que la fusión de duplicados es automática), además de las cuatro
  entradas que venían del merge.
- `docs/public-api.md`: `POST /api/v1/tags` documenta que la unicidad la impone la base y qué
  pasa al perder la carrera; `POST /api/v1/contacts/{id}/tags` documenta el **todo o nada**.

## 8. Deuda abierta (detectada, no arreglada)

1. **`review_tags-v1.md` hallazgo 4** — `src/lib/automations/engine.ts:583-589` descarta el
   `error` del DELETE, así que un borrado fallido se registra `success`. Preexistente, sigue ahí.
2. **`review_tags-v1.md` hallazgos 5 y 6** — la asimetría `PATCH {"color": null}` → 400 frente a
   `POST {"color": null}` → color por defecto, y la viñeta del CHANGELOG que prettier parte a
   columna 0. Ambos cosméticos, sin tocar.
3. **El gestor de etiquetas del panel lista filtrando por `user_id`**
   (`tag-manager.tsx:fetchTags`), no solo por cuenta: una etiqueta creada por un compañero es
   invisible ahí, y desde hoy además colisiona. El mensaje nuevo explica el porqué, pero el
   agente no puede ver ni editar la etiqueta que le estorba. Arreglarlo es cambiar el alcance de
   esa lista —decisión de producto— y queda fuera de esta integración.
4. **`docs/public-api.md` crecerá hasta desaparecer**: el spec (S-A5) lo convierte en un puntero
   a `/developers` en a7.6. Todo lo que se añada aquí hasta entonces habrá que mudarlo.
5. **`api/exports` trae la migración 063** en paralelo. 064 no depende de ella y el replay lo
   confirma, pero quien integre esa rama debe correr el replay con las dos juntas.
