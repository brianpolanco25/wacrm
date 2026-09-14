-- ============================================================
-- checks_enforce-limits.sql — f3.4 (fase 3 §4/§5)
--
-- Lo que no se puede comprobar con vitest: la semilla de pruebas de la
-- 046 contra una base real y, sobre todo, que `redeem_invitation()`
-- siga funcionando con esa semilla puesta (la 052).
--
-- Cómo correrlo:
--
--   KEEP=1 scripts/replay-migrations.sh \
--     /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/fase-3
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 -q < progress/checks_enforce-limits.sql
--
-- Salida silenciosa = todo pasó. Cualquier RAISE EXCEPTION aborta.
-- Cada parte va en su propia transacción y termina en ROLLBACK: la base
-- queda como estaba.
--
-- Las cuentas se crean SIEMPRE por el camino real — un INSERT en
-- `auth.users`, que dispara `handle_new_user()` (017) y con ella el
-- trigger de la 046. Crear la fila de `accounts` a mano no probaría el
-- camino que recorre un alta de verdad (y además `accounts.owner_user_id`
-- tiene FK contra `auth.users`).
-- ============================================================

-- ============================================================
-- A. La semilla del trigger (046)
--
-- Un alta normal nace con su prueba: plan `pro`, estado `trialing`,
-- 14 días. Es lo que hace que `getEntitlements()` pueda decir cuándo
-- termina la prueba en vez de devolver `trialEndsAt = null`.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user    uuid := gen_random_uuid();
  v_account uuid;
  v_sub     subscriptions%ROWTYPE;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'a@example.com', '{"full_name":"Check A"}'::jsonb);

  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_user;
  IF v_account IS NULL THEN
    RAISE EXCEPTION 'A0: handle_new_user did not bootstrap an account';
  END IF;

  SELECT * INTO v_sub FROM subscriptions WHERE account_id = v_account;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'A1: a new account did not get a trial subscription (046 trigger)';
  END IF;
  IF v_sub.plan_id <> 'pro' THEN
    RAISE EXCEPTION 'A2: the trial plan is % and not pro', v_sub.plan_id;
  END IF;
  IF v_sub.status <> 'trialing' THEN
    RAISE EXCEPTION 'A3: the trial status is % and not trialing', v_sub.status;
  END IF;
  IF v_sub.provider_subscription_id IS NOT NULL THEN
    RAISE EXCEPTION 'A4: a seeded trial must not carry a provider subscription id';
  END IF;
  IF v_sub.trial_ends_at IS NULL THEN
    RAISE EXCEPTION 'A5: trial_ends_at is null — the whole point of 046 is the date';
  END IF;
  -- 14 días, con un día de holgura para no depender del reloj exacto.
  IF v_sub.trial_ends_at < now() + interval '13 days'
     OR v_sub.trial_ends_at > now() + interval '15 days' THEN
    RAISE EXCEPTION 'A6: trial_ends_at is % — expected ~14 days out', v_sub.trial_ends_at;
  END IF;

  -- Exactamente una fila: el trigger no duplica.
  IF (SELECT count(*) FROM subscriptions WHERE account_id = v_account) <> 1 THEN
    RAISE EXCEPTION 'A7: the signup produced more than one trial row';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- B. La semilla no pisa una suscripción existente
