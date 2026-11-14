# impl n15.2 `ai-image-input`

Rama `feat/ai-image-input` (worktree `.claude/worktrees/ai-image-input`, base `main @ 0224f5f`).

## Plan (de `specs/ai-image-input/tasks.md`)

1. T1 tipos (`ChatImage`, `ChatImageRef`) + puros `images/{types,config,sniff,vision}.ts` y tests.
2. T2 `images/image-source.ts` (carga segura, Storage canónico / Meta) y test.
3. T3 `context.ts` (turnos de imagen del cliente) y `query.ts` (caption sin marcador).
4. T4 `images/hydrate.ts` (3 más recientes, nunca lanza, sin loguear base64).
5. T5 adaptadores multimodales (`shared`, `gemini`, `openai`, `anthropic`) + tests.
6. T6 `generate.ts`: gate de visión + 1 reintento sin imágenes.
7. T7 `defaults.ts`: `IMAGES_PARAGRAPH` con flag `images`.
8. T8 `dispatch-gate.ts`, webhook (solo la llamada), `auto-reply.ts` + `auto-reply.image.test.ts`.
9. T9 `images/playground.ts` + ruta del playground + `route.image.test.ts`.
10. T10 UI playground (`ai-image.tsx`, `ai-playground.tsx`) + i18n `AiImage`.
11. T11 CHANGELOG, `docs/docker.md`, compuerta dirigida, informe.

## Estado

**done** (pendiente de reviewer). Commits en `feat/ai-image-input`:

- `9b42939` feat: la IA lee las fotos que envía el cliente en la auto-respuesta (n15.2) — T1–T8.
- `90953bf` feat: el playground de la IA acepta una imagen de prueba por mensaje (n15.2) — T9–T11.

Sin migración, sin dependencias nuevas. Sin push ni merge.

## Cambios por archivo

| archivo | cambio |
|---|---|
| `src/lib/ai/types.ts` | `ChatImage`, `ChatImageRef`; `ChatMessage.image` / `images`. |
| `src/lib/ai/images/types.ts` (nuevo) | `InboundImageSource`, `ImageUnavailableReason`. |
| `src/lib/ai/images/config.ts` (nuevo) | marcadores, topes, `aiImageMaxPerTurn` (acepta 0), `aiImageMaxBytes`, `aiImageDownloadTimeoutMs`, `formatImageTurn`, `stripImageMarker`. |
| `src/lib/ai/images/sniff.ts` (nuevo) | `sniffImageMime` por magic bytes. |
| `src/lib/ai/images/vision.ts` (nuevo) | `modelSupportsVision` (lista negra conservadora), `withoutImages`. |
| `src/lib/ai/images/image-source.ts` (nuevo) | `loadInboundImage`: Storage `chat-media` canónico con `assertStoragePathOwnedBy` antes del download, o Meta solo para el entrante; timeout con `Promise.race`; nunca lanza. |
| `src/lib/ai/images/hydrate.ts` (nuevo) | `hydrateConversationImages`: las N más recientes con bytes, `source` solo al entrante, un `console.info` con ids y motivos (nunca base64). |
| `src/lib/ai/images/playground.ts` (nuevo) | `parsePlaygroundImage`, `toPlaygroundMessages` (filtro + voz + imagen + selección). |
| `src/lib/ai/context.ts` | consulta con `id, media_url, media_type` e `image` en `in`/`or`; turno `[imagen no disponible]` (+caption) con ref; agente/bot/sticker fuera. |
| `src/lib/ai/query.ts` | `latestUserMessage` devuelve el caption sin marcador en turnos de imagen. |
| `src/lib/ai/providers/shared.ts` | `mergeConsecutive` concatena `images`; helper `userImages` (solo turnos `user`). |
| `src/lib/ai/providers/{gemini,openai,anthropic}.ts` | bloques multimodales (imágenes antes del texto) en `generate<X>` y `generate<X>WithTools`; sin imágenes, cuerpo idéntico. |
| `src/lib/ai/generate.ts` | `generateReply` = gate de visión + 1 reintento sin imágenes ante `provider_error` con `usage === null`; cuerpo anterior pasa a `generateOnce`. |
| `src/lib/ai/defaults.ts` | `IMAGES_PARAGRAPH` + flag `images` (tras el de voz). Redactado con la aclaración de Brian (ver Decisiones). |
| `src/lib/ai/voice/dispatch-gate.ts` | `imageMediaId` → `{ dispatch: true, inboundImage }`. |
| `src/app/api/whatsapp/webhook/route.ts` | solo la llamada: `imageMediaId` si `message.type === 'image'` y reenvío de `inboundImage`. |
| `src/lib/ai/auto-reply.ts` | `DispatchArgs.inboundImage`; hidratación tras el rate limit por cuenta; `images` al prompt. |
| `src/app/api/ai/playground/route.ts` | usa `toPlaygroundMessages`; 400 `invalid_image` antes de `loadAiConfig`; `images` al prompt. |
| `src/components/agents/ai-image.tsx` (nuevo) | `ImageAttachButton`, `AttachedImagePreview`, `ImageCostHint`, `TurnImage`, `playgroundImageMessages`, `imageFileError`, `readImageFile`. |
| `src/components/agents/ai-playground.tsx` | imagen pendiente, miniatura en el turno, cuerpo con `playgroundImageMessages`, toast `invalidImage`. |
| `messages/{es,en}.json` | espacio `AiImage` (7 claves, design §10). |
| `CHANGELOG.md`, `docs/docker.md` | entrada Unreleased; tabla de las 3 variables nuevas. |

