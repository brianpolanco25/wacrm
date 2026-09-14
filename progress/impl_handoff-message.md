# Implementación — f1.2 handoff-message (corrección tras CHANGES_REQUESTED)

Spec: `docs/saas/fase-1-bandeja.md` §2 «Avisar al cliente antes de callarse».
Rama `saas/fase-1-bandeja`, worktree `.claude/worktrees/fase-1`.

Esta sesión atiende los siete cambios requeridos de
`progress/review_handoff-message.md` más el hallazgo 8 (heredado de f1.1), según las
decisiones del líder. **No existía informe de implementación previo**: el material de §2
llegó en `20fbd9c` (columna, ruta, formulario) y `1292984` (envío, validación, textarea,
i18n, tests). Este documento cubre el conjunto de §2 tal y como queda ahora, no solo el
diff de corrección.

## Commits

| Commit | Qué trae |
|---|---|
| `20fbd9c` (f1.1, alcance excedido) | `043_ai_handoff_mode.sql`, campo en la ruta y en `ai-config.tsx` |
| `1292984` | envío en `auto-reply.ts`, validación de `handoff_message`, textarea, en/ko, tests |
| **`a492504`** (esta sesión) | los 7 cambios requeridos + hallazgo 8 |

## Los siete cambios requeridos

### 1. Sembrado (hallazgo 1) — decidido y documentado

Decisión del líder, escrita en la cabecera de `supabase/migrations/043_ai_handoff_mode.sql`
(bloque «DECISIÓN sobre el sembrado»):

- **El `DEFAULT` se mantiene y sí alcanza a las filas existentes.** §2 pide literalmente
  «texto por defecto sembrado en la migración y editable en Ajustes → IA», y el objetivo de
  la sección es que ninguna cesión ocurra en silencio: la cuenta que ya tenía la IA
  configurada es exactamente la que hoy deja clientes sin respuesta. En PostgreSQL 11+
  `ADD COLUMN … DEFAULT` rellena las filas presentes; eso deja de ser un efecto colateral y
  pasa a ser el comportamiento buscado, anotado en `CHANGELOG.md`.
- **El texto pasa de español a inglés.** El producto solo tiene `messages/en.json` y
  `messages/ko.json`, `en` es el locale por defecto, y sembrar en un idioma que la interfaz
  no ofrece dejaba a la cuenta enviando a sus clientes algo que ni siquiera puede leer en su
  panel. Texto sembrado:
  `Thanks for writing to us. A member of our team will continue this conversation shortly.`
- La migración **se edita en sitio** (no está desplegada; misma política que 041).
- Tres copias de esa frase tienen que coincidir —el `DEFAULT` de 043, el placeholder de
  `en.json` y `DEFAULT_HANDOFF_MESSAGE`— y ahora hay test que las ata
  (`src/lib/ai/handoff-message.test.ts`) más una aserción del `DEFAULT` en
  `supabase/ci/verify-schema.sql` (el reviewer había anotado que no existía).

### 2. La UI ya no manda `handoff_message: ''` sin que nadie lo pida (hallazgo 2)

- `src/lib/ai/handoff-message.ts` (nuevo): `DEFAULT_HANDOFF_MESSAGE` y
  `handoffMessagePayload({ edited, value })` — `undefined` cuando el campo no se tocó
  (`JSON.stringify` lo elimina, la ruta ve «campo ausente» y no escribe la columna),
  el valor recortado cuando sí.
- `ai-config.tsx`: bandera `handoffMessageEdited` (mismo patrón que `api_key` /
  `embeddings_api_key`), textarea sembrado con `DEFAULT_HANDOFF_MESSAGE` mientras no haya
  fila (`configured === false`), y `buildBody()` usando el helper.
- Resultado: en un alta nueva sin tocar el campo, el `insert` no lleva `handoff_message` y
  la cuenta se queda con el default de 043 — el mismo texto que el formulario mostraba.

**Por qué un helper y no un test de componente:** el repo no tiene `@testing-library/react`
ni `jsdom` (vitest corre en `environment: 'node'`, el único `.test.tsx` usa
`renderToStaticMarkup`), y no se pueden añadir dependencias. La regla que importa —«campo no
tocado ⇒ clave omitida»— se extrajo a una función pura probada, y su efecto en el servidor
se prueba en la ruta (`inserts[0]` sin `handoff_message`). El cableado del textarea a la
bandera queda cubierto por lectura, no por test.

### 3. Cesión comprobada y condicional (hallazgos 5 y 6)

