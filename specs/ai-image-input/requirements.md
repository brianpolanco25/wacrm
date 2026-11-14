# n15.2 `ai-image-input` — requisitos

**Fase 15** (`feature_list.json`, `sdd: true`, depende de n15.1 y m14.3). Redactada el 2026-11-12
por `spec_author`. Base de lectura: `main` @ 57a98e6. **Sin migración** (última: `096_ai_voice_notes.sql`).
i18n: `es` (defecto) y `en` (CP6). Sin dependencias nuevas (CP5). Diseño en `design.md`; orden de
trabajo en `tasks.md`. Cuenta piloto: Rehactive (Aura).

## Contexto

Pedido de Brian (2026-11-12): la IA debe poder leer las imágenes que envía el paciente; caso
principal, la foto de la cédula para agendar (el prompt de Aura dice «si la envía en foto, lee los
dígitos», y hoy es falso).

Hechos de partida (verificados en `main` @ 57a98e6):

- El webhook (`src/app/api/whatsapp/webhook/route.ts`, `extractMessageContent` ~L1480) guarda una
  foto como `content_type = 'image'`, `content_text = caption | null`, `media_url`, `media_type`
  (`image/jpeg` en fotos de WhatsApp). Un **sticker** también se guarda como `content_type = 'image'`
  (L1142–1148) con `media_type = 'image/webp'`. `media_url` es la URL canónica del bucket privado
  `chat-media` (`account-<id>/inbound/…`, `mirrorInboundMedia` en
  `src/lib/whatsapp/mirror-inbound-media.ts`, activo por defecto: `whatsapp_config.mirror_inbound_media
  DEFAULT TRUE`, migración 039) o el proxy `/api/whatsapp/media/<mediaId>` si la cuenta no espeja o el
  espejo falló.
- Disparo (`aiReplyDispatchPlan`, `src/lib/ai/voice/dispatch-gate.ts`): texto no vacío → sí; audio con
  media id → sí con `voiceNote`; **imagen sin caption → no**. Una imagen **con** caption sí dispara
  (`inboundText` = caption), pero la IA solo ve… nada: `buildConversationContext`
  (`src/lib/ai/context.ts`) filtra `content_type IN ('text','audio')`, así que ni el caption entra.
- Proveedores (`src/lib/ai/providers/{gemini,openai,anthropic}.ts`): `fetch` sin SDK; los turnos se
  convierten con `toGeminiContents`, `mergeConsecutive` (OpenAI) y `normalizeForAnthropic`, que solo
  emiten texto. `mergeConsecutive` (`shared.ts`) copia únicamente `role` y `content`. Las variantes
  `generate<X>WithTools` reutilizan esas mismas funciones.
- Descarga segura con rol de servicio ya resuelta para audio en `src/lib/ai/voice/audio-source.ts`
  (`parseStorageObjectUrl` + `assertStoragePathOwnedBy` de `src/lib/media/storage-url.ts` antes de
  `storage.from('chat-media').download`, o `getMediaUrl` + `downloadMedia` de Meta con el token del
  webhook).
- El proxy de Next (`src/middleware.ts`, matcher `/api/:path*`) bufferiza el cuerpo hasta
  `proxyClientMaxBodySize` = **10 MB** por defecto
  (`node_modules/next/dist/docs/01-app/03-api-reference/05-config/01-next-config-js/proxyClientMaxBodySize.md`);
  un cuerpo mayor llega truncado a la ruta. Relevante para el playground.

## Criterios de aceptación (derivados del encargo; la entrada no tenía `acceptance`)

- **A1** Una imagen entrante del cliente dispara la auto-respuesta igual que una nota de voz, por las
  mismas puertas.
- **A2** Las imágenes recientes del cliente entran en el contexto como bloques multimodales en los tres
  proveedores (Gemini `inlineData`, OpenAI `image_url` data URI, Anthropic `image` base64), con el
  caption como texto, con topes de número y tamaño, descargadas del storage privado por la ruta
  canónica.
- **A3** Si el modelo no soporta visión o la descarga falla, la IA recibe un marcador de texto y el
  turno sigue sin romperse.
