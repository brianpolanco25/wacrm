-- ============================================================
-- checks_meta-rate-card.sql — s10.2, migración 076, contra el Postgres
-- del harness:
--   KEEP=1 scripts/replay-migrations.sh "<worktree>"
--   docker cp <worktree>/supabase/migrations/076_meta_rates.sql <contenedor>:/tmp/076_meta_rates.sql
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 < progress/checks_meta-rate-card.sql
-- (el paso 5 reaplica la 076 con \i para probar la idempotencia).
-- Todo en una transacción que se deshace. Cada comprobación RAISE EXCEPTION
-- si falla; la salida esperada es una lista de NOTICE «ok …».
-- ============================================================
BEGIN;

-- Un owner de empresa (handle_new_user le crea cuenta y suscripción).
INSERT INTO auth.users (id, email, aud, role)
VALUES ('bbbbbbbb-0000-4000-8000-000000000002', 'owner@example.test', 'authenticated', 'authenticated');

-- ------------------------------------------------------------
-- 1. Semilla y columnas nuevas (como postgres = rol de servicio).
-- ------------------------------------------------------------
DO $$
DECLARE n int; r record;
BEGIN
  SELECT count(*) INTO n FROM meta_rates;
  IF n <> 3 THEN RAISE EXCEPTION 'seed has % rates, expected 3', n; END IF;
  SELECT count(*) INTO n FROM meta_rates
   WHERE market = 'rest_of_latam' AND category LIKE 'authentication%';
  IF n <> 0 THEN RAISE EXCEPTION 'authentication rates were seeded without local data'; END IF;
  RAISE NOTICE 'ok 1a: seed = rest_of_latam service/utility 0.0113, marketing 0.0740; no authentication';

  SELECT count(*) INTO n FROM meta_market_countries WHERE market = 'rest_of_latam';
  RAISE NOTICE 'ok 1b: % countries in rest_of_latam (DO included)', n;
  SELECT count(*) INTO n FROM meta_rates WHERE market <> 'rest_of_latam';
  IF n <> 0 THEN RAISE EXCEPTION 'rates seeded for markets without local data'; END IF;
  RAISE NOTICE 'ok 1c: mexico/colombia/brazil/north_america/spain/rest_of_world have no rate';

  SELECT meta_billing, meta_pricing INTO r FROM subscriptions s
    JOIN accounts a ON a.id = s.account_id
   WHERE a.owner_user_id = 'bbbbbbbb-0000-4000-8000-000000000002';
  IF r.meta_billing IS DISTINCT FROM 'direct' OR r.meta_pricing IS DISTINCT FROM '{}'::jsonb THEN
    RAISE EXCEPTION 'new subscription is % / %', r.meta_billing, r.meta_pricing;
  END IF;
  RAISE NOTICE 'ok 1d: a new subscription is direct with meta_pricing {}';
END $$;

-- ------------------------------------------------------------
-- 2. CHECKs: categoría, tarifa > 0, país en mayúsculas, meta_billing.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO meta_rates VALUES ('mexico', 'marketing', 0, DATE '2026-10-01');
    RAISE EXCEPTION 'a rate of 0 was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO meta_rates VALUES ('mexico', 'sms', 0.01, DATE '2026-10-01');
    RAISE EXCEPTION 'an unknown category was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    INSERT INTO meta_rates VALUES ('rest_of_latam', 'marketing', 0.09, DATE '2026-10-01');
    RAISE EXCEPTION 'a second rate for the same key was accepted';
  EXCEPTION WHEN unique_violation THEN NULL; END;
  BEGIN
    INSERT INTO meta_market_countries (country_code, market) VALUES ('do', 'x_y');
    RAISE EXCEPTION 'a lowercase country was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE subscriptions SET meta_billing = 'other';
    RAISE EXCEPTION 'meta_billing other was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  BEGIN
    UPDATE subscriptions SET meta_pricing = '[]'::jsonb;
    RAISE EXCEPTION 'a non-object meta_pricing was accepted';
  EXCEPTION WHEN check_violation THEN NULL; END;
  RAISE NOTICE 'ok 2: CHECKs and PK refuse 0, unknown category, duplicate key, lowercase country, bad meta_billing/meta_pricing';
