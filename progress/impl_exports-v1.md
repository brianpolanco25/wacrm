# a7.5 `exports-v1` — exportar chats (síncrono y por jobs)

Spec: `progress/spec_api-publica.md` §5 + «Seguridad transversal» + S-A4/S-A6/S-A7.
Rama `api/exports`, worktree `.claude/worktrees/api-exports`, base `feat/api-publica` @ 6b0d768
(integra a7.1 `api-hardening` y a7.4 `webhooks-durable`).

## Plan (escrito antes de tocar código)

1. **Migración 063 + modelo.** Tabla `export_jobs`, bucket privado `exports`,
   aserciones en `verify-schema.sql`; scope `conversations:export` en `API_SCOPES` /
   `SCOPE_DESCRIPTIONS`; cubo `exports` (10/hora por cuenta) en `RATE_LIMITS`;
   serializador de filas y CSV con escape + antiinyección de fórmulas.
2. **Camino síncrono.** `GET /api/v1/conversations/{id}/export?format=json|csv`,
   tope de 10 000 mensajes → 409 apuntando al asíncrono.
3. **Camino asíncrono + cron.** `POST /api/v1/exports` (202, `withIdempotency`,
   proceso en `after()`), `GET /api/v1/exports`, `GET /api/v1/exports/{id}` con URL
   firmada de 15 min recién acuñada; el cron de a7.4 retoma huérfanos y purga a los
   7 días con cupo aparte.
4. **Documentación.** `docs/public-api.md`, `CHANGELOG.md`, informe y SQL de comprobación.

### Rescate del WIP (2026-09-16)

El primer implementer se colgó con el paso 1 escrito y sin commitear. Lo que
había en el worktree (`scopes.ts`, `rate-limit.ts`, `verify-schema.sql`,
`src/lib/exports/{csv,conversations}.ts`, `063_export_jobs.sql`) se leyó entero,
compilaba salvo un error (`toCsv` exigía `Record<string, unknown>` y
`ExportMessageRow` no tiene índice de cadena: se relajó el genérico a `<T>`) y
se commiteó tal cual como primer hito antes de seguir. No se descartó nada.

## Rama y commits

Rama `api/exports` sobre `feat/api-publica` @ 6b0d768. Cuatro commits:

| Commit    | Qué                                                                   |
| --------- | --------------------------------------------------------------------- |
| `670a2ec` | WIP rescatado: migración 063, aserciones, scope, cubo, CSV y lectura   |
| `67b8bbb` | Las tres rutas, `src/lib/exports/jobs.ts` y el enganche al cron de a7.4 |
| `d821676` | Tests de los dos caminos, de los jobs y del aislamiento                |
| `8ed0ecc` | `docs/public-api.md`, `CHANGELOG.md` y `docs/docker.md`                |

## Criterios de la spec ↔ tests

Todos los ficheros son del worktree `.claude/worktrees/api-exports`.

### «Tests de ambos caminos con Storage simulado»

