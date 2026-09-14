# Review — f4.2 multi-number

**Veredicto:** APPROVED

Rama `saas/fase-4-multinumero` @ `09f71ba` (base `saas/integracion` @ `e6ceba2`), tres commits
(`ff3dca4`, `9b054ef`, `09f71ba`), 46 archivos. Worktree limpio, nada pusheado
(`git ls-remote origin saas/fase-4-multinumero` vacío); `main`, `dev` y `feat/saas-multiempresa`
intactos.

## Compuerta (ejecutada por mí, cada paso por separado)

| Paso | Resultado |
|---|---|
| `npm run lint` | **verde** — 0 errores, 38 avisos, todos preexistentes |
| `npm run typecheck` | **verde** — sin salida |
| `TZ=UTC npm test --reporter=dot` | **verde** — 121 archivos, 1585 tests, 0 fallos |
| `npm run build` (vars dummy de `ci.yml`) | **verde** — 58 páginas |
| `scripts/replay-migrations.sh "$(pwd)"` | **verde** — 040…053 y 056 `ok`, `verify-schema.sql: OK`, salida 0 |
| `progress/checks_multi-number.sql` | **verde** — ejecutado por mí con `KEEP=1` + `psql -v ON_ERROR_STOP=1`; los 7 bloques imprimen `OK` y el script cierra en `ROLLBACK` |

## Trazabilidad criterio ↔ test

Los dos criterios de `docs/saas/fase-4-plataforma.md` §1 que le tocan a f4.2 (los otros tres son
de f4.1).

- **C4 «Una empresa con varios números envía por el que elige…»**
  - Orden de resolución: [x] `src/lib/whatsapp/resolve-config.test.ts` › `1. an explicit config_id
    wins over everything else`, `2. otherwise the conversation's own number, not the default`,
    `3. a thread with no number sealed falls back to the default`, `3b.`, `4. with the default
    deleted by hand, the oldest survivor`, `5. an account with no numbers raises the message it
    always raised`. Leídos: usan `FakeDatabase`, que evalúa filtros y orden de verdad, y la
    cuenta B se siembra **primero** y es la más antigua, así que un `.eq('account_id')` perdido
    aparece como fila filtrada, no como test verde.
  - Fuga (CP3): [x] mismo archivo › `a config_id from another account is a 404, never that
    account's row`, `a conversation_id from another account never yields B's number`,
    `an account with no numbers does not inherit another account's`,
    `translates the public phone_number_id into this account's row id`.
  - Envío (§9 4b): [x] `src/lib/whatsapp/send-message.test.ts` › `sends through the conversation's
    own number, not the account default` / `sends through the number the caller named` /
    `a number that is not this account's is a 404, and nothing is sent`. El doble discrimina por
    id (`askedId`/`askedDefault`), así que distingue «número del hilo» de «predeterminado».
  - Difusiones (§9 4c): [x] `src/lib/whatsapp/broadcast-resume.test.ts` › `uses the campaign's
    frozen number even when another one is the default` (el fixture devuelve `null` si el id
    pedido no coincide: el test no puede pasar resolviendo al predeterminado), `falls back to the
    default for a campaign created before migration 053`, `names the cause when the number the
    campaign used was disconnected`. Lado escritura: ver hallazgo 2.
  - Auto-reparación CBC→GCM sin cruzar cuentas: [x] `resolve-config.test.ts` › `self-heals a
    legacy CBC ciphertext by id, scoped to the account` (afirma el filtro `account_id` en el log
    de escrituras y que la fila de B queda intacta).
- **C4b «…y recibe correctamente en todos»**
  - [x] `src/app/api/whatsapp/webhook/route.test.ts` › `stores messages arriving on either number
    of the same account` (dos entrantes a `pn-sales` y `pn-support` de la misma cuenta, los dos
    almacenados y en la **misma** conversación), `seals the conversation with the number the
    customer wrote to`, `does not rewrite the seal when the number has not changed`.
