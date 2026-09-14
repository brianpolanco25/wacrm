-- ============================================================
-- f4.3 `platform-admins-panel` — comprobaciones contra base real.
--
-- Se ejecuta contra el Postgres del harness:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fase-4
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_platform-admins-panel.sql
--
-- Todo va dentro de un BEGIN … ROLLBACK: no deja nada. Cualquier
-- aserción fallida aborta la transacción, así que no hay verde
-- silencioso.
--
-- DOS TRAMPAS DE ESTA IMAGEN, heredadas de checks_multi-number.sql y de
-- checks_impersonation-audit.sql, y que cuestan una hora si se repiten:
--
--   1. El disparador `on_auth_user_created` (017) ya crea cuenta y
--      perfil al insertar en auth.users, y `idx_accounts_one_per_owner`
--      impide crear una segunda. Nunca se insertan cuentas a mano.
--      Y desde la 046, el disparador `on_account_created_seed_trial`
--      siembra también la fila de `subscriptions`.
--   2. `auth.uid()` en esta imagen lee `request.jwt.claim.sub` EN
--      SINGULAR. Ponerlo como JSON completo deja el uid a NULL y la RLS
--      devuelve cero filas PARA TODOS: un falso verde perfecto.
-- ============================================================

BEGIN;

DO $$
DECLARE
  operator_id  uuid := gen_random_uuid();
  owner_a_id   uuid := gen_random_uuid();
  owner_b_id   uuid := gen_random_uuid();
  account_a    uuid;
  account_b    uuid;
  n            int;
  txt          text;
BEGIN
  -- ----------------------------------------------------------
  -- Semilla: tres usuarios por el camino real (el disparador de la 017
  -- crea la cuenta y el de la 046 su suscripción de prueba).
  -- ----------------------------------------------------------
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (operator_id, 'operator@example.com', '{"full_name":"Operator"}'::jsonb),
    (owner_a_id,  'a@example.com',        '{"full_name":"Owner A"}'::jsonb),
    (owner_b_id,  'b@example.com',        '{"full_name":"Owner B"}'::jsonb);

  SELECT account_id INTO account_a FROM profiles WHERE user_id = owner_a_id;
  SELECT account_id INTO account_b FROM profiles WHERE user_id = owner_b_id;

  IF account_a IS NULL OR account_b IS NULL OR account_a = account_b THEN
    RAISE EXCEPTION 'semilla: las dos cuentas no se crearon como se esperaba';
  END IF;

  INSERT INTO platform_admins (user_id, granted_by, note)
  VALUES (operator_id, operator_id, 'bootstrap de la prueba');

  -- ==========================================================
  -- 1. La retención manual exige un motivo legible.
  -- ==========================================================
  BEGIN
    UPDATE subscriptions
       SET manual_hold_at = now(), manual_hold_by = operator_id
     WHERE account_id = account_a;
    RAISE EXCEPTION 'FALLO 1a: se aceptó una retención sin motivo';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    UPDATE subscriptions
       SET manual_hold_at = now(),
           manual_hold_by = operator_id,
           manual_hold_reason = '   spam   '
     WHERE account_id = account_a;
    RAISE EXCEPTION 'FALLO 1b: se aceptó un motivo de 4 caracteres';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- Y con motivo de verdad, pasa.
  UPDATE subscriptions
     SET manual_hold_at = now(),
         manual_hold_by = operator_id,
         manual_hold_reason = 'chargebacks, ticket 88'
   WHERE account_id = account_a;

  SELECT count(*) INTO n
    FROM subscriptions
   WHERE account_id = account_a AND manual_hold_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 1c: la retención no quedó puesta';
  END IF;

  -- Y NO se puso en la otra cuenta.
  SELECT count(*) INTO n
    FROM subscriptions
   WHERE account_id = account_b AND manual_hold_at IS NOT NULL;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO 1d: la retención alcanzó a la cuenta ajena';
  END IF;

  -- ==========================================================
  -- 2. Borrar al operador NO reactiva al moroso (FK SET NULL).
  --
  -- El control que importa de CP2 aquí: si la FK fuera CASCADE, dar de
  -- baja a un empleado levantaría todas las suspensiones que puso.
  -- ==========================================================
  -- Borrar al operador exige desmontar antes su propia empresa: la 017
  -- le crea una al darse de alta y `accounts.owner_user_id` es RESTRICT.
  -- Es exactamente el procedimiento de baja que documenta la 041, y hay
  -- que recorrerlo para que este control negativo sea real.
  DELETE FROM platform_admins WHERE user_id = operator_id;
  DELETE FROM subscriptions
   WHERE account_id IN (SELECT account_id FROM profiles WHERE user_id = operator_id);
  DELETE FROM usage_counters
   WHERE account_id IN (SELECT account_id FROM profiles WHERE user_id = operator_id);
  DELETE FROM accounts
   WHERE id IN (SELECT account_id FROM profiles WHERE user_id = operator_id);
  DELETE FROM auth.users WHERE id = operator_id;

  SELECT count(*) INTO n
    FROM subscriptions
   WHERE account_id = account_a
     AND manual_hold_at IS NOT NULL
     AND manual_hold_by IS NULL
     AND manual_hold_reason = 'chargebacks, ticket 88';
  IF n <> 1 THEN
    RAISE EXCEPTION
      'FALLO 2: borrar al operador movió la retención (esperado: sigue puesta, manual_hold_by a NULL)';
  END IF;

  -- Y la fila de la cuenta sigue existiendo: no hay CASCADE hacia
  -- `subscriptions` por este camino.
  SELECT count(*) INTO n FROM subscriptions WHERE account_id = account_a;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 2b: la suscripción desapareció al borrar al operador';
  END IF;

  RAISE NOTICE 'bloques 1 y 2: OK';
