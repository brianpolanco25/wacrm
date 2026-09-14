# Review — f1.2 handoff-message (re-revisión tras la corrección)

**Veredicto:** APPROVED

Alcance re-evaluado: §2 de `docs/saas/fase-1-bandeja.md` tal y como queda en `a492504`.
El material de §2 sigue repartido entre `20fbd9c` (columna 043, campo en la ruta y en el
formulario), `1292984` (envío, validación, textarea, en/ko, tests) y `a492504` (la corrección).
`fac4d40`, que también cae en el rango, es la corrección de f1.1 (aislamiento de
`pick_available_agent`, `REVOKE` a `authenticated` en 042) y **no** se juzga aquí.

Los siete cambios requeridos y el hallazgo 8 están cerrados, cada uno con test leído. Las
decisiones del líder (DEFAULT que se mantiene y alcanza a filas existentes, en inglés; 043
editada en sitio) se dan por buenas y quedan escritas donde se pueden encontrar: cabecera de
la migración, `CHANGELOG.md`, `verify-schema.sql` y `handoff-message.test.ts`.

## Compuerta

Ejecutada por mí en `/Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-1`
sobre `a492504`, árbol limpio:

- `npm run lint`: **verde** — 0 errores, 37 warnings preexistentes.
- `npm run typecheck`: **verde**.
- `TZ=UTC npm test`: **verde** — **85 archivos, 945 tests**.
- `npm run build` con las dummies de `ci.yml`: **verde**.
- `scripts/replay-migrations.sh "$(pwd)"`: **verde** — 001…043 aplican, `verify-schema.sql: OK`,
  exit 0.
- `progress/checks_handoff-message.sql` contra el contenedor que deja `KEEP=1`
  (`wacrm-migrations-27897`, `supabase/postgres:17.4.1.075`), **ejecutado por mí**:

  ```
  BEGIN / DO / NOTICE: column "handoff_message" … already exists, skipping / ALTER TABLE / DO
  NOTICE: confirmado: ADD COLUMN … DEFAULT rellena las filas existentes (PG11+)
  NOTICE: checks_handoff-message.sql: OK
  ROLLBACK          EXIT=0
  ```

  **Control negativo comprobado por mí**, no leído del informe: anteponiendo
  `ALTER TABLE public.ai_configs ALTER COLUMN handoff_message SET DEFAULT 'Gracias por
  escribirnos.';` el script falla con
  `ERROR: DEFAULT inesperado: 'Gracias por escribirnos.'::text`. No es un script que pase
  siempre.

Nota menor: el informe declara «84 archivos, 913 tests»; en `a492504` son 85/945. La
diferencia es `fac4d40` (f1.1), que el implementer no tenía en el árbol cuando midió. No
afecta al veredicto — la compuerta la corrí yo — pero el número del informe está desfasado.

## Los siete cambios requeridos, uno a uno

