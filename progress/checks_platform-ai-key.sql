-- Behavioural acceptance checks for f0.4 platform-ai-key (fase 0, §4 — S1).
--
-- What migration 047 has to be true for, against a real Postgres:
--   A. `ai_configs.api_key` accepts NULL (an account with no key of its
--      own, backed by the platform key).
--   B. `ai_usage_log.key_source` tells platform-funded spend apart from
--      BYO spend, per account, and its domain is closed.
--   C. `ai_usage_log.mode` accepts 'playground' — the third LLM faucet
--      (the test chat) now logs its spend too — without opening the
--      domain to anything else.
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   C=<container>
--   docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_platform-ai-key.sql
--
-- Everything runs inside a transaction that is rolled back, so the run
-- leaves no rows behind and can be repeated. Every assertion RAISEs on
-- failure: a silent run is a passing run.

BEGIN;

DO $$
DECLARE
  v_user_a     uuid := '00000000-0000-0000-0000-000000000f41';
  v_user_b     uuid := '00000000-0000-0000-0000-000000000f42';
  v_account_a  uuid;
  v_account_b  uuid;
  v_platform   bigint;
  v_account    bigint;
  v_scoped     bigint;
  v_legacy     text;
  v_rejected   boolean := false;
BEGIN
  -- Two unrelated tenants. The auth trigger gives each a personal
  -- account + owner profile.
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user_a, 'authenticated', 'authenticated', 'ai-platform-a@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_user_b, 'authenticated', 'authenticated', 'ai-platform-b@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_user_b;

  -- ==========================================================
  -- A. An account may have no key of its own (api_key NULL).
  --    Before 047 the column was NOT NULL and this insert failed.
  -- ==========================================================
  INSERT INTO ai_configs (account_id, created_by, provider, model, api_key, is_active)
  VALUES (v_account_a, v_user_a, 'openai', 'gpt-x', NULL, true);

  IF (SELECT api_key FROM ai_configs WHERE account_id = v_account_a) IS NOT NULL THEN
    RAISE EXCEPTION 'A: ai_configs.api_key did not stay NULL';
  END IF;

  -- The BYO account keeps storing its (encrypted) key: 047 makes the
  -- column optional, not unusable.
  INSERT INTO ai_configs (account_id, created_by, provider, model, api_key, is_active)
  VALUES (v_account_b, v_user_b, 'openai', 'gpt-x', 'enc:sk-own', true);

  -- ==========================================================
  -- B. Usage is attributable: who paid, for which account.
  -- ==========================================================
  -- Account A runs on the platform key; account B on its own. Two calls
  -- each, so a count that ignored `key_source` would look identical.
  INSERT INTO ai_usage_log
    (account_id, mode, provider, model, key_source,
     prompt_tokens, completion_tokens, total_tokens)
  VALUES (v_account_a, 'auto_reply', 'openai', 'gpt-x', 'platform', 10, 2, 12),
         (v_account_a, 'draft',      'openai', 'gpt-x', 'platform', 20, 4, 24),
         (v_account_b, 'auto_reply', 'openai', 'gpt-x', 'account',  30, 6, 36),
         (v_account_b, 'draft',      'openai', 'gpt-x', 'account',  40, 8, 48);

  -- B1. The platform's bill for account A is separable from A's own
  --     spend and from B's.
  SELECT coalesce(sum(total_tokens), 0) INTO v_platform
    FROM ai_usage_log
   WHERE account_id = v_account_a AND key_source = 'platform';
  SELECT coalesce(sum(total_tokens), 0) INTO v_account
    FROM ai_usage_log
   WHERE account_id = v_account_a AND key_source = 'account';
  IF v_platform <> 36 OR v_account <> 0 THEN
    RAISE EXCEPTION
      'B1: account A should show 36 platform tokens and 0 BYO tokens, got % / %',
      v_platform, v_account;
  END IF;

  SELECT coalesce(sum(total_tokens), 0) INTO v_platform
    FROM ai_usage_log
   WHERE account_id = v_account_b AND key_source = 'platform';
  SELECT coalesce(sum(total_tokens), 0) INTO v_account
    FROM ai_usage_log
   WHERE account_id = v_account_b AND key_source = 'account';
  IF v_platform <> 0 OR v_account <> 84 THEN
    RAISE EXCEPTION
      'B1: account B should show 0 platform tokens and 84 BYO tokens, got % / %',
      v_platform, v_account;
  END IF;

  -- B2. Every row carries its account: no row is unattributable, and
  --     the platform bill never mixes two tenants.
  SELECT count(*) INTO v_scoped
    FROM ai_usage_log
   WHERE account_id IS NULL;
  IF v_scoped <> 0 THEN
    RAISE EXCEPTION 'B2: % ai_usage_log rows have no account_id', v_scoped;
  END IF;
  SELECT count(DISTINCT account_id) INTO v_scoped
    FROM ai_usage_log
   WHERE key_source = 'platform';
  IF v_scoped <> 1 THEN
    RAISE EXCEPTION
      'B2: platform-funded rows should belong to exactly one account here, got %',
      v_scoped;
  END IF;

  -- B3. A writer that predates the column (033-era insert, no
  --     `key_source`) is recorded as BYO — which is what those calls
  --     were: before S1 the key could only be the account's.
  INSERT INTO ai_usage_log
    (account_id, mode, provider, model, prompt_tokens, completion_tokens, total_tokens)
  VALUES (v_account_b, 'draft', 'openai', 'gpt-x', 1, 1, 2)
  RETURNING key_source INTO v_legacy;
  IF v_legacy <> 'account' THEN
    RAISE EXCEPTION 'B3: default key_source should be ''account'', got %', v_legacy;
  END IF;

  -- B4. Negative control — the domain is closed, so a typo cannot
  --     invent a third payer that the billing query would silently drop.
  BEGIN
    INSERT INTO ai_usage_log
      (account_id, mode, provider, model, key_source,
       prompt_tokens, completion_tokens, total_tokens)
    VALUES (v_account_b, 'draft', 'openai', 'gpt-x', 'vendor', 1, 1, 2);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'B4: key_source accepted a value outside (account, platform)';
  END IF;

  -- B5. Negative control — NULL is not a way around the check.
  v_rejected := false;
  BEGIN
    INSERT INTO ai_usage_log
      (account_id, mode, provider, model, key_source,
       prompt_tokens, completion_tokens, total_tokens)
    VALUES (v_account_b, 'draft', 'openai', 'gpt-x', NULL, 1, 1, 2);
  EXCEPTION WHEN not_null_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'B5: key_source accepted NULL';
  END IF;

  -- ----------------------------------------------------------------
  -- C. The playground is billable spend too (047 widened 033's domain).
  -- ----------------------------------------------------------------

  -- C1. A playground turn funded by the platform is accepted and lands
  --     in the same per-account/per-source bucket as the rest.
  INSERT INTO ai_usage_log
    (account_id, mode, provider, model, key_source,
     prompt_tokens, completion_tokens, total_tokens)
  VALUES (v_account_a, 'playground', 'openai', 'gpt-x', 'platform', 5, 5, 10);
  SELECT count(*) INTO v_scoped
    FROM ai_usage_log
   WHERE account_id = v_account_a
     AND mode = 'playground'
     AND key_source = 'platform';
  IF v_scoped <> 1 THEN
    RAISE EXCEPTION 'C1: playground row missing for account A, got %', v_scoped;
  END IF;

  -- C2. The playground has no conversation to point at; the column has
  --     to take NULL or the write would be lost exactly where the
  --     platform pays.
  INSERT INTO ai_usage_log
    (account_id, conversation_id, mode, provider, model, key_source,
     prompt_tokens, completion_tokens, total_tokens)
  VALUES (v_account_a, NULL, 'playground', 'openai', 'gpt-x', 'platform', 1, 1, 2);

  -- C3. Negative control — widening the domain did not open it: a typo
  --     in `mode` is still rejected.
  v_rejected := false;
  BEGIN
    INSERT INTO ai_usage_log
      (account_id, mode, provider, model, key_source,
       prompt_tokens, completion_tokens, total_tokens)
    VALUES (v_account_a, 'sandbox', 'openai', 'gpt-x', 'platform', 1, 1, 2);
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'C3: mode accepted a value outside (auto_reply, draft, playground)';
  END IF;

  RAISE NOTICE 'checks_platform-ai-key: all assertions passed';
END
$$;

ROLLBACK;
