# Review — a7.2 tags-v1

**Veredicto:** APPROVED

Rama `api/recursos`, worktree `.claude/worktrees/api-recursos`, base `6b0d768`.
Commits revisados: `9530f4f`, `9de4cc4`, `9b6e6a9` (19 archivos, +1955/−23).
El diff coincide con lo que declara `progress/impl_tags-v1.md`, incluida la nota
de continuidad: el WIP rescatado está entero en `9530f4f` y nada de lo que el
informe atribuye a la primera sesión falta en el árbol.

## Compuerta

Ejecutada por mí, en el worktree, cada comando en primer plano y por separado:

| Comando | Resultado |
| --- | --- |
| `npm run lint` | **verde** — 0 errores, 35 warnings (todos preexistentes, ninguno en archivos de la feature) |
| `npm run typecheck` | **verde** — `tsc --noEmit` sin salida |
| `TZ=UTC npm test` | **verde** — 174 archivos, 2285 tests, 0 fallos |
| `npm run build` | **verde** con las variables dummy de `docs/harness.md`; las cuatro rutas nuevas salen en `.next/routes-manifest.json` (`/api/v1/tags`, `/api/v1/tags/[id]`, `/api/v1/contacts/[id]/tags`, `/api/v1/contacts/[id]/tags/[tagId]`) |

- **replay-migrations: n/a** — `git diff 6b0d768..HEAD --stat -- supabase` sale
  vacío: la feature no toca SQL. Lo corrí igualmente para poder ejecutar los
  checks: 001–062 + `verify-schema.sql` **OK**.
- **`progress/checks_tags-v1.sql`: verificado por mí**, no leído del informe.
  `KEEP=1 scripts/replay-migrations.sh <worktree>` y luego el archivo por
  `psql -v ON_ERROR_STOP=1`: salida 0, cuatro `NOTICE OK` (A cascada, B unique,
  C `RETURNING`, D homónimos permitidos) y ningún `ERROR`.

## Trazabilidad criterio ↔ test

Criterios del spec §2. Los `it` los leí; no me limité a comprobar que existan.

**C1 «Tests de las 7 operaciones, incluido fuga».**

- Op 1 `GET /tags`: [x] `src/app/api/v1/tags/route.test.ts` › «lista solo las
  etiquetas de la cuenta, de la más nueva a la más vieja» (afirma el orden y que
  `tag-b`, **homónima**, no sale), «con ?search= devuelve la etiqueta de ESTA
  cuenta, no la homónima de la otra», «pagina por cursor…» (dos páginas reales,
  el cursor de la primera trae la segunda).
- Op 2 `POST /tags`: [x] «crea una etiqueta nueva con 201, acotada a la cuenta»
  (comprueba `account_id` y `user_id` de la fila escrita, y la normalización
  `#ABC → #aabbcc`), «un nombre que ya existe (en otra caja) devuelve 200 con la
  fila existente y no crea otra» (`'  vip  '` → `TAG_A1`, conteo de filas igual,
  color intacto), «el homónimo de la otra cuenta no cuenta como existente»,
  «rechaza un nombre vacío, ausente o demasiado largo sin escribir nada» (4
  cuerpos, conteo de filas sin cambiar), «rechaza un color que no es hexadecimal».
- Op 3 `GET /tags/{id}`: [x] «devuelve la etiqueta propia» (compara el objeto
  completo).
- Op 4 `PATCH /tags/{id}`: [x] «renombra y repinta la etiqueta propia» (afirma la
  fila en la base, no solo la respuesta), «acepta cambiar solo la caja del propio
  nombre», «rechaza con 409 renombrar sobre un nombre que la cuenta ya usa» (y
  que la fila quedó sin tocar), «el nombre que usa la OTRA cuenta no estorba».