| # | Pedido | Estado | Evidencia leída |
|---|---|---|---|
| 1 | Decidir el sembrado y hacerlo coherente | **cerrado** | `043_ai_handoff_mode.sql:24-49` (bloque «DECISIÓN sobre el sembrado», explica a) el backfill asumido y b) el inglés) y `:83` `DEFAULT 'Thanks for writing to us. A member of our team will continue this conversation shortly.'`; `verify-schema.sql:129-141` asserta ese `DEFAULT` con mensaje propio; `handoff-message.test.ts:15-43` ata las tres copias (regex sobre el `ALTER TABLE`, `en.json`, y `not.toMatch(/Gracias por escribirnos/)`) |
| 2 | La UI no manda `handoff_message: ''` sin que nadie lo pida | **cerrado** | `handoff-message.ts:41` `handoffMessagePayload` devuelve `undefined` si `edited === false`; `ai-config.tsx:101` estado sembrado con `DEFAULT_HANDOFF_MESSAGE`, `:105` bandera, `:582-585` `onChange` la marca, `:143` `fetchConfig` la resetea **dentro de `if (data.configured)`** (comprobado: una cuenta sin fila no pisa el estado sembrado), `:198-201` `buildBody` usa el helper y `:248` lo serializa con `JSON.stringify`. Tests: `handoff-message.test.ts:47,53,57,61,67` y `route.test.ts:407` › "omits the column on a first save when the field is absent, so the seeded default survives" (`inserts[0]` sin la clave) |
| 3 | Comprobar `error` y hacer la escritura condicional | **cerrado** | `auto-reply.ts:166-190`: `.eq('ai_autoreply_disabled', false).select('id')`, `handoffErr` ⇒ log + `return` sin enviar, 0 filas ⇒ `return`. Tests: `auto-reply.test.ts:430` › "sends nothing when the handoff write fails…" (`updateAttempts === 1`, `engineSendText` no llamado, log contiene «handoff write failed») y `:447` › "sends exactly one notice when two inbounds hand off concurrently" (`updateAttempts === 2`, `updatesApplied === 1`, un solo envío). El mock de `conversations` se reescribió para evaluar el predicado contra la fila compartida (`auto-reply.test.ts:63-89`): la carrera es real, no decorativa |
| 4 | Cubrir `src/lib/ai/config.ts` | **cerrado** | `config.test.ts:99-152`: el mock captura las columnas del `select` y hay cuatro casos — columnas (`handoff_mode`/`handoff_message`/`handoff_agent_id` en `CONFIG_COLUMNS`), mapeo, `''` como opt-out y fallback pre-043. Quitar una columna del `select` ahora rompe la suite |
| 5 | `progress/checks_handoff-message.sql` con resultado | **cerrado** | Existe, cubre DEFAULT, alta nueva sin la columna, opt-out, re-ejecución del `ALTER` y reproducción del backfill sobre tabla temporal. Ejecutado y con control negativo por mí (arriba) |
| 6 | Limpiar `handoffMode`/`handoffMessage` en `handleRemove` | **cerrado** | `ai-config.tsx:277-283`: `setHandoffMode('queue')`, `setHandoffAgentId('')`, `setHandoffMessage(DEFAULT_HANDOFF_MESSAGE)`, `setHandoffMessageEdited(false)` |
| 7 | Informe + `CHANGELOG.md` | **cerrado** | `progress/impl_handoff-message.md` existe y coincide con el diff de `a492504` (11 archivos, ninguno de más). `CHANGELOG.md:28-41` entrada «Handoff notice» con el **Heads-up for existing accounts** y cómo desactivarlo (vaciar el campo) |
| 8 | Guarda «`fixed` necesita destino» sobre el estado efectivo (heredado de f1.1) | **cerrado** | `route.ts:205-215`: la comprobación sale del `if (modeProvided)` y se hace tras leer la fila, sobre `effectiveMode`/`effectiveAgent`; el `select` de `:199` añade las dos columnas solo para validar y el `shared` sigue escribiéndolas solo si vinieron (`:307-309`). Tests: `route.test.ts:312` › "rejects clearing the fixed target when the stored mode stays fixed" (400 y `updates === []`), `:328` › "accepts handoff_mode fixed on its own when the stored row already has a target" (200 y **sin** `handoff_agent_id` en el update), `:344` › "still allows switching a fixed row to queue in one save" |

## Trazabilidad criterio ↔ test (§2, revalidada sobre `a492504`)

- C1 «Al ceder, el cliente recibe exactamente un mensaje de transición»:
  [x] `src/lib/ai/auto-reply.test.ts:333` › "sends exactly one transition message, marked as
  AI-generated" (payload exacto: `text: MSG`, `aiGenerated: true`, `toHaveBeenCalledTimes(1)`)
  **y** `:447` › "sends exactly one notice when two inbounds hand off concurrently". El «exactamente
  uno» deja de depender de que no haya carrera: lo garantiza el `UPDATE` condicional, que en READ
  COMMITTED serializa sobre el row lock, y la columna es `NOT NULL DEFAULT false`, así que el
  predicado `= false` no lo puede burlar un NULL.
