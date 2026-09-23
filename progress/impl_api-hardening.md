# a7.1 `api-hardening` — endurecer la capa común de `/api/v1`

Spec: `progress/spec_api-publica.md` §1, más «Seguridad transversal» y S-A1..S-A7.
Rama `api/recursos`, worktree `.claude/worktrees/api-recursos`, base `main` @ 3b82698.

## Commits

| Hash | Qué |
|---|---|
| `a8118d2` | Migración 061 + `respond.ts` (X-Request-Id, no-store, request_id, códigos nuevos) + `readJsonBody` + `withIdempotency` + sus tests |
| `00ae028` | `POST /api/v1/messages` y `POST /api/v1/broadcasts` bajo `withIdempotency`; caso de aislamiento entre cuentas |
| `c6089f2` | Rotación y caducidad de claves: ruta `/rotate`, gracia de 24 h, revocación durante la gracia, panel, es/en/ko, CHANGELOG, `docs/public-api.md` |

Nada pusheado. `main`, `dev` y `feat/saas-multiempresa` intactos.

## Compuerta

Ejecutada paso a paso en primer plano, en este orden:

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 35 avisos (todos preexistentes) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | 159 archivos, 2 127 tests, todos verdes |
| `npm run build` (variables dummy de `docs/harness.md`) | `✓ Compiled successfully`; `/api/account/api-keys/[id]/rotate` aparece en el manifiesto |
| `scripts/replay-migrations.sh "$(pwd)"` | salida **0**, `verify-schema.sql: OK` |

## La firma de los dos helpers (para a7.2, a7.3 y a7.5)

Esto es lo que las features siguientes deben reutilizar. **Ninguna ruta de `/api/v1`
debería volver a llamar a `request.json()`**: hacerlo se salta el `Content-Type`, el tope
de 1 MiB y consume el cuerpo que la idempotencia necesita para hashear.

```ts
// src/lib/api/v1/idempotency.ts
export async function withIdempotency(
  ctx: ApiKeyContext,
  request: Request,
  handler: (body: Record<string, unknown>) => Promise<NextResponse>
): Promise<NextResponse>;
```

Uso canónico en una escritura nueva:

```ts
export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    return await withIdempotency(ctx, request, async (body) => {
      // `body` ya es un objeto JSON validado. Devuelve un NextResponse
      // construido con ok() / okList() / fail().
      return ok({ id }, 201);
    });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
```

Lo que aporta, y en qué orden: valida la cabecera `Idempotency-Key` (1–255, si no `400`),
llama a `readJsonBody`, calcula `sha256(método + ruta + cuerpo crudo)`, **reserva** con un
INSERT contra el índice único y solo entonces ejecuta `handler`. Si el handler devuelve
2xx guarda estado y cuerpo; si devuelve otra cosa o lanza, libera la reserva. Sin la
cabecera no escribe nada y el endpoint se comporta como antes.

```ts
// src/lib/api/v1/body.ts
export const MAX_BODY_BYTES = 1024 * 1024;
export interface JsonBody { data: Record<string, unknown>; raw: string }
export async function readJsonBody(request: Request): Promise<JsonBody>;
```

Lanza `ApiError`: `415 unsupported_media_type` sin `Content-Type: application/json`,
`413 payload_too_large` por encima de 1 MiB (comprobado **mientras** se lee, no después),
`400 bad_request` si no es JSON o no es un objeto. Devuelve también el crudo porque el
cuerpo solo se puede consumir una vez y la idempotencia hashea los bytes que llegaron.
Una lectura sin idempotencia (un `PATCH` sin efectos duplicables) puede llamarlo directo.

Constantes exportadas desde `src/lib/api/v1/respond.ts`, un solo sitio para las dos
cabeceras: `REQUEST_ID_HEADER`, `IDEMPOTENT_REPLAYED_HEADER`, `v1Headers(extra?)` y
`replayed(body, status)`. `ok`, `okList`, `fail` y `toApiErrorResponse` ya pasan por ahí:
una ruta nueva hereda `X-Request-Id` y `Cache-Control: no-store` sin escribir una línea.
Códigos nuevos en `ApiErrorCode`: `conflict`, `idempotency_mismatch`, `payload_too_large`,
`unsupported_media_type`, y constructores `conflict()`, `idempotencyMismatch()`,
`payloadTooLarge()`, `unsupportedMediaType()`, `notFound()`.

## Criterio ↔ test

