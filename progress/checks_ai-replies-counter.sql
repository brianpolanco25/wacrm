-- Verificación de f1.5 (contador `ai_replies`) contra el Postgres local que
-- crea scripts/replay-migrations.sh. Ejecutar después del replay con:
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_ai-replies-counter.sql
--
-- La feature no añade SQL: usa `increment_usage` de la 041. Lo que hay que
-- comprobar contra la base real es justo lo que un test con mocks no puede
-- ver — que la llamada que escribe el código (argumentos NOMBRADOS
-- p_account_id/p_metric/p_delta, bajo el rol de servicio) existe con esa
-- firma, la puede ejecutar service_role y no la pueden ejecutar anon ni
-- authenticated, y que cada cuenta acumula en su propia fila.
--
-- Partes: A firma, B privilegios, C acumulación y aislamiento entre cuentas,
-- D control negativo (un nombre de argumento equivocado no resuelve).

BEGIN;

-- ------------------------------------------------------------
-- A. La firma que invoca el código existe tal cual.
-- ------------------------------------------------------------
DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM pg_proc p
  JOIN pg_namespace ns ON ns.oid = p.pronamespace
  WHERE ns.nspname = 'public'
    AND p.proname = 'increment_usage'
    AND p.proargnames = ARRAY['p_account_id','p_metric','p_delta']
    AND pg_get_function_identity_arguments(p.oid) = 'p_account_id uuid, p_metric text, p_delta bigint'
    AND p.prosecdef;                     -- SECURITY DEFINER
  IF n <> 1 THEN
    RAISE EXCEPTION 'A: increment_usage(p_account_id uuid, p_metric text, p_delta bigint) SECURITY DEFINER no existe (n=%)', n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- B. Solo el rol de servicio la ejecuta.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT has_function_privilege('service_role',
       'public.increment_usage(uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B: service_role no puede ejecutar increment_usage';
  END IF;
  IF has_function_privilege('authenticated',
       'public.increment_usage(uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B: authenticated PUEDE ejecutar increment_usage (no debería)';
  END IF;
  IF has_function_privilege('anon',
       'public.increment_usage(uuid,text,bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'B: anon PUEDE ejecutar increment_usage (no debería)';
  END IF;
END $$;

-- ------------------------------------------------------------
-- C. Dos cuentas. Cada respuesta de IA suma 1 en la fila de SU cuenta y
--    en el mes natural en curso; la otra cuenta no se entera.
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('20000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'ai-counter-a@example.test', '{}', '{"full_name":"AI counter A"}', now(), now()),
  ('20000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'ai-counter-b@example.test', '{}', '{"full_name":"AI counter B"}', now(), now());

-- El trigger de alta crea una cuenta personal por usuario.
CREATE TEMP TABLE t_accounts AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '20000000-0000-4000-8000-000000000001') AS a,
  (SELECT account_id FROM public.profiles WHERE user_id = '20000000-0000-4000-8000-000000000002') AS b;

-- El rol de servicio tiene que poder leer la tabla auxiliar para llamar a
-- la RPC exactamente como la llama el código.
GRANT SELECT ON t_accounts TO service_role;

SET LOCAL ROLE service_role;

-- Tres respuestas enviadas en A (la llamada que hace el código, con
-- argumentos nombrados) y una en B.
SELECT public.increment_usage(p_account_id := a, p_metric := 'ai_replies', p_delta := 1) FROM t_accounts;
SELECT public.increment_usage(p_account_id := a, p_metric := 'ai_replies', p_delta := 1) FROM t_accounts;
SELECT public.increment_usage(p_account_id := a, p_metric := 'ai_replies', p_delta := 1) FROM t_accounts;
SELECT public.increment_usage(p_account_id := b, p_metric := 'ai_replies', p_delta := 1) FROM t_accounts;

RESET ROLE;

DO $$
DECLARE va bigint; vb bigint; rows int; acc_a uuid; acc_b uuid;
BEGIN
  SELECT a, b INTO acc_a, acc_b FROM t_accounts;

  SELECT value INTO va FROM usage_counters
   WHERE account_id = acc_a AND metric = 'ai_replies'
     AND period_start = date_trunc('month', now())::date;
  SELECT value INTO vb FROM usage_counters
   WHERE account_id = acc_b AND metric = 'ai_replies'
     AND period_start = date_trunc('month', now())::date;

  IF va IS DISTINCT FROM 3 THEN
    RAISE EXCEPTION 'C: la cuenta A debería llevar 3 ai_replies, lleva %', va;
  END IF;
  IF vb IS DISTINCT FROM 1 THEN
    RAISE EXCEPTION 'C: la cuenta B debería llevar 1 ai_reply, lleva %', vb;
  END IF;

  -- Una sola fila por (cuenta, métrica, periodo): el upsert acumula, no
  -- inserta una fila por respuesta.
  SELECT count(*) INTO rows FROM usage_counters
   WHERE account_id IN (acc_a, acc_b) AND metric = 'ai_replies';
  IF rows <> 2 THEN
    RAISE EXCEPTION 'C: se esperaban 2 filas (una por cuenta), hay %', rows;
  END IF;

  -- Y no se tocó ninguna otra métrica.
  SELECT count(*) INTO rows FROM usage_counters
   WHERE account_id IN (acc_a, acc_b) AND metric <> 'ai_replies';
  IF rows <> 0 THEN
    RAISE EXCEPTION 'C: se escribieron % filas de otras métricas', rows;
  END IF;
END $$;

-- ------------------------------------------------------------
-- D. Control negativo: si el código escribiera mal un nombre de argumento
--    (p_account en vez de p_account_id) la llamada no resolvería. Esto es
--    lo que la parte A protege y lo que los mocks no pueden ver.
-- ------------------------------------------------------------
DO $$
DECLARE acc uuid;
BEGIN
  SELECT a INTO acc FROM t_accounts;
  BEGIN
    PERFORM public.increment_usage(p_account := acc, p_metric := 'ai_replies', p_delta := 1);
    RAISE EXCEPTION 'D: una llamada con el argumento mal escrito resolvió (no debería)';
  EXCEPTION WHEN undefined_function OR invalid_parameter_value THEN
    NULL; -- esperado
  END;
END $$;

SELECT 'checks_ai-replies-counter: OK' AS resultado;

ROLLBACK;
