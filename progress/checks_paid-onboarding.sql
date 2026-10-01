-- Behavioural acceptance checks for s9.6 paid-onboarding (migración 073).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports. Section 2 re-applies the migration from inside the
-- transaction, so copy it in first:
--
--   docker cp <worktree>/supabase/migrations/073_no_trial.sql "$C":/tmp/073_no_trial.sql
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_paid-onboarding.sql
--
-- Everything runs inside one transaction and rolls back. Any failed
-- assertion RAISEs and psql exits non-zero.

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO service_role, authenticated;

-- ------------------------------------------------------------
-- 1. A new signup: handle_new_user() + the 073 seed → incomplete, no date
-- ------------------------------------------------------------
DO $$
DECLARE
  own uuid := '73000000-0000-4000-8000-000000000001';
  mem uuid := '73000000-0000-4000-8000-000000000002';
  op  uuid := '73000000-0000-4000-8000-000000000003';
  inv uuid := '73000000-0000-4000-8000-000000000004';
  acct uuid;
  s record;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (own, 'chk-073-owner@example.test'),
    (mem, 'chk-073-agent@example.test'),
    (op,  'chk-073-op@example.test'),
    (inv, 'chk-073-invitee@example.test');
  acct := (SELECT id FROM accounts WHERE owner_user_id = own);
  IF acct IS NULL THEN RAISE EXCEPTION 'handle_new_user did not create the account'; END IF;
  INSERT INTO ids VALUES ('owner', own), ('agent', mem), ('op', op), ('invitee', inv), ('acct', acct);

  SELECT plan_id, status, trial_ends_at, provider_subscription_id INTO s
  FROM subscriptions WHERE account_id = acct;
  IF NOT FOUND THEN RAISE EXCEPTION 'no subscription row seeded for a new account'; END IF;
  IF s.status <> 'incomplete' THEN RAISE EXCEPTION 'new account seeded as % (expected incomplete)', s.status; END IF;
  IF s.plan_id <> 'inicio' THEN RAISE EXCEPTION 'new account seeded on plan % (expected inicio)', s.plan_id; END IF;
  IF s.trial_ends_at IS NOT NULL THEN RAISE EXCEPTION 'new account seeded with a trial end date'; END IF;
  RAISE NOTICE 'new signup → inicio/incomplete, no trial_ends_at: OK';

  -- A bare INSERT relies on the column default, not on the trigger.
  IF (SELECT column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'subscriptions' AND column_name = 'status')
     NOT LIKE '%incomplete%' THEN
    RAISE EXCEPTION 'subscriptions.status default is not incomplete';
  END IF;

  -- The agent joins the owner's company (as an invitation would leave it).
  UPDATE profiles SET account_id = acct, account_role = 'agent' WHERE user_id = mem;
  INSERT INTO platform_admins (user_id, granted_by, note) VALUES (op, op, 'checks 073');
END $$;

-- ------------------------------------------------------------
-- 2. Existing trials become incomplete (decision 3), re-applying 073
-- ------------------------------------------------------------
UPDATE subscriptions
SET status = 'trialing', plan_id = 'pro', trial_ends_at = now() + interval '9 days'
WHERE account_id = (SELECT v FROM ids WHERE k = 'acct');

\i /tmp/073_no_trial.sql

DO $$
DECLARE
  s record;
BEGIN
  SELECT status, trial_ends_at INTO s FROM subscriptions WHERE account_id = (SELECT v FROM ids WHERE k = 'acct');
  IF s.status <> 'incomplete' OR s.trial_ends_at IS NOT NULL THEN
    RAISE EXCEPTION 'a trialing row was left as %/% after 073', s.status, s.trial_ends_at;
  END IF;
  IF EXISTS (SELECT 1 FROM subscriptions WHERE status = 'trialing') THEN
    RAISE EXCEPTION 'trialing rows survive 073';
  END IF;
  -- Put the plan back where the seed leaves it for the rest of the file.
  UPDATE subscriptions SET plan_id = 'inicio' WHERE account_id = (SELECT v FROM ids WHERE k = 'acct');
  RAISE NOTICE 'trialing → incomplete, trial_ends_at NULL (and 073 re-runs cleanly): OK';
END $$;

-- ------------------------------------------------------------
-- 3. The CHECKs on the company profile
-- ------------------------------------------------------------
DO $$
DECLARE
  acct uuid := (SELECT v FROM ids WHERE k = 'acct');