- **A4** Privacidad: la imagen nunca se persiste fuera del storage ni se loguea.
- **A5** Playground: se puede adjuntar una imagen de prueba.
- **A6** Coste visible: las imágenes cuentan en los tokens ya registrados y la UI lo avisa.

## Requisitos

### Disparo (A1)

- **R1** Cuando llega un mensaje de tipo `image` con media id de Meta, sin caption, que ningún flow
  consumió y que no es una respuesta interactiva, el sistema debe despachar la auto-respuesta con
  `inboundImage = { metaMediaId, accessToken }`. *Test:* `src/lib/ai/voice/dispatch-gate.test.ts`.
- **R2** Cuando llega una imagen con caption, el sistema debe despachar la auto-respuesta (como hoy) y
  además pasar `inboundImage`. *Test:* `dispatch-gate.test.ts`.
- **R3** Cuando llega un sticker, un vídeo o un documento sin texto, el sistema no debe despachar la
  auto-respuesta (sin cambios para ellos). Cuando el entrante lo consumió un flow o es una respuesta
  interactiva, tampoco. *Test:* `dispatch-gate.test.ts`.
- **R4** Cuando se despacha una imagen, el sistema debe aplicar las mismas puertas que a un texto
  (config/auto-reply apagado, `assertWritable`/plan/cuota `ai_replies`, conversación cerrada, agente
  asignado, `ai_autoreply_disabled`, tope por conversación, `pause_ai`, reserva
  `claimInboundAutoReply`) **antes** de cualquier descarga: si una puerta corta, ni Storage ni Meta se
  llaman. *Test:* `src/lib/ai/auto-reply.image.test.ts`.
- **R5** Cuando la respuesta a una imagen sale, el sistema debe contar exactamente una `ai_replies`
  (`recordUsage`) y consumir un hueco de `auto_reply_max_per_conversation`, igual que un texto.
  *Test:* `auto-reply.image.test.ts`.

### Contexto (A2)

- **R6** Cuando `buildConversationContext` lee la conversación, el sistema debe incluir cada fila
  `content_type = 'image'` del **cliente** con `media_type` distinto de `image/webp` como turno `user`
  con contenido `[imagen no disponible]` (o `[imagen no disponible] <caption>`) y una referencia
  `image = { messageId, mediaUrl, mediaType }`, en orden cronológico y ocupando hueco del límite de
  contexto. *Test:* `src/lib/ai/context.test.ts`.
- **R7** Cuando la fila de imagen es de un agente o del bot, o es un sticker (`image/webp`), el sistema
  no debe incluirla en el contexto. *Test:* `context.test.ts`.
- **R8** Cuando el contexto no tiene imágenes, el sistema debe devolver exactamente lo mismo que antes
  (textos y notas de voz). *Test:* los casos existentes de `context.test.ts` sin cambiar aserciones.
- **R9** Cuando se hidratan las imágenes del turno, el sistema debe adjuntar los bytes a las
  `AI_IMAGE_MAX_PER_TURN` (defecto **3**) imágenes de cliente **más recientes** del contexto y cambiar su
  marcador a `[imagen]` (o `[imagen] <caption>`); las anteriores siguen como `[imagen no disponible]`.
  *Test:* `src/lib/ai/images/hydrate.test.ts`.
- **R10** El sistema debe leer `AI_IMAGE_MAX_PER_TURN` como entero ≥ 0 (0 desactiva la visión: todas
  quedan como no disponibles; inválido → 3), `AI_IMAGE_MAX_BYTES` como entero > 0 (defecto
  **3 932 160** = 3,75 MiB, para que el base64 no pase de 5 MiB, el tope por imagen de Anthropic) y
  `AI_IMAGE_DOWNLOAD_TIMEOUT_MS` (defecto 8000). *Test:* `src/lib/ai/images/config.test.ts`.
- **R11** Cuando `media_url` es un objeto de Storage, el sistema debe descargarlo con rol de servicio
  solo si es del bucket `chat-media`, del origen `NEXT_PUBLIC_SUPABASE_URL`, canónico y con
  `assertStoragePathOwnedBy(ref, accountId).kind === 'account'`; en cualquier otro caso (otra cuenta,
  ruta legacy `<uid>/…`, `..`/`%2F`, otro bucket, otro origen) la imagen queda no disponible **sin**
  llamar a `download`. *Test:* `src/lib/ai/images/image-source.test.ts` (incluye fuga entre dos
  cuentas, CP3).
