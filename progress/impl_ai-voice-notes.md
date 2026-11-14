# impl n15.1 `ai-voice-notes`

Estado: **implementado, compuerta dirigida en verde**. Pendiente: review y guion manual (T10).

## Plan seguido (tasks.md)

T1 migración 096 → T2 puros → T3 adaptadores → T4 origen del audio → T5 orquestador → T6 contexto/consulta/prompt → T6b texto de reserva configurable → T7a envío del texto de reserva → T7 dispatch + webhook → T8 borrador/playground → T9 bandeja + i18n → T11 compuerta, CHANGELOG, docker.md. T10 (manual) queda para el humano.

## Rama y commits

Rama `feat/ai-voice-notes` (worktree `.claude/worktrees/ai-voice-notes`), base `main @ 2799b6b`:

- `0c573d0` feat: migración 096 para transcripciones de notas de voz (n15.1)
- `3aee0f3` feat: la IA responde a notas de voz transcribiéndolas (n15.1)
- `8d353c8` feat: transcripción en la bandeja, texto de reserva en Ajustes y voz en el playground (n15.1)
- `b130cc7` docs: notas de voz en CHANGELOG y variables nuevas en docker.md (n15.1)

Nota: `fallback-message.test.ts` (commit 3aee0f3) lee la clave `voiceFallbackMessagePlaceholder` que llega en 8d353c8; la rama es verde en su punta, no commit a commit.

## Qué se hizo

- **Migración** `supabase/migrations/096_ai_voice_notes.sql` (design §2 literal) + bloque `-- 096` en `supabase/ci/verify-schema.sql`.
- **Módulo nuevo** `src/lib/ai/voice/`: `types.ts`, `config.ts` (límites por env, `cleanTranscript`, `formatVoiceNote`, `stripVoiceNoteMarker`, `withVoiceTurn`), `ogg-duration.ts`, `resolve-transcriber.ts` (+`TRANSCRIBE_MIME`), `dispatch-gate.ts` (`aiReplyDispatchPlan`), `audio-source.ts` (`loadVoiceNoteAudio`), `transcribe.ts`, `ensure-transcript.ts` (orquestador con reintento), `fallback-message.ts` (`DEFAULT_VOICE_FALLBACK_MESSAGE`), `fallback.ts` (`sendVoiceFallback`), `voice-test-support.ts` (fake de base para tests, patrón de `providers/tools-test-support.ts`).
- **Adaptadores** `src/lib/ai/providers/transcribe-openai.ts`, `transcribe-gemini.ts`, `transcribe-errors.ts` (`TranscribeHttpError`, `isTransientTranscribeError`); `gemini.ts` solo exporta `GEMINI_BASE_URL`.
- **Cambios existentes**: `auto-reply.ts` (bloque tras la reserva: transcribe; sin transcripción → `sendVoiceFallback` y `return`; el bloque de traspaso no se toca; `voiceNotes` al prompt), webhook (`aiReplyDispatchPlan`), `context.ts`, `query.ts`, `defaults.ts` (`VOICE_NOTES_PARAGRAPH` tras el párrafo de contenido no confiable), `types.ts` (`ChatMessage.voice`, `AiConfig.voiceFallbackMessage?`), `config.ts`, `usage.ts`, `/api/ai/config`, `/api/ai/draft`, `/api/ai/playground`, `ai-playground.tsx` (+ `ai-voice.tsx` nuevo), `ai-config.tsx`, `message-media.tsx` (+ `voice-transcript.tsx` nuevo), `src/types/index.ts`, `messages/{es,en}.json`.

## Trazabilidad R → código → test