## Criterio ↔ test

| R | test (archivo › `it`) |
|---|---|
| R1 | `src/lib/ai/voice/dispatch-gate.test.ts` › «image with a media id and no text → dispatch with inboundImage (R1)»; `webhook/route.test.ts` › «an image without caption wakes the AI with inboundImage (n15.2 R1)» |
| R2 | `dispatch-gate.test.ts` › «image with caption → dispatch with inboundImage (R2)» |
| R3 | `dispatch-gate.test.ts` › «image without id, sticker (no imageMediaId), video, document → no dispatch (R3)», «flow consumed or interactive reply → no dispatch (R3)»; `webhook/route.test.ts` › «a sticker still does not wake the AI (n15.2 R3)» |
| R4 | `src/lib/ai/auto-reply.image.test.ts` › bloque «image gates (R4): nothing is downloaded» (11 puertas: AI off, auto-reply off, read-only, plan, cuota, cerrada, asignada, desactivada, tope, pause_ai, reserva perdida) |
| R5, R30 | `auto-reply.image.test.ts` › «logs one usage row with the provider usage and charges one ai_replies» |
| R6, R37 | `src/lib/ai/context.test.ts` › «maps a customer image without and with caption to an unavailable user turn (R6, R37)», «selects id, media_url and media_type (R6)», «keeps chronological order mixed with text and voice notes (R6)» |
| R7 | `context.test.ts` › «drops agent/bot images and stickers (R7)» |
| R8 | casos existentes de `context.test.ts` (ver Decisión 2) |
| R9 | `src/lib/ai/images/hydrate.test.ts` › «attaches only the 3 most recent of 5 images», «maxPerTurn 0 → no load at all» |
| R10 | `src/lib/ai/images/config.test.ts` (6 casos) |
| R11 (CP3) | `src/lib/ai/images/image-source.test.ts` › «cross-account leak (CP3): account A never downloads account B», «refuses legacy, .., %2F, another bucket and another origin without downloading»; `auto-reply.image.test.ts` › «an image of another account is never downloaded (CP3)» |
| R12 | `image-source.test.ts` › «a proxy URL without source → no_source, no network», «a proxy URL with source → getMediaUrl + downloadMedia», «a declared fileSize over the limit → too_large without downloading»; `hydrate.test.ts` › «passes the Meta source only to the current inbound turn (R12)»; `auto-reply.image.test.ts` › «fetches the current inbound from Meta when it was not mirrored (R12)» |
| R13 | `src/lib/ai/images/sniff.test.ts` (2); `image-source.test.ts` › «downloads an own canonical object; MIME comes from the bytes», «bytes over the limit → too_large», «an unknown signature → unsupported_format» |
| R14 | `image-source.test.ts` › «a download that never resolves → timeout», «a download that throws → download_failed», «a storage error → download_failed»; `hydrate.test.ts` › «a failed or throwing load leaves that turn unavailable, others load (R14)» |
| R15 | `src/lib/ai/query.test.ts` › «returns the caption of an image turn without its marker (n15.2, R15)» |
| R16, R20, R21 | `src/lib/ai/providers/gemini.images.test.ts` (3) |
| R17, R20, R21 | `providers/openai.images.test.ts` (3) |
| R18, R20, R21 | `providers/anthropic.images.test.ts` (3) |
| R19 | `providers/shared.test.ts` (3) |
| R22 | `src/lib/ai/images/vision.test.ts` (3); `src/lib/ai/generate.images.test.ts` › «a no-vision model: one call without images, markers unavailable» |
| R23, R31 | `generate.images.test.ts` › «provider_error with usage null → one retry without images, its usage», «a failing retry propagates its error» |
| R24 | `generate.images.test.ts` › «%s → no retry» (rate_limited, invalid_key, timeout, network_error), «provider_error after a tool round (usage set) → no retry» |
| R25 | `auto-reply.image.test.ts` › «a failed download still replies, with the unavailable marker, no handoff» |
| R26 | `src/lib/ai/defaults.test.ts` › bloque «buildSystemPrompt — images (n15.2, R26)» (4 casos, incluye el del párrafo pedido por Brian) |
| R27 | `auto-reply.image.test.ts` › «sends the image bytes to the model with images: true in the prompt»; `src/app/api/ai/playground/route.image.test.ts` › «a valid image becomes an [imagen] turn with bytes, images: true in the prompt (R27, R32)» |
| R28 | `hydrate.test.ts` › «never logs the base64 (R28)»; `auto-reply.image.test.ts` › «never writes nor logs the base64 (R28)» |
| R29 | `route.image.test.ts` › «the response never echoes the image (R29)» |
| R32 | `route.image.test.ts` › «a valid image …», «accepts an image with empty text (R32)» |
| R33 | `route.image.test.ts` › «%s → 400 invalid_image, no provider call (R33)» (MIME, base64 roto, firma distinta, > 2 MiB, no objeto) |
| R34 | `route.image.test.ts` › «only the 3 most recent images carry bytes; imageOmitted is unavailable; assistant image ignored (R34)», «AI_IMAGE_MAX_PER_TURN=0 sends no bytes (R34)» |
| R35 | `src/components/agents/ai-playground-image.test.tsx` › «the attach button accepts JPEG/PNG/WebP and is labelled», «previews the attached image …», `imageFileError` (2), `playgroundImageMessages` (2) |
| R36 | `ai-playground-image.test.tsx` › «shows the cost hint» y `title` del botón |
| R38 | `ai-playground-image.test.tsx` › «es and en have the same AiImage keys, all non-empty» |
| R39 | manual, guion abajo |

