-- Comprobaciones de f1.2 (mensaje de transición) contra base real.
-- Ejecutar contra el Postgres local que deja scripts/replay-migrations.sh
-- con KEEP=1:
--   docker exec -i <contenedor> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_handoff-message.sql
-- Todo dentro de una transacción que termina en ROLLBACK: no deja datos.
--
-- Lo que se comprueba (hallazgo 1 y 4 de progress/review_handoff-message.md):
--   1. El DEFAULT de ai_configs.handoff_message es el texto en inglés y no
--      queda rastro del español.
--   2. Un alta nueva que no manda la columna hereda ese default (es lo que
--      hace la ruta cuando el formulario no tocó el campo).
--   3. La cadena vacía es un opt-out que se guarda tal cual.
--   4. Re-ejecutar el ALTER de 043 (idempotencia) no pisa ni el opt-out ni
--      el texto que la cuenta escribió.
--   5. Reproducción del backfill: en PostgreSQL 11+ un ADD COLUMN … DEFAULT
--      rellena también las filas ya existentes. Es la consecuencia asumida
--      en la cabecera de 043 y anotada en CHANGELOG, y se comprueba aquí
--      para que no dependa de la memoria de nadie.

BEGIN;

DO $$
DECLARE
  seeded constant text :=
    'Thanks for writing to us. A member of our team will continue this conversation shortly.';
  u uuid := '30000000-0000-0000-0000-000000000001';
  acct uuid;
  def text;
  msg text;
  mode text;
BEGIN
  -- 1. El DEFAULT vigente.
  SELECT column_default INTO def
    FROM information_schema.columns
   WHERE table_schema = 'public'
     AND table_name   = 'ai_configs'
     AND column_name  = 'handoff_message';
  IF def IS NULL THEN
    RAISE EXCEPTION 'ai_configs.handoff_message no tiene DEFAULT: §2 pide texto sembrado';
  END IF;
  IF position(seeded in def) = 0 THEN
    RAISE EXCEPTION 'DEFAULT inesperado: %', def;
  END IF;
  IF def LIKE '%Gracias por escribirnos%' THEN
    RAISE EXCEPTION 'el DEFAULT sigue en español: %', def;
  END IF;

  -- 2. Alta nueva sin la columna → hereda el default.
  INSERT INTO auth.users (id, aud, role, email, encrypted_password)
  VALUES (u, 'authenticated', 'authenticated', 'handoff@example.test', 'not-used');
  -- El trigger de alta crea cuenta y perfil personal.
  SELECT account_id INTO acct FROM profiles WHERE user_id = u;

  INSERT INTO ai_configs (account_id, created_by, provider, model, api_key)
  VALUES (acct, u, 'openai', 'gpt-x', 'enc:dummy');

  SELECT handoff_message, handoff_mode INTO msg, mode
    FROM ai_configs WHERE account_id = acct;
  IF msg IS DISTINCT FROM seeded THEN
    RAISE EXCEPTION 'alta nueva sin la columna: esperaba el default, obtuve %', quote_nullable(msg);
  END IF;
  IF mode IS DISTINCT FROM 'queue' THEN
    RAISE EXCEPTION 'handoff_mode por defecto debía ser queue, es %', quote_nullable(mode);
  END IF;

  -- 3. Cadena vacía = opt-out explícito (no se convierte en NULL ni vuelve
  --    al default).
  UPDATE ai_configs SET handoff_message = '' WHERE account_id = acct;
  SELECT handoff_message INTO msg FROM ai_configs WHERE account_id = acct;
  IF msg IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 'el opt-out no se guardó como cadena vacía: %', quote_nullable(msg);
  END IF;
END $$;

-- 4. Idempotencia: el ALTER de 043, tal cual, re-ejecutado sobre una base
--    que ya lo tiene. No debe tocar el opt-out de la cuenta anterior.
ALTER TABLE public.ai_configs
  ADD COLUMN IF NOT EXISTS handoff_message text
    DEFAULT 'Thanks for writing to us. A member of our team will continue this conversation shortly.';

DO $$
DECLARE
  msg text;
BEGIN
  SELECT handoff_message INTO msg
    FROM ai_configs
   WHERE created_by = '30000000-0000-0000-0000-000000000001';
  IF msg IS DISTINCT FROM '' THEN
    RAISE EXCEPTION 're-ejecutar 043 pisó el opt-out de la cuenta: %', quote_nullable(msg);
  END IF;
END $$;

-- 5. El backfill a filas existentes, reproducido sobre una tabla temporal
--    con la misma sentencia (mismo motor, misma semántica).
DO $$
DECLARE
  seeded constant text :=
    'Thanks for writing to us. A member of our team will continue this conversation shortly.';
  msg text;
BEGIN
  CREATE TEMP TABLE backfill_probe (id int) ON COMMIT DROP;
  INSERT INTO backfill_probe (id) VALUES (1); -- fila anterior a la migración
  ALTER TABLE backfill_probe
    ADD COLUMN IF NOT EXISTS handoff_message text
      DEFAULT 'Thanks for writing to us. A member of our team will continue this conversation shortly.';
  SELECT handoff_message INTO msg FROM backfill_probe WHERE id = 1;
  IF msg IS DISTINCT FROM seeded THEN
    RAISE EXCEPTION 'esperaba el backfill del DEFAULT en la fila previa, obtuve %',
      quote_nullable(msg);
  END IF;
  RAISE NOTICE 'confirmado: ADD COLUMN … DEFAULT rellena las filas existentes (PG11+)';
END $$;

DO $$ BEGIN RAISE NOTICE 'checks_handoff-message.sql: OK'; END $$;

ROLLBACK;