--
-- Reejecutar la 046 (una migración se aplica dos veces más a menudo de
-- lo que a uno le gustaría) no puede devolver a `trialing` a nadie que
-- esté pagando ni renovarle la prueba a nadie.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user    uuid := gen_random_uuid();
  v_account uuid;
  v_status  text;
  v_plan    text;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'b@example.com', '{"full_name":"Check B"}'::jsonb);
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_user;

  UPDATE subscriptions
  SET status = 'active', plan_id = 'negocio',
      provider_subscription_id = 'I-PAYING'
  WHERE account_id = v_account;

  -- Lo que hace la parte 3 de la 046.
  INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at)
  SELECT a.id, 'pro', 'trialing', now() + trial_period()
  FROM accounts a
  ON CONFLICT (account_id) DO NOTHING;

  SELECT status, plan_id INTO v_status, v_plan
  FROM subscriptions WHERE account_id = v_account;

  IF v_status <> 'active' OR v_plan <> 'negocio' THEN
    RAISE EXCEPTION 'B1: re-running the seed downgraded a paying account to %/%',
      v_plan, v_status;
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- C. redeem_invitation() con la prueba sembrada — EL CASO DEL AVISO
--
-- 041 puso ON DELETE RESTRICT en `subscriptions` y `usage_counters`.
-- Con la 046 sembrando una fila por cuenta, el DELETE de la cuenta
-- personal del invitado fallaría con 23503 y NADIE podría aceptar una
-- invitación. La 052 lo resuelve. Esto es la prueba de que lo resuelve.
--
-- `redeem_invitation()` es SECURITY DEFINER y lee `auth.uid()`, así que
-- hay que fingir el JWT con `request.jwt.claims`.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_host_user     uuid := gen_random_uuid();
  v_guest_user    uuid := gen_random_uuid();
  v_host_account  uuid;
  v_guest_account uuid;
  v_token         text := encode(gen_random_bytes(32), 'hex');
  v_joined        uuid;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_host_user, 'chost@example.com', '{"full_name":"Host"}'::jsonb);
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_guest_user, 'cguest@example.com', '{"full_name":"Guest"}'::jsonb);

  SELECT account_id INTO v_host_account FROM profiles WHERE user_id = v_host_user;
  SELECT account_id INTO v_guest_account FROM profiles WHERE user_id = v_guest_user;

  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = v_guest_account) THEN
    RAISE EXCEPTION 'C0: the guest account has no seeded trial — the test proves nothing';
  END IF;

  INSERT INTO account_invitations
    (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES
    (v_host_account, encode(digest(v_token, 'sha256'), 'hex'), 'agent',
     v_host_user, now() + interval '7 days');

  -- La imagen del harness implementa `auth.uid()` sobre
  -- `request.jwt.claim.sub`; Supabase real usa `request.jwt.claims`.
  -- Se ponen las dos para que el control valga en ambas.
  PERFORM set_config('request.jwt.claim.sub', v_guest_user::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_guest_user::text)::text, true);

  v_joined := redeem_invitation(encode(digest(v_token, 'sha256'), 'hex'));

  IF v_joined <> v_host_account THEN
    RAISE EXCEPTION 'C1: redeem_invitation returned % instead of the host account', v_joined;
  END IF;
  IF EXISTS (SELECT 1 FROM accounts WHERE id = v_guest_account) THEN
    RAISE EXCEPTION 'C2: the empty personal account survived the redemption';
  END IF;
  IF EXISTS (SELECT 1 FROM subscriptions WHERE account_id = v_guest_account) THEN
    RAISE EXCEPTION 'C3: the seeded trial survived its account';
  END IF;
  IF (SELECT account_id FROM profiles WHERE user_id = v_guest_user) <> v_host_account THEN
    RAISE EXCEPTION 'C4: the guest profile was not moved to the host account';
  END IF;
  -- Y la suscripción del anfitrión sigue en su sitio: se borró la del
  -- invitado, no «una».
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = v_host_account) THEN
    RAISE EXCEPTION 'C5: the HOST account lost its subscription';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- D. redeem_invitation() protege lo que SÍ es dato de facturación
--
-- Dos negativos. Una cuenta con una suscripción de verdad (o con
-- consumo medido) no se disuelve al aceptar una invitación: la función
-- levanta 23505 y el invitado se entera antes de perder nada.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_host_user     uuid := gen_random_uuid();
  v_guest_user    uuid := gen_random_uuid();
  v_host_account  uuid;
  v_guest_account uuid;
  v_token         text := encode(gen_random_bytes(32), 'hex');
  v_hash          text;
  v_raised        boolean;
