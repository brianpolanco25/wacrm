-- Behavioural acceptance checks for f3.3 paypal-webhook (fase 3, §3).
--
-- Everything the route relies on that TypeScript cannot prove: the UNIQUE
-- that makes the idempotency lock real (migration 041), the watermark
-- column and the reconciliation index of migration 050, the RLS that stops
-- a tenant writing its own subscription or reading the event log, and the
-- uniqueness that stops two accounts claiming the same PayPal subscription.
--
-- Run after `KEEP=1 scripts/replay-migrations.sh <worktree>` against the
-- container it reports:
--
--   C=<container>
--   docker exec -i "$C" psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_paypal-webhook.sql
--
-- Every assertion RAISEs on failure, so a silent run (BEGIN/DO/ROLLBACK …)
-- is a passing run. Nothing is left behind: each part rolls back.

-- ============================================================
-- Part A — the idempotency lock is the database's, not the code's.
--
-- Why it matters: the route inserts into `billing_events` BEFORE doing
-- anything, and treats 23505 as "already taken". If that UNIQUE were
-- missing, two concurrent deliveries of the same PayPal event would both
-- pass the insert and both extend the customer's paid period.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_code text;
  v_rows integer;
BEGIN
  INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
  VALUES ('paypal', 'WH-DUP', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id":"WH-DUP"}'::jsonb);

  BEGIN
    INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
    VALUES ('paypal', 'WH-DUP', 'BILLING.SUBSCRIPTION.ACTIVATED', '{"id":"WH-DUP"}'::jsonb);
    RAISE EXCEPTION 'a replayed PayPal event was stored twice — the idempotency lock does not exist';
  EXCEPTION WHEN unique_violation THEN
    GET STACKED DIAGNOSTICS v_code = RETURNED_SQLSTATE;
    IF v_code <> '23505' THEN
      RAISE EXCEPTION 'expected 23505 on a replayed event, got %', v_code;
    END IF;
  END;

  -- A different provider is a different namespace: the day a card
  -- processor is added, its event ids must not collide with PayPal's.
  INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
  VALUES ('stripe', 'WH-DUP', 'whatever', '{}'::jsonb);

  SELECT count(*) INTO v_rows FROM billing_events WHERE provider_event_id = 'WH-DUP';
  IF v_rows <> 2 THEN
    RAISE EXCEPTION 'expected one event per provider, saw %', v_rows;
  END IF;

  -- The reconciliation queue of migration 050: verified events that
  -- could not be applied keep processed_at NULL and carry their reason.
  UPDATE billing_events SET error = 'no account owns PayPal subscription I-GHOST'
   WHERE provider = 'paypal' AND provider_event_id = 'WH-DUP';

  SELECT count(*) INTO v_rows
    FROM billing_events
   WHERE processed_at IS NULL AND error IS NOT NULL;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'the reconciliation query returned % rows, expected 1', v_rows;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part B — migration 050 is really there and means what the code thinks.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_type text;
  v_pred text;
BEGIN
  SELECT data_type INTO v_type
    FROM information_schema.columns
   WHERE table_schema = 'public' AND table_name = 'subscriptions'
     AND column_name = 'last_event_at';
  IF v_type IS DISTINCT FROM 'timestamp with time zone' THEN
    RAISE EXCEPTION 'subscriptions.last_event_at is missing or not timestamptz (got %)', v_type;
  END IF;

  -- It must be nullable: an account that has never had an event applied
  -- has no watermark, and "no watermark" must not read as "epoch".
  IF (SELECT is_nullable FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'subscriptions'
         AND column_name = 'last_event_at') <> 'YES' THEN
    RAISE EXCEPTION 'subscriptions.last_event_at must be nullable';
  END IF;

  SELECT pg_get_expr(i.indpred, i.indrelid) INTO v_pred
    FROM pg_index i
   WHERE i.indexrelid = 'public.billing_events_unprocessed_idx'::regclass;
  IF v_pred IS NULL OR v_pred NOT LIKE '%processed_at IS NULL%' THEN
    RAISE EXCEPTION 'billing_events_unprocessed_idx is not the partial index of migration 050 (predicate: %)', v_pred;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- Part C — a tenant cannot write its own subscription, and cannot see
-- the event log at all.
--
-- Why it matters: the webhook is the ONLY writer of `subscriptions`.
-- A tenant that could UPDATE its own row would grant itself the Negocio
-- plan; one that could read `billing_events` would see another
-- customer's payment payloads, `custom_id` included.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_owner_id   uuid := '00000000-0000-0000-0000-0000000f3301';
  v_other_id   uuid := '00000000-0000-0000-0000-0000000f3302';
  v_account_id uuid;
  v_foreign_id uuid;
  v_rows       integer;
  v_denied     boolean;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_owner_id, 'authenticated', 'authenticated', 'webhook-owner@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_other_id, 'authenticated', 'authenticated', 'webhook-other@example.test',
          '{}'::jsonb, '{}'::jsonb);

  SELECT account_id INTO v_account_id FROM profiles WHERE user_id = v_owner_id;
  SELECT account_id INTO v_foreign_id FROM profiles WHERE user_id = v_other_id;
  IF v_account_id IS NULL OR v_foreign_id IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the two accounts';
  END IF;

  -- Seeded the way the webhook does it: service role.
  INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id,
                             status, current_period_end, last_event_at)
  VALUES (v_account_id, 'inicio', 'paypal', 'I-OWNER', 'active',
          now() + interval '30 days', now()),
         (v_foreign_id, 'inicio', 'paypal', 'I-OTHER', 'active',
          now() + interval '30 days', now());

  INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
  VALUES ('paypal', 'WH-SECRET', 'BILLING.SUBSCRIPTION.ACTIVATED',
          jsonb_build_object('resource', jsonb_build_object('custom_id', v_foreign_id)));

  PERFORM set_config('request.jwt.claim.sub', v_owner_id::text, true);
  PERFORM set_config('request.jwt.claims', json_build_object('sub', v_owner_id)::text, true);
  SET LOCAL ROLE authenticated;

  -- Reads its own subscription (the settings page of §6 needs this).
  SELECT count(*) INTO v_rows FROM subscriptions WHERE account_id = v_account_id;
  IF v_rows <> 1 THEN
    RAISE EXCEPTION 'a member must read its own subscription, saw % rows', v_rows;
  END IF;
  SELECT count(*) INTO v_rows FROM subscriptions WHERE account_id = v_foreign_id;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % subscription(s) of another account', v_rows;
  END IF;

  -- Cannot upgrade itself.
  UPDATE subscriptions SET plan_id = 'negocio', status = 'active'
   WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant updated its own subscription (% rows) — it could grant itself any plan', v_rows;
  END IF;

  -- Cannot move its own watermark either: doing so would let it replay
  -- a favourable event, or freeze out every future one.
  UPDATE subscriptions SET last_event_at = 'infinity'
   WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant moved its own last_event_at watermark';
  END IF;

  UPDATE subscriptions SET status = 'cancelled' WHERE account_id = v_foreign_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant cancelled another account''s subscription';
  END IF;

  DELETE FROM subscriptions WHERE account_id = v_account_id;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant deleted its own subscription row';
  END IF;

  v_denied := false;
  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, status)
    VALUES (v_account_id, 'negocio', 'active');
  EXCEPTION WHEN insufficient_privilege OR unique_violation THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'a tenant inserted a subscription row';
  END IF;

  -- `billing_events` has RLS on and no policies at all (041).
  SELECT count(*) INTO v_rows FROM billing_events;
  IF v_rows <> 0 THEN
    RAISE EXCEPTION 'a tenant read % billing event(s) — the payloads carry other tenants'' data', v_rows;
  END IF;

  v_denied := false;
  BEGIN
    INSERT INTO billing_events (provider, provider_event_id, event_type, payload)
    VALUES ('paypal', 'WH-FORGED', 'BILLING.SUBSCRIPTION.ACTIVATED', '{}'::jsonb);
  EXCEPTION WHEN insufficient_privilege THEN
    v_denied := true;
  END;
  IF NOT v_denied THEN
    RAISE EXCEPTION 'a tenant inserted a billing event — it could poison the idempotency lock';
  END IF;

  RESET ROLE;
