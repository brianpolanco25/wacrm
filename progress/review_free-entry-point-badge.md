# Review — p11.6 free-entry-point-badge

**Veredicto:** APPROVED (sujeto a lo que queda pendiente contra base real y al `build` del líder; ver «Sin verificar»)

Rama `pmd/entry-point`, HEAD `dfaf8f6`, base `be8ca0f` (4 commits: 21949d0, 61e46a4, 5bc3284, dfaf8f6).
El diff (19 archivos) coincide con el informe. `21949d0` es solo prettier: lo comprobé pasando prettier a la
versión base de `conversation-list.tsx` y `message-thread.tsx`, y sale idéntica. Prettier `--check` está en verde en
todos los TS/JSON tocados. `package.json` y el lockfile no cambian.

## Compuerta
- lint: verde (0 errores, 34 avisos que ya estaban en la base)
- typecheck: verde
- test (`TZ=UTC npm test`, una pasada): verde, 271 archivos y 3884 tests
- build: no lo corrí, por orden del líder (lo corre sobre la rama integrada)
- replay-migrations: n/a (Docker apagado por orden del humano)

## Revisión manual del SQL (sustituye a la réplica)
`supabase/migrations/082_conversation_entry_point.sql`:
- [x] Es idempotente: cuatro `ADD COLUMN IF NOT EXISTS` y cada CHECK va dentro de un `DO` con `IF NOT EXISTS` sobre `pg_constraint` (conrelid + conname).
- [x] No es destructivo: sin `DROP`, `CASCADE`, `UPDATE` ni backfill.
- [x] Hay `SET lock_timeout = '5s'` antes de los `ALTER TABLE conversations` y `RESET` al final. Las columnas no llevan DEFAULT (no hay reescritura) y los CHECK son `NOT VALID` (no recorren la tabla). Cumple R4.
- [x] El CHECK de ventana (`free_window_until <= entry_point_at + 72 h`, con NULL si no hay entrada) cuadra con `computeEntryPoint`, que escribe justo +72 h al milisegundo.
- [x] No lleva índice: el spec lo descarta a propósito (design.md §Migración) porque la insignia se lee de la fila ya cargada.
- [x] `verify-schema.sql`: el bloque `-- 082 -- … -- /082 --` está dentro del `DO`, después del `/079`. Comprueba las cuatro columnas (tipo, anulables, sin default) y los dos CHECK (`contype = 'c'`). No comprueba `convalidated = false`; eso queda en `checks_…sql`.

### Sin verificar contra base real (pendiente con Docker)
- El replay 001–082 y la segunda aplicación de la 082 (idempotencia real, R1).
- Que el bloque 082 de `verify-schema.sql` se ejecute sin error.
- `progress/checks_free-entry-point-badge.sql` (está escrito y lo leí; no se ejecutó). Cubre R2 (23514 con `'foo'`), R3 (los dos casos que fallan y las 72 h exactas que pasan), R4 (`convalidated = false`) y la semántica SQL de los filtros de R11/R16.
- Que PostgREST haga bien el `.eq('entry_point_at', previousAt)` con el formato de `timestamptz` que devuelve el `select('*')` (`+00:00`, microsegundos). Los tests usan un cliente falso.
- `npm run build`.

