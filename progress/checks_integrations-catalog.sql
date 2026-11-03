-- Verificación de n13.1 (`integrations-catalog`, migración 091) contra el
-- Postgres local de scripts/replay-migrations.sh:
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_integrations-catalog.sql
--
-- Cada bloque imprime `PASS <caso>` o aborta con `FAIL <caso>`.
--   A. cada CHECK de la 091 rechaza su caso (R1, R3);
--   B. `authenticated` y `anon`: permission denied en las cuatro tablas (R2);
--   C. borrar una integración con activación u operación → foreign_key_violation (R1);
--   D. ningún plan sembrado trae `integrations` (R12, D2).
-- Todo dentro de una transacción que se deshace al final.

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('91000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'int-a@example.test', '{}', '{"full_name":"INT A"}', now(), now());

CREATE TEMP TABLE t_acc AS
SELECT (SELECT account_id FROM public.profiles
         WHERE user_id = '91000000-0000-4000-8000-000000000001') AS a;

INSERT INTO integrations (id, slug, name, base_url, auth_scheme, test_path, is_active)
VALUES ('91100000-0000-4000-8000-000000000001', 'health', 'Cabbity Health',
        'https://health.example.com/api/v1', 'bearer', '/me', true);
INSERT INTO integration_operations (integration_id, key, name, description, method, path, params)
VALUES ('91100000-0000-4000-8000-000000000001', 'create_appointment', 'Crear cita',
        'Crea una cita', 'POST', '/appointments',
        '[{"name":"doctor_id","in":"body","type":"integer","required":true,"description":"Doctor"}]');
INSERT INTO account_integrations (account_id, integration_id, is_enabled, credential, credential_last4)
SELECT a, '91100000-0000-4000-8000-000000000001', true, 'enc:xxxx', 'xxxx' FROM t_acc;
INSERT INTO integration_calls (account_id, integration_id, source, outcome, status_code, latency_ms)
SELECT a, '91100000-0000-4000-8000-000000000001', 'test', 'ok', 200, 12 FROM t_acc;

-- A. CHECKs -----------------------------------------------------------
CREATE FUNCTION pg_temp.expect_check(label text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE stmt;
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'PASS %', label;
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL % (no check_violation)', label;
END $$;

SELECT pg_temp.expect_check('integrations_slug_format',
  $q$INSERT INTO integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('Bad Slug', 'x', 'https://x.example.com', 'bearer', '/')$q$);
SELECT pg_temp.expect_check('integrations_base_url_https',
  $q$INSERT INTO integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('plain-http', 'x', 'http://x.example.com', 'bearer', '/')$q$);
SELECT pg_temp.expect_check('integrations_auth_scheme',
  $q$INSERT INTO integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('basic-auth', 'x', 'https://x.example.com', 'basic', '/')$q$);
SELECT pg_temp.expect_check('integrations_header_name',
  $q$INSERT INTO integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('no-header', 'x', 'https://x.example.com', 'header', '/')$q$);
SELECT pg_temp.expect_check('integrations_test_path',
  $q$INSERT INTO integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('rel-path', 'x', 'https://x.example.com', 'bearer', 'me')$q$);
SELECT pg_temp.expect_check('integration_operations_key_format',
  $q$INSERT INTO integration_operations (integration_id, key, name, description, method, path)
     VALUES ('91100000-0000-4000-8000-000000000001', 'Bad-Key', 'x', 'x', 'GET', '/x')$q$);
SELECT pg_temp.expect_check('integration_operations_method',
  $q$INSERT INTO integration_operations (integration_id, key, name, description, method, path)
     VALUES ('91100000-0000-4000-8000-000000000001', 'head_op', 'x', 'x', 'HEAD', '/x')$q$);
SELECT pg_temp.expect_check('integration_operations_path',
  $q$INSERT INTO integration_operations (integration_id, key, name, description, method, path)
     VALUES ('91100000-0000-4000-8000-000000000001', 'rel_op', 'x', 'x', 'GET', 'x')$q$);
SELECT pg_temp.expect_check('integration_operations_params_array',
  $q$INSERT INTO integration_operations (integration_id, key, name, description, method, path, params)
     VALUES ('91100000-0000-4000-8000-000000000001', 'obj_params', 'x', 'x', 'GET', '/x', '{}')$q$);
SELECT pg_temp.expect_check('integration_operations_outputs_array',
  $q$INSERT INTO integration_operations (integration_id, key, name, description, method, path, outputs)
     VALUES ('91100000-0000-4000-8000-000000000001', 'obj_outputs', 'x', 'x', 'GET', '/x', '{}')$q$);
-- R3: una fila activa no puede quedarse sin credencial.
SELECT pg_temp.expect_check('account_integrations_enabled_has_credential',
  $q$UPDATE account_integrations SET credential = NULL
     WHERE integration_id = '91100000-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_check('account_integrations_test_status',
  $q$UPDATE account_integrations SET last_test_status = 'weird'
     WHERE integration_id = '91100000-0000-4000-8000-000000000001'$q$);
SELECT pg_temp.expect_check('integration_calls_source',
  $q$INSERT INTO integration_calls (account_id, integration_id, source, outcome, latency_ms)
     SELECT a, '91100000-0000-4000-8000-000000000001', 'cron', 'ok', 1 FROM t_acc$q$);
SELECT pg_temp.expect_check('integration_calls_outcome',
  $q$INSERT INTO integration_calls (account_id, integration_id, source, outcome, latency_ms)
     SELECT a, '91100000-0000-4000-8000-000000000001', 'test', 'boom', 1 FROM t_acc$q$);

-- D5: desactivar (is_enabled = false + credential NULL) sí está permitido.
DO $$
BEGIN
  UPDATE account_integrations SET is_enabled = false, credential = NULL, credential_last4 = NULL
   WHERE integration_id = '91100000-0000-4000-8000-000000000001';
  UPDATE account_integrations SET is_enabled = true, credential = 'enc:yyyy', credential_last4 = 'yyyy'
   WHERE integration_id = '91100000-0000-4000-8000-000000000001';
  RAISE NOTICE 'PASS desactivar y reactivar respetan el CHECK';
END $$;

-- B. Privilegios de los roles de cliente --------------------------------
CREATE FUNCTION pg_temp.expect_denied(label text, r text, stmt text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
  BEGIN
    EXECUTE format('SET LOCAL ROLE %I', r);
    EXECUTE stmt;
  EXCEPTION WHEN insufficient_privilege THEN
    RESET ROLE;
    RAISE NOTICE 'PASS % (% denied)', label, r;
    RETURN;
  END;
  RESET ROLE;
  RAISE EXCEPTION 'FAIL % (% allowed)', label, r;
END $$;

SELECT pg_temp.expect_denied('select integrations', r, 'SELECT * FROM public.integrations')
  FROM unnest(ARRAY['authenticated', 'anon']) r;
SELECT pg_temp.expect_denied('select integration_operations', r, 'SELECT * FROM public.integration_operations')
  FROM unnest(ARRAY['authenticated', 'anon']) r;
SELECT pg_temp.expect_denied('select account_integrations', r, 'SELECT * FROM public.account_integrations')
  FROM unnest(ARRAY['authenticated', 'anon']) r;
SELECT pg_temp.expect_denied('select integration_calls', r, 'SELECT * FROM public.integration_calls')
  FROM unnest(ARRAY['authenticated', 'anon']) r;
SELECT pg_temp.expect_denied('insert integrations', 'authenticated',
  $q$INSERT INTO public.integrations (slug, name, base_url, auth_scheme, test_path)
     VALUES ('evil', 'x', 'https://x.example.com', 'bearer', '/')$q$);
SELECT pg_temp.expect_denied('update account_integrations', 'authenticated',
  'UPDATE public.account_integrations SET is_enabled = false');
SELECT pg_temp.expect_denied('delete integration_calls', 'authenticated',
  'DELETE FROM public.integration_calls');
SELECT pg_temp.expect_denied('update integration_operations', 'authenticated',
  'UPDATE public.integration_operations SET is_active = false');

-- C. FK RESTRICT ----------------------------------------------------------
DO $$
BEGIN
  BEGIN
    DELETE FROM integrations WHERE id = '91100000-0000-4000-8000-000000000001';
  EXCEPTION WHEN foreign_key_violation THEN
    RAISE NOTICE 'PASS DELETE integrations con activación → foreign_key_violation';
    RETURN;
  END;
  RAISE EXCEPTION 'FAIL DELETE integrations con activación se permitió';
END $$;

-- D. Ningún plan trae la feature ------------------------------------------
DO $$
DECLARE n integer;
BEGIN
  SELECT count(*) INTO n FROM plans WHERE 'integrations' = ANY (features);
  IF n <> 0 THEN
    RAISE EXCEPTION 'FAIL % planes traen integrations', n;
  END IF;
  RAISE NOTICE 'PASS ningún plan trae integrations (count = 0)';
END $$;

ROLLBACK;
