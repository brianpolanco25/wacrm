# Review — a7.1 api-hardening

**Veredicto:** CHANGES_REQUESTED

Rama `api/recursos` @ c6089f2, base `feat/api-publica` (= `main` @ 3b82698).
Commits revisados: a8118d2, 00ae028, c6089f2. Diff: 26 archivos, +3049/−268.
Coincide con lo que declara `progress/impl_api-hardening.md` (incluido que
`src/lib/api/v1/conversations.test.ts` no está en el diff).

## Compuerta

Ejecutada por mí, paso a paso, en el worktree:

| Paso | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 35 avisos, todos preexistentes |
| `npm run typecheck` | **verde** |
| `TZ=UTC npm test` | **verde** — 159 archivos, 2 127 tests |
| `npm run build` (variables dummy de `docs/harness.md`) | **verde** |
| `scripts/replay-migrations.sh "$(pwd)"` | **verde** — `EXIT=0`, 001→061 y `verify-schema.sql: OK` |
| `progress/checks_api-hardening.sql` (KEEP=1 + `docker exec … psql -v ON_ERROR_STOP=1`) | **verde** — los 7 bloques, `EXIT=0` |

Ningún fallo se debe al cambio. Lo que sigue es de revisión de código, no de la compuerta.

## Trazabilidad criterio ↔ test

- **C1** «dos POST iguales con la misma `Idempotency-Key` → un solo mensaje y la 2.ª lleva
  `Idempotent-Replayed`; cuerpo distinto → 409; otra clave de API no ve la respuesta ajena»:
  [x] `src/app/api/v1/messages/route.test.ts` › "two identical POSTs send ONE message and the
  second is flagged as replayed" (cuenta `h.sends`, es decir el núcleo de envío, no el helper),
  › "the same key with a different body is 409 idempotency_mismatch",
  › "another API key reusing the same Idempotency-Key does NOT see the other response".
  [x] `src/lib/api/v1/idempotency.test.ts` › "same key and same body…", › "same key, different
  body…", › "another API KEY…", › "a concurrent retry gets 409 conflict instead of doing the
  work twice" (espera a que la reserva aterrice antes de lanzar la segunda: reproduce la carrera
  de verdad, no un orden de microtareas). El doble `FakeIdempotencyStore` implementa el índice
  único y devuelve `23505`, así que la arbitración que se prueba es la misma que la de Postgres.
  Fuga entre **cuentas**: [x] `src/lib/security/tenant-isolation.test.ts` › "la idempotencia de
  la fase 7 §1 no cruza cuentas…", respaldada por la auditoría de `afterEach`
  (`unscopedServiceRoleQueries`) — `api_idempotency_keys` no tiene waiver, así que si alguien
  quita un `.eq('account_id', …)` la suite cae.
- **C2** «cuerpo de 1 MiB + 1 → 413; `text/plain` → 415»:
  [x] en `POST /api/v1/messages` — `route.test.ts` › "refuses a body of 1 MiB + 1 with 413 and
  never reaches the send core" (construye 1 048 577 bytes reales y comprueba `h.sends` vacío) y
  › "refuses text/plain with 415". `src/lib/api/v1/body.test.ts` prueba además el borde exacto
  (1 MiB entra) y el caso que importa, "refuses an oversized STREAMED body, with no
  Content-Length to go by": 17 trozos de 64 KiB por un `ReadableStream`, o sea el tope se aplica
  **durante** la lectura y no a partir de una cabecera declarada.
  [ ] **Como regla transversal, no.** Ver hallazgo 1: cuatro escrituras de `/api/v1` siguen
  leyendo el cuerpo con `request.json()` y no tienen ni tope ni `Content-Type`.
