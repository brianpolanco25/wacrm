-- ============================================================
-- 073_no_trial.sql — Fase 9 (s9.6 `paid-onboarding`): sin prueba gratis
--
-- Hasta aquí cada cuenta nacía en `pro` / `trialing` con 14 días (046) y
-- nada vencía esa prueba. El humano decidió (spec fase 9, decisiones 3 y
-- 6) que no haya demos: para entrar al CRM hay que dar los datos de la
-- empresa y contratar un plan en PayPal.
--
-- Esta migración:
--
--   1. Añade `incomplete` al CHECK de `subscriptions.status` y lo hace el
--      valor por defecto de la columna. `incomplete` = la cuenta existe
--      pero todavía no ha pagado: solo lectura, con la puerta de alta
--      (`/onboarding`) delante. `trialing` sigue siendo un valor válido
--      del CHECK para no romper nada que aún lo lea, pero nadie lo escribe
--      ya y el paso 3 deja la tabla sin ninguna fila en ese estado.
--   2. El trigger de la 046 (`on_account_created_seed_trial`, mismo nombre
--      para no mover nada que lo compruebe) siembra `inicio` /
--      `incomplete` sin `trial_ends_at`. `trial_period()` se queda —
--      verify-schema la sigue pidiendo y no molesta—, pero ya no la llama
--      nadie.
--   3. Datos existentes: TODA fila `trialing` pasa a `incomplete` con
--      `trial_ends_at = NULL` (decisión 3). Las cuentas que hoy están en
--      prueba ven la puerta de pago en su próximo inicio de sesión.
--   4. `redeem_invitation()` (052) sabía que una prueba intacta
--      (`trialing` sin id de la pasarela) no es dato del cliente y la
--      borraba con la cuenta personal del invitado. Desde el paso 2 la
--      semilla es `incomplete`: sin enseñárselo, aceptar una invitación
--      fallaría con «tu cuenta ya contiene datos» para CADA usuario
--      nuevo. Mismo cuerpo que la 052 con las dos condiciones ampliadas.
--   5. Datos de la empresa en `accounts` (decisión 6): país (ISO-3166
--      alfa-2), teléfono, sector, tamaño del equipo y el sello
--      `onboarding_completed_at`. El nombre ya existe (`accounts.name`).
--      RLS: sin cambios. `accounts_update` (017) ya exige owner/admin de
--      la cuenta, y la 072 dejó `accounts` fuera de la sesión de soporte;
--      así sigue.
--
-- Idempotente — safe to re-run: el CHECK se busca y se recrea, CREATE OR
-- REPLACE FUNCTION, ADD COLUMN IF NOT EXISTS, DROP CONSTRAINT IF EXISTS +
-- ADD CONSTRAINT, y un UPDATE que en la segunda pasada no encuentra filas.
-- ============================================================

-- ============================================================
-- 1. `incomplete` en el CHECK de `subscriptions.status`
--
-- El CHECK de la 041 va en línea y Postgres le puso nombre solo
-- (`subscriptions_status_check`). Se busca por definición, no por nombre,
-- para no depender de cómo se llamó en cada base.
-- ============================================================
DO $$
DECLARE
  v_name text;
BEGIN
  FOR v_name IN
    SELECT c.conname
    FROM pg_constraint c
    WHERE c.conrelid = 'public.subscriptions'::regclass
      AND c.contype = 'c'
      AND pg_get_constraintdef(c.oid) LIKE '%status%'
      AND pg_get_constraintdef(c.oid) LIKE '%past_due%'
  LOOP
    EXECUTE format('ALTER TABLE public.subscriptions DROP CONSTRAINT %I', v_name);
  END LOOP;
END
$$;

ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_status_check
  CHECK (status IN ('incomplete', 'trialing', 'active', 'past_due',
                    'suspended', 'cancelled', 'expired'));

ALTER TABLE subscriptions ALTER COLUMN status SET DEFAULT 'incomplete';

-- ============================================================
-- 2. La semilla de cada cuenta nueva: sin prueba
--
-- `inicio` porque la fila necesita un plan del catálogo (FK de la 041) y
-- es el más barato: el plan real lo fija el webhook de PayPal al activar
-- (con el plan del `checkout_intent`) o el operador a mano (s9.4). Con
-- `incomplete` no importa cuál sea: la cuenta es de solo lectura.
--
-- Mismo contrato que la 046: SECURITY DEFINER propiedad de postgres (la
-- tabla no tiene política de escritura), ON CONFLICT DO NOTHING (no pisa
-- una fila que alguien ya puso) y un fallo aquí no impide crear la
-- cuenta. Sin fila, `getEntitlements()` resuelve igualmente a
-- `incomplete`.
-- ============================================================
CREATE OR REPLACE FUNCTION public.seed_account_trial()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO subscriptions (account_id, plan_id, status, trial_ends_at)
  VALUES (NEW.id, 'inicio', 'incomplete', NULL)
  ON CONFLICT (account_id) DO NOTHING;
  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RAISE WARNING 'Failed to seed the incomplete subscription for account %: %',
    NEW.id, SQLERRM;
  RETURN NEW;