- **R12** Cuando la imagen es la del entrante actual y su `media_url` es nula o el proxy
  `/api/whatsapp/media/…`, el sistema debe pedirla a Meta con `inboundImage` (`getMediaUrl` +
  `downloadMedia`), sin descargar si `fileSize` declarado supera el tope. Cuando una imagen **anterior**
  tiene URL de proxy, el sistema debe dejarla no disponible sin ninguna llamada de red.
  *Test:* `image-source.test.ts`, `hydrate.test.ts`.
- **R13** Cuando los bytes superan `AI_IMAGE_MAX_BYTES` o su firma (magic bytes) no es JPEG, PNG ni
  WebP, el sistema debe dejar la imagen no disponible; cuando la firma es válida, el MIME enviado al
  proveedor debe ser el detectado por la firma, no el de la fila. *Test:* `src/lib/ai/images/sniff.test.ts`,
  `image-source.test.ts`.
- **R14** Cuando la descarga falla, lanza o supera `AI_IMAGE_DOWNLOAD_TIMEOUT_MS`, el sistema debe dejar
  esa imagen no disponible y seguir con el turno; la hidratación nunca lanza. *Test:* `hydrate.test.ts`.
- **R15** Cuando el último turno `user` es una imagen, `latestUserMessage` debe devolver el caption sin
  el marcador (`''` si no hay caption) para la búsqueda en la base de conocimiento.
  *Test:* `src/lib/ai/query.test.ts`.

### Proveedores (A2)

- **R16** Cuando un turno `user` lleva imágenes, el adaptador Gemini debe emitir
  `parts = [{ inlineData: { mimeType, data } }…, { text }]`; los turnos sin imágenes deben quedar
  byte a byte como antes. *Test:* `src/lib/ai/providers/gemini.images.test.ts`.
- **R17** Cuando un turno `user` lleva imágenes, el adaptador OpenAI debe emitir `content` como array
  `[{ type: 'image_url', image_url: { url: 'data:<mime>;base64,<data>', detail: 'high' } }…,
  { type: 'text', text }]`; los turnos sin imágenes siguen con `content` string.
  *Test:* `openai.images.test.ts`.
- **R18** Cuando un turno `user` lleva imágenes, el adaptador Anthropic debe emitir `content =
  [{ type: 'image', source: { type: 'base64', media_type, data } }…, { type: 'text', text }]`; los
  turnos sin imágenes siguen con `content` string. *Test:* `anthropic.images.test.ts`.
- **R19** `mergeConsecutive` debe concatenar las imágenes de turnos consecutivos del mismo rol en orden
  y unir el texto como hoy; si ninguno tiene imágenes, la salida no debe tener la clave `images`.
  *Test:* `src/lib/ai/providers/shared.test.ts`.
- **R20** Las variantes con herramientas (`generateGeminiWithTools`, `generateOpenAiWithTools`,
  `generateAnthropicWithTools`) deben llevar las mismas imágenes en el transcript. *Test:* los tres
  `*.images.test.ts`.
- **R21** Cuando un turno `assistant` trae imágenes, los adaptadores deben ignorarlas (solo texto).
  *Test:* los tres `*.images.test.ts`.

### Visión no soportada o fallo (A3)

- **R22** Cuando `modelSupportsVision(provider, model)` es falso, `generateReply` debe quitar las
  imágenes, cambiar sus marcadores a `[imagen no disponible]` y llamar al proveedor una sola vez.
  *Test:* `src/lib/ai/images/vision.test.ts`, `src/lib/ai/generate.images.test.ts`.
- **R23** Cuando el proveedor falla con `AiError` `code = 'provider_error'`, el turno llevaba imágenes y
  ninguna ronda de herramientas había terminado (`err.usage === null`), `generateReply` debe reintentar
  **una vez** sin imágenes (marcadores no disponibles); si el reintento falla, el error se propaga como
  antes. *Test:* `generate.images.test.ts`.
