-- Behavioural acceptance checks for p8.3 gemini-provider (migration 066).
--
-- What migration 066 has to be true for, against a real Postgres:
--   A. `ai_configs.provider` accepts 'gemini' (an account can save Gemini).
--   B. `ai_usage_log.provider` accepts 'gemini' (its spend can be logged).
--   C. Both domains stay closed: an invented provider is still rejected.
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   C=<container>
--   docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_gemini-provider.sql
--
-- Everything runs inside a transaction that is rolled back, so the run
-- leaves no rows behind and can be repeated. Every assertion RAISEs on
-- failure: a silent run is a passing run.

BEGIN;

DO $$
DECLARE
  v_user     uuid := '00000000-0000-0000-0000-000000000866';
  v_account  uuid;
  v_rejected boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user, 'authenticated', 'authenticated', 'gemini-provider@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_user;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'setup: the auth trigger did not create a personal account';
  END IF;

  -- A. ai_configs accepts 'gemini' (with and without a BYO key).
  INSERT INTO ai_configs (account_id, created_by, provider, model, api_key, is_active)
  VALUES (v_account, v_user, 'gemini', 'gemini-3.5-flash-lite', NULL, true);
  IF (SELECT provider FROM ai_configs WHERE account_id = v_account) <> 'gemini' THEN
    RAISE EXCEPTION 'A: ai_configs did not store provider = gemini';
  END IF;
  DELETE FROM ai_configs WHERE account_id = v_account;

  -- B. ai_usage_log accepts 'gemini'.
  INSERT INTO ai_usage_log (account_id, mode, provider, model, prompt_tokens,
                            completion_tokens, total_tokens, key_source)
  VALUES (v_account, 'draft', 'gemini', 'gemini-3.5-flash-lite', 10, 5, 15, 'platform');
  IF NOT EXISTS (
    SELECT 1 FROM ai_usage_log WHERE account_id = v_account AND provider = 'gemini'
  ) THEN
    RAISE EXCEPTION 'B: ai_usage_log did not store provider = gemini';
  END IF;
  DELETE FROM ai_usage_log WHERE account_id = v_account;

  -- C. The domain is still closed on both tables.
  v_rejected := false;
  BEGIN
    INSERT INTO ai_configs (account_id, created_by, provider, model, api_key, is_active)
    VALUES (v_account, v_user, 'mistral', 'x', NULL, true);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'C: ai_configs accepted an invented provider';
  END IF;

  v_rejected := false;
  BEGIN
    INSERT INTO ai_usage_log (account_id, mode, provider, model, key_source)
    VALUES (v_account, 'draft', 'mistral', 'x', 'account');
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'C: ai_usage_log accepted an invented provider';
  END IF;

  RAISE NOTICE 'checks_gemini-provider: all assertions passed';
END
$$;

ROLLBACK;
