-- ============================================================
-- 090 — El invitado entra directo a la empresa que lo invitó (i12.1).
--
-- Hasta la 089, todo alta en `auth.users` creaba una cuenta personal
-- (`handle_new_user`, 017) y el invitado tenía que pulsar «Aceptar» en
-- /join/<token> para que `redeem_invitation` lo moviera a la empresa. Si
-- no lo hacía (otro navegador, PKCE perdido, onboarding por medio), se
-- quedaba en una empresa vacía sin saberlo. Desde aquí:
--
--   1. `handle_new_user()` lee `raw_user_meta_data->>'invite_token'`. Si
--      viene, el perfil nace en la empresa de la invitación con su rol, sin
--      `accounts` propia (ni `subscriptions`, ni `usage_counters`), y la
--      invitación queda aceptada en la misma transacción. Si el token no
--      vale (no existe, usado, caducado, tipo raro) o la empresa no tiene
--      asientos libres, el alta ENTERA se aborta con una excepción: GoTrue
--      responde «Database error saving new user» y no queda usuario, perfil
--      ni cuenta. Nunca se crea en silencio una empresa personal para un
--      invitado. Sin `invite_token` la función se comporta como la 017.
--
--   2. `redeem_invitation()` (073) es no-op para quien ya es miembro de la
--      cuenta de la invitación (el alta nueva tras confirmar el correo, el
--      invitado del panel tras /reset-password): devuelve la cuenta y no
--      toca nada. Cada rechazo lleva un `HINT` con el motivo
--      (`not_found`, `used`, `expired`, `no_seats`, `has_data`,
--      `shared_account`) que la ruta devuelve como `reason`.
--
--   3. `peek_invitation()` (019) responde `no_seats` si los miembros ya
--      llenan el plan vigente.
--
-- Hash en SQL: `pg_catalog.sha256()` (núcleo de Postgres ≥ 11), no
-- `pgcrypto.digest`, que vive en el esquema `extensions`, fuera del
-- `search_path = public` de estas funciones. Mismo resultado que
-- `hashInviteToken` (sha256 hex del token en UTF-8).
--
-- Token en claro en `raw_user_meta_data`: solo queda persistido si el alta
-- consumió la invitación (si la rechaza, la transacción entera se deshace),
-- y una invitación consumida no se puede volver a usar (`accepted_at`).
--
-- Qué es un asiento. Para EMITIR un enlace (TS: `countSeats` y el POST de
-- /api/account/invitations) se cuentan miembros + invitaciones pendientes
-- no caducadas: la pendiente es una reserva. Al CONSUMIR un enlace la
-- reserva que se convierte es la propia, así que aquí la pregunta es
-- «¿cabe un miembro más en el plan de hoy?»: miembros + 1 ≤ límite. Con el
-- plan intacto siempre cabe; si el plan bajó, entra el primero que llegue.
-- `account_seat_limit` replica `getEntitlements` + `normalizeLimits`: sin
-- suscripción → plan 'inicio' (DEFAULT_PLAN_ID); `operators` null, ausente
-- o no numérico → sin límite. Un plan que no está en el catálogo también
-- devuelve NULL (falla abierto): el TS lanza en ese caso, pero en SQL un
-- plan borrado no debe bloquear todas las altas.
--
-- Idempotente: solo CREATE OR REPLACE FUNCTION, ALTER … OWNER y
-- REVOKE/GRANT. No toca tablas, RLS ni el trigger `on_auth_user_created`
-- (sigue apuntando a `public.handle_new_user()`).
-- ============================================================

-- ============================================================
-- 1. Asientos (R30–R33)
-- ============================================================
CREATE OR REPLACE FUNCTION public.account_seat_limit(p_account_id UUID)
RETURNS INTEGER
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT CASE WHEN jsonb_typeof(p.limits->'operators') = 'number'
              THEN floor((p.limits->>'operators')::numeric)::int END
  FROM plans p
  WHERE p.id = COALESCE(
    (SELECT s.plan_id FROM subscriptions s WHERE s.account_id = p_account_id),
    'inicio');
$$;

ALTER FUNCTION public.account_seat_limit(UUID) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.account_seat_limit(UUID) FROM PUBLIC, anon, authenticated;

-- Lanza `no_seats` si un miembro más no cabe. Bloquea la fila de
-- `accounts` para serializar altas y canjes concurrentes en la misma
-- cuenta.
CREATE OR REPLACE FUNCTION public.assert_seat_available(
  p_account_id UUID,
  p_errcode TEXT
) RETURNS VOID
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_limit INTEGER;
  v_members INTEGER;
BEGIN
  PERFORM 1 FROM accounts WHERE id = p_account_id FOR UPDATE;
  v_limit := account_seat_limit(p_account_id);
  IF v_limit IS NULL THEN
    RETURN;
  END IF;
  SELECT count(*) INTO v_members FROM profiles WHERE account_id = p_account_id;
  IF v_members + 1 > v_limit THEN
    RAISE EXCEPTION 'The account has no free seats on its plan'
      USING ERRCODE = p_errcode, HINT = 'no_seats';
  END IF;
END;
$$;