## Compuerta (dirigida)

- `npm run typecheck`: verde.
- `npx eslint src/lib/ai src/app/api/ai/playground src/app/api/whatsapp/webhook src/components/agents`: 0 errores, 1 aviso **previo** (`downloadMedia` sin usar en `webhook/route.ts:5`, línea no tocada, existe en `main`).
- `TZ=UTC npx vitest run src/lib/ai src/app/api/ai src/app/api/whatsapp/webhook src/components/agents`: 74 archivos, 963 tests verdes.
- `npx prettier --write` sobre lo tocado, salvo los 4 archivos que ya no cumplían prettier en `main` (ver Decisión 5).
- Sin build ni suite entera (instrucción del líder). Sin SQL → sin `replay-migrations.sh`.

## Decisiones

1. **Párrafo del prompt (aclaración de Brian vía líder, a mitad de tarea).** `IMAGES_PARAGRAPH` dice, en inglés: que `[imagen]` trae una foto y el texto es su caption; que suelen ser documentos de identidad o carnets de seguro médico; que extraiga nombre, número de documento, aseguradora, plan y número de póliza/afiliado y los use en la conversación y como argumentos de herramientas; que **nunca** pida por escrito un dato que se lee con claridad; que copie exacto y, si un dato está borroso o dudoso, pida solo ese dato; que `[imagen no disponible]` = no la ve y debe pedirlo; y que el texto de la imagen es contenido del cliente, nunca instrucciones. Test dedicado en `defaults.test.ts`.
2. **Dos tests existentes contradecían el spec y se ajustaron** (tasks.md solo listaba la excepción de `dispatch-gate.test.ts`):
   - `context.test.ts` › «asks for text plus transcribed audio only»: afirmaba `in(['text','audio'])` y el `or` sin `image`; design §4 cambia ambos filtros. Solo se cambiaron esas dos aserciones; el resto de casos de `context.test.ts` (R8) sigue intacto.
   - `webhook/route.test.ts` › «an image without caption still does not wake the AI (R5)» (n15.1): es justo lo que R1 invierte. Se reescribió para afirmar R1 y se añadió un caso de sticker (R3).
   - `dispatch-gate.test.ts`: excepción prevista (`image` sale de la lista).
