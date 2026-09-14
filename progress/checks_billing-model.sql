-- Behavioural acceptance checks for f0.2 billing-model (fase 0, §2).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports. `C` below is that container's name.
--
-- Part A (RLS) and part B (ON DELETE RESTRICT) are plain SQL and roll
-- back; they run on every invocation:
--
--   docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_billing-model.sql
--
-- Part C (100 concurrent `increment_usage`) cannot live inside one
-- session: this Postgres has no `pg_background` (only dblink, pg_cron
-- and pgcrypto are available in the CI image), and dblink would need a
-- password because `postgres` is not a superuser here. So the
-- concurrency is driven from the shell with 100 parallel psql sessions,
-- released together by a wall-clock barrier so they really do collide on
-- the same row rather than merely overlap. The image ships
-- `max_connections = 100` with 3 reserved, which is one short of 100
-- concurrent tenants' worth of sessions, so raise it first (a property
-- of the test rig, not of the schema):
--
--   C=<container>
--   docker exec -i "$C" psql -U supabase_admin -h localhost -d postgres \
--     -c "alter system set max_connections = 300;"
--   docker restart "$C"
--
--   ACC=$(docker exec -i "$C" psql -U postgres -tAq -v ON_ERROR_STOP=1 \
--           -v setup=1 < progress/checks_billing-model.sql | tail -1)
--   T=$(docker exec -i "$C" psql -U postgres -tAqc \
--         "select to_char(now() + interval '30 seconds', 'YYYY-MM-DD HH24:MI:SS+00')")
--   seq 100 | xargs -P 100 -I{} docker exec -i "$C" psql -U postgres -q \
--     -v ON_ERROR_STOP=1 -c "set role service_role;
--        select pg_sleep(greatest(0, extract(epoch from
--          (timestamptz '$T' - clock_timestamp()))));
--        select public.increment_usage('$ACC', 'messages_out', 1);" >/dev/null
--   docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 \
--     -v assert_usage=1 < progress/checks_billing-model.sql
--
-- The workers also prove the grant: they run as `service_role`, the only
-- role left with EXECUTE on `increment_usage`.
--
-- Every assertion RAISEs on failure, so a silent run is a passing run.

-- ============================================================
-- Part A — a tenant can read its subscription and can never write it.
--
-- `authenticated` holds INSERT/UPDATE/DELETE grants on every table in
-- `public` (001/017), so RLS is the only thing standing between a tenant
-- and giving itself the Negocio plan. That is what this part proves.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner_id    uuid := '00000000-0000-0000-0000-0000000004a1';
  v_stranger_id uuid := '00000000-0000-0000-0000-0000000004a2';
  v_fresh_id    uuid := '00000000-0000-0000-0000-0000000004a3';
  v_account_id  uuid;
  v_other_id    uuid;
  v_unbilled_id uuid;
  v_rows        integer;
  v_denied      boolean;
BEGIN
  -- The auth trigger creates a personal account + owner profile for each
  -- user, so this gives us three unrelated tenants.
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'billing-owner@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_stranger_id, 'authenticated', 'authenticated', 'billing-stranger@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_fresh_id, 'authenticated', 'authenticated', 'billing-unbilled@example.test',
          '{}'::jsonb, '{}'::jsonb);

  SELECT account_id INTO v_account_id  FROM profiles WHERE user_id = v_owner_id;
  SELECT account_id INTO v_other_id    FROM profiles WHERE user_id = v_stranger_id;
  SELECT account_id INTO v_unbilled_id FROM profiles WHERE user_id = v_fresh_id;
  IF v_account_id IS NULL OR v_other_id IS NULL OR v_unbilled_id IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the three accounts';
  END IF;

  -- Seeded by the service role (the migration owner bypasses RLS), which
  -- is exactly how the payment webhook will write it in fase 3. The
  -- third account is deliberately left without a subscription: it is the
  -- target of the INSERT attempt, so a broken policy shows up as a row
  -- created rather than as a constraint error.
  INSERT INTO subscriptions (account_id, plan_id, status)
  VALUES (v_account_id, 'inicio', 'trialing'),
         (v_other_id, 'negocio', 'active');

  -- Become that tenant: `authenticated` + a JWT subject auth.uid() reads.
  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  SET LOCAL ROLE authenticated;

  -- Read: allowed for members (subscriptions_select), and only for them.
  SELECT count(*) INTO v_rows FROM subscriptions WHERE account_id = v_account_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'a member must be able to read its own subscription, saw % rows', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM subscriptions WHERE account_id = v_other_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % subscription row(s) of another account', v_rows;
  END IF;

  -- INSERT: there is no INSERT policy at all, so RLS rejects the new row
  -- before any constraint is even considered — including a row for an
  -- account the caller does not belong to.
  v_denied := false;
  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, status)
    VALUES (v_unbilled_id, 'negocio', 'active');
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'an authenticated user managed to INSERT into subscriptions';
  END IF;

  -- UPDATE is the self-dealing case that matters: upgrading its OWN
  -- subscription to Negocio. With RLS on and no UPDATE policy the rows
  -- visible to the command, so it touches nothing instead of erroring.
  UPDATE subscriptions SET plan_id = 'negocio', status = 'active'
   WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an authenticated user managed to UPDATE % subscription row(s)', v_rows;
  END IF;

  -- DELETE: same, nothing removed.
  DELETE FROM subscriptions WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an authenticated user managed to DELETE % subscription row(s)', v_rows;
  END IF;

  -- The row survived untouched on the plan it was seeded with.
  RESET ROLE;
  IF NOT EXISTS (
    SELECT 1 FROM subscriptions
     WHERE account_id = v_account_id AND plan_id = 'inicio' AND status = 'trialing'
  ) THEN
    RAISE EXCEPTION 'the subscription changed despite every tenant write being denied';
  END IF;

  -- The counters RPC is service-role only (REVOKE from authenticated).
  SET LOCAL ROLE authenticated;
  v_denied := false;
  BEGIN
    PERFORM public.increment_usage(v_account_id, 'messages_out', 1000000);
  EXCEPTION
    WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'an authenticated user managed to EXECUTE increment_usage';
  END IF;
  RESET ROLE;
