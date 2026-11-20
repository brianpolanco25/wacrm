-- Comprobaciones de p16.3 (migración 098) contra el Postgres del harness.
-- Uso: KEEP=1 scripts/replay-migrations.sh "$(pwd)"  y luego
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_audit-db-privileges.sql
-- auth.uid() de esta imagen lee request.jwt.claim.sub; se fijan ambas claves.
-- Cada bloque imprime PASS o aborta con FAIL. Todo corre dentro de una
-- transacción que se deshace al final.
\set QUIET on
BEGIN;

-- Montaje (postgres): tres altas por auth.users -> handle_new_user crea
-- cuenta + perfil. B y C se mueven a la cuenta de A como viewer y agent.
INSERT INTO auth.users (id, email, raw_user_meta_data) VALUES
  ('00000000-0000-0000-0000-00000000000a', 'owner@t.test', '{"full_name":"Owner"}'),
  ('00000000-0000-0000-0000-00000000000b', 'viewer@t.test', '{"full_name":"Viewer"}'),
  ('00000000-0000-0000-0000-00000000000c', 'agent@t.test', '{"full_name":"Agent"}');

DO $$
DECLARE acc uuid;
BEGIN
  SELECT account_id INTO acc FROM profiles WHERE user_id = '00000000-0000-0000-0000-00000000000a';
  IF acc IS NULL THEN RAISE EXCEPTION 'FAIL C2: handle_new_user no creó el perfil'; END IF;
  RAISE NOTICE 'PASS C2: handle_new_user sigue creando el perfil (account %)', acc;
  UPDATE profiles SET account_id = acc, account_role = 'viewer' WHERE user_id = '00000000-0000-0000-0000-00000000000b';
  UPDATE profiles SET account_id = acc, account_role = 'agent'  WHERE user_id = '00000000-0000-0000-0000-00000000000c';
  INSERT INTO storage.objects (bucket_id, name) VALUES
    ('chat-media', 'account-' || acc || '/a.jpg'),
    ('chat-media', 'account-' || acc || '/b.jpg'),
    ('flow-media', 'account-' || acc || '/f.jpg');
  INSERT INTO webhook_endpoints (id, account_id, url, secret)
    VALUES ('00000000-0000-0000-0000-0000000000e1', acc, 'https://x.test', 's');
  INSERT INTO broadcasts (id, user_id, name, template_name, account_id)
    VALUES ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-00000000000a', 'b', 't', acc);
  INSERT INTO broadcast_recipients (id, broadcast_id) VALUES
    ('00000000-0000-0000-0000-0000000000c1', '00000000-0000-0000-0000-0000000000b1');
END $$;

-- ---------- como el viewer (authenticated) ----------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000b","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000b';

DO $$
BEGIN
  BEGIN
    UPDATE profiles SET email = 'nuevo.soporte@cabbity.com' WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FAIL C1: authenticated pudo cambiar profiles.email';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C1: UPDATE profiles SET email -> 42501';
  END;
  UPDATE profiles SET full_name = 'Nuevo nombre' WHERE user_id = auth.uid();
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL C1: full_name ya no se puede cambiar'; END IF;
  RAISE NOTICE 'PASS C1: full_name sigue editable';
END $$;

DO $$
BEGIN
  BEGIN
    INSERT INTO profiles (user_id, full_name, email, account_id, account_role)
    VALUES (auth.uid(), 'x', 'x', gen_random_uuid(), 'owner');
    RAISE EXCEPTION 'FAIL C2: authenticated pudo insertar en profiles';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C2: INSERT profiles -> 42501 (sin política)';
  END;
END $$;

DO $$
DECLARE fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'SELECT record_webhook_failure(''00000000-0000-0000-0000-0000000000e1'', 0)',
    'SELECT _bcast_bump(''00000000-0000-0000-0000-0000000000b1'', ''sent_count'', 100000)',
    'SELECT recompute_broadcast_counts(''00000000-0000-0000-0000-0000000000b1'')',
    'SELECT merge_duplicate_contacts()',
    'SELECT merge_duplicate_conversations()'
  ] LOOP
    BEGIN
      EXECUTE fn;
      RAISE EXCEPTION 'FAIL C3: authenticated ejecutó %', fn;
    EXCEPTION WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS C3: authenticated -> 42501 en %', fn;
    END;
  END LOOP;
END $$;