BEGIN
  BEGIN
    UPDATE accounts SET country = 'do' WHERE id = acct;
    RAISE EXCEPTION 'lower-case country accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE accounts SET country = 'DOM' WHERE id = acct;
    RAISE EXCEPTION 'three-letter country accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE accounts SET team_size = '7' WHERE id = acct;
    RAISE EXCEPTION 'team_size outside the list accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE accounts SET onboarding_completed_at = now() WHERE id = acct;
    RAISE EXCEPTION 'onboarding stamped without a profile';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, status) VALUES (acct, 'inicio', 'demo')
    ON CONFLICT (account_id) DO UPDATE SET status = excluded.status;
    RAISE EXCEPTION 'status outside the CHECK accepted';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'company profile CHECKs: OK';
END $$;

-- ------------------------------------------------------------
-- 4. As the OWNER: may write the company profile, may not touch subscriptions
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'owner'), 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'owner')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  acct uuid := (SELECT v FROM ids WHERE k = 'acct');
  n int;
BEGIN
  UPDATE accounts
  SET name = 'Ferretería Check', country = 'DO', phone = '+1 809 555 0101',
      industry = 'retail', team_size = '2-5'
  WHERE id = acct;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'the owner could not update their company profile (% rows)', n; END IF;

  UPDATE subscriptions SET status = 'active' WHERE account_id = acct;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'an authenticated owner flipped their own subscription to active'; END IF;

  BEGIN
    DELETE FROM subscriptions WHERE account_id = acct;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION 'an authenticated owner deleted their subscription'; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, status) VALUES (gen_random_uuid(), 'pro', 'active');
    RAISE EXCEPTION 'an authenticated user inserted a subscription';
  EXCEPTION WHEN insufficient_privilege OR foreign_key_violation THEN NULL;
  END;
  RAISE NOTICE 'owner updates the profile, cannot touch subscriptions: OK';
END $$;

RESET ROLE;

DO $$
BEGIN
  IF (SELECT status FROM subscriptions WHERE account_id = (SELECT v FROM ids WHERE k = 'acct')) <> 'incomplete' THEN
    RAISE EXCEPTION 'the subscription moved under the tenant';
  END IF;
  IF (SELECT country FROM accounts WHERE id = (SELECT v FROM ids WHERE k = 'acct')) <> 'DO' THEN
    RAISE EXCEPTION 'the owner profile write did not land';
  END IF;
END $$;

-- ------------------------------------------------------------
-- 5. As an AGENT of the same company: cannot write the profile
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'agent'), 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'agent')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n int;
BEGIN
  UPDATE accounts SET country = 'MX' WHERE id = (SELECT v FROM ids WHERE k = 'acct');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'an agent updated the company profile'; END IF;
  RAISE NOTICE 'agent cannot update the profile: OK';
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- 6. As a platform operator INSIDE an open support session: accounts
--    stays closed (072), even with the session open on this very company
-- ------------------------------------------------------------
INSERT INTO impersonation_log (actor_user_id, account_id, account_name, reason, expires_at)
SELECT (SELECT v FROM ids WHERE k = 'op'), (SELECT v FROM ids WHERE k = 'acct'),
       'Ferretería Check', 'checks 073: el soporte no toca accounts', now() + interval '30 minutes';

SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'op'), 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'op')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  n int;
BEGIN
  IF NOT has_open_support_session((SELECT v FROM ids WHERE k = 'acct')) THEN
    RAISE EXCEPTION 'the support session did not open (test setup)';
  END IF;
  UPDATE accounts SET country = 'KR' WHERE id = (SELECT v FROM ids WHERE k = 'acct');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'a support session updated the company profile'; END IF;
  UPDATE subscriptions SET status = 'active' WHERE account_id = (SELECT v FROM ids WHERE k = 'acct');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'a support session activated the subscription'; END IF;
  RAISE NOTICE 'support session cannot update accounts nor subscriptions: OK';
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- 7. The service role stamps onboarding once the profile is complete
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
DO $$
DECLARE
  n int;
BEGIN
  UPDATE accounts SET onboarding_completed_at = now()
  WHERE id = (SELECT v FROM ids WHERE k = 'acct') AND onboarding_completed_at IS NULL;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'service role could not stamp a complete profile'; END IF;
  RAISE NOTICE 'onboarding stamp with a complete profile: OK';
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 8. Invitations still work: the incomplete seed of the invitee's
--    personal account is discarded, not counted as "data"
-- ------------------------------------------------------------
INSERT INTO account_invitations (account_id, label, role, token_hash, created_by_user_id, expires_at)
SELECT (SELECT v FROM ids WHERE k = 'acct'), 'chk-073-invitee@example.test', 'agent',
       'chk-073-token-hash', (SELECT v FROM ids WHERE k = 'owner'), now() + interval '1 day';

