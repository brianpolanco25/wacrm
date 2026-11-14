# n15.1 `ai-voice-notes` — requisitos

**Fase 15** (`feature_list.json`, `sdd: true`, depende de n13.3). Redactada el 2026-11-10 por
`spec_author`. Base de lectura: `main` @ 2799b6b. Migración **096** (la 092 la reserva n13.2 y la
095 n13.7, en `spec_ready`; la 096 es la siguiente libre). i18n: `es` (defecto) y `en` (CP6).
Diseño en `design.md`; orden de trabajo en `tasks.md`. Cuenta piloto: Rehactive (Aura).

**Revisión 2026-11-11** (Brian): D1, D2, D4 y D5 aprobadas tal cual; **D3 cambiada**. Una nota
de voz que no se puede transcribir ya no traspasa a humano: un reintento ante fallo transitorio
del proveedor y, si no hay transcripción, un texto fijo configurable pidiendo que escriba, con la
IA activa. Afecta a A3, D2, D3, R19, R28–R30, R38, R40 y añade R41–R47.

## Contexto

Encargo del humano (2026-11-10): «necesito que la IA responda a notas de voz».

Hechos de partida (verificados en `main`):

- El webhook (`src/app/api/whatsapp/webhook/route.ts`) guarda la nota de voz como
  `content_type = 'audio'`, `content_text = null`, `media_url` y `media_type` (normalmente
  `audio/ogg; codecs=opus`). `media_url` es la URL canónica del objeto en el bucket privado
  `chat-media` (`account-<id>/inbound/<mediaId>-audio-<ts>.ogg`, `mirrorInboundMedia` en
  `src/lib/whatsapp/mirror-inbound-media.ts`) o, si la cuenta no espeja o el espejo falló, el
  proxy `/api/whatsapp/media/<mediaId>` (`resolveInboundMediaUrl`,
  `src/lib/whatsapp/inbound-media-url.ts`).
- La puerta de la IA está en el webhook: `if (!flowConsumed && !interactiveReplyId &&
  inboundText.trim())` → `dispatchInboundToAiReply` (`src/lib/ai/auto-reply.ts`). Con una nota de
  voz `inboundText` es `''`: la IA no se dispara.
- `buildConversationContext` (`src/lib/ai/context.ts`) filtra `content_type = 'text'`: una nota de
  voz tampoco entra en el contexto de turnos posteriores.
- Proveedores (`src/lib/ai/providers/*.ts`): todos por `fetch`, **sin SDK**. En `node_modules` no
  hay `openai`, `@anthropic-ai/sdk` ni `@google/genai` (comprobado: `package.json` no los
  declara). OpenAI expone `POST /v1/audio/transcriptions`; Gemini acepta audio en línea en
  `generateContent`; Anthropic no acepta audio.
- Claves: `resolveAiApiKey` / `platformApiKey` (`src/lib/ai/platform-key.ts`), una clave de
  plataforma por proveedor (`AI_PLATFORM_{OPENAI,ANTHROPIC,GEMINI}_API_KEY`, supuesto S1).
- Coste: `logAiUsage` (`src/lib/ai/usage.ts`) → `ai_usage_log`, `mode` con CHECK
  `('auto_reply','draft','playground')` (033, ampliado en 047).

Notación: **nota de voz** = mensaje entrante del cliente con `content_type = 'audio'` (se trata
igual un audio reenviado que uno grabado; Meta no garantiza el campo `voice`).
**Transcriptor** = par (proveedor, clave, modelo) que convierte el audio en texto.
**Marca** = el prefijo literal `[nota de voz]`.

Verificación: **[V]** test vitest junto al código; **[SQL]** contra el Postgres del harness
(`scripts/replay-migrations.sh`, guardado en `progress/checks_ai-voice-notes.sql`); **[M]** guion
manual con WhatsApp y proveedores reales (design §11).

## Criterios de aceptación (derivados del encargo; la entrada no tenía `acceptance`)

