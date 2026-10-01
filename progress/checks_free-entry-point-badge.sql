-- Verificación de p11.6 (free-entry-point-badge) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 082, columnas de punto de entrada
-- en conversations).
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/pmd-entry-point
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/migrations/082_conversation_entry_point.sql   # R1: 2.ª vez
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_free-entry-point-badge.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_free-entry-point-badge: OK` o con la primera EXCEPTION.
--
--   R4  los dos CHECK existen con convalidated = false.
--   R2  entry_point_source = 'foo' -> 23514; ctwa_ad/organic/other y NULL pasan.
--   R3  ventana sin entry_point_at -> 23514; 72 h + 1 s -> 23514; 72 h exactas pasa.
--   R11 el UPDATE con el filtro optimista (.eq sobre el entry_point_at leído)
--       no escribe si el valor guardado cambió; el de .is(null) solo escribe
--       si sigue NULL.
--   R16 el mismo UPDATE con account_id de B no toca la conversación de A
--       aunque el id sea el de A (filtro id + account_id).

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10820000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a-082@example.test', '{}', '{"full_name":"Owner A"}', now(), now()),
  ('10820000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b-082@example.test', '{}', '{"full_name":"Owner B"}', now(), now());

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '10820000-0000-4000-8000-000000000001') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '10820000-0000-4000-8000-000000000002') AS b_acc;

-- Mismo teléfono en A y en B (R16).
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '10820000-0000-4000-8000-0000000000c1'::uuid,
       '10820000-0000-4000-8000-000000000001'::uuid, a_acc, '+18095550182', 'Cliente A'
FROM ids;
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '10820000-0000-4000-8000-0000000000c2'::uuid,
       '10820000-0000-4000-8000-000000000002'::uuid, b_acc, '+18095550182', 'Cliente B'
FROM ids;
INSERT INTO public.conversations (id, user_id, account_id, contact_id)
SELECT '10820000-0000-4000-8000-0000000000d1'::uuid,
       '10820000-0000-4000-8000-000000000001'::uuid, a_acc,
       '10820000-0000-4000-8000-0000000000c1'::uuid
FROM ids;
INSERT INTO public.conversations (id, user_id, account_id, contact_id)
SELECT '10820000-0000-4000-8000-0000000000d2'::uuid,
       '10820000-0000-4000-8000-000000000002'::uuid, b_acc,
       '10820000-0000-4000-8000-0000000000c2'::uuid
FROM ids;

DO $$
DECLARE
  v_a   uuid := '10820000-0000-4000-8000-0000000000d1';
  v_b   uuid := '10820000-0000-4000-8000-0000000000d2';
  v_aacc uuid;
  v_bacc uuid;
  n int;
BEGIN
  SELECT a_acc, b_acc INTO v_aacc, v_bacc FROM ids;
  IF v_aacc IS NULL OR v_bacc IS NULL OR v_aacc = v_bacc THEN
    RAISE EXCEPTION 'fixture: accounts A/B not created';
  END IF;

  -- R4
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.conversations'::regclass
        AND conname IN ('conversations_entry_point_source_check',
                        'conversations_free_window_check')
        AND contype = 'c' AND convalidated = false) <> 2 THEN
    RAISE EXCEPTION 'R4: both CHECKs must exist with convalidated = false';
  END IF;

  -- R2: valor desconocido
  BEGIN
    UPDATE conversations SET entry_point_source = 'foo' WHERE id = v_a;
    RAISE EXCEPTION 'R2: entry_point_source = foo was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- R2: los válidos y NULL pasan
  UPDATE conversations SET entry_point_source = 'ctwa_ad' WHERE id = v_a;
  UPDATE conversations SET entry_point_source = 'ctwa_organic' WHERE id = v_a;
  UPDATE conversations SET entry_point_source = 'ctwa_other' WHERE id = v_a;
  UPDATE conversations SET entry_point_source = NULL WHERE id = v_a;

  -- R3 caso 1: ventana sin entrada
  BEGIN
    UPDATE conversations SET entry_point_at = NULL, free_window_until = now() WHERE id = v_a;
    RAISE EXCEPTION 'R3: free_window_until without entry_point_at was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- R3 caso 2: 72 h + 1 s
  BEGIN
    UPDATE conversations
       SET entry_point_at = TIMESTAMPTZ '2026-10-01 00:00:00+00',
           free_window_until = TIMESTAMPTZ '2026-10-04 00:00:01+00'
     WHERE id = v_a;
    RAISE EXCEPTION 'R3: 72 h + 1 s was accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  -- R11: primera escritura con el filtro .is(entry_point_at, null)
  UPDATE conversations
     SET entry_point_source = 'ctwa_ad',
         entry_point_at = TIMESTAMPTZ '2026-10-01 00:00:00+00',
         free_window_until = TIMESTAMPTZ '2026-10-04 00:00:00+00',  -- R3 caso 3: 72 h exactas
         entry_point_referral = '{"source_type":"ad","source_id":"123"}'::jsonb
   WHERE id = v_a AND account_id = v_aacc AND entry_point_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'R3/R11: exact 72 h first write did not apply'; END IF;

  -- R11: segunda escritura con .is(null) ya no coincide
  UPDATE conversations SET entry_point_source = 'ctwa_other'
   WHERE id = v_a AND account_id = v_aacc AND entry_point_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'R11: .is(null) filter matched a filled row'; END IF;

  -- R11: .eq con un valor leído que ya no es el guardado no escribe
  UPDATE conversations SET entry_point_source = 'ctwa_other'
   WHERE id = v_a AND account_id = v_aacc
     AND entry_point_at = TIMESTAMPTZ '2026-09-01 00:00:00+00';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'R11: optimistic .eq matched a stale value'; END IF;

  -- R11: .eq con el valor vigente sí escribe (entrante más nuevo)
  UPDATE conversations
     SET entry_point_at = TIMESTAMPTZ '2026-10-02 00:00:00+00',
         free_window_until = TIMESTAMPTZ '2026-10-05 00:00:00+00'
   WHERE id = v_a AND account_id = v_aacc
     AND entry_point_at = TIMESTAMPTZ '2026-10-01 00:00:00+00';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'R11: optimistic .eq with current value did not apply'; END IF;

  -- R16: id de A con account_id de B no toca nada
  UPDATE conversations SET entry_point_source = 'ctwa_other'
   WHERE id = v_a AND account_id = v_bacc AND entry_point_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'R16: cross-account update matched'; END IF;
  UPDATE conversations SET entry_point_source = 'ctwa_other'
   WHERE id = v_a AND account_id = v_bacc;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'R16: cross-account update matched (no optimistic filter)'; END IF;

  IF (SELECT entry_point_source FROM conversations WHERE id = v_a) IS DISTINCT FROM 'ctwa_ad'
     OR (SELECT free_window_until FROM conversations WHERE id = v_a)
        IS DISTINCT FROM TIMESTAMPTZ '2026-10-05 00:00:00+00' THEN
    RAISE EXCEPTION 'final state of A is wrong';
  END IF;
  IF (SELECT entry_point_source IS NOT NULL OR entry_point_at IS NOT NULL
             OR free_window_until IS NOT NULL OR entry_point_referral IS NOT NULL
      FROM conversations WHERE id = v_b) THEN
    RAISE EXCEPTION 'R16: B was modified';
  END IF;

  RAISE NOTICE 'checks_free-entry-point-badge: OK';
END
$$;

ROLLBACK;
