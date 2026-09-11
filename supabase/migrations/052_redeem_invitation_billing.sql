-- ============================================================
-- 052_redeem_invitation_billing.sql — Fase 3 (SaaS)
--
-- Mismo choque que resolvió la 049, una vuelta más. 041 puso
-- `ON DELETE RESTRICT` en `subscriptions.account_id` y en
-- `usage_counters.account_id`: el rastro de facturación no se destruye
-- como efecto colateral de borrar una cuenta. Mientras `subscriptions`
-- estuvo vacía eso no molestaba a nadie. La 046 siembra una prueba por
-- CADA cuenta —también las personales que nacen en el alta— y a partir
-- de ahí el `DELETE FROM accounts` con el que `redeem_invitation()`
-- limpia la cuenta personal del invitado falla siempre:
--
--   update or delete on table "accounts" violates foreign key
--   constraint "subscriptions_account_id_fkey" on table "subscriptions"
--
-- Es decir: sin esto, NADIE puede aceptar una invitación. No es un caso
-- estrecho como el de la 049, es el camino normal.
--
-- La salida es la misma que eligió la 049, no aflojar la FK sino
-- enseñarle a la función qué significa cada fila:
--
--   * `subscriptions` en `trialing` y sin `provider_subscription_id` —
--     la prueba que la 046 sembró sola, sin que nadie la pidiera ni la
--     pagara. No es dato del cliente: se borra con la cuenta.
--   * `subscriptions` en cualquier otro estado, o con identificador de
--     la pasarela — hubo una contratación de verdad. Cuenta como «tu
--     cuenta ya contiene datos» y la invitación se rechaza con 23505,
--     igual que si hubiera contactos. Quien tiene una suscripción no
--     debe disolver su cuenta aceptando una invitación.
--   * `usage_counters` con `value = 0` — filas que ni siquiera deberían
--     existir (la RPC solo inserta al incrementar), pero si una
--     restauración o un `increment_usage(…, 0)` dejó alguna, borrarla es
--     inocuo.
--   * `usage_counters` con `value > 0` — la cuenta envió, difundió o
--     usó la IA. Dato contable: cuenta como datos.
--
-- Único cambio respecto de la 049: las dos ramas nuevas de la
-- comprobación de vacío y los dos DELETE previos. El resto del cuerpo se
-- reproduce tal cual — `CREATE OR REPLACE` sustituye la definición
-- entera, no la parchea.
--
-- Idempotente — safe to re-run: `CREATE OR REPLACE FUNCTION` más los
-- mismos OWNER/REVOKE/GRANT de 019/049.
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
    RAISE EXCEPTION 'Invitation not found' USING ERRCODE = '22023';
  END IF;
  IF v_inv.accepted_at IS NOT NULL THEN
    RAISE EXCEPTION 'Invitation has already been redeemed'
      USING ERRCODE = '22023';
  END IF;
  IF v_inv.expires_at <= NOW() THEN
    RAISE EXCEPTION 'Invitation has expired' USING ERRCODE = '22023';
  END IF;

  -- Caller's current account + its owner.
  SELECT p.account_id, a.owner_user_id
  INTO v_old_account_id, v_old_account_owner
  FROM profiles p
  JOIN accounts a ON a.id = p.account_id
  WHERE p.user_id = v_caller_id;

  IF v_old_account_id IS NULL THEN
    -- Defensive — every authenticated user has a profile post-017.
    RAISE EXCEPTION 'Caller has no profile' USING ERRCODE = '42501';
  END IF;

  -- Edge case: the inviter sent themselves a link, or the
  -- caller is somehow already in the inviter's account.
  IF v_old_account_id = v_inv.account_id THEN
    RAISE EXCEPTION 'You are already a member of this account'
      USING ERRCODE = '23505';
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
      USING ERRCODE = '23505';
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
    -- 046 siembra una prueba por cuenta, y 041 ata `subscriptions` y
    -- `usage_counters` a `accounts` con ON DELETE RESTRICT. Una prueba
    -- intacta (`trialing`, sin identificador de la pasarela) no es un
    -- dato que nadie pierda al disolver la cuenta personal: se borra
    -- más abajo. Cualquier otra cosa —un plan contratado, uno vencido,
    -- una cancelación— SÍ es historial de facturación y hace que la
    -- cuenta cuente como «con datos», igual que si tuviera contactos.
    UNION ALL SELECT 1 FROM subscriptions
      WHERE account_id = v_old_account_id
        AND (status <> 'trialing' OR provider_subscription_id IS NOT NULL)
    -- Consumo medido: un contador a cero no es consumo. Uno con valor
    -- significa que esta cuenta envió, difundió o usó la IA, y eso es
    -- dato contable.
    UNION ALL SELECT 1 FROM usage_counters
      WHERE account_id = v_old_account_id AND value > 0
    LIMIT 1
  ) INTO v_has_data;

  IF v_has_data THEN
    RAISE EXCEPTION 'Your account already contains data; sign up with a different email to join this one'
      USING ERRCODE = '23505';
  END IF;

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

  -- La prueba sembrada por 046 y sus contadores a cero. Solo pueden
  -- quedar en ese estado (lo demás ya levantó la excepción de arriba) y
  -- las dos FKs de 041 son RESTRICT a propósito, así que el borrado
  -- tiene que ser explícito.
  DELETE FROM usage_counters
  WHERE account_id = v_old_account_id AND value = 0;

  DELETE FROM subscriptions
  WHERE account_id = v_old_account_id
    AND status = 'trialing'
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