| R | Código | Test (archivo › `it`) |
|---|---|---|
| R1, R2, R3, R43 | `096_ai_voice_notes.sql`, `verify-schema.sql` | `progress/checks_ai-voice-notes.sql` (SQL, ver abajo) + `replay-migrations.sh` |
| R4 | `webhook/route.ts`, `voice/dispatch-gate.ts` | `webhook/route.test.ts` › «dispatches a voice note to the AI with its Meta media id and token (R4)»; `voice/dispatch-gate.test.ts` › «audio with a media id → dispatch with voiceNote (R4)» |
| R5 | idem | `webhook/route.test.ts` › «a text inbound is dispatched without voiceNote (R5)», «an image without caption still does not wake the AI (R5)»; `dispatch-gate.test.ts` › «text → dispatch…», «image/video/document…»; `auto-reply.voice.test.ts` › «text inbound (R5) › never transcribes nor sends the fallback» |
| R6 | idem | `webhook/route.test.ts` › «a voice note a flow consumed is not dispatched (R6)»; `dispatch-gate.test.ts` › «flowConsumed or interactiveReplyId → no dispatch, even for audio (R6)» |
| R7 | `auto-reply.ts` | `auto-reply.voice.test.ts` › «voice note gates (R7)…» (9 casos: AI off, auto-reply off, quota, closed, agent, ai_autoreply_disabled, cap, service-cap, reserva perdida) |
| R8 | `voice/ensure-transcript.ts` | `ensure-transcript.test.ts` › «a done row is reused…», «a failed row → previous_attempt…»; `auto-reply.voice.test.ts` › «transcribes after the reservation…» |
| R9, R10, R11 | `voice/resolve-transcriber.ts` | `resolve-transcriber.test.ts` (6 casos) |
| R12 | `voice/audio-source.ts` | `audio-source.test.ts` › «downloads an account-A object…», «refuses account B…», «refuses a legacy…», «refuses .. and %2F…», «refuses another bucket of ours» |
| R13 | idem | `audio-source.test.ts` › «uses getMediaUrl + downloadMedia…», «also goes to Meta when media_url is null», «never fetches an arbitrary URL» |
| R14 | idem + orquestador | `audio-source.test.ts` › «a declared fileSize over the limit…», «downloaded bytes over the limit…», «a downloaded object over the limit…»; `ensure-transcript.test.ts` › «a loader skipped/too_large…» |
| R15 | `voice/ogg-duration.ts`, orquestador | `ogg-duration.test.ts` (5 casos); `ensure-transcript.test.ts` › «an Ogg of 400 s → skipped/too_long» |
| R16 | `resolve-transcriber.ts`, orquestador | `resolve-transcriber.test.ts` › «both accept audio/ogg; neither accepts audio/amr»; `ensure-transcript.test.ts` › «audio/amr → skipped/unsupported_format» |
| R17 | `providers/transcribe-openai.ts` | `providers/transcribe.test.ts` › «POSTs one multipart request…», «returns usage null…», 401/429/500/TimeoutError |
| R18 | `providers/transcribe-gemini.ts` | `providers/transcribe.test.ts` › «sends the audio inline as base64 with the anti-instruction prompt», «maps 503…», «returns an empty text…» |
| R19 | `transcribe-errors.ts`, orquestador | `transcribe-errors.test.ts` (5 casos); `ensure-transcript.test.ts` › «timeout then success…», «503 twice…», «429 twice…», «invalid_key → 1 call, no sleep», «400 → 1 call», «a loader skipped/too_large or failed/forbidden_path → 0 transcribe calls» |
| R20 | orquestador, `config.ts` | `ensure-transcript.test.ts` › «stores the clean transcript with the guarded UPDATE…», «a blank result → failed/empty»; `voice/config.test.ts` › «cleanTranscript (R20)» |
| R21 | orquestador | `ensure-transcript.test.ts` › «no transcriber → UPDATE skipped…», «an Ogg of 400 s…», «a blank result…» (fila con `transcript: null`) |
| R22 | orquestador, `withVoiceTurn` en `auto-reply.ts` | `ensure-transcript.test.ts` › «an UPDATE error still returns done (R22)»; `auto-reply.voice.test.ts` › «keeps the in-memory transcript when the stored one is missing (R22)» |
| R23 | orquestador, `usage.ts` | `ensure-transcript.test.ts` › «stores the clean transcript… and logs transcription usage», «an anthropic account logs the transcriber (openai/platform)…» |
| R24 | `auto-reply.ts` | `auto-reply.voice.test.ts` › «transcribes after the reservation…» (`recordUsage` 1 vez) |
| R25 | `context.ts` | `context.test.ts` › «voice notes (n15.1, R25)» (3 casos) + casos existentes intactos |
| R26 | `defaults.ts`, draft/playground/auto-reply | `defaults.test.ts` › «voice notes (n15.1, R26)» (3 casos); `auto-reply.voice.test.ts` › `voiceNotes: true/false` |
| R27 | `query.ts`, `auto-reply.ts` | `query.test.ts` › «strips the voice-note marker…», «keeps a typed "[nota de voz]" prefix…»; `auto-reply.voice.test.ts` › «transcribes after the reservation…» (systemPrompt sin transcripción, knowledge sin marca) |
| R28 | `auto-reply.ts`, `voice/fallback.ts` | `auto-reply.voice.test.ts` › «skipped/no_transcriber → fallback once, nothing else», «failed/timeout → …»; `fallback.test.ts` › «no previous row → sent with aiGenerated and the trimmed text» |
| R29 | `voice/fallback.ts` | `fallback.test.ts` › «a bot row with the same text 9 min ago → cooldown», «the same row 11 min ago → sent», «two calls in a row with the real limiter…», «a read error fails open…» |
| R30 | `auto-reply.ts`, orquestador, fallback | `auto-reply.voice.test.ts` › «a throwing sendVoiceFallback…», «a throwing ensureVoiceTranscript…»; `ensure-transcript.test.ts` › «a throwing loader → failed…» |
| R31 | orquestador, audio-source, fallback | `ensure-transcript.test.ts` › «no log line contains the transcript or the token»; `audio-source.test.ts` › «a Meta error → download_failed, and the token never reaches console»; `fallback.test.ts` › «a throwing send… text not logged» |
| R32 | orquestador, fallback | `ensure-transcript.test.ts` › «a message of account B with the same id in another conversation is neither read nor written», «with both rows present only A is updated»; `fallback.test.ts` › «filters by conversation…», «a row with the text in ANOTHER conversation does not cause cooldown» |
| R33, R34 | `inbox/voice-transcript.tsx`, `message-media.tsx` | `voice-transcript.test.tsx` (es/en: done, escape, failed/skipped, null) |
| R36 | `api/ai/playground/route.ts` | `playground/route.voice.test.ts` (3 casos) |
| R37 | `agents/ai-voice.tsx`, `ai-playground.tsx` | `agents/ai-playground-voice.test.tsx` (aria-pressed, etiqueta es/en, `playgroundRequestMessages`) |
| R38 | `messages/{es,en}.json` | `src/i18n/messages.test.ts`, `icu-safety.test.ts` (verdes) + tests de render es/en |
| R44 | `voice/fallback-message.ts` | `voice/fallback-message.test.ts` (migración 096, placeholder en, clave es) |
| R45 | `lib/ai/config.ts` | `config.test.ts` › «loadAiConfig voice fallback message (n15.1, R45)» (3 casos) |
| R46 | `api/ai/config/route.ts` | `api/ai/config/route.test.ts` › «voice fallback message (n15.1, R46)» (6 casos, incl. GET) |
| R41 | `voice/fallback.ts` | `fallback.test.ts` › «null and blank text → opted_out without a query or a send» |
| R42 | idem | `fallback.test.ts` › «a throwing send → send_failed, not propagated, text not logged» |
| R35, R39, R40, R47 | — | **[M]** guion manual abajo (pendiente del humano) |

