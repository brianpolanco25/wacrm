# p11.4 ai-single-reply — informe de implementación

## Plan (de specs/ai-single-reply/tasks.md)

1. T1 `src/lib/whatsapp/text-limit.ts` + test.
2. T2 `auto-reply.ts`: `fitWhatsAppText` antes de cada `engineSendText`, warn sin texto, cabecera; tests R1–R5.
3. T3 tipos de flujos (`last_advanced_at`, `lost_race`).
4. T4 reclamo antes de enviar + reprompt condicionado; tests R6, R7, R10.
5. T5 `try` en botones/listas, `engaged` en dispatch; tests R8, R9.
6. T6 tests de automatizaciones (R11) y cron (R12); citar R13.
7. T7 tests de variantes de teléfono (R14).
8. T8/T9 alcance, CHANGELOG, compuerta (sin build ni replay por orden del líder), commits.

Estado: **done** (pendiente del reviewer).

## Rama y commits

Rama `pmd/ai-single-reply` (worktree `.claude/worktrees/pmd-ai-single-reply`), base `feat/precios-meta-directo` @ 24fdb08 (con p11.3 integrada). Sin push.

| Commit | Qué |
|---|---|
| b5f73e1 | `chore:` prettier en `src/lib/flows/{engine,types}.ts`, `engine.test.ts`, `dispatch.test.ts` (no estaban formateados), sin cambio de lógica, para que el diff de la feature sea legible |
| b7b3cef | `feat:` `text-limit.ts` + IA un mensaje por turno (T1, T2) |
| 5660a7b | `fix:` flujos: reclamo antes de enviar, reprompt condicionado, `try` en botones/listas, `engaged` (T3–T5) |
| 31f2fb1 | `test:` automatizaciones, cron y variantes de teléfono (T6, T7) |
| f2648e0 | `docs:` CHANGELOG (T9) |

Para revisar solo la lógica: `git diff b5f73e1..HEAD`.

## Compuerta (ejecutada en el worktree)

- `npm run lint`: 0 errores (34 avisos preexistentes, ninguno en archivos tocados; `npx eslint` sobre los tocados, limpio).
- `npm run typecheck`: verde.
- `TZ=UTC npm test`: 283 archivos, 4091 tests, verde.
- `npm run build`: **no ejecutado**, por orden del líder (lo corre sobre la rama integrada).
- `scripts/replay-migrations.sh`: no aplica (sin SQL; Docker apagado).

## Auditoría (design.md §Auditoría) ↔ test

| # | Camino | Acción | Test |
|---|---|---|---|
| A1 | Respuesta normal IA | test | `src/lib/ai/auto-reply.test.ts` › «un solo envío por turno (p11.4)» › `R1 normal reply: exactly one send` |
| A2 | Traspaso con aviso | test | idem › `R1 handoff with a notice: exactly one send (the notice)` |
| A3 | Traspaso con texto parcial | test | idem › `R1 handoff with partial model text: only the notice goes out` |
| A4 | Varios párrafos | test | idem › `R2 several paragraphs go out as ONE message with line breaks intact` |
| A5 | Texto > 4096 | **truncar** | idem › `R3 a 6,000-char reply is truncated…`, `R3 an over-long handoff notice is truncated too`; `src/lib/whatsapp/text-limit.test.ts` (7 casos) |
| A6 | Reintento mismo entrante | test | idem › `R4 the same inboundMessageId twice: one model call, one send` |
| A7 | Fallo tras el envío | test | idem › `R5 send throws («…»): no retry, no notice, no ai_replies` (×2) |
| A8 | Variantes de teléfono | test | `src/lib/flows/meta-send.test.ts` y `src/lib/automations/meta-send.test.ts` › «phone variants (p11.4, R14)» (3 casos cada uno) |
| F1 | Cadena de nodos | test | `src/lib/flows/engine.test.ts` › `R10 a chain sends exactly once per sending node` |
| F2 | Dos respuestas al mismo nodo | **reclamar antes de enviar** | `engine.test.ts` › `R6 two taps…`, `R6 the claim moves the pointer and resets reprompt_count in one write`, `R6 the claim lands before any send of the branch`, `R6 a button pointing at its own node…`, `R6 two texts to a collect_input: the stored var is the winner’s` |
| F3 | Dos reprompts | **UPDATE condicionado** | `engine.test.ts` › `R7 two non-matching replies at once: the prompt is re-sent once` |
| F4 | Botones/lista lanzan | **try + consumed** | `engine.test.ts` › `R8 send_buttons throwing … on advance`, `R8 send_list throwing on advance`, `R8 send_buttons throwing on reprompt`; R9 abajo |
| F5 | Reintento de Meta | test | `engine.test.ts` › `R10 the same meta_message_id twice: the second sends nothing` |
| F6 | Cron de flujos | — (no envía) | — |
| M1 | Pasos de envío de automatización | test | `src/lib/automations/engine.test.ts` › «send steps — one send per step, no retry (p11.4)» (8 casos: 4 tipos × 2 errores) |
| M2 | Reanudar tras wait | test | `src/app/api/automations/cron/route.test.ts` (nuevo) › `R12 two concurrent runs over the same row resume it once`, `R12 a row already claimed…` |
| M3 | Automatización + IA | tests existentes | `src/lib/automations/reply-marker.test.ts` › «picks exactly one winner when an automation and the AI race for the same message», «stands down when the AI got there first», «keeps talking when the reservation is its own» (verdes) |
| M4 | Mensaje + plantilla | — | — |

