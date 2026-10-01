-- ============================================================
-- checks_managed-plan.sql — s10.3, migración 077, contra el Postgres
-- del harness:
--   KEEP=1 scripts/replay-migrations.sh "<worktree>"
--   docker cp <worktree>/supabase/migrations/077_plan_gestionado.sql <contenedor>:/tmp/077_plan_gestionado.sql
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < progress/checks_managed-plan.sql
-- (el paso 5 reaplica la 077 con \i para probar la idempotencia).
-- Todo en una transacción que se deshace. Cada comprobación RAISE EXCEPTION
-- si falla; la salida esperada es una lista de NOTICE «ok …».
-- ============================================================
BEGIN;

-- Dos owners de empresa (handle_new_user les crea cuenta y suscripción).
INSERT INTO auth.users (id, email, aud, role) VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'a@example.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'b@example.test', 'authenticated', 'authenticated');

-- La empresa A, gestionada con pago manual (lo que escribe el panel con
-- el rol de servicio); la B, como queda al registrarse.
UPDATE subscriptions s
SET plan_id = 'gestionado', provider = 'manual', status = 'active',
    cycle = 'month', current_period_end = now() + interval '1 month',
    payment_method = 'manual', meta_billing = 'managed',
    meta_pricing = (SELECT meta_pricing FROM plans WHERE id = 'gestionado')
FROM accounts a
WHERE a.id = s.account_id
  AND a.owner_user_id = 'aaaaaaaa-0000-4000-8000-000000000001';

