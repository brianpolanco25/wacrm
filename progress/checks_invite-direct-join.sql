-- Verificación de i12.1 (invite-direct-join) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 090). Para correrlo:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/invitacion-directa
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_invite-direct-join.sql
--
-- Idempotencia (aplicar la 090 una segunda vez y volver a correr esto):
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/migrations/090_invite_direct_join.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_invite_direct_join: OK` o con la primera EXCEPTION.
--
--   §0 paridad del hash SQL con hashInviteToken (vector de invitations.test.ts).
--   §1 (R1 R2 R3 R21) alta con invite_token → perfil en A como agent, sin
--      cuenta ni suscripción propias, invitación aceptada por él, asientos
--      (miembros + pendientes) iguales.
--   §2 (R3 R4 R7) token usado, inexistente, caducado, numérico y de 129
--      caracteres → el INSERT en auth.users falla con su HINT y los conteos
--      de auth.users / accounts / profiles no cambian.
--   §3 (R5) el INSERT INTO profiles de la rama de invitación falla (provocado
--      con un trigger temporal: la FK profiles.user_id → auth.users impide
--      crear el perfil antes que el usuario) → el alta falla y no aparece
--      cuenta personal; la invitación sigue pendiente.
--   §4 (R6) alta sin invite_token y con invite_token null → cuenta personal
--      owner + semilla incomplete.
--   §5 (R13 R23) redeem del usuario de §1 → devuelve A sin tocar accepted_at;
--      ya miembro con otra invitación pendiente → devuelve A, sigue pendiente.
--   §6 (R16) rechazos de redeem con HINT: used, expired, not_found (22023);
--      has_data, shared_account (23505).
--   §7 (R29–R33) asientos según el plan.

BEGIN;

-- ---------------------------------------------------------------
-- Ayudantes (pg_temp: desaparecen con la sesión)
-- ---------------------------------------------------------------
CREATE FUNCTION pg_temp.h(p_token text) RETURNS text LANGUAGE sql AS $$
  SELECT encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
$$;

-- Alta en auth.users. Devuelve 'OK' o el HINT del rechazo (o el SQLSTATE).
CREATE FUNCTION pg_temp.signup(p_id uuid, p_email text, p_meta jsonb)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_hint text; v_state text;
BEGIN
  INSERT INTO auth.users (id, aud, role, email, raw_app_meta_data,
                          raw_user_meta_data, created_at, updated_at)
  VALUES (p_id, 'authenticated', 'authenticated', p_email, '{}', p_meta, now(), now());
  RETURN 'OK';
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RETURN COALESCE(NULLIF(v_hint, ''), 'state:' || v_state);
END;
$$;

-- redeem_invitation como `p_user`. Devuelve 'OK:<cuenta>' o '<sqlstate>:<hint>'.
CREATE FUNCTION pg_temp.redeem(p_user uuid, p_hash text)
RETURNS text LANGUAGE plpgsql AS $$
DECLARE v_acc uuid; v_hint text; v_state text;
BEGIN
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', p_user, 'role', 'authenticated')::text, true);
  -- La imagen local define auth.uid() sobre `request.jwt.claim.sub`.
  PERFORM set_config('request.jwt.claim.sub', p_user::text, true);
  v_acc := redeem_invitation(p_hash);
  RETURN 'OK:' || v_acc;
EXCEPTION WHEN OTHERS THEN
  GET STACKED DIAGNOSTICS v_hint = PG_EXCEPTION_HINT, v_state = RETURNED_SQLSTATE;
  RETURN v_state || ':' || COALESCE(v_hint, '');
END;
$$;

-- Asientos al EMITIR (mismo filtro que countSeats y el POST de invitaciones).
CREATE FUNCTION pg_temp.seats(p_acc uuid) RETURNS int LANGUAGE sql AS $$
  SELECT (SELECT count(*) FROM profiles WHERE account_id = p_acc)::int
       + (SELECT count(*) FROM account_invitations
          WHERE account_id = p_acc AND accepted_at IS NULL AND expires_at > now())::int;
$$;

CREATE FUNCTION pg_temp.members(p_acc uuid) RETURNS int LANGUAGE sql AS $$
  SELECT count(*)::int FROM profiles WHERE account_id = p_acc;
$$;

CREATE FUNCTION pg_temp.acc_of(p_user uuid) RETURNS uuid LANGUAGE sql AS $$
  SELECT account_id FROM profiles WHERE user_id = p_user;
$$;

DO $$
DECLARE
  -- dueños (alta normal → cuenta personal)
  u_a   uuid := '10900000-0000-4000-8000-00000000000a';
  u_b   uuid := '10900000-0000-4000-8000-00000000000b';
  u_c   uuid := '10900000-0000-4000-8000-00000000000c';
  u_d   uuid := '10900000-0000-4000-8000-00000000000d';
  -- invitados / otros
  u_1   uuid := '10900000-0000-4000-8000-000000000001';
  u_2   uuid := '10900000-0000-4000-8000-000000000002';
  u_3   uuid := '10900000-0000-4000-8000-000000000003';
  u_4   uuid := '10900000-0000-4000-8000-000000000004';
  u_5   uuid := '10900000-0000-4000-8000-000000000005';
  u_6   uuid := '10900000-0000-4000-8000-000000000006';
  u_7   uuid := '10900000-0000-4000-8000-000000000007';
  u_8   uuid := '10900000-0000-4000-8000-000000000008';
  u_9   uuid := '10900000-0000-4000-8000-000000000009';
  u_10  uuid := '10900000-0000-4000-8000-000000000010';
  u_11  uuid := '10900000-0000-4000-8000-000000000011';
  u_12  uuid := '10900000-0000-4000-8000-000000000012';
  u_13  uuid := '10900000-0000-4000-8000-000000000013';
  u_14  uuid := '10900000-0000-4000-8000-000000000014';
  u_15  uuid := '10900000-0000-4000-8000-000000000015';
  a uuid; b uuid; c uuid; d uuid;
  n_users int; n_accounts int; n_profiles int; n_subs int;
  s_before int;
  r text;
  v_acc uuid;
  v_at timestamptz;
  v_role text;
  v_inicio int;
  pk json;
BEGIN
  -- §0 paridad del hash ----------------------------------------------
  IF pg_temp.h('invite-token-abc')
     <> '51481b404112f61a4e1171ff116d52068c429737863181bef089df7cb607352f' THEN
    RAISE EXCEPTION '§0: sha256 en SQL no coincide con hashInviteToken';
  END IF;

  -- Cuentas de partida ------------------------------------------------
  IF pg_temp.signup(u_a, 'owner-a-090@example.test', '{"full_name":"Owner A"}') <> 'OK'
     OR pg_temp.signup(u_b, 'owner-b-090@example.test', '{"full_name":"Owner B"}') <> 'OK'
     OR pg_temp.signup(u_c, 'owner-c-090@example.test', '{"full_name":"Owner C"}') <> 'OK'
     OR pg_temp.signup(u_d, 'owner-d-090@example.test', '{"full_name":"Owner D"}') <> 'OK' THEN
    RAISE EXCEPTION 'setup: el alta normal falló';
  END IF;
  a := pg_temp.acc_of(u_a); b := pg_temp.acc_of(u_b);
  c := pg_temp.acc_of(u_c); d := pg_temp.acc_of(u_d);
  IF a IS NULL OR b IS NULL OR c IS NULL OR d IS NULL THEN
    RAISE EXCEPTION 'setup: el trigger de alta no creó las cuentas de prueba';
  END IF;

  -- Planes de prueba (se deshacen con el ROLLBACK).
  INSERT INTO plans (id, name, price_usd_month, limits, is_public)
  VALUES ('chk090_two', 'chk two', 0, '{"operators": 2}', false),
         ('chk090_one', 'chk one', 0, '{"operators": 1}', false),
         ('chk090_txt', 'chk txt', 0, '{"operators": "x"}', false);

  -- Invitaciones de A (plan inicio, 3 operadores).
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (a, pg_temp.h('chk090-tok-1'), 'agent',  now() + interval '7 days'),
    (a, pg_temp.h('chk090-tok-exp'), 'agent', now() - interval '1 minute'),
    (a, pg_temp.h('chk090-tok-r5'), 'viewer', now() + interval '7 days');

  -- §1 alta ligada a la invitación ------------------------------------
  s_before := pg_temp.seats(a);
  SELECT count(*) INTO n_subs FROM subscriptions;
  r := pg_temp.signup(u_1, 'agent-1-090@example.test',
                      '{"full_name":"Agent One","invite_token":"chk090-tok-1"}');
  IF r <> 'OK' THEN RAISE EXCEPTION '§1: el alta con invitación falló: %', r; END IF;
  SELECT account_id, account_role::text INTO v_acc, v_role FROM profiles WHERE user_id = u_1;
  IF v_acc IS DISTINCT FROM a OR v_role <> 'agent' THEN
    RAISE EXCEPTION '§1 (R1): perfil en % como %, se esperaba A como agent', v_acc, v_role;
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE owner_user_id = u_1) THEN
    RAISE EXCEPTION '§1 (R2): se creó una cuenta propia para el invitado';
  END IF;
  IF (SELECT count(*) FROM subscriptions) <> n_subs THEN
    RAISE EXCEPTION '§1 (R2): apareció una suscripción nueva';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account_invitations
                 WHERE token_hash = pg_temp.h('chk090-tok-1')
                   AND accepted_at IS NOT NULL AND accepted_by_user_id = u_1) THEN
    RAISE EXCEPTION '§1 (R3): la invitación no quedó aceptada por el invitado';
  END IF;
  IF pg_temp.seats(a) <> s_before THEN
    RAISE EXCEPTION '§1 (R21): asientos % → %', s_before, pg_temp.seats(a);
  END IF;

  -- §2 rechazos en el alta --------------------------------------------
  SELECT count(*) INTO n_users FROM auth.users;
  SELECT count(*) INTO n_accounts FROM accounts;
  SELECT count(*) INTO n_profiles FROM profiles;
  r := pg_temp.signup(u_2, 'x2-090@example.test', '{"invite_token":"chk090-tok-1"}');
  IF r <> 'used' THEN RAISE EXCEPTION '§2: token usado → %', r; END IF;
  r := pg_temp.signup(u_2, 'x2-090@example.test', '{"invite_token":"chk090-no-such"}');
  IF r <> 'not_found' THEN RAISE EXCEPTION '§2: token inexistente → %', r; END IF;
  r := pg_temp.signup(u_2, 'x2-090@example.test', '{"invite_token":"chk090-tok-exp"}');
  IF r <> 'expired' THEN RAISE EXCEPTION '§2: token caducado → %', r; END IF;
  r := pg_temp.signup(u_2, 'x2-090@example.test', '{"invite_token":123}');
  IF r <> 'not_found' THEN RAISE EXCEPTION '§2: token numérico → %', r; END IF;
  r := pg_temp.signup(u_2, 'x2-090@example.test',
                      jsonb_build_object('invite_token', repeat('x', 129)));
  IF r <> 'not_found' THEN RAISE EXCEPTION '§2: token de 129 caracteres → %', r; END IF;
  r := pg_temp.signup(u_2, 'x2-090@example.test', '{"invite_token":""}');
  IF r <> 'not_found' THEN RAISE EXCEPTION '§2: token vacío → %', r; END IF;
  IF (SELECT count(*) FROM auth.users) <> n_users
     OR (SELECT count(*) FROM accounts) <> n_accounts
     OR (SELECT count(*) FROM profiles) <> n_profiles THEN
    RAISE EXCEPTION '§2 (R4): un alta rechazada dejó usuario, cuenta o perfil';
  END IF;

  -- §3 fallo del INSERT INTO profiles en la rama de invitación ---------
  CREATE FUNCTION public.chk090_block_profile() RETURNS trigger LANGUAGE plpgsql AS $f$
  BEGIN
    IF NEW.email = 'r5-090@example.test' THEN
      RAISE EXCEPTION 'chk090: perfil bloqueado a propósito';
    END IF;
    RETURN NEW;
  END;
  $f$;
  CREATE TRIGGER chk090_block_profile BEFORE INSERT ON profiles
    FOR EACH ROW EXECUTE FUNCTION public.chk090_block_profile();
  r := pg_temp.signup(u_3, 'r5-090@example.test', '{"invite_token":"chk090-tok-r5"}');
  IF r = 'OK' THEN RAISE EXCEPTION '§3 (R5): el alta pasó con el perfil bloqueado'; END IF;
  IF EXISTS (SELECT 1 FROM auth.users WHERE id = u_3)
     OR EXISTS (SELECT 1 FROM accounts WHERE owner_user_id = u_3) THEN
    RAISE EXCEPTION '§3 (R5): quedó usuario o cuenta personal tras el fallo';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM account_invitations
                 WHERE token_hash = pg_temp.h('chk090-tok-r5') AND accepted_at IS NULL) THEN
    RAISE EXCEPTION '§3 (R5): la invitación se consumió aunque el alta falló';
  END IF;
  DROP TRIGGER chk090_block_profile ON profiles;
  DROP FUNCTION public.chk090_block_profile();

  -- §4 alta sin invitación: como siempre --------------------------------
  IF pg_temp.signup(u_4, 'plain-4-090@example.test', '{"full_name":"Plain"}') <> 'OK'
     OR pg_temp.signup(u_5, 'plain-5-090@example.test', '{"invite_token":null}') <> 'OK' THEN
    RAISE EXCEPTION '§4 (R6): el alta normal falló';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM profiles p JOIN accounts x ON x.id = p.account_id
                 JOIN subscriptions s ON s.account_id = x.id
                 WHERE p.user_id = u_4 AND p.account_role = 'owner'
                   AND x.owner_user_id = u_4 AND s.status = 'incomplete')
     OR NOT EXISTS (SELECT 1 FROM profiles p JOIN accounts x ON x.id = p.account_id
                    JOIN subscriptions s ON s.account_id = x.id
                    WHERE p.user_id = u_5 AND p.account_role = 'owner'
                      AND x.owner_user_id = u_5 AND s.status = 'incomplete') THEN
    RAISE EXCEPTION '§4 (R6): sin invitación no nació cuenta personal owner + incomplete';
  END IF;

  -- §5 redeem no-op para el ya miembro ---------------------------------
  SELECT accepted_at INTO v_at FROM account_invitations WHERE token_hash = pg_temp.h('chk090-tok-1');
  r := pg_temp.redeem(u_1, pg_temp.h('chk090-tok-1'));
  IF r <> 'OK:' || a THEN RAISE EXCEPTION '§5 (R13): redeem del recién nacido → %', r; END IF;
  IF (SELECT accepted_at FROM account_invitations WHERE token_hash = pg_temp.h('chk090-tok-1'))
     IS DISTINCT FROM v_at THEN
    RAISE EXCEPTION '§5 (R13): el no-op tocó accepted_at';
  END IF;
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
  VALUES (a, pg_temp.h('chk090-tok-pend'), 'admin', now() + interval '7 days');
  r := pg_temp.redeem(u_1, pg_temp.h('chk090-tok-pend'));
  IF r <> 'OK:' || a THEN RAISE EXCEPTION '§5 (R13): redeem de ya miembro → %', r; END IF;
  IF NOT EXISTS (SELECT 1 FROM account_invitations
                 WHERE token_hash = pg_temp.h('chk090-tok-pend') AND accepted_at IS NULL)
     OR (SELECT account_role::text FROM profiles WHERE user_id = u_1) <> 'agent' THEN
    RAISE EXCEPTION '§5 (R13): el no-op consumió la invitación o cambió el rol';
  END IF;

  -- §6 rechazos de redeem con HINT -------------------------------------
  -- u_4 tiene cuenta personal vacía (de §4).
  r := pg_temp.redeem(u_4, pg_temp.h('chk090-tok-1'));
  IF r <> '22023:used' THEN RAISE EXCEPTION '§6: used → %', r; END IF;
  r := pg_temp.redeem(u_4, pg_temp.h('chk090-tok-exp'));
  IF r <> '22023:expired' THEN RAISE EXCEPTION '§6: expired → %', r; END IF;
  r := pg_temp.redeem(u_4, pg_temp.h('chk090-nope'));
  IF r <> '22023:not_found' THEN RAISE EXCEPTION '§6: not_found → %', r; END IF;
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at)
  VALUES (b, pg_temp.h('chk090-tok-b'), 'agent', now() + interval '7 days');
  -- u_1 es agent de A (no dueño) → shared_account.
  r := pg_temp.redeem(u_1, pg_temp.h('chk090-tok-b'));
  IF r <> '23505:shared_account' THEN RAISE EXCEPTION '§6: shared_account → %', r; END IF;
  -- u_5: cuenta personal con historial de facturación → has_data.
  UPDATE subscriptions SET status = 'active' WHERE account_id = pg_temp.acc_of(u_5);
  r := pg_temp.redeem(u_5, pg_temp.h('chk090-tok-b'));
  IF r <> '23505:has_data' THEN RAISE EXCEPTION '§6: has_data → %', r; END IF;

  -- §7 asientos según el plan ------------------------------------------
  -- account_seat_limit: sin suscripción → inicio; numérico; ilimitado; no numérico.
  SELECT (limits->>'operators')::int INTO v_inicio FROM plans WHERE id = 'inicio';
  DELETE FROM usage_counters WHERE account_id = d;
  DELETE FROM subscriptions WHERE account_id = d;
  IF account_seat_limit(d) IS DISTINCT FROM v_inicio THEN
    RAISE EXCEPTION '§7 (R33): sin suscripción → %, se esperaba % (inicio)', account_seat_limit(d), v_inicio;
  END IF;
  UPDATE subscriptions SET plan_id = 'chk090_two' WHERE account_id = c;
  IF account_seat_limit(c) IS DISTINCT FROM 2 THEN
    RAISE EXCEPTION '§7 (R33): plan de 2 → %', account_seat_limit(c);
  END IF;
  UPDATE subscriptions SET plan_id = 'ilimitado' WHERE account_id = b;
  IF account_seat_limit(b) IS NOT NULL THEN
    RAISE EXCEPTION '§7 (R33): ilimitado → %', account_seat_limit(b);
  END IF;
  UPDATE subscriptions SET plan_id = 'chk090_txt' WHERE account_id = b;
  IF account_seat_limit(b) IS NOT NULL THEN
    RAISE EXCEPTION '§7 (R33): operators no numérico → %', account_seat_limit(b);
  END IF;
  UPDATE subscriptions SET plan_id = 'ilimitado' WHERE account_id = b;

  -- C en plan de 2: 1 miembro + 1 pendiente → el alta entra.
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (c, pg_temp.h('chk090-c1'), 'agent', now() + interval '7 days');
  IF pg_temp.seats(c) <> 2 THEN RAISE EXCEPTION '§7: seats(C) = %', pg_temp.seats(c); END IF;
  r := pg_temp.signup(u_6, 'c1-090@example.test', '{"invite_token":"chk090-c1"}');
  IF r <> 'OK' OR pg_temp.members(c) <> 2 THEN
    RAISE EXCEPTION '§7 (R30): alta con asiento libre → %, miembros %', r, pg_temp.members(c);
  END IF;

  -- El plan baja a 1 con otra invitación pendiente → no_seats, nada cambia.
  UPDATE subscriptions SET plan_id = 'chk090_one' WHERE account_id = c;
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (c, pg_temp.h('chk090-c2'), 'agent', now() + interval '7 days');
  SELECT count(*) INTO n_users FROM auth.users;
  SELECT count(*) INTO n_accounts FROM accounts;
  SELECT count(*) INTO n_profiles FROM profiles;
  r := pg_temp.signup(u_7, 'c2-090@example.test', '{"invite_token":"chk090-c2"}');
  IF r <> 'no_seats' THEN RAISE EXCEPTION '§7 (R30): plan lleno → %', r; END IF;
  IF (SELECT count(*) FROM auth.users) <> n_users
     OR (SELECT count(*) FROM accounts) <> n_accounts
     OR (SELECT count(*) FROM profiles) <> n_profiles
     OR NOT EXISTS (SELECT 1 FROM account_invitations
                    WHERE token_hash = pg_temp.h('chk090-c2') AND accepted_at IS NULL) THEN
    RAISE EXCEPTION '§7 (R30): el rechazo por asientos dejó rastro o consumió la invitación';
  END IF;

  -- peek de esa invitación → no_seats (R32).
  pk := peek_invitation(pg_temp.h('chk090-c2'));
  IF pk->>'ok' <> 'false' OR pk->>'reason' <> 'no_seats' THEN
    RAISE EXCEPTION '§7 (R32): peek → %', pk;
  END IF;
  -- y una con sitio sigue respondiendo ok (A, plan inicio).
  pk := peek_invitation(pg_temp.h('chk090-tok-pend'));
  IF pk->>'ok' <> 'true' THEN RAISE EXCEPTION '§7 (R32): peek con sitio → %', pk; END IF;

  -- redeem de un usuario existente con cuenta vacía → 22023 + no_seats (R31).
  IF pg_temp.signup(u_8, 'existing-8-090@example.test', '{}') <> 'OK' THEN
    RAISE EXCEPTION '§7: setup u_8';
  END IF;
  v_acc := pg_temp.acc_of(u_8);
  r := pg_temp.redeem(u_8, pg_temp.h('chk090-c2'));
  IF r <> '22023:no_seats' THEN RAISE EXCEPTION '§7 (R31): redeem con plan lleno → %', r; END IF;
  IF pg_temp.acc_of(u_8) IS DISTINCT FROM v_acc THEN
    RAISE EXCEPTION '§7 (R31): el redeem rechazado movió al usuario';
  END IF;

  -- Vuelve el plan de 2 y se quita un miembro → la misma invitación ya entra.
  UPDATE subscriptions SET plan_id = 'chk090_two' WHERE account_id = c;
  DELETE FROM profiles WHERE user_id = u_6;
  r := pg_temp.signup(u_9, 'c2b-090@example.test', '{"invite_token":"chk090-c2"}');
  IF r <> 'OK' OR pg_temp.acc_of(u_9) IS DISTINCT FROM c THEN
    RAISE EXCEPTION '§7 (R30): con asiento liberado → %', r;
  END IF;

  -- Plan ilimitado (B): sin límite aunque haya muchos.
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (b, pg_temp.h('chk090-b1'), 'agent', now() + interval '7 days'),
    (b, pg_temp.h('chk090-b2'), 'agent', now() + interval '7 days'),
    (b, pg_temp.h('chk090-b3'), 'agent', now() + interval '7 days');
  IF pg_temp.signup(u_10, 'b1-090@example.test', '{"invite_token":"chk090-b1"}') <> 'OK'
     OR pg_temp.signup(u_11, 'b2-090@example.test', '{"invite_token":"chk090-b2"}') <> 'OK'
     OR pg_temp.signup(u_12, 'b3-090@example.test', '{"invite_token":"chk090-b3"}') <> 'OK' THEN
    RAISE EXCEPTION '§7 (R30): el plan ilimitado limitó altas';
  END IF;

  -- R29: D en plan de 2, 1 miembro + 1 caducada → la caducada no ocupa.
  INSERT INTO subscriptions (account_id, plan_id, status)
  VALUES (d, 'chk090_two', 'active');
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (d, pg_temp.h('chk090-d-exp'), 'agent', now() - interval '1 day');
  IF pg_temp.seats(d) <> 1 THEN
    RAISE EXCEPTION '§7 (R29): la caducada cuenta como asiento (seats = %)', pg_temp.seats(d);
  END IF;
  r := pg_temp.signup(u_13, 'dexp-090@example.test', '{"invite_token":"chk090-d-exp"}');
  IF r <> 'expired' THEN RAISE EXCEPTION '§7 (R29): alta con caducada → %', r; END IF;
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (d, pg_temp.h('chk090-d2'), 'agent', now() + interval '7 days');
  IF pg_temp.seats(d) <> 2 THEN RAISE EXCEPTION '§7 (R29): seats(D) = %', pg_temp.seats(d); END IF;
  DELETE FROM account_invitations WHERE token_hash = pg_temp.h('chk090-d2');
  IF pg_temp.seats(d) <> 1 THEN
    RAISE EXCEPTION '§7 (R29): revocar no devolvió el asiento (seats = %)', pg_temp.seats(d);
  END IF;
  -- ...y la revocada ya no se puede consumir.
  r := pg_temp.signup(u_14, 'd2-090@example.test', '{"invite_token":"chk090-d2"}');
  IF r <> 'not_found' THEN RAISE EXCEPTION '§7 (R29): alta con revocada → %', r; END IF;

  -- Paso de un usuario existente con cuenta vacía cuando SÍ hay sitio (R31 contrapartida).
  IF pg_temp.signup(u_15, 'existing-15-090@example.test', '{}') <> 'OK' THEN
    RAISE EXCEPTION '§7: setup u_15';
  END IF;
  v_acc := pg_temp.acc_of(u_15);
  INSERT INTO account_invitations (account_id, token_hash, role, expires_at) VALUES
    (d, pg_temp.h('chk090-d3'), 'viewer', now() + interval '7 days');
  r := pg_temp.redeem(u_15, pg_temp.h('chk090-d3'));
  IF r <> 'OK:' || d OR EXISTS (SELECT 1 FROM accounts WHERE id = v_acc) THEN
    RAISE EXCEPTION '§7 (R31): redeem con sitio → % (o la cuenta personal no se borró)', r;
  END IF;

  RAISE NOTICE 'checks_invite_direct_join: OK';
END
$$;

ROLLBACK;