- C2 «Ese mensaje no incrementa `ai_reply_count`»:
  [x] `auto-reply.test.ts:350` › "does not claim a reply slot nor count as an AI reply". Sigue
  siendo aserción indirecta (`rpcCalls` vacío) y sigue siendo válida: `ai_reply_count` solo sube
  dentro de `claim_ai_reply_slot` (`029_ai_reply.sql:125`) y el `update` de la cesión no toca la
  columna.
- C3 «Con el mensaje vacío no se envía nada y la cesión ocurre igual»:
  [x] `auto-reply.test.ts:358` › "sends nothing when the message is empty or whitespace, and still
  hands off" (`'   '`, cubre el `.trim()` de `auto-reply.ts:194`) más `:217` › "disables
  auto-reply, writes a summary, and does not send a reply on handoff".
- C4 «Si el envío falla, la conversación queda cedida y asignada»:
  [x] `auto-reply.test.ts:367` › "leaves the conversation handed off and assigned when the send
  fails". Intacto tras el cambio: la escritura sigue yendo antes del envío
  (`auto-reply.ts:166` vs `:198`) y el `catch` local no revierte nada.

Lo que en la revisión anterior estaba sin cobertura y ahora lo tiene: el mapeo de
`config.ts` (cambio 4) y el sembrado en base (cambio 5).

Verificación manual (depende de Meta, no automatizable): guion de 5 pasos en
`progress/impl_handoff-message.md` §«Verificaciones manuales pendientes». Cubre el alta nueva
sin tocar el campo, el aviso único, la ráfaga de dos entrantes, el opt-out y el fallo de envío.

## Revisión de código

Corrí el skill `code-review` a nivel `high` sobre `fac4d40..a492504` (la corrección; el rango
completo ya se revisó a ese nivel en la pasada anterior). Confirma que el núcleo del arreglo es
correcto —serialización real en READ COMMITTED, `NOT NULL DEFAULT false`, ningún trigger que suba
`ai_reply_count` desde `messages`— y aporta cinco observaciones. Las contrasté una a una:
tres las incorporo abajo como hallazgos no bloqueantes (1, 2, 3); dos las descarto como
bloqueo por decisión del líder (la no convergencia de 043 en una base que ya corrió la versión
vieja: la migración no está desplegada, y tanto CI como `replay-migrations.sh` parten de base
limpia) y como consecuencia de la anterior (el textarea en inglés sobre una base con el default
español solo existe en ese mismo escenario). Ambas quedan como caveat, no como hallazgo.

A mano, además:
- **Aislamiento**: las dos consultas de `conversations` con `supabaseAdmin()` filtran por
  `account_id` (`auto-reply.ts:76` en el read, `:170` en el update) y el test
  `auto-reply.test.ts:344` › "scopes the service-role conversation read and handoff write to its
  account" compara los arrays de filtros exactos, dejando explícito que
  `ai_autoreply_disabled=false` es guarda de concurrencia y **no** sustituye al filtro de cuenta.
- **Dependencias**: `package.json` y `package-lock.json` sin cambios en todo el rango.
- **i18n**: `handoffMessage`, `handoffMessageDesc`, `handoffMessagePlaceholder` en
  `messages/en.json:1699-1701` y `messages/ko.json:1699-1701`, misma clave; no hay `es.json`.
- **Next 16**: no se toca ninguna API de framework. El aviso `middleware → proxy` del build es
  preexistente y ajeno a §2.

## Checkpoints

- **CP1 Compuerta**: [x] verde, ejecutada por mí (incluye replay y el SQL de comprobación).
- **CP2 Migraciones**: [x] 043 idempotente (bloque `DO` + `ADD COLUMN IF NOT EXISTS` + `CHECK`
  soltada y vuelta a poner), sin `CASCADE`, y `verify-schema.sql:105-141` asserta ahora
  `handoff_mode`, la constraint, `handoff_message` **y el `DEFAULT` sembrado** — la reserva de la
  revisión anterior queda cubierta. Replay exit 0. Caveat asumido por el líder: 043 se editó en
  sitio, así que una base local que ya corrió la versión española no converge sola (hay que
  resetearla); CI y el replay parten de cero.
