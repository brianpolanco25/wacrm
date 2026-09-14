-- Behavioural acceptance checks for f3.2 checkout-flow (fase 3, §2).
--
-- Everything the route relies on that TypeScript cannot prove: the RLS of
-- `checkout_intents` (migration 048), the uniqueness that stops one tenant
-- claiming another's PayPal subscription, the non-destructive FK, the
-- CHECK/DEFAULT that keep a row from meaning something it should not, and
-- the interaction between that FK and `redeem_invitation()` (migration 049).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   C=<container>
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_checkout-flow.sql
--
-- Every assertion RAISEs on failure, so a silent run (BEGIN/DO/ROLLBACK …)
-- is a passing run. Nothing is left behind: each part rolls back.

-- ============================================================
-- Part A — a tenant can READ its own checkout intents and can never
-- write one, not even for itself.
--
-- Why it matters: `provider_subscription_id` is the key the webhook of
-- §3 will use to decide which account a payment belongs to. A tenant
-- able to INSERT here could point a row at somebody else's PayPal
-- subscription — or at its own cheap one while claiming the Negocio
-- plan — and get the upgrade for free. `authenticated` holds the table
-- grants (001/017), so RLS is the only thing in the way.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_admin_id    uuid := '00000000-0000-0000-0000-0000000f3201';
  v_agent_id    uuid := '00000000-0000-0000-0000-0000000f3202';
  v_stranger_id uuid := '00000000-0000-0000-0000-0000000f3203';
  v_account_id  uuid;
  v_other_id    uuid;
  v_rows        integer;
  v_denied      boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_admin_id, 'authenticated', 'authenticated', 'checkout-admin@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_agent_id, 'authenticated', 'authenticated', 'checkout-agent@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_stranger_id, 'authenticated', 'authenticated', 'checkout-stranger@example.test',
          '{}'::jsonb, '{}'::jsonb);

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_admin_id;
  SELECT account_id INTO v_other_id   FROM profiles WHERE user_id = v_stranger_id;
  -- The agent joins the admin's account: the "member but not admin" case.
  UPDATE profiles
     SET account_id = v_account_id, account_role = 'agent'::account_role_enum
   WHERE user_id = v_agent_id;
  IF v_account_id IS NULL OR v_other_id IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the two accounts';
  END IF;

  -- Seeded the way the route does it: service role, account from the
  -- authenticated context.
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id, created_by)
  VALUES (v_account_id, 'pro', 'month', 'P-PRO-MONTH', 'I-MINE', v_admin_id),
         (v_other_id, 'negocio', 'year', 'P-NEG-YEAR', 'I-THEIRS', v_stranger_id);

  -- ---- the admin: reads its own, never another account's ----
  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id)::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_rows FROM checkout_intents WHERE account_id = v_account_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'an admin must read its own checkout intent, saw % rows', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM checkout_intents WHERE account_id = v_other_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % checkout intent(s) of another account', v_rows;
  END IF;
  -- The lookup the return page performs, by provider subscription id.
  SELECT count(*) INTO v_rows
    FROM checkout_intents WHERE provider_subscription_id = 'I-THEIRS';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant resolved another account''s PayPal subscription id';
  END IF;

  -- INSERT: no policy at all → rejected before any constraint.
  v_denied := false;
  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_account_id, 'negocio', 'year', 'P-NEG-YEAR', 'I-FORGED');
  EXCEPTION WHEN insufficient_privilege THEN v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'an authenticated user managed to INSERT a checkout intent';
  END IF;

  -- UPDATE: no rows are visible to the command, so it touches nothing.
  UPDATE checkout_intents SET plan_id = 'negocio', status = 'activated'
   WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an authenticated user managed to UPDATE % checkout intent(s)', v_rows;
  END IF;

  DELETE FROM checkout_intents WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an authenticated user managed to DELETE % checkout intent(s)', v_rows;
  END IF;

  -- ---- the agent: a member, but billing data is admin+ ----
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_agent_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_id)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM checkout_intents;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an agent read % checkout intent(s); the policy is admin+', v_rows;
  END IF;

  -- ---- the stranger sees only its own ----
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_stranger_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_stranger_id)::text, true);
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO v_rows FROM checkout_intents;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the other account saw % rows, expected only its own', v_rows;
  END IF;

  -- The one writer that must work: the service role the route uses.
  RESET ROLE;
  SET LOCAL ROLE service_role;
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id, created_by)
  VALUES (v_account_id, 'inicio', 'month', 'P-INI-MONTH', 'I-SERVICE', v_admin_id);
  SELECT count(*) INTO v_rows
    FROM checkout_intents WHERE provider_subscription_id = 'I-SERVICE';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the service role could not record a checkout intent';
  END IF;
  DELETE FROM checkout_intents WHERE provider_subscription_id = 'I-SERVICE';

  -- Both rows survived every write attempt, unchanged.
  RESET ROLE;
  IF NOT EXISTS (
    SELECT 1 FROM checkout_intents
     WHERE provider_subscription_id = 'I-MINE'
       AND plan_id = 'pro' AND status = 'pending'
  ) THEN
    RAISE EXCEPTION 'the intent changed despite every tenant write being denied';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part B — one PayPal subscription belongs to exactly one intent.
