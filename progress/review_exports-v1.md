# Review — a7.5 exports-v1

**Veredicto:** APPROVED

Rama `api/exports`, worktree `.claude/worktrees/api-exports`, base `6b0d768`.
Commits revisados: `670a2ec`, `67b8bbb`, `d821676`, `8ed0ecc`.
`git diff 6b0d768..HEAD --stat`: 22 archivos, +3641/-3. Coincide con el informe
(el informe no omite nada ni declara nada que no esté en el diff).

## Compuerta

Ejecutada por mí, en el worktree, los cuatro comandos por separado y en primer plano.

- `npm run lint` — **verde**. 0 errores, 35 avisos, todos preexistentes (ninguno en
  `src/lib/exports/**` ni en `src/app/api/v1/exports/**`).
- `npm run typecheck` — **verde**, sin salida.
- `TZ=UTC npm test` — **verde**. 178 archivos, 2 328 tests, 0 fallos.
- `npm run build` con las variables dummy de `docs/harness.md` — **verde**
  (`Compiled successfully in 34.1s`). Registra `/api/v1/exports`,
  `/api/v1/exports/[id]` y `/api/v1/conversations/[id]/export`.

**replay-migrations: verde.** `KEEP=1 scripts/replay-migrations.sh "$(pwd)"` aplica
001–063 (`ok 063_export_jobs.sql`), `verify-schema.sql: OK`, salida 0.
Idempotencia comprobada a mano: re-aplicar `063_export_jobs.sql` sobre la misma base
solo emite `NOTICE ... already exists, skipping` y `verify-schema.sql` vuelve a pasar.

`progress/checks_exports-v1.sql` re-ejecutado por mí contra ese contenedor: los cinco
bloques verdes (A CHECKs + retención de 7 días, B RLS de lectura por cuenta y escritura
solo del rol de servicio, C bucket privado con tope y cero políticas de
`storage.objects`, D reclamo optimista exclusivo, E cascadas).

## Trazabilidad criterio ↔ test

Criterios de `spec_api-publica.md` §5.

- C1 «Tests de ambos caminos con Storage simulado»:
  - [x] Síncrono json/csv: `src/app/api/v1/conversations/[id]/export/route.test.ts` ›
    "json: descarga con el documento y las cabeceras de v1" (verifica
    `Content-Disposition`, `no-store`, `X-Request-Id` y las **once** claves estables) y
    "csv: cabecera, una fila por mensaje y escape del texto peligroso".
  - [x] Asíncrono con Storage simulado: `src/app/api/v1/exports/route.test.ts` ›
    "202 con el encargo en queued y el scope correcto" y "after() construye el archivo y
    deja el encargo en done" (afirma `db.storageObjects === [{bucket:'exports',
    path:'acct-a/<id>.json'}]`, no solo que no lanzó).
  - [x] Tope 10 000 → 409: idem síncrono › "por encima del tope manda al encargo
    asíncrono, sin leer los mensajes". El doble solo intercepta el `select(..., {head:true})`
    y devuelve `SYNC_MESSAGE_LIMIT + 1`; el 409 solo puede venir del recuento. Leído en el
    código: `countConversationMessages` (`conversations.ts:208`) usa `head: true` y la ruta
    lo llama antes de `fetchConversationMessages` (`route.ts:88` vs `:98`).
- C2 «CSV con escape correcto (comas, comillas, saltos de línea, celdas que empiezan
  por `=`)»:
  - [x] `src/lib/exports/csv.test.ts` › "entrecomilla las comas", "entrecomilla y duplica
    las comillas dobles", "entrecomilla los saltos de línea (LF y CRLF)", "neutraliza la
    celda que empieza por %s" (`=`,`+`,`-`,`@`), "también tras un tabulador o un retorno de
    carro iniciales", "el prefijo va DENTRO de las comillas cuando la celda las necesita".
    Contrastado con `csv.ts:42` (`FORMULA_STARTERS` incluye `\t` y `\r`) y `csv.ts:68` (el
    prefijo se aplica **antes** del entrecomillado).
  - [x] Extremo a extremo por HTTP: ruta síncrona › csv, que afirma
    `"'=1+1, ""ojo"""` en la línea del mensaje.
- C3 «Fuga: conversación ajena → 404; job ajeno → 404; el filtro nunca sale de
  `account_id`»:
  - [x] `src/lib/security/tenant-isolation.test.ts` › "export síncrono: la conversación de
    B → 404; la propia baja con sus mensajes" (además recorre el CSV entero buscando los
    ids de B).
  - [x] idem › "encargos: la lista es de A, el de B → 404 y el archivo se construye solo
    con datos de A" — encola, drena el `after()` y comprueba que la fila resultante es de A
    y que `file_path` empieza por `A/`.
  - [x] idem › "el filtro de un encargo no puede ampliar el alcance a otra cuenta":
    `filters:{account_id:B, contact_id:'contact-b'}` → `params` guardados sin `account_id`
    y `row_count = 0`.
  - [x] `src/lib/exports/jobs.test.ts` › "el archivo solo contiene lo de su cuenta"
    (el cuerpo subido no contiene "secreto de B" ni `conv-b`) y "reclamar nombrando otra
    cuenta no toca la fila (fuga)".
  - [x] El `afterEach` de auditoría de rol de servicio de la suite pasa sin waivers nuevos.
- C4 «URL firmada caduca y no se persiste»:
  - [x] `src/app/api/v1/exports/[id]/route.test.ts` › "done: URL firmada de 15 minutos,
    acuñada ahora y no guardada" — afirma el delta exacto de 900 s y que la fila no
    contiene `token=` ni `signedUrl`; "cada llamada acuña una firma nueva y no reutiliza la
    anterior"; "la ruta dentro del bucket nunca sale en la respuesta"; "un fallo al firmar
    no devuelve un enlace roto: 500".
  - [x] `src/lib/exports/jobs.test.ts` › "acuña una URL de 15 minutos y no escribe nada en
    la fila" (comprueba que firmar no genera **ninguna** entrada en el log de escrituras).
- C5 «Replay verde con aserción en `verify-schema.sql`»: [x] ver Compuerta; las aserciones
  cubren tabla, `started_at`, `expires_at NOT NULL`, los tres CHECK, los tres índices (el
  parcial se afirma como parcial), RLS activa, la política de SELECT, la **ausencia** de
  políticas de escritura, el bucket y la ausencia de políticas de `storage.objects` que lo
  nombren.

Extras del implementer (fuera de los criterios del spec, verificados igualmente):

- `media_url` como `storage://<bucket>/<path>` — `conversations.ts:118` y su test en
  `conversations.test.ts`; documentado en `docs/public-api.md` y en la cabecera del módulo.