ALTER FUNCTION public.assert_seat_available(UUID, TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.assert_seat_available(UUID, TEXT) FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 2. `handle_new_user()` (reemplaza la de 017) — R1–R7, R21, R30
-- ============================================================
CREATE OR REPLACE FUNCTION public.handle_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_full_name  TEXT := COALESCE(NEW.raw_user_meta_data->>'full_name', '');
  v_invite     JSONB := NEW.raw_user_meta_data->'invite_token';
  v_token      TEXT;
  v_inv        account_invitations%ROWTYPE;
  v_account_id UUID;
BEGIN
  -- Rama de invitación (i12.1): fuera del bloque que traga errores. Un
  -- fallo aquí aborta el alta; nunca cae a la cuenta personal.
  IF v_invite IS NOT NULL AND jsonb_typeof(v_invite) <> 'null' THEN
    IF jsonb_typeof(v_invite) <> 'string' THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;
    v_token := v_invite #>> '{}';
    IF length(v_token) NOT BETWEEN 1 AND 128 THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;

    SELECT * INTO v_inv
    FROM account_invitations
    WHERE token_hash = encode(pg_catalog.sha256(convert_to(v_token, 'UTF8')), 'hex')
    FOR UPDATE;

    IF NOT FOUND THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'not_found';
    END IF;
    IF v_inv.accepted_at IS NOT NULL THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'used';
    END IF;
    IF v_inv.expires_at <= NOW() THEN
      RAISE EXCEPTION 'invite_rejected' USING ERRCODE = 'P0001', HINT = 'expired';
    END IF;

    PERFORM assert_seat_available(v_inv.account_id, 'P0001');

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_inv.account_id, v_inv.role);

    UPDATE account_invitations
    SET accepted_at = NOW(),
        accepted_by_user_id = NEW.id
    WHERE id = v_inv.id;

    RETURN NEW;
  END IF;

  -- Rama de siempre (017), sin cambios de comportamiento (R6).
  BEGIN
    INSERT INTO public.accounts (name, owner_user_id)
    VALUES (COALESCE(NULLIF(v_full_name, ''), NEW.email, 'My account'), NEW.id)
    RETURNING id INTO v_account_id;

    INSERT INTO public.profiles (user_id, full_name, email, account_id, account_role)
    VALUES (NEW.id, v_full_name, NEW.email, v_account_id, 'owner');
  EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'Failed to bootstrap account/profile for user %: %', NEW.id, SQLERRM;
  END;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.handle_new_user() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.handle_new_user() FROM PUBLIC, anon, authenticated;

-- ============================================================
-- 3. `redeem_invitation()` (reemplaza la de 073) — R13, R16, R31
--
-- Cuerpo de la 073 con cuatro cambios: no-op si el llamante ya es
-- miembro de la cuenta (antes 23505 «already a member»), HINT en cada
-- rechazo, comprobación de asientos antes de mover el perfil, y nada más.
-- ============================================================
CREATE OR REPLACE FUNCTION public.redeem_invitation(
  p_token_hash TEXT
) RETURNS UUID  -- the joined account_id
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_caller_id UUID := auth.uid();
  v_inv account_invitations%ROWTYPE;
  v_old_account_id UUID;
  v_old_account_owner UUID;
  v_has_data BOOLEAN;
