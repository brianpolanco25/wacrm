# p11.4 `ai-single-reply` — diseño

Leído contra `feat/precios-meta-directo` @ be8ca0f. Rutas y funciones citadas existen en esa rama
salvo las marcadas **(nuevo)**.

## Rama

Worktree hijo `pmd/ai-single-reply` en `.claude/worktrees/pmd-ai-single-reply`, desde be8ca0f.
Conflicto previsible con p11.3 en `src/lib/ai/auto-reply.ts` y su test (zonas distintas: p11.3 mete
una compuerta antes de `claimInboundAutoReply`; aquí se ajusta el texto antes de cada
`engineSendText`). Si van en paralelo, integrar p11.3 primero y resolver a mano.

## Supuestos sin verificar (Meta)

| Id | Supuesto | Fuente en el repo | Efecto si es falso |
|---|---|---|---|
| S-L1 | El cuerpo de un mensaje de texto admite como mucho **4096** caracteres; por encima Meta rechaza el envío entero. | Comentario de `HANDOFF_MESSAGE_MAX_LEN` en `src/app/api/ai/config/route.ts` («WhatsApp allows 4096»). | Constante única `WHATSAPP_TEXT_MAX_LENGTH`; se cambia en un sitio. Se mide en unidades UTF-16 (`.length`), que nunca son menos que los caracteres que cuente Meta: el corte es conservador. |
| S-L2 | Un rechazo de Meta («recipient not allowed», 4xx, 5xx) no entrega ni cobra el mensaje. | `isRecipientNotAllowedError` en `src/lib/whatsapp/phone-utils.ts` y el bucle de variantes de los `meta-send.ts`. | Si un 5xx pudiera entregar, no reintentar (R14) sigue siendo lo correcto. |
| S-L3 | Meta cobra por mensaje entregado, no por conversación (modelo vigente desde el 01-10). | `progress/spec_facturacion-gestionada.md` (encabezado y s10.1). | Ninguno: la garantía de un envío por turno vale igual. |

## Auditoría de los caminos de salida

| # | Camino | Archivo | Hoy | ¿Puede salir más de un mensaje? | Acción |
|---|---|---|---|---|---|
| A1 | Respuesta normal de la IA | `auto-reply.ts` (tras `claim_ai_reply_slot`) | Un `engineSendText` | No | Test R1 |
| A2 | Traspaso con aviso | `auto-reply.ts` (rama `handoff \|\| !text`) | Un aviso, solo si el UPDATE condicionado en `ai_autoreply_disabled = false` devuelve fila | No | Test R1 |
| A3 | Traspaso con texto parcial | `parseGeneration` en `src/lib/ai/generate.ts` quita el centinela; la rama de traspaso descarta el texto | Solo el aviso | No | Test R1 (fija el comportamiento) |
| A4 | Varios párrafos | `generateReply` devuelve un solo `text` | Un mensaje | No | Test R2 |
| A5 | Texto > 4096 | Ninguno: Meta rechaza, `engineSendText` lanza, la respuesta se pierde y el hueco de `claim_ai_reply_slot` queda gastado | Ninguno | No, pero se pierde | **Truncar** (R3) |
| A6 | Reintento del mismo entrante | Webhook: upsert idempotente de `messages` (037) + reserva `inbound_auto_replies` (051) en `claimInboundAutoReply` | Una vez | No | Test R4. **La clave de turno ya existe: `inbound_auto_replies.message_id`.** |
| A7 | Fallo tras el envío | `engineSendText` lanza «sent to Meta but DB insert failed»; el `catch` exterior registra y sale | Sin reintento | No | Test R5 |
| A8 | Variantes de teléfono | Bucle de `recipientAttempts` en los tres `meta-send` | Reintenta solo con «recipient not allowed» | No (S-L2) | Test R14 |
| F1 | Cadena de nodos de un flujo | `advanceFromNodeKey` | Un envío por nodo | No | Test R10 |
| F2 | Dos respuestas a la vez al mismo nodo | `handleReplyForActiveRun` → `advanceFromNodeKey(matched)` | `isDuplicateInbound` solo detecta el **mismo** `meta_message_id`; el UPDATE optimista (`advanceCurrentNodeKey`) llega **después** de los envíos de los nodos que avanzan solos | **Sí**: los dos entrantes envían la rama completa | **Reclamar antes de enviar** (R6) |
| F3 | Dos reprompts a la vez | `reprompt_count` se lee y escribe sin condición | Dos reenvíos | **Sí** | UPDATE condicionado (R7) |
| F4 | `send_buttons`/`send_list` lanzan | `sendButtonsAndSuspend`/`sendListAndSuspend` sin `try`; la excepción sube a `dispatchInboundToFlows`, que devuelve `consumed: false` | El webhook dispara entonces automatizaciones de contenido y la IA para el mismo entrante | **Sí**, si Meta ya aceptó el mensaje («sent to Meta but DB insert failed») | `try` como `send_message` (R8) y `consumed: true` tras empezar (R9) |
| F5 | Reintento de Meta | Webhook idempotente + `isDuplicateInbound` + índice `idx_one_active_run_per_contact` | Una vez | No | Test R10 |
| F6 | Cron de flujos | `src/app/api/flows/cron/route.ts` solo marca `timed_out` | No envía | No | — |
| M1 | Pasos de envío de automatización | `runStep` en `src/lib/automations/engine.ts` | Un envío por paso; error → `failed` y `break` | No | Test R11 |
| M2 | Reanudar tras `wait` | `src/app/api/automations/cron/route.ts`, reclamo `pending → running` | Una vez | No | Test R12 (la ruta no tiene test) |
| M3 | Automatización + IA en el mismo entrante | `reserveReplyToInbound` / `claimInboundAutoReplyForAutomation` | Una respuesta | No | Tests existentes (R13) |
| M4 | Mensaje + plantilla | Solo como dos pasos explícitos del autor | Lo que el autor configuró | No es duplicado | — |