--
-- The UNIQUE (provider, provider_subscription_id) is what turns a
-- replayed checkout into "read the row back" instead of a second row,
-- and what stops two accounts ever claiming the same payment.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_one_id     uuid := '00000000-0000-0000-0000-0000000f3211';
  v_two_id     uuid := '00000000-0000-0000-0000-0000000f3212';
  v_account_a  uuid;
  v_account_b  uuid;
  v_clashed    boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_one_id, 'authenticated', 'authenticated', 'checkout-uni-a@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_two_id, 'authenticated', 'authenticated', 'checkout-uni-b@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_a FROM profiles WHERE user_id = v_one_id;
  SELECT account_id INTO v_account_b FROM profiles WHERE user_id = v_two_id;

  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id)
  VALUES (v_account_a, 'pro', 'month', 'P-PRO-MONTH', 'I-SHARED');

  -- Same account, replayed request id: the second insert must clash so
  -- the route reads its own row back instead of duplicating it.
  v_clashed := false;
  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_account_a, 'pro', 'month', 'P-PRO-MONTH', 'I-SHARED');
  EXCEPTION WHEN unique_violation THEN v_clashed := true;
  END;
  IF NOT v_clashed THEN
    RAISE EXCEPTION 'a replayed PayPal subscription id created a second intent';
  END IF;

  -- Another account claiming the same PayPal subscription: same guard.
  v_clashed := false;
  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_account_b, 'negocio', 'year', 'P-NEG-YEAR', 'I-SHARED');
  EXCEPTION WHEN unique_violation THEN v_clashed := true;
  END;
  IF NOT v_clashed THEN
    RAISE EXCEPTION 'two accounts hold an intent for the same PayPal subscription';
  END IF;

  -- A different provider is a different namespace (the `provider`
  -- column exists so a card processor can be added later).
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider,
                                provider_plan_id, provider_subscription_id)
  VALUES (v_account_b, 'pro', 'month', 'stripe', 'price_x', 'I-SHARED');
END
$$;

ROLLBACK;

-- ============================================================
-- Part C — the record of a contracting attempt is not collateral of an
-- account delete (ON DELETE RESTRICT, like subscriptions in 041), and
-- a departing member does not erase it either (created_by SET NULL).
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner_id   uuid := '00000000-0000-0000-0000-0000000f3221';
  v_mate_id    uuid := '00000000-0000-0000-0000-0000000f3222';
  v_account_id uuid;
  v_blocked    boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'checkout-restrict@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_mate_id, 'authenticated', 'authenticated', 'checkout-mate@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_owner_id;
  UPDATE profiles
     SET account_id = v_account_id, account_role = 'admin'::account_role_enum
   WHERE user_id = v_mate_id;

  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id, created_by)
  VALUES (v_account_id, 'pro', 'month', 'P-PRO-MONTH', 'I-RESTRICT', v_mate_id);

  v_blocked := false;
  BEGIN
    DELETE FROM accounts WHERE id = v_account_id;
  EXCEPTION WHEN foreign_key_violation THEN v_blocked := true;
  END;
  IF NOT v_blocked THEN
    RAISE EXCEPTION 'deleting an account silently removed its checkout intents';
  END IF;

  -- The admin who clicked "contract" leaves: the audit row stays, its
  -- author goes to NULL. (Their empty personal account, created by the
  -- signup trigger, has to go first: `accounts.owner_user_id` points at
  -- them and is not part of what is being tested here.)
  DELETE FROM accounts WHERE owner_user_id = v_mate_id;
  DELETE FROM auth.users WHERE id = v_mate_id;
  IF NOT EXISTS (
    SELECT 1 FROM checkout_intents
     WHERE provider_subscription_id = 'I-RESTRICT' AND created_by IS NULL
  ) THEN
    RAISE EXCEPTION 'removing the member did not leave the intent with created_by NULL';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part D — the row cannot mean something the code never intends: a
