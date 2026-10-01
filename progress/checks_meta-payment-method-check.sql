-- Behavioural acceptance checks for p11.1 meta-payment-method-check (migración 079).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_meta-payment-method-check.sql
--
-- One transaction, rolled back. Any failed assertion RAISEs and psql
-- exits non-zero.
--
-- Seed: two owners (handle_new_user gives each an account, role owner).
--   A: number cfgA, seeded as postgres with meta_payment_status = 'missing'
--   B: number cfgB, seeded as postgres with meta_payment_status = 'missing'

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid);
GRANT SELECT ON ids TO service_role, authenticated;

DO $$
DECLARE
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  acct_a uuid;
  acct_b uuid;
  cfg_a uuid;
  cfg_b uuid;
BEGIN
  INSERT INTO auth.users (id, email) VALUES
    (ua, 'chk-079-a@example.test'),
    (ub, 'chk-079-b@example.test');
  acct_a := (SELECT id FROM accounts WHERE owner_user_id = ua);
  acct_b := (SELECT id FROM accounts WHERE owner_user_id = ub);
  IF acct_a IS NULL OR acct_b IS NULL THEN
    RAISE EXCEPTION 'handle_new_user did not create the accounts';
  END IF;

  -- As postgres: the guard does not apply (it only rewrites for
  -- authenticated/anon), so the seed keeps its status.
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id,
                               access_token, status, meta_payment_status,
                               meta_payment_checked_at)
  VALUES (ua, acct_a, 'chk-079-pn-a', 'waba-a', 'enc-a', 'connected',
          'missing', now() - interval '2 hours')
  RETURNING id INTO cfg_a;
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id,
                               access_token, status, meta_payment_status,
                               meta_payment_checked_at)
  VALUES (ub, acct_b, 'chk-079-pn-b', 'waba-b', 'enc-b', 'connected',
          'missing', now() - interval '2 hours')
  RETURNING id INTO cfg_b;

  INSERT INTO ids VALUES ('ua', ua), ('ub', ub), ('acct_a', acct_a),
    ('acct_b', acct_b), ('cfg_a', cfg_a), ('cfg_b', cfg_b);

  IF (SELECT meta_payment_status FROM whatsapp_config WHERE id = cfg_a)
     IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'seed as postgres lost its status';
  END IF;
END $$;

-- ------------------------------------------------------------
-- R1. The CHECK rejects anything outside ok|missing|unknown.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE whatsapp_config SET meta_payment_status = 'foo'
    WHERE id = (SELECT v FROM ids WHERE k = 'cfg_a');
    RAISE EXCEPTION 'CHECK accepted meta_payment_status = foo';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'R1 ok: CHECK rejects foo';
END $$;

-- ------------------------------------------------------------
-- R2. An admin of A cannot mark themselves 'ok' from the browser.
--     Other columns still update (the trigger only pins the three).
-- ------------------------------------------------------------
DO $$
DECLARE
  ua uuid := (SELECT v FROM ids WHERE k = 'ua');
  cfg_a uuid := (SELECT v FROM ids WHERE k = 'cfg_a');
  cfg_b uuid := (SELECT v FROM ids WHERE k = 'cfg_b');
  acct_a uuid := (SELECT v FROM ids WHERE k = 'acct_a');
  n int;
  st text;
  lbl text;
  new_id uuid;
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ua::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE whatsapp_config
     SET meta_payment_status = 'ok',
         meta_payment_checked_at = now(),
         meta_payment_error = 'forged',
         label = 'chk-079-label'
   WHERE id = cfg_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN
    RAISE EXCEPTION 'R2 setup: owner A could not update own row (RLS?), rows=%', n;
  END IF;
  SELECT meta_payment_status, label INTO st, lbl FROM whatsapp_config WHERE id = cfg_a;
  IF st IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'R2: authenticated forged meta_payment_status = %', st;
  END IF;
  IF lbl IS DISTINCT FROM 'chk-079-label' THEN
    RAISE EXCEPTION 'R2: the trigger swallowed an unrelated column (label = %)', lbl;
  END IF;
  IF (SELECT meta_payment_error FROM whatsapp_config WHERE id = cfg_a) IS NOT NULL THEN
    RAISE EXCEPTION 'R2: authenticated forged meta_payment_error';
  END IF;

  -- INSERT from the browser: the three columns land NULL.
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, waba_id,
                               access_token, status, meta_payment_status,
                               meta_payment_checked_at, meta_payment_error)
  VALUES (ua, acct_a, 'chk-079-pn-a2', 'waba-a2', 'enc-a2', 'connected',
          'ok', now(), 'forged')
  RETURNING id INTO new_id;
  IF (SELECT meta_payment_status IS NOT NULL OR meta_payment_checked_at IS NOT NULL
             OR meta_payment_error IS NOT NULL
      FROM whatsapp_config WHERE id = new_id) THEN
    RAISE EXCEPTION 'R2: authenticated INSERT kept a forged payment status';
  END IF;

  -- CP3: A cannot touch nor see B's row.
  UPDATE whatsapp_config SET meta_payment_status = 'ok' WHERE id = cfg_b;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'R2/CP3: A updated B''s row';
  END IF;
  IF EXISTS (SELECT 1 FROM whatsapp_config WHERE id = cfg_b) THEN
    RAISE EXCEPTION 'CP3: A can read B''s whatsapp_config row';
  END IF;

  RESET ROLE;

  IF (SELECT meta_payment_status FROM whatsapp_config WHERE id = cfg_b)
     IS DISTINCT FROM 'missing' THEN
    RAISE EXCEPTION 'CP3: B''s status changed';
  END IF;
  RAISE NOTICE 'R2 ok: authenticated cannot write the payment columns; RLS isolates B';