- **C3** «rotar deja dos claves activas 24 h y la vieja deja de autenticar después»:
  [x] `src/app/api/account/api-keys/[id]/rotate/route.test.ts` › "leaves BOTH keys
  authenticating for 24 h, then only the new one". El test no mira una bandera de UI: llama al
  `findActiveKeyByHash` real a 0 h, 23 h y 25 h. › "stamps the old key exactly 24 h out",
  › "rotating twice does not push the old key's deadline further out", › "a key already revoked
  for good is a 404", › "another account's key id is a 404 and nothing is created".
  El corte de la gracia: [x] `src/app/api/account/api-keys/[id]/route.test.ts` › "cuts short a
  rotation grace window instead of answering 404" (el doble parsea de verdad el `or(...)`).
- **C4** «replay verde con aserción en `verify-schema.sql`»: [x] verificado por mí (arriba). El
  bloque «061» de `supabase/ci/verify-schema.sql` afirma tabla, índice único, índice por
  `expires_at`, RLS habilitada, **cero políticas** y `account_id NOT NULL`.
- **Transversal** «`X-Request-Id`, `Cache-Control: no-store` y `request_id` en toda respuesta de
  `/api/v1`»: [x] `src/lib/api/v1/respond.test.ts` (6 `it`) y `messages/route.test.ts` ›
  "carries X-Request-Id and Cache-Control: no-store on success" / "puts request_id in the error
  envelope…". Comprobado además que ninguna ruta de `src/app/api/v1/**` construye un
  `NextResponse`/`Response` por su cuenta: las 11 pasan por `respond.ts`. El id lo acuña
  `v1Headers()` con `randomUUID()` y **nunca** se lee de la petición (`respond.ts:50-63`).

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí.
- **CP2 Migraciones**: [x] `061_api_idempotency.sql` idempotente (`CREATE TABLE/INDEX IF NOT
  EXISTS`), aserciones por objeto en `verify-schema.sql`, replay 0. Los dos `ON DELETE CASCADE`
  (`accounts`, `api_keys`) solo alcanzan filas efímeras de 24 h que describen respuestas ya
  entregadas; el bloque 6 del SQL lo comprueba. Aceptable.
- **CP3 Aislamiento**: [x] las cinco consultas de `idempotency.ts` (reserve, findRow, delete de
  caducada, release, update de respuesta) llevan `.eq('account_id', ctx.accountId)`; la purga
  también (`idempotency.ts:120-134`). La auditoría de la suite de aislamiento lo fija.
  `rotate/route.ts` usa el cliente RLS de `requireRole('admin')` y aun así filtra por
  `account_id` en lectura, alta, sellado y compensación.
- **CP4 Tests**: [x] con la salvedad de C2 (hallazgo 1). SQL real en
  `progress/checks_api-hardening.sql`, corrido por mí.
- **CP5 Sin dependencias**: [x] `package.json`/`package-lock.json` sin cambios.
- **CP6 i18n**: [x] 15 claves nuevas en `Settings.apiKeys`, presentes en `es`, `en` y `ko` con
  los mismos placeholders ICU (`{date}`, `{days}`, `{name}`) y la misma etiqueta rica `<docs>`.
  Recuento por catálogo: 1 707 claves en los tres, diferencia simétrica vacía.
- **CP7 Next 16**: [x] `{ params: Promise<{ id: string }> }` contrastado con
  `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md` («`params`:
  a promise that resolves to…»). No se usa ninguna API de framework nueva.
- **CP8 Alcance**: [x] todo lo tocado lo justifica §1. `docs/public-api.md` entra por la
  documentación del contrato nuevo.
- **CP9 Documentación**: [x] `CHANGELOG.md` (Unreleased) con nota de migración; sin variables de
  entorno nuevas, así que `docs/docker.md` no se toca; el informe coincide con el diff.
  **Pero** ver hallazgo 1: el CHANGELOG y `docs/public-api.md` afirman de las escrituras algo que
  solo es cierto en dos de ellas.
- **CP10 Git**: [x] 3 commits en `api/recursos`, en español, con `Co-Authored-By`; nada pusheado;
  `main` @ 3b82698 y `feat/saas-multiempresa` @ 4756a47 intactos; worktree limpio.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a — no se toca el webhook de WhatsApp.

## Hallazgos (archivo:línea)