INSERT INTO ids VALUES ('invitee_acct', (SELECT id FROM accounts WHERE owner_user_id = (SELECT v FROM ids WHERE k = 'invitee')));

DO $$
BEGIN
  IF (SELECT status FROM subscriptions WHERE account_id = (SELECT v FROM ids WHERE k = 'invitee_acct')) <> 'incomplete' THEN
    RAISE EXCEPTION 'the invitee personal account was not seeded incomplete (test setup)';
  END IF;
END $$;

SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'invitee'), 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'invitee')::text, true);
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  joined uuid;
BEGIN
  joined := redeem_invitation('chk-073-token-hash');
  IF joined <> (SELECT v FROM ids WHERE k = 'acct') THEN
    RAISE EXCEPTION 'redeem_invitation joined the wrong account';
  END IF;
END $$;

RESET ROLE;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM accounts WHERE id = (SELECT v FROM ids WHERE k = 'invitee_acct')) THEN
    RAISE EXCEPTION 'the invitee personal account survived';
  END IF;
  IF EXISTS (SELECT 1 FROM subscriptions WHERE account_id = (SELECT v FROM ids WHERE k = 'invitee_acct')) THEN
    RAISE EXCEPTION 'the invitee incomplete seed survived';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles
    WHERE user_id = (SELECT v FROM ids WHERE k = 'invitee')
      AND account_id = (SELECT v FROM ids WHERE k = 'acct')
      AND account_role = 'agent'
  ) THEN
    RAISE EXCEPTION 'the invitee profile did not move into the inviting account with the invitation role';
  END IF;
  RAISE NOTICE 'invitation redeems over an incomplete seed, profile moved as agent: OK';
END $$;

-- A paid (manual) personal account still counts as data.
DO $$
DECLARE
  u uuid := '73000000-0000-4000-8000-000000000005';
  a uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (u, 'chk-073-paid@example.test');
  a := (SELECT id FROM accounts WHERE owner_user_id = u);
  UPDATE subscriptions SET provider = 'manual', status = 'active' WHERE account_id = a;
  INSERT INTO ids VALUES ('paid', u);
  INSERT INTO account_invitations (account_id, label, role, token_hash, created_by_user_id, expires_at)
  VALUES ((SELECT v FROM ids WHERE k = 'acct'), 'chk-073-paid@example.test', 'agent',
          'chk-073-token-hash-2', (SELECT v FROM ids WHERE k = 'owner'), now() + interval '1 day');
END $$;

SELECT set_config('request.jwt.claims',
  json_build_object('sub', (SELECT v FROM ids WHERE k = 'paid'), 'role', 'authenticated')::text, true),
  set_config('request.jwt.claim.sub', (SELECT v FROM ids WHERE k = 'paid')::text, true);
SET LOCAL ROLE authenticated;

DO $$
BEGIN
  BEGIN
    PERFORM redeem_invitation('chk-073-token-hash-2');
    RAISE EXCEPTION 'a paying personal account was dissolved by an invitation';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  RAISE NOTICE 'a manual/active personal account still counts as data: OK';
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- 9. MRR (069) does not count incomplete; by_status does
-- ------------------------------------------------------------
SET LOCAL ROLE service_role;
DO $$
DECLARE
  m jsonb := platform_metrics();
BEGIN
  IF coalesce((m #>> '{accounts,by_status,incomplete}')::int, 0) < 1 THEN
    RAISE EXCEPTION 'by_status has no incomplete bucket: %', m -> 'accounts';
  END IF;
  RAISE NOTICE 'platform_metrics by_status.incomplete = %, mrr = %',
    m #>> '{accounts,by_status,incomplete}', m #>> '{revenue,mrr_usd}';
END $$;

-- The MRR filter itself: an incomplete row on a paid plan adds nothing.
DO $$
DECLARE
  before numeric := (platform_metrics() #>> '{revenue,mrr_usd}')::numeric;
  after numeric;
BEGIN
  UPDATE subscriptions SET plan_id = 'negocio', cycle = 'month'
  WHERE account_id = (SELECT v FROM ids WHERE k = 'acct');
  after := (platform_metrics() #>> '{revenue,mrr_usd}')::numeric;
  IF after <> before THEN
    RAISE EXCEPTION 'an incomplete account moved the MRR (% → %)', before, after;
  END IF;
  RAISE NOTICE 'incomplete stays out of the MRR: OK';
END $$;
RESET ROLE;

ROLLBACK;
