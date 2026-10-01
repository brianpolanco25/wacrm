-- Behavioural acceptance checks for s9.4 platform-provisioning (migración 071).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_platform-provisioning.sql
--
-- Everything runs inside one transaction and rolls back. Any failed
-- assertion RAISEs and psql exits non-zero.
--
-- Seed: three users. handle_new_user() (017) gives each its personal
-- account and 046 a pro/trialing row.
--   op1, op2  platform operators (op1 seeded by hand, op2 via the function)
--   owner     a plain tenant owner, whose account is the target

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO service_role, authenticated;

DO $$
DECLARE
  op1 uuid := gen_random_uuid();
  op2 uuid := gen_random_uuid();
  own uuid := gen_random_uuid();
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (op1, 'chk-071-op1@example.test'),
    (op2, 'chk-071-op2@example.test'),
    (own, 'chk-071-owner@example.test');
  INSERT INTO platform_admins (user_id, granted_by, note)
  VALUES (op1, op1, 'bootstrap for checks');
  INSERT INTO ids VALUES
    ('op1', op1), ('op2', op2), ('owner', own),
    ('acct', (SELECT id FROM accounts WHERE owner_user_id = own));
  IF (SELECT v FROM ids WHERE k = 'acct') IS NULL THEN
    RAISE EXCEPTION 'handle_new_user did not create the owner account';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 1. The widened CHECK, and the account rule
-- ------------------------------------------------------------
DO $$
DECLARE
  op1 uuid := (SELECT v FROM ids WHERE k = 'op1');
  acct uuid := (SELECT v FROM ids WHERE k = 'acct');
  a text;
BEGIN
  FOREACH a IN ARRAY ARRAY['plan_override', 'member_invite'] LOOP
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, details)
    VALUES (op1, acct, 'checks for migration 071', a, '{"k":1}');
  END LOOP;
  FOREACH a IN ARRAY ARRAY['account_create', 'operator_grant', 'operator_revoke'] LOOP
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, details)
    VALUES (op1, NULL, 'checks for migration 071', a, '{"k":1}');
  END LOOP;

  BEGIN
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action)
    VALUES (op1, acct, 'checks for migration 071', 'bogus');
    RAISE EXCEPTION 'CHECK accepted an unknown action';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  FOREACH a IN ARRAY ARRAY['impersonation', 'suspend', 'reactivate', 'plan_override', 'member_invite'] LOOP
    BEGIN
      INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
      VALUES (op1, NULL, 'checks for migration 071', a, now() + interval '1 hour');
      RAISE EXCEPTION '% accepted a NULL account_id', a;
    EXCEPTION WHEN check_violation THEN NULL;
    END;
  END LOOP;

  -- The 058 expiry rule still stands for sessions.
  BEGIN
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action)
    VALUES (op1, acct, 'checks for migration 071', 'impersonation');
    RAISE EXCEPTION 'an impersonation row was accepted without expiry';
  EXCEPTION WHEN check_violation THEN NULL;
  END;

  RAISE NOTICE 'widened CHECK + account rule: OK';
END $$;

-- ------------------------------------------------------------
-- 2. has_open_support_session ignores plan_override (and friends)
-- ------------------------------------------------------------
-- An open-looking plan_override row for the target: not ended, with an
-- expiry in the future. It must NOT grant the read.
INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
SELECT (SELECT v FROM ids WHERE k = 'op1'), (SELECT v FROM ids WHERE k = 'acct'),
       'plan override, not a session', 'plan_override', now() + interval '1 hour';
INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
SELECT (SELECT v FROM ids WHERE k = 'op1'), (SELECT v FROM ids WHERE k = 'acct'),
       'member invite, not a session', 'member_invite', now() + interval '1 hour';

-- auth.uid() in this image reads request.jwt.claim.sub; newer ones read
-- request.jwt.claims. Both are set.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'op1'), 'role', 'authenticated')::text,
  true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'op1')::text, true);
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF public.has_open_support_session((SELECT v FROM ids WHERE k = 'acct')) THEN
    RAISE EXCEPTION 'a plan_override/member_invite row opened a support session';
  END IF;
  RAISE NOTICE 'has_open_support_session ignores plan_override: OK';
