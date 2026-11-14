# Review — n15.2 ai-image-input

**Veredicto:** APPROVED (ronda 2; la ronda 1 fue CHANGES_REQUESTED)

Rama `feat/ai-image-input` (worktree `.claude/worktrees/ai-image-input`), commits `9b42939`, `90953bf` sobre `main @ 0224f5f`. Revisado el diff completo `0224f5f..HEAD` (45 archivos), el informe y el spec.

## Compuerta (dirigida, por orden del líder; ejecutada por el reviewer)
- `npm run typecheck`: verde.
- `npx eslint src/lib/ai src/app/api/ai/playground src/app/api/whatsapp/webhook src/components/agents`: 0 errores, 1 aviso previo (`webhook/route.ts:5` `downloadMedia` sin usar; ya está en `main`).
- `TZ=UTC npx vitest run src/lib/ai src/app/api/ai src/app/api/whatsapp/webhook src/components/agents`: 74 archivos, 963 tests verdes. `src/app/api/ai` + `resume`: 99 verdes.
- build / suite completa: no corridos (instrucción del líder).
- replay-migrations: n/a (sin SQL).
- prettier (no está en CI): `src/lib/ai/generate.images.test.ts` (archivo nuevo) no cumple; los otros 4 avisos son de archivos que ya no cumplían en `main`.

## Trazabilidad criterio ↔ test (tests leídos)
- R1 [x] `voice/dispatch-gate.test.ts` › "image with a media id and no text → dispatch with inboundImage (R1)"; `webhook/route.test.ts` › "an image without caption wakes the AI with inboundImage (n15.2 R1)".
- R2 [x] `dispatch-gate.test.ts` › "image with caption → dispatch with inboundImage (R2)".
- R3 [x] `dispatch-gate.test.ts` (sin id, sticker, vídeo, documento; flow/interactivo); `webhook/route.test.ts` › "a sticker still does not wake the AI".
- R4 [x] `auto-reply.image.test.ts` › bloque "image gates (R4)": 11 puertas, aserta que ni `storage.download` ni `getMediaUrl` ni `generateReply` se llaman. El rate limit por cuenta no tiene caso propio (está mockeado a éxito), pero en el código la hidratación va después (`auto-reply.ts:279-296`).
- R5, R30 [x] "logs one usage row … charges one ai_replies".
- R6, R7, R37 [x] `context.test.ts` bloque "customer images (n15.2)".
- R8 [x] casos previos de `context.test.ts` intactos salvo la aserción de filtros (ver punto 6).
- R9 [x] `images/hydrate.test.ts` › "attaches only the 3 most recent of 5 images", "maxPerTurn 0".
- R10 [x] `images/config.test.ts`.
- R11 / CP3 [x] `image-source.test.ts` › "cross-account leak (CP3)" (A rechaza B, B lee lo suyo, download 1 vez) y "refuses legacy, .., %2F, another bucket and another origin without downloading"; `auto-reply.image.test.ts` › "an image of another account is never downloaded (CP3)".
- R12 [x] `image-source.test.ts` (proxy sin source sin red; con source; fileSize > tope sin descargar); `hydrate.test.ts` › "passes the Meta source only to the current inbound turn".
- R13 [x] `sniff.test.ts`; `image-source.test.ts` (MIME de los bytes, too_large, unsupported_format).
- R14 [x] `image-source.test.ts` (timeout con fake timers, throw, error de storage); `hydrate.test.ts` › "a failed or throwing load…".
- R15 [x] `query.test.ts`.
- R16–R21 [x] `providers/{gemini,openai,anthropic}.images.test.ts`, `shared.test.ts` (incluye cuerpo idéntico sin imágenes).
- R22 [x] `vision.test.ts`; `generate.images.test.ts` › "a no-vision model…".
- R23, R31 [x] `generate.images.test.ts` › "provider_error with usage null → one retry…", "a failing retry propagates".
- R24 [~] `generate.images.test.ts` cubre los 4 códigos y "after a tool round (usage set)", pero solo con el error ya construido con `usage`; no cubre una ronda de herramientas cuyo proveedor no devolvió `usage` (hallazgo 1).
- R25 [x] "a failed download still replies, with the unavailable marker, no handoff".
- R26 [x] `defaults.test.ts` bloque images (incluye el párrafo de Brian: cédula/ARS, extraer nombre, documento, aseguradora, plan; no volver a pedir lo legible; pedir solo lo dudoso).
- R27 [x] `auto-reply.image.test.ts`, `playground/route.image.test.ts`.
- R28 [x] `hydrate.test.ts` › "never logs the base64"; `auto-reply.image.test.ts` › "never writes nor logs the base64" (espía de console + registro de escrituras; también el token).
- R29, R32–R34 [x] `playground/route.image.test.ts`.
- R35, R36, R38 [x] `ai-playground-image.test.tsx`.
- R39 [x] guion manual en el informe (Meta + proveedor), sin ejecutar.