| Criterio del spec | Archivo | `it` |
|---|---|---|
| Dos POST iguales con la misma `Idempotency-Key` producen un solo mensaje y la segunda respuesta lleva `Idempotent-Replayed` | `src/app/api/v1/messages/route.test.ts` | `two identical POSTs send ONE message and the second is flagged as replayed` |
| | `src/lib/api/v1/idempotency.test.ts` | `same key and same body: the handler runs once, the retry is replayed` |
| Cuerpo distinto → 409 | `src/app/api/v1/messages/route.test.ts` | `the same key with a different body is 409 idempotency_mismatch` |
| | `src/lib/api/v1/idempotency.test.ts` | `same key, different body: 409 idempotency_mismatch and no second run` |
| Otra clave de API con la misma `Idempotency-Key` no ve la respuesta ajena (fuga) | `src/app/api/v1/messages/route.test.ts` | `another API key reusing the same Idempotency-Key does NOT see the other response` |
| | `src/lib/api/v1/idempotency.test.ts` | `another API KEY with the same Idempotency-Key never sees the stored response` |
| Fuga entre **cuentas** + auditoría de alcance del rol de servicio (CP3) | `src/lib/security/tenant-isolation.test.ts` | `la idempotencia de la fase 7 §1 no cruza cuentas: misma Idempotency-Key, dos mensajes` |
| | `src/lib/api/v1/idempotency.test.ts` | `every query it makes is scoped by account_id` |
| Cuerpo de 1 MiB + 1 → 413 | `src/app/api/v1/messages/route.test.ts` | `refuses a body of 1 MiB + 1 with 413 and never reaches the send core` |
| | `src/lib/api/v1/body.test.ts` | `refuses 1 MiB + 1 with 413 payload_too_large`, `accepts a body of exactly 1 MiB`, `refuses an oversized STREAMED body, with no Content-Length to go by` |
| `text/plain` → 415 | `src/app/api/v1/messages/route.test.ts` | `refuses text/plain with 415` |
| | `src/lib/api/v1/body.test.ts` | `refuses text/plain with 415 unsupported_media_type`, `refuses a missing Content-Type with 415` |
| Rotar deja dos claves activas 24 h y la vieja deja de autenticar después | `src/app/api/account/api-keys/[id]/rotate/route.test.ts` | `leaves BOTH keys authenticating for 24 h, then only the new one`, `stamps the old key exactly 24 h out` |
| Replay de migraciones verde con aserción en `verify-schema.sql` | `supabase/ci/verify-schema.sql` (bloque «061») | — |
| `X-Request-Id` / `no-store` / `request_id` en toda respuesta | `src/lib/api/v1/respond.test.ts` | los 6 `it` del archivo |
| | `src/app/api/v1/messages/route.test.ts` | `carries X-Request-Id and Cache-Control: no-store on success`, `puts request_id in the error envelope so a caller can quote it` |

Tests de apoyo que no salen de un criterio literal pero cubren decisiones tomadas aquí:
concurrencia (`a concurrent retry gets 409 conflict instead of doing the work twice`),
liberación de la clave en error (`a non-2xx response releases the key…`), caducidad a las
24 h, degradación si el almacén falla, rotación heredando la caducidad, rotación doble que
no alarga el plazo, y las cuatro salidas de `DELETE /api/account/api-keys/[id]` en
`src/app/api/account/api-keys/[id]/route.test.ts`.

## Verificaciones contra base real

`progress/checks_api-hardening.sql`, corrido contra el Postgres del harness
(`KEEP=1 scripts/replay-migrations.sh "$(pwd)"` y `docker exec … psql -v ON_ERROR_STOP=1`).
Los 7 bloques en verde:

1. `expires_at` por defecto = `created_at + 24 h`.
2. Repetir `(api_key_id, idempotency_key)` da `23505`. **Este es el mecanismo entero**: sin
   el índice único, dos reintentos simultáneos enviarían el mensaje dos veces.
3. La misma `Idempotency-Key` convive en tres claves de API distintas, en filas separadas.
4. `authenticated` ve **0 filas aun con `GRANT SELECT`** — RLS habilitada sin políticas.
5. `service_role` sí ve las tres.
6. Borrar una clave de API se lleva solo sus propias reservas.
7. La purga por `expires_at` usa `api_idempotency_keys_expires_at_idx`.

El fake de `src/lib/api/v1/fake-idempotency-store.ts` reproduce el índice único y el
`23505`, así que los tests de vitest se apoyan en la misma arbitración que la base, no en
un doble que siempre dice que sí.