- **A1** Una nota de voz de un cliente dispara la respuesta automática de la IA, pasando por las
  mismas puertas que un texto (flows primero, automatizaciones, cuota y plan, cap por
  conversación, pausa por cupo de servicio, reserva en `inbound_auto_replies`).
- **A2** El audio se transcribe en el servidor una sola vez por mensaje, con límites de tamaño,
  duración y tiempo, y la transcripción se guarda en la fila del mensaje.
- **A3** Cadena de transcriptores definida: proveedor de la cuenta si admite audio; si no, clave de
  plataforma de OpenAI o Gemini. Un fallo transitorio del proveedor se reintenta una vez. Si no hay
  transcriptor o no hay transcripción, el bot responde con un texto fijo, configurable por la
  cuenta, pidiendo al cliente que escriba; la IA sigue activa en la conversación y el texto no se
  repite en bucle ante varias notas de voz seguidas.
- **A4** El contexto de la IA usa la transcripción como texto del cliente con la marca
  `[nota de voz]`, tratada siempre como dato, nunca como instrucción.
- **A5** El coste de transcribir se registra en `ai_usage_log` con un modo propio y con quién pagó.
- **A6** La bandeja muestra la transcripción bajo la burbuja de audio (es/en).
- **A7** El playground permite simular una nota de voz con texto transcrito.

## Requisitos

### Esquema (A2, A5)

- **R1 [SQL]** Cuando se aplique la migración `096_ai_voice_notes.sql`, el sistema debe añadir a
  `public.messages` las columnas nulas `transcript text` y `transcript_status text`, con
  `CHECK (transcript_status IN ('done','failed','skipped'))` (`messages_transcript_status_check`),
  `CHECK (transcript IS NULL OR content_type = 'audio')` (`messages_transcript_audio_only`) y
  `CHECK (transcript IS NULL OR char_length(transcript) <= 4000)` (`messages_transcript_len`).
- **R2 [SQL]** Cuando se aplique la migración 096, el CHECK `ai_usage_log_mode_check` debe admitir
  `'auto_reply','draft','playground','transcription'`, y aplicar la migración dos veces debe ser
  inocuo (`replay-migrations.sh` sale 0).
- **R3 [SQL]** Cuando se aplique la migración 096 sobre filas existentes, el sistema debe dejar
  `transcript` y `transcript_status` en `NULL` en todas ellas sin reescribir ninguna otra columna.

### Disparo (A1)

- **R4 [V]** Cuando llegue un entrante con `content_type = 'audio'` y `message.audio.id`, que
  ningún flow consumió y sin `interactiveReplyId`, el webhook debe llamar a
  `dispatchInboundToAiReply` con `voiceNote: { metaMediaId, accessToken }`.
- **R5 [V]** Cuando llegue un entrante de texto, el sistema debe decidir el disparo exactamente como
  hoy (texto no vacío, sin flow, sin `interactiveReplyId`) y sin `voiceNote`; un entrante de imagen,
  vídeo o documento sin texto debe seguir sin disparar la IA.
- **R6 [V]** Cuando un flow consuma la nota de voz, o llegue como respuesta interactiva, el
  sistema no debe llamar a `dispatchInboundToAiReply`.
- **R7 [V]** Cuando `dispatchInboundToAiReply` reciba una nota de voz, el sistema debe aplicar,
  antes de cualquier descarga o llamada de transcripción, las mismas puertas que a un texto: IA
  inactiva o sin auto-respuesta, cuenta no escribible, plan sin `ai_autoreply`, cuota
  `ai_replies` agotada, conversación cerrada, agente asignado, `ai_autoreply_disabled`,
  `ai_reply_count >= autoReplyMaxPerConversation`, pausa por cupo de servicio y reserva perdida en
  `claimInboundAutoReply`; cualquiera de ellas termina sin descargar el audio ni llamar al
  transcriptor.

### Transcripción (A2, A3)