-- cycle PayPal has no plan for, an invented status, or a default that
-- is anything other than "nothing has happened yet".
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user_id    uuid := '00000000-0000-0000-0000-0000000f3231';
  v_account_id uuid;
  v_rejected   boolean;
  v_status     text;
  v_provider   text;
  v_created    timestamptz;
  v_updated    timestamptz;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user_id, 'authenticated', 'authenticated', 'checkout-check@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_user_id;

  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id)
  VALUES (v_account_id, 'pro', 'month', 'P-PRO-MONTH', 'I-DEFAULTS')
  RETURNING status, provider, created_at, updated_at
       INTO v_status, v_provider, v_created, v_updated;

  IF v_status <> 'pending' THEN
    RAISE EXCEPTION 'a fresh intent must be pending, was %', v_status;
  END IF;
  IF v_provider <> 'paypal' THEN
    RAISE EXCEPTION 'the default provider must be paypal, was %', v_provider;
  END IF;

  -- Only the two cycles the catalogue has plans for.
  v_rejected := false;
  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_account_id, 'pro', 'week', 'P-PRO-WEEK', 'I-WEEKLY');
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'a weekly cycle was accepted; PayPal has no such plan';
  END IF;

  -- Only the three states the flow defines.
  v_rejected := false;
  BEGIN
    UPDATE checkout_intents SET status = 'paid'
     WHERE provider_subscription_id = 'I-DEFAULTS';
  EXCEPTION WHEN check_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'an unknown intent status was accepted';
  END IF;

  -- An unknown plan cannot be contracted (FK to the catalogue).
  v_rejected := false;
  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_account_id, 'enterprise', 'month', 'P-ENT', 'I-GHOST');
  EXCEPTION WHEN foreign_key_violation THEN v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'an intent was created for a plan that is not in the catalogue';
  END IF;

  -- The webhook of §3 will move the status; `updated_at` must follow.
  -- `now()` is frozen inside a transaction, so a plain "did it grow?"
  -- proves nothing here: we hand the UPDATE a stale timestamp instead
  -- and check the trigger overwrote it.
  UPDATE checkout_intents
     SET status = 'activated', updated_at = now() - interval '1 day'
   WHERE provider_subscription_id = 'I-DEFAULTS'
  RETURNING updated_at INTO v_updated;
  IF v_updated <> v_created THEN
    RAISE EXCEPTION
      'the updated_at trigger did not fire on the intent (kept %, transaction time is %)',
      v_updated, v_created;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part E — accepting an invitation still works with an abandoned