## Criterio ↔ test

| Req | Test(s) |
|---|---|
| R1 | `auto-reply.test.ts` › 5 casos `R1 …` |
| R2 | `auto-reply.test.ts` › `R2 …`; `text-limit.test.ts` › `keeps line breaks of a short multi-paragraph text intact` |
| R3 | `text-limit.test.ts` › `leaves a text of exactly 4096 units unchanged`, `truncates 4097 units…`, `cuts at the last whitespace within the final 200 characters`, `cuts hard when the tail has no whitespace`, `never splits a surrogate pair at the boundary`, `trims trailing whitespace before measuring`; `auto-reply.test.ts` › `R3 …` (×2, el warn se comprueba sin el texto) |
| R4 | `auto-reply.test.ts` › `R4 …` |
| R5 | `auto-reply.test.ts` › `R5 send throws («Meta API error…»)` y `(«sent to Meta but DB insert failed»)` |
| R6 | `engine.test.ts` › 5 casos `R6 …` |
| R7 | `engine.test.ts` › `R7 …` |
| R8 | `engine.test.ts` › 3 casos `R8 …` |
| R9 | `src/lib/flows/dispatch.test.ts` › «consumed once engaged (p11.4)» › `a throw after the send keeps the inbound consumed`, `a throw while looking the run up leaves it unconsumed (as before)`; y `engine.test.ts` › `R9 a throw after the run was engaged…`, `R9 a throw while looking the run up…` |
| R10 | `engine.test.ts` › 2 casos `R10 …` |
| R11 | `automations/engine.test.ts` › 8 casos `<tipo> throwing («…»): one call, next step not run, log failed` |
| R12 | `cron/route.test.ts` › 2 casos `R12 …`, `401 without the secret`, `401 with a wrong secret`, `503 when AUTOMATION_CRON_SECRET is not set` |
| R13 | tests existentes de `reply-marker.test.ts` citados arriba |
| R14 | `flows/meta-send.test.ts` y `automations/meta-send.test.ts` › `a 500 on the first variant…`, `a network failure on the first variant…`, `«recipient not allowed» on the first…` |
| R15 | `git diff --stat 24fdb08..HEAD`: nada bajo `supabase/` |
| R16 | `git diff --stat`: sin `src/app/api/whatsapp/webhook/route.ts`; tests del webhook verdes (parte de los 4091) |

Comprobado además que los 11 tests nuevos de R6–R9 fallan contra el `engine.ts` anterior (stash del archivo y re-ejecución).

### `git diff --stat 24fdb08..HEAD`