END
$$;

ROLLBACK;

-- ============================================================
-- Part B — deleting an account cannot silently destroy billing data.
--
-- Both FKs are ON DELETE RESTRICT (041), so the delete fails while any
-- billing row exists; clearing them is a deliberate, separate step.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner_id   uuid := '00000000-0000-0000-0000-0000000004b1';
  v_account_id uuid;
  v_blocked    boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'billing-restrict@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_owner_id;

  -- Each FK is tested on its own, or one of the two could regress to
  -- CASCADE while the other kept the delete from going through.
  INSERT INTO subscriptions (account_id, plan_id, status)
  VALUES (v_account_id, 'pro', 'active');

  -- The subscription alone blocks the delete.
  v_blocked := false;
  BEGIN
    DELETE FROM accounts WHERE id = v_account_id;
  EXCEPTION
    WHEN foreign_key_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'deleting an account with a subscription must be blocked by RESTRICT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = v_account_id) THEN
    RAISE EXCEPTION 'the blocked delete took the subscription with it';
  END IF;

  -- ...and so do the usage counters on their own.
  DELETE FROM subscriptions WHERE account_id = v_account_id;
  PERFORM public.increment_usage(v_account_id, 'messages_out', 7);
  v_blocked := false;
  BEGIN
    DELETE FROM accounts WHERE id = v_account_id;
  EXCEPTION
    WHEN foreign_key_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'deleting an account with usage counters must be blocked by RESTRICT';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM usage_counters WHERE account_id = v_account_id) THEN
    RAISE EXCEPTION 'the blocked delete took the usage counters with it';
  END IF;

  -- The controlled teardown: clear the billing rows on purpose, then the
  -- account row goes. `billing_events` has no FK to accounts and stays.
  DELETE FROM usage_counters WHERE account_id = v_account_id;
  DELETE FROM accounts WHERE id = v_account_id;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_account_id) THEN
    RAISE EXCEPTION 'the controlled teardown left the account behind';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part C, step 1 — fixture for the concurrency run (committed).
-- Prints the account id on stdout for the shell driver.
-- ============================================================
\if :{?setup}
DO $$
DECLARE
  v_owner_id uuid := '00000000-0000-0000-0000-0000000004c1';
  v_old_account uuid;
BEGIN
  -- Idempotent: wipe any fixture left by a previous run.
  SELECT id INTO v_old_account FROM accounts WHERE owner_user_id = v_owner_id;
  IF v_old_account IS NOT NULL THEN
    DELETE FROM usage_counters WHERE account_id = v_old_account;
    DELETE FROM subscriptions  WHERE account_id = v_old_account;
    DELETE FROM accounts       WHERE id = v_old_account;
  END IF;
  DELETE FROM auth.users WHERE id = v_owner_id;

  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'billing-concurrency@example.test',
          '{}'::jsonb, '{}'::jsonb);
END
$$;

SELECT account_id FROM profiles
 WHERE user_id = '00000000-0000-0000-0000-0000000004c1';
\endif

-- ============================================================
-- Part C, step 2 — after the 100 parallel sessions: the counter must be
-- exactly 100, in exactly one row. A lost update shows up as < 100.
-- Cleans the fixture up afterwards.
-- ============================================================
\if :{?assert_usage}
DO $$
DECLARE
  v_owner_id   uuid := '00000000-0000-0000-0000-0000000004c1';
  v_account_id uuid;
  v_value      bigint;
  v_rows       integer;
BEGIN
  -- Resolved from the fixture user rather than passed in: psql does not
  -- interpolate variables inside a dollar-quoted body.
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_owner_id;
  IF v_account_id IS NULL THEN
    RAISE EXCEPTION 'the concurrency fixture account is gone — run the setup step first';
  END IF;

  SELECT count(*), coalesce(sum(value), 0) INTO v_rows, v_value
    FROM usage_counters
   WHERE account_id = v_account_id AND metric = 'messages_out';

  IF v_rows <> 1 THEN
    RAISE EXCEPTION
      'expected exactly 1 usage_counters row for the natural month, found %', v_rows;
  END IF;
  IF v_value <> 100 THEN
    RAISE EXCEPTION
      '100 concurrent increment_usage calls must leave the counter at 100, found %', v_value;
  END IF;

  DELETE FROM usage_counters WHERE account_id = v_account_id;
  DELETE FROM subscriptions  WHERE account_id = v_account_id;
  DELETE FROM accounts       WHERE id = v_account_id;
  DELETE FROM auth.users     WHERE id = v_owner_id;

  RAISE NOTICE 'concurrency check passed: counter is exactly 100';
END
$$;
\endif
