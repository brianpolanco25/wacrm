# n15.2 `ai-image-input` — tareas

Orden pensado para que cada paso deje la compuerta dirigida en verde
(`./init.sh feature n15.2 --test <ruta>...`). Tests vitest junto al código; nada de e2e ni Playwright,
nada de capturas. Sin migración y sin dependencias nuevas (CP5). Ningún test existente se reescribe:
si `auto-reply.test.ts`, `auto-reply.voice.test.ts`, `context.test.ts`, `defaults.test.ts`,
`query.test.ts`, `generate.test.ts`, `providers/*.tools.test.ts` o `api/ai/playground/route*.test.ts`
se rompen, el código está mal. **Única excepción**: en `src/lib/ai/voice/dispatch-gate.test.ts` el caso
«image/video/document without text → no dispatch (R5)» pierde `image` de la lista (ahora R1 de esta
feature lo contradice a propósito); `video` y `document` se quedan.

- [ ] **T1 Tipos y puros de imagen** — `src/lib/ai/types.ts` (`ChatImage`, `ChatImageRef`,
  `ChatMessage.image`/`images`), `src/lib/ai/images/{types,config,sniff,vision}.ts`.
  Cubre **R10, R13 (firma), R22 (lista y `withoutImages`)**. Tests:
  `src/lib/ai/images/config.test.ts` (defectos; `AI_IMAGE_MAX_PER_TURN=0` → 0, `-1`/`abc` → 3;
  `AI_IMAGE_MAX_BYTES` y `AI_IMAGE_DOWNLOAD_TIMEOUT_MS` válidos/inválidos; `formatImageTurn` en sus 4
  combinaciones; `stripImageMarker` con ambos marcadores y sin marcador);
  `sniff.test.ts` (cabeceras JPEG/PNG/WebP sintéticas → MIME; GIF, PDF, 3 bytes, `RIFF…WAVE` → null);
  `vision.test.ts` (`gpt-3.5-turbo`, `o3-mini`, `gpt-4`, `claude-2.1` → false; `gpt-4o-mini`,
  `gpt-5`, `claude-sonnet-4-5`, `gemini-2.5-flash` → true; `withoutImages` quita bytes, reescribe el
  marcador conservando caption, no toca turnos sin `image`, no muta la entrada).

- [ ] **T2 Carga segura** — `src/lib/ai/images/image-source.ts`. Cubre **R11, R12 (carga), R13, R14
  (timeout/error)**. Test `image-source.test.ts` con fake de storage que registra llamadas e inyección
  de `getUrl`/`download`: ruta canónica propia → `ok` con MIME por firma y base64 correcto; ruta de
  **otra cuenta** (dos UUID) → `forbidden_path` y `download` no llamado (CP3); legacy `<uid>/…`, `..`,
  `%2F`, bucket `flow-media`, otro origen → `forbidden_path` sin descarga; proxy sin `source` →
  `no_source` sin `getUrl`; proxy con `source` → Meta; `fileSize` declarado mayor → `too_large` sin
  `download`; bytes mayores → `too_large`; firma inválida → `unsupported_format`; `download` que lanza
  → `download_failed`; promesa que no resuelve con `timeoutMs` 10 → `timeout` (timers falsos).

- [ ] **T3 Contexto y consulta** — `src/lib/ai/context.ts`, `src/lib/ai/query.ts`. Cubre **R6, R7, R8,
  R15, R37**. Tests nuevos en `context.test.ts` (añadir casos, no tocar los existentes): imagen de
  cliente sin y con caption → turno `user` `[imagen no disponible]…` con `image` ref; imagen de agente y
  sticker `image/webp` → fuera; orden cronológico mezclado con texto y audio; la consulta pide `id`,
  `media_url`, `media_type` e incluye `image` en `in`/`or`. `query.test.ts`: último `user` de imagen →
  caption sin marcador; sin caption → `''`.

- [ ] **T4 Hidratación** — `src/lib/ai/images/hydrate.ts`. Cubre **R9, R12 (selección por
  `messageId`), R14, R28 (parte)**. Test `hydrate.test.ts` con `load` inyectado: 5 imágenes → solo las 3
  últimas cargadas y con `[imagen]`; `maxPerTurn: 0` → ninguna carga; `source` solo al turno del
  entrante; una carga fallida → ese turno sigue no disponible y los demás sí cargan; `load` que lanza →
  no propaga; no muta la entrada; espía de `console.*`: ningún argumento contiene el base64.

- [ ] **T5 Adaptadores multimodales** — `src/lib/ai/providers/{shared,gemini,openai,anthropic}.ts`.
  Cubre **R16–R21**. Tests nuevos: `shared.test.ts` (`mergeConsecutive` concatena imágenes en orden,
  sin clave `images` si no hay); `gemini.images.test.ts`, `openai.images.test.ts`,
  `anthropic.images.test.ts` con `fetch` simulado (`vi.stubGlobal`, como `*.tools.test.ts`): cuerpo
  exacto con imágenes antes del texto en `generate<X>` y `generate<X>WithTools`; un transcript sin
  imágenes produce **el mismo `JSON.stringify` del cuerpo** que antes (comparar con el literal esperado
  de hoy); imágenes en turno `assistant` ignoradas; OpenAI `detail: 'high'` y data URI con el MIME.