1. **El tope de 1 MiB y el `Content-Type` obligatorio no llegan a cuatro escrituras de `/api/v1`,
   y la documentación dice que sí.** Siguen leyendo el cuerpo con `request.json()`:
   - `src/app/api/v1/contacts/route.ts:100` (POST)
   - `src/app/api/v1/contacts/[id]/route.ts:43` (PATCH)
   - `src/app/api/v1/webhooks/route.ts:58` (POST)
   - `src/app/api/v1/webhooks/[id]/route.ts:54` (PATCH)

   `await request.json()` almacena el cuerpo entero antes de que nadie pueda objetar: un POST a
   `/api/v1/contacts` con 500 MB se bufferiza completo. Es exactamente el fallo que
   `readCappedText` existe para evitar, y la feature se llama «endurecer la capa común».
   La spec lo pide dos veces: §1 («Tope de cuerpo (1 MiB) y `Content-Type` en `requireApiKey` o
   en un helper `readJsonBody`») y «Seguridad transversal» («Cuerpos JSON con tope de 1 MiB y
   `Content-Type: application/json` obligatorio **en escrituras**»).
   Agrava el hallazgo que el contrato publicado ya lo promete:
   - `docs/public-api.md:109-111` — «Writes must send `Content-Type: application/json` (`415`
     otherwise) … Bodies are capped at **1 MiB** (`413`)». Falso para esas cuatro rutas.
   - `CHANGELOG.md`, sección Security — «Writes to `/api/v1` require `Content-Type:
     application/json` and are capped at 1 MiB». Igual.

   El propio informe lo enuncia como regla («Ninguna ruta de `/api/v1` debería volver a llamar a
   `request.json()`») y no la aplica a lo que ya existía, ni lo anota como deuda.

2. `src/lib/api/v1/idempotency.ts:236-240` — **una reserva en vuelo no tiene plazo: si el proceso
   muere entre el INSERT y la respuesta, la clave queda inservible 24 h.** La fila se queda con
   `response_status IS NULL` y todo reintento recibe `409 conflict` con el texto «is still in
   progress; retry shortly», que es falso: no hay nada en curso y no lo habrá hasta que
   `expires_at` venza. No es hipotético — `src/app/api/v1/broadcasts/route.ts:44` fija
   `maxDuration = 60`, y un corte por tiempo aterriza justo en ese estado.
   Entiendo y comparto la dirección conservadora (adoptar una reserva rancia podría reenviar un
   mensaje que sí salió). Lo que falta es que la decisión exista: ni el módulo ni el informe la
   mencionan, y el mensaje de error miente sobre la duración.

3. `src/lib/api/v1/idempotency.ts:200-204` — **el hash cubre método + `pathname` + cuerpo, pero
   no la query string.** Hoy da igual (ni `/messages` ni `/broadcasts` usan parámetros en POST),
   pero este helper es el contrato que van a reutilizar a7.2, a7.3 y a7.5. La primera escritura
   que varíe por query (`?dry_run=1`, `?format=`) reproducirá la respuesta de la otra variante
   con `Idempotent-Replayed: true` y sin ejecutarse. O se incluye `search` en el hash, o queda
   escrito en el módulo que una escritura no puede depender de la query.

4. `src/app/api/account/api-keys/[id]/rotate/route.ts:96-99` y `:113-114` — **rotar una clave ya
   caducada acuña un reemplazo nacido muerto.** `alreadyDead` solo mira `revoked_at`; una clave
   con `expires_at` en el pasado pasa el filtro, y la nueva hereda ese mismo `expires_at`
   (`requested ?? current.expires_at`). El administrador ve el diálogo de revelación única con
   una credencial que no autentica desde el primer segundo, y el 404 que sí recibe por una clave
   revocada no llega por una caducada. La UI ya distingue el estado (`api-keys-settings.tsx:102`
   devuelve `'expired'`), la ruta no.

