# Review — p11.4 ai-single-reply

**Veredicto:** APPROVED (segunda ronda, HEAD 6d4c43e; primera ronda: CHANGES_REQUESTED)

Rama `pmd/ai-single-reply` @ f2648e0, base 24fdb08. Lógica revisada en `b5f73e1..HEAD`.
b5f73e1 es solo prettier: lo comprobé pasando prettier sobre `b5f73e1^` de los 4 archivos, y el resultado es byte a byte igual a `b5f73e1`.

## Compuerta
- lint: verde (0 errores, 34 avisos preexistentes)
- typecheck: verde
- `TZ=UTC npm test`: verde (283 archivos, 4091 tests)
- build: no ejecutado, por orden del humano (lo corre el líder sobre la rama integrada)
- replay-migrations: n/a (sin migración)

## Trazabilidad criterio ↔ test
- R1 «un `engineSendText` por turno en todos los caminos»: [x] `src/lib/ai/auto-reply.test.ts` › «un solo envío por turno (p11.4)» › los 5 casos `R1 …` (normal, aviso, texto parcial, vacío, aviso vacío), que cuentan llamadas.
- R2 «párrafos en un mensaje, saltos intactos»: [x] idem › `R2 …` (texto exacto); `text-limit.test.ts` › `keeps line breaks…`.
- R3 «truncado ≤4096 UTF-16, «…», corte en espacio, sin partir sustitutos, `warn` sin texto»: [x] `src/lib/whatsapp/text-limit.test.ts` (7 casos; revisé a mano el de sustitutos: 4094 'a' + emoji → el corte baja a 4094) y `auto-reply.test.ts` › `R3 …` ×2. El `warn` se comprueba con `{ conversationId, originalLength }`, y ninguna llamada lleva 'palabra'.
- R4 «mismo `inboundMessageId` → un modelo, un envío»: [x] `auto-reply.test.ts` › `R4 …`. El doble de `inbound_auto_replies` guarda las claves (`autoReplyClaims`): es una reserva de verdad, no un mock que devuelve true siempre.
- R5 «sin reintento ni aviso ni `recordUsage` si el envío lanza»: [x] `auto-reply.test.ts` › `R5 …` ×2 (los dos mensajes, con aviso configurado → 1 llamada, `recordUsage` sin llamar, resolves).
- R6 «reclamo condicionado a `current_node_key` + `last_advanced_at` antes de enviar; `lost_race`; evento `error`»: [x] `src/lib/flows/engine.test.ts` › 5 casos `R6 …`. El doble tiene estado, y el UPDATE casa por filtros sobre una fila compartida. Cubre el botón que apunta a su propio nodo, `collect_input` (gana el `vars` del ganador, una sola escritura de `vars`) y «claim lands before any send».
- R7 «reprompt condicionado, un reenvío»: [x] `engine.test.ts` › `R7 …`. Solo cubre dos textos que no casan. El caso mixto falla (hallazgo 1).
- R8 «try en botones/lista, avance y reprompt»: [x] `engine.test.ts` › 3 casos `R8 …`.
- R9 «consumed tras engaged; antes no»: [x] `src/lib/flows/dispatch.test.ts` › «consumed once engaged (p11.4)» ×2 y `engine.test.ts` › `R9 …` ×2.
- R10 «una vez por nodo que envía; mismo `meta_message_id` → 0»: [x] `engine.test.ts` › `R10 …` ×2.
- R11 «automatizaciones: un envío por paso, sin reintento»: [x] `src/lib/automations/engine.test.ts` › «send steps — one send per step, no retry (p11.4)» (4 tipos × 2 errores; paso siguiente sin ejecutar, log `failed`).
- R12 «cron reanuda una vez»: [x] `src/app/api/automations/cron/route.test.ts` (nuevo). `Promise.all` de dos GET sobre una fila compartida da 1 reanudación, más los casos 401/401/503. `clearMocks: true` en `vitest.config` hace válidos los contadores entre tests.
- R13: [x] tests existentes en `src/lib/automations/reply-marker.test.ts:129,208,220`, verdes.
- R14 «variantes de teléfono solo con #131030»: [x] `src/lib/flows/meta-send.test.ts` y `src/lib/automations/meta-send.test.ts` › «phone variants (p11.4, R14)» ×3. Cuentan `sendTextMessage` en vez de `fetch`, y vale como una petición. Decisión anotada en el informe.
- R15 «sin migración»: [x] `git diff --stat 24fdb08..HEAD` sin `supabase/`.
- R16 / CP11 «webhook intacto»: [x] el diff no toca `src/app/api/whatsapp/webhook/route.ts` y los tests del webhook siguen en verde. Que la IA no conteste, el truncado o perder la carrera solo hacen `return` o `consumed: true` después de guardar el entrante.
- Guion manual (S-L1…S-L3, `last_advanced_at` contra Postgres real): [x] presente en el informe.

