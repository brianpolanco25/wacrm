-- n15.1 ai-voice-notes — comprobaciones de la migración 096 contra el
-- Postgres del harness. Uso:
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 < este_archivo
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 < supabase/migrations/096_ai_voice_notes.sql  (segunda aplicación)
-- Todo corre en una transacción y termina en ROLLBACK.
BEGIN;

-- Simula «antes de la 096»: quita lo que la 096 añade, siembra filas y
-- vuelve a aplicar la 096 tal cual (R3, R43).
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_status_check;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_audio_only;
ALTER TABLE public.messages DROP CONSTRAINT IF EXISTS messages_transcript_len;
ALTER TABLE public.messages DROP COLUMN IF EXISTS transcript;
ALTER TABLE public.messages DROP COLUMN IF EXISTS transcript_status;
ALTER TABLE public.ai_configs DROP COLUMN IF EXISTS voice_fallback_message;

INSERT INTO auth.users (id, email) VALUES
  ('11111111-1111-1111-1111-111111111111', 'voice-a@example.test'),
  ('22222222-2222-2222-2222-222222222222', 'voice-b@example.test');
-- El trigger de auth.users crea la cuenta personal de cada usuario; se
-- usan esas (A = la del usuario 1111…, B = la del 2222…).
CREATE TEMP TABLE acc AS
  SELECT (SELECT id FROM public.accounts WHERE owner_user_id = '11111111-1111-1111-1111-111111111111') AS a,
         (SELECT id FROM public.accounts WHERE owner_user_id = '22222222-2222-2222-2222-222222222222') AS b;
INSERT INTO public.contacts (id, user_id, account_id, phone) VALUES
  ('cccccccc-cccc-cccc-cccc-cccccccccccc', '11111111-1111-1111-1111-111111111111',
   (SELECT a FROM acc), '+18095550001');
INSERT INTO public.conversations (id, user_id, contact_id, account_id) VALUES
  ('dddddddd-dddd-dddd-dddd-dddddddddddd', '11111111-1111-1111-1111-111111111111',
   'cccccccc-cccc-cccc-cccc-cccccccccccc', (SELECT a FROM acc));
INSERT INTO public.messages (id, conversation_id, sender_type, content_type, content_text, media_url, media_type) VALUES
  ('e0000000-0000-0000-0000-000000000001', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'customer', 'text', 'hola', NULL, NULL),
  ('e0000000-0000-0000-0000-000000000002', 'dddddddd-dddd-dddd-dddd-dddddddddddd', 'customer', 'audio', NULL,
   'https://x.supabase.co/storage/v1/object/public/chat-media/account-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa/inbound/1-audio-1.ogg',
   'audio/ogg; codecs=opus');
INSERT INTO public.ai_configs (account_id, provider, model) VALUES
  ((SELECT a FROM acc), 'openai', 'gpt-5.4-mini');

CREATE TEMP TABLE pre_096 AS
  SELECT id, conversation_id, sender_type, content_type, content_text, media_url, media_type, created_at
  FROM public.messages WHERE id::text LIKE 'e0000000-%';

\i /tmp/096_ai_voice_notes.sql

DO $$
DECLARE
  seed constant text := 'Sorry, I can''t listen to voice notes. Could you type your message, please?';
BEGIN
  -- R3: filas previas con ambas columnas NULL y el resto intacto.
  IF EXISTS (SELECT 1 FROM public.messages
             WHERE id::text LIKE 'e0000000-%'
               AND (transcript IS NOT NULL OR transcript_status IS NOT NULL)) THEN
    RAISE EXCEPTION 'R3: existing rows got a transcript';
  END IF;
  IF EXISTS (
    (SELECT id, conversation_id, sender_type, content_type, content_text, media_url, media_type, created_at
       FROM public.messages WHERE id::text LIKE 'e0000000-%')
    EXCEPT
    (SELECT * FROM pre_096)
  ) THEN
    RAISE EXCEPTION 'R3: existing rows were rewritten';
  END IF;

  -- R43: fila previa y fila nueva leen la semilla.
  IF (SELECT voice_fallback_message FROM public.ai_configs
      WHERE account_id = (SELECT a FROM acc)) IS DISTINCT FROM seed THEN
    RAISE EXCEPTION 'R43: pre-096 ai_configs row does not read the seed';
  END IF;
  INSERT INTO public.ai_configs (account_id, provider, model)
    SELECT (SELECT b FROM acc), 'gemini', 'gemini-3.5-flash-lite';
  IF (SELECT voice_fallback_message FROM public.ai_configs
      WHERE account_id = (SELECT b FROM acc)) IS DISTINCT FROM seed THEN
    RAISE EXCEPTION 'R43: post-096 ai_configs row does not read the seed';
  END IF;

  -- R1: audio con done y texto → ok.
  UPDATE public.messages SET transcript = 'tienen cita el jueves', transcript_status = 'done'
    WHERE id = 'e0000000-0000-0000-0000-000000000002';

  -- R1: estado fuera del dominio → falla.
  BEGIN
    UPDATE public.messages SET transcript_status = 'x'
      WHERE id = 'e0000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'R1: transcript_status = x was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- R1: transcript en una fila de texto → falla.
  BEGIN
    UPDATE public.messages SET transcript = 'nope'
      WHERE id = 'e0000000-0000-0000-0000-000000000001';
    RAISE EXCEPTION 'R1: transcript on a text row was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- R1: 4001 caracteres → falla; 4000 → ok.
  BEGIN
    UPDATE public.messages SET transcript = repeat('a', 4001)
      WHERE id = 'e0000000-0000-0000-0000-000000000002';
    RAISE EXCEPTION 'R1: 4001-char transcript was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  UPDATE public.messages SET transcript = repeat('a', 4000)
    WHERE id = 'e0000000-0000-0000-0000-000000000002';

  -- R2: ai_usage_log acepta 'transcription' y rechaza 'otro'.
  INSERT INTO public.ai_usage_log (account_id, mode, provider, model, key_source)
    SELECT (SELECT a FROM acc), 'transcription', 'openai',
           'gpt-4o-mini-transcribe', 'platform';
  BEGIN
    INSERT INTO public.ai_usage_log (account_id, mode, provider, model)
      SELECT (SELECT a FROM acc), 'otro', 'openai', 'x';
    RAISE EXCEPTION 'R2: mode otro was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'checks_ai-voice-notes: all passed';
END
$$;

ROLLBACK;
