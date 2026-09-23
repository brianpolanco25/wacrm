-- Verificación de a7.5 (`exports-v1`) contra el Postgres local que crea
-- scripts/replay-migrations.sh. Ejecutar después del replay con:
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_exports-v1.sql
--
-- Lo que un test con mocks NO puede ver y aquí sí:
--   A. los tres CHECK (`status`, `format`, `kind`) rechazan lo inventado
--      y `expires_at` nace a 7 días (S-A6) sin que nadie lo escriba;
--   B. la RLS: un miembro ve los encargos de SU cuenta y cero de la
--      ajena, y `authenticated` no puede crear, modificar ni borrar uno;
--   C. el bucket `exports` es PRIVADO y no hay una sola política de
--      `storage.objects` que lo nombre — la única lectura del archivo es
--      una URL firmada que acuña el rol de servicio;
--   D. el reclamo optimista del barrido es exclusivo de verdad bajo dos
--      UPDATE sobre la misma foto de la fila;
--   E. cascadas: borrar la clave de API no se lleva el encargo, borrar
--      la cuenta sí.

BEGIN;

-- ------------------------------------------------------------
-- Semilla: dos usuarios → dos cuentas personales (trigger de alta), una
-- clave de API por cuenta y un encargo por cuenta.
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('41000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'exp-a@example.test', '{}', '{"full_name":"EXP A"}', now(), now()),
  ('41000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
   'exp-b@example.test', '{}', '{"full_name":"EXP B"}', now(), now());

UPDATE profiles SET account_role = 'owner'
 WHERE user_id IN ('41000000-0000-4000-8000-000000000001',
                   '41000000-0000-4000-8000-000000000002');

CREATE TEMP TABLE t_acc AS
SELECT
  (SELECT account_id FROM public.profiles
    WHERE user_id = '41000000-0000-4000-8000-000000000001') AS a,
  (SELECT account_id FROM public.profiles
    WHERE user_id = '41000000-0000-4000-8000-000000000002') AS b;

INSERT INTO api_keys (id, account_id, created_by, name, key_prefix, key_hash, scopes)
SELECT 'a2000000-0000-4000-8000-00000000000a', a,
       '41000000-0000-4000-8000-000000000001', 'clave A',
       'wacrm_live_aaaa', 'hash-a', ARRAY['conversations:export'] FROM t_acc;
INSERT INTO api_keys (id, account_id, created_by, name, key_prefix, key_hash, scopes)
SELECT 'a2000000-0000-4000-8000-00000000000b', b,
       '41000000-0000-4000-8000-000000000002', 'clave B',
       'wacrm_live_bbbb', 'hash-b', ARRAY['conversations:export'] FROM t_acc;

INSERT INTO export_jobs (id, account_id, api_key_id, kind, format, params, status, file_path)
SELECT 'e2000000-0000-4000-8000-00000000000a', a,
       'a2000000-0000-4000-8000-00000000000a', 'conversations', 'json',
       '{"status":"closed"}'::jsonb, 'done', 'ruta-a/export.json' FROM t_acc;
INSERT INTO export_jobs (id, account_id, api_key_id, kind, format, params, status, file_path)
SELECT 'e2000000-0000-4000-8000-00000000000b', b,
       'a2000000-0000-4000-8000-00000000000b', 'conversations', 'csv',
       '{}'::jsonb, 'done', 'ruta-b/export.csv' FROM t_acc;

-- ------------------------------------------------------------
-- A. Los tres CHECK y el valor por defecto de la retención.
--    Sin el CHECK de `status`, un estado inventado ('paused') saldría
--    del filtro del barrido y el encargo se quedaría colgado en
--    silencio; sin `expires_at` a 7 días, la purga no tendría de dónde
--    agarrarse y el archivo viviría para siempre.
-- ------------------------------------------------------------
DO $$
DECLARE dias numeric;
BEGIN
  BEGIN
    UPDATE export_jobs SET status = 'paused'
     WHERE id = 'e2000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'A: el CHECK de status aceptó un estado inventado';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE export_jobs SET format = 'xlsx'
     WHERE id = 'e2000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'A: el CHECK de format aceptó xlsx';
  EXCEPTION WHEN check_violation THEN NULL; END;

  BEGIN
    UPDATE export_jobs SET kind = 'contacts'
     WHERE id = 'e2000000-0000-4000-8000-00000000000a';
    RAISE EXCEPTION 'A: el CHECK de kind aceptó un recurso no soportado';
  EXCEPTION WHEN check_violation THEN NULL; END;

  -- Los cuatro estados legítimos sí entran.
  UPDATE export_jobs SET status = 'queued'
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  UPDATE export_jobs SET status = 'running'
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  UPDATE export_jobs SET status = 'failed'
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  UPDATE export_jobs SET status = 'done'
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';

  SELECT EXTRACT(EPOCH FROM (expires_at - created_at)) / 86400 INTO dias
    FROM export_jobs WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  IF round(dias) <> 7 THEN
    RAISE EXCEPTION 'A: la retención por defecto es de % días, no 7', dias;
  END IF;
  RAISE NOTICE 'OK A — CHECKs de status/format/kind y retención de 7 días';
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
  updated INT;
  deleted INT;
  acc_a uuid;
BEGIN
  SELECT a INTO acc_a FROM t_acc;

  SET LOCAL ROLE authenticated;

  PERFORM set_config('request.jwt.claim.sub',
    '41000000-0000-4000-8000-000000000001', TRUE);
  SELECT count(*) INTO visible_to_a FROM export_jobs;

  PERFORM set_config('request.jwt.claim.sub',
    '41000000-0000-4000-8000-000000000002', TRUE);
  SELECT count(*) INTO visible_to_b FROM export_jobs WHERE account_id = acc_a;

  PERFORM set_config('request.jwt.claim.sub',
    '41000000-0000-4000-8000-000000000001', TRUE);

  -- Crear: sin política de INSERT, ni el dueño puede encargarse una
  -- exportación saltándose el cubo de rate limit de la API.
  BEGIN
    INSERT INTO export_jobs (account_id, kind, format)
    VALUES (acc_a, 'conversations', 'json');
    wrote := TRUE;
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;

  -- Modificar y borrar: sin políticas, un UPDATE/DELETE no encuentra
  -- ninguna fila que le deje tocar (Postgres no lanza; afecta 0).
  UPDATE export_jobs SET file_path = 'robado'
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS updated = ROW_COUNT;
  DELETE FROM export_jobs WHERE id = 'e2000000-0000-4000-8000-00000000000a';
  GET DIAGNOSTICS deleted = ROW_COUNT;

  RESET ROLE;

  IF visible_to_a <> 1 THEN
    RAISE EXCEPTION 'B: un miembro de A ve % encargos en vez de 1', visible_to_a;
  END IF;
  IF visible_to_b <> 0 THEN
    RAISE EXCEPTION 'B: un miembro de B ve % encargos de A', visible_to_b;
  END IF;
  IF wrote THEN
    RAISE EXCEPTION 'B: authenticated PUDO crear un encargo (no debería)';
  END IF;
  IF updated <> 0 OR deleted <> 0 THEN
    RAISE EXCEPTION 'B: authenticated modificó % y borró % filas', updated, deleted;
  END IF;
  RAISE NOTICE 'OK B — lectura acotada a la cuenta; escribir es solo del rol de servicio';
END $$;

-- ------------------------------------------------------------
-- C. El bucket. Privado y sin una sola política que lo nombre: el
--    archivo de un export es una copia plana de toda la mensajería de
--    una cuenta y la única vía de lectura es la URL firmada de 15 min.
-- ------------------------------------------------------------
DO $$
DECLARE es_publico boolean; politicas INT; limite bigint;
BEGIN
  SELECT public, file_size_limit INTO es_publico, limite
    FROM storage.buckets WHERE id = 'exports';
  IF es_publico IS DISTINCT FROM FALSE THEN
    RAISE EXCEPTION 'C: el bucket exports no es privado (public = %)', es_publico;
  END IF;
  IF limite IS NULL THEN
    RAISE EXCEPTION 'C: el bucket exports no tiene tope de tamaño';
  END IF;

  SELECT count(*) INTO politicas FROM pg_policies
   WHERE schemaname = 'storage' AND tablename = 'objects'
     AND (qual ILIKE '%''exports''%' OR with_check ILIKE '%''exports''%');
  IF politicas <> 0 THEN
    RAISE EXCEPTION 'C: % políticas de storage.objects nombran el bucket exports', politicas;
  END IF;
  RAISE NOTICE 'OK C — bucket privado, con tope y sin políticas de storage';
END $$;

-- ------------------------------------------------------------
-- D. El reclamo optimista del barrido. Dos procesos que leyeron la
--    MISMA foto (queued, started_at NULL) intentan reclamar; solo uno
--    puede afectar la fila. Sin esto, el `after()` de la petición y el
--    cron construirían el mismo archivo a la vez.
-- ------------------------------------------------------------
DO $$
DECLARE first_rows INT; second_rows INT; st text;
BEGIN
  UPDATE export_jobs SET status = 'queued', started_at = NULL
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';

  UPDATE export_jobs SET status = 'running', started_at = now()
   WHERE id = 'e2000000-0000-4000-8000-00000000000a'
     AND status = 'queued' AND started_at IS NULL;
  GET DIAGNOSTICS first_rows = ROW_COUNT;

  UPDATE export_jobs SET status = 'running', started_at = now()
   WHERE id = 'e2000000-0000-4000-8000-00000000000a'
     AND status = 'queued' AND started_at IS NULL;
  GET DIAGNOSTICS second_rows = ROW_COUNT;

  SELECT status INTO st FROM export_jobs
   WHERE id = 'e2000000-0000-4000-8000-00000000000a';

  IF first_rows <> 1 THEN
    RAISE EXCEPTION 'D: el primer reclamo afectó % filas', first_rows;
  END IF;
  IF second_rows <> 0 THEN
    RAISE EXCEPTION 'D: el segundo reclamo afectó % filas (doble trabajo)', second_rows;
  END IF;
  IF st <> 'running' THEN
    RAISE EXCEPTION 'D: el encargo quedó en % tras el reclamo', st;
  END IF;
  RAISE NOTICE 'OK D — el reclamo por (status, started_at) es exclusivo';
END $$;

-- ------------------------------------------------------------
-- E. Cascadas. La clave de API es trazabilidad: revocarla y borrarla no
--    puede llevarse por delante el encargo ni su archivo. La cuenta sí.
-- ------------------------------------------------------------
DO $$
DECLARE sigue INT; huerfanos INT; acc_b uuid;
BEGIN
  DELETE FROM api_keys WHERE id = 'a2000000-0000-4000-8000-00000000000a';
  SELECT count(*) INTO sigue FROM export_jobs
   WHERE id = 'e2000000-0000-4000-8000-00000000000a' AND api_key_id IS NULL;
  IF sigue <> 1 THEN
    RAISE EXCEPTION 'E: borrar la clave se llevó el encargo (o no anuló api_key_id)';
  END IF;

  SELECT b INTO acc_b FROM t_acc;
  -- La 041 deja `subscriptions`/`usage_counters` en RESTRICT a propósito
  -- (f0.2): se retiran primero para poder llegar a borrar la cuenta.
  DELETE FROM subscriptions WHERE account_id = acc_b;
  DELETE FROM usage_counters WHERE account_id = acc_b;
  DELETE FROM accounts WHERE id = acc_b;
  SELECT count(*) INTO huerfanos FROM export_jobs WHERE account_id = acc_b;
  IF huerfanos <> 0 THEN
    RAISE EXCEPTION 'E: quedaron % encargos tras borrar la cuenta', huerfanos;
  END IF;
  RAISE NOTICE 'OK E — la clave se puede borrar sin perder el encargo; la cuenta arrastra';
END $$;

ROLLBACK;
