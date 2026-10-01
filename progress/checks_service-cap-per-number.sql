-- Verificación de p11.3 (service-cap-per-number) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 080).
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/pmd-service-cap
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_service-cap-per-number.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_service-cap-per-number: OK` o con la primera EXCEPTION.
--
--   R1  una cuenta existente queda en 'warn'; 'pause_ai' se acepta; 'foo'
--       viola el CHECK; NULL viola el NOT NULL.
--   R2  service_quota_usage con filas sintéticas de dos cuentas: una fila
--       por cada exclusión (otra cuenta, otra categoría, sent, failed,
--       anterior a p_since, whatsapp_config_id NULL, free_entry_point) y
--       resultado exacto; pricing_type NULL sí cuenta; billable cuenta
--       solo pricing_billable = true; read cuenta.
--   R3  authenticated y anon: insufficient_privilege; service_role sí
--       ejecuta y ve las filas (SECURITY INVOKER + bypass de RLS).
--   R7  accounts_update (017): el owner de A cambia su acción; no la de B.

BEGIN;

CREATE TEMP TABLE ids (k text PRIMARY KEY, v uuid) ON COMMIT DROP;
GRANT SELECT ON ids TO authenticated, anon, service_role;

DO $$
DECLARE
  ua uuid := '10800000-0000-4000-8000-000000000001';
  ub uuid := '10800000-0000-4000-8000-000000000002';
  acct_a uuid;
  acct_b uuid;
  cfg_a1 uuid;
  cfg_a2 uuid;
  cfg_b1 uuid;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data,
                          raw_user_meta_data, created_at, updated_at)
  VALUES
    (ua, 'authenticated', 'authenticated', 'chk-080-a@example.test', '{}',
     '{"full_name":"Owner A"}', now(), now()),
    (ub, 'authenticated', 'authenticated', 'chk-080-b@example.test', '{}',
     '{"full_name":"Owner B"}', now(), now());
  acct_a := (SELECT id FROM accounts WHERE owner_user_id = ua);
  acct_b := (SELECT id FROM accounts WHERE owner_user_id = ub);
  IF acct_a IS NULL OR acct_b IS NULL THEN
    RAISE EXCEPTION 'handle_new_user did not create the accounts';
  END IF;

  -- R1: la cuenta recién creada queda en 'warn' por el DEFAULT.
  IF (SELECT service_cap_action FROM accounts WHERE id = acct_a) <> 'warn' THEN
    RAISE EXCEPTION 'R1: default is not warn';
  END IF;
  UPDATE accounts SET service_cap_action = 'pause_ai' WHERE id = acct_a;
  BEGIN
    UPDATE accounts SET service_cap_action = 'foo' WHERE id = acct_a;
    RAISE EXCEPTION 'R1: CHECK accepted foo';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    UPDATE accounts SET service_cap_action = NULL WHERE id = acct_a;
    RAISE EXCEPTION 'R1: NOT NULL accepted NULL';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;

  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id,
                               access_token, status, is_default)
  VALUES (ua, acct_a, 'chk-080-pn-a1', 'enc-a1', 'connected', true)
  RETURNING id INTO cfg_a1;
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id,
                               access_token, status, is_default)
  VALUES (ua, acct_a, 'chk-080-pn-a2', 'enc-a2', 'connected', false)
  RETURNING id INTO cfg_a2;
  INSERT INTO whatsapp_config (user_id, account_id, phone_number_id,
                               access_token, status, is_default)
  VALUES (ub, acct_b, 'chk-080-pn-b1', 'enc-b1', 'connected', true)
  RETURNING id INTO cfg_b1;

  -- R2: filas sintéticas. Mes = octubre 2026; p_since = 2026-10-01 UTC.
  INSERT INTO message_charges (account_id, whatsapp_config_id, wamid,
                               pricing_category, pricing_billable,
                               pricing_type, status, delivered_at)
  VALUES
    -- Cuentan para A1: 3 entregados/leídos, 1 de ellos cobrado, 1 con
    -- pricing_type NULL.
    (acct_a, cfg_a1, 'w-a1-1', 'service', false, 'free_customer_service',
     'delivered', '2026-10-02T10:00:00Z'),
    (acct_a, cfg_a1, 'w-a1-2', 'service', true, 'regular',
     'read', '2026-10-03T10:00:00Z'),
    (acct_a, cfg_a1, 'w-a1-3', 'service', NULL, NULL,
     'delivered', '2026-10-01T00:00:00Z'),
    -- Cuenta para A2: 1 entregado.
    (acct_a, cfg_a2, 'w-a2-1', 'service', false, NULL,
     'delivered', '2026-10-05T10:00:00Z'),
    -- Exclusiones (A1):
    (acct_a, cfg_a1, 'x-cat', 'utility', true, 'regular',
     'delivered', '2026-10-02T10:00:00Z'),
    (acct_a, cfg_a1, 'x-sent', 'service', false, NULL,
     'sent', NULL),
    (acct_a, cfg_a1, 'x-failed', 'service', false, NULL,
     'failed', NULL),
    (acct_a, cfg_a1, 'x-old', 'service', true, 'regular',
     'delivered', '2026-09-30T23:59:59Z'),
    (acct_a, NULL, 'x-nocfg', 'service', true, 'regular',
     'delivered', '2026-10-02T10:00:00Z'),
    (acct_a, cfg_a1, 'x-entry', 'service', false, 'free_entry_point',
     'delivered', '2026-10-02T10:00:00Z'),
    -- Otra cuenta (B), que no debe aparecer en el resultado de A.
    (acct_b, cfg_b1, 'w-b1-1', 'service', true, 'regular',
     'delivered', '2026-10-02T10:00:00Z'),
    (acct_b, cfg_b1, 'w-b1-2', 'service', true, 'regular',
     'delivered', '2026-10-02T11:00:00Z');

  INSERT INTO ids VALUES ('ua', ua), ('ub', ub), ('acct_a', acct_a),
    ('acct_b', acct_b), ('cfg_a1', cfg_a1), ('cfg_a2', cfg_a2),
    ('cfg_b1', cfg_b1);
END
$$;

-- R2 como postgres: resultado exacto para A y para B.
DO $$
DECLARE
  acct_a uuid := (SELECT v FROM ids WHERE k = 'acct_a');
  acct_b uuid := (SELECT v FROM ids WHERE k = 'acct_b');
  cfg_a1 uuid := (SELECT v FROM ids WHERE k = 'cfg_a1');
  cfg_a2 uuid := (SELECT v FROM ids WHERE k = 'cfg_a2');
  cfg_b1 uuid := (SELECT v FROM ids WHERE k = 'cfg_b1');
  got text;
  want text;
BEGIN
  SELECT string_agg(format('%s:%s:%s', whatsapp_config_id, used, billable),
                    ',' ORDER BY whatsapp_config_id::text)
    INTO got
    FROM service_quota_usage(acct_a, '2026-10-01T00:00:00Z');
  SELECT string_agg(x, ',' ORDER BY x) INTO want FROM (VALUES
    (format('%s:%s:%s', cfg_a1, 3, 1)),
    (format('%s:%s:%s', cfg_a2, 1, 0))) t(x);
  IF got IS DISTINCT FROM want THEN
    RAISE EXCEPTION 'R2: A got %, want %', got, want;
  END IF;

  SELECT string_agg(format('%s:%s:%s', whatsapp_config_id, used, billable), ',')
    INTO got
    FROM service_quota_usage(acct_b, '2026-10-01T00:00:00Z');
  IF got IS DISTINCT FROM format('%s:%s:%s', cfg_b1, 2, 2) THEN
    RAISE EXCEPTION 'R2: B got %', got;
  END IF;

  -- p_since mueve el corte: desde el 1-nov no hay nada.
  IF EXISTS (SELECT 1 FROM service_quota_usage(acct_a, '2026-11-01T00:00:00Z')) THEN
    RAISE EXCEPTION 'R2: November should be empty';
  END IF;
  -- Y con p_since en septiembre entra x-old (A1 pasa a 4 usados, 2 cobrados).
  IF (SELECT format('%s:%s', used, billable)
        FROM service_quota_usage(acct_a, '2026-09-01T00:00:00Z')
       WHERE whatsapp_config_id = cfg_a1) <> '4:2' THEN
    RAISE EXCEPTION 'R2: September cut wrong';
  END IF;
END
$$;

-- R3: service_role ejecuta y ve las filas pese a la RLS (admin+) de
-- message_charges.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT sum(used) FROM service_quota_usage(
        (SELECT v FROM ids WHERE k = 'acct_a'), '2026-10-01T00:00:00Z')) <> 4 THEN
    RAISE EXCEPTION 'R3: service_role does not see the rows';
  END IF;
END
$$;
RESET ROLE;

-- R3: authenticated (el owner de A, que por RLS sí podría leer sus cargos)
-- no puede ejecutar la función.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10800000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10800000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
BEGIN
  BEGIN
    PERFORM * FROM service_quota_usage(
      (SELECT v FROM ids WHERE k = 'acct_a'), '2026-10-01T00:00:00Z');
    RAISE EXCEPTION 'R3: authenticated executed service_quota_usage';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- R7: accounts_update (017) deja al owner de A cambiar SU acción…
  UPDATE accounts SET service_cap_action = 'warn'
   WHERE id = (SELECT v FROM ids WHERE k = 'acct_a');
  IF NOT FOUND THEN
    RAISE EXCEPTION 'R7: owner of A could not update its own account';
  END IF;
  -- …y no la de B (RLS: 0 filas).
  UPDATE accounts SET service_cap_action = 'pause_ai'
   WHERE id = (SELECT v FROM ids WHERE k = 'acct_b');
  IF FOUND THEN
    RAISE EXCEPTION 'R7: owner of A updated account B';
  END IF;
END
$$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM * FROM service_quota_usage(
      (SELECT v FROM ids WHERE k = 'acct_a'), '2026-10-01T00:00:00Z');
    RAISE EXCEPTION 'R3: anon executed service_quota_usage';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

DO $$
BEGIN
  IF (SELECT service_cap_action FROM accounts
       WHERE id = (SELECT v FROM ids WHERE k = 'acct_b')) <> 'warn' THEN
    RAISE EXCEPTION 'R7: B changed';
  END IF;
  IF (SELECT service_cap_action FROM accounts
       WHERE id = (SELECT v FROM ids WHERE k = 'acct_a')) <> 'warn' THEN
    RAISE EXCEPTION 'R7: A did not change';
  END IF;
  IF has_function_privilege('authenticated',
       'public.service_quota_usage(uuid, timestamptz)', 'EXECUTE')
     OR has_function_privilege('anon',
       'public.service_quota_usage(uuid, timestamptz)', 'EXECUTE')
     OR NOT has_function_privilege('service_role',
       'public.service_quota_usage(uuid, timestamptz)', 'EXECUTE') THEN
    RAISE EXCEPTION 'R3: privileges wrong';
  END IF;
  RAISE NOTICE 'checks_service-cap-per-number: OK';
END
$$;

ROLLBACK;