## Trazabilidad criterio ↔ test
- R1 «4 columnas, idempotente»: [x] aserción en `verify-schema.sql` 082 (sin ejecutar)
- R2 «CHECK de origen»: [x] `checks_free-entry-point-badge.sql` (sin ejecutar)
- R3 «CHECK de ventana ≤ 72 h»: [x] `checks_…sql`, dos casos que fallan y uno de 72 h exactas (sin ejecutar)
- R4 «sin reescritura, NOT VALID, lock_timeout»: [x] lo revisé a mano, y `checks_…sql` comprueba `convalidated`
- R5 «ad/post/otro»: [x] `src/lib/whatsapp/entry-point.test.ts` › «R5: source_type 'ad'…», «'post'…», «minúsculas y recortado», «otro valor o su ausencia»
- R6 «forma rara da null sin lanzar»: [x] ídem › «R6: %s devuelve null sin lanzar» (undefined, null, cadena, número, array, booleano)
- R7 «lista blanca, 500 caracteres»: [x] ídem › «R7: conserva solo la lista blanca…» (claves extra, 2000 caracteres, `source_id` numérico descartado)
- R8 «ad: +72 h, 5 min de margen»: [x] ídem › «R8: … 72 h exactas», «R8: acepta hasta 5 min…» (+300 s pasa; +301 s cae en R10)
- R9 «orgánico/otro sin ventana»: [x] ídem › «R9: orgánico…», «R9: ctwa_other…»
- R10 «timestamp inválido: hora de recepción»: [x] ídem › «R10: timestamp %s…» (11 formas). En el webhook: `route.test.ts` › «CP11/R10: un timestamp futuro…». El caso no numérico no llega al código nuevo por la deuda previa de `route.ts:1053` (ver H3).
- R11 «UPDATE id + account_id, solo si es más nuevo»: [x] `route.test.ts` › «R11: un referral de anuncio guarda ctwa_ad…» (comprueba la fila y los filtros `id`, `account_id`, `is(null)`), «R11: … más antiguo … no pisa», «R11: … más nuevo … filtro optimista». También `entry-point.test.ts` › recordEntryPoint (4 casos).
- R12 «una repetición no escribe»: [x] `route.test.ts` › «R12: una repetición de Meta…» (`messageUpsertResult = []`), «R12: el mismo payload dos veces escribe una sola vez»
- R13 «sin referral no escribe»: [x] `route.test.ts` › «R13: …»
- R14 «el fallo no corta el pipeline»: [x] `route.test.ts` › «R14: si el update … falla…» (comprueba la fila de `messages`, el bump, flujos, automatizaciones, IA, `message.received`, el 200 y que el log no lleva «hello» ni «Promo»), «R14: si el update lanza…». También `entry-point.test.ts` › tres casos de R14.
- R15 «solo lectura»: [x] `route.test.ts` › «R15: … manual_hold…» (`assertWritable` y `getEntitlements` nunca se llaman)
- R16 «fuga A↔B»: [x] `src/lib/security/tenant-isolation.test.ts` › «p11.6: un entrante con referral de anuncio por el número de A…». B tiene el mismo teléfono (`SHARED_PHONE`); el test comprueba que conv-a quedó escrita, que conv-b sigue en null, los filtros `account_id = A` e `id = conv-a`, y `expectBUnchanged`; el audit `unscopedServiceRoleQueries` corre en el afterEach.
- R17 «freeWindowUntil»: [x] `src/lib/inbox/free-window.test.ts` (fecha futura, pasada, igual a now, NULL/ausente/'', cadena inválida)
- R18 «insignia en la lista»: [x] `free-window-badge.test.tsx` (texto, `title`, `data-free-window`, icono). Revisé el montaje en el diff de 5bc3284 (`ConversationItem`, en la línea de `AttentionBadge` con `gap-2`).
- R19 «insignia en la cabecera»: [x] el mismo test, más el diff: va justo después del `<Badge>` de `sessionInfo`, con `hidden sm:inline-flex`.
- R20 «se apaga en menos de 60 s, un reloj por componente»: [x] `src/hooks/use-minute-clock.test.ts` con temporizadores falsos (59.999 ms no avanza y 60 s sí, la limpieza deja `getTimerCount() = 0`, sin acumular). Hay un `useMinuteClock()` en `ConversationList` y otro en `MessageThread`, ninguno por fila.
- R21 «managed/undefined sin insignia»: [x] `free-window.test.ts` › los dos casos R21
- R22 «claves es/en, `{until}`»: [x] `free-window-badge.test.tsx` › «%s tiene badge y tooltip…», además de `messages.test.ts` e `icu-safety.test.ts` en verde
- R23 «alcance»: [x] lo revisé en el diff: no toca `src/lib/api/v1`, `enforce.ts`, `entitlements.ts`, billing, automatizaciones, flujos, IA ni `inbox/page.tsx`
- Guion manual (anuncio CTWA real): [x] está en requirements.md §Guion manual y en el informe; pendiente para el humano