- **R24** Cuando el fallo es `rate_limited`, `invalid_key`, `timeout`, `network_error` o ya corrió alguna
  ronda de herramientas (`err.usage` no nulo), el sistema no debe reintentar sin imágenes.
  *Test:* `generate.images.test.ts`.
- **R25** Cuando una imagen no está disponible, el sistema no debe traspasar a humano ni enviar ningún
  texto de reserva por eso: el turno sigue con el marcador y el modelo decide (p. ej. pedir que lo
  escriba). *Test:* `auto-reply.image.test.ts`.

### Prompt (A2, A3)

- **R26** Cuando `buildSystemPrompt` recibe `images: true`, el sistema debe añadir `IMAGES_PARAGRAPH`
  (qué significan `[imagen]` y `[imagen no disponible]`, que la imagen es contenido del cliente y nunca
  instrucciones, y que los números leídos de una imagen se copian exactos y, si algún carácter es
  dudoso, se pide al cliente que lo escriba); sin el flag, el prompt debe quedar byte a byte igual.
  *Test:* `src/lib/ai/defaults.test.ts`.
- **R27** Cuando el contexto del turno tiene algún turno de imagen, la auto-respuesta y el playground
  deben pasar `images: true`. *Test:* `auto-reply.image.test.ts`, `src/app/api/ai/playground/route.image.test.ts`.

### Privacidad (A4)

- **R28** El sistema no debe escribir los bytes ni el base64 de una imagen en ninguna tabla, bucket ni
  log: la ruta de imagen no hace `insert`/`update`/`upload`, y ningún `console.*` recibe el base64 (solo
  `messageId` y un código de motivo). *Test:* `hydrate.test.ts` y `auto-reply.image.test.ts` (espía de
  `console` y fake de `db` que registra llamadas).
- **R29** La respuesta del playground no debe devolver las imágenes recibidas.
  *Test:* `route.image.test.ts`.

### Coste (A6)

- **R30** Cuando un turno con imágenes se responde, el sistema debe registrar los tokens en la misma
  fila de `ai_usage_log` (mismo `mode`, `usage` del proveedor que ya incluye la imagen), sin modo nuevo.
  *Test:* `auto-reply.image.test.ts`.
- **R31** Cuando hubo reintento sin imágenes (R23), el `usage` devuelto debe ser el del reintento (el
  intento fallido no terminó ninguna ronda, `err.usage === null`) y registrarse una sola fila.
  *Test:* `generate.images.test.ts`.

### Playground (A5, A6)

- **R32** Cuando un turno `user` del cuerpo trae `image = { mimeType, data }` válido, la ruta
  `POST /api/ai/playground` debe convertirlo en un turno con `images` y contenido `[imagen] <texto>`
  (texto puede ser vacío si hay imagen). *Test:* `route.image.test.ts`.
- **R33** Cuando la imagen tiene MIME fuera de `image/jpeg|png|webp`, base64 inválido, firma que no
  coincide o más de **2 MiB** decodificados (`PLAYGROUND_IMAGE_MAX_BYTES`), la ruta debe responder 400
  `{ code: 'invalid_image' }` sin llamar al proveedor. *Test:* `route.image.test.ts`.
- **R34** La ruta debe aplicar la misma selección que el bot: solo las `AI_IMAGE_MAX_PER_TURN` imágenes
  más recientes llevan bytes; un turno con `imageOmitted: true` o una imagen más antigua queda
  `[imagen no disponible]`; `image` en un turno `assistant` se ignora. *Test:* `route.image.test.ts`.
- **R35** El playground debe ofrecer un botón para adjuntar una imagen (JPEG/PNG/WebP, una por turno),
  mostrarla en el turno, comprobar en cliente el tope de 2 MiB con un error traducido, y enviar bytes
  solo de las 3 imágenes más recientes (las anteriores como `imageOmitted: true`).
  *Test:* `src/components/agents/ai-playground-image.test.tsx` (función pura de cuerpo +
  `renderToStaticMarkup`).
