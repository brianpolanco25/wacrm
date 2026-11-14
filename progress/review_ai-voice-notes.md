# Review — n15.1 ai-voice-notes

**Veredicto:** APPROVED

Rama `feat/ai-voice-notes`, worktree `.claude/worktrees/ai-voice-notes`, base `main @ 2799b6b`,
commits `0c573d0..b130cc7` (4). El diff (58 archivos) coincide con el informe y con la tabla §5 del design.
Implementa la **D3 revisada**: un reintento solo ante transitorio (`isTransientTranscribeError`: network/timeout/429/5xx),
luego `sendVoiceFallback` con `ai_configs.voice_fallback_message` y cooldown de 10 min; sin traspaso, sin tocar
`conversations`, sin `claim_ai_reply_slot` ni `ai_replies` (`auto-reply.ts:215-236`). No hay restos de la D3 vieja
(`voiceFailure`, `buildHandoffSummary` y `handoff.ts` intactos).

## Compuerta (ejecutada por el reviewer, desde el worktree)
- lint: verde (0 errores, 34 warnings preexistentes)
- typecheck: verde
- test (`TZ=UTC npm test`, suite completa): verde — 380 archivos, 5873 tests, 7 skipped
- build (variables dummy de CI): verde
- replay-migrations (`scripts/replay-migrations.sh <worktree>`): verde, `096_ai_voice_notes.sql` ok, `verify-schema.sql: OK`
- `progress/checks_ai-voice-notes.sql` (KEEP=1, con la 096 copiada a `/tmp` del contenedor como exige su `\i`): `all passed`
- Reaplicar la 096 sobre la base migrada + `verify-schema.sql`: ok (idempotente)