- Op 5 `DELETE /tags/{id}`: [x] «borra la etiqueta propia». La otra mitad del
  criterio —«`DELETE` quita también sus `contact_tags`»— **no** la puede probar
  vitest (la hace la FK, no el código) y está donde debe: bloque A de
  `checks_tags-v1.sql`, ejecutado por mí contra Postgres real. Que solo alcance
  `contact_tags` de la propia cuenta se sigue de que la cascada es por `tag_id` y
  el `DELETE` va acotado por `account_id`: una etiqueta ajena nunca entra.
- Op 6 `POST /contacts/{id}/tags`: [x]
  `src/app/api/v1/contacts/[id]/tags/route.test.ts` › «ata las etiquetas y
  devuelve el contacto con ellas», «rechaza un tag_ids que no sea una lista de
  cadenas no vacías» (5 cuerpos), «rechaza más de 50 ids».
- Op 7 `DELETE /contacts/{id}/tags/{tagId}`: [x] «quita la etiqueta, emite
  contact.tag_removed y devuelve el contacto sin ella», «repetido sigue siendo
  200 pero NO vuelve a anunciar una retirada», «una etiqueta que el contacto
  nunca tuvo tampoco emite nada» (y no se llevó la que sí tenía).
- Fuga, etiqueta ajena en GET/PATCH/DELETE: [x] «con el id de otra cuenta
  responde 404, nunca 403 ni la fila» (además afirma que el id de B **no aparece**
  en el cuerpo), «…no toca su fila», «…y la deja donde estaba» (ambos con
  `snapshot(B)` antes/después). Repetido en la suite de aislamiento ›
  «GET/PATCH/DELETE /tags/{id} con el id de B son 404 y no tocan nada suyo», que
  además comprueba el caso positivo para descartar un 404 de ruta rota.
- Fuga al asignar: [x] «con una etiqueta de otra cuenta responde 404 y no escribe
  ni dispara nada», «con un contacto de otra cuenta responde 404 antes de tocar
  ninguna etiqueta», «con una etiqueta de otra cuenta responde 404 y no toca la
  unión», «con un contacto de otra cuenta responde 404». **Ambos ajenos a la vez**:
  `tenant-isolation.test.ts` › «DELETE /contacts/{id}/tags/{tagId} no desetiqueta
  a un contacto de B» (`contact-b` + `tag-b` → 404 con la unión de B intacta).
  En el POST el contacto se resuelve antes que ninguna etiqueta, así que el caso
  «ambos ajenos» cae en el 404 de contacto ya cubierto.
- Fuga del find-or-create: [x] `tenant-isolation.test.ts` › «POST /tags con un
  nombre que solo tiene B crea la etiqueta de A, no reutiliza la de B».

**C2 «asignar una etiqueta por API dispara el mismo evento que el panel».** [x]
`src/app/api/v1/contacts/[id]/tags/route.test.ts` › «dispara el MISMO evento que
el panel: trigger tag_added y contact.tag_added». El test vale porque **no** dobla
`tag-events.ts`: corre `addContactTagAndDispatch` de verdad contra
`fake-supabase.ts` y solo dobla la frontera observable
(`runAutomationsForTrigger`, `emitWebhookEvent`). Una ruta que insertara la fila a
mano fallaría aquí. Confirmado en la suite de aislamiento con
`h.webhookEvents` (`POST /contacts/{id}/tags ata la etiqueta propia y emite el
evento de la cuenta`).

**Deuda de a7.4 (hallazgo 2 de `review_webhooks-durable.md`): cerrada en las
tres capas.** [x]
- Escritor: `src/lib/contacts/tag-write.test.ts` › «devuelve true cuando el DELETE
  alcanzó una fila», «devuelve false cuando la etiqueta no estaba puesta», «pide
  las filas de vuelta en la propia consulta de borrado» (el doble devuelve `data:
  null` si no se llamó `.select()`, que es lo que hace PostgREST: si alguien
  quitara el `.select('id')` el test cae).
