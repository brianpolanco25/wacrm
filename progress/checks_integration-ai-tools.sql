-- n13.3 integration-ai-tools — comprobaciones contra el Postgres del harness
-- (KEEP=1 scripts/replay-migrations.sh <worktree>, luego:
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 < este archivo
--   y, para la idempotencia, volver a aplicar 094).
-- Todo dentro de una transacción que se deshace.
BEGIN;

DO $$
DECLARE
  owner uuid;
  acct uuid;
  integ uuid;
  row_id uuid;
  ok boolean;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (gen_random_uuid(), 'n133@example.com')
    RETURNING id INTO owner;
  -- El alta de usuario crea su cuenta (trigger de auth.users).
  SELECT id INTO acct FROM public.accounts WHERE owner_user_id = owner;
  IF acct IS NULL THEN
    INSERT INTO public.accounts (name, owner_user_id) VALUES ('n13.3 check', owner)
      RETURNING id INTO acct;
  END IF;
  INSERT INTO public.integrations (slug, name, base_url, auth_scheme, test_path)
    VALUES ('n133-check', 'Check', 'https://example.com', 'bearer', '/')
    RETURNING id INTO integ;

  -- R31: ai_enabled false por defecto en una fila nueva.
  INSERT INTO public.account_integrations (account_id, integration_id, is_enabled, credential)
    VALUES (acct, integ, true, 'enc') RETURNING id INTO row_id;
  IF (SELECT ai_enabled FROM public.account_integrations WHERE id = row_id) IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'ai_enabled should default to false';
  END IF;

  -- R31: 2000 caracteres caben; 2001 violan el CHECK.
  UPDATE public.account_integrations SET ai_instructions = repeat('x', 2000) WHERE id = row_id;
  ok := false;
  BEGIN
    UPDATE public.account_integrations SET ai_instructions = repeat('x', 2001) WHERE id = row_id;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'ai_instructions of 2001 chars must violate the CHECK'; END IF;

  -- R31: zona de 1..64; '' y 65 violan.
  UPDATE public.account_integrations SET ai_timezone = 'America/Santo_Domingo' WHERE id = row_id;
  ok := false;
  BEGIN
    UPDATE public.account_integrations SET ai_timezone = '' WHERE id = row_id;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'empty ai_timezone must violate the CHECK'; END IF;
  ok := false;
  BEGIN
    UPDATE public.account_integrations SET ai_timezone = repeat('z', 65) WHERE id = row_id;
  EXCEPTION WHEN check_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'ai_timezone of 65 chars must violate the CHECK'; END IF;

  -- ai_enabled NOT NULL.
  ok := false;
  BEGIN
    UPDATE public.account_integrations SET ai_enabled = NULL WHERE id = row_id;
  EXCEPTION WHEN not_null_violation THEN ok := true;
  END;
  IF NOT ok THEN RAISE EXCEPTION 'ai_enabled must be NOT NULL'; END IF;

  -- R30 (parte SQL): integration_calls admite source = 'ai' con el account_id.
  INSERT INTO public.integration_calls (account_id, integration_id, operation_key, source, outcome, status_code, latency_ms)
    VALUES (acct, integ, 'list_doctors', 'ai', 'ok', 200, 12);
  IF NOT EXISTS (SELECT 1 FROM public.integration_calls WHERE account_id = acct AND source = 'ai') THEN
    RAISE EXCEPTION 'integration_calls must accept source ai';
  END IF;

  -- RLS sigue activada y sin políticas.
  IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid = 'public.account_integrations'::regclass) THEN
    RAISE EXCEPTION 'RLS must stay enabled';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_policies WHERE tablename = 'account_integrations') THEN
    RAISE EXCEPTION 'account_integrations must have no policies';
  END IF;

  RAISE NOTICE 'n13.3 checks passed';
END
$$;

ROLLBACK;