## Checkpoints
- CP1 [~] dirigida en verde (typecheck, eslint, vitest); build y suite completa no corridos por instrucción.
- CP2 [x] n/a, sin SQL.
- CP3 [x] la única lectura con rol de servicio nueva es `storage.from('chat-media').download`, precedida de `parseStorageObjectUrl` (origen + canónica) + bucket `chat-media` + `assertStoragePathOwnedBy(...).kind === 'account'` (`image-source.ts:474-490`); test de fuga entre dos cuentas. La consulta de `context.ts` filtra por `conversation_id`, ya validada contra `account_id` en `auto-reply.ts`.
- CP4 [~] todo cubierto salvo el hueco de R24 (hallazgo 1).
- CP5 [x] `package.json`/lock sin cambios.
- CP6 [x] `AiImage` con 7 claves iguales en `es` y `en`.
- CP7 [x] sin API nueva de framework; Route Handler `POST` existente y componente `'use client'` con hooks de React y `next-intl`. Cuerpo máx. 3 × 2 MiB ≈ 8 MiB base64 < `proxyClientMaxBodySize` 10 MB (`src/middleware.ts` activo).
- CP8 [x] el diff se ciñe al design; el webhook solo cambia la llamada (`route.ts:1407`, `1418`).
- CP9 [x] CHANGELOG Unreleased, `docs/docker.md` con las 3 variables, informe coincide con el diff. `.env.local.example` sin tocar (bloqueado), anotado.
- CP10 [x] 2 commits en español con prefijo y `Co-Authored-By`, sin push.
- CP11 [x] el insert del entrante no cambia; la hidratación ocurre dentro de `dispatchInboundToAiReply`, después.

