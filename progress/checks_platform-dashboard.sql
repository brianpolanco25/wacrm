-- Behavioural acceptance checks for s9.2 platform-dashboard (migración 069).
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   docker exec -i "$C" psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_platform-dashboard.sql
--
-- Everything runs inside one transaction and rolls back. Any failed
-- assertion RAISEs and psql exits non-zero.
--
-- Seed: four users, whose personal accounts come from handle_new_user()
-- (017); the 046 trigger seeds a `pro`/`trialing` row that is then
-- overwritten:
--   A  active, paypal, cycle month, plan priced 100/month  -> +100 MRR
--   B  active, paypal, cycle year,  plan priced 1200/year  -> +100 MRR
--   C  active, manual (comped)                              -> 0 MRR, comped 1
--   D  past_due, paypal, cycle NULL (counts as month) on a plan whose
--      price is 0 -> +0 MRR, but a delinquent
-- Expected: MRR = 200, ARR = 2400, comped = 1, paying = 3 (A, B, D).
--
-- The baseline (whatever the replayed schema already holds) is read
-- first and subtracted, so the check does not depend on an empty base.

BEGIN;

-- Plans of our own, so the catalogue prices of 041/059/065 do not matter.
INSERT INTO plans (id, name, price_usd_month, price_usd_year, limits, features, is_public, sort_order)
VALUES
  ('chk_m100', 'check month 100', 100, NULL, '{}', '{}', false, 900),
  ('chk_y1200', 'check year 1200', 999, 1200, '{}', '{}', false, 901),
  ('chk_zero', 'check zero', 0, 0, '{}', '{}', false, 902)
ON CONFLICT (id) DO NOTHING;

CREATE TEMP TABLE baseline AS SELECT public.platform_metrics() AS m;
GRANT SELECT ON baseline TO service_role;

DO $$
DECLARE
  ua uuid := gen_random_uuid();
  ub uuid := gen_random_uuid();
  uc uuid := gen_random_uuid();
  ud uuid := gen_random_uuid();
BEGIN
  -- One account per owner (idx_accounts_one_per_owner): each user gets
  -- its personal account from handle_new_user() (017), and the 046
  -- trigger seeds a pro/trialing row that is overwritten below.
  INSERT INTO auth.users (id, email) VALUES
    (ua, 'chk-069-a@example.test'), (ub, 'chk-069-b@example.test'),
    (uc, 'chk-069-c@example.test'), (ud, 'chk-069-d@example.test');

  INSERT INTO subscriptions (account_id, plan_id, provider, status, cycle)
  SELECT a.id, v.plan_id, v.provider, v.status, v.cycle
  FROM (VALUES
    (ua, 'chk_m100',  'paypal', 'active',   'month'),
    (ub, 'chk_y1200', 'paypal', 'active',   'year'),
    (uc, 'chk_y1200', 'manual', 'active',   NULL),
    (ud, 'chk_zero',  'paypal', 'past_due', NULL)
  ) AS v(owner_id, plan_id, provider, status, cycle)
  JOIN accounts a ON a.owner_user_id = v.owner_id
  ON CONFLICT (account_id) DO UPDATE
    SET plan_id = EXCLUDED.plan_id,
        provider = EXCLUDED.provider,
        status = EXCLUDED.status,
        cycle = EXCLUDED.cycle;

  IF (SELECT count(*) FROM accounts a
      WHERE a.owner_user_id IN (ua, ub, uc, ud)) <> 4 THEN
    RAISE EXCEPTION 'handle_new_user() did not create the four accounts';
  END IF;
END
$$;

