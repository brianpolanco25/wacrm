# n15.1 `ai-voice-notes` — tareas

Orden pensado para que cada paso deje la compuerta dirigida en verde
(`./init.sh feature n15.1 --test <ruta>...`). Tests vitest junto al código; nada de e2e ni
Playwright, nada de capturas. Revisado el 2026-11-11 por la D3 nueva (reintento + texto de
reserva, sin traspaso). Ningún test existente se reescribe: si `auto-reply.test.ts`,
`context.test.ts`, `defaults.test.ts`, `handoff.test.ts`, `config.test.ts`,
`handoff-message.test.ts` o `api/ai/config/route.test.ts` se rompen, el código está mal (única excepción: el fake de
`context.test.ts` gana los métodos `in` y `or` que la consulta nueva encadena, sin tocar sus
aserciones). Sin dependencias nuevas (CP5). Migración **096**: si al empezar ya existe otra 096,
parar y avisar.

- [ ] **T1 Migración 096** — `supabase/migrations/096_ai_voice_notes.sql` (design §2) y bloque
  `-- 096` en `supabase/ci/verify-schema.sql`. `scripts/replay-migrations.sh` aplicada dos veces
  sale 0. `progress/checks_ai-voice-notes.sql`: `transcript_status = 'x'` → falla; `transcript` en
  una fila `text` → falla; 4001 caracteres → falla; fila `audio` con `done` y texto → ok; filas
  previas con ambas columnas `NULL`; `ai_usage_log` acepta `mode = 'transcription'` y rechaza
  `'otro'`; una fila de `ai_configs` creada antes de la 096 y otra insertada después leen
  `voice_fallback_message` = la semilla. Cubre **R1, R2, R3, R43**.

- [ ] **T2 Puros de voz** — `src/lib/ai/voice/{types,config,ogg-duration,resolve-transcriber,dispatch-gate}.ts`.
  Cubre **R4, R5, R6 (lógica), R9, R10, R11, R15 (parte pura), R16 (lista)**. Tests:
  `config.test.ts` (defectos y env válidos/inválidos, incluido
  `AI_VOICE_FALLBACK_COOLDOWN_MINUTES` → 10 min por defecto; `cleanTranscript` colapsa, recorta y
  corta a 4000; `formatVoiceNote`); `ogg-duration.test.ts` (buffer Ogg sintético de 3 páginas con granule
  final 48000×12 → 12; granule `-1` → null; sin `OggS` → null; buffer de 10 bytes → null);
  `resolve-transcriber.test.ts` (openai propia/plataforma, gemini con `config.model`, anthropic →
  OpenAI de plataforma, → Gemini de plataforma con `AI_PROVIDER_DEFAULT_MODEL.gemini`, → null;
  `keySource` correcto en cada caso; `audio/amr` fuera de ambas listas);
  `dispatch-gate.test.ts` (texto → dispatch sin `voiceNote`; audio con id → con `voiceNote`;
  audio sin id, imagen sin texto → no; `flowConsumed` / `interactiveReplyId` → no).

- [ ] **T3 Adaptadores de transcripción** — `src/lib/ai/providers/transcribe-openai.ts`,
  `transcribe-gemini.ts` (exporta `GEMINI_BASE_URL` desde `gemini.ts`),
  `src/lib/ai/providers/transcribe-errors.ts`, `src/lib/ai/voice/transcribe.ts`.
  Cubre **R17, R18, R19 (clasificación)**. Tests con `fetch` simulado (`vi.stubGlobal`): URL, método, cabecera de
  autorización, `FormData` con `file`/`model`/`response_format=json` y nombre `voice.ogg`; cuerpo
  Gemini con `inlineData` base64 y la instrucción que prohíbe seguir el audio; `usage` normalizado
  (OpenAI tokens, Gemini `usageMetadata`, OpenAI sin `usage` → null); 401 → `invalid_key`, 429 →
  `rate_limited`, 500 → `provider_error` con `upstreamStatus` 500, `TimeoutError` → `timeout`;
  `fetch` llamado una sola vez por llamada al adaptador (el reintento no vive aquí).
  `transcribe-errors.test.ts`: `isTransientTranscribeError` → `true` para `network_error`,
  `timeout`, `rate_limited`, `TranscribeHttpError` 500/503; `false` para `invalid_key`,
  `TranscribeHttpError` 400/413/415, `Error` genérico.

- [ ] **T4 Origen del audio** — `src/lib/ai/voice/audio-source.ts`. Cubre **R12, R13, R14, R31
  (parte)**. Test `audio-source.test.ts` con storage y Meta inyectados: URL `chat-media` de la
  cuenta A → `download` con la ruta; ruta `account-<B>/…` → `forbidden_path`, `download` no
  llamado; ruta legada `<uuid>/…` → `forbidden_path`; `..`/`%2F` en el origen de Supabase →
  `forbidden_path`; `https://evil.example/a.ogg` → `forbidden_path`, ningún `fetch`; proxy
  `/api/whatsapp/media/123` → `getMediaUrl` + `downloadMedia` con id y token; `fileSize` > límite →
  `too_large` sin `downloadMedia`; descargado > límite → `too_large`; error de storage o de Meta →
  `download_failed`; el token no aparece en ningún `console.*` espiado.