5. `src/app/api/account/api-keys/[id]/rotate/route.ts:149-156` — **rotar dos veces deja una clave
   nueva de más.** La segunda rotación no es rechazada (la vieja está en gracia, no muerta): crea
   otro reemplazo y el `.is('revoked_at', null)` hace que el sellado no afecte a nadie. El plazo
   de la vieja se respeta —eso sí lo prueba "rotating twice does not push the old key's deadline
   further out"— pero quedan tres filas con el mismo nombre y dos credenciales vivas que el
   administrador no pidió. El test no cuenta las filas.

6. `src/components/settings/api-keys-settings.tsx:114` — el enlace `/developers` apunta a una
   página que no existe hasta a7.7. El informe lo declara y la spec §1 lo pide explícitamente, así
   que lo doy por aceptado, pero queda anotado: si a7.7 se cae del alcance, este enlace es un 404
   en producción dentro de Ajustes.

7. Menor, sin acción obligatoria: no hay test que fije «un `X-Request-Id` enviado por el cliente
   no se refleja». La propiedad se cumple por construcción (`respond.ts:54` lo acuña y nadie lee
   la cabecera de entrada) y es una decisión que el informe destaca; una aserción de una línea la
   protegería de una futura «mejora» que la eche a perder.

## Cambios requeridos

1. Pasar las cuatro escrituras del hallazgo 1 por `readJsonBody` (o por `withIdempotency`, si se
   quiere darles también la reproducción) y añadir, al menos en una de ellas, el test de 413 y el
   de 415 — la promesa de `docs/public-api.md:109-111` y del CHANGELOG tiene que ser cierta para
   todas las escrituras, no para dos. Si se decide dejar alguna fuera a propósito, entonces lo que
   hay que corregir es la documentación, y el motivo va en el informe.
2. Hallazgo 2: acotar la reserva en vuelo (p. ej. tratarla como rancia pasado un plazo corto y
   volver a intentar la reserva) **o**, si se mantiene el 409 conservador, decirlo donde se toma
   la decisión: comentario en `idempotency.ts`, apartado de deuda en el informe y un mensaje que
   no prometa «retry shortly» para algo que puede durar 24 h.
3. Hallazgo 4: rechazar con 404 (o rehusar heredar la caducidad) al rotar una clave cuyo
   `expires_at` ya pasó, con su test.
4. Hallazgo 3 y 5: decidir y dejar escrito. Para el 3 basta una línea en el módulo si se opta por
   no hashear la query; para el 5, o se rechaza rotar una clave que ya está en gracia, o el test
   de doble rotación cuenta las filas y el comportamiento queda documentado.

Lo demás está bien hecho: la reserva por INSERT contra el índice único (y no un check-then-act),
el fake que reproduce el `23505`, el tope aplicado sobre el stream, el `X-Request-Id` acuñado
siempre en servidor, la gracia comprobada contra el `findActiveKeyByHash` real, y la RLS sin
políticas verificada ejecutando como `authenticated` en vez de leyendo `pg_policies`.

---

# Segunda ronda — a7.1 api-hardening

**Veredicto:** APPROVED

Rama `api/recursos` @ a16e2b0, base `feat/api-publica` (= `main` @ 3b82698). Commits nuevos
`617cbe2` y `a16e2b0` (13 archivos, +464/−55); los tres anteriores intactos. El diff coincide
con la sección «Segunda ronda» de `progress/impl_api-hardening.md`. Worktree limpio, nada
pusheado (`api/recursos` y `feat/api-publica` no existen en `origin`).

## Compuerta

Ejecutada por mí, paso a paso, en primer plano, en el worktree:

| Paso | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 35 avisos (los mismos preexistentes) |
| `npm run typecheck` | **verde** |
| `TZ=UTC npm test` | **verde** — 160 archivos, 2 139 tests |
| `npm run build` (variables dummy de `docs/harness.md`) | **verde** — `✓ Compiled successfully in 8.4s`, 64/64 páginas |
| `scripts/replay-migrations.sh` | **n/a** — `git diff c6089f2..HEAD --name-only -- supabase` devuelve 0 archivos; el SQL de la 1.ª ronda (061 + `verify-schema.sql`) ya salió 0 y no se ha tocado |

