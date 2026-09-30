-- ============================================================
-- 071_platform_provisioning.sql — Fase 9 (s9.4): crear recursos
-- desde el panel de plataforma
--
-- El panel deja de ser solo de lectura + suspender: el operador crea
-- empresas (invitando al propietario), asigna un plan a mano, invita
-- miembros a una cuenta y concede o revoca el rol de operador. Todo eso
-- es un acto de la plataforma sobre algo que no es suyo, y se audita en
-- la MISMA bitácora que la impersonación y la suspensión (058): quien
-- quiera saber qué se le ha hecho a una cuenta mira un sitio.
--
-- 1. `impersonation_log.action` admite cinco actos más
--
--      plan_override    plan asignado a mano (provider = 'manual')
--      account_create   empresa creada desde el panel
--      member_invite    invitación de un miembro a una cuenta
--      operator_grant   alta de un operador de plataforma
--      operator_revoke  baja de un operador de plataforma
--
--    Drop-then-add del CHECK con el mismo nombre que la 058. La caducidad
--    sigue siendo obligatoria solo para `impersonation`
--    (`impersonation_log_session_needs_expiry` no se toca), y
--    `has_open_support_session()` sigue filtrando por
--    `action = 'impersonation'` (058): una fila de plan manual o de alta
--    de operador no concede la lectura de nadie. No se recrea aquí; la
--    aserción de verify-schema lo vigila.
--
-- 2. `details jsonb` — lo que cada acto necesita recordar
--
--    El plan de antes y el de después, el correo invitado, el rol, el
--    usuario al que se le concedió el rol de operador. Un jsonb y no
--    columnas sueltas: cada acto guarda cosas distintas y la bitácora no
--    debe crecer una columna por acto. NULL en las filas anteriores.
--
-- 3. `account_id` deja de ser NOT NULL, SOLO para tres actos
--
--    `account_create`: la fila se escribe ANTES del acto (misma regla
--    que `[id]/hold`: si no se puede registrar, no se hace). En ese
--    momento la cuenta todavía no existe: nace cuando Supabase crea el
--    usuario invitado y `handle_new_user()` (017) le da su cuenta. La
--    ruta rellena `account_id` en cuanto la conoce.
--
--    `operator_grant` / `operator_revoke`: el rol de operador está por
--    encima de las cuentas (055); atarlo a la cuenta de inquilino del
--    usuario afectado haría que su empresa enseñara en su ficha un acto
--    que no le concierne. El usuario afectado va en `details`.
--
--    Todo lo demás sigue exigiendo cuenta: un CHECK lo dice en voz alta
--    para que una impersonación o una suspensión sin cuenta no pueda
--    colarse por otro camino.
--
--    Alternativa descartada: crear la cuenta en el momento con
--    `INSERT INTO accounts` y enseñar a `handle_new_user()` a respetarla.
--    `accounts.owner_user_id` es NOT NULL y apunta a `auth.users`, así
--    que la cuenta no puede existir antes que el usuario; y como
--    `inviteUserByEmail` crea el usuario (y dispara el trigger) en la
--    misma llamada, la cuenta ya existe cuando la ruta recibe la
--    respuesta. No hace falta tocar `handle_new_user()` ni
--    `redeem_invitation()`.
--
-- 4. Operadores: dos funciones, por atomicidad
--
--    Conceder y revocar escriben dos tablas (la bitácora y
--    `platform_admins`) y la revocación tiene dos reglas que dependen de
--    las demás filas: no a uno mismo y nunca el último operador. Desde
--    TypeScript eso son varias peticiones y una carrera: dos operadores
--    que se revocan el uno al otro a la vez dejarían el servicio sin
--    nadie que lo opere. Dentro de una función, la bitácora y el acto van
--    en la misma transacción y la tabla se bloquea para la comprobación.
--
--    Sin SECURITY DEFINER y ejecutables solo por `service_role`, igual
--    que `platform_account_list()` (058): la única llamada es
--    `/api/platform/operators*`, detrás de `requirePlatformAdmin()`.
--
-- Idempotente — safe to re-run: ADD COLUMN IF NOT EXISTS, restricciones
-- en drop-then-add, DROP NOT NULL (no-op si ya lo es), CREATE OR REPLACE.
-- ============================================================

-- ============================================================
-- 1. Los actos nuevos
-- ============================================================

ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN (
    'impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite',
    'operator_grant', 'operator_revoke'
  ));

COMMENT ON COLUMN impersonation_log.action IS
  'Qué hizo el operador: impersonation (sesión de soporte, el valor por '
  'defecto), suspend/reactivate (058), plan_override, account_create, '
  'member_invite, operator_grant, operator_revoke (071).';

-- ============================================================
-- 2. Lo que cada acto necesita recordar
-- ============================================================

ALTER TABLE impersonation_log
  ADD COLUMN IF NOT EXISTS details jsonb;

