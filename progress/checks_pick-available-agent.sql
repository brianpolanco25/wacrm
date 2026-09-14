-- Escenarios funcionales de f1.1 para ejecutar contra el Postgres local
-- iniciado por scripts/replay-migrations.sh con KEEP=1.
-- Ejecutar como postgres: docker exec -i <contenedor> psql -U postgres -d postgres -v ON_ERROR_STOP=1 < progress/checks_pick-available-agent.sql

BEGIN;

DO $$
DECLARE
  account_a uuid := '10000000-0000-0000-0000-000000000001';
  account_b uuid := '20000000-0000-0000-0000-000000000002';
  owner_a uuid := '10000000-0000-0000-0000-000000000010';
  agent_heavy uuid := '10000000-0000-0000-0000-000000000011';
  agent_light uuid := '10000000-0000-0000-0000-000000000012';
  agent_stale uuid := '10000000-0000-0000-0000-000000000013';
  viewer_a uuid := '10000000-0000-0000-0000-000000000014';
  agent_b uuid := '20000000-0000-0000-0000-000000000010';
  picked uuid;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, encrypted_password)
  VALUES
    (owner_a, 'authenticated', 'authenticated', 'owner-a@example.test', 'not-used'),
    (agent_heavy, 'authenticated', 'authenticated', 'heavy@example.test', 'not-used'),
    (agent_light, 'authenticated', 'authenticated', 'light@example.test', 'not-used'),
    (agent_stale, 'authenticated', 'authenticated', 'stale@example.test', 'not-used'),
    (viewer_a, 'authenticated', 'authenticated', 'viewer@example.test', 'not-used'),
    (agent_b, 'authenticated', 'authenticated', 'agent-b@example.test', 'not-used');

  -- El trigger de alta crea una cuenta y perfil personal por usuario.
  -- Reutilizamos esas dos cuentas y reunimos los cinco miembros de A.
  SELECT account_id INTO account_a FROM profiles WHERE user_id = owner_a;
  SELECT account_id INTO account_b FROM profiles WHERE user_id = agent_b;
  UPDATE profiles
     SET account_id = account_a,
         account_role = CASE user_id
           WHEN owner_a THEN 'owner'::account_role_enum
           WHEN viewer_a THEN 'viewer'::account_role_enum
           ELSE 'agent'::account_role_enum
         END
   WHERE user_id IN (owner_a, agent_heavy, agent_light, agent_stale, viewer_a);
  UPDATE profiles
     SET account_role = 'agent'
   WHERE user_id = agent_b;

  INSERT INTO member_presence (user_id, account_id, status, last_seen_at)
  VALUES
    (agent_heavy, account_a, 'online', now() - interval '1 minute'),
    (agent_light, account_a, 'online', now()),
    (agent_stale, account_a, 'online', now() - interval '10 minutes'),
    (viewer_a, account_a, 'online', now() + interval '1 minute'),
    (agent_b, account_b, 'online', now() + interval '2 minutes');

  -- Cargas 5/2/9: el agente ligero debe ganar con carga 2.
  WITH new_contacts AS (
    INSERT INTO contacts (id, user_id, phone, account_id)
    SELECT uuid_generate_v4(), owner_a,
           '+199900' || lpad(n::text, 6, '0'), account_a
      FROM generate_series(1, 16) AS n
    RETURNING id, phone
  ), ordered_contacts AS (
    SELECT id, row_number() OVER (ORDER BY phone) AS n
      FROM new_contacts
  )
  INSERT INTO conversations (user_id, contact_id, account_id, assigned_agent_id, status)
  SELECT owner_a, id, account_a,
         CASE
           WHEN n <= 5 THEN agent_heavy
           WHEN n <= 7 THEN agent_light
           ELSE owner_a
         END,
         CASE WHEN n <= 5 OR n > 7 THEN 'open' ELSE 'pending' END
    FROM ordered_contacts;

  SELECT public.pick_available_agent(account_a) INTO picked;
  IF picked IS DISTINCT FROM agent_light THEN
    RAISE EXCEPTION 'expected light agent %, got %', agent_light, picked;
  END IF;

  -- El stale de diez minutos y el viewer (aunque tengan presencia online)
  -- no son candidatos; cuenta B tampoco se filtra en la llamada de A.
  DELETE FROM member_presence WHERE user_id IN (agent_heavy, agent_light);
  SELECT public.pick_available_agent(account_a) INTO picked;
  IF picked IS NOT NULL THEN
    RAISE EXCEPTION 'expected NULL with only stale/viewer candidates, got %', picked;
  END IF;

  -- Aislamiento de datos: la presencia online de la cuenta B no puede
  -- convertirse en resultado al pedir la cuenta A.
  SELECT public.pick_available_agent(account_b) INTO picked;
  IF picked IS DISTINCT FROM agent_b THEN
    RAISE EXCEPTION 'expected account B agent %, got %', agent_b, picked;
  END IF;
END $$;

-- Autorización: una sesión autenticada no puede usar el UUID de otra cuenta.
DO $$
BEGIN
  SET LOCAL ROLE authenticated;
  BEGIN
    PERFORM public.pick_available_agent('20000000-0000-0000-0000-000000000002');
    RAISE EXCEPTION 'authenticated unexpectedly executed pick_available_agent';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
  RESET ROLE;
END $$;

ROLLBACK;