END $$;

-- ------------------------------------------------------------
-- 3. RLS: un inquilino lee tarifas y países, y no escribe.
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', 'bbbbbbbb-0000-4000-8000-000000000002', true),
       set_config('request.jwt.claims', '{"sub":"bbbbbbbb-0000-4000-8000-000000000002","role":"authenticated"}', true);
DO $$ BEGIN
  IF auth.uid() IS DISTINCT FROM 'bbbbbbbb-0000-4000-8000-000000000002'::uuid THEN
    RAISE EXCEPTION 'auth.uid() is not the owner: the check would prove nothing';
  END IF;
END $$;

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM meta_rates;
  IF n <> 3 THEN RAISE EXCEPTION 'tenant reads % rates, expected 3', n; END IF;
  SELECT count(*) INTO n FROM meta_market_countries WHERE country_code = 'DO';
  IF n <> 1 THEN RAISE EXCEPTION 'tenant cannot read DO'; END IF;
  RAISE NOTICE 'ok 3a: tenant reads meta_rates and meta_market_countries';

  BEGIN
    INSERT INTO meta_rates VALUES ('mexico', 'marketing', 0.05, DATE '2026-10-01');
    RAISE EXCEPTION 'tenant inserted a rate';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  BEGIN
    INSERT INTO meta_market_countries (country_code, market) VALUES ('ZZ', 'rest_of_latam');
    RAISE EXCEPTION 'tenant inserted a country';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
  RAISE NOTICE 'ok 3b: tenant INSERT refused on both tables';

  -- UPDATE/DELETE sin política: 0 filas tocadas, sin error.
  UPDATE meta_rates SET usd_per_message = 0.00001;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant updated % rates', n; END IF;
  DELETE FROM meta_rates;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant deleted % rates', n; END IF;
  UPDATE meta_market_countries SET market = 'mexico';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant updated % countries', n; END IF;
  DELETE FROM meta_market_countries;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant deleted % countries', n; END IF;
  RAISE NOTICE 'ok 3c: tenant UPDATE/DELETE touch 0 rows on both tables';

  -- Su propia suscripción: la lee (meta_billing incluido) y no la escribe.
  UPDATE subscriptions SET meta_billing = 'managed';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant updated its subscription'; END IF;
  RAISE NOTICE 'ok 3d: tenant cannot switch itself to managed';
END $$;

-- ------------------------------------------------------------
-- 4. anon no lee nada.
-- ------------------------------------------------------------
RESET ROLE;
SET LOCAL ROLE anon;
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM meta_rates;
  IF n <> 0 THEN RAISE EXCEPTION 'anon reads % rates', n; END IF;
  RAISE NOTICE 'ok 4: anon reads 0 rates';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'ok 4: anon has no privilege on meta_rates';
END $$;
RESET ROLE;

-- ------------------------------------------------------------
-- 5. Idempotencia: reaplicar la 076 no duplica ni pisa nada.
-- ------------------------------------------------------------
UPDATE meta_market_countries SET market = 'custom_market' WHERE country_code = 'HT';
\i /tmp/076_meta_rates.sql
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM meta_rates;
  IF n <> 3 THEN RAISE EXCEPTION 'second pass left % rates', n; END IF;
  IF (SELECT market FROM meta_market_countries WHERE country_code = 'HT') <> 'custom_market' THEN
    RAISE EXCEPTION 'second pass overwrote an operator edit';
  END IF;
  RAISE NOTICE 'ok 5: 076 re-applied: same rows, operator edits kept';
END $$;

ROLLBACK;