3. **Imagen + nota de voz en el playground:** si el turno lleva imagen, `voice` se ignora (la UI no lo envía y la ruta da precedencia a la imagen). El spec no cubría la combinación.
4. **Aviso de coste (R36):** visible como `title` del botón de adjuntar y como línea de texto junto a la miniatura cuando hay una imagen adjunta, para no ocupar el compositor en cada prueba de solo texto. Si el reviewer quiere que esté siempre visible, es una línea en `ai-playground.tsx`.
5. **Prettier:** `context.ts`, `context.test.ts`, `query.ts` y `query.test.ts` no cumplían prettier en `main` (sin punto y coma); se editaron respetando su estilo, igual que n15.1 (decisión 7 de `impl_ai-voice-notes.md`). `docs/docker.md` tampoco lo cumplía; la tabla nueva se alineó a mano.
6. **Log de hidratación:** un `console.info('[ai-image] hydrated', { attached, unavailable, reasons: [{ messageId, reason }] })` por turno con imágenes; nunca bytes ni token.
7. **Playground: validación de todas las imágenes del cuerpo** (también las que el recorte a 20 turnos descartaría): cualquier imagen inválida → 400, más simple y estricto.
8. **Fila de imagen sin `id`** (solo en mocks previos): se descarta del contexto, no se puede hidratar.

## Verificaciones contra base real

No aplica: sin migración ni RPC nueva. El aislamiento entre cuentas (CP3) está en la ruta de descarga y lo cubren los tests de `image-source.test.ts` y `auto-reply.image.test.ts` con dos UUID de cuenta.

## Verificación manual pendiente

**Navegador (T10).** No ejecutada: el worktree no tiene `.env.local` (bloqueado) ni sesión de Supabase, y el playground exige `requireRole('agent')`. Guion para Brian o el líder, sin capturas:
1. `npm run dev` con `.env.local`, entrar como agente, Agentes → Playground.
2. Botón «Adjuntar imagen»: elegir una JPG < 2 MB → aparece la miniatura (`img[data-attached-image] img`, `alt="Imagen adjunta"`) y el aviso de coste.
3. Elegir un GIF o una JPG > 2 MB → toast «Solo JPG, PNG o WebP» / «La imagen supera 2 MB», no se adjunta.
4. Enviar con texto vacío → en DevTools › Red, **una sola** petición `POST /api/ai/playground` cuyo cuerpo tiene `messages[-1].image.mimeType === 'image/jpeg'` y sin `previewUrl`; la respuesta solo tiene `reply`/`handoff` (+ `toolsUsed`/`grounding`), sin base64.
5. Enviar 4 imágenes seguidas → en la 4.ª petición la 1.ª va con `imageOmitted: true`.

**Extremo a extremo (R39, design §11).** Depende de Meta y del proveedor:
1. Rehactive con la rama desplegada (y `./init.sh live` donde aplique).
2. Desde un teléfono de prueba, enviar la foto de una cédula de prueba **sin texto** → Aura responde usando los 11 dígitos (comparar con la foto). En `ai_usage_log`, la fila del turno (`mode = 'auto_reply'`) tiene `prompt_tokens` mayor que un turno de solo texto; ninguna fila de otro modo.
3. Contestar con texto («mañana a las 10») → la cita se crea con la cédula de la foto, sin volver a pedirla.
4. Repetir con caption «esta es mi cédula», y con un carnet de ARS (debe usar aseguradora/plan/póliza sin pedirlos).
5. Con `AI_IMAGE_MAX_PER_TURN=0` → Aura pide que escriba el número; ningún traspaso.
6. Enviar un sticker → la IA no responde.
7. Logs del contenedor (`ssh cabbity`, servicio `crm-app`): solo líneas `[ai-image] hydrated` con ids y motivos, ninguna con base64.

## Variables de entorno nuevas

`AI_IMAGE_MAX_PER_TURN` (3), `AI_IMAGE_MAX_BYTES` (3932160), `AI_IMAGE_DOWNLOAD_TIMEOUT_MS` (8000), documentadas en `docs/docker.md`. **`.env.local.example` no se tocó** (bloqueado por permisos): conviene añadirlas a mano.