END $$;
RESET ROLE;

-- Control: a real impersonation row does open it (the check above is not
-- vacuously false).
INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
SELECT (SELECT v FROM ids WHERE k = 'op1'), (SELECT v FROM ids WHERE k = 'acct'),
       'support session control', 'impersonation', now() + interval '1 hour';
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  IF NOT public.has_open_support_session((SELECT v FROM ids WHERE k = 'acct')) THEN
    RAISE EXCEPTION 'control failed: an impersonation row did not open the session';
  END IF;
  RAISE NOTICE 'control (impersonation opens it): OK';
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 3. The tenant cannot write its own subscription
-- ------------------------------------------------------------
-- auth.uid() in this image reads request.jwt.claim.sub; newer ones read
-- request.jwt.claims. Both are set.
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'owner'), 'role', 'authenticated')::text,
  true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'owner')::text, true);
SET LOCAL ROLE authenticated;
DO $$
DECLARE
  acct uuid := (SELECT v FROM ids WHERE k = 'acct');
  n int;
BEGIN
  -- Visible (the owner reads its own row)…
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = acct) THEN
    RAISE EXCEPTION 'owner cannot even read its subscription (unexpected)';
  END IF;

  -- …but not writable: no UPDATE policy, so zero rows.
  UPDATE subscriptions
     SET plan_id = 'negocio', provider = 'manual', status = 'active'
   WHERE account_id = acct;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'tenant updated its own subscription (% rows)', n;
  END IF;

  BEGIN
    DELETE FROM subscriptions WHERE account_id = acct;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN
      RAISE EXCEPTION 'tenant deleted its own subscription';
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, provider, status)
    VALUES (acct, 'negocio', 'manual', 'active')
    ON CONFLICT (account_id) DO UPDATE SET plan_id = 'negocio';
    RAISE EXCEPTION 'tenant upserted its own subscription';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Nor the bitácora.
  BEGIN
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action)
    VALUES (auth.uid(), acct, 'forging a plan override', 'plan_override');
    RAISE EXCEPTION 'tenant wrote to impersonation_log';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  RAISE NOTICE 'tenant cannot write subscriptions / the log: OK';
END $$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT plan_id FROM subscriptions
      WHERE account_id = (SELECT v FROM ids WHERE k = 'acct')) <> 'pro' THEN
    RAISE EXCEPTION 'the subscription moved after the tenant attempts';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 4. The manual plan, as service_role (what the route writes)
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
DO $$
DECLARE
  acct uuid := (SELECT v FROM ids WHERE k = 'acct');
  r subscriptions%ROWTYPE;
BEGIN
  INSERT INTO subscriptions (
    account_id, plan_id, provider, status, provider_subscription_id,
    cycle, trial_ends_at, grace_until, cancel_at_period_end
  ) VALUES (acct, 'negocio', 'manual', 'active', NULL, NULL, NULL, NULL, false)
  ON CONFLICT (account_id) DO UPDATE SET
    plan_id = EXCLUDED.plan_id, provider = EXCLUDED.provider,
    status = EXCLUDED.status,
    provider_subscription_id = EXCLUDED.provider_subscription_id,
    cycle = EXCLUDED.cycle, trial_ends_at = EXCLUDED.trial_ends_at,
    grace_until = EXCLUDED.grace_until,
    cancel_at_period_end = EXCLUDED.cancel_at_period_end;
  SELECT * INTO r FROM subscriptions WHERE account_id = acct;
  IF r.plan_id <> 'negocio' OR r.provider <> 'manual' OR r.status <> 'active'
     OR r.trial_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'manual plan upsert did not land: %', row_to_json(r);
  END IF;
  -- Comped: out of the MRR (069), counted apart.
  IF (public.platform_metrics() -> 'comped')::int < 1 THEN
    RAISE EXCEPTION 'the manual plan is not counted as comped';
  END IF;
  RAISE NOTICE 'manual plan as service_role (comped, not MRR): OK';
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 5. Operators: grant / revoke through the functions
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
DO $$
DECLARE
  op1 uuid := (SELECT v FROM ids WHERE k = 'op1');
  op2 uuid := (SELECT v FROM ids WHERE k = 'op2');
  n int;
  before_count int := (SELECT count(*) FROM platform_admins);