Compuerta de cuota de p11.3: intacta. El diff de `auto-reply.ts` contra 24fdb08 solo quita 2 líneas (`text: handoffMessage` y `text`), y las dos pasan ahora por `fitForOneMessage`. `claimInboundAutoReply` y lo anterior no cambian.

## Checkpoints
- CP1: [x] lint/typecheck/test verdes, ejecutados por mí. Build delegado al líder por orden del humano.
- CP2: [x] n/a, sin SQL.
- CP3: [x] sin consultas nuevas con rol de servicio por cuenta. Los UPDATE nuevos van por `id` de `flow_runs`, como antes, sobre una fila ya cargada con `account_id`.
- CP4: [ ] falta el caso mixto de R6/R7 (hallazgo 1). El resto está cubierto y leído.
- CP5: [x] `package.json` sin cambios.
- CP6: [x] n/a, sin textos de UI.
- CP7: [x] no toca framework. El test del Route Handler usa `GET(request: Request)`.
- CP8: [x] alcance correcto. La única línea fuera es una línea en blanco que añadió en `CHANGELOG.md:36`, inocua.
- CP9: [x] CHANGELOG (Unreleased) actualizado; sin variables nuevas; el informe coincide con el diff.
- CP10: [x] 5 commits en español con prefijo y `Co-Authored-By`; sin push.
- CP11: [x] véase R16.

## Hallazgos (archivo:línea)
1. `src/lib/flows/engine.ts:1121-1126`: el UPDATE de `reprompt_count` solo condiciona `id` y `reprompt_count`. **Carrera mixta:** la ejecución está en el nodo de botones X con `reprompt_count = 0`, y llegan a la vez el toque válido A y el texto libre B. El reclamo de A (`:1076`) mueve el puntero a Y y vuelve a escribir `reprompt_count: 0`. Por eso el `.eq('reprompt_count', 0)` de B sigue casando:
   - B reenvía los botones de X después de la rama de A, y son dos mensajes cobrados para un solo paso;
   - B pisa `last_prompt_message_id`;
   - B deja Y con `reprompt_count = 1`;
   - con política `handoff`/`end` agotada, B puede incluso `endRun` sobre la ejecución que A está avanzando.

   Es justo el doble envío que A3 quiere evitar. El diseño fijó solo `reprompt_count`, pero el hueco no deja de existir.