- [ ] **T5 Orquestador** — `src/lib/ai/voice/ensure-transcript.ts`; `src/lib/ai/usage.ts`
  (`mode: 'transcription'`). Cubre **R8, R14, R15, R16, R19 (reintento), R20, R21, R22, R23,
  R30, R31, R32**. Test
  `ensure-transcript.test.ts` con fake de base que registra filtros: fila `done` → reusa sin
  `loadAudio` ni `transcribe`; `failed` → `previous_attempt` sin llamadas; sin transcriptor →
  `UPDATE` `skipped` y sin descarga; MIME `audio/amr` → `skipped/unsupported_format`; Ogg de
  400 s → `skipped/too_long` sin `transcribe`; éxito → `UPDATE` con `transcript` limpio, `done`,
  filtros `id` + `conversation_id` + `transcript_status IS NULL`, y `logAiUsage` con `mode
  'transcription'` y provider/model/keySource del transcriptor (cuenta anthropic →
  `openai`/`platform`); respuesta en blanco → `failed/empty`; **reintento**: `timeout` y luego
  éxito → `done`, `transcribe` llamado 2 veces y `sleep(1000)` 1 vez; 503 dos veces → `failed/
  provider_error` con exactamente 2 llamadas; 429 dos veces → `failed/rate_limited`, 2 llamadas;
  `invalid_key` → `failed/invalid_key` con 1 llamada y sin `sleep`; 400 → 1 llamada; `skipped/*`
  y `forbidden_path`/`download_failed` → 0 llamadas a `transcribe`;
  `UPDATE` con error → devuelve `done` igualmente; `loadAudio` lanza → `failed`, no propaga;
  **fuga**: mensaje de la cuenta B con el mismo `id` en otra conversación no se lee ni se escribe;
  ningún log contiene el texto transcrito.

- [ ] **T6 Contexto, consulta y prompt** — `src/lib/ai/types.ts` (`ChatMessage.voice`),
  `context.ts`, `query.ts`, `defaults.ts`. Cubre **R25, R26, R27**. (`handoff.ts` no se toca.)
  Tests: `context.test.ts` (casos nuevos: audio de cliente `done` → `user` con
  `[nota de voz] …` y `voice: true`; filtros `in`/`or` pedidos; los casos existentes intactos);
  `query.test.ts` (último `user` con `voice` → sin marca); `defaults.test.ts` (con `voiceNotes`
  aparece el párrafo y menciona la marca; sin él, salida igual a la de hoy para los mismos
  argumentos, comparada con un literal ya existente o con la llamada sin el parámetro).

- [ ] **T6b Texto de reserva configurable** — `supabase/migrations/096` ya lo trae (T1);
  `src/lib/ai/voice/fallback-message.ts`, `src/lib/ai/types.ts` (`AiConfig.voiceFallbackMessage?`),
  `src/lib/ai/config.ts`, `src/app/api/ai/config/route.ts`, `src/components/settings/ai-config.tsx`,
  claves `Settings.aiConfig.voiceFallbackMessage*` en `messages/{es,en}.json`. Cubre **R38
  (parte), R44, R45, R46, R47 (cableado)**. Tests: `fallback-message.test.ts` (patrón de
  `handoff-message.test.ts`: la constante coincide con el `DEFAULT` de la 096 extraído por regex,
  con `en.Settings.aiConfig.voiceFallbackMessagePlaceholder` = `e.g. ` + constante, y `es` tiene
  la clave); `config.test.ts` (casos nuevos: el `select` contiene `voice_fallback_message`; fila con
  texto → `voiceFallbackMessage`; `''` → `''`; `null` → `null`); `api/ai/config/route.test.ts`
  (casos nuevos: texto con espacios → guardado recortado; `''` → guardado `''`; 1001 caracteres →
  400; número → 400; ausente → ni insert ni update llevan la propiedad; `GET` la devuelve).