## Cambios requeridos ↔ verificación

- **CR1 — el tope y el `Content-Type` en todas las escrituras: [x] atendido.**
  Las cuatro rutas leen por `readJsonBody` (`contacts/route.ts:103`,
  `contacts/[id]/route.ts:46`, `webhooks/route.ts:61`, `webhooks/[id]/route.ts:57`) y
  `grep -rn "request.json()" src/app/api/v1/` ya solo encuentra la palabra dentro de los
  comentarios. Los cuatro `catch` acaban en `toApiErrorResponse`, que es quien mapea el
  `ApiError` del helper (`webhooks/route.ts:105`, `webhooks/[id]/route.ts:113`).
  Tests leídos en `src/app/api/v1/contacts/route.test.ts`: › "refuses a body of 1 MiB + 1 with
  413 and never creates a contact" (construye bytes reales y comprueba
  `findOrCreateContact` no llamado), › "refuses text/plain with 415, and a missing Content-Type
  too", › "still answers 400 on a body that is not a JSON object", › "a well-formed write still
  goes through", y en el PATCH › "refuses text/plain with 415 before reading the contact" /
  › "refuses an oversized body with 413 before reading the contact". El `ctx.supabase` del doble
  lanza si alguien toca la base (`forbiddenClient`, línea 44): el test no se conforma con el
  código de estado. La documentación de `docs/public-api.md:109-111` y del CHANGELOG pasa a ser
  cierta para todas las escrituras.
  **Diff de `webhooks` comprobado**: es exclusivamente el `import` y la sustitución de las siete
  líneas de lectura, en cada una de las dos rutas. Ni cabecera, ni firmas, ni `route.test.ts`.
  El merge con `api/webhooks` no debería tener conflicto fuera de esas dos hunks.
- **CR2 — la reserva en vuelo: [x] atendido, acotada.** `IN_FLIGHT_STALE_MS = 2 min`
  (`idempotency.ts:94`). La decisión y su coste están escritos en la cabecera del módulo
  (`idempotency.ts:44-58`), no solo en el informe, y el mensaje de conflicto pasa a «retry in a
  moment» en las dos salidas.
  **Comprobada la carrera que me preocupaba**: el borrado es
  `.eq(account_id).eq(id).is('response_status', null)` (`idempotency.ts:300-305`). Si la reserva
  original aterriza entre `findRow` y el borrado, el `DELETE` no encaja ninguna fila, la
  re-reserva pierde contra el índice único (`23505`) y cae en el `throw conflict` compartido de
  la línea 312. No hay adopción de una reserva recién completada. El mismo razonamiento cubre a
  dos reintentos simultáneos: uno borra y gana el `INSERT`, el otro no borra nada y recibe 409.
  **Comprobada la coherencia con `maxDuration`**: las dos únicas rutas envueltas en
  `withIdempotency` son `POST /api/v1/messages` y `POST /api/v1/broadcasts`; la segunda declara
  `maxDuration = 60` y además responde 202 tras persistir, con el reparto a Meta en `after()`
  (`broadcasts/route.ts:96-110`), así que la reserva solo está abierta durante `createBroadcast`.
  2 min es holgado. (Ver hallazgo 2 sobre la redacción.)
  Tests leídos en `src/lib/api/v1/idempotency.test.ts`: › "an ABANDONED reservation is taken over
  after the stale window, not locked for 24 h" — deja una petición realmente colgada tras una
  promesa, comprueba primero que el reintento **inmediato** es 409, después envejece `created_at`
  y comprueba que el reintento ejecuta (`retry` llamado 1 vez), devuelve su propio cuerpo y deja
  **una** fila; › "an old but COMPLETED reservation is replayed, never re-run" fija que la edad
  sola no autoriza nada. El `FakeIdempotencyStore` sella `created_at` en el `insert`
  (`fake-idempotency-store.ts:94`) y la tabla real lo tiene `NOT NULL DEFAULT now()`
  (`061_api_idempotency.sql:84`), y `findRow` ya lo selecciona: el 409 de «en vuelo de verdad»
  no pasa por un `NaN`. El `.is(col, null)` del doble implementa `IS NULL` de PostgREST
  (`fake-idempotency-store.ts:33-39`), así que el filtro se prueba, no se ignora.
