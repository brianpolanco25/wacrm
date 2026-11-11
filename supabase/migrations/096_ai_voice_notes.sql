-- ============================================================
-- 096_ai_voice_notes.sql — n15.1: la IA responde a notas de voz.
--
-- 1. `messages.transcript` / `messages.transcript_status` — la
--    transcripción de una nota de voz entrante, escrita por el rol de
--    servicio dentro del turno de la IA (después de ganar la reserva de
--    `inbound_auto_replies`, 051). Una por mensaje: el UPDATE filtra por
--    `transcript_status IS NULL`. Columnas nulas sin DEFAULT: el ADD
--    COLUMN no reescribe la tabla y las filas existentes quedan en NULL.
--    Heredan las políticas RLS de `messages` y ya viajan por realtime.
--
-- 2. `ai_usage_log_mode_check` admite 'transcription': el coste de
--    transcribir se registra con su propio modo (mismo patrón
--    drop-then-add que la 047, reaplicar es inocuo).
--
-- 3. `ai_configs.voice_fallback_message` — texto que el bot envía
--    cuando no puede transcribir una nota de voz, pidiendo al cliente
--    que escriba. Mismo patrón que `handoff_message` (043): semilla en
--    inglés, editable en Ajustes → IA, '' = no enviar. La IA sigue
--    activa (sin traspaso). El literal está fijado por
--    src/lib/ai/voice/fallback-message.test.ts.
-- ============================================================

ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS transcript text;
ALTER TABLE public.messages ADD COLUMN IF NOT EXISTS transcript_status text;

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_status_check;
ALTER TABLE public.messages ADD CONSTRAINT messages_transcript_status_check
  CHECK (transcript_status IS NULL OR transcript_status IN ('done', 'failed', 'skipped'));

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_audio_only;
ALTER TABLE public.messages ADD CONSTRAINT messages_transcript_audio_only
  CHECK (transcript IS NULL OR content_type = 'audio');

ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_len;
ALTER TABLE public.messages ADD CONSTRAINT messages_transcript_len
  CHECK (transcript IS NULL OR char_length(transcript) <= 4000);

DO $$
BEGIN
  IF to_regclass('public.ai_usage_log') IS NOT NULL THEN
    ALTER TABLE public.ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_mode_check;
    ALTER TABLE public.ai_usage_log ADD CONSTRAINT ai_usage_log_mode_check
      CHECK (mode IN ('auto_reply', 'draft', 'playground', 'transcription'));
  END IF;
END
$$;

ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS voice_fallback_message text
    DEFAULT 'Sorry, I can''t listen to voice notes. Could you type your message, please?';