- [ ] **T6 Gate de visión y reintento** — `src/lib/ai/generate.ts`. Cubre **R22, R23, R24, R31**. Test
  `src/lib/ai/generate.images.test.ts` (adaptadores simulados con `vi.mock`): sin imágenes → una llamada
  con los mensajes tal cual; modelo de la lista negra → una llamada sin imágenes y marcadores no
  disponibles; `provider_error` con `usage` null → segunda llamada sin imágenes y su `usage`;
  reintento que falla → propaga; `rate_limited`/`invalid_key`/`timeout`/`network_error` → sin
  reintento; `provider_error` con `err.usage` no nulo (ronda de herramientas) → sin reintento.

- [ ] **T7 Prompt** — `src/lib/ai/defaults.ts`. Cubre **R26**. `defaults.test.ts`: con `images: true`
  contiene `IMAGES_PARAGRAPH` tras el de voz; sin el flag, igual al prompt de hoy (caso existente).

- [ ] **T8 Disparo y auto-respuesta** — `src/lib/ai/voice/dispatch-gate.ts`,
  `src/app/api/whatsapp/webhook/route.ts` (solo la llamada a `aiReplyDispatchPlan` y el reenvío de
  `inboundImage`), `src/lib/ai/auto-reply.ts`. Cubre **R1–R5, R25, R27, R28, R30**. Tests:
  `dispatch-gate.test.ts` (imagen con id sin texto → `inboundImage`; con caption → `inboundImage`;
  imagen sin id, sticker (sin `imageMediaId`), vídeo, documento → no; flow/interactivo → no);
  `src/lib/ai/auto-reply.image.test.ts` siguiendo `auto-reply.voice.test.ts`: cada puerta (auto-reply
  off, no writable, sin plan, cuota, cerrada, asignada, desactivada, tope, `pause_ai`, reserva perdida)
  → ni `storage.download` ni `getMediaUrl`; turno feliz → `generateReply` recibe un turno `user` con
  `images` y `buildSystemPrompt` con `images: true`; `logAiUsage` una vez con el `usage` del proveedor
  y `mode: 'auto_reply'`; `recordUsage('ai_replies', 1)` una vez; descarga fallida → la IA responde
  igual con `[imagen no disponible]`, sin traspaso ni texto de reserva; el fake de `db` no registra
  ningún `insert`/`update`/`upload` con base64; espía de `console`: sin base64.

- [ ] **T9 Playground (ruta)** — `src/lib/ai/images/playground.ts` (`parsePlaygroundImage`,
  selección), `src/app/api/ai/playground/route.ts`. Cubre **R27, R29, R32, R33, R34**. Test
  `src/app/api/ai/playground/route.image.test.ts` siguiendo `route.voice.test.ts`: imagen válida →
  turno con `images` y `[imagen] texto`; texto vacío con imagen → aceptado; MIME no permitido, base64
  roto, firma distinta, > 2 MiB → 400 `invalid_image` y proveedor no llamado; 4 turnos con imagen → solo
  3 con bytes; `imageOmitted` → no disponible; `image` en `assistant` ignorada; la respuesta JSON no
  contiene el base64; `buildSystemPrompt` con `images: true`.

- [ ] **T10 Playground (UI) + i18n** — `src/components/agents/ai-image.tsx` (nuevo),
  `src/components/agents/ai-playground.tsx`, `messages/es.json`, `messages/en.json` (espacio
  `AiImage`, design §10). Cubre **R35, R36, R38**. Test
  `src/components/agents/ai-playground-image.test.tsx`: `playgroundImageMessages` (bytes solo en las 3
  más recientes, el resto `imageOmitted: true`, combinada con `voice`); `renderToStaticMarkup` del
  botón (`accept="image/jpeg,image/png,image/webp"`, `aria-label` traducido) y del aviso de coste;
  validación pura de archivo (tipo y 2 MiB → clave de error); todas las claves de `AiImage` existen en
  `es` y `en`. Comprobación en navegador (sin capturas): adjuntar una JPG de < 2 MiB muestra miniatura
  y el envío produce una sola petición con `image` — se describe en el informe con la aserción usada.

- [ ] **T11 Compuerta en verde + CHANGELOG** — `CHANGELOG.md` (Unreleased: la IA lee fotos del
  cliente, topes, coste en tokens, sin migración), `docs/docker.md` (tabla de env:
  `AI_IMAGE_MAX_PER_TURN`, `AI_IMAGE_MAX_BYTES`, `AI_IMAGE_DOWNLOAD_TIMEOUT_MS`),
  `progress/impl_ai-image-input.md` con el guion manual de design §11 (**R39**) pendiente para Brian.
  `./init.sh feature n15.2` con todos los tests de T1–T10 en verde. Cubre **R39 (guion)** y CP9.
