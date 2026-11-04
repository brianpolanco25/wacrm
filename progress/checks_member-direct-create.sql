-- Verificación de i12.2 (member-direct-create) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 093 + trigger 090). Para correrlo:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/miembro-directo
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_member-direct-create.sql
--
-- Idempotencia de la migración (aplicar la 093 una segunda vez):
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/migrations/093_platform_member_create.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_member_direct_create: OK` o con la primera EXCEPTION.
--
--   §0 (R22) el cuerpo de la 093 se reaplica sin error dentro de la
--      transacción (DROP IF EXISTS + ADD).
--   §1 (R22) `member_create` entra en impersonation_log; las acciones de la
--      087 siguen entrando; una inventada falla con 23514.
--   §2 (R23) lo que hace GoTrue con createUser + email_confirm: INSERT en
--      auth.users con email_confirmed_at y {"full_name","invite_token"} de
--      una invitación viewer de E → perfil en E viewer con full_name, sin
--      cuenta propia, invitación aceptada por él, email confirmado.
--   §3 (R24b) misma alta con E llena (plan de 1 operador, el dueño ya lo
--      ocupa) → el INSERT falla y los conteos de auth.users / profiles /
--      accounts no cambian; la invitación sigue pendiente.

BEGIN;

-- §0 -----------------------------------------------------------------
ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN (
    'impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite',
    'operator_grant', 'operator_revoke',
    'payment_confirmed', 'statement_void',
    'password_set', 'member_create'
  ));

CREATE FUNCTION pg_temp.h(p_token text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

-- La columna de «email confirmado» en el auth.users de la imagen local.
-- GoTrue actual escribe `email_confirmed_at`; el esquema auth inicial de
-- supabase/postgres (el que monta replay-migrations.sh) solo trae
-- `confirmed_at`. El trigger 090 no lee ninguna de las dos: se pone la que
-- exista para que la fila se parezca a la de createUser + email_confirm.
CREATE FUNCTION pg_temp.confirmed_col() RETURNS text LANGUAGE sql AS $$
  SELECT CASE WHEN EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'auth' AND table_name = 'users'
      AND column_name = 'email_confirmed_at')
  THEN 'email_confirmed_at' ELSE 'confirmed_at' END;
$$;

-- Alta en auth.users, confirmada o no. Devuelve 'OK' o el HINT / SQLSTATE.
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text, p_meta jsonb,
                               p_confirmed boolean)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_hint text; v_state text;
BEGIN
  EXECUTE format(
    'INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data,
                             raw_user_meta_data, %I, created_at, updated_at)
     VALUES ($1, ''authenticated'', ''authenticated'', $2, ''{}'', $3,
             CASE WHEN $4 THEN now() END, now(), now())',
    pg_temp.confirmed_col())
  USING p_id, p_email, p_meta, p_confirmed;
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RETURN COALESCE(NULLIF(v_hint, ''), 'state:' || v_state);
END;
$$;

-- Inserta una línea de bitácora. Devuelve 'OK' o el SQLSTATE.
CREATE FUNCTION pg_temp.log(p_action text, p_actor uuid, p_acc uuid)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_state text;
BEGIN
  INSERT INTO impersonation_log (actor_user_id, account_id, account_name,
                                 reason, expires_at, action)
  VALUES (p_actor, p_acc, 'chk093', 'check de la migración 093', now(), p_action);
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_state = RETURNED_SQLSTATE;
  RETURN v_state;
END;
$$;

DO $$
DECLARE
  u_e   uuid := '10930000-0000-4000-8000-00000000000e';
  u_1   uuid := '10930000-0000-4000-8000-000000000001';
  u_2   uuid := '10930000-0000-4000-8000-000000000002';
  e uuid;
  n_users int; n_accounts int; n_profiles int;
  r text;
  a text;
  v_prof record;
  v_inv record;
  v_ok boolean;
BEGIN
  -- Empresa E (alta normal: el dueño nace con cuenta propia).
  IF pg_temp.signup(u_e, 'owner-e-093@example.test', '{"full_name":"Owner E"}', true) <> 'OK' THEN
    RAISE EXCEPTION 'setup: el alta del dueño de E falló';
  END IF;
  SELECT account_id INTO e FROM profiles WHERE user_id = u_e;
  IF e IS NULL THEN RAISE EXCEPTION 'setup: E sin cuenta'; END IF;

  -- §1 bitácora -------------------------------------------------------
  IF pg_temp.log('member_create', u_e, e) <> 'OK' THEN
    RAISE EXCEPTION '§1 (R22): member_create no entra en impersonation_log';
  END IF;
  FOREACH a IN ARRAY ARRAY['impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite', 'operator_grant',
    'operator_revoke', 'payment_confirmed', 'statement_void', 'password_set'] LOOP
    IF pg_temp.log(a, u_e, e) <> 'OK' THEN
      RAISE EXCEPTION '§1 (R22): la acción % de la 087 dejó de entrar', a;
    END IF;
  END LOOP;
  r := pg_temp.log('member_nope', u_e, e);
  IF r <> '23514' THEN
    RAISE EXCEPTION '§1 (R22): una acción inventada → %, se esperaba 23514', r;
  END IF;

  -- §2 alta confirmada con invite_token -------------------------------
  INSERT INTO plans (id, name, price_usd_month, limits, is_public)
  VALUES ('chk093_three', 'chk three', 0, '{"operators": 3}', false),
         ('chk093_one',   'chk one',   0, '{"operators": 1}', false);
  UPDATE subscriptions SET plan_id = 'chk093_three' WHERE account_id = e;

  INSERT INTO account_invitations (account_id, token_hash, role,
                                   created_by_user_id, label, expires_at)
  VALUES (e, pg_temp.h('chk093-tok-1'), 'viewer', u_e, 'ana-093@example.test',
          now() + interval '1 day');

  SELECT count(*) INTO n_accounts FROM accounts;
  r := pg_temp.signup(u_1, 'ana-093@example.test',
         '{"full_name":"Ana","invite_token":"chk093-tok-1"}', true);
  IF r <> 'OK' THEN
    RAISE EXCEPTION '§2 (R23): el alta confirmada con token falló: %', r;
  END IF;
  SELECT account_id, account_role::text AS role, full_name
    INTO v_prof FROM profiles WHERE user_id = u_1;
  IF v_prof.account_id IS DISTINCT FROM e OR v_prof.role <> 'viewer'
     OR v_prof.full_name IS DISTINCT FROM 'Ana' THEN
    RAISE EXCEPTION '§2 (R23): perfil = (%, %, %), se esperaba (E, viewer, Ana)',
      v_prof.account_id, v_prof.role, v_prof.full_name;
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE owner_user_id = u_1)
     OR (SELECT count(*) FROM accounts) <> n_accounts THEN
    RAISE EXCEPTION '§2 (R23): el miembro creado tiene cuenta propia';
  END IF;
  SELECT accepted_at, accepted_by_user_id INTO v_inv
    FROM account_invitations WHERE token_hash = pg_temp.h('chk093-tok-1');
  IF v_inv.accepted_at IS NULL OR v_inv.accepted_by_user_id IS DISTINCT FROM u_1 THEN
    RAISE EXCEPTION '§2 (R23): la invitación no quedó aceptada por él';
  END IF;
  EXECUTE format('SELECT %I IS NOT NULL FROM auth.users WHERE id = $1',
                 pg_temp.confirmed_col())
    INTO STRICT v_ok USING u_1;
  IF NOT v_ok THEN
    RAISE EXCEPTION '§2 (R23): el usuario no quedó confirmado';
  END IF;

  -- §3 empresa llena: el alta se aborta entera -------------------------
  UPDATE subscriptions SET plan_id = 'chk093_one' WHERE account_id = e;
  DELETE FROM profiles WHERE user_id = u_1;  -- E vuelve a 1 miembro (el dueño), su plan admite 1
  INSERT INTO account_invitations (account_id, token_hash, role,
                                   created_by_user_id, label, expires_at)
  VALUES (e, pg_temp.h('chk093-tok-2'), 'agent', u_e, 'beto-093@example.test',
          now() + interval '1 day');
  SELECT count(*) INTO n_users FROM auth.users;
  SELECT count(*) INTO n_profiles FROM profiles;
  SELECT count(*) INTO n_accounts FROM accounts;
  r := pg_temp.signup(u_2, 'beto-093@example.test',
         '{"full_name":"Beto","invite_token":"chk093-tok-2"}', true);
  IF r = 'OK' THEN
    RAISE EXCEPTION '§3 (R24b): con E llena el alta entró';
  END IF;
  RAISE NOTICE '§3: alta rechazada con %', r;
  IF (SELECT count(*) FROM auth.users) <> n_users
     OR (SELECT count(*) FROM profiles) <> n_profiles
     OR (SELECT count(*) FROM accounts) <> n_accounts
     OR EXISTS (SELECT 1 FROM auth.users WHERE id = u_2) THEN
    RAISE EXCEPTION '§3 (R24b): el alta rechazada dejó usuario, perfil o cuenta';
  END IF;
  IF (SELECT accepted_at FROM account_invitations
      WHERE token_hash = pg_temp.h('chk093-tok-2')) IS NOT NULL THEN
    RAISE EXCEPTION '§3 (R24b): la invitación quedó aceptada';
  END IF;

  RAISE NOTICE 'checks_member_direct_create: OK';
END
$$;

ROLLBACK;