- Despachador: `src/lib/contacts/tag-events.test.ts` › «no emite
  contact.tag_removed si el DELETE no quitó ninguna fila», «un segundo DELETE
  seguido solo emite una vez».
- Motor: `src/lib/automations/engine.test.ts` › «emite contact.tag_removed cuando
  el DELETE alcanzó una fila», «no emite nada cuando el contacto no llevaba esa
  etiqueta» (y el paso se registra `success`, no `failed`).
- Ruta del panel: `src/app/api/contacts/[id]/tags/route.test.ts` › «dice que no
  quitó nada cuando la etiqueta no estaba puesta».
- Base real: bloque C de `checks_tags-v1.sql` (`DELETE … RETURNING id` devuelve 1
  y luego 0), verificado por mí.

## Checkpoints

- **CP1 Compuerta**: [x] los cuatro comandos en verde, ejecutados por mí.
- **CP2 Migraciones**: [x] n/a — sin SQL nuevo (`git diff --stat -- supabase`
  vacío). El replay se corrió igualmente: 001–062 + `verify-schema.sql` OK.
- **CP3 Aislamiento**: [x] Revisadas una por una las consultas nuevas con rol de
  servicio: `tags.ts:113` (`findTagByName`), `tags.ts:132-133` (`getTagById`),
  `tags.ts:157-158` (insert con `account_id` en la fila),
  `tags/route.ts:51` (list), `tags/[id]/route.ts:105-106` (update),
  `:140-141` (delete). Todas con `.eq('account_id', …)` o el `account_id` escrito
  en la fila. Las dos rutas de contacto no consultan directas: pasan por
  `getContactById` (acotado) y por `assertContactAndTagOwnership`
  (`tag-write.ts:23-36`, que verifica contacto **y** etiqueta contra la cuenta
  antes de escribir). `contact_tags` no tiene `account_id` y se acota por
  `contact_id`, que es lo que declara `CHILD_TABLES` en
  `service-role-audit.ts:41`. La auditoría de la suite es dinámica (lee el log de
  consultas de `fake-supabase`), así que las seis pruebas nuevas del bloque de
  etiquetas pasan también por ella. Un recurso ajeno responde 404, nunca 403, y
  el id ajeno no viaja en el cuerpo del error.
- **CP4 Tests**: [x] ver trazabilidad. Lo que exige base real está en
  `progress/checks_tags-v1.sql` y lo ejecuté.
- **CP5 Sin dependencias nuevas**: [x] `package.json` y `package-lock.json` sin
  cambios.
- **CP6 i18n**: [x] n/a — `messages/` sin cambios. No hay texto de interfaz
  nuevo; `SCOPE_DESCRIPTIONS` sigue la convención en inglés que ya tenían los
  siete scopes anteriores, y el informe lo anota como deuda 1 en vez de
  arreglarlo (correcto por CP8).
