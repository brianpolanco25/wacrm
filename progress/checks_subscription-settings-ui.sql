-- Behavioural acceptance checks for f3.5 subscription-settings-ui (fase 3, §6).
--
-- Two acceptance criteria of the phase are graded here, because neither can
-- be proved in TypeScript:
--
--   «Un usuario autenticado no puede modificar su propia suscripción ni sus
--    contadores, comprobado contra la RLS.»
--   «El consumo mostrado coincide con `usage_counters`.»
--
-- The first overlaps on purpose with part C of `checks_paypal-webhook.sql`
-- (which proves a tenant cannot rewrite `subscriptions`) and with part G of
-- `checks_enforce-limits.sql`. This file does not repeat those: it adds the
-- angles §6 introduces — the read side (who may SEE the counters the panel
-- prints), the write side of `usage_counters` specifically, and the fact
-- that what the panel reads is byte for byte what `increment_usage` wrote,
-- on the same period anchor the enforcement layer uses.
--
-- Plus migration 056: the cycle column that keeps a plan change from
-- renewing on the wrong period, and the partial index the receipts query
-- needs.
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   C=<container>
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_subscription-settings-ui.sql
--
-- Every assertion RAISEs on failure, so a silent run (BEGIN/DO/ROLLBACK …)
-- is a passing run. Nothing is left behind: each part rolls back.

-- ============================================================
-- Part A — who may read the consumption, and who may write it.
--
-- Why it matters: the panel of §6 prints `usage_counters` to admins. The
-- policy of 041 is `is_account_member(account_id, 'admin')`, so an agent
-- must see nothing — and NOBODY authenticated may write, or a tenant
-- would reset its own meter to zero the moment a quota bit.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_admin_id   uuid := '00000000-0000-0000-0000-0000000f3501';
  v_agent_id   uuid := '00000000-0000-0000-0000-0000000f3502';
  v_other_id   uuid := '00000000-0000-0000-0000-0000000f3503';
  v_account_id uuid;
  v_foreign_id uuid;
  v_period     date := date_trunc('month', now())::date;
  v_rows       integer;
  v_value      bigint;
  v_denied     boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_admin_id, 'authenticated', 'authenticated', 'sub-admin@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_agent_id, 'authenticated', 'authenticated', 'sub-agent@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_other_id, 'authenticated', 'authenticated', 'sub-other@example.test',
          '{}'::jsonb, '{}'::jsonb);

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_admin_id;
  SELECT account_id INTO v_foreign_id FROM profiles WHERE user_id = v_other_id;
  IF v_account_id IS NULL OR v_foreign_id IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the two accounts';
  END IF;

  -- The agent joins the admin's account, as `redeem_invitation` would
  -- leave them.
  UPDATE profiles SET account_id = v_account_id, account_role = 'agent'
   WHERE user_id = v_agent_id;
  UPDATE profiles SET account_role = 'admin' WHERE user_id = v_admin_id;

  -- Counters written the only way they are ever written: the atomic RPC
  -- of migration 041, under the service role.
  PERFORM increment_usage(v_account_id, 'messages_out', 2731);
  PERFORM increment_usage(v_account_id, 'ai_replies', 12);
  PERFORM increment_usage(v_foreign_id, 'messages_out', 55555);

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id)::text, true);
  SET LOCAL ROLE authenticated;

  -- The admin sees its own consumption…
  SELECT count(*) INTO v_rows
    FROM usage_counters WHERE account_id = v_account_id AND period_start = v_period;
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'an admin must read its own counters, saw % rows', v_rows;
  END IF;

  -- …and NONE of another account's. This is the leak the panel would
  -- become if the route ever dropped its account filter.
  SELECT count(*) INTO v_rows
    FROM usage_counters WHERE account_id = v_foreign_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % usage counter(s) of another account', v_rows;
  END IF;

  -- Cannot zero its own meter.
  UPDATE usage_counters SET value = 0 WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant reset % of its own usage counters', v_rows;
  END IF;

  DELETE FROM usage_counters WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant deleted % of its own usage counters', v_rows;
  END IF;

  -- Nor invent a row for a metric it has not used (there is no INSERT
  -- policy at all, so this is a hard privilege error).
  v_denied := false;
  BEGIN
    INSERT INTO usage_counters (account_id, metric, period_start, value)
    VALUES (v_account_id, 'messages_out', v_period + 1, 0);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'a tenant inserted its own usage counter row';
  END IF;

  -- Nor write its own subscription. (`checks_paypal-webhook.sql` part C
  -- covers plan and watermark; §6 adds the two fields ITS actions touch:
  -- a tenant that could set `cancel_at_period_end` or `cycle` by hand
  -- would cancel without telling PayPal, or make a monthly plan renew
  -- by a year.)
  RESET ROLE;
  INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id,
                             status, current_period_end, cycle)
  VALUES (v_account_id, 'inicio', 'paypal', 'I-F35-A', 'active',
          now() + interval '30 days', 'month')
  ON CONFLICT (account_id) DO UPDATE
    SET provider_subscription_id = EXCLUDED.provider_subscription_id,
        status = EXCLUDED.status,
        current_period_end = EXCLUDED.current_period_end,
        cycle = EXCLUDED.cycle;

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id)::text, true);
  SET LOCAL ROLE authenticated;

  UPDATE subscriptions SET cancel_at_period_end = true WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant cancelled its own subscription without telling the provider';
  END IF;

  UPDATE subscriptions SET cycle = 'year' WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant rewrote its own billing cycle — a month plan would renew by a year';
  END IF;

  -- The agent: a member of the SAME account, and still no consumption.
  RESET ROLE;
  PERFORM set_config('request.jwt.claim.sub', v_agent_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_agent_id)::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_rows FROM usage_counters WHERE account_id = v_account_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'an agent read % usage counter(s) — billing data is admin+', v_rows;
  END IF;

  -- …but it CAN see the subscription row (041 makes that member-wide);
  -- the admin-only gate of §6 is the route's, not this policy's.
  SELECT count(*) INTO v_rows FROM subscriptions WHERE account_id = v_account_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'a member must be able to read the subscription row, saw %', v_rows;
  END IF;

  -- The event log stays invisible: its payloads carry other tenants'
  -- data, which is why the receipts of §6 are served by the route and
  -- never read from the browser.
  RESET ROLE;
  INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
  VALUES ('paypal', 'WH-F35-SECRET', 'PAYMENT.SALE.COMPLETED',
          jsonb_build_object('resource', jsonb_build_object(
            'id', 'TX-1', 'billing_agreement_id', 'I-F35-A',
            'amount', jsonb_build_object('total', '79.00', 'currency', 'USD'))));

  PERFORM set_config('request.jwt.claim.sub', v_admin_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_admin_id)::text, true);
  SET LOCAL ROLE authenticated;

  SELECT count(*) INTO v_rows FROM billing_events;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % billing event(s) directly', v_rows;
  END IF;

  RESET ROLE;

  -- The consumption the panel prints IS what the RPC wrote, on the same
  -- period anchor the enforcement layer checks against.
  SELECT value INTO v_value
    FROM usage_counters
   WHERE account_id = v_account_id AND metric = 'messages_out'
     AND period_start = v_period;
  IF v_value <> 2731 THEN
    RAISE EXCEPTION 'the counter the panel reads says %, the RPC wrote 2731', v_value;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part B — the period the panel shows is the period the limits use.
