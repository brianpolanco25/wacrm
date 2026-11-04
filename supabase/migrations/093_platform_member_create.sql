-- ============================================================
-- 093_platform_member_create.sql — bitácora: alta directa de un miembro (i12.2)
--
-- Un operador de la plataforma puede crear desde la ficha de una empresa
-- un miembro ya confirmado, con contraseña y sin correo (cuando el alta
-- por enlace se pierde: correo limitado, PKCE en otro navegador…). La
-- persona nace dentro de la empresa por el trigger de la 090 (invitación
-- efímera + `invite_token` en los metadatos). Va a la bitácora como acto
-- propio: `member_create`; la ruta no actúa si no puede escribir esa línea.
--
-- Solo amplía la lista del CHECK (058, 071, 078, 087); no toca datos.
-- Idempotente: DROP IF EXISTS + ADD.
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
    'password_set', 'member_create'
  ));

COMMENT ON COLUMN impersonation_log.action IS
  'Qué hizo el operador: impersonation (sesión de soporte, el valor por '
  'defecto), suspend/reactivate (058), plan_override, account_create, '
  'member_invite, operator_grant, operator_revoke (071), '
  'payment_confirmed, statement_void (078), password_set (087), '
  'member_create (093).';