`src/lib/ai/auto-reply.ts`: el `UPDATE` de cesión pasa a

```ts
.update(update).eq('id', …).eq('account_id', …).eq('ai_autoreply_disabled', false).select('id')
```

- **`error` comprobado**: si la escritura falla, se registra y **no se envía el aviso**.
  Antes, un `UPDATE` perdido dejaba `ai_autoreply_disabled = false`, y como la rama de cesión
  no consume cupo, cada mensaje del cliente volvía a ceder y volvía a enviar el aviso.
- **Filas afectadas comprobadas**: el predicado sobre el propio flag convierte la cesión en
  el equivalente de `claim_ai_reply_slot`. Dos entrantes simultáneos leen ambos
  `ai_autoreply_disabled = false`, ambos escriben, pero solo uno afecta filas y solo ese
  envía. C1 («exactamente un mensaje») deja de depender del test unitario.
- El aviso sigue yendo **después** de la escritura y su fallo sigue sin revertir la cesión
  (C4 intacto).

### 4. Guarda «`fixed` necesita destino» sobre el estado efectivo (hallazgo 8, heredado de f1.1)

`src/app/api/ai/config/route.ts`: la comprobación sale del `if (modeProvided)` y se hace tras
leer la fila existente, sobre `effectiveMode`/`effectiveAgent` (lo que trae el cuerpo, si lo
trae; si no, lo guardado). Cierra los dos agujeros que señalaba el reviewer:

- `{ handoff_agent_id: null }` sobre una fila `fixed` ya no persiste `mode='fixed', agent=null`.
- `{ handoff_mode: 'fixed' }` sobre una fila que ya tiene destino ya no se rechaza con 400.

El `select` de la fila existente añade `handoff_mode, handoff_agent_id` (solo para validar; no
se reescriben). **Anotado para la re-revisión de f1.1: este hallazgo queda cerrado aquí.**

### 5-7. Tests de `config.ts`, SQL de comprobación, `handleRemove`, informe y CHANGELOG

- `src/lib/ai/config.test.ts`: el mock registra las columnas del `select` y hay cuatro casos
  nuevos (columnas, mapeo, `''` como opt-out, fallback pre-043).
- `progress/checks_handoff-message.sql` ejecutado contra el Postgres del harness (abajo).
- `handleRemove` vuelve al estado de cuenta sin configurar: `handoffMode = 'queue'`,
  `handoffAgentId = ''`, `handoffMessage = DEFAULT_HANDOFF_MESSAGE`, bandera a `false`.
- Este informe y la entrada de `CHANGELOG.md` (Unreleased → Added).

## Trazabilidad criterio ↔ test

Criterios de aceptación de §2:

| Criterio | Test |
|---|---|
| C1 Al ceder, el cliente recibe **exactamente un** mensaje de transición | `src/lib/ai/auto-reply.test.ts` › "sends exactly one transition message, marked as AI-generated" **y** › "sends exactly one notice when two inbounds hand off concurrently" (2 intentos de `UPDATE`, 1 aplicado, 1 envío) |
| C2 Ese mensaje no incrementa `ai_reply_count` | `auto-reply.test.ts` › "does not claim a reply slot nor count as an AI reply" |
| C3 Con el mensaje vacío no se envía nada y la cesión ocurre igual | `auto-reply.test.ts` › "sends nothing when the message is empty or whitespace, and still hands off" y › "disables auto-reply, writes a summary, and does not send a reply on handoff" |
| C4 Si el envío falla, la conversación queda cedida y asignada | `auto-reply.test.ts` › "leaves the conversation handed off and assigned when the send fails" |

Cambios de esta sesión:

| Cambio requerido | Test |
|---|---|
| 1 — sembrado en inglés, coherente en las tres copias | `src/lib/ai/handoff-message.test.ts` › "matches the DEFAULT seeded by migration 043", › "matches the English placeholder shown under the textarea", › "is English, not Spanish — the product only ships en/ko catalogues"; aserción del `DEFAULT` en `supabase/ci/verify-schema.sql` (replay) |
| 2 — alta nueva sin tocar el campo conserva el default | `handoff-message.test.ts` › "omits the field when the admin never touched it (the seeded default survives)", › "is dropped by JSON.stringify when undefined, so the route sees no key"; `src/app/api/ai/config/route.test.ts` › "omits the column on a first save when the field is absent, so the seeded default survives" |
| 3a — `UPDATE` fallido ⇒ no se envía nada | `auto-reply.test.ts` › "sends nothing when the handoff write fails (it would be re-sent on every inbound)" |
| 3b — dos despachos concurrentes ⇒ un solo envío | `auto-reply.test.ts` › "sends exactly one notice when two inbounds hand off concurrently" |
| 4 — `config.ts` cubierto | `src/lib/ai/config.test.ts` › "selects the handoff columns — dropping one would kill the feature silently", › "maps the stored mode, target and transition message", › "keeps an empty message as an opt-out, not as \"unset\"", › "falls back to the pre-043 semantics on a row without the columns" |
| 8 — guarda `fixed` sobre el estado efectivo | `route.test.ts` › "rejects clearing the fixed target when the stored mode stays fixed", › "accepts handoff_mode fixed on its own when the stored row already has a target", › "still allows switching a fixed row to queue in one save" |
| CP3 aislamiento | `auto-reply.test.ts` › "scopes the service-role conversation read and handoff write to its account" (actualizado: el filtro nuevo `ai_autoreply_disabled=false` no sustituye a `account_id`) |

El mock de `conversations` en `auto-reply.test.ts` se reescribió para modelar
`update(...).eq(...).select('id')` como lo hace PostgREST, incluida la evaluación del
predicado contra la fila compartida: por eso el test de concurrencia no es decorativo
(comprueba `updateAttempts === 2` y `updatesApplied === 1`).

## Verificación contra base real

`KEEP=1 scripts/replay-migrations.sh "$(pwd)"` (imagen `supabase/postgres:17.4.1.075`) y
después `progress/checks_handoff-message.sql`:

```
BEGIN
DO
NOTICE:  column "handoff_message" of relation "ai_configs" already exists, skipping
ALTER TABLE
DO
DO
NOTICE:  confirmado: ADD COLUMN … DEFAULT rellena las filas existentes (PG11+)
DO
NOTICE:  checks_handoff-message.sql: OK
ROLLBACK
EXIT=0
```

Comprueba: (1) el `DEFAULT` es el texto en inglés y no queda rastro del español; (2) un alta
nueva que no manda la columna hereda el default y `handoff_mode = 'queue'`; (3) la cadena
vacía se guarda tal cual (opt-out); (4) re-ejecutar el `ALTER` de 043 no pisa ese opt-out
(idempotencia); (5) el backfill a filas existentes, reproducido con la misma sentencia sobre
una tabla temporal con una fila previa — la afirmación de la cabecera de 043 y del CHANGELOG
no depende de la memoria de nadie.

**Control negativo**: la misma comprobación con el texto español esperado falla con
`ERROR: DEFAULT inesperado: 'Thanks for writing to us…'`. No es un script que pase siempre.

## Compuerta

Ejecutada en el worktree de fase 1:

- `npm run lint`: verde (0 errores, 37 warnings preexistentes).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: verde — **84 archivos, 913 tests** (antes 83/895).
- `npm run build` con las dummies de `ci.yml`: verde.
- `scripts/replay-migrations.sh "$(pwd)"`: **exit 0**, `verify-schema.sql: OK`.

## Verificaciones manuales pendientes

El envío real depende de Meta, así que el aviso saliendo por WhatsApp no se puede automatizar.
Guion (sandbox o número de pruebas):

1. Ajustes → IA: proveedor, modelo y clave; «Auto-reply» activo, cupo 3, modo de cesión
   `auto` o `queue`. Dejar «Message when handing off» **sin tocar** en una cuenta recién
   creada y guardar. Comprobar en base que `ai_configs.handoff_message` es el texto sembrado
   (no `''`) — es el hallazgo 2, y el resto del guion depende de ello.
2. Escribir desde el móvil de pruebas algo que el modelo no pueda contestar (p. ej. «quiero
   hablar con una persona»). Esperado: un único mensaje entrante en el hilo con el texto de
   transición, marcado como generado por IA, `conversations.ai_autoreply_disabled = true` y
   `ai_reply_count` **sin** incrementar.
3. Escribir dos mensajes seguidos en menos de un segundo antes de que llegue el aviso.
   Esperado: **un** aviso, no dos (es lo que fuerza el `UPDATE` condicional; en unitario está
   cubierto, en real depende del solapamiento de dos `after()`).
4. Vaciar el campo en Ajustes → IA, guardar, reactivar la IA del hilo y repetir el paso 2.
   Esperado: cesión sin ningún mensaje saliente.
5. Con el campo relleno, provocar un fallo de envío (token de WhatsApp caducado). Esperado:
   error en el log, la conversación igualmente cedida y asignada.