- [ ] **T7a Envío del texto de reserva** — `src/lib/ai/voice/fallback.ts` (`sendVoiceFallback`,
  design §4.9). Cubre **R29, R41, R42, R32 (lectura anti-bucle)**. Test `fallback.test.ts` con fake
  de base que registra filtros, `send`/`limiter`/`now` inyectados: texto `null` y `'   '` →
  `opted_out`, sin consulta ni `send`; sin fila previa → `sent`, `send` con `aiGenerated: true` y
  el texto recortado; fila `bot` con el mismo texto creada hace 9 min → `cooldown`, sin `send`;
  hace 11 min (filtro `gte('created_at', now − 10 min)`) → `sent`; dos llamadas seguidas con el
  limitador real y la base vacía → la segunda `cooldown` (un solo `send`); error de lectura →
  sigue y envía; `send` lanza → `send_failed`, no propaga, el log no contiene el texto; filtros
  `conversation_id` + `sender_type = 'bot'` + `content_text` presentes; fila con el texto en otra
  conversación → no provoca `cooldown`.

- [ ] **T7 Dispatch y webhook** — `src/lib/ai/auto-reply.ts` (`voiceNote`, transcripción tras la
  reserva, `sendVoiceFallback` si no hay transcripción, `voiceNotes` al prompt; el bloque de
  traspaso queda intacto) y la condición de `src/app/api/whatsapp/webhook/route.ts` con
  `aiReplyDispatchPlan`. Cubre **R4, R7, R8, R24, R27, R28, R30**. Test nuevo
  `auto-reply.voice.test.ts` (patrón de `auto-reply.tools.test.ts`, con `ensureVoiceTranscript` y
  `sendVoiceFallback` simulados): cada puerta de R7 (config off, `assertQuota` lanza, cerrada,
  asignada, `ai_autoreply_disabled`, cap, pausa de servicio, reserva perdida) →
  `ensureVoiceTranscript` no llamado; `done` → `generateReply` con el contexto y
  `buildSystemPrompt` con `voiceNotes: true`, `recordUsage('ai_replies', 1)` una sola vez;
  `skipped`/`failed` → `sendVoiceFallback` llamado una vez con `config.voiceFallbackMessage`,
  sin `generateReply`, **ningún** `update` sobre `conversations` (ni `ai_autoreply_disabled` ni
  `assigned_agent_id` ni `ai_handoff_summary`), sin `claim_ai_reply_slot`, sin `recordUsage`;
  `sendVoiceFallback` o `ensureVoiceTranscript` lanzan → la función resuelve sin lanzar; sin
  `voiceNote` (texto) → ni `ensureVoiceTranscript` ni `sendVoiceFallback`. `auto-reply.test.ts`
  existente en verde sin cambios.

- [ ] **T8 Borrador y playground** — `src/app/api/ai/draft/route.ts` (`voiceNotes`),
  `src/app/api/ai/playground/route.ts`, `src/components/agents/ai-playground.tsx`. Cubre **R26
  (borrador), R36, R37**. Tests: `playground/route.test.ts` (nuevo o ampliado: turno `user` con
  `voice: true` llega a `generateReply` como `[nota de voz] …` y `buildSystemPrompt` con
  `voiceNotes: true`; `voice` en `assistant` o `"yes"` ignorado; ningún `logAiUsage` con
  `transcription`); `ai-playground-voice.test.tsx` con `renderToStaticMarkup` (botón con
  `aria-pressed` y `AiVoice.sendAsVoice` en es/en; turno con `voice` pinta
  `AiVoice.simulatedVoiceNote`) y una prueba de la función pura que construye el cuerpo
  (`voice: true` solo en el turno marcado; extraerla del componente si hace falta).

- [ ] **T9 Bandeja e i18n** — `src/types/index.ts`, `src/components/inbox/voice-transcript.tsx`,
  `src/components/inbox/message-media.tsx`, `messages/{es,en}.json`. Cubre **R33, R34, R38**
  (todas las claves nuevas, incluidas las de T6b).
  Test `voice-transcript.test.tsx` (patrón de `ai-tools-used.test.tsx`, es/en): `done` → etiqueta
  y texto; texto con `<script>` sale escapado; `failed` y `skipped` → `transcriptUnavailable`;
  `null` → markup vacío. `src/i18n/messages.test.ts` e `icu-safety.test.ts` en verde.

- [ ] **T10 Guion manual** — ejecutar design §11 con el humano (requiere WhatsApp real y
  despliegue); anotar resultado en `progress/impl_ai-voice-notes.md`. Cubre **R35, R39, R40,
  R47**. Si
  no se puede ejecutar antes del review, queda marcado como pendiente del humano, no como hecho.

- [ ] **T11 Compuerta en verde + CHANGELOG** — `./init.sh feature n15.1` con los tests de T2–T9
  (incluidos T6b y T7a); `CHANGELOG.md` (Unreleased: «La IA responde a notas de voz:
  transcripción con OpenAI o Gemini, visible en la bandeja; si no puede transcribir, pide al
  cliente que escriba con un texto configurable en Ajustes → IA»); variables nuevas en
  `docs/docker.md` (design §5, incluida `AI_VOICE_FALLBACK_COOLDOWN_MINUTES`); informe
  `progress/impl_ai-voice-notes.md` con la tabla R→test. Cubre **CP1, CP9**.