- **C5 «El modo autoalojado sigue funcionando»**
  - [x] `src/app/api/whatsapp/config/route.test.ts`: los `it` del archivo corren sin ninguna
    variable de plataforma; el camino manual (verificar → cifrar → registrar → guardar) sigue
    verde, incluidos los reajustados a `config_id`.
- **Tope `numbers` (plan §7)**
  - [x] `config/route.test.ts` › `a 1-number plan can re-save the number it already has` (empareja
    por `phone_number_id`, `updated` con `neq:id`, `inserted` nulo) y `lets a 1-number plan swap
    its number` (con `config_id`).
  - [x] `402s the same account on a SECOND, different number` — afirma `code`, `metric`, `limit`,
    `used`, `upgradeUrl` y que no hay ni insert ni update.
  - [x] `404s a config_id that is not one of the account rows`.
- **Rutas de configuración, fuga (extra de §9)**
  - [x] `src/lib/security/tenant-isolation.test.ts` › `GET lists only A's numbers`, `PATCH on B's
    number → 404 and B is untouched`, `DELETE on B's number → 404 and B still has it`, `PATCH
    renames A's own number and leaves B's default alone` (cubre que el «limpiar el predeterminado»
    de `promoteDefault` está acotado por cuenta), `DELETE ?id= on the collection route only removes
    A's row`, `DELETE without an id refuses rather than wiping every number` (400 y las 2 filas
    siguen ahí).