Ningún test existente se reescribió; solo se añadieron casos. Excepción permitida por tasks.md: el fake de `context.test.ts` gana `in`/`or` (y registra llamadas) sin tocar sus aserciones.

## Verificación contra base real (Postgres del harness)

- `scripts/replay-migrations.sh <worktree>` → todas aplican, `verify-schema.sql: OK`, salida 0 (dos ejecuciones, la última tras el commit final).
- `KEEP=1` + `progress/checks_ai-voice-notes.sql` (en transacción con ROLLBACK): simula «antes de la 096» quitando sus objetos, siembra filas, reaplica la 096 y comprueba: R3 (filas previas `NULL` y sin reescritura de otras columnas), R43 (fila previa y nueva de `ai_configs` leen la semilla), R1 (`transcript_status='x'` falla; `transcript` en fila `text` falla; 4001 caracteres falla; 4000 ok; audio `done` ok), R2 (`mode='transcription'` ok, `'otro'` falla). Resultado: `NOTICE: checks_ai-voice-notes: all passed`.
- Segunda aplicación de la 096 sobre la base ya migrada + `verify-schema.sql` → OK (idempotencia R2).

## Compuerta (dirigida, desde el worktree)

| Comando | Resultado |
|---|---|
| `npm run lint` | 0 errores; 37 warnings, todos preexistentes (los de los archivos tocados son los mismos 8 que en `HEAD`) |
| `npm run typecheck` | 0 errores |
| `TZ=UTC npx vitest run src/lib/ai src/app/api/ai src/app/api/whatsapp/webhook src/components/agents src/components/inbox src/i18n` | 58 archivos, 649 tests, verde |
| `TZ=UTC npx vitest run src/lib/whatsapp src/lib/media` | 804 tests, verde |
| `npm run build` (variables dummy de CI) | salida 0 |
| `scripts/replay-migrations.sh <worktree>` | salida 0 |