COMMENT ON COLUMN impersonation_log.details IS
  'Datos del acto (071): plan de antes y de después, correo invitado, rol, '
  'usuario afectado… NULL en las filas anteriores a la 071.';

-- ============================================================
-- 3. Cuenta opcional, solo para los actos que aún no la tienen
-- ============================================================

ALTER TABLE impersonation_log ALTER COLUMN account_id DROP NOT NULL;

ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_account_required;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_account_required
  CHECK (
    account_id IS NOT NULL
    OR action IN ('account_create', 'operator_grant', 'operator_revoke')
  );

-- «¿Qué se le ha hecho a este operador?» — la bitácora de la página de
-- operadores busca por el usuario afectado, que vive en `details`.
CREATE INDEX IF NOT EXISTS idx_impersonation_log_operator_target
  ON impersonation_log ((details ->> 'target_user_id'), started_at DESC)
  WHERE action IN ('operator_grant', 'operator_revoke');

-- ============================================================
-- 4. Conceder y revocar el rol de operador
--
-- Errores con código propio para que la ruta los traduzca sin comparar
-- mensajes:
--   P0001 + 'operator_self'   revocarse a uno mismo
--   P0001 + 'operator_last'   revocar al último operador
--   P0001 + 'operator_absent' el usuario no es operador
--   P0001 + 'operator_exists' el usuario ya es operador
--   P0001 + 'user_absent'     el usuario no tiene perfil (no existe)
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_grant_operator(
  p_user   uuid,
  p_by     uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  -- `profiles` y no `auth.users`: service_role no tiene SELECT sobre el
  -- esquema auth, y desde la 017 todo usuario tiene su perfil con correo.
  SELECT p.email INTO v_email FROM profiles p WHERE p.user_id = p_user;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'user_absent';
  END IF;

  IF EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = p_user) THEN
    RAISE EXCEPTION 'operator_exists';
  END IF;

  -- La bitácora primero, en la misma transacción: si el CHECK del
  -- motivo la rechaza, no hay alta.
  INSERT INTO impersonation_log (
    actor_user_id, account_id, account_name, reason, action,
    expires_at, details
  ) VALUES (
    p_by, NULL, NULL, btrim(p_reason), 'operator_grant', NULL,
    jsonb_build_object('target_user_id', p_user, 'target_email', v_email)
  );

  INSERT INTO platform_admins (user_id, granted_by, note)
  VALUES (p_user, p_by, btrim(p_reason));
END;
$$;

CREATE OR REPLACE FUNCTION public.platform_revoke_operator(
  p_user   uuid,
  p_by     uuid,
  p_reason text
)
RETURNS void
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_email text;
BEGIN
  IF p_user = p_by THEN
    RAISE EXCEPTION 'operator_self';
  END IF;

  -- Bloquea altas y bajas concurrentes mientras se cuenta: sin esto, dos
  -- revocaciones cruzadas verían cada una «quedan dos» y dejarían cero.
  -- Las lecturas (is_platform_admin) no se bloquean con este modo.
  LOCK TABLE platform_admins IN SHARE ROW EXCLUSIVE MODE;

  IF NOT EXISTS (SELECT 1 FROM platform_admins pa WHERE pa.user_id = p_user) THEN
    RAISE EXCEPTION 'operator_absent';
  END IF;

  IF (SELECT count(*) FROM platform_admins) <= 1 THEN
    RAISE EXCEPTION 'operator_last';
  END IF;

  SELECT p.email INTO v_email FROM profiles p WHERE p.user_id = p_user;

  INSERT INTO impersonation_log (
    actor_user_id, account_id, account_name, reason, action,
    expires_at, details
  ) VALUES (
    p_by, NULL, NULL, btrim(p_reason), 'operator_revoke', NULL,
    jsonb_build_object('target_user_id', p_user, 'target_email', v_email)
  );

  DELETE FROM platform_admins WHERE user_id = p_user;
END;
$$;

REVOKE ALL ON FUNCTION public.platform_grant_operator(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_grant_operator(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.platform_grant_operator(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.platform_grant_operator(uuid, uuid, text) TO service_role;

REVOKE ALL ON FUNCTION public.platform_revoke_operator(uuid, uuid, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_revoke_operator(uuid, uuid, text) FROM anon;
REVOKE ALL ON FUNCTION public.platform_revoke_operator(uuid, uuid, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.platform_revoke_operator(uuid, uuid, text) TO service_role;

COMMENT ON FUNCTION public.platform_grant_operator(uuid, uuid, text) IS
  'Concede platform_admins a un usuario existente y lo anota en la '
  'bitácora (operator_grant) en la misma transacción. Solo service_role.';
COMMENT ON FUNCTION public.platform_revoke_operator(uuid, uuid, text) IS
  'Revoca platform_admins (nunca a uno mismo ni al último operador) y lo '
  'anota en la bitácora (operator_revoke) en la misma transacción. Solo '
  'service_role.';
