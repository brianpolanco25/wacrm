# Review — p6.5 whatsapp-bsuid

**Veredicto:** APPROVED

Rama `saas/producto`, worktree `.claude/worktrees/producto`, base `9d10709`, HEAD `50c9758`
(5 commits, 48 archivos, +3356/−844). El diff coincide con lo que dice
`progress/impl_whatsapp-bsuid.md`: los cinco hitos del informe están en los cinco commits y
no hay nada en el árbol sin commitear.

## Compuerta

Ejecutada por mí, paso a paso, en el worktree:

- `npm run lint`: **verde** — 0 errores, 35 avisos. Los 35 son preexistentes; el único que
  cae en un archivo de la feature (`src/lib/whatsapp/send-message.test.ts:189`, `_args` sin
  usar) ya estaba en `9d10709` (comprobado con `git show`).
- `npm run typecheck`: **verde**.
- `TZ=UTC npm test -- --reporter=dot`: **verde** — 151 archivos, 2065 tests, 0 fallos.
- `npm run build` con las variables dummy de `docs/harness.md`: **verde**.
- `scripts/replay-migrations.sh`: **verde** — 001…060 aplicadas en orden sobre base limpia y
  `verify-schema.sql: OK`.
- `progress/checks_whatsapp-bsuid.sql`: **ejecutado por mí** contra el Postgres del harness
  (`KEEP=1`, `psql -v ON_ERROR_STOP=1`, salida 0). Los 9 CHECK dan OK, incluidos los tres que
  pedía el encargo: CHECK 1 (alta por BSUID sin teléfono, `phone_normalized` NULL), CHECK 5
  (contacto por teléfono que recibe su BSUID: una sola fila con las dos identidades),
  CHECK 7/8 (`check_violation` al insertar y al actualizar una fila sin ninguna identidad).
  CHECK 3 y 4 cierran el índice: BSUID duplicado en la misma cuenta rechazado (23505), el
  mismo BSUID en otra cuenta aceptado. Todo dentro de una transacción con `ROLLBACK`.

## Trazabilidad criterio ↔ test

Tests leídos uno a uno, no solo localizados.

Criterios de `progress/spec_producto.md` §5:

- C1 «Un entrante sin `from` pero con `from_user_id` crea contacto y conversación y aparece
  con su `@username`; responder envía con `recipient`»: [x]
  `src/app/api/whatsapp/webhook/route.test.ts:1136` › «un entrante sin `from` pero con
  `from_user_id` crea contacto, conversación y mensaje» (afirma `phone: null`,
  `wa_user_id`, `wa_username` y que el mensaje se guarda), `:1156` › «sin nombre de perfil,
  el contacto se llama «@usuario»», `:1271` › «el BSUID llega solo en `contacts[].user_id`
  y basta»; el envío, en `src/lib/whatsapp/send-message.test.ts:640` › «responde con
  `recipient` cuando el contacto solo tiene BSUID» (comprueba `args.recipient` y
  `args.to === undefined`); la presentación, en `src/lib/contacts/display.test.ts` (12
  tests: teléfono → `@usuario` → null, y el BSUID nunca se enseña).
- C2 «Un contacto existente por teléfono recibe su BSUID sin duplicarse; y uno creado por
  BSUID recibe el teléfono»: [x] `route.test.ts:1170` (0 inserts, 1 update con filtros
  `{id, account_id}`), `:1211` (el teléfono se completa), `:1243` (no pisa un teléfono ya
  guardado). Contra base real, CHECK 5 y CHECK 6 del SQL.
- C3 «Los estados se casan por `recipient_user_id` cuando no hay `recipient_id`»: [x]
  `route.test.ts:1371` › «un estado sin `recipient_id` avanza la fila de difusión
  igualmente» y `:1390` › «con varias filas para el mismo wamid, gana la del destinatario
  del evento» (el BSUID resuelve a `contact-2` y se actualiza `rcpt-mio`, no `rcpt-otro`).
- C4 «No rompe el camino con teléfono ni bloquea lo entrante (CP11)»: [x] los 2065 tests
  (incluida toda la batería previa del webhook con teléfono) pasan, y `route.test.ts:1288`
  › «un mensaje sin ninguna identidad se descarta sin tumbar el resto del lote» afirma
  `stored === ['wamid.GOOD']` con respuesta 200.

Encargo del líder, puntos adicionales:

- Migración 060 (columnas, índice único parcial, `phone` nullable, CHECK, sin CASCADE): [x]
  `supabase/migrations/060_whatsapp_bsuid.sql` + 7 aserciones nuevas en
  `supabase/ci/verify-schema.sql` (incluida «el índice debe ser UNIQUE **y** parcial» y que
  el cuerpo de `filter_contacts_by_tags` siga nombrando `wa_username`).
