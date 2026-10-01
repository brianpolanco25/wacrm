-- Verificación de s10.4 (statements) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 078).
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fg-statements
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_statements.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_statements: OK` o con la primera EXCEPTION.
--
--   1. UNIQUE (account_id, period_end): un segundo estado del mismo corte
--      choca, y el upsert que usa el cron (ON CONFLICT DO NOTHING) no
--      inserta otro — tres pasadas, un estado. El mismo instante escrito
--      en otra zona horaria también choca (timestamptz).
--   2. CHECKs: status fuera de la lista, periodo al revés, vencimiento
--      antes del corte, importe negativo, paid sin paid_at, usage no objeto.
--   3. CHECK ampliado de impersonation_log.action: payment_confirmed y
--      statement_void entran; los de antes siguen; un valor inventado no.
--   4. RLS: owner de A lee sus estados (columnas de totales); owner de B
--      no ve nada de A; agent de A no ve nada (admin+); nadie autenticado
--      lee meta_cost_usd, usage ni paid_reference; authenticated no
--      inserta, no actualiza, no borra; anon no lee.
--   5. ON DELETE CASCADE con la cuenta.
--   6. subscriptions.statement_period_end (ancla del corte): la 078 la
--      rellena para las managed previas (current_period_end, o now() + 1
--      mes) y re-ejecutarla no mueve un ancla ya puesta. Necesita
--      `docker cp supabase/migrations/078_statements.sql <c>:/tmp/`.

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10400000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a-104@example.test', '{}', '{"full_name":"Owner A"}', now(), now()),
  ('10400000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b-104@example.test', '{}', '{"full_name":"Owner B"}', now(), now()),
  ('10400000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'agent-a-104@example.test', '{}', '{"full_name":"Agent A"}', now(), now());

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '10400000-0000-4000-8000-000000000001') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '10400000-0000-4000-8000-000000000002') AS b_acc;
GRANT SELECT ON ids TO authenticated;

UPDATE public.profiles
   SET account_id = (SELECT a_acc FROM ids), account_role = 'agent'
 WHERE user_id = '10400000-0000-4000-8000-000000000003';

DO $$
DECLARE
  a uuid := (SELECT a_acc FROM ids);
  b uuid := (SELECT b_acc FROM ids);
  n int;
BEGIN
  -- Estados de A (uno abierto, uno pagado) y de B.
  INSERT INTO statements (account_id, period_start, period_end, plan_fee_usd,
    usage, meta_cost_usd, usage_charge_usd, total_usd, included_messages,
    messages_total, overage_messages, status, due_at, paid_reference)
  VALUES
    (a, '2026-10-01 00:00+00', '2026-11-01 00:00+00', 1036,
     '{"version":1,"lines":[{"billable":200}]}', 520.26, 33.90, 1069.90,
     7000, 8200, 1200, 'issued', '2026-11-04 00:00+00', NULL),
    (a, '2026-09-01 00:00+00', '2026-10-01 00:00+00', 1036, '{}', 300, 0,
     1036, 7000, 4000, 0, 'issued', '2026-10-04 00:00+00', 'TRX-A'),
    (b, '2026-10-01 00:00+00', '2026-11-01 00:00+00', 1036, '{}', 10, 0,
     1036, 7000, 100, 0, 'issued', '2026-11-04 00:00+00', NULL);
  UPDATE statements SET status = 'paid', paid_at = '2026-10-02 12:00+00'
   WHERE account_id = a AND period_end = '2026-10-01 00:00+00';

  -- 1. UNIQUE (account_id, period_end).
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at)
    VALUES (a, '2026-10-05 00:00+00', '2026-11-01 00:00+00', '2026-11-04 00:00+00');
    RAISE EXCEPTION '1a: un segundo estado del mismo corte entró';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- El mismo instante, escrito en otra zona: es el mismo corte.
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at)
    VALUES (a, '2026-10-05 00:00+00', '2026-10-31 20:00-04', '2026-11-04 00:00+00');
    RAISE EXCEPTION '1b: el mismo instante en otra zona entró';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  -- Lo que hace el cron (upsert ignoreDuplicates), tres veces.
  FOR i IN 1..3 LOOP
    INSERT INTO statements (account_id, period_start, period_end, due_at, total_usd)
    VALUES (b, '2026-11-01 00:00+00', '2026-12-01 00:00+00', '2026-12-04 00:00+00', 1036)
    ON CONFLICT (account_id, period_end) DO NOTHING;
  END LOOP;
  SELECT count(*) INTO n FROM statements
   WHERE account_id = b AND period_end = '2026-12-01 00:00+00';
  IF n <> 1 THEN RAISE EXCEPTION '1c: tres pasadas dejaron % estados', n; END IF;
  -- Otra cuenta con el mismo corte sí puede.
  IF (SELECT count(*) FROM statements WHERE period_end = '2026-11-01 00:00+00') <> 2 THEN
    RAISE EXCEPTION '1d: el UNIQUE no es por cuenta';
  END IF;
  RAISE NOTICE 'ok 1: UNIQUE (account_id, period_end) e idempotencia del cron';

  -- 2. CHECKs.
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at, status)
    VALUES (a, '2027-01-01', '2027-02-01', '2027-02-04', 'overdue');
    RAISE EXCEPTION '2a: status inventado entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at)
    VALUES (a, '2027-02-01', '2027-01-01', '2027-02-04');
    RAISE EXCEPTION '2b: periodo al revés entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at)
    VALUES (a, '2027-01-01', '2027-02-01', '2027-01-20');
    RAISE EXCEPTION '2c: vencimiento antes del corte entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at, total_usd)
    VALUES (a, '2027-01-01', '2027-02-01', '2027-02-04', -1);
    RAISE EXCEPTION '2d: importe negativo entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at, status)
    VALUES (a, '2027-01-01', '2027-02-01', '2027-02-04', 'paid');
    RAISE EXCEPTION '2e: paid sin paid_at entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at, usage)
    VALUES (a, '2027-01-01', '2027-02-01', '2027-02-04', '[]');
    RAISE EXCEPTION '2f: usage no objeto entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok 2: CHECKs';

  -- 3. CHECK ampliado de impersonation_log.action.
  INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
  VALUES
    ('10400000-0000-4000-8000-000000000002', a, 'payment confirmed: statement x', 'payment_confirmed', NULL),
    ('10400000-0000-4000-8000-000000000002', a, 'emitido dos veces por error', 'statement_void', NULL),
    ('10400000-0000-4000-8000-000000000002', a, 'plan asignado a mano', 'plan_override', NULL),
    ('10400000-0000-4000-8000-000000000002', a, 'suspendida por impago', 'suspend', NULL);
  BEGIN
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
    VALUES ('10400000-0000-4000-8000-000000000002', a, 'algo inventado aquí', 'payment_refunded', NULL);
    RAISE EXCEPTION '3a: una acción inventada entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO impersonation_log (actor_user_id, account_id, reason, action, expires_at)
    VALUES ('10400000-0000-4000-8000-000000000002', NULL, 'pago confirmado sin cuenta', 'payment_confirmed', NULL);
    RAISE EXCEPTION '3b: payment_confirmed sin cuenta entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  -- Ninguno de los actos nuevos abre una sesión de soporte.
  IF has_open_support_session(a) THEN
    RAISE EXCEPTION '3c: payment_confirmed / statement_void abren sesión de soporte';
  END IF;
  RAISE NOTICE 'ok 3: CHECK ampliado de impersonation_log.action';
END
$$;

-- 4. RLS, owner de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10400000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n FROM statements;
  IF n <> 2 THEN RAISE EXCEPTION '4a: owner de A ve % estados, esperaba 2', n; END IF;
  IF (SELECT sum(total_usd) FROM statements) <> 2105.90 THEN
    RAISE EXCEPTION '4b: owner de A no lee sus totales';
  END IF;
  IF EXISTS (SELECT 1 FROM statements WHERE account_id <> (SELECT a_acc FROM ids)) THEN
    RAISE EXCEPTION '4c: owner de A ve estados de otra cuenta';
  END IF;
  BEGIN
    PERFORM meta_cost_usd FROM statements;
    RAISE EXCEPTION '4d: owner de A leyó meta_cost_usd';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM usage FROM statements;
    RAISE EXCEPTION '4e: owner de A leyó usage (billable)';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM paid_reference FROM statements;
    RAISE EXCEPTION '4f: owner de A leyó paid_reference';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO statements (account_id, period_start, period_end, due_at)
    VALUES ((SELECT a_acc FROM ids), '2027-01-01', '2027-02-01', '2027-02-04');
    RAISE EXCEPTION '4g: authenticated insertó un estado';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE statements SET status = 'paid', paid_at = now();
    RAISE EXCEPTION '4h: authenticated se marcó pagado';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM statements;
    RAISE EXCEPTION '4i: authenticated borró estados';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

-- Owner de B: nada de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"10400000-0000-4000-8000-000000000002","role":"authenticated"}', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM statements WHERE account_id = (SELECT a_acc FROM ids)) THEN
    RAISE EXCEPTION '4j: owner de B ve estados de A';
  END IF;
  IF (SELECT count(*) FROM statements) <> 2 THEN
    RAISE EXCEPTION '4k: owner de B no ve los suyos (2)';
  END IF;
END
$$;
RESET ROLE;

-- Agent de A: nada (admin+).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10400000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claims', '{"sub":"10400000-0000-4000-8000-000000000003","role":"authenticated"}', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM statements) <> 0 THEN
    RAISE EXCEPTION '4l: un agent de A ve estados de cuenta';
  END IF;
END
$$;
RESET ROLE;

-- anon: nada, ni con las claims de A puestas (sin privilegio de tabla).
SELECT set_config('request.jwt.claim.sub', '', true);
SELECT set_config('request.jwt.claims', '{}', true);
SET LOCAL ROLE anon;
DO $$
BEGIN
  BEGIN
    PERFORM count(*) FROM statements;
    RAISE EXCEPTION '4m: anon leyó estados';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

-- 6. El ancla del corte (statement_period_end): la 078 la rellena para
--    las suscripciones managed que ya existían, y re-ejecutarla no mueve
--    ninguna. Requiere la 078 copiada en el contenedor:
--      docker cp supabase/migrations/078_statements.sql <c>:/tmp/078_statements.sql
UPDATE subscriptions
   SET meta_billing = 'managed', current_period_end = '2026-11-01 00:00+00',
       statement_period_end = NULL
 WHERE account_id = (SELECT a_acc FROM ids);
UPDATE subscriptions
   SET meta_billing = 'managed', current_period_end = NULL,
       statement_period_end = NULL
 WHERE account_id = (SELECT b_acc FROM ids);
\i /tmp/078_statements.sql
DO $$
DECLARE
  sa timestamptz := (SELECT statement_period_end FROM subscriptions WHERE account_id = (SELECT a_acc FROM ids));
  sb timestamptz := (SELECT statement_period_end FROM subscriptions WHERE account_id = (SELECT b_acc FROM ids));
BEGIN
  IF sa IS DISTINCT FROM '2026-11-01 00:00+00'::timestamptz THEN
    RAISE EXCEPTION '6a: el ancla de A no es su current_period_end: %', sa;
  END IF;
  IF sb IS NULL OR abs(extract(epoch FROM sb - (now() + interval '1 month'))) > 60 THEN
    RAISE EXCEPTION '6b: el ancla de B (sin periodo) no es now() + 1 mes: %', sb;
  END IF;
  IF EXISTS (SELECT 1 FROM subscriptions
             WHERE meta_billing = 'direct' AND statement_period_end IS NOT NULL) THEN
    RAISE EXCEPTION '6c: la 078 puso ancla a una cuenta direct';
  END IF;
  UPDATE subscriptions SET statement_period_end = '2026-12-15 00:00+00'
   WHERE account_id = (SELECT a_acc FROM ids);
END
$$;
\i /tmp/078_statements.sql
DO $$
BEGIN
  IF (SELECT statement_period_end FROM subscriptions WHERE account_id = (SELECT a_acc FROM ids))
     IS DISTINCT FROM '2026-12-15 00:00+00'::timestamptz THEN
    RAISE EXCEPTION '6d: re-ejecutar la 078 movió un ancla ya puesta';
  END IF;
  -- La 078 pone lock_timeout = 5s y lo devuelve al valor por defecto al
  -- final (tercera ronda): no se queda puesto en la sesión.
  IF current_setting('lock_timeout') <> '0' THEN
    RAISE EXCEPTION '6e: la 078 dejó lock_timeout = %', current_setting('lock_timeout');
  END IF;
  RAISE NOTICE 'ok 6: ancla rellenada por la 078, e idempotente';
END
$$;

DO $$
BEGIN
  RAISE NOTICE 'ok 4: RLS y privilegios por columna';
  -- 5. CASCADE con la cuenta (la cuenta no se puede borrar aquí sin
  -- vaciar antes otras tablas sin CASCADE, como subscriptions: se mira la
  -- clave foránea).
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.statements'::regclass AND contype = 'f'
      AND confrelid = 'public.accounts'::regclass AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION '5: statements.account_id no es ON DELETE CASCADE';
  END IF;
  RAISE NOTICE 'ok 5: ON DELETE CASCADE';
  RAISE NOTICE 'checks_statements: OK';
END
$$;

ROLLBACK;