Caminos fuera: compositor (`src/app/api/whatsapp/send/route.ts`), API v1 y difusiones
(`broadcast-core.ts`): los dispara una persona o un cliente de la API, uno por petición.

## Cambios

### `src/lib/whatsapp/text-limit.ts` (nuevo, puro)

```ts
/** S-L1. Ver HANDOFF_MESSAGE_MAX_LEN en src/app/api/ai/config/route.ts. */
export const WHATSAPP_TEXT_MAX_LENGTH = 4096;
const ELLIPSIS = '…';
const WORD_BOUNDARY_WINDOW = 200;

export function fitWhatsAppText(
  raw: string,
  max: number = WHATSAPP_TEXT_MAX_LENGTH
): { text: string; truncated: boolean; originalLength: number };
```

Algoritmo: `trimEnd()`; si `length <= max`, igual. Si no: `limit = max - ELLIPSIS.length`;
`cut = limit`; si `text.charCodeAt(cut - 1)` es sustituto alto (`0xD800–0xDBFF`), `cut -= 1`; buscar
el último `/\s/` en `[cut - 200, cut)` y, si existe, cortar ahí; `text.slice(0, cut).trimEnd() +
ELLIPSIS`. Va en `src/lib/whatsapp/` porque el límite es de WhatsApp, no de la IA; los motores
podrán usarlo más adelante (fuera de alcance).

### `src/lib/ai/auto-reply.ts`

- Antes del `engineSendText` del aviso de traspaso y del de la respuesta:
  `const fitted = fitWhatsAppText(text)`; si `fitted.truncated`, `console.warn('[ai auto-reply]
  reply truncated to the WhatsApp limit', { conversationId, originalLength })` (sin el texto: puede
  traer datos del cliente). Se envía `fitted.text`. El aviso de traspaso ya está limitado a 1000 por
  `HANDOFF_MESSAGE_MAX_LEN`; pasa por la función igual (barato y cubre filas antiguas).
- Comentario en la cabecera: «un turno = un entrante; como mucho un mensaje saliente; clave de turno
  = `inbound_auto_replies.message_id` (051)». Sin más cambios de lógica.

### `src/lib/flows/types.ts`

- `FlowRunRow` gana `last_advanced_at: string` (la columna existe desde la 010 y `select('*')` ya la
  trae).
- `DispatchInboundResult.outcome` gana `"lost_race"`.

### `src/lib/flows/engine.ts`

1. **Reclamar la transición antes de enviar (R6).** `advanceCurrentNodeKey` gana un parámetro
   opcional `expectedLastAdvancedAt?: string`; cuando viene, el UPDATE añade
   `.eq('last_advanced_at', expectedLastAdvancedAt)`. Fija `last_advanced_at = new Date().toISOString()`
   como hoy. En `handleReplyForActiveRun`, en la rama `if (matched)`, **antes** de
   `advanceFromNodeKey`:

   ```ts
   const claimedAt = new Date().toISOString();
   const claimed = await claimTransition(db, run, matched, claimedAt); // UPDATE … WHERE id, status='active', current_node_key = run.current_node_key, last_advanced_at = run.last_advanced_at
   if (!claimed) {
     await logEvent(db, run.id, 'error', run.current_node_key, { reason: 'lost_race_before_advance' });
     return { consumed: true, flow_run_id: run.id, outcome: 'lost_race' };
   }
   run.current_node_key = matched;
   run.last_advanced_at = claimedAt;
   ```

   `last_advanced_at` en la condición es lo que cubre el caso «botón que apunta al mismo nodo»
   (antiguo y nuevo `current_node_key` iguales: sin él, los dos UPDATE casarían). Los UPDATE de los
   nodos que suspenden (`send_buttons`, `send_list`, `collect_input`) siguen usando
   `run.current_node_key` en memoria, que ahora es `matched` = el valor en base: no cambian.

   La captura de `collect_input` deja de escribir antes de decidir: se calcula `newVars` en memoria
   y se escribe **en el mismo UPDATE del reclamo** (`vars: newVars, reprompt_count: 0`), igual que
   el `reprompt_count: 0` de un toque de botón. Así el entrante que pierde la carrera no pisa las
   variables del que ganó, y la ejecución no queda con la variable escrita y el puntero sin mover.
   Los eventos `node_entered` (`captured_key`, `captured_length`) se registran tras el reclamo.

   `last_advanced_at` se compara como texto tal como lo devolvió PostgREST (`select('*')` en
   `loadActiveRunForContact`, con microsegundos); Postgres lo vuelve a leer como `timestamptz` en
   el `eq`. El test de R6 usa ese formato literal.

   Consecuencia aceptada: si el proceso muere entre el reclamo y el envío, la ejecución queda en el
   nodo `matched` sin haber enviado; el siguiente entrante cae en la política de *fallback* o el cron
   la cierra por tiempo. Se prefiere no enviar a enviar dos veces (mismo criterio que
   `claimInboundAutoReply`).

