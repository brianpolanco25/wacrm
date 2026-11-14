-- n13.7 ai-grounded-availability — comprobaciones contra el Postgres del harness.
-- Uso: KEEP=1 scripts/replay-migrations.sh <worktree>  y luego
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < este archivo
-- Todo dentro de una transacción que acaba en ROLLBACK. Cada caso imprime NOTICE 'ok …'
-- o lanza EXCEPTION (sale con error).
BEGIN;

DO $$
DECLARE
  v_user uuid := gen_random_uuid();
  v_acct uuid;
  v_contact uuid;
  v_conv uuid;
  v_integ uuid;
  v_ai uuid;
  v_call uuid;
  v_val jsonb;
  v_bool boolean;
  v_count int;
BEGIN
  INSERT INTO auth.users (id, email, aud, role)
    VALUES (v_user, 'n137-' || v_user || '@example.com', 'authenticated', 'authenticated');
  SELECT id INTO v_acct FROM public.accounts WHERE owner_user_id = v_user;
  IF v_acct IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('n137', v_user) RETURNING id INTO v_acct;
  END IF;
  INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES (v_user, v_acct, '18095550000', 'Paciente') RETURNING id INTO v_contact;
  INSERT INTO public.conversations (user_id, account_id, contact_id)
    VALUES (v_user, v_acct, v_contact) RETURNING id INTO v_conv;
  INSERT INTO public.integrations (slug, name, base_url, auth_scheme, test_path)
    VALUES ('n137-health', 'Health', 'https://health.example.com', 'bearer', '/me')
    RETURNING id INTO v_integ;

  -- R1: default '[]'
  INSERT INTO public.account_integrations (account_id, integration_id, is_enabled)
    VALUES (v_acct, v_integ, false) RETURNING id, ai_live_reads INTO v_ai, v_val;
  IF v_val <> '[]'::jsonb THEN RAISE EXCEPTION 'R1 default is %', v_val; END IF;
  RAISE NOTICE 'ok R1 default []';

  -- R1: objeto → rechazado
  BEGIN
    UPDATE public.account_integrations SET ai_live_reads = '{"operation":"x"}' WHERE id = v_ai;
    RAISE EXCEPTION 'R1 object accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok R1 object rejected';
  END;
  -- R1: array de 4 → rechazado
  BEGIN
    UPDATE public.account_integrations SET ai_live_reads = '[{},{},{},{}]' WHERE id = v_ai;
    RAISE EXCEPTION 'R1 array of 4 accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok R1 array of 4 rejected';
  END;
  -- R1: array de 3 → aceptado
  UPDATE public.account_integrations
    SET ai_live_reads = '[{"operation":"find_availability","params":{"from":"{{today}}"}},{},{}]'
    WHERE id = v_ai;
  RAISE NOTICE 'ok R1 array of 3 accepted';

  -- R22: ai_policy string → rechazado; objeto y NULL → aceptados
  BEGIN
    INSERT INTO public.integration_operations (integration_id, key, name, description, method, path, ai_policy)
      VALUES (v_integ, 'bad', 'Bad', 'd', 'GET', '/x', '"schedule"');
    RAISE EXCEPTION 'R22 string accepted';
  EXCEPTION WHEN check_violation THEN RAISE NOTICE 'ok R22 string rejected';
  END;
  INSERT INTO public.integration_operations (integration_id, key, name, description, method, path, ai_policy)
    VALUES (v_integ, 'cancel_appointment', 'Cancel', 'd', 'POST', '/x',
            '{"requires_prior":[["list_appointments","get_appointment"],["find_availability"]]}');
  INSERT INTO public.integration_operations (integration_id, key, name, description, method, path)
    VALUES (v_integ, 'find_availability', 'Find', 'd', 'GET', '/a');
  SELECT ai_policy IS NULL INTO v_bool FROM public.integration_operations
    WHERE integration_id = v_integ AND key = 'find_availability';
  IF NOT v_bool THEN RAISE EXCEPTION 'R22 default not null'; END IF;
  RAISE NOTICE 'ok R22 object and NULL accepted';

  -- R27: ai_preload default false; conversation_id ON DELETE SET NULL
  INSERT INTO public.integration_calls (account_id, integration_id, operation_key, source, outcome, latency_ms, conversation_id)
    VALUES (v_acct, v_integ, 'find_availability', 'ai', 'ok', 5, v_conv)
    RETURNING id, ai_preload INTO v_call, v_bool;
  IF v_bool THEN RAISE EXCEPTION 'R27 ai_preload default true'; END IF;
  RAISE NOTICE 'ok R27 ai_preload default false';
  DELETE FROM public.conversations WHERE id = v_conv;
  SELECT count(*) INTO v_count FROM public.integration_calls WHERE id = v_call AND conversation_id IS NULL;
  IF v_count <> 1 THEN RAISE EXCEPTION 'R27 call row lost or conversation_id kept'; END IF;
  RAISE NOTICE 'ok R27 delete conversation keeps call with conversation_id NULL';
END
$$;

ROLLBACK;