No se corrió `npm test` completo ni el gate completo de scope (instrucción del líder).

## Decisiones donde el spec dejaba margen

1. **R22 en el turno**: si el `UPDATE` de la transcripción falla, `buildConversationContext` no la ve. Para «seguir con el resultado en memoria», `auto-reply.ts` añade el turno de voz al contexto con `withVoiceTurn` (solo si no está ya). Sin esto R22 se cumpliría en el orquestador pero el turno respondería sin la nota de voz.
2. **`done` sin texto** en una fila (no debería existir por los CHECK, pero la columna lo permite) se trata como `failed/previous_attempt` en vez de reintentar.
3. **Playground**: los turnos se normalizan a `{role, content[, voice]}` antes de llegar al modelo (antes se pasaban los objetos del body tal cual; los adaptadores ya ignoraban el resto). El conmutador «Como nota de voz» queda activo entre envíos hasta que el usuario lo apague. Los componentes de voz viven en `src/components/agents/ai-voice.tsx` para testearlos con `renderToStaticMarkup` y tocar `ai-playground.tsx` lo mínimo (n13.7 lo toca en paralelo).
4. **Test del playground** en archivo nuevo `route.voice.test.ts` en vez de ampliar `route.test.ts`, para no chocar con n13.7.
5. **Gemini vacío**: `transcribeGemini` devuelve `''` también ante bloqueo de seguridad (el orquestador lo marca `failed/empty`), en vez de lanzar como `generateGemini`.
6. **Origen nulo**: si `NEXT_PUBLIC_SUPABASE_URL` no está, `parseStorageObjectUrl` no compara origen; la descarga sigue yendo por el cliente de Storage del propio proyecto y con `assertStoragePathOwnedBy`, así que nunca se descarga un host ajeno.
7. **Prettier**: seis archivos no estaban en estilo prettier en `HEAD` (`usage.ts`, `context.ts`, `context.test.ts`, `query.ts`, `query.test.ts`, `message-media.tsx`: sin punto y coma o comillas dobles). Se editaron conservando su estilo para no producir un diff de archivo entero (riesgo de merge con n13.7). El resto de archivos tocados pasa `prettier --check`.
8. **D3**: el spec ya reflejaba la versión nueva; no quedan restos de la antigua (`voiceFailure` solo aparece como «se retira»). `buildHandoffSummary`/`handoff.ts` no se tocaron.

## Variables de entorno nuevas

`AI_VOICE_MAX_BYTES` (5242880), `AI_VOICE_MAX_SECONDS` (300), `AI_TRANSCRIBE_TIMEOUT_MS` (15000), `AI_TRANSCRIBE_OPENAI_MODEL` (`gpt-4o-mini-transcribe`), `AI_VOICE_FALLBACK_COOLDOWN_MINUTES` (10). Documentadas en `docs/docker.md` («Voice notes in the AI»). `.env.local.example` **no** se tocó (bloqueado por permisos): conviene añadirlas a mano.

## Conflictos previsibles con n13.7

Aditivos y acotados: `auto-reply.ts` (imports, campo `voiceNote`, bloque tras la reserva, `voiceNotes:` en `buildSystemPrompt`), `defaults.ts` (parámetro opcional + constante), playground route (un `.map` y `voiceNotes:`), `ai-playground.tsx` (estado + conmutador), `messages/*.json` (claves al final de `Settings.aiConfig.handoffMessagePlaceholder`, de `Inbox.bubble` y namespace `AiVoice` al final), `CHANGELOG.md` (entrada arriba de Unreleased), `verify-schema.sql` (bloque `-- 096` tras `-- /094`). No se toca `src/lib/ai/tools/*` ni `generate.ts`.

## Deuda detectada (fuera de alcance, no arreglada)