```
 CHANGELOG.md                               |   7 +
 src/app/api/automations/cron/route.test.ts | 134 +++++
 src/lib/ai/auto-reply.test.ts              | 114 ++++
 src/lib/ai/auto-reply.ts                   |  34 +-
 src/lib/automations/engine.test.ts         | 100 +++-
 src/lib/automations/meta-send.test.ts      |  37 ++
 src/lib/flows/dispatch.test.ts             | 311 ++++++-----   (mayoría: prettier, b5f73e1)
 src/lib/flows/engine.test.ts               | 817 ++++++++++------  (idem)
 src/lib/flows/engine.ts                    | 753 ++++++++-------  (idem)
 src/lib/flows/meta-send.test.ts            |  37 ++
 src/lib/flows/types.ts                     |  93 ++--          (idem)
 src/lib/whatsapp/text-limit.test.ts        |  59 +++
 src/lib/whatsapp/text-limit.ts             |  61 +++
```

Sin `supabase/`, sin webhook, sin `inbox/`, sin `messages/*.json`, sin `package.json`.

## Verificaciones contra base real

Ninguna: sin migración ni RPC nueva. La comparación de `last_advanced_at` como texto en el `eq` (formato PostgREST con microsegundos, que Postgres reinterpreta como `timestamptz`) solo está probada con el doble; queda para el guion manual o una prueba futura contra el Postgres del harness (Docker apagado en esta sesión).

## Verificaciones manuales pendientes (Meta real; las ejecuta el humano)

Guion de `requirements.md`, con S-L1…S-L3 sin verificar:
1. Con un número de pruebas, forzar una respuesta de IA de más de 4.096 caracteres (prompt de cuenta que pida un texto muy largo) y comprobar que llega un único mensaje terminado en «…» (S-L1). En el log debe salir `[ai auto-reply] reply truncated to the WhatsApp limit` con `conversationId` y `originalLength`, sin texto.
2. Mandar un texto de 4.097 caracteres con Graph API Explorer y anotar el error literal de Meta (confirma S-L1 y que un rechazo por longitud no cobra, S-L2).
3. En un flujo con botones, pulsar dos botones en menos de un segundo y comprobar que solo sale una rama; en `flow_run_events` del perdedor, un `error` con `reason: lost_race_before_advance`.
4. (añadido) Mismo flujo: confirmar que el UPDATE condicionado en `last_advanced_at` casa en Postgres real con el valor leído (si no casara, ningún toque avanzaría: el síntoma sería que todos los toques devuelven `lost_race`).

## Decisiones donde la spec era ambigua o el código difería

- **`FlowRunRow.last_advanced_at` ya existía** en `src/lib/flows/types.ts`; T3 solo añadió `"lost_race"` al `outcome`.
- **p11.3 integrada**: la compuerta de cuota de servicio está antes de `claimInboundAutoReply`; el truncado va justo antes de cada `engineSendText`, zonas distintas, sin conflicto. El código integrado coincide con lo que asume la spec en el resto.
- **El reclamo reutiliza `advanceCurrentNodeKey`** con un parámetro opcional `claim { expectedLastAdvancedAt, advancedAt, extra }` en lugar de una función `claimTransition` aparte; `extra` lleva `reprompt_count: 0` y, en `collect_input`, `vars`. Se elimina el UPDATE suelto de `reprompt_count: 0` posterior al match (ya va en el reclamo).
- **Reprompt con error de base**: si el UPDATE condicionado de `reprompt_count` resuelve con `{ error }`, se trata como carrera perdida (`lost_race`, `consumed: true`, sin enviar) y se registra `console.error`. Antes un error se ignoraba y se reenviaba. Consecuencia: con la política `ignore`, el entrante que pierde la carrera queda consumido (la spec pide `consumed: true` sin aplicar la política).
- **R9, `outcome` tras excepción con `engaged`**: `{ consumed: true, outcome: 'completed' }` sin `flow_run_id` (no está disponible en el `catch`), como fija el diseño.
- **R14 «una sola llamada a `fetch`»**: los tests existentes de `meta-send` mockean `@/lib/whatsapp/meta-api`; se cuenta `sendTextMessage` (una llamada = una petición HTTP a Meta). No se añadió un mock de `fetch` global para no duplicar el doble.
- **R12**: el test concurrente usa `Promise.all` de dos `GET`; ambos leen la fila como `pending` antes de reclamar, y el doble aplica el UPDATE condicionado sobre una fila compartida.
- **`engine.test.ts`** gana `vi.mock` de `./admin-client`, `./meta-send` y los helpers de etiquetas; los suites puros existentes no los usan y siguen verdes.

