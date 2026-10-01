-- ============================================================
-- checks_plans-admin.sql — s9.3, migración 070, contra el Postgres del
-- harness:
--   KEEP=1 scripts/replay-migrations.sh "$(pwd)"
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 < progress/checks_plans-admin.sql
-- Todo en una transacción que se deshace. Cada comprobación RAISE EXCEPTION
-- si falla; la salida esperada es una lista de NOTICE «ok …».
-- ============================================================
BEGIN;

-- Dos usuarios: un operador y el owner de una empresa (handle_new_user le
-- crea su cuenta).
INSERT INTO auth.users (id, email, aud, role)
VALUES
  ('aaaaaaaa-0000-4000-8000-000000000001', 'op@example.test', 'authenticated', 'authenticated'),
  ('bbbbbbbb-0000-4000-8000-000000000002', 'owner@example.test', 'authenticated', 'authenticated');
INSERT INTO platform_admins (user_id, granted_by, note)
VALUES ('aaaaaaaa-0000-4000-8000-000000000001', 'aaaaaaaa-0000-4000-8000-000000000001', 'check s9.3');

-- Una fila de historial escrita como lo hace la ruta (rol de servicio =
-- postgres aquí, que salta la RLS).
INSERT INTO plan_provider_history (id, plan_id, cycle, provider_plan_id, price_usd, provider_env)
VALUES ('11111111-0000-4000-8000-000000000001', 'pro', 'month', 'P-OLD', 79, 'sandbox');

-- ------------------------------------------------------------
-- 1. RLS: el owner no ve el historial ni escribe en plans ni en el historial.
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
-- La imagen del harness resuelve auth.uid() desde request.jwt.claim.sub;
-- Supabase real, desde request.jwt.claims. Se fijan los dos.
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
  SELECT count(*) INTO n FROM plan_provider_history;
  IF n <> 0 THEN RAISE EXCEPTION 'owner sees % history rows', n; END IF;
  RAISE NOTICE 'ok 1a: owner reads 0 rows of plan_provider_history';

  -- plans sigue siendo legible (catálogo) ...
  SELECT count(*) INTO n FROM plans;
  IF n = 0 THEN RAISE EXCEPTION 'owner cannot read plans'; END IF;
  RAISE NOTICE 'ok 1b: owner still reads plans (% rows)', n;

  -- ... pero no escribible: UPDATE sin política = 0 filas.
  UPDATE plans SET price_usd_month = 1 WHERE id = 'pro';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'owner updated % plans rows', n; END IF;
  RAISE NOTICE 'ok 1c: owner UPDATE plans affects 0 rows';

  BEGIN
    INSERT INTO plans (id, name, price_usd_month) VALUES ('hack', 'Hack', 1);
    RAISE EXCEPTION 'owner could INSERT into plans';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok 1d: owner INSERT plans refused (%)', SQLERRM;
  END;

  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('pro', 'month', 'P-HACK', 1, 'sandbox');
    RAISE EXCEPTION 'owner could INSERT into plan_provider_history';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok 1e: owner INSERT history refused (%)', SQLERRM;
  END;

  UPDATE plan_provider_history SET price_usd = 1;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'owner updated % history rows', n; END IF;
  DELETE FROM plan_provider_history;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'owner deleted % history rows', n; END IF;
  RAISE NOTICE 'ok 1f: owner UPDATE/DELETE history affect 0 rows';
END $$;

