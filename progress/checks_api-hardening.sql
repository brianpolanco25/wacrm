-- ============================================================
-- a7.1 `api-hardening` — comprobaciones contra Postgres de verdad.
--
-- Lo que se comprueba aquí es justo lo que un test de vitest no puede
-- comprobar: que el ÍNDICE ÚNICO existe y arbitra (es el mecanismo con
-- el que `withIdempotency` decide quién ejecuta y quién reproduce), y
-- que la RLS sin políticas deja la tabla fuera del alcance de
-- `authenticated`.
--
-- Cómo se corrió:
--   KEEP=1 scripts/replay-migrations.sh "$(pwd)"
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 \
--     -f progress/checks_api-hardening.sql
-- ============================================================

BEGIN;

-- Dos cuentas con una clave de API cada una, más una segunda clave en
-- la cuenta A: el trío que hace falta para probar el alcance.
--
-- Ojo: `accounts` NO se inserta a mano. El alta de un usuario en
-- `auth.users` dispara el trigger de la migración 001, que ya crea su
-- cuenta (y `idx_accounts_one_per_owner` impide una segunda). Así que
-- las claves de API se cuelgan de la cuenta que el trigger creó.
INSERT INTO auth.users (id, email)
VALUES ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
       ('22222222-2222-4222-8222-222222222222', 'b@example.test');

INSERT INTO api_keys (id, account_id, name, key_prefix, key_hash, scopes)
SELECT v.id, a.id, v.name, v.prefix, v.hash, ARRAY['messages:send']
FROM (VALUES
  ('a1a1a1a1-0000-4000-8000-000000000001'::uuid, 'A-1', 'wacrm_live_aaaa1111', 'hash-a1',
   '11111111-1111-4111-8111-111111111111'::uuid),
  ('a2a2a2a2-0000-4000-8000-000000000002'::uuid, 'A-2', 'wacrm_live_aaaa2222', 'hash-a2',
   '11111111-1111-4111-8111-111111111111'::uuid),
  ('b1b1b1b1-0000-4000-8000-000000000003'::uuid, 'B-1', 'wacrm_live_bbbb1111', 'hash-b1',
   '22222222-2222-4222-8222-222222222222'::uuid)
) AS v(id, name, prefix, hash, owner)
JOIN accounts a ON a.owner_user_id = v.owner;

-- Atajo para el resto del guion: la cuenta de cada clave sale de la
-- propia fila de `api_keys`, como en la aplicación.
CREATE OR REPLACE FUNCTION pg_temp.acct(p_key uuid) RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT account_id FROM api_keys WHERE id = p_key;
$$;

-- ------------------------------------------------------------
-- 1. La reserva por defecto caduca a las 24 h.
-- ------------------------------------------------------------
INSERT INTO api_idempotency_keys
  (account_id, api_key_id, idempotency_key, request_hash)
VALUES (pg_temp.acct('a1a1a1a1-0000-4000-8000-000000000001'),
        'a1a1a1a1-0000-4000-8000-000000000001', 'pedido-1', 'sha-1');

DO $$
DECLARE ttl interval;
BEGIN
  SELECT expires_at - created_at INTO ttl
  FROM api_idempotency_keys WHERE idempotency_key = 'pedido-1';
  IF ttl <> interval '24 hours' THEN
    RAISE EXCEPTION 'la caducidad por defecto no es 24 h, es %', ttl;
  END IF;
  RAISE NOTICE '1 OK: expires_at por defecto = created_at + 24 h';
END $$;

-- ------------------------------------------------------------
-- 2. La MISMA clave en la MISMA clave de API se rechaza (23505).
--    Esto es el mecanismo entero: sin él, dos reintentos simultáneos
--    enviarían el mensaje dos veces.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO api_idempotency_keys
      (account_id, api_key_id, idempotency_key, request_hash)
    VALUES (pg_temp.acct('a1a1a1a1-0000-4000-8000-000000000001'),
            'a1a1a1a1-0000-4000-8000-000000000001', 'pedido-1', 'sha-otro');
    RAISE EXCEPTION 'el índice único NO rechazó la clave repetida';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE '2 OK: (api_key_id, idempotency_key) repetido → 23505';
  END;