- Las cinco familias `send*` con `{to?, recipient?}`: [x] `src/lib/whatsapp/meta-api.test.ts`
  › describe «destinatario del envío», 5 tests: solo `to`, solo `recipient`, los dos a la
  vez, error **antes** de la red sin ninguno (`expect(bodies).toHaveLength(0)`), y el quinto
  recorre texto/media/plantilla/reacción/interactivos (botones y lista) comprobando
  `recipient` en los 5 cuerpos.
- Regla de identidad y lista de intentos: [x] `src/lib/whatsapp/recipient.test.ts` (12
  tests). Verificado en código: un solo intento por BSUID, variantes de prefijo troncal solo
  por teléfono, y la autocorrección del número solo cuando `recipient.kind === 'phone'`
  (`send-message.ts`, `flows/meta-send.ts`, `automations/meta-send.ts`).
- Difusiones con destinatarios sin teléfono: [x] `broadcast-core.test.ts` › «acepta
  `to_user_id` y planifica el envío por `recipient`», «con teléfono y BSUID …manda el
  teléfono», «rechaza un BSUID con formato imposible, sin tumbar la campaña» (rejected=1,
  planned=1) y «envía por `recipient` en la entrega». La reanudación
  (`broadcast-resume.ts:205-224`) marca «no entregable» solo cuando fallan las dos
  identidades, con el mensaje de error actualizado.
- `/api/v1/messages` con `to` o `to_user_id`: [x] `resolve-conversation.test.ts` › describe
  «resolveConversationForTarget — BSUID» (5 tests: rechazo del formato sin tocar la base,
  falta de ambos, hallazgo por BSUID sin crear, alta sin teléfono, y «con teléfono y BSUID
  busca por teléfono»). Documentado en `docs/public-api.md` (sección «Writing to somebody
  whose number you do not have», más `wa_username`/`wa_user_id` en `GET /api/v1/contacts` y
  `to_user_id` en `POST /api/v1/broadcasts`).
- Búsqueda por username en los tres sitios: [x] consulta de la lista
  (`contacts/page.tsx:176-186`, `wa_username.ilike` con la arroba recortada), RPC
  `filter_contacts_by_tags` (migración 060, `ltrim(p_search,'@')`) — comprobado contra base
  real en CHECK 9 con «brun» y «@bruno» — y filtro en cliente
  (`contactMatchesSearch`, con test de que «@» suelto no hace coincidir a todos).
- Exportaciones con teléfono nulo: [x] `broadcasts/[id]/page.tsx:218-222` escribe
  `contactHandle(...) ?? ''` en el CSV (la columna no desaparece) y `t('noPhone')` en la
  tabla.

## Checkpoints

- CP1 Compuerta: [x] los cuatro pasos en verde, ejecutados por mí.
- CP2 Migraciones: [x] 060 era el número libre; idempotente (`ADD COLUMN IF NOT EXISTS`,
  `CREATE UNIQUE INDEX IF NOT EXISTS`, `ADD CONSTRAINT` dentro de un `DO` que consulta
  `pg_constraint` porque PG17 no admite `IF NOT EXISTS` ahí, `CREATE OR REPLACE FUNCTION`);
  ningún `DROP`, ningún `CASCADE`; aserción por objeto nuevo en `verify-schema.sql`; replay 0.
  Los objetos que asumían `phone NOT NULL` están revisados y el razonamiento se comprueba
  contra base real: `phone_normalized` generada da NULL (CHECK 1), y el índice único parcial
  de la 022 (`WHERE phone_normalized <> ''`) deja fuera a las filas sin teléfono, así que
  conviven varias (CHECK 2).
- CP3 Aislamiento: [x] y además **mejora**. Verificado el agujero preexistente que declara el
  informe: en `9d10709` `handleStatusUpdate` hacía
  `.from('messages').update({status}).eq('message_id', status.id)` y
  `.from('broadcast_recipients')…maybeSingle()` por `whatsapp_message_id`, **sin cuenta**, con
  `wamid` que la migración 009 documenta como no único entre números. Ahora la configuración
  se resuelve una vez por `change` (`route.ts:362-376`), las dos lecturas se acotan
  (`.eq('conversations.account_id', …)` / `.eq('broadcasts.account_id', …)`) y la escritura va
  por ids ya resueltos. `findContactByWaUserId` (`dedupe.ts`) filtra siempre por `account_id`
  y `patchContact` añade `.eq('account_id', …)` al `UPDATE` del contacto, que antes iba solo
  por `id`. Tests de fuga leídos: `tenant-isolation.test.ts` › «un entrante por BSUID en el
  número de A casa con el contacto de A, no con el de B (mismo wa_user_id)», «un estado de
  entrega del wamid compartido solo mueve la fila de A» y «POST /messages con `to_user_id`
  escribe al contacto de A, no al de B». Los tres corren sobre `fake-supabase.ts`, que sí
  aplica los filtros con punto sobre embeds (`getPath`/`matches`), y el `afterEach` global
  (`unscopedServiceRoleQueries`, línea 1083) audita todas las consultas de rol de servicio
  que estos casos ejercitan sin waivers nuevos.