## Variables de entorno nuevas

Ninguna. (`.env.local.example` no tocado.)

## Deuda detectada fuera de alcance

- Los nodos `send_message` / `collect_input` de flujos y los pasos de automatización no pasan por `fitWhatsAppText`: un texto de autor > 4096 falla en Meta con error visible (fuera de alcance según la spec).
- `src/lib/flows/engine.ts`, `types.ts` y sus tests no estaban formateados con prettier en la base; se formatearon en un commit `chore:` aparte (b5f73e1). Otros archivos de `src/lib/flows/` podrían estar igual (no revisado).
- `CHANGELOG.md` no pasa `prettier --check` en la base (preexistente); solo se formateó la entrada nueva.
- Agrupar ráfagas (varios entrantes seguidos → una respuesta) queda como propuesta en `design.md` §Alternativas.

## Segunda ronda (review_ai-single-reply.md, CHANGES_REQUESTED)

Commit 6d4c43e (`fix:`) sobre f2648e0.

### Hallazgo 1 (bloqueante): carrera mixta toque válido + texto libre

- `src/lib/flows/engine.ts`, UPDATE de `reprompt_count` en `handleReplyForActiveRun`: ahora condiciona `id`, `status = 'active'`, `reprompt_count`, `last_advanced_at` y `current_node_key` leídos (`.is(..., null)` si fuera null; rama defensiva, porque antes ya se sale si no hay nodo actual). Si no casa (o hay error de base): evento `error` con `reason: 'lost_race_before_reprompt'` y `{ consumed: true, outcome: 'lost_race' }`, sin enviar ni aplicar la política.
- Test nuevo: `src/lib/flows/engine.test.ts` › «flows — un solo envío por paso (p11.4)» › `R7 a valid tap and a free text at once: the old prompt is not re-sent` (`race(() => tap('precio', …), () => typed('hola', …))`): `send.text` = 1 (`info`), `send.buttons` = 1 (solo `ask`), segundo resultado `lost_race` con evento `lost_race_before_reprompt`, ejecución activa en `ask` con `reprompt_count = 0` y `last_prompt_message_id` del prompt de `ask`. Para distinguirlo, el doble de `messages` devuelve ahora un id derivado del wamid (`msg:<wamid>`).
- Comprobado que el test **falla contra el código anterior** (el segundo resultado era `fallback_fired` y se reenviaban los botones de `menu`) y pasa con el arreglo.

### Hallazgo 2 (decisión, no bloqueante): error de base en el reclamo = `lost_race`

`advanceCurrentNodeKey` devuelve `false` también cuando el UPDATE resuelve con `{ error }`, y solo deja `console.error('[flows] advanceCurrentNodeKey error: …')`. Un fallo transitorio del reclamo se trata como carrera perdida: `consumed: true`, nada enviado, la captura de `collect_input` no se guarda y el cliente no recibe respuesta. Lo mismo para el UPDATE del reprompt. **Se acepta como está** porque falla hacia el lado de no enviar (criterio de la feature: mejor no enviar que enviar dos veces). Antes, un error en la captura caía a la política de *fallback*.

**Deuda:** distinguir el error de base de la carrera perdida, por ejemplo con `advanceCurrentNodeKey` devolviendo `'claimed' | 'lost' | 'error'`. En `'error'`, registrar un evento `error` propio (`claim_failed`) y caer a la política de *fallback* (reprompt), o devolver `consumed: false` para que la IA o una automatización puedan contestar. Hoy la única pista es el `console.error`.

### Compuerta de la segunda ronda

- `npm run lint`: 0 errores (avisos preexistentes).
- `npm run typecheck`: verde.
- `npx vitest run src/lib/flows src/lib/ai`: 331 tests, verde.
- Sin build, sin Docker y sin red, por orden del líder.