## Decisiones donde el spec era ambiguo

- **Idioma del texto sembrado.** §2 no dice en qué idioma. Se elige inglés por ser el locale
  por defecto y uno de los dos catálogos; alternativa descartada: `NULL` + propuesta desde la
  interfaz, porque §2 pide explícitamente sembrar en la migración y porque las cuentas
  existentes —las que hoy se callan— no volverían a pasar por el formulario.
- **Qué significa «campo no tocado» en el formulario.** La ruta ya distinguía ausente
  (no tocar) de `''` (opt-out); lo que faltaba era que el cliente usara esa distinción. Se
  eligió el patrón que el propio archivo ya usa para las claves, no un centinela nuevo.
- **Perder la carrera de concurrencia ⇒ salir en silencio.** El despacho perdedor no
  registra error: la cesión ocurrió (otro la hizo) y el aviso salió una vez. Un log ahí sería
  ruido en cada ráfaga.
- **`.select('id')` en lugar de `count: 'exact'`**: devuelve las filas afectadas con la misma
  ida y vuelta y es lo que el resto del repo usa cuando necesita saber si un `UPDATE` tocó
  algo.

## Variables de entorno

Ninguna nueva. `docs/docker.md` no se toca. `.env.local.example` está bloqueado por permisos
y **no** hacía falta tocarlo (no hay variables nuevas), así que la restricción no afectó a
esta feature.

## Deuda detectada, fuera de alcance (no arreglada)

1. `src/lib/ai/config.ts:96` — `handoffAgentId: row.handoff_agent_id` sin `?? null`: si la
   columna no viene en la fila (lectura contra una base sin 043, o un mock parcial) el campo
   sale `undefined` aunque `AiConfig` lo declare `string | null`. Detectado al escribir el
   test del fallback pre-043; por eso ese test afirma `handoffMode`/`handoffMessage` y no
   `handoffAgentId`. Es de f1.1, una línea, y no afecta a producción (la columna existe desde
   antes).
2. `src/lib/ai/auto-reply.ts:157` — `if (!conv.assigned_agent_id)` es inalcanzable (el
   `return` de `:79` ya cubre el caso). Inocuo y útil como red; lo dejo como estaba, igual que
   el reviewer.
3. `src/lib/ai/auto-reply.ts:83` y `:214` — agotar el cupo de respuestas retorna en silencio:
   ni cede, ni asigna, ni envía el aviso, contradiciendo lo que promete `handoffToDesc`. Ya
   anotado por el reviewer; sigue mereciendo feature propia de la fase.
4. `CHANGELOG.md` no está formateado con prettier y `npx prettier --write` sobre él reescribe
   secciones históricas (énfasis `*…*` → `_…_`, sangrías de listas). Se revirtió ese ruido y
   la entrada nueva se añadió a mano respetando el estilo del archivo. Es la misma trampa que
   se anotó en f3.1.
5. `feature_list.json` tenía f1.2 en `status: "review"` cuando se lanzó esta corrección (el
   líder la describió como `in_progress`). Solo bookkeeping; lo dejo al líder.

## Archivos tocados

| Archivo | Qué |
|---|---|
| `supabase/migrations/043_ai_handoff_mode.sql` | default en inglés + decisión documentada (editada en sitio) |
| `supabase/ci/verify-schema.sql` | aserción del `DEFAULT` sembrado |
| `src/lib/ai/handoff-message.ts` | **nuevo** — `DEFAULT_HANDOFF_MESSAGE` y `handoffMessagePayload` |
| `src/lib/ai/handoff-message.test.ts` | **nuevo** — ata las tres copias del texto y la regla del payload |
| `src/lib/ai/auto-reply.ts` | `UPDATE` condicional, `error` y filas afectadas comprobados |
| `src/lib/ai/auto-reply.test.ts` | mock de `update().select()`, tests de fallo y de concurrencia |
| `src/lib/ai/config.test.ts` | columnas del `select` y mapeo de la config |
| `src/app/api/ai/config/route.ts` | guarda `fixed` sobre el estado efectivo tras la mezcla |
| `src/app/api/ai/config/route.test.ts` | tests de esa guarda y del alta sin `handoff_message` |
| `src/components/settings/ai-config.tsx` | campo no tocado, textarea sembrado, `handleRemove` limpio |
| `CHANGELOG.md` | entrada de §2 con el aviso a cuentas existentes y cómo desactivarlo |
| `progress/checks_handoff-message.sql` | comprobación contra el Postgres del harness (checkout principal) |