END;
$$;

ALTER FUNCTION public.seed_account_trial() OWNER TO postgres;

COMMENT ON FUNCTION public.seed_account_trial() IS
  'AFTER INSERT ON accounts: siembra inicio/incomplete sin fecha (073). El nombre viene de la 046, cuando sembraba la prueba.';

COMMENT ON FUNCTION public.trial_period() IS
  'Obsoleta desde la 073 (sin prueba gratis): nadie la llama. Se conserva para no romper lo que la compruebe.';

-- El trigger de la 046 sigue igual; se recrea por si una base lo perdió.
DROP TRIGGER IF EXISTS on_account_created_seed_trial ON accounts;
CREATE TRIGGER on_account_created_seed_trial
  AFTER INSERT ON accounts
  FOR EACH ROW EXECUTE FUNCTION public.seed_account_trial();

-- ============================================================
-- 3. Las pruebas que hay hoy pasan a alta incompleta (decisión 3)
-- ============================================================
UPDATE subscriptions
SET status = 'incomplete',
    trial_ends_at = NULL
WHERE status = 'trialing';

-- ============================================================
-- 4. `redeem_invitation()`: la semilla `incomplete` tampoco es dato
--
-- Cuerpo de la 052, idéntico salvo las dos condiciones sobre
-- `subscriptions`: una fila `trialing` O `incomplete` sin id de la
-- pasarela es la que sembró el trigger — nadie la pidió ni la pagó — y se
-- borra con la cuenta personal. Cualquier otra (contratada, vencida,
-- manual, cancelada) sigue contando como «la cuenta tiene datos».
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
-- 5. Datos de la empresa (decisión 6)
--
-- Texto con CHECKs cortos, no enums: añadir un sector o un país no debe
-- exigir una migración de tipos. Los CHECKs son la red; la validación
-- con mensajes está en `src/lib/onboarding/profile.ts`.
--
-- `onboarding_completed_at` lo sella el servidor (rol de servicio) cuando
-- el perfil está completo Y la cuenta ya paga (o tiene plan manual). El
-- CHECK de abajo impide un sello sin perfil, así que ni un UPDATE directo
-- del owner a PostgREST puede saltarse el paso 1; y saltarse el pago no
-- depende del sello sino de `subscriptions.status`, que el inquilino no
-- puede escribir (041: sin política de escritura).
-- ============================================================
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS country text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS phone text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS industry text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS team_size text;
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS onboarding_completed_at timestamptz;

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_country_format;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_country_format
  CHECK (country IS NULL OR country ~ '^[A-Z]{2}$');

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_phone_length;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_phone_length
  CHECK (phone IS NULL OR char_length(phone) BETWEEN 6 AND 32);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_industry_length;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_industry_length
  CHECK (industry IS NULL OR char_length(industry) BETWEEN 1 AND 40);

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_team_size_check;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_team_size_check
  CHECK (team_size IS NULL OR team_size IN ('1', '2-5', '6-20', '21-50', '51+'));

ALTER TABLE accounts DROP CONSTRAINT IF EXISTS accounts_onboarding_needs_profile;
ALTER TABLE accounts
  ADD CONSTRAINT accounts_onboarding_needs_profile
  CHECK (
    onboarding_completed_at IS NULL
    OR (country IS NOT NULL AND phone IS NOT NULL
        AND industry IS NOT NULL AND team_size IS NOT NULL)
  );

COMMENT ON COLUMN accounts.country IS 'País de la empresa, ISO-3166 alfa-2 (073).';
COMMENT ON COLUMN accounts.phone IS 'Teléfono de contacto de la empresa (073).';
COMMENT ON COLUMN accounts.industry IS 'Sector, clave de src/lib/onboarding/profile.ts (073).';
COMMENT ON COLUMN accounts.team_size IS 'Tamaño del equipo: 1, 2-5, 6-20, 21-50, 51+ (073).';
COMMENT ON COLUMN accounts.onboarding_completed_at IS
  'Alta terminada: perfil completo y cuenta pagando o con plan manual. Lo sella el servidor (073).';