- **R8 [V]** Cuando la nota de voz gane la reserva, el sistema debe transcribirla antes de
  construir el contexto del turno, y debe hacerlo como máximo una vez por mensaje: si la fila ya
  tiene `transcript_status` no nulo, el sistema debe reutilizar ese resultado sin descargar el
  audio ni llamar al transcriptor.
- **R9 [V]** Cuando el proveedor de la cuenta sea `openai`, el transcriptor debe ser OpenAI con la
  clave y el `keySource` de `AiConfig` y el modelo `AI_TRANSCRIBE_OPENAI_MODEL` (por defecto
  `gpt-4o-mini-transcribe`).
- **R10 [V]** Cuando el proveedor de la cuenta sea `gemini`, el transcriptor debe ser Gemini con la
  clave, el `keySource` y el modelo de `AiConfig`.
- **R11 [V]** Cuando el proveedor de la cuenta sea `anthropic`, el transcriptor debe ser OpenAI con
  `AI_PLATFORM_OPENAI_API_KEY` si existe, si no Gemini con `AI_PLATFORM_GEMINI_API_KEY` y
  `AI_PROVIDER_DEFAULT_MODEL.gemini`, en ambos casos con `keySource = 'platform'`; si no existe
  ninguna, no debe haber transcriptor.
- **R12 [V]** Cuando `media_url` sea un objeto del bucket `chat-media` de este Supabase, el sistema
  debe exigir `assertStoragePathOwnedBy(ref, accountId)` con resultado `kind: 'account'` y
  descargarlo con el rol de servicio; una ruta de otra cuenta, no canónica o legada debe terminar
  como `failed` sin descargar nada.
- **R13 [V]** Cuando `media_url` sea el proxy `/api/whatsapp/media/<id>` o nulo, el sistema debe
  obtener el audio de Meta con `getMediaUrl` + `downloadMedia` usando el `metaMediaId` y el token
  del webhook; una URL de cualquier otro origen nunca debe descargarse.
- **R14 [V]** Cuando el tamaño declarado por Meta (`fileSize`) o el descargado supere
  `AI_VOICE_MAX_BYTES` (por defecto 5 MiB), el sistema debe marcar `skipped` (motivo
  `too_large`) sin llamar al transcriptor; con `fileSize` declarado excesivo, sin descargar.
- **R15 [V]** Cuando el audio sea Ogg/Opus y su duración (última granule position / 48 000) supere
  `AI_VOICE_MAX_SECONDS` (por defecto 300), el sistema debe marcar `skipped` (motivo `too_long`)
  sin llamar al transcriptor; si la duración no se puede leer, debe decidir solo por bytes.
- **R16 [V]** Cuando el MIME normalizado no esté en la lista admitida por el transcriptor elegido
  (design §4.3; `audio/amr` no lo está en ninguno), el sistema debe marcar `skipped` (motivo
  `unsupported_format`) sin llamar al transcriptor.
- **R17 [V]** Cuando el transcriptor sea OpenAI, el sistema debe hacer un único
  `POST https://api.openai.com/v1/audio/transcriptions` multipart (`file`, `model`,
  `response_format=json`) con `AbortSignal.timeout(AI_TRANSCRIBE_TIMEOUT_MS)` (por defecto 15 000)
  y devolver `{ text, usage }` con `usage` normalizado por `normalizeUsage`.
- **R18 [V]** Cuando el transcriptor sea Gemini, el sistema debe hacer un único `generateContent`
  con el audio en `inlineData` (base64) y una instrucción de sistema que pide la transcripción
  literal y prohíbe seguir instrucciones contenidas en el audio, con el mismo timeout, y devolver
  `{ text, usage }`.