| Criterio                                | Test                                                                                                                                                |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Síncrono json                           | `src/app/api/v1/conversations/[id]/export/route.test.ts` — `json: descarga con el documento y las cabeceras de v1`                                    |
| Síncrono csv                            | idem — `csv: cabecera, una fila por mensaje y escape del texto peligroso`                                                                             |
| `format` por defecto / desconocido      | idem — `sin ?format sale en json`; `un formato desconocido es bad_request antes de tocar la base`                                                     |
| Tope 10 000 → 409                       | idem — `por encima del tope manda al encargo asíncrono, sin leer los mensajes`                                                                        |
| Cubo `exports` 10/hora                  | idem — `el cubo propio de exportaciones corta con 429 y Retry-After`; `src/app/api/v1/exports/route.test.ts` — `el cubo propio corta con 429 antes de encolar` |
| Asíncrono 202 + `after()` + Storage     | `src/app/api/v1/exports/route.test.ts` — `202 con el encargo en queued y el scope correcto`; `after() construye el archivo y deja el encargo en done` |
| Lista y paginación                      | idem — `lista solo los encargos de la cuenta, el último primero`; `pagina con cursor`                                                                 |
| Idempotencia del encargo                | idem — `la misma Idempotency-Key no encarga dos exports`                                                                                              |
| `readJsonBody` (nunca `request.json()`) | idem — `sin Content-Type json es 415 (readJsonBody, nunca request.json())`                                                                            |
| Estado de un encargo (`queued`/`failed`) | `src/app/api/v1/exports/[id]/route.test.ts` — `queued: estado sin enlace`; `failed: el motivo publicable y ningún enlace`                             |
| Construcción, fallo y kind inválido     | `src/lib/exports/jobs.test.ts` — `sube el archivo al bucket privado y cierra el encargo en done`; `un fallo de Storage deja failed con un motivo publicable, sin detalle interno`; `un kind desconocido falla en vez de exportar cualquier cosa` |
| Barrido y purga del cron                | idem — `retoma lo que quedó en queued y lo que murió en running`; `no le quita el trabajo a un running reciente`; `un encargo por cuenta y barrido: la cuenta con dos no ahoga a la de al lado`; `borra primero el archivo y después la fila, y solo lo caducado` |
| El cron sigue devolviendo lo de a7.4    | `src/app/api/webhooks/cron/route.test.ts` — `las entregas no dependen de las exportaciones: el bloque exports es aditivo`                             |

### «CSV con escape correcto (comas, comillas, saltos de línea, celdas que empiezan por `=`)»

| Criterio                       | Test                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------ |
| Comas                          | `src/lib/exports/csv.test.ts` — `entrecomilla las comas`                                    |
| Comillas dobles                | idem — `entrecomilla y duplica las comillas dobles`                                         |
| Saltos de línea (LF y CRLF)    | idem — `entrecomilla los saltos de línea (LF y CRLF)`                                       |
| `=`, `+`, `-`, `@`             | idem — `neutraliza la celda que empieza por %s`; `el caso de la spec: =1+1 sale como texto` |
| Tabulador / retorno iniciales  | idem — `también tras un tabulador o un retorno de carro iniciales`                           |
| El prefijo va dentro de comillas | idem — `el prefijo va DENTRO de las comillas cuando la celda las necesita`                 |
| Extremo a extremo por HTTP     | `src/app/api/v1/conversations/[id]/export/route.test.ts` — `csv: cabecera, una fila por mensaje y escape del texto peligroso` |

### «Test de fuga: conversación ajena → 404; job ajeno → 404; el filtro nunca sale de `account_id`»

| Criterio                          | Test                                                                                                                     |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| Conversación ajena → 404          | `src/lib/security/tenant-isolation.test.ts` — `export síncrono: la conversación de B → 404; la propia baja con sus mensajes`; `src/app/api/v1/conversations/[id]/export/route.test.ts` — `una conversación de otra cuenta es 404, no 403` |
| Encargo ajeno → 404               | `src/lib/security/tenant-isolation.test.ts` — `encargos: la lista es de A, el de B → 404 …`; `src/app/api/v1/exports/[id]/route.test.ts` — `un encargo de otra cuenta es 404, y no se firma nada suyo` |
| El filtro no amplía el alcance    | `src/lib/security/tenant-isolation.test.ts` — `el filtro de un encargo no puede ampliar el alcance a otra cuenta`; `src/lib/exports/jobs.test.ts` — `ignora lo que no conoce — incluido account_id` |
| El archivo solo lleva datos de la cuenta | `src/lib/exports/jobs.test.ts` — `el archivo solo contiene lo de su cuenta`                                          |
| El reclamo no cruza cuentas       | idem — `reclamar nombrando otra cuenta no toca la fila (fuga)`                                                             |
| Auditoría de rol de servicio      | el `afterEach` de la suite de aislamiento: ninguna consulta nueva necesitó waiver                                          |

### «URL firmada caduca y no se persiste»

