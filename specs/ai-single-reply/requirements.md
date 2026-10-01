# p11.4 `ai-single-reply` — requisitos

**Fase 11** (`feature_list.json`, `sdd: true`). Redactada el 2026-10-01 por `spec_author`.
Base de lectura: `feat/precios-meta-directo` @ be8ca0f. Sin migración, sin UI nueva, sin claves
i18n. Regla del humano: ninguna conexión de red; todo `fetch` a Meta y al proveedor de IA va
mockeado.

## Contexto

Desde el 2026-10-01 Meta cobra por **mensaje entregado** (también los de servicio, pasados los
1.000 gratis por número y mes; ver p11.3). Cada envío de más que haga el CRM por su cuenta es dinero
del cliente. La feature garantiza que un turno de IA produce como mucho **un** mensaje saliente,
que un paso de flujo o de automatización envía como mucho **una** vez, y que ningún reintento
reenvía lo que Meta ya aceptó.

La auditoría de los caminos de salida está en `design.md` §Auditoría. Resumen: la IA ya manda un
solo mensaje por turno y tiene clave de turno (reserva `inbound_auto_replies`, 051); lo que falta
es el límite de longitud (hoy un texto largo hace fallar el envío entero). Los flujos sí pueden
duplicar: dos respuestas casi simultáneas al mismo paso avanzan las dos, y un error tras un envío
de botones o lista deja que la IA o una automatización respondan también. Las automatizaciones ya
cumplen; se fijan con tests.

## Criterios de aceptación de partida (nota de la feature + encargo del líder)

- **A1** Auditar los caminos de salida de la IA (`src/lib/ai/auto-reply.ts`) y de los pasos de
  flujo (`src/lib/flows/engine.ts`) y automatización (`src/lib/automations/engine.ts`).
- **A2** Un solo envío por turno de IA: varios párrafos van en un único mensaje; si excede el límite
  de WhatsApp, se trunca con aviso (dividir solo con permiso explícito de la cuenta).
- **A3** Un solo envío por paso de flujo o de automatización.
- **A4** Idempotencia ante reintento, con clave por turno.
- **A5** Sin migración salvo ajuste por cuenta; tests por camino.

**Decisión sobre A2 (dividir):** no se añade `ai_split_long_replies` ni la migración 081. Dividir
es justo lo que esta feature quiere evitar, el prompt ya pide respuestas concisas y el tope de
salida (`MAX_OUTPUT_TOKENS = 1024`, `src/lib/ai/defaults.ts`) deja los excesos en casos raros.
Truncar no pierde la respuesta (hoy se pierde entera). Si el humano quiere la opción, es una
feature aparte con su migración.

## Requisitos (EARS)

### IA (`src/lib/ai/auto-reply.ts`)

- **R1** (A2, A4) Cuando `dispatchInboundToAiReply` procese un entrante, el sistema debe llamar a
  `engineSendText` como máximo **una** vez en total, sea cual sea el camino: respuesta normal,
  traspaso con aviso, traspaso con texto parcial del modelo (solo sale el aviso), texto vacío,
  aviso de traspaso vacío.
  *Verificación:* `src/lib/ai/auto-reply.test.ts`, bloque «un solo envío por turno (p11.4)»: un
  caso por camino que cuenta las llamadas a `engineSendText` (0 o 1).
- **R2** (A2) Cuando el modelo devuelva un texto con varios párrafos o saltos de línea, el sistema
  debe enviarlo como un único mensaje con los saltos de línea intactos.
  *Verificación:* `auto-reply.test.ts`: texto `"Hola.\n\nPrecio: 10.\n\nGracias."` → una llamada
  con ese texto exacto.
- **R3** (A2) Cuando el texto a enviar (respuesta o aviso de traspaso) supere
  `WHATSAPP_TEXT_MAX_LENGTH` (4096 unidades UTF-16; supuesto S-L1), el sistema debe enviarlo
  truncado a como mucho 4096 unidades, terminado en «…», cortado en el último espacio en blanco de
  los 200 caracteres finales si lo hay, sin partir un par sustituto, y registrar un `console.warn`
  con el id de la conversación y la longitud original (nunca el texto).
  *Verificación:* `src/lib/whatsapp/text-limit.test.ts` (puro): 4096 exactos sin cambios; 4097 →
  ≤ 4096 y termina en «…»; corte en espacio; sin espacios en la cola → corte duro; emoji en la
  frontera no queda partido; texto con espacios al final se recorta antes de medir. Y
  `auto-reply.test.ts`: respuesta de 6.000 caracteres → una llamada con ≤ 4096 y un `warn` sin el
  texto.