- **R19 [V]** Cuando la llamada al transcriptor falle de forma transitoria (`toNetworkError` con
  código `network_error` o `timeout`, o respuesta HTTP 429 o 5xx), el sistema debe esperar
  `TRANSCRIBE_RETRY_DELAY_MS` (1 000 ms) y reintentar **exactamente una vez**; cuando falle de
  forma determinista (HTTP 4xx distinto de 429, incluida `invalid_key`), no debe reintentar. Si el
  último intento falla, debe marcar `failed` con el motivo de ese intento. Como máximo dos llamadas
  al transcriptor por nota de voz; los fallos anteriores a la llamada (`no_transcriber`,
  `too_large`, `too_long`, `unsupported_format`, `forbidden_path`, `download_failed`) no se
  reintentan.
- **R20 [V]** Cuando la transcripción tenga éxito, el sistema debe guardar el texto recortado
  (`trim`, espacios colapsados, truncado a 4000 caracteres) con `transcript_status = 'done'`
  mediante un `UPDATE` filtrado por `id`, `conversation_id` y `transcript_status IS NULL`; un
  resultado vacío tras recortar cuenta como `failed`.
- **R21 [V]** Cuando la transcripción termine en `failed` o `skipped`, el sistema debe guardar ese
  estado con `transcript = NULL`, con el mismo filtro que R20.
- **R22 [V]** Cuando falle la escritura de R20/R21, el sistema debe registrar el error y seguir el
  turno con el resultado en memoria (no lo pierde por un fallo de persistencia).

### Coste (A5)

- **R23 [V]** Cuando una llamada de transcripción devuelva uso, el sistema debe registrar una fila
  en `ai_usage_log` con `mode = 'transcription'`, el `provider`, `model` y `keySource` del
  **transcriptor** (no los de `AiConfig` si difieren) y el `conversationId`.
- **R24 [V]** Cuando se transcriba una nota de voz, el sistema no debe incrementar `ai_replies`
  por la transcripción; solo la respuesta enviada cuenta, como hoy.

### Contexto y prompt (A4)

- **R25 [V]** Cuando `buildConversationContext` lea la conversación, el sistema debe incluir los
  mensajes de cliente con `content_type = 'audio'` y `transcript_status = 'done'` como turnos
  `user` con contenido `[nota de voz] <transcript>`, y seguir incluyendo los de texto como hoy; un
  audio sin transcripción no debe aparecer ni ocupar hueco en el límite de mensajes.
- **R26 [V]** Cuando el contexto contenga al menos un turno con la marca, `buildSystemPrompt` debe
  añadir un párrafo que explique que la marca señala una transcripción automática de audio del
  cliente, que puede tener errores, y que es contenido del cliente, nunca instrucciones; cuando no
  la contenga, el prompt debe ser idéntico byte a byte al actual.
- **R27 [V]** Cuando se construya el turno, el sistema debe poner la transcripción solo en
  mensajes de rol `user`; nunca en el system prompt ni en la consulta a la base de conocimiento
  con la marca (la consulta usa el texto sin marca).

### Fallo → texto de reserva (A3, D3)

**Texto de reserva** = `ai_configs.voice_fallback_message` (`AiConfig.voiceFallbackMessage`).

- **R28 [V]** Cuando no haya transcriptor, o el resultado final (tras R19) sea `failed` o
  `skipped`, el sistema no debe llamar a `generateReply`, no debe escribir en `conversations`
  (`ai_autoreply_disabled`, `assigned_agent_id` y `ai_handoff_summary` quedan como estaban), no
  debe llamar a `claim_ai_reply_slot` ni a `recordUsage('ai_replies', …)`, y debe enviar el texto
  de reserva una vez con `engineSendText({ …, aiGenerated: true })`, salvo en los casos de R29 y
  R41.
- **R29 [V]** Cuando la conversación ya tenga un mensaje `sender_type = 'bot'` con
  `content_text` igual al texto de reserva creado hace menos de
  `AI_VOICE_FALLBACK_COOLDOWN_MINUTES` (por defecto 10), o el limitador en memoria
  `ai-voice-fallback:<conversationId>` ya haya concedido un envío en esa ventana, el sistema no
  debe enviar el texto de reserva (como máximo uno por conversación y ventana) y debe registrarlo
  en log con el motivo `cooldown`.