- `started_at` y reanudación — `jobs.test.ts` › "retoma lo que quedó en queued y lo que
  murió en running", "no le quita el trabajo a un running reciente", "un encargo por cuenta
  y barrido…", "respeta el tope del lote", "un fallo de lectura no lanza".
- Purga a 7 días — "borra primero el archivo y después la fila, y solo lo caducado" y "si
  el borrado del archivo falla, la fila sobrevive para el siguiente barrido".
- Cron de a7.4 — `src/app/api/webhooks/cron/route.test.ts` › "las entregas no dependen de
  las exportaciones: el bloque exports es aditivo". El diff de `route.ts` es puramente
  aditivo (`{...swept, purged, exports:{...}}`) y las entregas se barren **antes** que las
  exportaciones.
- Techo de 250 000 → `failed`: **parcial**, ver hallazgo 1.

## Checkpoints

- CP1 Compuerta: [x] los cuatro comandos ejecutados por mí, verdes.
- CP2 Migraciones: [x] 063 con el número del spec, idempotente (`IF NOT EXISTS`,
  `DROP POLICY IF EXISTS`+`CREATE POLICY`, `ON CONFLICT DO UPDATE`), re-aplicada a mano sin
  error, aserciones por objeto nuevo en `verify-schema.sql`, replay 0. El único
  `ON DELETE CASCADE` es `account_id → accounts(id)`, que borra encargos al borrar la
  cuenta dueña (justificado y verificado en el bloque E del SQL); `api_key_id` es
  `ON DELETE SET NULL` para no perder el encargo al borrar la clave.
- CP3 Aislamiento: [x] las tres rutas filtran `.eq('account_id', ctx.accountId)`
  (`conversations/[id]/export/route.ts:79`, `exports/route.ts:50`,
  `exports/[id]/route.ts:37`); `createExportJob` escribe `account_id`;
  `claimExportJob`, `markFailed` y el UPDATE de cierre llevan `.eq('account_id', …)`;
  `buildConversationsDocument` recibe `job.account_id` de la fila, **nunca** de `params`, y
  `fetchConversations` pone el `.eq('account_id', …)` siempre. `fetchConversationMessages`
  filtra por `conversation_id` porque `messages` **no tiene columna `account_id`**
  (`001_initial_schema.sql:163`) y es tabla hija declarada en `CHILD_TABLES` de
  `service-role-audit.ts`; los ids vienen de una consulta ya acotada por cuenta. Tests de
  fuga en los tres caminos. El barrido y la purga del cron son entre cuentas por definición,
  igual que los de `webhook_deliveries` de a7.4, y el implementer lo anota como deuda.