## Trazabilidad criterio ↔ test
- R1, R2, R3, R43 [SQL]: [x] `progress/checks_ai-voice-notes.sql` (CHECKs, filas previas NULL, semilla en filas viejas y nuevas, modo `transcription`) + replay + reaplicación, corridos por mí.
- R4: [x] `webhook/route.test.ts` › "dispatches a voice note to the AI with its Meta media id and token (R4)"; `dispatch-gate.test.ts` › "audio with a media id → dispatch with voiceNote".
- R5: [x] `webhook/route.test.ts` › "a text inbound is dispatched without voiceNote", "an image without caption still does not wake the AI"; `auto-reply.voice.test.ts` › "text inbound (R5)".
- R6: [x] `webhook/route.test.ts` › "a voice note a flow consumed is not dispatched"; `dispatch-gate.test.ts` › "flowConsumed or interactiveReplyId → no dispatch, even for audio".
- R7: [x] `auto-reply.voice.test.ts` › 9 puertas (sin config, auto-reply off, cuota, cerrada, agente, disabled, cap, service-cap, reserva perdida); cada una asserta `ensureVoiceTranscript`, fallback y `generateReply` no llamados. «No escribible» y «plan sin ai_autoreply» comparten el mismo `try/catch` que la cuota (cubierto por el caso de cuota).
- R8: [x] `ensure-transcript.test.ts` › "a done row is reused without loading or transcribing", "a failed row → previous_attempt without calls".
- R9–R11: [x] `resolve-transcriber.test.ts` (6 casos, incl. anthropic → OpenAI/Gemini plataforma / null).
- R12: [x] `audio-source.test.ts` › cuenta A descarga; cuenta B, legado, `..`/`%2F` y otro bucket → `forbidden_path` sin `download`.
- R13: [x] `audio-source.test.ts` › proxy y `null` → `getMediaUrl`+`downloadMedia` con id y token; "never fetches an arbitrary URL" (fetch espiado, 0 llamadas).
- R14: [x] `audio-source.test.ts` › `fileSize` excesivo sin descargar; bytes excesivos (Meta y Storage).
- R15: [x] `ogg-duration.test.ts` (5) + `ensure-transcript.test.ts` › "an Ogg of 400 s → skipped/too_long".
- R16: [x] `ensure-transcript.test.ts` › "audio/amr → skipped/unsupported_format"; `resolve-transcriber.test.ts` › MIME.
- R17: [x] `providers/transcribe.test.ts` › multipart, `voice.ogg`, `response_format=json`, `AbortSignal`, usage normalizado, 401/429/500/timeout.
- R18: [x] `providers/transcribe.test.ts` › inlineData base64, `TRANSCRIBE_INSTRUCTION` anti-instrucción, clave en cabecera y no en URL.
- R19: [x] `ensure-transcript.test.ts` › timeout→éxito (2 llamadas, `sleep(1000)` una vez), 503×2, 429×2 (2 llamadas), `invalid_key` y 400 (1 llamada, sin sleep), fallos previos a la llamada (0 llamadas); `transcribe-errors.test.ts`.
- R20, R21: [x] `ensure-transcript.test.ts` › UPDATE con filtros `id`+`conversation_id`+`is transcript_status null`; vacío → `failed`, `transcript: null`.
- R22: [x] `ensure-transcript.test.ts` › "an UPDATE error still returns done"; `auto-reply.voice.test.ts` › "keeps the in-memory transcript…".
- R23: [x] `ensure-transcript.test.ts` › fila `transcription` con proveedor/modelo/key_source del transcriptor (anthropic → openai/platform). Una sola `logAiUsage` tras el éxito: el reintento no duplica uso (`ensure-transcript.ts:205-226`).
- R24: [x] `auto-reply.voice.test.ts` › `recordUsage` una vez y solo `ai_replies` de la respuesta.
- R25: [x] `context.test.ts` › filtros `.in`/`.or`, audio `done` → `[nota de voz] …` con `voice`, audio sin transcripción y de agente fuera.
- R26: [x] `defaults.test.ts` › párrafo tras el de contenido no confiable; sin `voiceNotes` idéntico byte a byte.
- R27: [x] `query.test.ts` › quita la marca solo en turnos `voice`; `auto-reply.voice.test.ts` › systemPrompt sin transcripción y knowledge sin marca.
- R28: [x] `auto-reply.voice.test.ts` › skipped/failed → fallback 1 vez, sin `generateReply`, sin UPDATE de `conversations`, sin `claim_ai_reply_slot`, sin `recordUsage`; `fallback.test.ts` › `aiGenerated: true`.
- R29: [x] `fallback.test.ts` › fila 9 min → cooldown, 11 min → envía, limitador real dos llamadas → un envío, error de lectura fail-open.
- R30: [x] `auto-reply.voice.test.ts` › fallback y transcript que lanzan no propagan; `ensure-transcript.test.ts` › loader que lanza.
- R31: [x] `ensure-transcript.test.ts` › "no log line contains the transcript or the token"; `audio-source.test.ts` › token fuera de console; `fallback.test.ts` › texto fuera del log.
- R32: [x] `ensure-transcript.test.ts` › fila B mismo id en otra conversación ni leída ni escrita; con ambas solo A; `fallback.test.ts` › filtro `conversation_id` y fila de otra conversación sin cooldown.
- R33, R34: [x] `voice-transcript.test.tsx` (done, escape, failed/skipped, null; es/en).
- R36: [x] `playground/route.voice.test.ts` (3: marca + párrafo, `voice` en assistant/no booleano ignorado, sin transcribir ni fila `transcription`).
- R37: [x] `ai-playground-voice.test.tsx` (aria-pressed, etiqueta, `voice: true` solo en el turno marcado).
- R38: [x] claves presentes en `messages/es.json` y `en.json`; `messages.test.ts`/`icu-safety.test.ts` verdes.
- R41, R42: [x] `fallback.test.ts` › null/blanco → `opted_out` sin consultas; send que lanza → `send_failed`.
- R44: [x] `fallback-message.test.ts` (migración, placeholder en, clave es).
- R45: [x] `config.test.ts` › select y mapeo de `voice_fallback_message`.
- R46: [x] `api/ai/config/route.test.ts` › 6 casos (trim, '', 1001 → 400, no-string → 400, ausente no toca, GET).
- R35, R39, R40, R47 [M]: [x] guion manual en `progress/impl_ai-voice-notes.md` (pasos 0–4 = design §11); pendiente de ejecutar por el humano.

Red real: ninguna. `transcribe.test.ts` y `audio-source.test.ts` hacen `vi.stubGlobal('fetch')` + `vi.unstubAllGlobals()` en `afterEach`; el resto inyecta `transcribe`/`loadAudio`/`send`/`getUrl`/`download` o mockea `generate`, `meta-send` y `meta-api`.

