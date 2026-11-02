-- ============================================================
-- 087_platform_password_set.sql — bitácora: cambio manual de contraseña
--
-- Un operador de la plataforma puede fijar la contraseña de un miembro
-- desde la ficha de su cuenta, sin correo (el reset por correo de
-- Supabase tiene un límite de envíos y no sirve cuando se agota). Es de
-- lo más sensible que hace un operador, así que va a la bitácora como
-- acto propio: `password_set`. La ruta se niega a actuar si no puede
-- escribir esa línea.
--
-- Solo amplía la lista del CHECK (058, 071, 078); no toca datos.
-- ============================================================

ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN (
    'impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite',
    'operator_grant', 'operator_revoke',
    'payment_confirmed', 'statement_void',
    'password_set'
  ));

COMMENT ON COLUMN impersonation_log.action IS
  'Qué hizo el operador: impersonation (sesión de soporte, el valor por '
  'defecto), suspend/reactivate (058), plan_override, account_create, '
  'member_invite, operator_grant, operator_revoke (071), '
  'payment_confirmed, statement_void (078), password_set (087).';