- **Base real**: `progress/checks_multi-number.sql`, 7 bloques, ejecutados por mí: dos números en
  una cuenta; el índice parcial rechaza el segundo predeterminado y acepta «limpiar y marcar»;
  `UNIQUE(phone_number_id)` sigue rechazando el número ajeno (#136); borrar un número deja vivas
  conversación y campaña con la columna a `NULL`; la 036 sigue imponiendo una conversación por
  contacto; la RLS de la 017 da los dos números al miembro y cero al de la otra cuenta.
- **Verificación manual**: `progress/impl_multi-number.md` §4 trae el guion de los pasos 6 y 7 del
  plan §10 (dos números reales, entrada/salida, pausa y reanudación con cambio de predeterminado).
  Correcto salvo el «Extra» — ver hallazgo 1.

## Comprobaciones pedidas

1. **Ningún `.single()` sobre `whatsapp_config`**: [x]. Clasifiqué las 32 apariciones de
   `from('whatsapp_config')` en `src/` por llamada terminal: **cero `.single()`** en todo el
   repositorio; `maybeSingle` solo en `resolve-config.ts` (pasos 1, 2 y `configIdForPhoneNumberId`),
   `config/[id]/route.ts:44` y el chequeo de conflicto entre cuentas. El resto son listas, cuentas
   (`count`), `update` y `delete`. El censo de 23 sitios del informe cuadra con el diff.
2. **Orden de resolución + `.eq('account_id')` en el paso explícito**: [x]
   `resolve-config.ts:116-131` (paso 1 con `id` **y** `account_id`), `:134-154` (paso 2, la
   conversación también acotada por cuenta), `:157-163` (predeterminado), `:166-173` (superviviente).
   Test de fuga leído arriba.
3. **Difusiones por `broadcast.whatsapp_config_id`**: [x] lectura en
   `broadcast-resume.ts:219-247` y en el lote de `api/whatsapp/broadcast/route.ts:76-118, 249-272`
   (el id sale del `SELECT` de la campaña acotado por `account_id`, nunca del predeterminado).
   Escritura en `broadcast-core.ts:287-302` y `use-broadcast-sending.ts:390`.
4. **Webhook**: [x] resuelve por `phone_number_id` (`route.ts:315-334`, lista + rechazo explícito
   de ≥2 filas), sella en `:1331-1344` con `.eq('id')` **y** `.eq('account_id')`, y crea el hilo
   ya sellado en `:1350-1357`. **CP11**: un fallo al sellar solo hace `console.error` y sigue
   guardando el entrante (`:1337-1343`); el bloque `billing never blocks what comes in (CP11)`
   del test sigue verde.
5. **Migración 053**: [x] `UNIQUE(account_id)` retirado con `DROP CONSTRAINT IF EXISTS` y aserción
   de que **no** existe en `verify-schema.sql`; `whatsapp_config_phone_number_id_key` conservado
   con aserción de que **sí** existe; índice `(account_id, phone_number_id)`; un solo predeterminado
   por índice parcial `WHERE is_default`; las dos FK con `ON DELETE SET NULL` y aserción por
   `confdeltype = 'n'` (ningún `CASCADE` en el archivo); relleno idempotente (`IS NULL`,
   `account_id NOT IN (… WHERE is_default)`); la 036 con aserción de supervivencia. Replay y
   checks SQL verdes, ejecutados por mí.
6. **Tope `numbers`**: [x] `config/route.ts:410-428` cuenta por identidad de fila (`neq('id',
   existing.id)`) y falla cerrado si el conteo falla; tests arriba.
7. **Rutas de configuración**: [x] `config/[id]/route.ts` lleva `id` + `account_id` en las cuatro
   consultas (`:44-48`, `:75-79`, `:115-120`, `:139-151`), responde 404 (nunca 403 ni la fila);
   `config/route.ts:704-713` exige `?id=` y responde 400; `promoteDefault` (`default-number.ts`)
   acota las dos escrituras por `account_id`. CP7: `context: { params: Promise<{ id: string }> }`
   con `await context.params`, contrastado con
   `node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route.md:82-95` y la
   nota de `v15.0.0-RC` de la línea 668.
8. **`from` en `/api/v1/messages`**: [x] documentado en `docs/public-api.md` («Choosing which
   number it goes out from»), incluido el 400 `'from' is not a connected number`; el código
   (`route.ts:100-114`) traduce `phone_number_id` → id interno con `configIdForPhoneNumberId`,
   que filtra por cuenta, y rechaza antes de crear contacto o conversación.
9. **Plantillas al predeterminado**: [x] las cuatro rutas (`templates/sync:145-153`,
   `templates/submit:158`, `templates/[id]:161` y `:316`) resuelven con `{ accountId }` y llevan
   el comentario de la limitación por WABA; recogido como deuda 2 del informe. `036` intacta
   (aserción en `verify-schema.sql`). Multimedia entrante al predeterminado, comentado en
   `media/[mediaId]/route.ts:51-58` y deuda 1.
10. **CP6**: [x] paridad total de claves entre `messages/en.json` y `messages/ko.json`
    (0 claves en un catálogo y no en el otro); no hay `es.json`. **CP8**: el diff no sale de lo que
    justifica §1 (ver hallazgo 5 sobre ruido de formato).

## Checkpoints

- CP1 Compuerta: [x] ejecutada por mí, los cuatro pasos por separado, verdes.
- CP2 Migraciones: [x] 053 idempotente, aserciones por objeto nuevo, sin `CASCADE`, replay 0.
- CP3 Aislamiento: [x] con la excepción deliberada del hallazgo 3.
- CP4 Tests: [x] con la salvedad del hallazgo 2.
- CP5 Dependencias: [x] `package.json` y `package-lock.json` sin cambios.
- CP6 i18n: [x] paridad en/ko verificada por script.
- CP7 Next 16: [x] `params` como promesa, contrastado con `node_modules/next/dist/docs/`.
- CP8 Alcance: [x] lo roto fuera va como deuda, no arreglado (deudas 4 y 5 del informe).
- CP9 Documentación: [x] `CHANGELOG.md` (Unreleased) con la nota de migración y la limitación;
  sin variables de entorno nuevas, así que `docs/docker.md` no cambia; el informe coincide con
  el diff que leí.
- CP10 Git: [x] tres commits en la rama de la fase, en español, con prefijo y `Co-Authored-By`;
  nada pusheado; ramas base intactas.
- CP11 Lo entrante nunca se bloquea: [x] el sellado solo registra el error y no aborta el guardado.

## Hallazgos (archivo:línea)

1. `src/lib/whatsapp/broadcast-resume.ts:230-247` — la rama que responde «The WhatsApp number this
   broadcast was sent from is no longer connected» solo se alcanza con un `whatsapp_config_id`
   colgante, y la FK es `ON DELETE SET NULL`: borrar el número desde Ajustes pone la columna a
   `NULL`, así que la reanudación real **cae al predeterminado**, que es justo el cambio de
   remitente a media campaña que el comentario dice evitar. El test
   `broadcast-resume.test.ts:461` («names the cause when the number the campaign used was
   disconnected») prueba un estado que el esquema solo produce en carrera. En consecuencia, el
   «Extra (riesgo del plan §12.2)» de `progress/impl_multi-number.md:159-161` describe un
   resultado que el guion manual **no** va a observar: al desconectar y reanudar saldrá por el
   predeterminado, no un `whatsapp_not_configured`. No bloquea (es el comportamiento pre-053 y
   recuperable), pero el guion manual no debe usarse tal cual.
2. `src/lib/whatsapp/broadcast-core.ts:287-302` — el `UPDATE` que congela `whatsapp_config_id` en
   la campaña no tiene test que afirme lo escrito: `broadcast-core.test.ts:135-155` solo permite
   la llamada para no contarla como inserción directa. Lo mismo en
   `src/hooks/use-broadcast-sending.ts:390`, que es el camino por el que la columna gana valor en
   el asistente. El lado de lectura sí está cubierto y discrimina.
3. `src/app/api/whatsapp/config/route.ts:366-371` — única consulta con `supabaseAdmin()` sin
   `.eq('account_id')`. Es deliberada y preexistente: detecta que otra cuenta ya reclamó el
   `phone_number_id` y lleva `.neq('account_id', accountId)`; solo selecciona `account_id` y lo
   único que sale al cliente es un 409 sin datos. Acepto la excepción; por definición no puede
   filtrar por la cuenta propia.
4. `src/app/api/whatsapp/config/verify-registration/route.ts:58-66` — sin `?config_id=` consulta
   `is_default = true`; en la ventana de dos escrituras de `promoteDefault` la cuenta no tiene
   predeterminado y la respuesta sería «No WhatsApp configuration saved yet» teniendo números.
   Cosmético y muy improbable; el resolvedor de envío sí tiene red de seguridad (paso 4).
5. Ruido de formato: `src/app/(dashboard)/inbox/page.tsx` y
   `src/app/(dashboard)/broadcasts/new/page.tsx` llegan casi enteros al diff por un paso de
   prettier sobre archivos que no estaban formateados (comillas, Tailwind). El cambio real en cada
   uno son ~10 líneas. No incumple CP8 (son archivos que la sección justifica tocar) pero encarece
   la revisión. `docs/public-api.md` quedó **sin** pasar por prettier, por el motivo contrario y
   explicado en el informe §5.11; prettier no está en la compuerta de CI, así que no rompe nada.
6. `src/app/api/whatsapp/templates/sync/route.ts:143-150` — el comentario de la deuda por WABA está
   en español y sus vecinos en inglés. Cosmético.

## Cambios requeridos

Ninguno para aprobar. Recomendados para la siguiente pasada (o como deuda anotada):

1. Decidir qué hace una reanudación cuando el número congelado ya no existe: hoy el `NULL` de la
   FK la manda al predeterminado. Si se quiere el mensaje «no longer connected», hace falta
   distinguir «nunca tuvo número» (pre-053) de «lo tenía y desapareció» — p. ej. conservando el
   id en una columna de solo lectura o consultando `broadcasts.created_at` contra la fecha de la
   053 — y corregir el «Extra» del guion manual mientras tanto.
2. Un test que afirme que `createBroadcast` escribe `whatsapp_config_id` con el número resuelto
   (hallazgo 2).