## Verificaciones manuales pendientes

Ninguna depende de Meta ni de PayPal. Queda una comprobación visual del panel, que no
tiene runner (no hay e2e en el repo):

1. Ajustes → API → **Nueva clave de API**: el selector de caducidad ofrece «Nunca caduca»
   (por defecto), 30, 90 y 365 días; crear con 30 deja la fila con «caduca el …».
2. En una clave activa, **Rotar** → confirmar. Debe aparecer el texto de una sola
   revelación con la fecha y hora en que muere la anterior; al cerrar, el listado muestra
   dos filas con el mismo nombre, la vieja con la insignia ámbar «En rotación» y su plazo,
   sin tachado.
3. Sobre la fila en rotación, **Revocar ya** la marca como «Revocada» en el acto.
4. Los tres idiomas: cambiar a `en` y `ko` y comprobar que ninguna de las claves nuevas
   sale como texto crudo.

## Decisiones donde el spec era ambiguo

- **`withIdempotency(ctx, request, handler)` lee el cuerpo por dentro.** El spec pide esa
  firma de tres argumentos, pero el hash necesita los bytes crudos y un `Request` solo se
  consume una vez. En vez de añadir un cuarto parámetro, el helper llama a `readJsonBody`
  y le pasa al handler el objeto ya validado. La firma del spec se respeta y la ruta hace
  una sola llamada para las cuatro cosas (media type, tamaño, JSON, reproducción).
- **Solo se memorizan respuestas 2xx.** Un `400`/`429`/`500` libera la clave. Reproducir un
  error verbatim (lo que hace Stripe) convertiría un cuerpo mal formado en un bloqueo de
  24 h sobre ese identificador; liberar significa que el cliente corrige y reintenta con el
  mismo. El coste es que un error no se reproduce; el beneficio es que una clave nunca se
  vuelve una lápida.
- **El hash cubre método + ruta + cuerpo.** Reusar una clave en otro endpoint sale como
  `idempotency_mismatch` en vez de que un endpoint responda con el payload de otro.
- **Alcance de la unicidad: por clave de API, no por cuenta** (lo dice el spec y la
  migración lo razona). Con alcance de cuenta, dos integraciones de la misma empresa que
  eligieran el mismo identificador se leerían la respuesta la una a la otra.
- **Dos peticiones concurrentes con la misma clave → `409 conflict`**, no espera ni
  ejecución doble. El spec no lo cubría; es el caso que justifica reservar con INSERT antes
  de ejecutar.
- **`X-Request-Id` siempre lo acuña el servidor**, nunca se refleja el del cliente. Un
  valor controlado por quien llama permitiría falsear correlaciones en los registros y
  colar bytes arbitrarios en una cabecera de respuesta.
- **La clave rotada hereda la caducidad de la vieja** salvo que se pase `expiresInDays`.
  Reiniciar el reloj en silencio convertiría la rotación en una puerta trasera para alargar
  una credencial deliberadamente corta.
- **La clave nueva conserva el nombre.** El nombre describe la integración, que no ha
  cambiado; el prefijo distingue las dos filas y la vieja se ve «En rotación».
- **`DELETE /api/account/api-keys/[id]` acepta una clave en gracia** y la re-marca con
  `now()`. Sin esto, el botón al que acude un administrador que acaba de enterarse de una
  filtración habría respondido 404 durante 24 h. (Cambio de alcance mínimo pero necesario:
  el estado «marcada pero viva» lo creó esta feature.)
- **Purga de filas caducadas**: oportunista, 1 de cada 100 llamadas, acotada por
  `account_id` (mismo patrón que el barrido del limitador de `src/lib/rate-limit.ts`). La
  corrección no depende de ella: toda lectura filtra por `expires_at`. Cuando a7.4 monte el
  barrido por cron, puede quedarse con el trabajo.
- **Enlace a `/developers`** en la descripción del panel, como pide el spec. **Esa página
  todavía no existe**: la construye a7.7. El enlace queda muerto hasta que a7.7 entre en
  `feat/api-publica`; si por lo que sea a7.7 se cayera del alcance, hay que quitarlo.

## Variables de entorno

**Ninguna nueva.** Por eso `docs/docker.md` no se toca. `.env.local.example` está bloqueado
por permisos y, además, no habría nada que añadirle.

## Alcance y archivos