DO $$
DECLARE n int;
BEGIN
  DELETE FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media');
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C4: el viewer borró % objetos', n; END IF;
  UPDATE storage.objects SET name = name WHERE bucket_id = 'chat-media';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'FAIL C4: el viewer sobrescribió % objetos', n; END IF;
  BEGIN
    INSERT INTO storage.objects (bucket_id, name)
    SELECT 'chat-media', 'account-' || account_id || '/v.jpg' FROM profiles WHERE user_id = auth.uid();
    RAISE EXCEPTION 'FAIL C4: el viewer subió media';
  EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'PASS C4: viewer no puede subir, sobrescribir ni borrar media';
  END;
  SELECT count(*) INTO n FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media');
  IF n <> 3 THEN RAISE EXCEPTION 'FAIL C4: el viewer ya no lee su media (% filas)', n; END IF;
  RAISE NOTICE 'PASS C4: el viewer sigue leyendo (% objetos)', n;
END $$;

-- ---------- como anon ----------
SET LOCAL ROLE anon;
SET LOCAL request.jwt.claims = '{"role":"anon"}';
SET LOCAL request.jwt.claim.sub = '';
DO $$
BEGIN
  PERFORM record_webhook_failure('00000000-0000-0000-0000-0000000000e1', 0);
  RAISE EXCEPTION 'FAIL C3: anon ejecutó record_webhook_failure';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'PASS C3: anon -> 42501 en record_webhook_failure';
END $$;

-- ---------- como el agent (authenticated) ----------
SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
DO $$
DECLARE n int;
BEGIN
  DELETE FROM storage.objects WHERE bucket_id = 'chat-media' AND name LIKE '%/a.jpg';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C4: el agent no pudo borrar chat media (%)', n; END IF;
  DELETE FROM storage.objects WHERE bucket_id = 'flow-media';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'FAIL C4: el agent no pudo borrar flow media (%)', n; END IF;
  INSERT INTO storage.objects (bucket_id, name)
  SELECT 'chat-media', 'account-' || account_id || '/g.jpg' FROM profiles WHERE user_id = auth.uid();
  RAISE NOTICE 'PASS C4: el agent sube y borra media';
END $$;

-- ---------- service_role y triggers de difusión ----------
SET LOCAL ROLE service_role;
DO $$
DECLARE active boolean; sent int;
BEGIN
  PERFORM record_webhook_failure('00000000-0000-0000-0000-0000000000e1', 1);
  SELECT is_active INTO active FROM webhook_endpoints WHERE id = '00000000-0000-0000-0000-0000000000e1';
  IF active THEN RAISE EXCEPTION 'FAIL C3: service_role no pudo usar record_webhook_failure'; END IF;
  RAISE NOTICE 'PASS C3: service_role ejecuta record_webhook_failure';
  -- El webhook de Meta mueve el estado del destinatario con el rol de servicio;
  -- el trigger (SECURITY DEFINER) llama a _bcast_bump.
  UPDATE broadcast_recipients SET status = 'delivered' WHERE id = '00000000-0000-0000-0000-0000000000c1';
  SELECT sent_count INTO sent FROM broadcasts WHERE id = '00000000-0000-0000-0000-0000000000b1';
  IF sent <> 1 THEN RAISE EXCEPTION 'FAIL C3: el trigger de difusión no contó (sent_count=%)', sent; END IF;
  PERFORM recompute_broadcast_counts('00000000-0000-0000-0000-0000000000b1');
  RAISE NOTICE 'PASS C3: trigger de difusión cuenta (service_role), recompute ejecuta';
END $$;

SET LOCAL ROLE authenticated;
SET LOCAL request.jwt.claims = '{"sub":"00000000-0000-0000-0000-00000000000c","role":"authenticated"}';
SET LOCAL request.jwt.claim.sub = '00000000-0000-0000-0000-00000000000c';
DO $$
DECLARE sent int;
BEGIN
  -- Mismo trigger disparado por un usuario: sigue funcionando sin EXECUTE.
  UPDATE broadcast_recipients SET status = 'failed' WHERE id = '00000000-0000-0000-0000-0000000000c1';
  IF NOT FOUND THEN RAISE EXCEPTION 'FAIL C3: el agent no ve el destinatario'; END IF;
  RAISE NOTICE 'PASS C3: trigger de difusión disparado por authenticated sin error';
END $$;

ROLLBACK;