- **R41 [V]** Cuando el texto de reserva sea nulo o vacío tras `trim`, el sistema no debe enviar
  nada (la cuenta lo desactivó a propósito, igual que `handoffMessage`); el resto de R28 se
  mantiene.
- **R42 [V]** Cuando `engineSendText` lance al enviar el texto de reserva, el sistema debe
  registrar el error y terminar sin propagarlo; la IA sigue activa.

### Robustez y aislamiento (A1, A2)

- **R30 [V]** Cuando cualquier paso de la transcripción o del texto de reserva lance,
  `dispatchInboundToAiReply` no debe propagar la excepción (el webhook sigue respondiendo 200 y
  el mensaje queda guardado, CP11).
- **R31 [V]** Cuando el sistema registre en log un fallo de transcripción, el log debe contener id
  de mensaje, motivo y código, y nunca el texto transcrito, los bytes ni el token.
- **R32 [V]** Cuando el sistema lea o escriba `messages` con rol de servicio para la transcripción,
  la consulta debe filtrar por `id` y por `conversation_id` de una conversación ya verificada con
  `account_id`; un test con dos cuentas debe demostrar que un mensaje de la cuenta B no se lee ni
  se escribe desde un turno de la cuenta A.

### Bandeja (A6)

- **R33 [V]** Cuando una burbuja de audio tenga `transcript_status = 'done'`, la bandeja debe
  mostrar la transcripción bajo el reproductor con la etiqueta `Inbox.bubble.transcriptLabel`.
- **R34 [V]** Cuando tenga `failed` o `skipped`, debe mostrar `Inbox.bubble.transcriptUnavailable`;
  cuando sea `NULL`, no debe mostrar nada.
- **R35 [M]** Cuando llegue el `UPDATE` de realtime con la transcripción, la burbuja abierta debe
  mostrarla sin recargar (el handler de `src/app/(dashboard)/inbox/page.tsx` ya fusiona `UPDATE`).

### Playground (A7)

- **R36 [V]** Cuando `POST /api/ai/playground` reciba un turno `user` con `voice: true`, el sistema
  debe pasarlo al modelo como `[nota de voz] <content>` y activar el párrafo de R26, sin llamar a
  ningún transcriptor ni registrar uso de `transcription`; `voice` en un turno `assistant` o no
  booleano se ignora.
- **R37 [V]** Cuando el usuario active «Como nota de voz» en el playground y envíe, la UI debe
  mandar `voice: true` en ese turno y pintarlo con la etiqueta `AiVoice.simulatedVoiceNote`.

### Texto de reserva configurable (A3, D3)

- **R43 [SQL]** Cuando se aplique la migración 096, el sistema debe añadir
  `public.ai_configs.voice_fallback_message text` con `DEFAULT` igual al literal de
  `DEFAULT_VOICE_FALLBACK_MESSAGE`, de modo que las filas existentes y las nuevas lo lean sin que
  nadie toque Ajustes → IA.
- **R44 [V]** Cuando cambie el texto por defecto, sus tres copias deben coincidir: el `DEFAULT` de
  la migración 096, la constante `DEFAULT_VOICE_FALLBACK_MESSAGE` y
  `Settings.aiConfig.voiceFallbackMessagePlaceholder` de `messages/en.json` con el prefijo
  `e.g. ` (mismo test de sincronía que `handoff-message.test.ts`).
- **R45 [V]** Cuando `loadAiConfig` lea la fila, debe exponer `voice_fallback_message` como
  `AiConfig.voiceFallbackMessage` (`null` → `null`, `''` → `''`).
- **R46 [V]** Cuando `POST /api/ai/config` reciba `voice_fallback_message`, el sistema debe
  aceptarlo si es string o `null`, guardarlo recortado (vacío incluido, como baja explícita),
  rechazar con 400 un no-string o más de 1 000 caracteres, y no tocar la columna si el campo no
  viene; `GET` debe devolverlo.