-- 1. The numbers, as service_role (the only role that may run it).
SET LOCAL ROLE service_role;
DO $$
DECLARE
  before jsonb := (SELECT m FROM baseline);
  after  jsonb := public.platform_metrics();
  d_mrr numeric := (after #>> '{revenue,mrr_usd}')::numeric
                 - (before #>> '{revenue,mrr_usd}')::numeric;
  d_arr numeric := (after #>> '{revenue,arr_usd}')::numeric
                 - (before #>> '{revenue,arr_usd}')::numeric;
  d_comped int := (after ->> 'comped')::int - (before ->> 'comped')::int;
  d_paying int := (after #>> '{revenue,paying_accounts}')::int
                - (before #>> '{revenue,paying_accounts}')::int;
  d_total int := (after #>> '{accounts,total}')::int
               - (before #>> '{accounts,total}')::int;
  d_past_due int := (after #>> '{delinquent,past_due}')::int
                  - (before #>> '{delinquent,past_due}')::int;
  d_signups7 int := (after #>> '{signups,last_7_days}')::int
                  - (before #>> '{signups,last_7_days}')::int;
  weekly jsonb := after #> '{signups,weekly}';
BEGIN
  IF d_mrr <> 200 THEN
    RAISE EXCEPTION 'MRR delta must be 200 (100 month + 1200/12), got %', d_mrr;
  END IF;
  IF d_arr <> 2400 THEN
    RAISE EXCEPTION 'ARR delta must be 2400, got %', d_arr;
  END IF;
  IF d_comped <> 1 THEN
    RAISE EXCEPTION 'comped delta must be 1, got %', d_comped;
  END IF;
  IF d_paying <> 3 THEN
    RAISE EXCEPTION 'paying delta must be 3 (A, B, D; not the comped C), got %', d_paying;
  END IF;
  IF d_total <> 4 THEN
    RAISE EXCEPTION 'accounts.total delta must be 4, got %', d_total;
  END IF;
  IF d_past_due <> 1 THEN
    RAISE EXCEPTION 'delinquent.past_due delta must be 1, got %', d_past_due;
  END IF;
  IF d_signups7 <> 4 THEN
    RAISE EXCEPTION 'signups.last_7_days delta must be 4, got %', d_signups7;
  END IF;
  IF jsonb_array_length(weekly) <> 12 THEN
    RAISE EXCEPTION 'weekly series must have 12 weeks, got %', jsonb_array_length(weekly);
  END IF;
  IF (weekly -> 11 ->> 'count')::int < 4 THEN
    RAISE EXCEPTION 'the current week must carry the 4 new accounts, got %', weekly -> 11;
  END IF;
  IF NOT (after #> '{accounts,by_status}') ? 'active' THEN
    RAISE EXCEPTION 'by_status must have an active key: %', after #> '{accounts,by_status}';
  END IF;
  RAISE NOTICE 'platform_metrics numbers: OK (%)', after -> 'revenue';
END
$$;
RESET ROLE;

-- 2. An account with no subscription row is counted as `none`.
DO $$
DECLARE
  ue uuid := gen_random_uuid();
  before int := coalesce((public.platform_metrics() #>> '{accounts,by_status,none}')::int, 0);
  after int;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (ue, 'chk-069-e@example.test');
  DELETE FROM subscriptions s
  USING accounts a
  WHERE a.owner_user_id = ue AND s.account_id = a.id;
  after := (public.platform_metrics() #>> '{accounts,by_status,none}')::int;
  IF after - before <> 1 THEN
    RAISE EXCEPTION 'an account without a subscription row must count as none (% -> %)', before, after;
  END IF;
  RAISE NOTICE 'by_status.none: OK';
END
$$;

-- 2b. WhatsApp connected, inbound messages and outbound counters of
--     the month (the outbound side reads usage_counters: messages_out +
--     broadcast_recipients, never ai_replies, which is already inside
--     messages_out when the reply is sent).
DO $$
DECLARE
  uw uuid := gen_random_uuid();
  acc uuid;
  ct uuid := gen_random_uuid();
  cv uuid := gen_random_uuid();
  before jsonb := public.platform_metrics();
  after jsonb;
BEGIN
  INSERT INTO auth.users (id, email) VALUES (uw, 'chk-069-w@example.test');
  SELECT id INTO acc FROM accounts WHERE owner_user_id = uw;

  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id, access_token, status)
  VALUES (uw, acc, 'chk-069-pn-1', 'x', 'connected'),
         (uw, acc, 'chk-069-pn-2', 'x', 'disconnected');

  INSERT INTO contacts (id, user_id, account_id, phone)
  VALUES (ct, uw, acc, '+15550690000');
  INSERT INTO conversations (id, user_id, account_id, contact_id)
  VALUES (cv, uw, acc, ct);
  INSERT INTO messages (conversation_id, sender_type, content_text, created_at)
  VALUES (cv, 'customer', 'in 1', now()),
         (cv, 'customer', 'in 2', now()),
         (cv, 'agent',    'out',  now()),
         -- Last month: outside the period.
         (cv, 'customer', 'old',  date_trunc('month', now()) - interval '1 day');

  INSERT INTO usage_counters (account_id, metric, period_start, value) VALUES
    (acc, 'messages_out', date_trunc('month', now())::date, 5),
    (acc, 'broadcast_recipients', date_trunc('month', now())::date, 3),
    (acc, 'ai_replies', date_trunc('month', now())::date, 7),
    (acc, 'messages_out', (date_trunc('month', now()) - interval '1 month')::date, 100);

  after := public.platform_metrics();
  IF (after #>> '{whatsapp,connected}')::int - (before #>> '{whatsapp,connected}')::int <> 1 THEN
    RAISE EXCEPTION 'whatsapp.connected delta must be 1';
  END IF;
  IF (after #>> '{messages_month,inbound}')::int - (before #>> '{messages_month,inbound}')::int <> 2 THEN
    RAISE EXCEPTION 'messages_month.inbound delta must be 2, got %',
      (after #>> '{messages_month,inbound}')::int - (before #>> '{messages_month,inbound}')::int;
  END IF;
  IF (after #>> '{messages_month,outbound}')::int - (before #>> '{messages_month,outbound}')::int <> 8 THEN
    RAISE EXCEPTION 'messages_month.outbound delta must be 8, got %',
      (after #>> '{messages_month,outbound}')::int - (before #>> '{messages_month,outbound}')::int;
  END IF;
  RAISE NOTICE 'whatsapp + messages of the month: OK';
END
$$;

-- 3. authenticated (and anon) cannot execute it.
SET LOCAL ROLE authenticated;
DO $$
BEGIN
  PERFORM public.platform_metrics();
  RAISE EXCEPTION 'authenticated was able to run platform_metrics()';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'authenticated denied: OK';
END
$$;
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM public.platform_metrics();
  RAISE EXCEPTION 'anon was able to run platform_metrics()';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'anon denied: OK';
END
$$;
RESET ROLE;

ROLLBACK;