2. `src/lib/flows/engine.ts:1076-1088` (no bloquea, anotar en el informe): `advanceCurrentNodeKey` devuelve `false` también cuando hay error de base (`:913`). Un fallo transitorio del reclamo se toma como `lost_race`: `consumed: true`, sin envío y sin guardar la captura de `collect_input`, y el cliente no recibe nada. Antes un error de captura pasaba a la política de *fallback*. Es coherente con «mejor no enviar que enviar dos veces», pero hoy el `console.error` de `:913` es la única pista. Basta con dejarlo anotado como decisión.
3. Notas de code-review (high) que contrasté y no bloquean:
   - el puntero queda en un nodo que no espera respuesta si el proceso muere tras el reclamo: es una consecuencia aceptada en el diseño;
   - el perdedor con política `ignore` queda consumido: decisión anotada y conforme a la spec;
   - `engaged` antes de `loadFlow`/primer `logEvent`: es lo que fija el diseño;
   - truncado no aplicado a flujos ni automatizaciones: fuera de alcance, anotado como deuda;
   - cortes dentro de un grafema ZWJ: la spec solo exige pares sustitutos;
   - duplicación botones/lista y `truncate()` en `src/lib/ai/handoff.ts:43`: limpieza opcional.

   Descarté «texto solo con espacios»: `parseGeneration` hace `trim()` (`src/lib/ai/generate.ts:70`).

## Cambios requeridos
1. `src/lib/flows/engine.ts:1121-1126`: condicionar el UPDATE de reprompt también a `.eq('status', 'active')`, `.eq('current_node_key', run.current_node_key)` (o `.is(…, null)`) y `.eq('last_advanced_at', run.last_advanced_at)`. Así un reclamo concurrente que ya movió la ejecución hace perder al reprompt (`lost_race_before_reprompt`, sin enviar ni aplicar la política).
2. `src/lib/flows/engine.test.ts`: test nuevo con `race(() => tap('precio', …), () => typed('hola', …))`. Debe dar `send.buttons` = 1 (solo `ask`), `send.text` = 1 (`info`), segundo `outcome: 'lost_race'`, `reprompt_count` final 0 y `last_prompt_message_id` del nodo `ask`. Comprobar que falla contra el código actual.
3. Informe: añadir la decisión del hallazgo 2.

## Segunda ronda — 6d4c43e

**Veredicto:** APPROVED

### Compuerta (alcance fijado por el líder)
- `npm run lint`: verde (0 errores, 34 avisos preexistentes)
- `npm run typecheck`: verde
- `TZ=UTC npx vitest run src/lib/flows src/lib/ai`: verde (21 archivos, 331 tests)
- Ni suite completa ni build, por orden del líder. replay-migrations: n/a.

### Cambios requeridos
1. [x] `src/lib/flows/engine.ts:1126-1137`: el UPDATE del reprompt condiciona ahora `id`, `status = 'active'`, `reprompt_count`, `last_advanced_at` y `current_node_key` (`.is(…, null)` si es null). Si no casa o hay error: `lost_race_before_reprompt` y `{ consumed: true, outcome: 'lost_race' }` antes de `decideFallback`, así que ni envía ni hace `endRun`. Cierra el hueco porque el reclamo del ganador cambia `last_advanced_at` y `current_node_key`.
2. [x] `src/lib/flows/engine.test.ts` › `R7 a valid tap and a free text at once: the old prompt is not re-sent`. Comprueba:
   - `send.text` = 1 y `send.buttons` = 1;
   - el segundo da `lost_race` con el evento `lost_race_before_reprompt`;
   - la fila acaba con `status: 'active'`, `current_node_key: 'ask'` y `reprompt_count: 0`;
   - `last_prompt_message_id: 'msg:wamid.¿Algo más?'`, el de `ask`. El de `menu` sería `msg:wamid.¿Qué necesitas?`: el doble de `messages` deriva el id del wamid, así que el test distingue los dos.

   Contra f2648e0, el `.eq('reprompt_count', 0)` del perdedor casaba y devolvía `fallback_fired`, así que el test falla con el código anterior. Lo deduje del diff y coincide con lo que declara el informe. No lo ejecuté contra f2648e0: habría tenido que tocar el worktree.
3. [x] La decisión del hallazgo 2 está anotada en el informe, con la deuda (`'claimed' | 'lost' | 'error'`).

### Checkpoints que cambian
- CP4: [x] el caso mixto ya tiene test.
- CP10: [x] 6d4c43e en español con prefijo `fix:` y `Co-Authored-By`; sin push.
- CP8: [x] el diff de la ronda solo toca `engine.ts` y `engine.test.ts`.