-- ------------------------------------------------------------
-- 1. El plan y las columnas nuevas (como postgres = rol de servicio).
-- ------------------------------------------------------------
DO $$
DECLARE r record; n int;
BEGIN
  SELECT * INTO r FROM plans WHERE id = 'gestionado';
  IF r.is_public OR r.price_usd_month <> 1036 OR r.price_usd_year IS NOT NULL THEN
    RAISE EXCEPTION 'gestionado is not hidden / 1036 / monthly only: % % %',
      r.is_public, r.price_usd_month, r.price_usd_year;
  END IF;
  IF (r.limits->>'messages_out') IS NOT NULL OR (r.limits->>'broadcast_recipients') IS NOT NULL
     OR (r.limits->>'numbers')::int <> 3 THEN
    RAISE EXCEPTION 'gestionado limits are wrong: %', r.limits;
  END IF;
  IF r.provider_plan_id_month IS NOT NULL OR r.provider_plan_id_year IS NOT NULL THEN
    RAISE EXCEPTION 'the migration must not publish gestionado to PayPal';
  END IF;
  IF (r.meta_pricing->>'included_messages')::int <> 7000
     OR (r.meta_pricing->>'fee_usd')::numeric <> 1036
     OR (r.meta_pricing #>> '{overage,marketing,multiplier}')::numeric <> 2.5 THEN
    RAISE EXCEPTION 'gestionado default price is wrong: %', r.meta_pricing;
  END IF;
  RAISE NOTICE 'ok 1a: gestionado hidden, 1036/month, no yearly, sends unlimited, 3 numbers, default price 7000/1036/x2.5, not on PayPal';

  SELECT count(*) INTO n FROM plans WHERE id <> 'gestionado' AND meta_pricing <> '{}'::jsonb;
  IF n <> 0 THEN RAISE EXCEPTION '% other plans got a price policy', n; END IF;
  RAISE NOTICE 'ok 1b: every other plan keeps meta_pricing {}';

  SELECT count(*) INTO n FROM subscriptions s JOIN accounts a ON a.id = s.account_id
   WHERE a.owner_user_id = 'bbbbbbbb-0000-4000-8000-000000000002'
     AND s.payment_method IS NULL AND s.meta_billing = 'direct';
  IF n <> 1 THEN RAISE EXCEPTION 'a new subscription is not direct with no payment method'; END IF;
  RAISE NOTICE 'ok 1c: a new subscription has payment_method NULL (lo que diga provider)';
END $$;

-- ------------------------------------------------------------
-- 2. CHECKs.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE subscriptions SET payment_method = 'cash';
    RAISE EXCEPTION 'payment_method cash was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plans SET meta_pricing = '[]'::jsonb WHERE id = 'gestionado';
    RAISE EXCEPTION 'a non-object plans.meta_pricing was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE plans SET meta_pricing = NULL WHERE id = 'gestionado';
    RAISE EXCEPTION 'a NULL plans.meta_pricing was accepted';
  EXCEPTION WHEN not_null_violation THEN NULL; END;
  UPDATE subscriptions SET payment_method = 'paypal' WHERE false;
  RAISE NOTICE 'ok 2: CHECKs refuse payment_method cash and a non-object/NULL plans.meta_pricing';
END $$;

-- ------------------------------------------------------------
-- 3. RLS: el propietario de A lee su suscripción y no cambia nada de lo
--    que s10.3 escribe; no ve la de B.
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$ BEGIN
  IF auth.uid() IS DISTINCT FROM 'aaaaaaaa-0000-4000-8000-000000000001'::uuid THEN
    RAISE EXCEPTION 'auth.uid() is not the owner: the check would prove nothing';
  END IF;
END $$;

DO $$
DECLARE n int; r record;
BEGIN
  SELECT count(*) INTO n FROM subscriptions;
  IF n <> 1 THEN RAISE EXCEPTION 'tenant A sees % subscriptions, expected its own only', n; END IF;
  SELECT meta_billing, payment_method INTO r FROM subscriptions;
  IF r.meta_billing <> 'managed' OR r.payment_method <> 'manual' THEN
    RAISE EXCEPTION 'tenant A reads % / %', r.meta_billing, r.payment_method;
  END IF;
  RAISE NOTICE 'ok 3a: tenant A reads its own subscription (managed, manual) and not B''s';

  UPDATE subscriptions SET meta_billing = 'direct';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant changed its meta_billing'; END IF;
  UPDATE subscriptions SET meta_pricing = '{"included_messages": 999999, "fee_usd": 0, "overage": {}}'::jsonb;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant changed its meta_pricing'; END IF;
  UPDATE subscriptions SET payment_method = 'paypal';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant changed its payment_method'; END IF;
  UPDATE subscriptions SET current_period_end = now() + interval '10 years';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant moved its cut-off'; END IF;
  DELETE FROM subscriptions;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant deleted its subscription'; END IF;
  RAISE NOTICE 'ok 3b: tenant UPDATE of meta_billing / meta_pricing / payment_method / period end and DELETE touch 0 rows';

  BEGIN
    INSERT INTO subscriptions (account_id, plan_id, payment_method, meta_billing)
    VALUES (gen_random_uuid(), 'gestionado', 'manual', 'managed');
    RAISE EXCEPTION 'tenant inserted a subscription';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'ok 3c: tenant INSERT into subscriptions refused';

  SELECT count(*) INTO n FROM plans WHERE id = 'gestionado';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant cannot read the catalogue row'; END IF;
  UPDATE plans SET meta_pricing = '{}'::jsonb, is_public = true WHERE id = 'gestionado';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant edited the plan'; END IF;
  RAISE NOTICE 'ok 3d: tenant reads plans (041) but cannot publish gestionado nor change its price';
END $$;
RESET ROLE;

DO $$
DECLARE r record;
BEGIN
  SELECT s.meta_billing, s.payment_method, s.meta_pricing->>'fee_usd' AS fee
    INTO r
    FROM subscriptions s JOIN accounts a ON a.id = s.account_id
   WHERE a.owner_user_id = 'aaaaaaaa-0000-4000-8000-000000000001';
  IF r.meta_billing <> 'managed' OR r.payment_method <> 'manual' OR r.fee <> '1036' THEN
    RAISE EXCEPTION 'A changed after the tenant tries: %', r;
  END IF;
  IF (SELECT is_public FROM plans WHERE id = 'gestionado') THEN
    RAISE EXCEPTION 'gestionado became public';
  END IF;
  RAISE NOTICE 'ok 3e: as postgres, A is still managed/manual/1036 and gestionado still hidden';
END $$;

-- ------------------------------------------------------------
-- 4. anon no lee suscripciones.
-- ------------------------------------------------------------
-- Sin sesión: se borran las claims del JWT que dejó el paso 3 (un anon
-- real no trae `sub`).
SELECT set_config('request.jwt.claim.sub', '', true),
       set_config('request.jwt.claims', '{"role":"anon"}', true);
SET LOCAL ROLE anon;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM subscriptions;
  IF n <> 0 THEN RAISE EXCEPTION 'anon reads % subscriptions', n; END IF;
  RAISE NOTICE 'ok 4: anon reads 0 subscriptions';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok 4: anon has no privilege on subscriptions';
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 5. Idempotencia: reaplicar la 077 no duplica ni pisa ediciones.
-- ------------------------------------------------------------
UPDATE plans
SET description = 'editado por el operador',
    meta_pricing = jsonb_set(meta_pricing, '{fee_usd}', '900')
WHERE id = 'gestionado';
\i /tmp/077_plan_gestionado.sql
DO $$
DECLARE n int; r record;
BEGIN
  SELECT count(*) INTO n FROM plans WHERE id = 'gestionado';
  IF n <> 1 THEN RAISE EXCEPTION 'second pass left % gestionado rows', n; END IF;
  SELECT description, meta_pricing->>'fee_usd' AS fee INTO r FROM plans WHERE id = 'gestionado';
  IF r.description <> 'editado por el operador' OR r.fee <> '900' THEN
    RAISE EXCEPTION 'second pass overwrote an operator edit: %', r;
  END IF;
  RAISE NOTICE 'ok 5: 077 re-applied: one row, operator edits kept';
END $$;

ROLLBACK;