BEGIN
  IF v_caller_id IS NULL THEN
    RAISE EXCEPTION 'Unauthorized' USING ERRCODE = '42501';
  END IF;

  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'Invitation not found'
      USING ERRCODE = '22023', HINT = 'not_found';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  -- i12.1: ya es miembro (nació aquí por la invitación, o ya lo era).
  -- No-op: ni el perfil ni la invitación cambian. Una invitación
  -- pendiente que abre quien ya es miembro sigue pendiente y revocable.
  IF v_old_account_id = v_inv.account_id THEN
    RETURN v_inv.account_id;
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023', HINT = 'used';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired'
      USING ERRCODE = '22023', HINT = 'expired';
  END IF;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Safety: the caller must be the SOLE OWNER of their current
  -- account (i.e. their fresh personal account from signup or a
  -- prior removal). Any other state means they're either:
  --   - a member of another shared account (joining a second
  --     would silently orphan their access to the first), or
  --   - the owner of an account with teammates (they'd abandon
  --     their team to join the inviter's).
  -- Either way, the safe answer is "make a different login".
  IF v_old_account_owner <> v_caller_id THEN
    RAISE EXCEPTION 'You are already in a shared account; sign up with a different email to join this one'
      USING ERRCODE = '23505', HINT = 'shared_account';
  END IF;

  -- Belt: even if they own their account, refuse if it has any
  -- domain data — joining would orphan their contacts, deals,
  -- broadcasts, automations, flows, templates, etc.
  --
  -- `checkout_intents` (048) joins the list only for rows the webhook
  -- already moved on: those mean a real subscription happened under
  -- this account and must not be dissolved by accepting an invite.
  -- A `pending` row is an abandoned PayPal approval — nothing was
  -- charged — so it does not make the account "non-empty"; it is
  -- deleted below with the account itself.
  SELECT EXISTS (
    SELECT 1 FROM contacts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM conversations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM broadcasts WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM automations WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM flows WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM pipelines WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM message_templates WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM tags WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM custom_fields WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM contact_notes WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM whatsapp_config WHERE account_id = v_old_account_id
    UNION ALL SELECT 1 FROM checkout_intents
      WHERE account_id = v_old_account_id AND status <> 'pending'
    -- La semilla del trigger (046: `trialing`; 073: `incomplete`) sin
    -- identificador de la pasarela no es un dato que nadie pierda al
    -- disolver la cuenta personal: se borra más abajo. Cualquier otra
    -- cosa —un plan contratado, uno manual, uno vencido, una
    -- cancelación— SÍ es historial de facturación y hace que la cuenta
    -- cuente como «con datos», igual que si tuviera contactos.
    UNION ALL SELECT 1 FROM subscriptions
      WHERE account_id = v_old_account_id
        AND (status NOT IN ('trialing', 'incomplete')
             OR provider_subscription_id IS NOT NULL)
    -- Consumo medido: un contador a cero no es consumo. Uno con valor
    -- significa que esta cuenta envió, difundió o usó la IA, y eso es
    -- dato contable.
    UNION ALL SELECT 1 FROM usage_counters
      WHERE account_id = v_old_account_id AND value > 0
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505', HINT = 'has_data';
  END IF;

  -- i12.1 (R31): el plan vigente de la empresa tiene que admitir un
  -- miembro más. Después del guardián de datos: un 409 por datos gana a
  -- un 400 por asientos.
  PERFORM assert_seat_available(v_inv.account_id, '22023');

  -- Move the profile first so the cascade-on-delete of the old
  -- account doesn't try to nuke this user's profile too.
  UPDATE profiles
  SET account_id = v_inv.account_id,
      account_role = v_inv.role
  WHERE user_id = v_caller_id;

  UPDATE account_invitations
  SET accepted_at = NOW(),
      accepted_by_user_id = v_caller_id
  WHERE id = v_inv.id;

  -- Abandoned approvals of the account we are about to drop. Only
  -- `pending` rows can be here (anything else raised above), and the
  -- FK of 048 is RESTRICT on purpose, so this has to be explicit.
  DELETE FROM checkout_intents
  WHERE account_id = v_old_account_id AND status = 'pending';

  -- La semilla del trigger y sus contadores a cero. Solo pueden quedar en
  -- ese estado (lo demás ya levantó la excepción de arriba) y las dos FKs
  -- de 041 son RESTRICT a propósito, así que el borrado tiene que ser
  -- explícito.
  DELETE FROM usage_counters
  WHERE account_id = v_old_account_id AND value = 0;

  DELETE FROM subscriptions
  WHERE account_id = v_old_account_id
    AND status IN ('trialing', 'incomplete')
    AND provider_subscription_id IS NULL;

  -- Clean up the orphan personal account. Empty by the checks
  -- above, so this is purely housekeeping — no cascades fire
  -- because no other rows reference it.
  DELETE FROM accounts WHERE id = v_old_account_id;

  RETURN v_inv.account_id;
END;
$$;

ALTER FUNCTION public.redeem_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.redeem_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.redeem_invitation(TEXT) TO authenticated;

-- ============================================================
-- 4. `peek_invitation()` (reemplaza la de 019) — R32
--
-- Igual que la 019 más `no_seats` cuando los miembros ya llenan el plan
-- vigente. Solo lectura: revela a quien tiene el token que la empresa
-- está llena, nada más.
-- ============================================================
CREATE OR REPLACE FUNCTION public.peek_invitation(
  p_token_hash TEXT
) RETURNS JSON
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_inv account_invitations%ROWTYPE;
  v_account_name TEXT;
  v_limit INTEGER;
  v_members INTEGER;
BEGIN
  SELECT * INTO v_inv
  FROM account_invitations
  WHERE token_hash = p_token_hash;

  IF NOT FOUND THEN
    RETURN json_build_object('ok', false, 'reason', 'not_found');
  END IF;

  IF v_inv.accepted_at IS NOT NULL THEN
    RETURN json_build_object('ok', false, 'reason', 'used');
  END IF;

  IF v_inv.expires_at <= NOW() THEN
    RETURN json_build_object('ok', false, 'reason', 'expired');
  END IF;

  v_limit := account_seat_limit(v_inv.account_id);
  IF v_limit IS NOT NULL THEN
    SELECT count(*) INTO v_members
    FROM profiles
    WHERE account_id = v_inv.account_id;
    IF v_members >= v_limit THEN
      RETURN json_build_object('ok', false, 'reason', 'no_seats');
    END IF;
  END IF;

  SELECT name INTO v_account_name
  FROM accounts
  WHERE id = v_inv.account_id;

  RETURN json_build_object(
    'ok', true,
    'account_name', v_account_name,
    'role', v_inv.role,
    'expires_at', v_inv.expires_at
  );
END;
$$;

ALTER FUNCTION public.peek_invitation(TEXT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.peek_invitation(TEXT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.peek_invitation(TEXT) TO anon, authenticated;