Diff: migración 061 + `verify-schema.sql`; `src/lib/api/v1/{respond,body,idempotency,
fake-idempotency-store}.ts` y sus tests; `src/app/api/v1/{messages,broadcasts}/route.ts`;
`src/lib/api-keys/{keys,store}.ts`; `src/app/api/account/api-keys/**`;
`src/components/settings/api-keys-settings.tsx`; `messages/{es,en,ko}.json`;
`src/lib/security/tenant-isolation.test.ts`; `CHANGELOG.md`; `docs/public-api.md`.

`src/lib/api/v1/conversations.test.ts` se tocó sin querer (prettier sobre un glob) y se
revirtió: no forma parte del diff.

## Deuda detectada fuera de mi alcance (no arreglada)

- **La memoria de idempotencia es por proceso en un punto y por base en el otro.** La tabla
  es compartida, así que la garantía sobrevive a varias instancias; el contador de purga y
  el limitador de `rate-limit.ts` no. Es la misma deuda que ya documenta la cabecera de
  `src/lib/rate-limit.ts` (fase 5 §1), sin agravar.
- **Nadie borra las filas caducadas si el tráfico de escritura para.** Con la purga 1 de
  cada 100, una cuenta que deja de llamar conserva sus filas hasta que vuelva a llamar. El
  índice por `expires_at` está puesto para que el barrido de a7.4 las recoja; si a7.4 no lo
  hace, hay que decirlo.
- **`GET /api/account/api-keys` no ordena por estado.** Tras rotar, el listado muestra dos
  filas con el mismo nombre ordenadas por `created_at`; la nueva sale arriba, que es lo
  deseable, pero no es una garantía escrita en ninguna parte.
- **El aviso de rotación es un diálogo, no una notificación persistente.** Si el
  administrador cierra la ventana sin copiar la clave, no hay forma de recuperarla (igual
  que al crear): tiene que rotar otra vez. Es coherente con el contrato de revelación
  única, pero con la rotación duele más porque la anterior ya tiene fecha de muerte.
- **`api_keys` conserva la política RLS de DELETE (admin+).** Un borrado duro se lleva por
  cascada las reservas de idempotencia de esa clave (comprobado, bloque 6 del SQL). Es lo
  correcto, pero el panel no ofrece ese borrado y nadie ha decidido si debería.

---

# Segunda ronda (CHANGES_REQUESTED de `progress/review_api-hardening.md`)

Commits nuevos sobre `api/recursos` (los tres anteriores intactos):

| Hash | Qué |
|---|---|
| `617cbe2` | Las cuatro escrituras restantes de `/api/v1` leen por `readJsonBody` + test de 413/415 en contactos |
| `a16e2b0` | Reserva de idempotencia acotada, query string en el hash, rotación que rechaza clave caducada (404) y clave en gracia (409), doc y CHANGELOG |

## Compuerta (paso a paso, primer plano)

| Paso | Resultado |
|---|---|
| `npm run lint` | 0 errores, 35 avisos (los mismos preexistentes) |
| `npm run typecheck` | limpio |
| `TZ=UTC npm test` | **160 archivos, 2 139 tests**, todos verdes (antes 159 / 2 127) |
| `npm run build` (variables dummy de `docs/harness.md`) | `✓ Compiled successfully in 10.0s` |
| `scripts/replay-migrations.sh` | **no aplica**: esta ronda no toca SQL (061 y `verify-schema.sql` sin cambios) |

## Cambio requerido 1 — el tope y el `Content-Type` en todas las escrituras

Las cuatro rutas pasan por `readJsonBody`; el cambio en cada una es la
sustitución de la lectura y nada más (el `ApiError` que lanza ya lo mapea el
`toApiErrorResponse` que esas rutas tenían en su `catch`):

- `src/app/api/v1/contacts/route.ts` (POST)
- `src/app/api/v1/contacts/[id]/route.ts` (PATCH)
- `src/app/api/v1/webhooks/route.ts` (POST)
- `src/app/api/v1/webhooks/[id]/route.ts` (PATCH)

En las dos de `webhooks` me limité a eso deliberadamente —sin tocar cabecera,
firmas ni su `route.test.ts`— para que el merge con `api/webhooks` (que añade
`/webhooks/[id]/deliveries`, `/test` y `/rotate-secret`) sea trivial. Por la
misma razón los tests de 413/415 van en un archivo **nuevo**,
`src/app/api/v1/contacts/route.test.ts`, que no existe en la otra rama.