END $$;

ROLLBACK;

-- ============================================================
-- Bloque 3 — la bitácora ampliada, en su propia transacción para que el
-- bloque anterior no la contamine.
-- ============================================================
BEGIN;

DO $$
DECLARE
  operator_id uuid := gen_random_uuid();
  owner_a_id  uuid := gen_random_uuid();
  account_a   uuid;
  n           int;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES
    (operator_id, 'operator@example.com', '{"full_name":"Operator"}'::jsonb),
    (owner_a_id,  'a@example.com',        '{"full_name":"Owner A"}'::jsonb);
  SELECT account_id INTO account_a FROM profiles WHERE user_id = owner_a_id;
  INSERT INTO platform_admins (user_id, granted_by) VALUES (operator_id, operator_id);

  -- 3a. Una fila de suspensión no lleva caducidad, y se acepta.
  INSERT INTO impersonation_log
    (action, actor_user_id, account_id, account_name, reason, expires_at)
  VALUES
    ('suspend', operator_id, account_a, 'Company A', 'chargebacks, ticket 88', NULL);

  -- 3b. Una fila de impersonación SIN caducidad se rechaza. Es la
  -- garantía que la 055 daba con NOT NULL y que la 058 conserva donde
  -- importa: sin `expires_at` la sesión de soporte no caduca nunca.
  BEGIN
    INSERT INTO impersonation_log
      (action, actor_user_id, account_id, reason, expires_at)
    VALUES
      ('impersonation', operator_id, account_a, 'ticket 99: no entra nada', NULL);
    RAISE EXCEPTION 'FALLO 3b: se aceptó una sesión de soporte sin caducidad';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 3c. Una acción que no es ninguna de las tres se rechaza.
  BEGIN
    INSERT INTO impersonation_log
      (action, actor_user_id, account_id, reason, expires_at)
    VALUES ('delete_everything', operator_id, account_a, 'motivo suficiente', now());
    RAISE EXCEPTION 'FALLO 3c: se aceptó una acción fuera del CHECK';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 3d. El motivo mínimo de la 055 sigue vigente para las tres acciones.
  BEGIN
    INSERT INTO impersonation_log
      (action, actor_user_id, account_id, reason, expires_at)
    VALUES ('reactivate', operator_id, account_a, 'ok', NULL);
    RAISE EXCEPTION 'FALLO 3d: se aceptó un motivo de dos caracteres';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  -- 3e. El valor por defecto: una fila escrita sin `action` —como las
  -- que ya existían antes de la 058— sigue significando «sesión».
  INSERT INTO impersonation_log
    (actor_user_id, account_id, reason, expires_at)
  VALUES (operator_id, account_a, 'ticket 99: fila al estilo 055', now() + interval '30 minutes');

  SELECT count(*) INTO n
    FROM impersonation_log
   WHERE account_id = account_a AND action = 'impersonation';
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 3e: el valor por defecto de action no es impersonation';
  END IF;

  -- ==========================================================
  -- 4. Una fila de SUSPENSIÓN no concede la lectura de nadie.
  --
  -- El riesgo concreto: `has_open_support_session` mira filas abiertas
  -- sin caducar. Si una suspensión pudiera contar, suspender a un
  -- cliente le daría al operador acceso permanente a sus datos.
  -- ==========================================================
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', operator_id::text, true);

  IF has_open_support_session(account_a) IS NOT TRUE THEN
    RAISE EXCEPTION
      'FALLO 4a: la sesión de soporte legítima (3e) no concede lectura — la prueba siguiente sería vacua';
  END IF;

  RESET ROLE;

  -- Ahora se cierra la sesión legítima y se deja SOLO la suspensión,
  -- a la que además se le pone una caducidad futura a propósito: si el
  -- filtro por `action` no estuviera, esta fila pasaría.
  UPDATE impersonation_log
     SET ended_at = now(), ended_reason = 'manual'
   WHERE account_id = account_a AND action = 'impersonation';
  UPDATE impersonation_log
     SET expires_at = now() + interval '1 hour'
   WHERE account_id = account_a AND action = 'suspend';

  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', operator_id::text, true);

  IF has_open_support_session(account_a) IS NOT FALSE THEN
    RAISE EXCEPTION
      'FALLO 4b: una fila de suspensión abierta y sin caducar concede la lectura de la cuenta';
  END IF;

  RESET ROLE;
  RAISE NOTICE 'bloques 3 y 4: OK';
END $$;

ROLLBACK;