END $$;

-- ------------------------------------------------------------
-- 3. La misma clave bajo OTRA clave de API sí entra — y son filas
--    distintas. Dos integraciones de la misma empresa que eligen el
--    mismo identificador no se pisan ni se leen.
-- ------------------------------------------------------------
INSERT INTO api_idempotency_keys
  (account_id, api_key_id, idempotency_key, request_hash)
VALUES (pg_temp.acct('a2a2a2a2-0000-4000-8000-000000000002'),
        'a2a2a2a2-0000-4000-8000-000000000002', 'pedido-1', 'sha-2'),
       (pg_temp.acct('b1b1b1b1-0000-4000-8000-000000000003'),
        'b1b1b1b1-0000-4000-8000-000000000003', 'pedido-1', 'sha-3');

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n
  FROM api_idempotency_keys WHERE idempotency_key = 'pedido-1';
  IF n <> 3 THEN
    RAISE EXCEPTION 'se esperaban 3 filas independientes, hay %', n;
  END IF;
  RAISE NOTICE '3 OK: la misma Idempotency-Key convive en 3 claves de API';
END $$;

-- ------------------------------------------------------------
-- 4. RLS habilitada y CERO políticas: `authenticated` no ve nada.
--    Se comprueba ejecutando de verdad como ese rol, no leyendo
--    pg_policies.
-- ------------------------------------------------------------
GRANT SELECT ON api_idempotency_keys TO authenticated;  -- ni con GRANT

DO $$
DECLARE visible int;
BEGIN
  SET LOCAL ROLE authenticated;
  SELECT count(*) INTO visible FROM api_idempotency_keys;
  RESET ROLE;
  IF visible <> 0 THEN
    RAISE EXCEPTION
      'authenticated ve % filas de api_idempotency_keys (RLS sin políticas debería ocultarlas todas)',
      visible;
  END IF;
  RAISE NOTICE '4 OK: authenticated ve 0 filas aun con GRANT SELECT';
END $$;

-- ------------------------------------------------------------
-- 5. El rol de servicio sí las ve (es quien las escribe).
-- ------------------------------------------------------------
DO $$
DECLARE visible int;
BEGIN
  SET LOCAL ROLE service_role;
  SELECT count(*) INTO visible FROM api_idempotency_keys;
  RESET ROLE;
  IF visible <> 3 THEN
    RAISE EXCEPTION 'service_role ve % filas, se esperaban 3', visible;
  END IF;
  RAISE NOTICE '5 OK: service_role ve las 3 filas';
END $$;

-- ------------------------------------------------------------
-- 6. Borrar una clave de API se lleva SOLO sus reservas (efímeras),
--    y no toca las de las demás.
-- ------------------------------------------------------------
DELETE FROM api_keys WHERE id = 'a1a1a1a1-0000-4000-8000-000000000001';

DO $$
DECLARE n int;
BEGIN
  SELECT count(*) INTO n FROM api_idempotency_keys;
  IF n <> 2 THEN
    RAISE EXCEPTION 'tras borrar una clave quedan % filas, se esperaban 2', n;
  END IF;
  RAISE NOTICE '6 OK: el CASCADE por api_key_id solo borró sus propias filas';
END $$;

-- ------------------------------------------------------------
-- 7. La consulta de purga usa el índice de `expires_at`.
-- ------------------------------------------------------------
DO $$
DECLARE
  plan text := '';
  linea record;
BEGIN
  SET LOCAL enable_seqscan = off;   -- la tabla de prueba es diminuta
  FOR linea IN
    EXECUTE 'EXPLAIN (COSTS OFF) SELECT 1 FROM api_idempotency_keys WHERE expires_at < now()'
  LOOP
    plan := plan || linea."QUERY PLAN" || E'\n';
  END LOOP;
  IF plan NOT LIKE '%api_idempotency_keys_expires_at_idx%' THEN
    RAISE EXCEPTION 'la purga por expires_at no usa su índice: %', plan;
  END IF;
  RAISE NOTICE '7 OK: la purga por expires_at usa api_idempotency_keys_expires_at_idx';
END $$;

ROLLBACK;