END $$;

-- ------------------------------------------------------------
-- R2 (other half). The service role writes them.
-- ------------------------------------------------------------
DO $$
DECLARE
  cfg_a uuid := (SELECT v FROM ids WHERE k = 'cfg_a');
  acct_a uuid := (SELECT v FROM ids WHERE k = 'acct_a');
BEGIN
  SET LOCAL ROLE service_role;
  UPDATE whatsapp_config
     SET meta_payment_status = 'ok', meta_payment_checked_at = now(),
         meta_payment_error = NULL
   WHERE id = cfg_a AND account_id = acct_a;
  RESET ROLE;
  IF (SELECT meta_payment_status FROM whatsapp_config WHERE id = cfg_a)
     IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'R2: service_role could not write meta_payment_status';
  END IF;
  RAISE NOTICE 'R2 ok: service_role writes the payment columns';
END $$;

-- ------------------------------------------------------------
-- R3. Changing waba_id (or access_token) from the browser resets them.
-- ------------------------------------------------------------
DO $$
DECLARE
  ua uuid := (SELECT v FROM ids WHERE k = 'ua');
  cfg_a uuid := (SELECT v FROM ids WHERE k = 'cfg_a');
BEGIN
  PERFORM set_config('request.jwt.claim.sub', ua::text, true);
  PERFORM set_config('request.jwt.claims',
                     json_build_object('sub', ua, 'role', 'authenticated')::text, true);
  SET LOCAL ROLE authenticated;
  UPDATE whatsapp_config SET waba_id = 'waba-a-new' WHERE id = cfg_a;
  RESET ROLE;
  IF (SELECT meta_payment_status IS NOT NULL OR meta_payment_checked_at IS NOT NULL
             OR meta_payment_error IS NOT NULL
      FROM whatsapp_config WHERE id = cfg_a) THEN
    RAISE EXCEPTION 'R3: changing waba_id did not reset the payment status';
  END IF;

  -- Put it back to ok (service role) and check the token half.
  SET LOCAL ROLE service_role;
  UPDATE whatsapp_config SET meta_payment_status = 'ok',
         meta_payment_checked_at = now() WHERE id = cfg_a;
  RESET ROLE;
  SET LOCAL ROLE authenticated;
  UPDATE whatsapp_config SET access_token = 'enc-a-rotated' WHERE id = cfg_a;
  RESET ROLE;
  IF (SELECT meta_payment_status FROM whatsapp_config WHERE id = cfg_a) IS NOT NULL THEN
    RAISE EXCEPTION 'R3: changing access_token did not reset the payment status';
  END IF;

  -- The service role rotating the token (token-renewal) does NOT reset it.
  SET LOCAL ROLE service_role;
  UPDATE whatsapp_config SET meta_payment_status = 'ok',
         meta_payment_checked_at = now() WHERE id = cfg_a;
  UPDATE whatsapp_config SET access_token = 'enc-a-renewed' WHERE id = cfg_a;
  RESET ROLE;
  IF (SELECT meta_payment_status FROM whatsapp_config WHERE id = cfg_a)
     IS DISTINCT FROM 'ok' THEN
    RAISE EXCEPTION 'R3: a service-role token renewal reset the payment status';
  END IF;
  RAISE NOTICE 'R3 ok: waba_id/access_token changes from the browser reset the status';
END $$;

-- ------------------------------------------------------------
-- Index: the sweep predicate can use the partial index.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_indexes
    WHERE indexname = 'whatsapp_config_meta_payment_checked_idx'
      AND indexdef LIKE '%WHERE ((status = ''connected''::text) AND (waba_id IS NOT NULL))%'
  ) THEN
    RAISE EXCEPTION 'partial index predicate is not the expected one';
  END IF;
  RAISE NOTICE 'index ok';
END $$;

ROLLBACK;