END
$$;

ROLLBACK;

-- ============================================================
-- Part D — one PayPal subscription belongs to exactly one account.
--
-- Why it matters: the webhook resolves the tenant from the PayPal
-- subscription id. If two accounts could hold the same id, that lookup
-- would be a coin flip between two customers' money.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user_a uuid := '00000000-0000-0000-0000-0000000f3311';
  v_user_b uuid := '00000000-0000-0000-0000-0000000f3312';
  v_a uuid;
  v_b uuid;
BEGIN
  -- `accounts.owner_user_id` is NOT NULL and the signup trigger creates
  -- the personal account, so the two tenants come from two real users.
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user_a, 'authenticated', 'authenticated', 'webhook-uniq-a@example.test',
          '{}'::jsonb, '{}'::jsonb),
         (v_user_b, 'authenticated', 'authenticated', 'webhook-uniq-b@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_a FROM profiles WHERE user_id = v_user_a;
  SELECT account_id INTO v_b FROM profiles WHERE user_id = v_user_b;
  IF v_a IS NULL OR v_b IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the two accounts';
  END IF;

  INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id, status)
  VALUES (v_a, 'pro', 'paypal', 'I-SHARED', 'active');

  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id, status)
    VALUES (v_b, 'pro', 'paypal', 'I-SHARED', 'active');
    RAISE EXCEPTION 'two accounts claimed the same PayPal subscription';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;

  -- And the same on `checkout_intents` (048), which is the other half of
  -- the resolution.
  INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                provider_subscription_id)
  VALUES (v_a, 'pro', 'month', 'P-PRO-MONTH', 'I-SHARED2');

  BEGIN
    INSERT INTO checkout_intents (account_id, plan_id, cycle, provider_plan_id,
                                  provider_subscription_id)
    VALUES (v_b, 'pro', 'month', 'P-PRO-MONTH', 'I-SHARED2');
    RAISE EXCEPTION 'two accounts claimed the same PayPal subscription intent';
  EXCEPTION WHEN unique_violation THEN
    NULL;
  END;