- CP4 Tests: [x] cada criterio con su `it`, leído; SQL de base real en
  `progress/checks_exports-v1.sql`, re-ejecutado por mí.
- CP5 Sin dependencias: [x] `package.json` no aparece en el diff.
- CP6 i18n: n/a — la feature no añade UI; `messages/*.json` no se tocan.
- CP7 Next 16: [x] `after` importado de `next/server` y llamado dentro de un Route Handler
  con callback async, tal como describe
  `node_modules/next/dist/docs/01-app/03-api-reference/04-functions/after.md` (leído, no de
  memoria). Ese mismo documento advierte que `after` corre dentro del `maxDuration` de la
  ruta: aquí eso está cubierto por el barrido del cron, que es justo el mecanismo que la
  spec pide.
- CP8 Alcance: [x] 22 archivos, todos justificables por §5. Los compartidos con otras
  features (`scopes.ts` +2 líneas, `rate-limit.ts` +1 entrada, `webhooks/cron/route.ts`
  aditivo, `tenant-isolation.test.ts` al final del bloque de `/api/v1`, CHANGELOG y docs)
  están localizados y no reordenan nada: la integración sobre `api/recursos` (a7.2+a7.3+064)
  debería resolverse con conflictos triviales.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) con aviso de migración 063;
  `docs/docker.md` con el papel del cron (ninguna variable nueva); `docs/public-api.md`
  con los cuatro endpoints, el cubo, `storage://` y el prefijo del CSV;
  `progress/impl_exports-v1.md` coincide con el diff.
- CP10 Git: [x] cuatro commits en `api/exports`, en español, con prefijo
  (`feat:`/`test:`/`docs:`) y `Co-Authored-By`. Árbol limpio, nada pusheado, `main` sigue en
  `3b82698`.
- CP11 Lo entrante nunca se bloquea: [x] nada de esta feature toca el webhook de WhatsApp;
  el único cambio en un cron es aditivo y posterior al barrido de entregas.

## Hallazgos (archivo:línea) — ninguno bloqueante

1. `src/lib/exports/jobs.ts:367-380` — la rama que convierte `ExportTooLargeError` en
   `failed` con el texto accionable **no tiene test**. Sus dos mitades sí (que
   `buildConversationsDocument` lanza: `conversations.test.ts` › "pasado el techo de memoria
   lanza en vez de dar un export a medias"; y que el mensaje dice cómo partirlo:
   "el mensaje del techo dice cómo partir el export y no expone SQL"), pero ningún test
   hace que `runExportJob` capture esa excepción y deje la fila `failed` con
   `err.message`. El fixture `job-failed` de `exports/[id]/route.test.ts:64` es una fila
   sembrada a mano, no una prueba de ese camino. No bloquea: el techo de 250 000 es una
   decisión propia del implementer, no un criterio del spec, y el código es de lectura
   directa. Conviene cerrarlo en a7.6 o al integrar.
2. `src/lib/exports/jobs.ts:70` — `EXPORT_STALE_MS = 10 min` frente a
   `ASYNC_MESSAGE_LIMIT = 250 000`. Un export en el techo son ≥250 páginas de mensajes más
   una consulta por conversación; puede pasar de diez minutos contra una base real, y
   entonces el barrido lo reclama mientras el primer proceso sigue vivo y el archivo se
   construye dos veces. No hay fuga ni corrupción (misma ruta, `upsert: true`, misma
   cuenta; el cierre es idempotente), solo trabajo duplicado. Deuda a vigilar cuando haya
   volumen real, o a resolver atando el plazo al tamaño del job.
3. `src/app/api/v1/conversations/[id]/export/route.ts:57` — el cubo de 10/hora se consume
   **antes** de resolver la conversación, así que diez 404 seguidos dejan a la cuenta sin
   exportaciones esa hora. En el POST el orden es el contrario (validar y luego cobrar,
   decisión 8 del informe). Es una incoherencia menor entre los dos caminos, no un fallo.
4. `src/app/api/v1/conversations/[id]/export/route.ts:106` — el `filename` interpola el
   `{id}` de la URL sin sanear. Hoy es inalcanzable (un id que no sea uuid muere en el
   `.eq('id', id)` con 500 antes de llegar aquí), pero el día que la ruta acepte otro
   identificador conviene escapar las comillas del `Content-Disposition`.
5. `CHANGELOG.md:159` — la entrada mete `Requires migration 063.` y la frase para
   self-hosters en la misma línea larga, contra el ritmo del resto del archivo. Cosmético;
   arreglar al integrar si se pasa prettier.

## Cambios requeridos

Ninguno.