- **R4** (A4) Cuando llegue una segunda invocación de `dispatchInboundToAiReply` con el mismo
  `inboundMessageId` (la reserva `inbound_auto_replies` ya está tomada), el sistema no debe llamar
  al modelo ni enviar nada.
  *Verificación:* `auto-reply.test.ts`: dos invocaciones con el mismo id contra el doble de la base
  → `generateReply` y `engineSendText` una vez en total.
- **R5** (A4) Si `engineSendText` lanza (Meta rechaza, o «sent to Meta but DB insert failed»), el
  sistema no debe reintentar el envío, ni mandar el aviso de traspaso, ni contar `ai_replies`.
  *Verificación:* `auto-reply.test.ts`, dos casos (los dos mensajes de error) → una llamada,
  `recordUsage` sin llamar, el dispatch no lanza.

### Flujos (`src/lib/flows/engine.ts`)

- **R6** (A3, A4) Cuando dos entrantes distintos de un mismo contacto lleguen a la vez y los dos
  casen con el paso en curso de su flujo activo, el sistema debe ejecutar los pasos siguientes una
  sola vez: el primero en reclamar la transición (UPDATE condicionado a `current_node_key` y
  `last_advanced_at` leídos) avanza; el otro no envía nada y devuelve `consumed: true`,
  `outcome: 'lost_race'`, dejando un evento `error` con `reason: 'lost_race_before_advance'`.
  *Verificación:* `src/lib/flows/engine.test.ts`: doble de la base en el que el segundo UPDATE
  condicionado devuelve 0 filas → los envíos de los nodos siguientes (`send_message` +
  `send_buttons`) suceden una vez; también con un botón que apunta al mismo nodo (antiguo y nuevo
  `current_node_key` iguales); y con dos textos a un `collect_input`, la variable guardada es la
  del que ganó (el perdedor no escribe `vars`).
- **R7** (A3) Cuando dos entrantes que no casan lleguen a la vez a un paso que se vuelve a preguntar
  (`reprompt`), el sistema debe reenviar la pregunta una sola vez: solo reenvía quien consiga el
  UPDATE de `reprompt_count` condicionado al valor leído; el otro devuelve `consumed: true`,
  `outcome: 'lost_race'`.
  *Verificación:* `engine.test.ts` con el segundo UPDATE devolviendo 0 filas → un envío.
- **R8** (A3) Si el envío de un nodo `send_buttons` o `send_list` lanza, el sistema debe registrar el
  evento `error` (`send_buttons_failed` / `send_list_failed`), terminar la ejecución como `failed` y
  devolver `consumed: true`, igual que ya hace `send_message`; en el camino de `reprompt`, registrar
  `reprompt_send_failed` y devolver `consumed: true`.
  *Verificación:* `engine.test.ts`: `engineSendInteractiveButtons` lanzando «sent to Meta but DB
  insert failed» en el avance y en el reprompt → `consumed: true`, una llamada.
- **R9** (A3) Si se lanza una excepción después de haber empezado a manejar una ejecución
  (`handleReplyForActiveRun` o `startNewRun`), `dispatchInboundToFlows` debe devolver
  `consumed: true` (el flujo se queda el entrante y ni las automatizaciones de contenido ni la IA
  lo contestan); las excepciones anteriores (buscar la ejecución, el flujo o sus nodos) siguen
  devolviendo `consumed: false` como hoy.
  *Verificación:* `src/lib/flows/dispatch.test.ts`: excepción simulada en un `logEvent`/`update` tras
  el envío → `consumed: true`; excepción en `loadActiveRunForContact` → `consumed: false`.