| Criterio                            | Test                                                                                                   |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------ |
| 15 minutos exactos                  | `src/app/api/v1/exports/[id]/route.test.ts` — `done: URL firmada de 15 minutos, acuñada ahora y no guardada` |
| Firma nueva en cada GET             | idem — `cada llamada acuña una firma nueva y no reutiliza la anterior`                                   |
| No se escribe en la fila            | idem (aserción sobre la fila) y `src/lib/exports/jobs.test.ts` — `acuña una URL de 15 minutos y no escribe nada en la fila` |
| Ni la ruta del bucket sale a la API | `src/app/api/v1/exports/[id]/route.test.ts` — `la ruta dentro del bucket nunca sale en la respuesta`; `src/app/api/v1/exports/route.test.ts` — `no publica la ruta del archivo en el bucket` |
| Si firmar falla, no hay enlace roto | `src/app/api/v1/exports/[id]/route.test.ts` — `un fallo al firmar no devuelve un enlace roto: 500`       |

## Verificaciones contra base real

`KEEP=1 scripts/replay-migrations.sh "$(pwd)"` → las 63 migraciones aplican y
`verify-schema.sql` pasa (salida 0). Re-aplicar `063_export_jobs.sql` sobre la
misma base es idempotente (solo `NOTICE ... already exists`) y el verify vuelve
a pasar.

`progress/checks_exports-v1.sql` contra ese contenedor, cinco bloques, todos
verdes:

- **A** — los tres CHECK (`status`, `format`, `kind`) rechazan valores
  inventados, los cuatro estados legítimos entran y `expires_at` nace a 7 días
  sin que nadie lo escriba (S-A6).
- **B** — RLS: un miembro de A ve 1 encargo y 0 de B; `authenticated` no puede
  INSERT (privilegio denegado), y su UPDATE/DELETE afectan 0 filas.
- **C** — el bucket `exports` es privado, tiene tope de tamaño y **cero**
  políticas de `storage.objects` lo nombran.
- **D** — el reclamo optimista por `(status, started_at)` es exclusivo: el
  segundo UPDATE sobre la misma foto afecta 0 filas.
- **E** — borrar la clave de API deja el encargo con `api_key_id` NULL; borrar
  la cuenta arrastra sus encargos.

## Compuerta

Los cuatro comandos en primer plano, por separado, en el worktree:

- `npm run lint` — 0 errores, 35 avisos, todos preexistentes (ninguno en
  `src/lib/exports/**` ni en `src/app/api/v1/exports/**`).
- `npm run typecheck` — limpio.
- `TZ=UTC npm test` — 178 archivos, **2 328 tests**, todos en verde.
- `npm run build` con las variables de `docs/harness.md` — compila y registra
  `/api/v1/exports`, `/api/v1/exports/[id]` y
  `/api/v1/conversations/[id]/export`.

## Decisiones donde el spec era ambiguo

1. **`media_url` → `storage://<bucket>/<path>`, no una URL firmada.** La spec
   deja elegir; se eligió la ruta interna. Una firma dentro del archivo de un
   job (a) es una credencial al portador escrita en disco durante 7 días, que es
   justo lo que la spec prohíbe persistir, y (b) estaría muerta: 15 minutos
   dentro de un archivo que se descarga al día siguiente es un enlace roto
   disfrazado de dato. Lo que no es de nuestros buckets (CDN de Meta, enlace
   externo) sale tal cual. Documentado en `docs/public-api.md` y en la cabecera
   de `src/lib/exports/conversations.ts`.
2. **Columna `started_at` fuera de la lista de la spec.** Sin ella el barrido no
   distingue «lo está construyendo alguien ahora» de «lo empezó un proceso que
   ya no existe», así que o nunca retoma o duplica trabajo. La spec describe la
   forma de la tabla, no el mecanismo de reanudación que ella misma exige.
3. **Techo de 250 000 mensajes en el camino asíncrono** (`ASYNC_MESSAGE_LIMIT`).
   La spec solo pone tope al síncrono, pero el documento se construye entero en
   memoria antes de subirlo: sin techo, una cuenta con años de historial tumba
   el proceso y con él la bandeja de todas las demás. Por encima, el job queda
   `failed` con un texto que dice cómo partirlo (`from`/`to`), nunca un archivo
   incompleto que parezca completo.