BEGIN
  v_hash := encode(digest(v_token, 'sha256'), 'hex');

  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_host_user, 'dhost@example.com', '{"full_name":"Host"}'::jsonb);
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_guest_user, 'dguest@example.com', '{"full_name":"Guest"}'::jsonb);

  SELECT account_id INTO v_host_account FROM profiles WHERE user_id = v_host_user;
  SELECT account_id INTO v_guest_account FROM profiles WHERE user_id = v_guest_user;

  INSERT INTO account_invitations
    (account_id, token_hash, role, created_by_user_id, expires_at)
  VALUES (v_host_account, v_hash, 'agent', v_host_user, now() + interval '7 days');

  PERFORM set_config('request.jwt.claim.sub', v_guest_user::text, true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', v_guest_user::text)::text, true);

  -- D1: la cuenta contrató de verdad.
  UPDATE subscriptions
  SET status = 'active', provider_subscription_id = 'I-REAL'
  WHERE account_id = v_guest_account;

  v_raised := false;
  BEGIN
    PERFORM redeem_invitation(v_hash);
  EXCEPTION WHEN unique_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'D1: an account with a real subscription was dissolved by an invitation';
  END IF;

  -- D2: prueba intacta, pero con consumo medido.
  UPDATE subscriptions
  SET status = 'trialing', provider_subscription_id = NULL
  WHERE account_id = v_guest_account;
  PERFORM increment_usage(v_guest_account, 'messages_out', 5);

  v_raised := false;
  BEGIN
    PERFORM redeem_invitation(v_hash);
  EXCEPTION WHEN unique_violation THEN
    v_raised := true;
  END;
  IF NOT v_raised THEN
    RAISE EXCEPTION 'D2: an account with metered usage was dissolved by an invitation';
  END IF;

  -- D3: y con el contador a cero (una fila espuria) sí se disuelve —
  -- la 052 la borra en vez de considerarla dato.
  UPDATE usage_counters SET value = 0 WHERE account_id = v_guest_account;
  IF redeem_invitation(v_hash) <> v_host_account THEN
    RAISE EXCEPTION 'D3: a zero counter blocked the redemption';
  END IF;
  IF EXISTS (SELECT 1 FROM usage_counters WHERE account_id = v_guest_account) THEN
    RAISE EXCEPTION 'D4: the zero counter survived its account';
  END IF;
END
$$;

ROLLBACK;

-- ============================================================
-- E. El RESTRICT sigue siendo RESTRICT
--
-- Control negativo de la parte C: si alguien aflojara la FK a CASCADE,
-- la 052 dejaría de hacer falta y nadie se enteraría. Esto falla si eso
-- pasa.
-- ============================================================
DO $$
DECLARE
  v_del char;
BEGIN
  SELECT confdeltype INTO v_del
  FROM pg_constraint
  WHERE conname = 'subscriptions_account_id_fkey';
  IF v_del <> 'r' THEN
    RAISE EXCEPTION 'E1: subscriptions_account_id_fkey is % and not RESTRICT', v_del;
  END IF;

  SELECT confdeltype INTO v_del
  FROM pg_constraint
  WHERE conname = 'usage_counters_account_id_fkey';
  IF v_del <> 'r' THEN
    RAISE EXCEPTION 'E2: usage_counters_account_id_fkey is % and not RESTRICT', v_del;
  END IF;
END
$$;

-- ============================================================
-- F. increment_usage sigue siendo del rol de servicio y solo suyo
--
-- Toda la contabilidad de §4 pasa por esta RPC. Si `authenticated`
-- pudiera llamarla, un inquilino podría inflar (o no) sus propios
-- contadores.
-- ============================================================
DO $$
BEGIN
  IF has_function_privilege('authenticated',
       'public.increment_usage(uuid, text, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F1: authenticated can EXECUTE increment_usage';
  END IF;
  IF has_function_privilege('anon',
       'public.increment_usage(uuid, text, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F2: anon can EXECUTE increment_usage';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.increment_usage(uuid, text, bigint)', 'EXECUTE') THEN
    RAISE EXCEPTION 'F3: service_role cannot EXECUTE increment_usage';
  END IF;
END
$$;

-- ============================================================
-- G. Un usuario autenticado no puede tocar su propia suscripción
--
-- Criterio de aceptación de la fase: «un usuario autenticado no puede
-- modificar su propia suscripción ni sus contadores, comprobado contra
-- la RLS». La f0.2 ya lo comprobó; se repite aquí porque la 046 ahora
-- crea la fila que antes no existía, y una fila que sí existe es una
-- fila que se puede intentar actualizar.
-- ============================================================
BEGIN;

DO $$
DECLARE
  v_user    uuid := gen_random_uuid();
  v_account uuid;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (v_user, 'g@example.com', '{"full_name":"Check G"}'::jsonb);
  SELECT account_id INTO v_account FROM profiles WHERE user_id = v_user;
  PERFORM set_config('wacrm.check_account', v_account::text, false);
  PERFORM set_config('wacrm.check_user', v_user::text, false);
END
$$;

SET LOCAL ROLE authenticated;

DO $$
BEGIN
  PERFORM set_config('request.jwt.claim.sub',
    current_setting('wacrm.check_user'), true);
  PERFORM set_config('request.jwt.claims',
    json_build_object('sub', current_setting('wacrm.check_user'))::text, true);
END
$$;

DO $$
DECLARE
  v_account uuid := current_setting('wacrm.check_account')::uuid;
  v_updated integer;
  v_visible integer;
BEGIN
  -- La fila es LEGIBLE para un miembro (política subscriptions_select)…
  SELECT count(*) INTO v_visible FROM subscriptions WHERE account_id = v_account;
  IF v_visible <> 1 THEN
    RAISE EXCEPTION 'G0: the member cannot even read their own subscription (%)', v_visible;
  END IF;

  -- …y no escribible por nadie desde el cliente.
  UPDATE subscriptions SET plan_id = 'negocio', status = 'active'
  WHERE account_id = v_account;
  GET DIAGNOSTICS v_updated = ROW_COUNT;
  IF v_updated <> 0 THEN
    RAISE EXCEPTION 'G1: an authenticated user updated % subscription row(s)', v_updated;
  END IF;
END
$$;

DO $$
DECLARE
  v_account uuid := current_setting('wacrm.check_account')::uuid;
BEGIN
  INSERT INTO usage_counters (account_id, metric, period_start, value)
  VALUES (v_account, 'messages_out', date_trunc('month', now())::date, -1000);
  RAISE EXCEPTION 'G2: an authenticated user inserted a usage_counters row';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;  -- lo esperado
END
$$;

DO $$
DECLARE
  v_account uuid := current_setting('wacrm.check_account')::uuid;
BEGIN
  PERFORM increment_usage(v_account, 'messages_out', 1000);
  RAISE EXCEPTION 'G3: an authenticated user called increment_usage';
EXCEPTION
  WHEN insufficient_privilege THEN NULL;  -- lo esperado
END
$$;

ROLLBACK;