## Puntos pedidos por el líder
1. Storage: [x] solo `chat-media`, ruta canónica, `assertStoragePathOwnedBy` con el `accountId` de la conversación antes del download; otra cuenta / legacy / `..` / `%2F` / otro bucket / otro origen → `forbidden_path` sin descarga. Meta solo cuando `media_url` es nula o proxy **y** el turno es el entrante actual (`hydrate.ts:276-280`); el `metaMediaId` sale del webhook, nunca de `media_url`, así que una `media_url` manipulada no puede redirigir la descarga.
2. Privacidad: [x] el único log es `[ai-image] hydrated` con conteos, `messageId` y códigos de motivo; ninguna escritura en BD/bucket; `ai_usage_log` recibe solo `usage`.
3. Puertas y reserva: [x] la hidratación va después de config, billing, puertas de conversación, `pause_ai`, `claimInboundAutoReply` y rate limit por cuenta. Stickers: llegan como `type: 'sticker'` → sin `imageMediaId` → no despachan; en contexto se filtran por `image/webp`.
4. Reintento: [ ] ver hallazgo 1.
5. Topes: [x] 3 / 3 932 160 B / 8000 ms. **`AI_IMAGE_MAX_PER_TURN=0` NO deja el comportamiento byte a byte como antes**: una foto sin caption sigue despertando a la IA (antes no), el contexto lleva `[imagen no disponible]` y el prompt lleva `IMAGES_PARAGRAPH`. Es lo que pide el spec (R10 «0 desactiva la visión: todas quedan como no disponibles»; R39 paso 5 espera que Aura pida el número), así que no lo bloqueo; si el líder quiere un apagado total, es un cambio de spec (que `=0` tampoco despache imágenes sin caption).
6. Tests cambiados: [x] justificados. `context.test.ts` solo cambia la aserción de los filtros `in`/`or`, que design §4 amplía; el resto de casos sigue igual (R8). `webhook/route.test.ts` invierte "image without caption does not wake the AI" de n15.1 porque R1 lo invierte explícitamente, y añade el caso de sticker que conserva la protección. `dispatch-gate.test.ts` saca `image` de la lista sin despacho y lo cubre aparte. No ocultan regresión.
7. Playground: [x] tope de 2 MiB por imagen decodificada en servidor (`images/playground.ts:28-33`, con cota previa sobre la longitud base64), MIME en lista blanca + firma que coincide; 400 `invalid_image` antes de `loadAiConfig`; la respuesta no devuelve la imagen. No hay tope del cuerpo total aparte del de 10 MB del proxy (no lo pide el spec).

## Hallazgos (archivo:línea)
1. **`src/lib/ai/generate.ts:107-116` + `src/lib/ai/tools/loop.ts:265-270`** — el reintento sin imágenes usa `err.usage === null` como prueba de que «no corrió ninguna herramienta», pero eso no es cierto. En `runToolLoop`, `usage = sumUsage(usage, round.usage)` se queda en `null` si la ronda que pidió las herramientas vino sin bloque de uso (`normalizeUsage` devuelve `null` si faltan los contadores o valen 0, `providers/shared.ts:44`). Entrada que falla: ronda 1 con `toolCalls: [crear_cita]` y `usage: null` → la herramienta se ejecuta (cita creada) → la ronda 2 lanza `AiError('provider_error')` (p. ej. un 5xx) → en el `catch` de `loop.ts:266` no se suma nada porque `usage` es null → `generateReply` ve `err.usage === null` y vuelve a lanzar `runToolLoop` entero → el modelo puede volver a llamar `crear_cita` → **cita duplicada**. Justo lo que D5/R24 prometen evitar. Con los tres endpoints oficiales casi siempre viene `usage`, pero la garantía no puede depender de eso.
2. `src/lib/ai/images/playground.ts:35` — rechaza si la firma no coincide con el MIME declarado, y el cliente toma el MIME de `File.type` (sale de la extensión): un `cedula.png` que en realidad es JPEG da «La imagen no es válida». Es lo que dice R33, así que no bloquea; mejora posible: usar el MIME detectado, como en producción (R13).
3. `src/lib/ai/voice/dispatch-gate.ts:31` — cada foto sin caption despacha por separado. Un álbum (cédula por delante y por detrás + carnet ARS) son N webhooks → hasta N respuestas, N `ai_replies` y N turnos con visión, y el primero solo ve la foto 1. Pasa lo mismo con ráfagas de texto, y el spec (R1) lo acepta; vale la pena avisar a Brian por el caso Rehactive. No bloquea.
4. `src/lib/ai/context.ts:61` — el sticker se identifica solo por `media_type = image/webp`. Una foto real en WebP despacha (`type: 'image'`) pero se descarta del contexto y la IA contesta al turno anterior. Es raro (WhatsApp manda las fotos en JPEG) y es la regla del spec; no bloquea.
5. `src/app/api/ai/draft/route.ts` (sin tocar) — el borrador ve ahora `[imagen no disponible]` sin `IMAGES_PARAGRAPH`. El informe lo anota como deuda; R37 no pide más.
6. `src/lib/ai/images/image-source.ts:372-382` — `withTimeout` no aborta la descarga de Storage/Meta, que sigue en segundo plano; si Meta no declara `fileSize`, el archivo se baja entero antes del `too_large`. Memoria acotada por turno; no bloquea.
7. `src/components/agents/ai-image.tsx:21` — `PLAYGROUND_IMAGES_WITH_BYTES = 3` fijo en el cliente: con `AI_IMAGE_MAX_PER_TURN=0` el navegador sigue subiendo hasta ~8 MB que el servidor descarta. R35 fija el 3; no bloquea.
8. `src/components/agents/ai-playground.tsx:69` — con «nota de voz» activada y una imagen adjunta, la voz se ignora sin avisar (decisión 3 del informe). Menor.
9. `src/lib/ai/generate.images.test.ts:112-117` — no cumple prettier (archivo nuevo). Menor.