END
$$;

ROLLBACK;

-- ============================================================
-- Part E — the writes the webhook actually performs land, and the
-- statuses it writes are all accepted by the CHECK of 041.
--
-- Why it matters: `status` is constrained to six values. A handler that
-- wrote 'past_due' against a CHECK that only knew 'pastdue' would fail
-- at 3am on a renewal, not in CI.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user    uuid := '00000000-0000-0000-0000-0000000f3321';
  v_acc     uuid;
  v_status  text;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user, 'authenticated', 'authenticated', 'webhook-writes@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_acc FROM profiles WHERE user_id = v_user;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the account';
  END IF;
  -- The signup trigger already left a `trialing` subscription behind on
  -- some paths; start from a clean slate for this account.
  DELETE FROM subscriptions WHERE account_id = v_acc;

  -- ACTIVATED
  INSERT INTO subscriptions (account_id, plan_id, provider, provider_subscription_id,
                             status, current_period_end, grace_until,
                             cancel_at_period_end, last_event_at)
  VALUES (v_acc, 'pro', 'paypal', 'I-W', 'active',
          '2026-04-15T12:00:00Z', NULL, false, '2026-03-15T12:00:00Z');

  -- Every status the handlers write.
  FOREACH v_status IN ARRAY ARRAY['active','past_due','suspended','cancelled','expired']
  LOOP
    UPDATE subscriptions SET status = v_status WHERE account_id = v_acc;
  END LOOP;

  -- PAYMENT.FAILED
  UPDATE subscriptions
     SET status = 'past_due',
         grace_until = timestamptz '2026-03-20T00:00:00Z' + interval '7 days',
         last_event_at = '2026-03-20T00:00:00Z'
   WHERE account_id = v_acc;

  -- UPDATED: the quantity lands in `addons` without losing what was there.
  UPDATE subscriptions SET addons = '{"extra_numbers":1}'::jsonb WHERE account_id = v_acc;
  UPDATE subscriptions
     SET addons = addons || '{"paypal_quantity":2}'::jsonb
   WHERE account_id = v_acc;

  IF (SELECT addons FROM subscriptions WHERE account_id = v_acc)
     <> '{"extra_numbers":1,"paypal_quantity":2}'::jsonb THEN
    RAISE EXCEPTION 'the addons merge lost a key';
  END IF;

  -- `updated_at` is maintained by a trigger, not by the route. It cannot
  -- be observed moving inside one transaction (the trigger writes
  -- `now()`, which is the transaction timestamp), so assert the trigger
  -- is wired instead.
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.subscriptions'::regclass
       AND tgname = 'set_updated_at'
       AND NOT tgisinternal
  ) THEN
    RAISE EXCEPTION 'subscriptions has no set_updated_at trigger — a webhook write would not touch updated_at';
  END IF;

  -- And a status the handlers must never invent is refused.
  BEGIN
    UPDATE subscriptions SET status = 'paused' WHERE account_id = v_acc;
    RAISE EXCEPTION 'the status CHECK of 041 accepted an invented status';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

ROLLBACK;

-- ============================================================
-- F. Re-contratar tras cancelar (corrección del hallazgo 1) y el
--    contraste de `provider_plan_id` (hallazgo 8).
--
-- Lo que se comprueba contra el esquema real, no contra el mock:
--   * un intento nuevo sobre OTRA suscripción del proveedor convive
--     con la fila de suscripción que quedó de la anterior;
--   * adoptar esa fila (mover `provider_subscription_id` a la nueva)
--     no choca con el UNIQUE de 041;
--   * `checkout_intents.provider_plan_id` existe y es NOT NULL, así
--     que el contraste del `ACTIVATED` siempre tiene con qué comparar.
-- ============================================================