--
-- Why it matters: `currentPeriodStart()` in TypeScript builds
-- `YYYY-MM-01` in UTC and the route filters `usage_counters` by it.
-- `increment_usage` anchors on `date_trunc('month', now())::date`. If the
-- two ever disagreed, the panel would show a different number from the
-- one that blocks the send — and the acceptance criterion would be false
-- while every unit test passed.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user_id    uuid := '00000000-0000-0000-0000-0000000f3511';
  v_account_id uuid;
  v_ts_anchor  date;
  v_utc_anchor date;
  v_rows       integer;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user_id, 'authenticated', 'authenticated', 'sub-period@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_user_id;

  PERFORM increment_usage(v_account_id, 'messages_out', 5);

  SELECT period_start INTO v_ts_anchor
    FROM usage_counters WHERE account_id = v_account_id AND metric = 'messages_out';

  -- What the TypeScript helper computes, spelled out in SQL.
  v_utc_anchor := (to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM') || '-01')::date;

  IF v_ts_anchor <> v_utc_anchor THEN
    RAISE EXCEPTION
      'increment_usage anchors the period at % but the panel asks for % — the consumption shown would not be the consumption enforced',
      v_ts_anchor, v_utc_anchor;
  END IF;

  -- A second increment lands on the SAME row: the panel shows one line
  -- per metric, not one per call.
  PERFORM increment_usage(v_account_id, 'messages_out', 7);
  SELECT count(*) INTO v_rows
    FROM usage_counters WHERE account_id = v_account_id AND metric = 'messages_out';
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'expected one counter row per metric and period, saw %', v_rows;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part C — migration 056: the billing cycle.
--
-- Why it matters: changing plan in §6 revises the SAME PayPal
-- subscription, so `checkout_intents.cycle` keeps saying what was
-- contracted originally. Without this column a customer who moves from
-- monthly to yearly pays for a year and has their period extended by a
-- month.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user_id    uuid := '00000000-0000-0000-0000-0000000f3521';
  v_account_id uuid;
  v_cycle      text;
  v_nullable   text;
  v_rejected   boolean;
BEGIN
  SELECT is_nullable INTO v_nullable
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions'
     AND column_name = 'cycle';
  IF v_nullable IS DISTINCT FROM 'YES' THEN
    RAISE EXCEPTION
      'subscriptions.cycle must be nullable — NULL is "not known yet" and falls back to the intent (got %)',
      coalesce(v_nullable, '<missing>');
  END IF;

  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user_id, 'authenticated', 'authenticated', 'sub-cycle@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_user_id;

  INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id,
                             status, cycle)
  VALUES (v_account_id, 'pro', 'paypal', 'I-F35-CYCLE', 'active', 'year')
  ON CONFLICT (account_id) DO UPDATE
    SET provider_subscription_id = EXCLUDED.provider_subscription_id,
        status = EXCLUDED.status, cycle = EXCLUDED.cycle;

  -- A cycle we do not sell cannot get in: the renewal handler would not
  -- know how far to move the period.
  v_rejected := false;
  BEGIN
    UPDATE subscriptions SET cycle = 'week' WHERE account_id = v_account_id;
  EXCEPTION WHEN check_violation THEN
    v_rejected := true;
  END;
  IF NOT v_rejected THEN
    RAISE EXCEPTION 'subscriptions.cycle accepted ''week'' — the CHECK of migration 056 is missing';
  END IF;

  SELECT cycle INTO v_cycle FROM subscriptions WHERE account_id = v_account_id;
  IF v_cycle <> 'year' THEN
    RAISE EXCEPTION 'expected the cycle to stay ''year'', got %', v_cycle;
  END IF;

  -- The backfill statement of 056, replayed: an older row with no cycle
  -- picks it up from the intent that created the subscription, and a row
  -- that already has one is left alone.
  UPDATE subscriptions SET cycle = NULL WHERE account_id = v_account_id;
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider,
                                provider_plan_id, provider_subscription_id, status)
  VALUES (v_account_id, 'pro', 'month', 'paypal', 'P-PRO-MONTH', 'I-F35-CYCLE', 'activated');

  UPDATE subscriptions s
     SET cycle = ci.cycle
    FROM checkout_intents ci
   WHERE s.cycle IS NULL
     AND s.provider_subscription_id IS NOT NULL
     AND ci.provider = s.provider
     AND ci.provider_subscription_id = s.provider_subscription_id
     AND ci.cycle IN ('month', 'year');

  SELECT cycle INTO v_cycle FROM subscriptions WHERE account_id = v_account_id;
  IF v_cycle <> 'month' THEN
    RAISE EXCEPTION 'the 056 backfill did not take the cycle from the checkout intent (got %)',
      coalesce(v_cycle, '<null>');
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part D — migration 056: the receipts index is real and usable.
--
-- Why it matters: `billing_events` is the provider's GLOBAL log — it has
-- no `account_id`. The receipts of §6 are found by the
-- `billing_agreement_id` buried in the payload. Without the expression
-- index, painting one customer's settings page is a sequential scan over
-- every customer's payment history, on a table that grows with every
-- renewal of every account.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_def  text;
  v_rows integer;
