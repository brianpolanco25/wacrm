-- ============================================================
-- 079 — Estado del método de pago del WABA en Meta (p11.1).
--
-- Desde el 2026-10-01 Meta deja de entregar los mensajes de un WABA
-- sin método de pago. El CRM no tenía forma de saberlo: el cliente veía
-- «Conectado» y sus mensajes no llegaban. Esta migración guarda, por
-- número, lo último que dijo Meta, para que el banner del CRM no tenga
-- que preguntar en cada render:
--
--   meta_payment_status      'ok' | 'missing' | 'unknown', o NULL =
--                            nunca comprobado (o invalidado, ver abajo);
--   meta_payment_checked_at  cuándo se comprobó por última vez;
--   meta_payment_error       el mensaje de Meta si salió 'unknown'
--                            (solo el mensaje: nunca el token).
--
-- Solo el servidor (rol de servicio) escribe estas columnas. La política
-- UPDATE de la 017 deja a un admin del cliente editar su fila desde el
-- navegador, y sin el disparador de abajo podría marcarse 'ok' a sí
-- mismo y la ficha del superadmin mentiría. Cambiar el WABA o el token
-- desde la sesión del cliente invalida el estado (NULL) para que el
-- siguiente barrido lo mire primero.
--
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_status TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_checked_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS meta_payment_error TEXT;

-- CHECK en un DO, como whatsapp_config_provisioned_via_check en la 054.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_meta_payment_status_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_meta_payment_status_check
      CHECK (meta_payment_status IS NULL
             OR meta_payment_status IN ('ok', 'missing', 'unknown'));
  END IF;
END
$$;

-- El barrido de /api/webhooks/cron ordena por esto (NULL primero) y
-- solo mira números conectados con WABA.
CREATE INDEX IF NOT EXISTS whatsapp_config_meta_payment_checked_idx
  ON whatsapp_config (meta_payment_checked_at NULLS FIRST)
  WHERE status = 'connected' AND waba_id IS NOT NULL;

-- R2/R3 del spec. `current_user` como discriminador, mismo criterio que
-- la 034: PostgREST cambia de rol por petición (`authenticated`/`anon`
-- para el cliente, `service_role` para el servidor) y las migraciones
-- corren como `postgres`.
CREATE OR REPLACE FUNCTION whatsapp_config_guard_meta_payment()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.meta_payment_status := NULL;
      NEW.meta_payment_checked_at := NULL;
      NEW.meta_payment_error := NULL;
    ELSIF NEW.waba_id IS DISTINCT FROM OLD.waba_id
       OR NEW.access_token IS DISTINCT FROM OLD.access_token THEN
      NEW.meta_payment_status := NULL;
      NEW.meta_payment_checked_at := NULL;
      NEW.meta_payment_error := NULL;
    ELSE
      NEW.meta_payment_status := OLD.meta_payment_status;
      NEW.meta_payment_checked_at := OLD.meta_payment_checked_at;
      NEW.meta_payment_error := OLD.meta_payment_error;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS whatsapp_config_guard_meta_payment ON whatsapp_config;
CREATE TRIGGER whatsapp_config_guard_meta_payment
  BEFORE INSERT OR UPDATE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_config_guard_meta_payment();

COMMENT ON COLUMN whatsapp_config.meta_payment_status IS
  'Método de pago del WABA en Meta según la última comprobación: ok | missing | unknown; NULL = sin comprobar. Lo escribe solo el servidor (p11.1); el disparador whatsapp_config_guard_meta_payment lo protege del cliente.';
COMMENT ON COLUMN whatsapp_config.meta_payment_checked_at IS
  'Cuándo se comprobó por última vez el método de pago del WABA (p11.1). El barrido del cron lo usa para decidir qué número toca.';
COMMENT ON COLUMN whatsapp_config.meta_payment_error IS
  'Mensaje de Meta de la última comprobación fallida (unknown), truncado a 500 caracteres. NULL tras ok o missing. Nunca contiene el token.';