- **CP7 Next 16**: [x] la firma `{ params }: { params: Promise<{ id: string }> }`
  de las tres rutas dinámicas está comprobada contra
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:85-91`,
  no de memoria.
- **CP8 Alcance**: [x] Los cinco archivos fuera de `/api/v1/tags*`
  (`tag-write.ts`, `tag-events.ts`, `engine.ts`, la ruta del panel y `scopes.ts`)
  los justifica el encargo explícito de cerrar el hallazgo 2 de a7.4 y S-A4. Tres
  deudas detectadas y **no** arregladas, correctamente anotadas en el informe.
  Los cambios en `scopes.ts`, `CHANGELOG.md`, `docs/public-api.md` y
  `tenant-isolation.test.ts` van al final de sus listas para no chocar con
  `api/templates`, que crece en paralelo por los mismos archivos.
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) con las dos entradas,
  `docs/public-api.md` con las cinco secciones y los dos scopes, informe presente
  y fiel al diff. Sin variables de entorno nuevas, así que `docs/docker.md` no
  cambia.
- **CP10 Git**: [x] tres commits en `api/recursos`, en español, con prefijo
  (`feat:`/`test:`/`docs:`) y `Co-Authored-By`. Worktree limpio, nada pusheado,
  `main` @ 3b82698 y `feat/api-publica` @ 6b0d768 intactos.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a — la feature no toca el webhook
  de WhatsApp ni la capa de facturación.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Por orden de importancia:

1. `src/app/api/v1/contacts/[id]/tags/route.ts:79-86` — **la asignación por lotes
   se aplica a medias**. El bucle ata id por id; si el tercero es ajeno (o no
   existe), `addContactTagAndDispatch` lanza `ContactTagWriteError` y la ruta
   responde 404 **después** de haber atado los dos primeros y emitido sus
   `contact.tag_added`. El cuerpo del 404 no dice cuáles entraron. No es fuga (la
   etiqueta ajena nunca se ata) y el spec no pide atomicidad, pero la promesa que
   sugiere el test «no escribe ni dispara nada» solo se cumple cuando **todos** los
   ids de la lista son ajenos. Cura barata para una feature futura: resolver los
   ≤50 ids en una sola consulta acotada antes de la primera escritura, o
   documentar el comportamiento parcial en `docs/public-api.md`.
2. `src/lib/api/v1/tags.ts:105-121` + `:152-153` — **carrera de doble inserción en
   el find-or-create**, tal y como el informe declara en su deuda 2. Lo comprobé
   en el esquema: `001_initial_schema.sql:58-64` crea `tags` sin restricción única
   y `017_account_sharing.sql:296` solo añade `idx_tags_account`; no hay índice
   sobre `(account_id, lower(name))`. El bloque D de `checks_tags-v1.sql` lo
   confirma contra Postgres real (dos filas `moroso`/`Moroso` conviven). Con
   read-then-insert y sin índice, dos `POST /tags` simultáneos con el mismo nombre
   crean dos filas; `Idempotency-Key` tapa el reintento del mismo cliente, no la
   concurrencia real. El daño es cosmético (dos píldoras iguales, que el panel ya
   permite crear hoy) y la cura pide migración, que esta feature excluye por spec.
   Queda como deuda **con dueño**: el índice único funcional + tratar el 23505
   como find-or-create debería entrar con la próxima migración de la fase (063).
3. `src/lib/api/v1/tags.ts:110-113` — `findTagByName` lee el catálogo entero sin
   `.limit()`. La suposición «un puñado de filas por cuenta» es razonable y está
   escrita en el comentario, pero si una cuenta superara el `db-max-rows` de
   PostgREST (1000 por defecto) el find-or-create dejaría de ver etiquetas
   existentes y empezaría a duplicar en silencio. Un `.limit()` explícito haría
   visible el techo.
4. `src/lib/automations/engine.ts:583-589` — el `error` del DELETE se descarta
   (`const { data: deleted }`), así que un borrado fallido se lee como «la
   etiqueta no estaba» y el paso se registra `success`. Es **preexistente** (el
   código anterior tampoco lo miraba) y el cambio no lo empeora; lo anoto porque
   ahora esa rama tiene un `return` con mensaje que afirma algo que puede ser
   falso.
5. `src/app/api/v1/tags/[id]/route.ts:84-94` — asimetría menor: `PATCH` con
   `{"color": null}` es 400, mientras que `POST` con `{"color": null}` cae al
   color por defecto. Coherente con lo que documenta `docs/public-api.md`
   («must be a hex colour»); solo lo dejo escrito.
6. `CHANGELOG.md:446-447` — el `` `DELETE /api/v1/contacts/{id}/tags/{tagId}` ``
   parte a columna 0 y rompe la sangría de la viñeta en el fuente. Es prettier
   partiendo un span que no puede partir; renderiza bien como continuación
   perezosa. Cosmético.

## Cambios requeridos

Ninguno.