- **R47 [M]** Cuando un administrador edite «Mensaje si no puedo escuchar un audio» en Ajustes →
  IA y guarde, el campo debe persistir y el siguiente fallo de transcripción debe enviar ese texto;
  un formulario guardado sin tocar el campo no debe sobrescribir el valor por defecto
  (`handoffMessagePayload`).

### i18n (A3, A6, A7)

- **R38 [V]** Cuando se añadan las claves nuevas (`Inbox.bubble.transcriptLabel`,
  `Inbox.bubble.transcriptUnavailable`, `AiVoice.*`, `Settings.aiConfig.voiceFallbackMessage`,
  `Settings.aiConfig.voiceFallbackMessageDesc`, `Settings.aiConfig.voiceFallbackMessagePlaceholder`),
  deben existir en `messages/es.json` y `messages/en.json` con los mismos placeholders ICU (lo
  comprueban `src/i18n/messages.test.ts` e `icu-safety.test.ts`).

### Extremo a extremo (A1–A6)

- **R39 [M]** Cuando un cliente real envíe una nota de voz a la cuenta piloto con auto-respuesta
  activa, la IA debe responder por WhatsApp a su contenido, la bandeja debe mostrar la
  transcripción y `ai_usage_log` debe tener una fila `transcription` y otra `auto_reply`.
- **R40 [M]** Cuando el mismo guion se repita con una cuenta en `anthropic` y sin claves de
  plataforma de OpenAI ni Gemini, el cliente debe recibir el texto de reserva una sola vez aunque
  mande dos notas de voz seguidas, la conversación debe seguir con `ai_autoreply_disabled = false`
  y sin agente asignado por la IA, y un texto escrito a continuación debe recibir respuesta normal
  de la IA.

## Fuera de alcance

- Transcribir notas de voz cuando la IA no va a responder (agente asignado, auto-respuesta
  apagada, cap alcanzado): la transcripción solo existe en el camino de la IA (decisión D1).
- Que `keyword_match` o los flows lean la transcripción: corren antes de que exista.
- Responder con audio (TTS), audios salientes, vídeo, notas de voz del eco de coexistencia.
- Cola diferida de transcripción y más de un reintento (R19 fija uno, en línea).
- Traspasar a humano por una nota de voz fallida (D3 revisada): el traspaso sigue existiendo solo
  por las vías de hoy (sentinel del modelo o respuesta vacía).
- Usar la clave de embeddings de la cuenta como transcriptor.

## Decisiones (D1, D2, D4, D5 aprobadas; D3 revisada 2026-11-11)

- **D1** Transcribir solo en el camino de la IA, después de ganar la reserva (design §3). Coste
  acotado; la bandeja solo ve transcripciones de conversaciones que atiende el bot.
- **D2** Cuenta en `anthropic`: transcribe con la clave de **plataforma** de OpenAI o Gemini
  (paga la plataforma, coherente con S1). En autoalojado sin esas claves → texto de reserva (D3).
- **D3** (revisada por Brian el 2026-11-11) Nota de voz no transcribible → **un reintento** solo
  ante fallo transitorio del proveedor (red, timeout, 429, 5xx); si sigue sin transcripción, el bot
  envía el **texto de reserva** de `ai_configs.voice_fallback_message` (columna nueva en la 096,
  mismo patrón que `handoff_message`: semilla en inglés, editable en Ajustes → IA, vacío = no
  enviar) y la IA **sigue activa**. Anti-bucle: como máximo un texto de reserva por conversación
  cada 10 minutos (design §9). Sin traspaso, sin nota interna.
- **D4** Sin dependencias nuevas: adaptadores por `fetch`, como los de chat.
- **D5** Límites por defecto: 5 MiB, 300 s, 15 s de timeout; modelo OpenAI
  `gpt-4o-mini-transcribe`.