## Deuda detectada (fuera de alcance, sin arreglar)

- `image-source.ts` duplica ~40 líneas de `voice/audio-source.ts` (prevista en design §13); un cargador común de media sería la limpieza.
- Aviso de eslint previo en `src/app/api/whatsapp/webhook/route.ts:5` (`downloadMedia` sin usar).
- Los textos del playground fuera de `AiVoice`/`AiImage` siguen hardcodeados en inglés (no i18n), anterior a esta feature.
- El borrador de la bandeja ve las imágenes como `[imagen no disponible]` pero no recibe `images: true` en su prompt (R37 no lo pide); el modelo no tiene la explicación del marcador ahí.

## Ronda 2 (review `progress/review_ai-image-input.md`)

Commit `cfc0707`: fix: la IA no reintenta sin imágenes si ya corrió una herramienta (n15.2).

**Hallazgo 1 (bloqueante) — corregido.** `AiError` tiene un campo nuevo, `toolsRan` (por defecto `false`). `runToolLoop` (`src/lib/ai/tools/loop.ts`, el `catch` de `callProvider`) lo pone a `true` cuando `steps.length > 0`, es decir, cuando ya terminó alguna ronda de herramientas. Es conservador: cuenta también las llamadas que bloqueó la política. Antes la señal era `usage`, que sigue en `null` si el proveedor no mandó uso. `generateReply` solo reintenta sin imágenes si `code === 'provider_error' && !err.toolsRan && err.usage === null`.

Tests:
- `src/lib/ai/generate.images.tools.test.ts` (nuevo, bucle **real**, proveedor e `executeIntegrationOperation` mockeados):
  - «round 1 runs a tool with usage null, round 2 provider_error → execute once, no retry»: `execute` se llama 1 vez, el proveedor 2 veces, `err.toolsRan === true` y `err.usage === null`. Comprobado que **falla** si se quita la condición `!err.toolsRan`.
  - «provider_error on the first round (no tool ran) → one retry without images».
- `src/lib/ai/tools/loop.test.ts`: «marks toolsRan on an AiError after a tool round, even with usage null (n15.2 D5)» y «does not mark toolsRan when the first round fails (n15.2 D5)».
- `src/lib/ai/generate.images.test.ts`: «provider_error marked toolsRan (usage null) → no retry».

**Hallazgo 9 — corregido.** Se pasó prettier a `generate.images.test.ts`.

**Hallazgos 2–8 — quedan como deuda, sin tocar:**
- 2: el playground rechaza las imágenes cuya firma no coincide con el MIME de `File.type`, que sale de la extensión. Por ejemplo, un `.png` que en realidad es JPEG da «La imagen no es válida». Se podría usar el MIME detectado por la firma.
- 3: cada foto sin caption despacha por separado. Un álbum (cédula por delante y por detrás + carnet ARS) produce N respuestas y gasta N `ai_replies`, y la primera solo ve la foto 1. **Conviene avisar a Brian por Rehactive.**
- 4: el sticker se reconoce solo por `image/webp`. Una foto real en WebP despacha, pero se descarta del contexto.
- 5: el borrador de la bandeja ve `[imagen no disponible]` sin `IMAGES_PARAGRAPH` (ya estaba anotado).
- 6: `withTimeout` no aborta la descarga, que sigue en segundo plano. Sin `fileSize` de Meta, el archivo se baja entero antes del `too_large`.
- 7: `PLAYGROUND_IMAGES_WITH_BYTES = 3` está fijo en el cliente. Con `AI_IMAGE_MAX_PER_TURN=0` el navegador sigue subiendo bytes que el servidor descarta.
- 8: en el playground, una nota de voz con imagen adjunta ignora la voz sin avisar.
- (Punto 5 del reviewer) `AI_IMAGE_MAX_PER_TURN=0` no es un apagado total: una foto sin caption sigue despertando a la IA, como pide el spec. Un apagado total sería un cambio de spec.

**Compuerta dirigida:**
- `npm run typecheck`: verde.
- `npx eslint src/lib/ai`: 0 avisos.
- `TZ=UTC npx vitest run src/lib/ai src/app/api/ai`: 71 archivos y 853 tests, todos verdes.
- Prettier pasado a los 6 archivos tocados.