- CP4 Tests: [x] ver trazabilidad. SQL de base real ejecutado; guion manual de Meta presente
  y utilizable (6 pasos + difusión, con preparación y resultado esperado por paso).
- CP5 Sin dependencias nuevas: [x] `package.json` no aparece en el diff.
- CP6 i18n: [x] clave `noPhone` añadida en los seis mismos espacios de nombres de
  `messages/es.json`, `en.json` y `ko.json` («Sin número» / «No number» / «번호 없음»). Sin
  placeholders ICU, nada que desalinear.
- CP7 Next 16: [x] no se estrena API de framework; `after()` de `next/server` y las firmas de
  los manejadores quedan como estaban (los cambios son del cuerpo hacia dentro). El build lo
  confirma.
- CP8 Alcance: [x] con una nota. Los 48 archivos se explican por §5: migración + verify-schema,
  webhook, los cuatro caminos de salida, bandeja/contactos/difusiones, API pública y
  documentación. `src/app/api/whatsapp/react/route.ts` está fuera del guion literal del líder
  pero es un envío más y sin tocarlo reaccionar a un contacto sin teléfono devolvía 400: el
  informe lo declara. La deuda detectada (5 puntos, incluido `notify_conversation_assigned()`
  de la 027 y `POST /api/v1/contacts`, que sigue exigiendo `phone`) está anotada, no arreglada.
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) con entrada en Added, otra en Fixed por
  el recibo de entrega y aviso de «Migration required» que menciona el `phone` nullable como
  ruptura para integraciones; `docs/public-api.md` actualizado; sin variables de entorno
  nuevas, así que `docs/docker.md` no cambia; el informe existe y coincide con el diff.
- CP10 Git: [x] 5 commits en `saas/producto`, en español, con prefijo y `Co-Authored-By`;
  nada pusheado (no hay remoto para la rama); `feat/saas-multiempresa` sigue en `9d10709`,
  que es la base de la feature.
- CP11 Lo entrante nunca se bloquea: [x] `value.contacts` deja de ser obligatorio para
  procesar el lote (antes su ausencia descartaba el `change` entero); un mensaje sin ninguna
  identidad se registra y se salta **ese** mensaje; los `UPDATE` de casado son best-effort
  (un 23505 se registra y el mensaje se guarda igual); `sanitizeBsuid` es permisiva a
  propósito para que un prefijo nuevo de Meta no pierda un entrante. Test leído arriba.

## Hallazgos (archivo:línea)

Ninguno bloqueante. Los tres son de calidad, no de corrección ni de aislamiento.

1. `src/lib/whatsapp/resolve-conversation.ts:96` y `src/lib/api/v1/contacts.ts:160` — el
   formato del BSUID solo se valida **cuando no hay teléfono válido**. Un llamante de la API
   pública que mande `to` correcto y un `to_user_id` basura no recibe error, y si el contacto
   se crea, la basura se escribe tal cual en `contacts.wa_user_id`
   (`resolve-conversation.ts:156`, `contacts.ts:185`). Consecuencia: una fila ocupa un valor
   inventado en el índice único de la 060, y cuando llegue el BSUID real de esa persona el
   `patchContact` del webhook chocará (23505) y lo dejará sin guardar — en silencio, salvo el
   log. Recomendación para una feature futura: `if (waUserId && !isValidBsuid(waUserId))
   throw` con independencia del teléfono.
2. `src/app/api/whatsapp/webhook/route.ts:391` — `value.contacts?.[i] ?? value.contacts?.[0]`
   empareja mensaje y contacto **por posición**. Es preexistente (igual en `9d10709`), pero
   ahora esa entrada es además una fuente de identidad (`contact?.user_id` / `contact?.wa_id`,
   líneas 833-835): en un lote con varios remitentes y un `contacts[]` desalineado, un mensaje
   al que le falte `from_user_id` podría atribuirse al contacto equivocado **dentro de la misma
   cuenta**. Riesgo bajo (Meta manda `from_user_id` siempre, que es lo que se prueba primero) y
   sin implicación de tenencia, pero el emparejamiento correcto sería por `wa_id`/`user_id`.
3. `src/app/api/whatsapp/webhook/route.test.ts:1409` — el test «el espejo sobre `messages` se
   acota a las filas de la cuenta» promete más de lo que afirma: el doble de `messages` de ese
   archivo ignora la columna de los `.eq()`, así que lo que prueba es que el `UPDATE` sale por
   `.in('id', …)` en vez de por `message_id` suelto. La acotación real por cuenta sí está
   probada, pero en `tenant-isolation.test.ts` («un estado de entrega del wamid compartido solo
   mueve la fila de A»), que corre sobre un doble que sí aplica filtros. No falta cobertura;
   sobra nombre.

Nota menor de alcance: `src/components/contacts/contact-form.tsx` y `src/lib/contacts/dedupe.ts`
traen reformateo de prettier ajeno a §5 (comillas, saltos). Ruido inocuo, pero engorda el diff.

## Cambios requeridos

Ninguno.