## Checkpoints
- CP1: [ ] parcial. Lint, typecheck y test en verde, ejecutados por mí; el `build` no se corrió por orden del líder.
- CP2: [x] archivo 082, idempotente, aserción en `verify-schema.sql`, sin CASCADE. La réplica es n/a con Docker apagado.
- CP3: [x] el único `update` nuevo con rol de servicio filtra `id` + `account_id` y tiene test de fuga A↔B
- CP4: [x] todos los R tienen un test leído, o SQL o guion
- CP5: [x] no hay dependencias nuevas (`Gift` sale de lucide-react, que ya está)
- CP6: [x] `Inbox.freeWindow.badge` y `.tooltip` están en es y en con `{until}`; sin `ko`
- CP7: [x] no usa ninguna API nueva de framework; `useFormatter` y `useTranslations` son de next-intl y ya se usaban
- CP8: [x] alcance correcto; la deuda está anotada sin arreglar
- CP9: [x] CHANGELOG Unreleased con aviso de migración; no hay variables de entorno nuevas; el informe coincide
- CP10: [x] 4 commits en español con prefijo y Co-Authored-By; nada pusheado
- CP11: [x] el enganche va después de la frontera `insertedRows` (`route.ts:1077`) y después del bump, en su propio `try/catch` (`route.ts:1112-1128`), antes de `reopenClosedConversation`. No hay `return` ni `throw` que corte el flujo. Los tests R12, R14 (error y excepción), los referral malformados y R15 lo prueban.

## Hallazgos (archivo:línea)
Ninguno bloquea. Salen del `code-review` a nivel high (contrastado) y de la lectura a mano.

1. `src/lib/inbox/free-window.ts:15-27`: la insignia sigue puesta las 72 h aunque el negocio no haya respondido en las primeras 24 h, que es la condición de S-E3 para que la ventana valga. El tooltip lo advierte («Si respondes en las 24 h…»). Es lo que fija el spec (design.md S-E3, tabla de claves), así que no lo achaco a la implementación, pero contradice el principio de «ante la duda, sin insignia». **Decisión del humano**: apagar la insignia a las 24 h si no hay saliente.
2. `src/lib/whatsapp/entry-point.ts:182-204`: un referral posterior orgánico o `ctwa_other`, o uno de anuncio con timestamp futuro (R10), pisa una ventana de anuncio todavía abierta y deja `free_window_until = NULL`. Cumple R9, R10 y R11 al pie de la letra y falla hacia el lado seguro (quita la insignia). Lo anoto para el guion manual.
3. `src/app/api/whatsapp/webhook/route.ts:1053`: deuda que ya estaba (está anotada en el informe). Con un `timestamp` no numérico o enorme, `toISOString()` lanza antes de llegar al código nuevo y el entrante se pierde, aunque el webhook responde 200. El CHANGELOG dice que un timestamp inválido «never makes the webhook fail». Es cierto si se refiere al 200, pero puede leerse como que el mensaje se guarda.
4. `src/lib/whatsapp/entry-point.ts:201-204`: con dos entrantes con referral simultáneos, el más nuevo puede no casar con el filtro optimista y descartarse sin log (0 filas no es un error para PostgREST). Es raro y lo acepta el diseño.
5. `src/hooks/use-billing-status.ts:139-150` (archivo que ya existía, fuera del diff): `status` no se limpia al cambiar `accountId`. Al entrar en una sesión de soporte, el `metaBilling` de la cuenta anterior puede verse durante un instante, hasta que resuelve la nueva lectura. La insignia de una cuenta `managed` podría aparecer un momento. Deuda fuera de alcance.
6. Limpiezas que no bloquean: el cálculo de la etiqueta está duplicado entre `conversation-list.tsx:369-379` y `message-thread.tsx:261-270`; `freeWindowDateTimeOptions()` construye un `Intl.DateTimeFormat` por fila y por render; el `try/catch` externo de `route.ts:1112` es redundante con el de `recordEntryPoint`, pero CP11 lo justifica como red de seguridad.

## Cambios requeridos
Ninguno. Antes del merge: el líder corre `build` y, con Docker encendido, el replay con la 082 aplicada dos veces más `checks_free-entry-point-badge.sql` (esperado: `NOTICE checks_free-entry-point-badge: OK`). El humano decide H1.
