-- Verificación de la migración 072 (s9.5 impersonation-write) contra el
-- Postgres local de scripts/replay-migrations.sh. Ejecutar tras el replay:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/platform-impersonation
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_impersonation-write.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_impersonation-write: OK` o con la primera EXCEPTION.
--
-- Lo que comprueba (lo que vitest no puede: vive en la RLS y en el trigger):
--   0. Las tablas abiertas y con trigger = SUPPORT_WRITABLE_TABLES (24; webhook_endpoints cerrada).
--   7. H1 (revisión): una sesión no mueve filas de A a otra empresa; si lo
--      intenta, se rechaza, y un DELETE en A deja rastro por OLD.
--   8. H2 (revisión): no puede haber dos sesiones abiertas del mismo
--      operador; y la fila se apunta a la sesión DE SU CUENTA.
--   1. Con sesión abierta sobre A, el operador ESCRIBE en contacts/tags/
--      contact_tags de A, y NO en B.
--   2. Ni con sesión: subscriptions, accounts, api_keys, account_invitations
--      de A siguen cerradas.
--   3. Cada escritura del operador en A queda en impersonation_actions
--      (source=db, log_id de su sesión); nada de B, nada de su propia cuenta.
--   4. Sin sesión (cerrada, caducada, operador revocado): nada.
--   5. El rol de servicio escribe sin dejar filas de soporte (CP11).
--   6. RLS de impersonation_actions: el operador lee, nadie escribe desde el
--      cliente, el dueño de la cuenta no lee. FK RESTRICT hacia la bitácora.

BEGIN;

-- 0. Las tablas que la 072 abrió al soporte son EXACTAMENTE las de
--    SUPPORT_WRITABLE_TABLES (src/lib/auth/support-scope.ts), y todas llevan
--    el trigger de auditoría. Si esta lista cambia, cambia en los dos sitios.
DO $$
DECLARE
  expected text[] := ARRAY[
    'ai_configs','ai_knowledge_chunks','ai_knowledge_documents','automation_steps',
    'automations','broadcast_recipients','broadcasts','contact_custom_values',
    'contact_notes','contact_tags','contacts','conversations','custom_fields','deals',
    'flow_nodes','flows','message_reactions','message_templates','messages',
    'pipeline_stages','pipelines','quick_replies','tags',
    'whatsapp_config'];
  opened text[];
  triggered text[];
BEGIN
  SELECT array_agg(DISTINCT tablename ORDER BY tablename) INTO opened
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd <> 'SELECT'
     AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%can_write_account(%';
  SELECT array_agg(c.relname::text ORDER BY c.relname) INTO triggered
    FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
   WHERE t.tgname = 'record_support_write' AND NOT t.tgisinternal;
  IF (SELECT array_agg(c.relname::text ORDER BY c.relname)
        FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
       WHERE t.tgname = 'forbid_support_account_move' AND NOT t.tgisinternal)
     IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'forbid_support_account_move no está exactamente en las tablas abiertas';
  END IF;
  IF opened IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'tablas abiertas al soporte % <> esperadas %', opened, expected;
  END IF;
  IF triggered IS DISTINCT FROM expected THEN
    RAISE EXCEPTION 'tablas con trigger % <> esperadas %', triggered, expected;
  END IF;
END
$$;

-- Operador O (con su propia empresa), dueños de A y de B. handle_new_user()
-- crea la cuenta y el perfil owner de cada uno.
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('72000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'op-72@example.test',      '{}', '{"full_name":"Operator"}', now(), now()),
  ('72000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-a-72@example.test', '{}', '{"full_name":"Owner A"}',  now(), now()),
  ('72000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'owner-b-72@example.test', '{}', '{"full_name":"Owner B"}',  now(), now());

INSERT INTO public.platform_admins (user_id, granted_by, note)
VALUES ('72000000-0000-4000-8000-000000000001', '72000000-0000-4000-8000-000000000001', 'checks 072');

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '72000000-0000-4000-8000-000000000001') AS op_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '72000000-0000-4000-8000-000000000002') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '72000000-0000-4000-8000-000000000003') AS b_acc;
GRANT SELECT ON ids TO authenticated;

-- Un contacto en A y otro en B, escritos por el rol de servicio: no dejan
-- filas de soporte (auth.uid() es NULL).
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '72000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-000000000002', a_acc, '+10000000001', 'A1' FROM ids;
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '72000000-0000-4000-8000-0000000000b1', '72000000-0000-4000-8000-000000000003', b_acc, '+10000000002', 'B1' FROM ids;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.impersonation_actions) THEN
    RAISE EXCEPTION 'el rol de servicio dejó filas en impersonation_actions';
  END IF;
END
$$;

-- La sesión de soporte de O sobre A, como la abre /api/platform/impersonate.
INSERT INTO public.impersonation_log (id, actor_user_id, account_id, account_name, reason, expires_at)
SELECT '72000000-0000-4000-8000-0000000000ff', '72000000-0000-4000-8000-000000000001', a_acc,
       'Cuenta A', 'ticket 72: el cliente no puede crear etiquetas', now() + interval '30 minutes'
FROM ids;

-- ============================================================
-- 1-3. Con sesión abierta, como el operador
-- ============================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $$
DECLARE
  a uuid; b uuid; op uuid; n int;
BEGIN
  SELECT a_acc, b_acc, op_acc INTO a, b, op FROM ids;

  -- 1. Escribe en A.
  INSERT INTO public.contacts (id, user_id, account_id, phone, name)
  VALUES ('72000000-0000-4000-8000-0000000000a2', '72000000-0000-4000-8000-000000000001', a, '+10000000003', 'A2 by support');

  UPDATE public.contacts SET name = 'A1 fixed' WHERE id = '72000000-0000-4000-8000-0000000000a1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 1 THEN RAISE EXCEPTION 'el operador no pudo actualizar el contacto de A (% filas)', n; END IF;

  INSERT INTO public.tags (id, user_id, account_id, name)
  VALUES ('72000000-0000-4000-8000-0000000000c1', '72000000-0000-4000-8000-000000000001', a, 'soporte-72');

  -- Tabla hija, por su padre.
  INSERT INTO public.contact_tags (contact_id, tag_id)
  VALUES ('72000000-0000-4000-8000-0000000000a1', '72000000-0000-4000-8000-0000000000c1');

  -- ...y NO en B.
  BEGIN
    INSERT INTO public.contacts (user_id, account_id, phone)
    VALUES ('72000000-0000-4000-8000-000000000001', b, '+10000000004');
    RAISE EXCEPTION 'el operador escribió un contacto en B sin sesión sobre B';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.contacts SET name = 'pwned' WHERE id = '72000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'el operador actualizó un contacto de B'; END IF;
  DELETE FROM public.contacts WHERE id = '72000000-0000-4000-8000-0000000000b1';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'el operador borró un contacto de B'; END IF;

  -- 2. Lo que sigue cerrado con sesión.
  BEGIN
    INSERT INTO public.subscriptions (account_id, plan_id, status) VALUES (a, 'pro', 'active');
    RAISE EXCEPTION 'el operador escribió en subscriptions de A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  UPDATE public.subscriptions SET status = 'active' WHERE account_id = a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'el operador actualizó subscriptions de A'; END IF;

  UPDATE public.accounts SET name = 'renamed by support' WHERE id = a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'el operador renombró la cuenta A'; END IF;

  BEGIN
    INSERT INTO public.api_keys (account_id, name, key_prefix, key_hash)
    VALUES (a, 'backdoor', 'wacrm_x', 'hash');
    RAISE EXCEPTION 'el operador creó una clave de API en A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  BEGIN
    INSERT INTO public.account_invitations (account_id, token_hash, role, expires_at)
    VALUES (a, 'hash-72', 'admin', now() + interval '1 day');
    RAISE EXCEPTION 'el operador creó una invitación en A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Rol efectivo admin: nada que pida owner.
  IF public.can_write_account(a, 'owner') THEN
    RAISE EXCEPTION 'can_write_account concede owner a la sesión de soporte';
  END IF;
  IF NOT public.can_write_account(a, 'admin') THEN
    RAISE EXCEPTION 'can_write_account no concede admin a la sesión de soporte';
  END IF;
  IF public.can_write_account(b, 'viewer') THEN
    RAISE EXCEPTION 'can_write_account concede B sin sesión sobre B';
  END IF;

  -- Su propia empresa: la escribe como miembro, y no es acción de soporte.
  INSERT INTO public.tags (user_id, account_id, name)
  VALUES ('72000000-0000-4000-8000-000000000001', op, 'mine-72');

  -- 3. La bitácora (el operador la LEE: es platform admin).
  SELECT count(*) INTO n FROM public.impersonation_actions
   WHERE log_id = '72000000-0000-4000-8000-0000000000ff' AND source = 'db' AND account_id = a;
  -- contacts INSERT + UPDATE, tags INSERT, contact_tags INSERT
  IF n <> 4 THEN RAISE EXCEPTION 'se esperaban 4 acciones db en A, hay %', n; END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_actions
     WHERE method = 'POST' AND path = 'db:contacts/72000000-0000-4000-8000-0000000000a2'
       AND actor_user_id = '72000000-0000-4000-8000-000000000001'
  ) THEN
    RAISE EXCEPTION 'el alta del contacto no quedó con método y ruta';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_actions
     WHERE method = 'PATCH' AND path = 'db:contacts/72000000-0000-4000-8000-0000000000a1'
  ) THEN
    RAISE EXCEPTION 'la edición del contacto no quedó registrada como PATCH';
  END IF;
  IF EXISTS (SELECT 1 FROM public.impersonation_actions WHERE account_id IS DISTINCT FROM a) THEN
    RAISE EXCEPTION 'hay acciones de soporte fuera de A (B o la cuenta del operador)';
  END IF;

  -- 6. Nadie escribe la bitácora desde el cliente, ni el operador.
  BEGIN
    INSERT INTO public.impersonation_actions (log_id, actor_user_id, account_id, method, path)
    VALUES ('72000000-0000-4000-8000-0000000000ff', '72000000-0000-4000-8000-000000000001', a, 'POST', '/forged');
    RAISE EXCEPTION 'el operador insertó en impersonation_actions desde el cliente';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  DELETE FROM public.impersonation_actions;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'el operador borró su propia bitácora de acciones'; END IF;
END
$$;
RESET ROLE;

-- ============================================================
-- 7. H1: sacar una fila de A no se puede, y si algo cambia en A por OLD,
--    queda rastro. (Sigue la misma sesión de O sobre A.)
-- ============================================================
-- Un contacto propio del operador, para el caso de la tabla hija.
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '72000000-0000-4000-8000-0000000000e1', '72000000-0000-4000-8000-000000000001', op_acc, '+10000000010', 'Mine' FROM ids;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
DECLARE
  a uuid; op uuid; n int; before int;
BEGIN
  SELECT a_acc, op_acc INTO a, op FROM ids;
  SELECT count(*) INTO before FROM public.impersonation_actions;

  -- El UPDATE exacto de la revisión: mover el contacto de A a la empresa
  -- del operador.
  BEGIN
    UPDATE public.contacts SET account_id = op
     WHERE id = '72000000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'H1: la sesión sacó un contacto de A a la empresa del operador';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF (SELECT account_id FROM public.contacts WHERE id = '72000000-0000-4000-8000-0000000000a1') IS DISTINCT FROM a THEN
    RAISE EXCEPTION 'H1: el contacto ya no está en A';
  END IF;

  -- Tabla hija: pasar la etiqueta de A a un contacto del operador.
  BEGIN
    UPDATE public.contact_tags SET contact_id = '72000000-0000-4000-8000-0000000000e1'
     WHERE contact_id = '72000000-0000-4000-8000-0000000000a1';
    RAISE EXCEPTION 'H1: la sesión movió una contact_tag de A a otra empresa';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Al revés: meter en A un contacto propio del operador también se rechaza
  -- (la cuenta nueva tiene sesión abierta).
  BEGIN
    UPDATE public.contacts SET account_id = a
     WHERE id = '72000000-0000-4000-8000-0000000000e1';
    RAISE EXCEPTION 'H1: la sesión metió en A un contacto de la empresa del operador';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;

  -- Nada de lo rechazado dejó filas (se deshizo con la sentencia).
  SELECT count(*) INTO n FROM public.impersonation_actions;
  IF n <> before THEN RAISE EXCEPTION 'H1: una sentencia rechazada dejó rastro'; END IF;

  -- Un DELETE en A se apunta por OLD.
  DELETE FROM public.contacts WHERE id = '72000000-0000-4000-8000-0000000000a2';
  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_actions
     WHERE method = 'DELETE' AND path = 'db:contacts/72000000-0000-4000-8000-0000000000a2'
       AND account_id = a AND log_id = '72000000-0000-4000-8000-0000000000ff'
  ) THEN
    RAISE EXCEPTION 'H1: el borrado en A no dejó rastro';
  END IF;

  -- webhook_endpoints se cerró al soporte (decisión del líder).
  BEGIN
    INSERT INTO public.webhook_endpoints (account_id, url, secret, events)
    VALUES (a, 'https://exfil.example/hook', 'secret', ARRAY['message.received']);
    RAISE EXCEPTION 'el operador creó un webhook saliente en A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  IF EXISTS (
    SELECT 1 FROM pg_policies WHERE tablename = 'webhook_endpoints'
      AND (COALESCE(qual,'') || COALESCE(with_check,'')) LIKE '%can_write_account%'
  ) THEN
    RAISE EXCEPTION 'webhook_endpoints sigue abierta al soporte';
  END IF;
END
$$;
RESET ROLE;

-- ============================================================
-- 8. H2: dos sesiones abiertas del mismo operador no pueden existir, y la
--    fila se apunta a la sesión DE SU CUENTA.
-- ============================================================
DO $$
BEGIN
  BEGIN
    INSERT INTO public.impersonation_log (actor_user_id, account_id, account_name, reason, expires_at)
    SELECT '72000000-0000-4000-8000-000000000001', b_acc, 'Cuenta B',
           'ticket 73: segunda sesión en incógnito', now() + interval '30 minutes'
    FROM ids;
    RAISE EXCEPTION 'H2: se abrió una segunda sesión con la primera abierta';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
END
$$;

-- Aunque la base llegara a tener dos (índice quitado a mano), la fila de A
-- va a la sesión de A, no a la más reciente del operador.
DROP INDEX public.uq_impersonation_log_one_open_session;
INSERT INTO public.impersonation_log (id, actor_user_id, account_id, account_name, reason, expires_at, started_at)
SELECT '72000000-0000-4000-8000-0000000000fe', '72000000-0000-4000-8000-000000000001', b_acc,
       'Cuenta B', 'ticket 73: segunda sesión en incógnito', now() + interval '30 minutes', now() + interval '1 second'
FROM ids;
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
BEGIN
  UPDATE public.contacts SET name = 'A1 edited while B is open'
   WHERE id = '72000000-0000-4000-8000-0000000000a1';
  IF NOT EXISTS (
    SELECT 1 FROM public.impersonation_actions
     WHERE path = 'db:contacts/72000000-0000-4000-8000-0000000000a1'
       AND method = 'PATCH' AND log_id = '72000000-0000-4000-8000-0000000000ff'
     GROUP BY log_id HAVING count(*) >= 2
  ) THEN
    RAISE EXCEPTION 'H2: la edición en A con la sesión de B abierta no dejó rastro en la sesión de A';
  END IF;
  IF EXISTS (
    SELECT 1 FROM public.impersonation_actions WHERE log_id = '72000000-0000-4000-8000-0000000000fe'
  ) THEN
    RAISE EXCEPTION 'H2: la edición en A se apuntó a la sesión de B';
  END IF;
END
$$;
RESET ROLE;
DELETE FROM public.impersonation_log WHERE id = '72000000-0000-4000-8000-0000000000fe';
CREATE UNIQUE INDEX uq_impersonation_log_one_open_session
  ON public.impersonation_log(actor_user_id)
  WHERE action = 'impersonation' AND ended_at IS NULL;

-- ============================================================
-- 6. El dueño de A no lee la bitácora de lo que se hizo en su cuenta.
-- ============================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000002","role":"authenticated"}', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.impersonation_actions) THEN
    RAISE EXCEPTION 'el dueño de la cuenta lee impersonation_actions';
  END IF;
END
$$;
RESET ROLE;

-- FK RESTRICT: la sesión no se borra mientras tenga acciones.
DO $$
BEGIN
  BEGIN
    DELETE FROM public.impersonation_log WHERE id = '72000000-0000-4000-8000-0000000000ff';
    RAISE EXCEPTION 'se borró una sesión con acciones registradas';
  EXCEPTION WHEN foreign_key_violation THEN NULL;
  END;
END
$$;

-- ============================================================
-- 4. Sin sesión: caducada, cerrada, operador revocado.
-- ============================================================
CREATE OR REPLACE FUNCTION pg_temp.op_can_insert_in_a() RETURNS boolean
LANGUAGE plpgsql AS $$
DECLARE a uuid;
BEGIN
  SELECT a_acc INTO a FROM ids;
  INSERT INTO public.contacts (user_id, account_id, phone)
  VALUES ('72000000-0000-4000-8000-000000000001', a, '+10000000099');
  RETURN true;
EXCEPTION WHEN insufficient_privilege THEN
  RETURN false;
END
$$;

-- caducada
UPDATE public.impersonation_log SET expires_at = now() - interval '1 second'
 WHERE id = '72000000-0000-4000-8000-0000000000ff';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$ BEGIN
  IF pg_temp.op_can_insert_in_a() THEN RAISE EXCEPTION 'escribe en A con la sesión caducada'; END IF;
END $$;
RESET ROLE;

-- cerrada (salida manual)
UPDATE public.impersonation_log SET expires_at = now() + interval '30 minutes', ended_at = now(), ended_reason = 'manual'
 WHERE id = '72000000-0000-4000-8000-0000000000ff';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$ BEGIN
  IF pg_temp.op_can_insert_in_a() THEN RAISE EXCEPTION 'escribe en A con la sesión cerrada'; END IF;
END $$;
RESET ROLE;

-- abierta otra vez, pero operador revocado
UPDATE public.impersonation_log SET ended_at = NULL, ended_reason = NULL
 WHERE id = '72000000-0000-4000-8000-0000000000ff';
DELETE FROM public.platform_admins WHERE user_id = '72000000-0000-4000-8000-000000000001';
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$ BEGIN
  IF pg_temp.op_can_insert_in_a() THEN RAISE EXCEPTION 'escribe en A un operador revocado'; END IF;
END $$;
RESET ROLE;

-- Un usuario normal, sin sesión de nada, tampoco (control).
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '72000000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claims', '{"sub":"72000000-0000-4000-8000-000000000003","role":"authenticated"}', true);
DO $$
DECLARE a uuid;
BEGIN
  SELECT a_acc INTO a FROM ids;
  BEGIN
    INSERT INTO public.contacts (user_id, account_id, phone)
    VALUES ('72000000-0000-4000-8000-000000000003', a, '+10000000098');
    RAISE EXCEPTION 'el dueño de B escribió en A';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

-- 5. Y lo que escribió el rol de servicio en todo esto: cero filas de soporte.
DO $$
BEGIN
  -- 4 del bloque 3 + el DELETE del 7 + el PATCH del 8.
  IF (SELECT count(*) FROM public.impersonation_actions) <> 6 THEN
    RAISE EXCEPTION 'la bitácora de acciones cambió fuera de la sesión (% filas)',
      (SELECT count(*) FROM public.impersonation_actions);
  END IF;
  RAISE NOTICE 'checks_impersonation-write: OK';
END
$$;

ROLLBACK;