## Cambios requeridos
1. Que el reintento sin imágenes no se haga si se ejecutó alguna herramienta, **sin depender de que el proveedor mande el uso**. Por ejemplo: en `runToolLoop`, cuando `steps.length > 0` (o `executed > 0`), marcar el `AiError` que se propaga (un campo `toolsRan`/`afterToolRound`, o `err.usage` puesto a cero en vez de `null`) y que `generateReply` lo compruebe. Hay que tocar `tools/loop.ts`, y D5 lo justifica. Añadir un test en `generate.images.test.ts` o `tools/loop.test.ts`: con `callProvider` reales, ronda 1 con `toolCalls` y `usage: null`, `execute` llamado, ronda 2 lanza `provider_error` → `execute` se llama **una sola vez** y no hay reintento.
2. (Opcional, en la misma pasada) `npx prettier --write src/lib/ai/generate.images.test.ts`.

## Ronda 2 — commit `cfc0707`

**Veredicto:** APPROVED

- **Hallazgo 1 corregido.** `AiError.toolsRan` (por defecto `false`, `types.ts`). `runToolLoop` lo pone a `true` en el `catch` de `callProvider` cuando `steps.length > 0` (`tools/loop.ts:266-271`). Eso pasa cuando ya terminó una ronda con llamadas a herramientas, aunque la política las haya bloqueado: es conservador. La ronda correctiva de grounding no añade `steps` porque no ejecuta herramientas. `generateReply` exige `!err.toolsRan && err.usage === null` (`generate.ts:65-69`).
- Caso de la ronda 1, con el bucle real: `generate.images.tools.test.ts` › "round 1 runs a tool with usage null, round 2 provider_error → execute once, no retry". `execute` se llama 1 vez y el proveedor 2; `err.usage === null` y `err.toolsRan === true`. **Mutación comprobada por el reviewer:** quitando `!err.toolsRan` de `generate.ts`, este test falla. Restaurado; el worktree queda limpio.
- El camino normal sigue igual: "provider_error on the first round (no tool ran) → one retry without images" reintenta una vez, sin `images` y con `[imagen no disponible] mi cédula`. `loop.test.ts` cubre que `toolsRan` queda en `false` si falla la primera ronda.
- Prettier: los archivos de `cfc0707` lo cumplen.
- Compuerta dirigida (ejecutada por el reviewer): typecheck verde. eslint sobre `src/lib/ai`, `playground`, `webhook` y `components/agents`: 0 errores y el aviso previo de `webhook/route.ts:5`. `TZ=UTC vitest` sobre esas carpetas y `src/app/api/ai`: 968/968 verdes.
- Hallazgos 2–8: siguen como deuda no bloqueante, tal como los anota el informe. Para Brian quedan pendientes dos puntos: el 3 (un álbum de fotos produce N respuestas) y que `AI_IMAGE_MAX_PER_TURN=0` no es un apagado total.
