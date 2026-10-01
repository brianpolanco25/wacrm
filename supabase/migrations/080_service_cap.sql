-- ============================================================
-- 080 — Cuota gratis de mensajes de servicio por número (p11.3).
--
-- Desde el 2026-10-01 Meta regala 1.000 mensajes de servicio entregados
-- por número y mes y cobra los siguientes (supuestos S-C1…S-C6 del spec
-- `specs/service-cap-per-number/design.md`, sin verificar contra Meta).
-- La IA del CRM responde sola a cada entrante y puede agotar esa cuota
-- sin que nadie lo note. Esta migración añade:
--
--   accounts.service_cap_action  'warn' (por defecto) | 'pause_ai': qué
--                                hace la IA cuando un número agota la
--                                cuota del mes. Nunca bloquea lo entrante
--                                ni los envíos manuales (CP11).
--   service_quota_usage()        conteo del mes por número desde
--                                message_charges (075). Solo service_role:
--                                la RLS de message_charges deja leer solo
--                                a admin+, y el aviso de la bandeja es para
--                                todos los miembros; la app la llama con
--                                el account_id de la sesión (CP3).
--
-- Qué cuenta como cuota consumida: pricing_category = 'service',
-- entregado o leído desde p_since, con número, y sin pricing_type =
-- 'free_entry_point' (ventana de 72 h de un anuncio Click to WhatsApp).
-- `billable` cuenta cuántos de ellos Meta ya cobra: la app trata el
-- número como agotado si used >= 1000 o billable > 0.
--
-- CP11: no toca messages, conversations ni message_charges. El ALTER de
-- accounts toma un lock breve; con lock_timeout falla en 5 s en vez de
-- esperar. DEFAULT constante: en PG >= 11 no reescribe la tabla.
--
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE accounts
  ADD COLUMN IF NOT EXISTS service_cap_action text NOT NULL DEFAULT 'warn';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.accounts'::regclass
      AND conname = 'accounts_service_cap_action_check'
  ) THEN
    ALTER TABLE accounts
      ADD CONSTRAINT accounts_service_cap_action_check
      CHECK (service_cap_action IN ('warn', 'pause_ai'));
  END IF;
END
$$;

RESET lock_timeout;

COMMENT ON COLUMN accounts.service_cap_action IS
  'p11.3: qué hace la IA cuando un número agota los 1.000 mensajes de servicio gratis del mes: warn (solo avisar, por defecto) | pause_ai (la IA no responde sola desde ese número hasta el mes siguiente). Nunca bloquea entrantes ni envíos manuales.';

CREATE OR REPLACE FUNCTION public.service_quota_usage(
  p_account_id uuid,
  p_since timestamptz
)
RETURNS TABLE (whatsapp_config_id uuid, used bigint, billable bigint)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  SELECT mc.whatsapp_config_id,
         count(*)                                    AS used,
         count(*) FILTER (WHERE mc.pricing_billable) AS billable
  FROM message_charges mc
  WHERE mc.account_id = p_account_id
    AND mc.whatsapp_config_id IS NOT NULL
    AND mc.pricing_category = 'service'
    AND mc.status IN ('delivered', 'read')
    AND mc.delivered_at >= p_since
    AND mc.pricing_type IS DISTINCT FROM 'free_entry_point'
  GROUP BY mc.whatsapp_config_id
$$;

REVOKE ALL ON FUNCTION public.service_quota_usage(uuid, timestamptz) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.service_quota_usage(uuid, timestamptz) FROM anon;
REVOKE ALL ON FUNCTION public.service_quota_usage(uuid, timestamptz) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.service_quota_usage(uuid, timestamptz) TO service_role;

COMMENT ON FUNCTION public.service_quota_usage(uuid, timestamptz) IS
  'p11.3: mensajes de servicio entregados por número de una cuenta desde p_since (used) y cuántos cobra Meta (billable). Excluye free_entry_point. Solo service_role; la app pasa el account_id de la sesión.';