- **CR3 — rotar una clave caducada: [x] atendido.** `alreadyExpired` se une a `alreadyDead` en
  el 404 (`rotate/route.ts:113-124`). Tests leídos: › "an expired key is a 404: no stillborn
  replacement is minted" (cuenta filas: sigue habiendo una, y su `revoked_at` es null) y › "an
  expired key is a 404 even when the caller asks for a new expiry".
- **CR4a — la query string en el hash: [x] atendido.** El hash pasa a
  `método + pathname + search + cuerpo` (`idempotency.ts:236-241`), documentado en la cabecera.
  Test leído: › "a request that differs only in the QUERY STRING is a mismatch, not a replay"
  (409 `idempotency_mismatch`, handler llamado una sola vez).
- **CR4b — rotar dos veces: [x] atendido, se rechaza.** `revoked_at` en el futuro → 409
  (`rotate/route.ts:126-137`), y el `.is('revoked_at', null)` del sellado se queda como guardia
  de carrera con el comentario corregido. Test leído: › "rotating a key that is already rotating
  is a 409, and creates nothing" — **cuenta filas** (2 antes y 2 después) y mantiene la aserción
  del plazo del test anterior, que queda absorbido.
- **Hallazgo 7 (opcional): [x] añadido.** `messages/route.test.ts` › "never reflects a
  client-supplied X-Request-Id" manda `not-a-uuid-<script>` y exige que la respuesta traiga otro
  valor con forma de uuid.
- **Hallazgo 6:** sigue tal cual, aceptado (depende de a7.7).

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí, paso a paso.
- **CP2 Migraciones**: [x] n/a en esta ronda — sin SQL nuevo; lo de la 1.ª ronda sigue validado.
- **CP3 Aislamiento**: [x] la única consulta nueva es el borrado condicional, con
  `.eq('account_id', ctx.accountId)` (`idempotency.ts:303`). La auditoría `unscopedServiceRoleQueries`
  de `tenant-isolation.test.ts` sigue verde sin waiver para `api_idempotency_keys`.
- **CP4 Tests**: [x] los seis puntos de esta ronda tienen test leído por mí. Excepción aceptada:
  413/415 por ruta no se prueban en `webhooks` (ver hallazgo 5).
- **CP5 Sin dependencias**: [x] `package.json`/`package-lock.json` sin cambios en todo el rango.
- **CP6 i18n**: [x] n/a — esta ronda no toca `messages/*.json` (los 15 textos de la 1.ª ronda
  siguen en `es`/`en`/`ko`).
- **CP7 Next 16**: [x] sin API de framework nueva; `{ params: Promise<{ id: string }> }` se
  mantiene, contrastado en la 1.ª ronda contra `node_modules/next/dist/docs/`.
- **CP8 Alcance**: [x] los 13 archivos los justifica §1 + «Seguridad transversal».
- **CP9 Documentación**: [x] CHANGELOG y `docs/public-api.md` actualizados con los tres cambios
  de contrato (415 por falta de cabecera, reserva abandonada, rechazos de la rotación). Sin
  variables de entorno nuevas. **Con la salvedad del hallazgo 1.**
- **CP10 Git**: [x] 2 commits nuevos en español con prefijo y `Co-Authored-By`; nada pusheado;
  `main` @ 3b82698 y `feat/saas-multiempresa` @ 4756a47 intactos; worktree limpio.
- **CP11 Lo entrante nunca se bloquea**: [x] n/a.

## Hallazgos (archivo:línea) — ninguno bloquea

