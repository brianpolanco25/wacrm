-- Verificación de a7.4 (`webhooks-durable`) contra el Postgres local que
-- crea scripts/replay-migrations.sh. Ejecutar después del replay con:
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_webhooks-durable.sql
--
-- Lo que un test con mocks NO puede ver y aquí sí:
--   A. el CHECK de `status` rechaza un estado inventado;
--   B. la RLS de lectura: un miembro ve la bitácora de SU cuenta y cero de
--      la ajena; `authenticated` no puede escribir (encolar) por ningún lado;
--   C. el reclamo optimista del barrido es exclusivo de verdad bajo dos
--      UPDATE simultáneos sobre la misma foto de la fila;
--   D. borrar el endpoint (o la cuenta) arrastra su bitácora, sin dejar
--      payloads huérfanos con datos del cliente final.

BEGIN;

-- ------------------------------------------------------------
-- Semilla: dos usuarios → dos cuentas personales (trigger de alta),
-- un endpoint por cuenta y una entrega por endpoint.
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('31000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'wh-a@example.test', '{}', '{"full_name":"WH A"}', now(), now()),
  ('31000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'wh-b@example.test', '{}', '{"full_name":"WH B"}', now(), now());

UPDATE profiles SET account_role = 'owner'
 WHERE user_id IN ('31000000-0000-4000-8000-000000000001',
                   '31000000-0000-4000-8000-000000000002');

CREATE TEMP TABLE t_acc AS
SELECT
  (SELECT account_id FROM public.profiles
    WHERE user_id = '31000000-0000-4000-8000-000000000001') AS a,
  (SELECT account_id FROM public.profiles
    WHERE user_id = '31000000-0000-4000-8000-000000000002') AS b;

INSERT INTO webhook_endpoints (id, account_id, url, secret, events, is_active)
SELECT 'e1000000-0000-4000-8000-00000000000a', a,
       'https://a.example.com/hook', 'enc:sec-a',
       ARRAY['message.received'], TRUE FROM t_acc;
INSERT INTO webhook_endpoints (id, account_id, url, secret, events, is_active)
SELECT 'e1000000-0000-4000-8000-00000000000b', b,
       'https://b.example.com/hook', 'enc:sec-b',
       ARRAY['message.received'], TRUE FROM t_acc;

INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event, payload)
SELECT 'd1000000-0000-4000-8000-00000000000a', a,
       'e1000000-0000-4000-8000-00000000000a', 'message.received',
       '{"id":"evt-a","data":{"text":"hola"}}'::jsonb FROM t_acc;
INSERT INTO webhook_deliveries (id, account_id, endpoint_id, event, payload)
SELECT 'd1000000-0000-4000-8000-00000000000b', b,
       'e1000000-0000-4000-8000-00000000000b', 'message.received',
       '{"id":"evt-b","data":{"text":"ajeno"}}'::jsonb FROM t_acc;

-- ------------------------------------------------------------
-- A. El CHECK de `status`. Sin él, un estado inventado ('retrying')
--    saldría del filtro del barrido y la entrega se perdería callando.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE webhook_deliveries SET status = 'retrying'
     WHERE id = 'd1000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'A: el CHECK de status aceptó un estado inventado';
  EXCEPTION WHEN check_violation THEN
    NULL; -- esperado
  END;

  -- Y los cuatro legítimos sí entran.
  UPDATE webhook_deliveries SET status = 'failed'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';
  UPDATE webhook_deliveries SET status = 'dead'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';
  UPDATE webhook_deliveries SET status = 'delivered'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';
  UPDATE webhook_deliveries SET status = 'pending'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';
  RAISE NOTICE 'OK A — el CHECK de status deja pasar los cuatro estados y nada más';
END $$;

-- ------------------------------------------------------------
-- B. RLS. `auth.uid()` en esta imagen sale de `request.jwt.claim.sub`
--    (singular): ponerlo mal deja uid NULL, cero filas para todos y un
--    falso verde.
-- ------------------------------------------------------------
DO $$
DECLARE
  visible_to_a INT;
  visible_to_b INT;
  wrote BOOLEAN := FALSE;
  acc_a uuid;
BEGIN
  SELECT a INTO acc_a FROM t_acc;

  SET LOCAL ROLE authenticated;

  PERFORM set_config('request.jwt.claim.sub',
    '31000000-0000-4000-8000-000000000001', TRUE);
  SELECT count(*) INTO visible_to_a FROM webhook_deliveries;

  PERFORM set_config('request.jwt.claim.sub',
    '31000000-0000-4000-8000-000000000002', TRUE);
  SELECT count(*) INTO visible_to_b FROM webhook_deliveries
   WHERE account_id = acc_a;

  -- Escritura: no hay política de INSERT, así que ni el dueño de la
  -- cuenta puede fabricarse una entrega (y con ella una llamada saliente
  -- firmada por nosotros a la URL que quiera).
  PERFORM set_config('request.jwt.claim.sub',
    '31000000-0000-4000-8000-000000000001', TRUE);
  BEGIN
    INSERT INTO webhook_deliveries (account_id, endpoint_id, event, payload)
    VALUES (acc_a, 'e1000000-0000-4000-8000-00000000000a', 'message.received',
            '{"id":"forjado"}'::jsonb);
    wrote := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL; -- esperado
  END;

  RESET ROLE;

  IF visible_to_a <> 1 THEN
    RAISE EXCEPTION 'B: un miembro de A ve % entregas en vez de 1', visible_to_a;
  END IF;
  IF visible_to_b <> 0 THEN
    RAISE EXCEPTION 'B: un miembro de B ve % entregas de A', visible_to_b;
  END IF;
  IF wrote THEN
    RAISE EXCEPTION 'B: authenticated PUDO encolar una entrega (no debería)';
  END IF;
  RAISE NOTICE 'OK B — lectura acotada a la cuenta; encolar es solo del rol de servicio';
END $$;

-- ------------------------------------------------------------
-- C. El reclamo optimista. Dos barridos que leyeron la MISMA foto
--    (attempt = 0) intentan reclamar; solo uno puede afectar la fila.
--    Sin esto, un cron que se pisa a sí mismo entrega dos veces.
-- ------------------------------------------------------------
DO $$
DECLARE first_rows INT; second_rows INT; final_attempt INT;
BEGIN
  UPDATE webhook_deliveries
     SET attempt = 0, status = 'pending'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';

  UPDATE webhook_deliveries
     SET attempt = attempt + 1, status = 'pending'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a'
     AND attempt = 0
     AND status IN ('pending', 'failed');
  GET DIAGNOSTICS first_rows = ROW_COUNT;

  UPDATE webhook_deliveries
     SET attempt = attempt + 1, status = 'pending'
   WHERE id = 'd1000000-0000-4000-8000-00000000000a'
     AND attempt = 0
     AND status IN ('pending', 'failed');
  GET DIAGNOSTICS second_rows = ROW_COUNT;

  SELECT attempt INTO final_attempt FROM webhook_deliveries
   WHERE id = 'd1000000-0000-4000-8000-00000000000a';

  IF first_rows <> 1 THEN
    RAISE EXCEPTION 'C: el primer reclamo afectó % filas', first_rows;
  END IF;
  IF second_rows <> 0 THEN
    RAISE EXCEPTION 'C: el segundo reclamo afectó % filas (doble entrega)', second_rows;
  END IF;
  IF final_attempt <> 1 THEN
    RAISE EXCEPTION 'C: attempt quedó en % (debería ser 1)', final_attempt;
  END IF;
  RAISE NOTICE 'OK C — el reclamo por attempt es exclusivo';
END $$;

-- ------------------------------------------------------------
-- D. Cascadas: borrar la integración no deja payloads huérfanos.
-- ------------------------------------------------------------
DO $$
DECLARE left_over INT; acc_b uuid;
BEGIN
  DELETE FROM webhook_endpoints WHERE id = 'e1000000-0000-4000-8000-00000000000a';
  SELECT count(*) INTO left_over FROM webhook_deliveries
   WHERE endpoint_id = 'e1000000-0000-4000-8000-00000000000a';
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'D: quedaron % entregas huérfanas tras borrar el endpoint', left_over;
  END IF;

  SELECT b INTO acc_b FROM t_acc;
  -- La 041 deja `subscriptions`/`usage_counters` en RESTRICT a propósito
  -- (f0.2): se retiran primero para poder llegar a borrar la cuenta.
  DELETE FROM subscriptions WHERE account_id = acc_b;
  DELETE FROM usage_counters WHERE account_id = acc_b;
  DELETE FROM accounts WHERE id = acc_b;
  SELECT count(*) INTO left_over FROM webhook_deliveries WHERE account_id = acc_b;
  IF left_over <> 0 THEN
    RAISE EXCEPTION 'D: quedaron % entregas tras borrar la cuenta', left_over;
  END IF;
  RAISE NOTICE 'OK D — la bitácora muere con su endpoint y con su cuenta';
END $$;

-- ------------------------------------------------------------
-- E. El índice parcial del barrido se usa de verdad para la consulta
--    que hace `sweepDueDeliveries` (status vencidos, por antigüedad).
--    Con la tabla vacía el planificador puede preferir un seq scan, así
--    que aquí solo se afirma que el índice existe con su predicado; el
--    plan se mira a mano cuando haya volumen.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_index i
    WHERE i.indexrelid = 'public.webhook_deliveries_due_idx'::regclass
      AND i.indpred IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'E: webhook_deliveries_due_idx no es parcial';
  END IF;
  RAISE NOTICE 'OK E — el índice del barrido existe y es parcial';
END $$;

ROLLBACK;

SELECT 'checks_webhooks-durable: OK' AS resultado;