BEGIN
  SELECT indexdef INTO v_def
    FROM pg_indexes
   WHERE schemaname = 'public' AND indexname = 'billing_events_sale_subscription_idx';
  IF v_def IS NULL THEN
    RAISE EXCEPTION 'billing_events_sale_subscription_idx does not exist (migration 056)';
  END IF;
  IF v_def NOT LIKE '%billing_agreement_id%' THEN
    RAISE EXCEPTION 'the receipts index is not on the billing agreement id: %', v_def;
  END IF;
  IF v_def NOT LIKE '%WHERE%PAYMENT.SALE.COMPLETED%' THEN
    RAISE EXCEPTION 'the receipts index is not partial — it would carry the whole event log: %', v_def;
  END IF;

  -- And the expression the route filters on really selects the sale.
  INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
  VALUES ('paypal', 'WH-F35-SALE-1', 'PAYMENT.SALE.COMPLETED',
          jsonb_build_object('resource', jsonb_build_object(
            'id', 'TX-1', 'billing_agreement_id', 'I-MINE',
            'amount', jsonb_build_object('total', '79.00', 'currency', 'USD')))),
         ('paypal', 'WH-F35-SALE-2', 'PAYMENT.SALE.COMPLETED',
          jsonb_build_object('resource', jsonb_build_object(
            'id', 'TX-2', 'billing_agreement_id', 'I-SOMEONE-ELSE',
            'amount', jsonb_build_object('total', '1990.00', 'currency', 'USD')))),
         ('paypal', 'WH-F35-ACT', 'BILLING.SUBSCRIPTION.ACTIVATED',
          jsonb_build_object('resource', jsonb_build_object('id', 'I-MINE')));

  SELECT count(*) INTO v_rows
    FROM billing_events
   WHERE event_type = 'PAYMENT.SALE.COMPLETED'
     AND payload -> 'resource' ->> 'billing_agreement_id' = ANY (ARRAY['I-MINE']);
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the receipts filter returned % rows, expected exactly the one sale of I-MINE', v_rows;
  END IF;
END
$$;

ROLLBACK;