## Checkpoints
- CP1 Compuerta: [x] verde, ejecutada por mí (arriba).
- CP2 Migraciones: [x] 096 idempotente (`IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS`, `to_regclass`), bloque `-- 096` en `verify-schema.sql` por cada objeto, replay 0, sin CASCADE.
- CP3 Aislamiento: [x] `messages` por `id`+`conversation_id` de conversación verificada con `.eq('account_id')` (`auto-reply.ts:126-133`); Storage con `assertStoragePathOwnedBy` → `kind: 'account'` antes de `download` (`audio-source.ts:102-108`); Meta solo con el `metaMediaId`/token del webhook; URL arbitraria rechazada. Tests de fuga presentes.
- CP4 Tests: [x] ver trazabilidad.
- CP5 Sin dependencias: [x] `package.json`/lock sin cambios.
- CP6 i18n: [x] 8 claves nuevas en es y en, sin placeholders ICU.
- CP7 Next 16: [x] sin APIs nuevas de framework (sigue dentro del `after()` existente).
- CP8 Alcance: [x] solo archivos de la tabla §5 + módulos nuevos del design; `gemini.ts` solo exporta `GEMINI_BASE_URL` (previsto).
- CP9 Documentación: [x] CHANGELOG (Unreleased), `docs/docker.md` con las 5 variables, informe. `.env.local.example` no actualizado (bloqueado por permisos; anotado en el informe).
- CP10 Git: [x] 4 commits en español con prefijo y `Co-Authored-By`; `main` = 2799b6b intacto; nada pusheado.
- CP11 Entrante nunca se bloquea: [x] el dispatch va tras el insert; `ensureVoiceTranscript`/`sendVoiceFallback` nunca lanzan y el `try` exterior de `dispatchInboundToAiReply` sigue.

## Hallazgos (no bloqueantes; contrastados con el skill `code-review` high)
1. `src/lib/ai/voice/config.ts:89` — `withVoiceTurn` deduplica contra *cualquier* turno de voz previo con el mismo texto. Si el UPDATE falló (R22) y el cliente ya había mandado antes una nota con la misma transcripción («sí»), la nota actual no se añade y el modelo responde al contexto viejo. Comparar solo con el último turno del contexto.
2. `src/lib/ai/voice/fallback.ts:82-89` — el limitador en memoria se consume antes de `send`; si `engineSendText` lanza (R42), el slot queda tomado y durante 10 min ninguna nota de voz de esa conversación recibe nada. Aceptable por R29 literal, pero conviene no gastar el slot ante `send_failed`.
3. `src/lib/ai/providers/transcribe-openai.ts:44` + `src/lib/ai/voice/resolve-transcriber.ts:20-23` — `audio/m4a`, `audio/wav`, `audio/webm`, `audio/flac` están admitidos para OpenAI pero `extensionForMime` (`src/lib/media/filename.ts:39-44`) no los mapea → `voice.bin` → 400 probable. Impacto bajo (WhatsApp manda ogg/mpeg/mp4/aac/amr), pero o se mapean o se sacan de la lista. Reconfirmar en el paso 4 del guion manual.
4. `src/lib/ai/auto-reply.ts:216` vs `:259` — la transcripción (de pago) va antes del limitador por cuenta `aiAutoReplyAccount`; en una ráfaga que lo supere se paga transcripción sin respuesta. Conforme al design §1/§3 (transcribir tras la reserva, antes del contexto); se anota como riesgo de coste para una iteración posterior.
5. `src/lib/ai/providers/transcribe-gemini.ts:84` — no filtra partes `thought: true` como hace `gemini.ts:252`. Sin `includeThoughts` no llegan, así que hoy no aplica; alinear por consistencia.
6. Despliegue: `loadAiConfig` (`src/lib/ai/config.ts:31`) y `buildConversationContext` seleccionan columnas de la 096; con el código desplegado antes de la migración se rompe toda la IA, no solo la voz. Lo prevé el design §2 y el CHANGELOG («apply it before deploying»); el humano debe aplicar la 096 en el Supabase remoto **antes** del deploy.

## Cambios requeridos
Ninguno bloqueante. Los hallazgos 1–3 son correcciones pequeñas recomendables antes o después del merge.