2. **Reprompt condicionado (R7).** El `update({ reprompt_count: newReprompts })` pasa a
   `.eq('id', run.id).eq('reprompt_count', run.reprompt_count).select('id')`; si no devuelve fila,
   evento `error` con `reason: 'lost_race_before_reprompt'` y `{ consumed: true, outcome:
   'lost_race' }` sin enviar ni aplicar la política.

3. **`try` en botones y listas (R8).** En `advanceFromNodeKey`, las ramas `send_buttons` y
   `send_list` envuelven `sendButtonsAndSuspend`/`sendListAndSuspend` igual que `send_message`:
   `logEvent('error', { reason: 'send_buttons_failed' | 'send_list_failed', detail })`, `endRun(…,
   'failed', …)`, `return { outcome: 'completed' }`. En la rama `reprompt`, las tres variantes van en
   el mismo `try` con `reprompt_send_failed` (hoy solo `collect_input` lo tiene).

4. **Consumido tras empezar (R9).** En `dispatchInboundToFlows`, una variable `engaged = false` que
   pasa a `true` justo antes de llamar a `handleReplyForActiveRun` y a `startNewRun`; el `catch`
   devuelve `{ consumed: engaged, outcome: engaged ? 'completed' : 'no_match' }` y registra
   `console.error` como hoy.

### Automatizaciones

Sin cambios de código previstos. Si al escribir los tests de R11/R12 aparece un camino que reintenta,
se arregla aquí y se anota en el informe.

- `src/app/api/automations/cron/route.test.ts` **(nuevo)**: con `vi.mock` de
  `@/lib/automations/admin-client` y de `resumePendingExecution`. La ruta no se toca.

## Manejo de errores

| Dónde | Error | Resultado |
|---|---|---|
| IA | texto largo | truncado + `warn`, un envío |
| IA | `engineSendText` lanza | sin reintento, sin aviso, sin `ai_replies` (como hoy) |
| Flujo | reclamo perdido | `consumed: true`, `lost_race`, nada enviado |
| Flujo | botones/lista lanzan | ejecución `failed`, `consumed: true` |
| Flujo | excepción tras empezar | `consumed: true` (nadie más contesta) |

## Next 16

No se toca código de framework: solo librerías de servidor y un test de un Route Handler existente
(`GET(request: Request)`, forma documentada en
`node_modules/next/dist/docs/01-app/01-getting-started/15-route-handlers.md`).

## Alternativas descartadas

- **Dividir respuestas largas** (`ai_split_long_replies` + migración 081): multiplica el cobro por
  respuesta, que es lo que la feature quiere evitar; truncar ya evita perder la respuesta. Se puede
  añadir después como opción explícita.
- **Pedir al modelo «máximo N caracteres»** en `buildSystemPrompt`: cambia el comportamiento de
  todas las cuentas y no garantiza nada; el truncado es la garantía. Se deja como mejora opcional.
- **Clave de idempotencia nueva para la IA** (p. ej. `ai_turns` con `UNIQUE(message_id)`): duplica la
  reserva de la 051, que ya es exactamente esa clave.
- **Bloqueo `SELECT … FOR UPDATE` de la ejecución del flujo**: PostgREST no lo expone; haría falta
  una RPC y una migración. El UPDATE condicionado consigue lo mismo con lo que ya hay.
- **Agrupar ráfagas** (esperar unos segundos y contestar una vez a varios entrantes seguidos): es
  el mayor ahorro posible, pero cambia la latencia de todas las respuestas, necesita una cola o un
  `after()` con espera, y un turno pasaría a ser «varios entrantes». Propuesta para una feature
  aparte si el humano la quiere.