- **CP3 Aislamiento**: [x] ver arriba; `engineSendText` sigue filtrando contacto y
  `whatsapp_config` por `accountId` (`src/lib/flows/meta-send.ts:336,350`); la ruta usa el cliente
  de usuario con `.eq('account_id')`.
- **CP4 Tests**: [x] los cuatro criterios con test leído, `config.ts` cubierto, SQL de
  comprobación ejecutado, guion manual escrito.
- **CP5 Sin dependencias nuevas**: [x].
- **CP6 i18n**: [x] las tres claves en `en.json` y `ko.json`; ningún `es.json`.
- **CP7 Next 16**: [x] nada que contrastar.
- **CP8 Alcance**: [x] `a492504` toca 11 archivos, todos justificados por §2 salvo `route.ts` /
  `route.test.ts`, que son el hallazgo 8 que el líder pidió arreglar aquí. `042_pick_available_agent.sql`
  y las aserciones de privilegios en `verify-schema.sql` son de `fac4d40` (f1.1), no de esta feature.
- **CP9 Documentación**: [x] **corregido**. `progress/impl_handoff-message.md` existe y coincide
  con el diff; `CHANGELOG.md` (Unreleased → Added) tiene la entrada de §2 con el aviso a cuentas
  existentes y cómo desactivarlo; también actualiza el bloque «Migration required» con 042 y 043.
  Sin variables de entorno nuevas.
- **CP10 Git**: [x] `a492504` en `saas/fase-1-bandeja`, mensaje en español con prefijo `fix:` y
  `Co-Authored-By`; árbol limpio; ninguna rama remota lo contiene.
- **CP11 Lo entrante nunca se bloquea**: [x] todo sigue dentro del `try/catch` de
  `dispatchInboundToAiReply`, en el `after()` del webhook; los dos `return` nuevos son salidas
  limpias.

## Hallazgos (archivo:línea) — ninguno bloqueante

1. `src/lib/ai/auto-reply.ts:157` — el `UPDATE` es atómico sobre `ai_autoreply_disabled`, pero la
   decisión «no pisar una asignación humana» sigue basada en el `conv` leído **antes** de la
   llamada al modelo. Si un agente reclama el hilo a mitad de la generación, el predicado sigue
   casando y la escritura le reasigna la conversación a otro y le manda el aviso al cliente.
   Se cerraría en la misma sentencia con `.is('assigned_agent_id', null)` cuando
   `update.assigned_agent_id` está puesto. Es una carrera anterior a §2, pero vive justo en la
   sentencia que este commit hizo atómica: cerrarla es de una línea.
2. `src/lib/ai/auto-reply.ts:187` — la rama de 0 filas confunde «otro despacho ganó» con «un
   agente apagó el bot desde el hilo». En el segundo caso antes se escribía igualmente
   `ai_handoff_summary`; ahora se sale antes y quien recoja el hilo se queda sin la nota de
   contexto de ese entrante. El comentario documenta la rama pero no esta consecuencia.
3. `src/app/api/ai/config/route.ts:197` — el `select` de la fila existente descarta su `error`
   (`const { data: existing } = …`), y este commit lo vuelve load-bearing también para validar.
   Si la lectura falla, `existing` queda `null`, la guarda de `fixed` se salta y la ruta va a la
   rama de `INSERT`, que choca con `UNIQUE(account_id)` y devuelve un 500 opaco a una cuenta que
   sí tenía config. Basta con loguearlo.

## Deuda anotada, no exigida

- `src/lib/ai/config.ts:96` — `handoffAgentId: row.handoff_agent_id` sin `?? null` (lo declara el
  propio informe). De f1.1, una línea.
- `src/lib/ai/auto-reply.ts:83` y `:214` — agotar el cupo retorna en silencio: ni cede, ni asigna,
  ni envía el aviso, contradiciendo lo que prometen `handoffToDesc` y `handoffMessageDesc`. Sigue
  mereciendo feature propia de la fase.
- `src/lib/ai/auto-reply.ts:157` — `if (!conv.assigned_agent_id)` es inalcanzable (el `return` de
  `:79` ya cubre el caso). Inocuo.

## Cambios requeridos

Ninguno.