BEGIN
  -- A replayed base has no other operator, so after op2 is revoked op1 is
  -- the last one and the "last" rule is exercised below (skipped, with a
  -- notice, on a base that holds more).
  PERFORM public.platform_grant_operator(op2, op1, 'second operator for checks');
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = op2 AND granted_by = op1) THEN
    RAISE EXCEPTION 'grant did not insert platform_admins';
  END IF;
  SELECT count(*) INTO n FROM impersonation_log
   WHERE action = 'operator_grant' AND account_id IS NULL
     AND details ->> 'target_user_id' = op2::text
     AND details ->> 'target_email' = 'chk-071-op2@example.test';
  IF n <> 1 THEN
    RAISE EXCEPTION 'grant was not logged with its details (% rows)', n;
  END IF;

  BEGIN
    PERFORM public.platform_grant_operator(op2, op1, 'second operator again');
    RAISE EXCEPTION 'granted twice';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'operator_exists' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.platform_grant_operator(gen_random_uuid(), op1, 'a user that does not exist');
    RAISE EXCEPTION 'granted a ghost';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'user_absent' THEN RAISE; END IF;
  END;

  -- Short reason: the 055 CHECK refuses the log row, and with it the grant.
  BEGIN
    PERFORM public.platform_grant_operator(
      (SELECT v FROM ids WHERE k = 'owner'), op1, 'short');
    RAISE EXCEPTION 'granted with a short reason';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  IF EXISTS (SELECT 1 FROM platform_admins
             WHERE user_id = (SELECT v FROM ids WHERE k = 'owner')) THEN
    RAISE EXCEPTION 'grant survived its failed log row';
  END IF;

  BEGIN
    PERFORM public.platform_revoke_operator(op1, op1, 'revoking myself on purpose');
    RAISE EXCEPTION 'revoked self';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'operator_self' THEN RAISE; END IF;
  END;

  BEGIN
    PERFORM public.platform_revoke_operator(
      (SELECT v FROM ids WHERE k = 'owner'), op1, 'not an operator at all');
    RAISE EXCEPTION 'revoked a non-operator';
  EXCEPTION WHEN raise_exception THEN
    IF SQLERRM <> 'operator_absent' THEN RAISE; END IF;
  END;

  PERFORM public.platform_revoke_operator(op2, op1, 'second operator leaves');
  IF EXISTS (SELECT 1 FROM platform_admins WHERE user_id = op2) THEN
    RAISE EXCEPTION 'revoke did not delete';
  END IF;
  SELECT count(*) INTO n FROM impersonation_log
   WHERE action = 'operator_revoke' AND details ->> 'target_user_id' = op2::text;
  IF n <> 1 THEN
    RAISE EXCEPTION 'revoke was not logged';
  END IF;

  -- The last operator. Only meaningful if op1 is alone now.
  IF (SELECT count(*) FROM platform_admins) = 1 THEN
    -- op2 (no longer an operator) is the actor, so the self rule does not
    -- fire first: what refuses is the count.
    BEGIN
      PERFORM public.platform_revoke_operator(op1, op2, 'revoking the very last one');
      RAISE EXCEPTION 'revoked the last operator';
    EXCEPTION WHEN raise_exception THEN
      IF SQLERRM <> 'operator_last' THEN RAISE; END IF;
    END;
    IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_id = op1) THEN
      RAISE EXCEPTION 'the last operator is gone';
    END IF;
  ELSE
    RAISE NOTICE 'base holds % other operators; last-operator rule skipped', before_count - 1;
  END IF;

  RAISE NOTICE 'operator grant/revoke functions: OK';
END $$;
RESET ROLE;

-- Client roles cannot call them.
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM public.platform_grant_operator(
      (SELECT v FROM ids WHERE k = 'owner'), (SELECT v FROM ids WHERE k = 'owner'),
      'self-promotion attempt');
    RAISE EXCEPTION 'authenticated ran platform_grant_operator';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'authenticated denied on operator functions: OK';
END $$;
RESET ROLE;

ROLLBACK;