- **R10** (A3, A4) Cuando una ejecución recorra una cadena de nodos, el sistema debe llamar al envío
  exactamente una vez por nodo que envía y ninguna por los que no; y cuando el mismo entrante (mismo
  `meta_message_id`) llegue dos veces, la segunda no debe enviar nada.
  *Verificación:* `engine.test.ts`: `start → send_message → set_tag → send_message → end` → 2
  envíos; segundo dispatch con el mismo `meta_message_id` → 0 (`duplicate_inbound_ignored`).

### Automatizaciones (`src/lib/automations/*`)

- **R11** (A3, A4) Cuando una automatización ejecute un paso de envío (`send_message`,
  `send_buttons`, `send_list`, `send_template`), el sistema debe llamar al envío una sola vez para
  ese paso; si lanza (también «sent to Meta but DB insert failed»), el paso queda `failed`, la
  ejecución se detiene y no se reintenta.
  *Verificación:* `src/lib/automations/engine.test.ts`: un caso por tipo de paso con el envío
  lanzando → una llamada, pasos siguientes sin ejecutar, log `failed`.
- **R12** (A4) Cuando dos invocaciones de `GET /api/automations/cron` coincidan sobre la misma fila
  de `automation_pending_executions`, el sistema debe reanudarla una sola vez (reclamo `pending →
  running`).
  *Verificación:* `src/app/api/automations/cron/route.test.ts` **(nuevo)**: dos `GET` concurrentes
  contra un doble donde el segundo reclamo devuelve 0 filas → `resumePendingExecution` una vez;
  401 sin secreto, 503 sin variable.
- **R13** (A4) Cuando una automatización y la IA reaccionen al mismo entrante, el sistema debe
  enviar como máximo una respuesta automática a ese entrante (reserva de la 051), salvo los pasos
  siguientes de la misma automatización que ya la tiene.
  *Verificación:* ya cubierto en `src/lib/automations/reply-marker.test.ts` («picks exactly one
  winner when an automation and the AI race for the same message», «stands down when the AI got
  there first», «keeps talking when the reservation is its own»); el implementer confirma que
  siguen verdes y los cita en el informe. Sin test nuevo salvo que falte un orden.

### Envío a Meta (común)

- **R14** (A4) Cuando un envío de motor (`src/lib/flows/meta-send.ts`,
  `src/lib/automations/meta-send.ts`) pruebe variantes del teléfono, el sistema debe probar la
  siguiente solo si Meta rechazó la anterior con «recipient not allowed»
  (`isRecipientNotAllowedError`); con cualquier otro error, incluido un fallo de red o un 5xx, no
  debe probar otra variante.
  *Verificación:* `src/lib/flows/meta-send.test.ts` y `src/lib/automations/meta-send.test.ts`:
  contacto con dos variantes, primera llamada con 500 → una sola llamada a `fetch`; con el error de
  destinatario → dos llamadas y un mensaje guardado.

### Lo que no cambia

- **R15** (A5) El sistema no debe añadir migraciones, columnas ni ajustes de cuenta en esta feature.
  *Verificación:* `git diff --stat` sin `supabase/` (CP8).
- **R16** (CP11) Esta feature no debe modificar `src/app/api/whatsapp/webhook/route.ts`; un entrante
  sigue guardándose aunque el flujo o la IA fallen.
  *Verificación:* `git diff --stat` sin `webhook/route.ts`; los tests existentes de CP11 del webhook
  siguen verdes.

## Guion manual (exige Meta real; lo ejecuta el humano)

1. Con un número de pruebas, forzar una respuesta de IA de más de 4.096 caracteres (prompt de cuenta
   que pida un texto muy largo) y comprobar que llega un único mensaje terminado en «…» (S-L1).
2. Mandar un texto de 4.097 caracteres con Graph API Explorer y anotar el error literal de Meta
   (confirma S-L1 y que un rechazo por longitud no cobra).
3. En un flujo con botones, pulsar dos botones en menos de un segundo y comprobar que solo sale una
   rama.

## Fuera de alcance

- Agrupar ráfagas (el cliente manda tres mensajes seguidos y la IA contesta tres veces): cada
  entrante es un turno. Propuesta para el humano en `design.md` §Alternativas.
- Límite de longitud de los textos que escribe el autor de un flujo o una automatización (fallan
  en Meta con error visible en el log; no duplican).
- Difusiones, compositor y API v1 (envíos humanos o explícitos).