| Criterio | Archivo | `it` |
|---|---|---|
| 1 MiB + 1 → 413 y no se crea contacto | `src/app/api/v1/contacts/route.test.ts` | `refuses a body of 1 MiB + 1 with 413 and never creates a contact` |
| `text/plain` y sin `Content-Type` → 415 | idem | `refuses text/plain with 415, and a missing Content-Type too` |
| Cuerpo que no es objeto → 400 (no cambia) | idem | `still answers 400 on a body that is not a JSON object` |
| La escritura sigue funcionando | idem | `a well-formed write still goes through` |
| Los mismos topes en el PATCH | idem | `refuses text/plain with 415 before reading the contact`, `refuses an oversized body with 413 before reading the contact` |

Las aserciones que importan son las negativas: el `ctx.supabase` del doble
lanza si alguien lo toca, y `findOrCreateContact` / `getContactById` no se
llaman. Un 413 que hubiera bufferizado igualmente pasaría un test que solo
mirara el código de estado.

**Cobertura por ruta**: no añadí tests de 413/415 a `webhooks` por la razón de
merge de arriba. El guardián es el mismo helper, ya probado exhaustivamente en
`src/lib/api/v1/body.test.ts` (incluido el borde exacto y el cuerpo
*streamed*). Si el reviewer lo prefiere explícito, el sitio natural es
`src/app/api/v1/webhooks/route.test.ts` **después** de integrar a7.4.

## Cambio requerido 2 — la reserva en vuelo (hallazgo 2)

**Decisión: acotarla.** Una reserva sin `response_status` cuyo `created_at`
tiene más de `IN_FLIGHT_STALE_MS` (2 min) se considera abandonada: se borra
—con `.is('response_status', null)`, así que si la original aterrizó entre la
lectura y el borrado no se borra nada y la re-reserva pierde contra el índice
único— y el reintento toma el sitio y ejecuta.

Por qué esto y no el 409 conservador:

- El 409 conservador convierte **cada** muerte de proceso en una clave
  inservible 24 h. El cliente que reintenta con la misma clave —que es
  justamente lo que le pedimos que haga— queda bloqueado un día entero, y el
  mensaje le dice que hay algo «en curso» que no existe. Es un fallo seguro,
  pero garantizado, en cada caída.
- El reenvío solo es posible en la ventana estrecha «el proceso murió
  **después** del efecto y **antes** de guardar la respuesta». Fuera de ella
  (que es la mayoría: el corte por tiempo ocurre casi siempre *durante* la
  llamada externa) el reintento hace el trabajo que nunca se hizo.
- 2 min es el doble del handler más largo que la app permite
  (`maxDuration = 60` en `POST /api/v1/broadcasts`), así que una petición que
  de verdad sigue corriendo nunca pierde su sitio: el 409 que ve un
  concurrente honesto sigue siendo 409.
- Con ese límite, el mensaje ya no miente. Pasa a «retry in a moment» en las
  dos salidas de conflicto, y `docs/public-api.md` dice explícitamente que un
  `409 conflict` nunca significa esperar 24 h.

Queda escrito en la cabecera del módulo (`src/lib/api/v1/idempotency.ts`,
apartado «A reservation that never finishes»), con el coste asumido nombrado.

| Criterio | Archivo | `it` |
|---|---|---|
| Se adopta la reserva abandonada, y solo entonces | `src/lib/api/v1/idempotency.test.ts` | `an ABANDONED reservation is taken over after the stale window, not locked for 24 h` (comprueba primero que en vuelo de verdad sigue dando 409) |
| La edad sola no basta: una fila vieja **con** respuesta se reproduce | idem | `an old but COMPLETED reservation is replayed, never re-run` |

`FakeIdempotencyStore` aprende `.is(col, null)` (semántica `IS NULL` de
PostgREST) para que el borrado condicional se pruebe de verdad y no como un
filtro ignorado.

## Cambio requerido 4a — la query string en el hash (hallazgo 3)

Se incluye: el hash pasa a ser `método + pathname + search + cuerpo crudo`.
Era más barato que confiar en un comentario, y a7.2/a7.3/a7.5 heredan la
propiedad sin leerse nada. Documentado en el módulo y en `docs/public-api.md`.

| Criterio | Archivo | `it` |
|---|---|---|
| Dos llamadas que solo difieren en la query no se reproducen | `src/lib/api/v1/idempotency.test.ts` | `a request that differs only in the QUERY STRING is a mismatch, not a replay` |