-- ------------------------------------------------------------
-- 2. RLS: el operador lee el historial, pero tampoco escribe desde el cliente.
-- ------------------------------------------------------------
SELECT set_config('request.jwt.claim.sub', 'aaaaaaaa-0000-4000-8000-000000000001', true),
       set_config('request.jwt.claims', '{"sub":"aaaaaaaa-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM plan_provider_history;
  IF n <> 1 THEN RAISE EXCEPTION 'operator sees % history rows, expected 1', n; END IF;
  RAISE NOTICE 'ok 2a: platform admin reads the history';

  UPDATE plans SET price_usd_month = 1 WHERE id = 'pro';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'operator session updated plans'; END IF;
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('pro', 'month', 'P-X', 1, 'sandbox');
    RAISE EXCEPTION 'operator session could INSERT history';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'ok 2b: even the operator writes only through the service role';
  END;
END $$;

RESET ROLE;

-- ------------------------------------------------------------
-- 3. Integridad.
-- ------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  -- FK RESTRICT: un plan con historial no se borra. Plan propio sin
  -- suscripciones, para que salte ESTA FK y no la de subscriptions (041).
  INSERT INTO plans (id, name, price_usd_month) VALUES ('solo', 'Solo', 10);
  INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
  VALUES ('solo', 'month', 'P-SOLO', 10, 'sandbox');
  BEGIN
    DELETE FROM plans WHERE id = 'solo';
    RAISE EXCEPTION 'a plan with history was deleted';
  EXCEPTION WHEN foreign_key_violation THEN
    IF SQLERRM NOT LIKE '%plan_provider_history_plan_id_fkey%' THEN
      RAISE EXCEPTION 'unexpected FK: %', SQLERRM;
    END IF;
    RAISE NOTICE 'ok 3a: plan_provider_history_plan_id_fkey ON DELETE RESTRICT';
  END;

  -- replaced_by: self-FK ON DELETE SET NULL.
  INSERT INTO plan_provider_history (id, plan_id, cycle, provider_plan_id, price_usd, provider_env)
  VALUES ('11111111-0000-4000-8000-000000000002', 'pro', 'month', 'P-NEW', 100, 'sandbox');
  UPDATE plan_provider_history
     SET replaced_at = now(), replaced_by = '11111111-0000-4000-8000-000000000002'
   WHERE id = '11111111-0000-4000-8000-000000000001';
  DELETE FROM plan_provider_history WHERE id = '11111111-0000-4000-8000-000000000002';
  SELECT count(*) INTO n FROM plan_provider_history
   WHERE id = '11111111-0000-4000-8000-000000000001' AND replaced_by IS NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'replaced_by was not set to NULL'; END IF;
  RAISE NOTICE 'ok 3b: replaced_by ON DELETE SET NULL';

  -- replaced_by debe apuntar a una fila existente.
  BEGIN
    UPDATE plan_provider_history SET replaced_by = gen_random_uuid()
     WHERE id = '11111111-0000-4000-8000-000000000001';
    RAISE EXCEPTION 'replaced_by accepted a dangling id';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'ok 3c: replaced_by is a real FK';
  END;

  -- plan_id debe existir.
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('no-such-plan', 'month', 'P-Z', 1, 'sandbox');
    RAISE EXCEPTION 'history accepted an unknown plan';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'ok 3d: plan_id FK';
  END;

  -- CHECKs.
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('pro', 'week', 'P-W', 1, 'sandbox');
    RAISE EXCEPTION 'cycle CHECK missing';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 3e: cycle CHECK month/year';
  END;
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('pro', 'month', 'P-E', 1, 'staging');
    RAISE EXCEPTION 'provider_env CHECK missing';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'ok 3f: provider_env CHECK sandbox/live';
  END;
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('pro', 'month', NULL, 1, 'sandbox');
    RAISE EXCEPTION 'provider_plan_id NOT NULL missing';
  EXCEPTION WHEN not_null_violation THEN
    RAISE NOTICE 'ok 3g: provider_plan_id NOT NULL';
  END;

  -- Un id de PayPal, una vez por entorno.
  BEGIN
    INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
    VALUES ('inicio', 'year', 'P-OLD', 350, 'sandbox');
    RAISE EXCEPTION 'the same PayPal id was recorded twice';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'ok 3h: (provider, provider_env, provider_plan_id) unique';
  END;
  INSERT INTO plan_provider_history (plan_id, cycle, provider_plan_id, price_usd, provider_env)
  VALUES ('pro', 'month', 'P-OLD', 79, 'live');
  RAISE NOTICE 'ok 3i: the same id in the other environment is a different plan';

  -- Defaults.
  SELECT count(*) INTO n FROM plan_provider_history
   WHERE provider_env = 'live' AND provider = 'paypal' AND created_at IS NOT NULL;
  IF n <> 1 THEN RAISE EXCEPTION 'provider/created_at defaults missing'; END IF;
  RAISE NOTICE 'ok 3j: provider defaults to paypal, created_at to now()';
END $$;

-- ------------------------------------------------------------
-- 4. plans: columnas nuevas y trigger de updated_at.
-- ------------------------------------------------------------
UPDATE plans SET updated_at = '2000-01-01' WHERE id = 'inicio';
UPDATE plans SET description = 'check' WHERE id = 'inicio';
DO $$
BEGIN
  IF (SELECT updated_at FROM plans WHERE id = 'inicio') < now() - interval '1 minute' THEN
    RAISE EXCEPTION 'updated_at trigger did not fire';
  END IF;
  IF EXISTS (SELECT 1 FROM plans WHERE created_at IS NULL) THEN
    RAISE EXCEPTION 'existing plans got no created_at';
  END IF;
  RAISE NOTICE 'ok 4: plans.created_at backfilled, updated_at maintained by trigger, description writable';
END $$;

ROLLBACK;