- Seis archivos del módulo IA/bandeja no cumplen `.prettierrc` en `main` (ver decisión 7); `npm run format` los reescribiría enteros.
- `AiUsageCard`/`/api/ai/usage` muestran `transcription` en «Other» (design §13, sin i18n en la tarjeta).
- En serverless el peor caso del turno (31 s de transcripción + generación) supera `maxDuration = 60`; aceptado en design §3 (despliegue soportado: Node/Dokploy).

## Verificaciones manuales pendientes (T10, design §11) — para el humano

Requieren despliegue con la migración 096 aplicada y WhatsApp real (Rehactive en Dokploy, auto-respuesta activa):

0. **R47** Ajustes → IA: el campo «Mensaje si no puedo escuchar un audio» muestra la semilla inglesa; cambiarlo a «No puedo escuchar notas de voz, ¿me lo escribes?», guardar y recargar → persiste. Guardar otra vez sin tocarlo → `select voice_fallback_message from ai_configs where account_id = …` conserva el texto.
1. **R39, R35** Desde un móvil, nota de voz de ~10 s («¿tienen cita el jueves por la tarde?»). Esperado: Aura responde al contenido; en la bandeja la transcripción aparece bajo el audio sin recargar; `select mode, provider, key_source from ai_usage_log where account_id = … order by created_at desc limit 2` → `auto_reply` y `transcription`.
2. Nota de voz de > 5 min → el cliente recibe el texto del paso 0; la fila queda `transcript_status = 'skipped'`; `select ai_autoreply_disabled, assigned_agent_id from conversations where id = …` sin cambios (`false`, sin agente). Otra nota larga antes de 10 min → no llega un segundo texto. Acto seguido un texto escrito → respuesta normal de Aura.
3. **R40** Cuenta de prueba con `provider = 'anthropic'` y sin `AI_PLATFORM_OPENAI_API_KEY` ni `AI_PLATFORM_GEMINI_API_KEY` → dos notas de voz seguidas: un solo texto de reserva, `transcript_status = 'skipped'` en ambas, IA activa; un texto escrito recibe respuesta.
4. Reconfirmar con un `audio/mpeg` reenviado que OpenAI y Gemini aceptan la lista MIME de design §4.3.

## Ronda 2 (hallazgos 1-3 de la revisión)

Commit `679b5ee` en `feat/ai-voice-notes` (worktree `.claude/worktrees/ai-voice-notes`).

| Hallazgo | Cambio | Test |
|---|---|---|
| 1 `withVoiceTurn` deduplicaba contra cualquier turno de voz | Compara solo con el último turno del contexto (`src/lib/ai/voice/config.ts`) | `config.test.ts` › `withVoiceTurn (R22)`: «appends…», «does not duplicate it when it already is the last turn», «an OLDER voice turn with the same text does not count: appends» |
| 2 slot del limitador consumido ante `send_failed` | Se sigue reclamando antes de enviar (cierra la carrera) y se devuelve con `releaseRateLimit` si `send` lanza; nuevo export en `src/lib/rate-limit.ts`, inyectable como `deps.release` | `fallback.test.ts` › «a failed send gives the slot back: the next voice note is answered», «releases the same key it claimed, only when the send fails»; `rate-limit.test.ts` › `releaseRateLimit` (2 casos) |
| 3 MIME de OpenAI sin extensión | Mapeados `audio/m4a`, `audio/wav`, `audio/webm`, `audio/flac` en `src/lib/media/filename.ts` (opción preferida; no rompe sus tests) | `filename.test.ts` › «maps the audio types the OpenAI transcriber accepts»; `resolve-transcriber.test.ts` › «every MIME OpenAI accepts uploads with a real extension, never .bin» |

Decisión: liberar en vez de consumir tras el éxito, porque consumir después reabriría la carrera de dos notas simultáneas que el limitador cierra (R29).

Compuerta dirigida: eslint de los archivos tocados 0 avisos, `npm run typecheck` verde, `TZ=UTC vitest run` sobre `src/lib/ai/voice`, `src/lib/ai/providers`, `src/lib/ai/auto-reply`, `filename.test.ts`, `rate-limit.test.ts`: 18 archivos, 243 tests verdes. Sin build (lo corre el líder en main). `filename.ts` y `rate-limit.test.ts` usan comillas dobles y no pasan por prettier sin reformatearse enteros: se editaron a mano respetando su estilo.