1. `CHANGELOG.md:428` — **la viñeta se equivoca de sujeto**: «A key **rotation** that died
   mid-flight no longer blocks the `Idempotency-Key` for a day». La rotación de claves no tiene
   nada que ver con `Idempotency-Key`; lo que se acotó es una **petición** (`request`) que murió
   entre el INSERT y la respuesta. Es una palabra, pero está en el changelog publicado y junta
   dos cambios que no se tocan. Corregir antes del merge.
2. `src/lib/api/v1/idempotency.ts:91` — «twice the longest handler **the app allows**» no es
   exacto: `src/app/api/whatsapp/broadcast/[id]/resume/route.ts:45` declara `maxDuration = 300`.
   No afecta al comportamiento (esa ruta no usa `withIdempotency`, y las dos que sí lo usan están
   muy por debajo de 2 min), pero la frase invita a asumir un techo global que no existe. Bastaría
   «el handler más largo **de los envueltos en este helper**».
3. `src/lib/api/v1/idempotency.ts:242` y `:281` — **la edad se calcula con dos relojes**: `now` es
   `Date.now()` del proceso y `created_at` lo pone Postgres (`DEFAULT now()`). Un desfase de más
   de dos minutos entre app y base convierte una reserva viva en «abandonada» (o al revés). Es la
   deriva de un contenedor mal sincronizado, no algo que se dé a diario, y el daño está acotado
   por el mismo análisis del módulo; queda anotado por si a7.4 endurece la ventana.
4. `src/lib/api/v1/idempotency.ts:324-334` y `:355-363` — `release()` y el `UPDATE` de la
   respuesta identifican la fila por `(account_id, api_key_id, idempotency_key)`, no por el `id`
   que ese proceso reservó. Tras una adopción, un proceso original que revive tarde borraría o
   sobrescribiría la fila del adoptante. La ventana es estrechísima (el original tendría que
   sobrevivir a los 2 min y volver justo después) y en ese escenario el efecto ya se duplicó, así
   que no es lo peor que pasa; capturar el `id` devuelto por el `INSERT` y filtrar por él lo
   cerraría del todo. Anótalo como deuda de a7.2 si se toca el helper.
5. `src/app/api/v1/webhooks/route.ts` y `[id]/route.ts` — **sin test de 413/415 por ruta.**
   Acepto la deuda: el diff de esas dos rutas es la sustitución literal de la lectura (lo
   verifiqué línea a línea), el guardián es el mismo `readJsonBody` probado a fondo en
   `src/lib/api/v1/body.test.ts` (borde exacto de 1 MiB y cuerpo *streamed* sin `Content-Length`),
   y mantener `webhooks/route.test.ts` fuera del diff evita un conflicto con `api/webhooks`. El
   sitio del test es ese archivo **después** de integrar a7.4; que quede en la lista de a7.4, no
   en el aire.
6. `src/components/settings/api-keys-settings.tsx:652` — el toast muestra el texto del servidor
   tal cual (`payload.error`), en inglés y sin traducir, y ahora hay dos respuestas más que
   llegan por ahí (404 de caducada, 409 de en gracia). Patrón preexistente en este archivo, y el
   panel no ofrece **Rotar** en esos estados, así que solo se ve si alguien llega al endpoint por
   otra vía. Sin acción.

## Cambios requeridos

Ninguno bloqueante. Antes del merge, corregir el sujeto de `CHANGELOG.md:428` (hallazgo 1) y,
si sale gratis, la frase de `idempotency.ts:91` (hallazgo 2). Los hallazgos 3, 4 y 5 van a la
lista de deuda de a7.2/a7.4.

Lo demás está bien resuelto: el borrado condicional por `.is('response_status', null)` arbitra
la adopción con la misma regla que ya usaba el índice único, el doble aprende `IS NULL` en vez de
fingir que el filtro existe, el test de adopción comprueba primero que lo genuinamente en vuelo
sigue dando 409, el de rotación doble cuenta filas, y las cuatro escrituras que faltaban entran
por el mismo helper sin arrastrar nada más al diff.