BEGIN;

DO $$
DECLARE
  v_user uuid := '00000000-0000-0000-0000-0000000f3313';
  v_acc uuid;
BEGIN
  -- Misma vía que las partes anteriores: la cuenta la crea el trigger
  -- de alta a partir de un usuario real.
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data, raw_user_meta_data)
  VALUES (v_user, 'authenticated', 'authenticated', 'webhook-recontrata@example.test',
          '{}'::jsonb, '{}'::jsonb);
  SELECT account_id INTO v_acc FROM profiles WHERE user_id = v_user;
  IF v_acc IS NULL THEN
    RAISE EXCEPTION 'test setup did not create the account';
  END IF;

  -- 1. Primera contratación, suscripción I-1, y su cancelación.
  INSERT INTO checkout_intents
    (account_id, plan_id, cycle, provider, provider_plan_id, provider_subscription_id, status)
  VALUES (v_acc, 'pro', 'month', 'paypal', 'P-PRO-MONTH', 'I-1', 'cancelled');

  INSERT INTO subscriptions
    (account_id, plan_id, status, provider, provider_subscription_id,
     current_period_end, cancel_at_period_end, last_event_at)
  VALUES (v_acc, 'pro', 'cancelled', 'paypal', 'I-1',
          '2026-02-15T12:00:00Z', true, '2026-02-20T00:00:00Z');

  -- 2. Vuelve a contratar: §2 escribe un segundo intento, I-2. El UNIQUE
  --    de `checkout_intents` es por suscripción del proveedor, no por
  --    cuenta: si lo fuera, nadie podría recontratar nunca.
  INSERT INTO checkout_intents
    (account_id, plan_id, cycle, provider, provider_plan_id, provider_subscription_id, status)
  VALUES (v_acc, 'pro', 'month', 'paypal', 'P-PRO-MONTH', 'I-2', 'pending');

  IF (SELECT count(*) FROM checkout_intents WHERE account_id = v_acc) <> 2 THEN
    RAISE EXCEPTION 'an account cannot record a second checkout attempt — re-contracting would be impossible';
  END IF;

  -- 3. El ACTIVATED de I-2 adopta la fila. Es un UPDATE acotado por
  --    cuenta, exactamente el que hace la ruta.
  UPDATE subscriptions
     SET status = 'active',
         provider_subscription_id = 'I-2',
         current_period_end = '2026-04-19T00:00:00Z',
         cancel_at_period_end = false,
         grace_until = NULL,
         last_event_at = '2026-03-19T00:00:00Z'
   WHERE account_id = v_acc;

  IF NOT EXISTS (
    SELECT 1 FROM subscriptions
     WHERE account_id = v_acc
       AND status = 'active'
       AND provider_subscription_id = 'I-2'
       AND cancel_at_period_end = false
       AND grace_until IS NULL
  ) THEN
    RAISE EXCEPTION 'the customer who contracted again is not being served';
  END IF;

  IF (SELECT count(*) FROM subscriptions WHERE account_id = v_acc) <> 1 THEN
    RAISE EXCEPTION 'adopting the row left a second subscription for the account';
  END IF;

  -- 4. `provider_plan_id` del intento: el contraste del ACTIVATED lo
  --    necesita presente en toda fila.
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_name = 'checkout_intents'
       AND column_name = 'provider_plan_id'
       AND data_type = 'text'
       AND is_nullable = 'NO'
  ) THEN
    RAISE EXCEPTION 'checkout_intents.provider_plan_id is missing or nullable — the activation could not be contrasted';
  END IF;

  -- 5. Una fila de evento con motivo y sin procesar es la cola de
  --    reconciliación de la que ahora se sale con un reenvío.
  INSERT INTO billing_events (provider, provider_event_id, event_type, payload, error)
  VALUES ('paypal', 'WH-UNMATCHED', 'BILLING.SUBSCRIPTION.ACTIVATED', '{}'::jsonb,
          'no account owns PayPal subscription I-9');

  IF NOT EXISTS (
    SELECT 1 FROM billing_events
     WHERE provider_event_id = 'WH-UNMATCHED'
       AND processed_at IS NULL AND error IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'an unapplied event is not visible in the reconciliation queue';
  END IF;

  -- El reenvío la cierra en sitio, sin borrar nada a mano.
  UPDATE billing_events
     SET processed_at = now(), error = NULL
   WHERE provider = 'paypal' AND provider_event_id = 'WH-UNMATCHED';

  IF EXISTS (
    SELECT 1 FROM billing_events
     WHERE processed_at IS NULL AND error IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'the reconciliation queue did not empty after the replay';
  END IF;
END
$$;

ROLLBACK;