-- checkout behind you (migration 049).
--
-- Why it matters: the `ON DELETE RESTRICT` of Part C is the right
-- default, but `redeem_invitation()` (019) DELETEs the invitee's empty
-- personal account, and its "is it empty?" list cannot know about a
-- table added five migrations later. Without 049 the sequence
-- "click Choose plan → abandon PayPal → accept an invitation" ends in
-- a raw 23503 and the person can never join the team.
--
-- Two halves, and they must disagree:
--   * a `pending` intent is an abandoned approval — nothing charged —
--     so the invitation is accepted and the row goes with the account;
--   * an `activated` intent means a real subscription existed under
--     that account, so it counts as "your account already contains
--     data" (23505), exactly like contacts or broadcasts would.
-- The control (no intent at all) passes with or without 049, which is
-- what makes the first half a real detector.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_inviter_id uuid := '00000000-0000-0000-0000-0000000f3241';
  v_join1_id   uuid := '00000000-0000-0000-0000-0000000f3242';
  v_join2_id   uuid := '00000000-0000-0000-0000-0000000f3243';
  v_join3_id   uuid := '00000000-0000-0000-0000-0000000f3244';
  v_team_id    uuid;
  v_personal1  uuid;
  v_personal2  uuid;
  v_personal3  uuid;
  v_joined     uuid;
  v_refused    text;
  v_rows       integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_inviter_id, 'authenticated', 'authenticated', 'checkout-inviter@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_join1_id, 'authenticated', 'authenticated', 'checkout-join1@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_join2_id, 'authenticated', 'authenticated', 'checkout-join2@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_join3_id, 'authenticated', 'authenticated', 'checkout-join3@example.test',
          '{}'::jsonb, '{}'::jsonb);

  SELECT account_id INTO v_team_id   FROM profiles WHERE user_id = v_inviter_id;
  SELECT account_id INTO v_personal1 FROM profiles WHERE user_id = v_join1_id;
  SELECT account_id INTO v_personal2 FROM profiles WHERE user_id = v_join2_id;
  SELECT account_id INTO v_personal3 FROM profiles WHERE user_id = v_join3_id;
  IF v_team_id IS NULL OR v_personal2 IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the signup accounts';
  END IF;

  INSERT INTO account_invitations (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES (v_team_id, 'hash-e-control',  'agent', v_inviter_id, now() + interval '7 days'),
         (v_team_id, 'hash-e-pending',  'agent', v_inviter_id, now() + interval '7 days'),
         (v_team_id, 'hash-e-activated','agent', v_inviter_id, now() + interval '7 days');

  -- The two intents, written the way the route writes them (service
  -- role, account of the authenticated context).
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id, created_by, status)
  VALUES (v_personal2, 'pro', 'month', 'P-PRO-MONTH', 'I-ABANDONED', v_join2_id, 'pending'),
         (v_personal3, 'pro', 'year',  'P-PRO-YEAR',  'I-REAL',      v_join3_id, 'activated');

  -- ---- control: nothing behind you, the invitation is accepted ----
  PERFORM set_config('request.jwt.claim.sub', v_join1_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_join1_id)::text, true);
  SET LOCAL ROLE authenticated;
  v_joined := redeem_invitation('hash-e-control');
  RESET ROLE;
  IF v_joined IS DISTINCT FROM v_team_id THEN
    RAISE EXCEPTION 'the control redeem did not join the team (got %)', v_joined;
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_personal1) THEN
    RAISE EXCEPTION 'the control redeem left the personal account behind';
  END IF;

  -- ---- an abandoned checkout must not lock you out ----
  PERFORM set_config('request.jwt.claim.sub', v_join2_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_join2_id)::text, true);
  SET LOCAL ROLE authenticated;
  v_refused := NULL;
  BEGIN
    v_joined := redeem_invitation('hash-e-pending');
  EXCEPTION WHEN OTHERS THEN
    v_refused := SQLSTATE || ' ' || SQLERRM;
  END;
  RESET ROLE;
  IF v_refused IS NOT NULL THEN
    RAISE EXCEPTION
      'an abandoned checkout blocked the invitation: %', v_refused;
  END IF;
  IF v_joined IS DISTINCT FROM v_team_id THEN
    RAISE EXCEPTION 'the invitee with a pending intent did not join the team';
  END IF;
  -- The personal account and its worthless intent are gone; the
  -- invitation is stamped; the profile moved.
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_personal2) THEN
    RAISE EXCEPTION 'the empty personal account survived the redeem';
  END IF;
  SELECT count(*) INTO v_rows
    FROM checkout_intents WHERE provider_subscription_id = 'I-ABANDONED';
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'the abandoned intent outlived its account, % row(s) left', v_rows;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM account_invitations
     WHERE token_hash = 'hash-e-pending'
       AND accepted_at IS NOT NULL
       AND accepted_by_user_id = v_join2_id
  ) THEN
    RAISE EXCEPTION 'the invitation was not marked accepted';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM profiles WHERE user_id = v_join2_id AND account_id = v_team_id
  ) THEN
    RAISE EXCEPTION 'the invitee was not moved into the team account';
  END IF;

  -- ---- a real contract is data: the invitation is refused ----
  PERFORM set_config('request.jwt.claim.sub', v_join3_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_join3_id)::text, true);
  SET LOCAL ROLE authenticated;
  v_refused := NULL;
  BEGIN
    PERFORM redeem_invitation('hash-e-activated');
  EXCEPTION WHEN unique_violation THEN
    v_refused := SQLSTATE;
  END;
  RESET ROLE;
  IF v_refused IS NULL THEN
    RAISE EXCEPTION
      'an account with an activated checkout was dissolved by accepting an invitation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM accounts WHERE id = v_personal3) THEN
    RAISE EXCEPTION 'the refused redeem still deleted the account';
  END IF;
  IF EXISTS (
    SELECT 1 FROM account_invitations
     WHERE token_hash = 'hash-e-activated' AND accepted_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the refused invitation was marked accepted anyway';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM checkout_intents WHERE provider_subscription_id = 'I-REAL'
  ) THEN
    RAISE EXCEPTION 'the activated intent was deleted by a refused redeem';
  END IF;
END
$$;

ROLLBACK;