- **R36** El playground debe mostrar junto al botón un aviso de coste («cada imagen cuenta como tokens
  de entrada y se reenvía mientras sea de las 3 más recientes»). *Test:* `ai-playground-image.test.tsx`.

### Borrador (sin cambio de código)

- **R37** Cuando el borrador de la bandeja (`src/app/api/ai/draft/route.ts`) construye el contexto, las
  imágenes del cliente deben aparecer como `[imagen no disponible]` (+ caption) sin bytes: el borrador
  no hidrata imágenes en esta feature. *Test:* `context.test.ts` (R6 cubre la forma).

### i18n (A5, A6)

- **R38** Cada texto nuevo de UI debe existir en `messages/es.json` y `messages/en.json` bajo el
  espacio `AiImage`, con las mismas claves. *Test:* `ai-playground-image.test.tsx` comprueba que las
  claves existen en ambos catálogos.

### Extremo a extremo (A1–A3)

- **R39** Guion manual (depende de Meta y del proveedor): con la cuenta Rehactive, enviar por WhatsApp
  una foto de una cédula de prueba sin texto; Aura responde leyendo los 11 dígitos. Repetir con caption
  («esta es mi cédula»). Repetir con una cuenta en un modelo sin visión (o `AI_IMAGE_MAX_PER_TURN=0`):
  la IA pide que escriba el número. Pasos en `design.md` §11.

## Fuera de alcance

- Imágenes enviadas por agentes o por el bot, stickers, vídeos y documentos (PDF) en el contexto.
- Hidratar imágenes en el borrador de la bandeja (R37) y en el MCP.
- Guardar una descripción/OCR de la imagen en la fila (`messages`): exigiría migración y persistiría un
  dato clínico derivado.
- Redimensionar o recomprimir en servidor (necesitaría `sharp` u otra dependencia, CP5).
- Interruptor de visión por cuenta en ajustes (necesitaría migración); hay interruptor global por env.

## Decisiones (recomendación del spec; pendientes de aprobación)

- **D1 Qué imágenes entran.** Solo del cliente; las **3 más recientes dentro de la ventana de contexto**
  (`aiContextMessageLimit`), no solo las del último turno. Motivo: en Rehactive la cédula llega, Aura
  pregunta la fecha y la cita se crea dos o tres turnos después; si solo viera el último turno, en el
  momento de agendar ya no tendría la foto. El coste se acota por el tope de 3.
- **D2 Topes.** 3 imágenes por turno, 3,75 MiB por imagen (Anthropic: 5 MiB en base64), descarga 8 s por
  imagen en paralelo. Sin redimensionado (CP5; las fotos de WhatsApp ya llegan comprimidas, ~100–500 KB).
  OpenAI con `detail: 'high'`: el caso principal es leer dígitos.
- **D3 Descarga.** Rol de servicio, solo `chat-media` canónico con `assertStoragePathOwnedBy`; Meta solo
  para el entrante actual sin espejo. Imágenes anteriores con proxy → no disponibles (el espejo está
  activo por defecto).
- **D4 Formato por proveedor.** Imágenes antes del texto en el mismo turno (Gemini `inlineData`, OpenAI
  `image_url` data URI, Anthropic `image` base64). Solo en turnos `user`.
- **D5 Sin visión o fallo.** Marcador `[imagen no disponible]` y seguir; lista conservadora de modelos sin
  visión + un único reintento sin imágenes ante `provider_error` si no corrió ninguna herramienta (no se
  reintenta tras herramientas: podría duplicar una cita). Sin traspaso ni texto de reserva.
- **D6 Coste.** Sin modo nuevo en `ai_usage_log`: los tokens de imagen van en `prompt_tokens` de la fila
  del turno. Aviso en el playground, `CHANGELOG.md` y `docs/docker.md`. Orden de magnitud por foto de
  WhatsApp: Gemini ~258–1 300 tokens, OpenAI `high` ~765–1 100, Anthropic ~1 000–1 600.
- **D7 Privacidad.** Bytes solo en memoria durante el turno; nada se guarda ni se loguea; la imagen es
  contenido del cliente, nunca instrucción (R26).
- **D8 Migración.** Ninguna: `media_url` y `media_type` ya existen en `messages`.