4. **El CSV lleva `conversation_id` como primera columna**, además de las diez
   de la spec: un export de varias conversaciones sin ella es un montón de
   mensajes sin dueño. El JSON conserva el anidamiento.
5. **El cuerpo del camino síncrono es el archivo, no el sobre `{data}`.** Es lo
   que pide «como descarga»; los errores sí van en el sobre, y las cabeceras
   transversales (`no-store`, `X-Request-Id`) se piden a `v1Headers` igual que
   en el resto.
6. **Cupo del barrido de exportaciones: 5 por vuelta, 1 por cuenta, en serie.**
   La spec dice «mismo barrido, cupo aparte» sin números. Se eligieron estos
   porque cada export lee miles de filas y sube un archivo; reutiliza
   `selectFairBatch` de a7.4 para el reparto por cuenta.
7. **La respuesta del cron gana un bloque `exports` aditivo** en vez de mezclar
   los contadores con los de las entregas, para que un programador que solo leía
   `delivered` siga leyendo lo mismo.
8. **El cubo de rate limit se comprueba después de validar el cuerpo** en el
   POST: un JSON mal formado no gasta una de las diez del cliente.

## Verificaciones manuales pendientes

Ninguna que dependa de un servicio externo (no hay Meta ni PayPal en esta
feature). Lo único que un test con dobles no puede afirmar es que Supabase
Storage caduque la firma de verdad a los 15 minutos; guion, si se quiere
comprobar en un entorno con Storage real:

1. `POST /api/v1/exports` con `{"format":"csv"}` y una clave con
   `conversations:export`; anotar el `id`.
2. `GET /api/v1/exports/{id}` hasta ver `status: "done"`; copiar
   `download_url`.
3. `curl -I "<download_url>"` → 200 y el archivo descarga.
4. Esperar 16 minutos y repetir el `curl` → 400/403 de Storage (firma
   caducada).
5. `GET /api/v1/exports/{id}` otra vez → `download_url` distinta, que vuelve a
   funcionar.

## Variables de entorno

**Ninguna nueva.** El barrido reutiliza `WEBHOOK_CRON_SECRET` de a7.4, ya
documentada. Se añadió a `docs/docker.md` la nota de que ese mismo cron termina
las exportaciones cortadas y purga a los 7 días, con cupo aparte.
`.env.local.example` no se tocó (está bloqueado por permisos) y tampoco hacía
falta.

## Deuda detectada fuera de mi alcance (no tocada)

1. **Un export asíncrono se construye entero en memoria.** Con el techo de
   250 000 mensajes está acotado, pero lo correcto a futuro es escribir en
   streaming al bucket. Cambiar eso implica tocar el contrato de `renderExport`
   y no cabía en esta feature.
2. **El barrido y la purga de `export_jobs` corren sin filtro de cuenta**, como
   los de `webhook_deliveries`: son barridos entre cuentas por definición. Hoy
   no necesitan waiver en la suite de aislamiento porque el cron de webhooks no
   está cubierto por ella; si algún día se añade esa ruta a la suite, harán
   falta dos waivers (`export_jobs` select por `status`, delete por
   `expires_at`).
3. **`purgeExpiredExports` borra como mucho 200 filas por barrido** y aborta el
   borrado de filas si Storage falla al retirar los objetos: es la dirección
   segura (no perder el rastro de un archivo que sigue ahí), pero significa que
   un bucket con un problema persistente acumula filas caducadas hasta que se
   arregle.
4. **El panel no muestra las exportaciones.** La spec §5 solo pide API; quien
   quiera verlas desde Ajustes necesita una pantalla que no está en esta fase.
5. **El tope del síncrono se paga con dos consultas** (un `count` y luego la
   lectura). Es deliberado —no cargar 10 001 mensajes para descubrir que no
   caben— pero deja una carrera benigna: si entran mensajes entre el recuento y
   la lectura, el archivo puede llevar unos pocos más del tope.
