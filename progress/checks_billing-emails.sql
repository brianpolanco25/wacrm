-- Verificación de p11.7 (billing-emails) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 083). NO EJECUTADO en esta
-- sesión: Docker estaba apagado por decisión del humano. Para correrlo:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/pmd-billing-emails
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_billing-emails.sql
--
-- Y la idempotencia (aplicar la 083 una segunda vez):
--   docker cp supabase/migrations/083_notification_emails.sql <c>:/tmp/
--   docker exec <c> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 -f /tmp/083_notification_emails.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_billing_emails: OK` o con la primera EXCEPTION.
--
--   1. (R1) UNIQUE (account_id, kind, ref): un segundo INSERT con la
--      misma terna falla con 23505; el ON CONFLICT DO NOTHING que usa la
--      reserva no inserta otra fila. La misma ref con otro kind, o en
--      otra cuenta, sí entra.
--   2. (R2) CHECK: kind y status fuera de la lista → 23514; attempts
--      negativo y ref vacía → 23514.
--   3. (R3) authenticated (admin de A con sus claims): no lee ni escribe
--      notification_emails aunque haya filas de A. Con REVOKE ALL el
--      SELECT da 42501 (insufficient_privilege) antes de llegar a la RLS;
--      se acepta también 0 filas, por si un GRANT futuro reabre la tabla
--      (la RLS sin políticas la sigue cerrando). anon igual.
--   4. ON DELETE CASCADE con la cuenta (catálogo), sin otras FKs.

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10830000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a-083@example.test', '{}', '{"full_name":"Owner A"}', now(), now()),
  ('10830000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b-083@example.test', '{}', '{"full_name":"Owner B"}', now(), now());

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '10830000-0000-4000-8000-000000000001') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '10830000-0000-4000-8000-000000000002') AS b_acc;
GRANT SELECT ON ids TO authenticated, anon;

DO $$
DECLARE
  a uuid := (SELECT a_acc FROM ids);
  b uuid := (SELECT b_acc FROM ids);
  n int;
BEGIN
  IF a IS NULL OR b IS NULL THEN
    RAISE EXCEPTION '0: el trigger de alta no creó las cuentas de prueba';
  END IF;

  -- 1. UNIQUE.
  INSERT INTO notification_emails (account_id, kind, ref)
  VALUES (a, 'statement_issued', 'st-1');
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref)
    VALUES (a, 'statement_issued', 'st-1');
    RAISE EXCEPTION '1a: un segundo aviso con la misma terna entró';
  EXCEPTION WHEN unique_violation THEN NULL;  -- 23505
  END;
  INSERT INTO notification_emails (account_id, kind, ref, status, attempts)
  VALUES (a, 'statement_issued', 'st-1', 'pending', 1)
  ON CONFLICT (account_id, kind, ref) DO NOTHING;
  SELECT count(*) INTO n FROM notification_emails
   WHERE account_id = a AND kind = 'statement_issued' AND ref = 'st-1';
  IF n <> 1 THEN RAISE EXCEPTION '1b: ON CONFLICT DO NOTHING dejó % filas', n; END IF;
  INSERT INTO notification_emails (account_id, kind, ref)
  VALUES (a, 'statement_due', 'st-1'), (b, 'statement_issued', 'st-1');
  SELECT count(*) INTO n FROM notification_emails WHERE ref = 'st-1';
  IF n <> 3 THEN RAISE EXCEPTION '1c: otro kind u otra cuenta con la misma ref no entró (% filas)', n; END IF;
  -- Valores por defecto.
  IF NOT EXISTS (SELECT 1 FROM notification_emails
                 WHERE account_id = b AND status = 'pending' AND attempts = 0
                   AND sent_at IS NULL AND recipients IS NULL) THEN
    RAISE EXCEPTION '1d: los valores por defecto no son pending/0/null';
  END IF;
  RAISE NOTICE 'ok 1: UNIQUE (account_id, kind, ref)';

  -- 2. CHECKs.
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref)
    VALUES (a, 'welcome', 'x');
    RAISE EXCEPTION '2a: kind inventado entró';
  EXCEPTION WHEN check_violation THEN NULL;  -- 23514
  END;
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref, status)
    VALUES (a, 'service_quota_80', 'cfg:2026-10', 'delivered');
    RAISE EXCEPTION '2b: status inventado entró';
  EXCEPTION WHEN check_violation THEN NULL;  -- 23514
  END;
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref, attempts)
    VALUES (a, 'service_quota_80', 'cfg:2026-10', -1);
    RAISE EXCEPTION '2c: attempts negativo entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref)
    VALUES (a, 'service_quota_80', '');
    RAISE EXCEPTION '2d: ref vacía entró';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  RAISE NOTICE 'ok 2: CHECK de kind, status, attempts y ref';
END
$$;

-- El dueño de A pasa a admin para el caso de R3 (claims de un admin).
UPDATE public.profiles SET account_role = 'admin'
 WHERE user_id = '10830000-0000-4000-8000-000000000001';

-- 3. authenticated, admin de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10830000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10830000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM notification_emails;
    IF n <> 0 THEN RAISE EXCEPTION '3a: admin de A ve % avisos', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;  -- 42501, lo esperado con REVOKE
  END;
  BEGIN
    INSERT INTO notification_emails (account_id, kind, ref)
    VALUES ((SELECT a_acc FROM ids), 'statement_due', 'st-2');
    RAISE EXCEPTION '3b: authenticated insertó un aviso';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE notification_emails SET status = 'sent';
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION '3c: authenticated actualizó % avisos', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    DELETE FROM notification_emails;
    GET DIAGNOSTICS n = ROW_COUNT;
    IF n <> 0 THEN RAISE EXCEPTION '3d: authenticated borró % avisos', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok 3: authenticated no lee ni escribe';
END
$$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
DECLARE
  n int;
BEGIN
  BEGIN
    SELECT count(*) INTO n FROM notification_emails;
    IF n <> 0 THEN RAISE EXCEPTION '3e: anon ve % avisos', n; END IF;
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  RAISE NOTICE 'ok 3b: anon no lee';
END
$$;
RESET ROLE;

-- 4. ON DELETE CASCADE con la cuenta, leído del catálogo (borrar una
--    cuenta de prueba arrastra FKs de otras tablas que no son de esta
--    migración). Y que ninguna FK apunte A esta tabla.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.notification_emails'::regclass
                   AND contype = 'f'
                   AND confrelid = 'public.accounts'::regclass
                   AND confdeltype = 'c') THEN
    RAISE EXCEPTION '4a: notification_emails.account_id no cae en cascada con accounts';
  END IF;
  IF (SELECT count(*) FROM pg_constraint
      WHERE conrelid = 'public.notification_emails'::regclass
        AND contype = 'f') <> 1 THEN
    RAISE EXCEPTION '4b: notification_emails tiene FKs además de accounts (ref no debe tener FK)';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_constraint
             WHERE confrelid = 'public.notification_emails'::regclass) THEN
    RAISE EXCEPTION '4c: otra tabla referencia notification_emails';
  END IF;
  RAISE NOTICE 'ok 4: ON DELETE CASCADE solo desde accounts';
  RAISE NOTICE 'checks_billing_emails: OK';
END
$$;

ROLLBACK;