## Cambio requerido 3 — rotar una clave caducada (hallazgo 4)

`alreadyExpired` (un `expires_at` en el pasado) se une a `alreadyDead` en el
404. Antes se acuñaba un reemplazo que heredaba esa caducidad: el
administrador copiaba, de un diálogo de revelación única, una credencial que
no autenticaba desde el primer segundo.

| Criterio | Archivo | `it` |
|---|---|---|
| Clave caducada → 404, sin reemplazo | `src/app/api/account/api-keys/[id]/rotate/route.test.ts` | `an expired key is a 404: no stillborn replacement is minted` |
| Tampoco pasando `expiresInDays` | idem | `an expired key is a 404 even when the caller asks for a new expiry` |

## Cambio requerido 4b — rotar dos veces (hallazgo 5)

**Se rechaza**: un `revoked_at` en el futuro (clave en gracia) es `409`. La
segunda rotación no podía mover el plazo de la primera —eso lo garantiza el
`.is('revoked_at', null)` del sellado—, así que lo único que aportaba era una
tercera fila con el mismo nombre y una credencial viva que nadie pidió.
Rechazar coincide con lo que el panel ya ofrecía: `api-keys-settings.tsx` solo
muestra **Rotar** sobre una clave con estado `active`, nunca sobre una
`rotating` ni una `expired`. El `.is('revoked_at', null)` se queda como
guardia de carrera (por si entra en gracia entre la lectura y el sellado) y su
comentario lo dice.

| Criterio | Archivo | `it` |
|---|---|---|
| Segunda rotación → 409, no se crea nada, el plazo no se mueve (**cuenta filas**) | `src/app/api/account/api-keys/[id]/rotate/route.test.ts` | `rotating a key that is already rotating is a 409, and creates nothing` |

El test antiguo `rotating twice does not push the old key’s deadline further
out` queda absorbido por este (mantiene su aserción del plazo y añade el
recuento de filas).

## Hallazgo 7 (opcional)

Añadido: `src/app/api/v1/messages/route.test.ts` ›
`never reflects a client-supplied X-Request-Id` — manda
`X-Request-Id: not-a-uuid-<script>` y comprueba que la respuesta trae otro
valor y con forma de uuid. Una futura «mejora» que refleje la cabecera del
cliente rompe ese test.

## Hallazgo 6

Sin acción: el enlace a `/developers` sigue dependiendo de a7.7, como declaró
la primera ronda y aceptó el review.

## Cambios de contrato visibles (documentados)

- `CHANGELOG.md` (Unreleased, Security): tres líneas nuevas — el tope y el
  media type ahora alcanzan a contactos y webhooks (una integración que
  posteaba JSON sin cabecera pasa a recibir 415), la reserva abandonada, y los
  dos rechazos de la rotación.
- `docs/public-api.md`: nota sobre la reserva abandonada y sobre la query
  string en la tabla de idempotencia; en «Rotating a key», qué no se puede
  rotar y por qué.
- **`.env.local.example` no se toca** (bloqueado por permisos) y no habría
  nada que añadirle: esta ronda tampoco introduce variables de entorno.

## Verificaciones contra base real

Ninguna nueva: esta ronda no toca SQL. `progress/checks_api-hardening.sql` de
la primera ronda sigue siendo válido tal cual (la tabla, el índice único, la
RLS y las cascadas no cambian). El único comportamiento nuevo que toca la base
—borrar una reserva abandonada solo si sigue sin respuesta— se apoya en un
`DELETE … WHERE response_status IS NULL`, que el doble reproduce con la misma
semántica.

## Verificaciones manuales pendientes

Las cuatro de la primera ronda siguen en pie, más una:

5. Ajustes → API, sobre una clave **en rotación**: comprobar que el botón
   **Rotar** no aparece (solo **Revocar ya**). Si alguien llega al endpoint de
   otra forma, la respuesta es 409 con el texto del servidor en el toast.

## Deuda nueva detectada (no arreglada)

- **`POST /api/account/api-keys/[id]/rotate` lee con `request.json()`.** Es
  una ruta de panel con sesión por cookie, no `/api/v1`, así que el tope de
  1 MiB de la API pública no le aplica; pero las rutas de `/api/account` no
  tienen ningún tope propio. Es anterior a esta feature y afecta a todas por
  igual: merece una decisión aparte, no un parche aquí.
- **Los tests de 413/415 por ruta no cubren `webhooks`** (razón de merge, más
  arriba). Es cobertura, no comportamiento.