-- ============================================================
-- Bloque 5 — el censo no se lo puede pedir un inquilino, y el inquilino
-- no se puede levantar su propia retención.
-- ============================================================
BEGIN;

DO $$
DECLARE
  owner_a_id uuid := gen_random_uuid();
  account_a  uuid;
  n          int;
BEGIN
  INSERT INTO auth.users (id, email, raw_user_meta_data)
  VALUES (owner_a_id, 'a@example.com', '{"full_name":"Owner A"}'::jsonb);
  SELECT account_id INTO account_a FROM profiles WHERE user_id = owner_a_id;

  UPDATE subscriptions
     SET manual_hold_at = now(), manual_hold_reason = 'chargebacks, ticket 88'
   WHERE account_id = account_a;

  -- 5a. Ningún rol de cliente puede ejecutar el censo.
  IF has_function_privilege('authenticated',
       'public.platform_account_list(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLO 5a: authenticated puede ejecutar platform_account_list';
  END IF;
  IF has_function_privilege('anon',
       'public.platform_account_list(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLO 5a2: anon puede ejecutar platform_account_list';
  END IF;
  IF NOT has_function_privilege('service_role',
       'public.platform_account_list(text, integer, integer)', 'EXECUTE') THEN
    RAISE EXCEPTION 'FALLO 5a3: service_role NO puede ejecutar platform_account_list';
  END IF;

  -- 5b. Y no es SECURITY DEFINER, que es la segunda mitad de la defensa:
  -- un GRANT equivocado seguiría chocando con la RLS de `accounts`.
  SELECT count(*) INTO n
    FROM pg_proc p JOIN pg_namespace ns ON ns.oid = p.pronamespace
   WHERE ns.nspname = 'public'
     AND p.proname = 'platform_account_list'
     AND p.prosecdef = true;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO 5b: platform_account_list es SECURITY DEFINER';
  END IF;

  -- 5c. Ejecutado por el rol de servicio, el censo ve la cuenta y su
  -- retención (control positivo: sin esto, 5a sería vacuo).
  SET LOCAL ROLE service_role;
  SELECT count(*) INTO n
    FROM platform_account_list(NULL, 50, 0) AS c
   WHERE c.account_id = account_a AND c.manual_hold_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 5c: el censo no devuelve la cuenta retenida';
  END IF;
  RESET ROLE;

  -- 5d. El inquilino LEE su suscripción…
  SET LOCAL ROLE authenticated;
  PERFORM set_config('request.jwt.claim.sub', owner_a_id::text, true);

  SELECT count(*) INTO n FROM subscriptions WHERE account_id = account_a;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 5d: el dueño no lee su propia suscripción';
  END IF;

  -- …y NO puede levantarse la retención. Sin política de UPDATE la RLS
  -- no lanza error: simplemente no afecta a ninguna fila.
  UPDATE subscriptions SET manual_hold_at = NULL WHERE account_id = account_a;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO 5e: el inquilino levantó su propia suspensión (% filas)', n;
  END IF;

  RESET ROLE;

  SELECT count(*) INTO n
    FROM subscriptions WHERE account_id = account_a AND manual_hold_at IS NOT NULL;
  IF n <> 1 THEN
    RAISE EXCEPTION 'FALLO 5f: la retención se levantó de todas formas';
  END IF;

  RAISE NOTICE 'bloque 5: OK';
END $$;

ROLLBACK;

-- ============================================================
-- Bloque 6 — la 057 aplicada DESPUÉS de 045–056: ninguna política de
-- escritura recibió el predicado de soporte, y ninguna de lectura se
-- quedó atrás. Es la comprobación que el líder pidió explícitamente
-- para el merge; se repite aquí porque 058 recrea la función.
-- ============================================================
DO $$
DECLARE
  n int;
BEGIN
  SELECT count(*) INTO n
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd <> 'SELECT'
     AND (coalesce(qual, '') || coalesce(with_check, ''))
         ~ '(has_open_support_session|can_read_account)';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO 6a: % políticas de ESCRITURA llevan el predicado de soporte', n;
  END IF;

  SELECT count(*) INTO n
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'SELECT'
     AND qual LIKE '%is_account_member(%';
  IF n <> 0 THEN
    RAISE EXCEPTION 'FALLO 6b: % políticas de SELECT siguen llamando a is_account_member', n;
  END IF;

  -- Control positivo: 37 políticas de SELECT ampliadas (36 antes del
  -- merge; la nueva es `checkout_intents_select`, de la 048). Si este
  -- número cambia, es que alguien añadió o quitó una tabla y hay que
  -- decidirlo a conciencia, no descubrirlo en producción.
  SELECT count(*) INTO n
    FROM pg_policies
   WHERE schemaname = 'public' AND cmd = 'SELECT' AND qual ~ 'can_read_account';
  IF n <> 37 THEN
    RAISE EXCEPTION
      'FALLO 6c: % políticas de SELECT llevan can_read_account (esperado 37)', n;
  END IF;

  RAISE NOTICE 'bloque 6: OK';
END $$;

DO $$ BEGIN RAISE NOTICE 'checks_platform-admins-panel: OK'; END $$;
