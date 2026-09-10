-- ============================================================
-- 049_redeem_invitation_checkout_intents.sql — Fase 3 (SaaS)
--
-- 048 dio a `checkout_intents.account_id` un `ON DELETE RESTRICT`
-- (el rastro de facturación no desaparece como efecto colateral de
-- borrar una cuenta). Eso choca con `redeem_invitation()` de 019, que
-- después de comprobar que la cuenta personal del invitado está vacía
-- la BORRA. Su lista de «¿hay datos?» (019:194-206) enumera las tablas
-- de dominio que existían entonces y no puede conocer `checkout_intents`,
-- así que el borrado final salta con 23503:
--
--   update or delete on table "accounts" violates foreign key
--   constraint "checkout_intents_account_id_fkey" on table
--   "checkout_intents"
--
-- El caso es estrecho pero real y deja a alguien fuera para siempre:
-- un usuario pulsa «Elegir plan» en su cuenta personal, abandona la
-- aprobación en PayPal (la fila queda `pending`), y luego acepta la
-- invitación a un equipo. Sin esto, nunca puede entrar.
--
-- La salida NO es aflojar la FK, sino enseñarle a `redeem_invitation()`
-- lo que un intento significa:
--
--   * `pending` — una aprobación abandonada. No vale nada: no hay
--     suscripción activa, no hay cobro y PayPal deja caducar la
--     suscripción en `APPROVAL_PENDING`. Se BORRA junto con la cuenta
--     personal, igual que se borra la cuenta.
--   * `activated` / `cancelled` — el webhook de §3 ya tocó esa fila:
--     hubo (o hay) una suscripción de verdad detrás. Eso es dato
--     contable, así que cuenta como «tu cuenta ya contiene datos» y la
--     invitación se rechaza con 23505, exactamente igual que si hubiera
--     contactos o difusiones. El mensaje que ya devuelve la función
--     («sign up with a different email») es la respuesta correcta:
--     quien tiene una contratación no debe disolver su cuenta al
--     aceptar una invitación.
--
-- Único cambio respecto de 019: la rama de `checkout_intents` en la
-- comprobación de vacío y el DELETE previo de los `pending`. El resto
-- del cuerpo se reproduce tal cual — `CREATE OR REPLACE` sustituye la
-- definición entera, no la parchea.
--
-- Idempotente — safe to re-run: `CREATE OR REPLACE FUNCTION` más los
-- mismos OWNER/REVOKE/GRANT de 019.
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
