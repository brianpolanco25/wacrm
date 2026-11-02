-- ============================================================
-- 088 — Coexistencia: app de WhatsApp Business + Cloud API (#1650).
--
-- Un número conectado por Embedded Signup en modo coexistencia sigue en
-- la app de WhatsApp Business del teléfono y además está en Cloud API.
-- No pasa por /register, así que `registered_at` queda NULL y hace
-- falta otra marca para distinguirlo:
--
--   coexistence_onboarded_at       cuándo se conectó en coexistencia;
--                                  NULL = no es coexistencia. Abre la
--                                  ventana de 24 h de Meta para las
--                                  sincronizaciones.
--   smb_state_sync_requested_at    reclamo de la sincronización de
--   smb_state_sync_request_id      contactos (`smb_app_state_sync`) y su
--                                  request_id de Meta;
--   smb_history_sync_requested_at  ídem para el historial (`history`);
--   smb_history_sync_request_id
--   smb_sync_error                 último fallo de sincronización.
--
-- Meta admite cada sincronización UNA vez: una segunda petición obliga
-- a desconectar y repetir el onboarding. Por eso las cinco columnas
-- smb_* solo las escribe el servidor (rol de servicio): la política
-- UPDATE de la 017 deja a un admin editar su fila desde el navegador y,
-- sin el disparador de abajo, podría borrar los request_id y forzar una
-- segunda llamada. `coexistence_onboarded_at` no va protegida: la
-- escribe el upsert del propio tenant en el alta.
--
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS coexistence_onboarded_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS smb_state_sync_requested_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS smb_state_sync_request_id TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS smb_history_sync_requested_at TIMESTAMPTZ;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS smb_history_sync_request_id TEXT;
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS smb_sync_error TEXT;

-- Mismo criterio `current_user` que la 079: PostgREST cambia de rol por
-- petición (`authenticated`/`anon` para el cliente, `service_role` para
-- el servidor) y las migraciones corren como `postgres`.
CREATE OR REPLACE FUNCTION whatsapp_config_guard_smb_sync()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF current_user IN ('authenticated', 'anon') THEN
    IF TG_OP = 'INSERT' THEN
      NEW.smb_state_sync_requested_at := NULL;
      NEW.smb_state_sync_request_id := NULL;
      NEW.smb_history_sync_requested_at := NULL;
      NEW.smb_history_sync_request_id := NULL;
      NEW.smb_sync_error := NULL;
    ELSE
      NEW.smb_state_sync_requested_at := OLD.smb_state_sync_requested_at;
      NEW.smb_state_sync_request_id := OLD.smb_state_sync_request_id;
      NEW.smb_history_sync_requested_at := OLD.smb_history_sync_requested_at;
      NEW.smb_history_sync_request_id := OLD.smb_history_sync_request_id;
      NEW.smb_sync_error := OLD.smb_sync_error;
    END IF;
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS whatsapp_config_guard_smb_sync ON whatsapp_config;
CREATE TRIGGER whatsapp_config_guard_smb_sync
  BEFORE INSERT OR UPDATE ON whatsapp_config
  FOR EACH ROW EXECUTE FUNCTION whatsapp_config_guard_smb_sync();

COMMENT ON COLUMN whatsapp_config.coexistence_onboarded_at IS
  'Cuándo se conectó el número en coexistencia (app de WhatsApp Business + Cloud API) por Embedded Signup (#1650). NULL = no es coexistencia. Inicio de la ventana de 24 h de Meta para las sincronizaciones SMB.';
COMMENT ON COLUMN whatsapp_config.smb_state_sync_requested_at IS
  'Reclamo de la sincronización de contactos (smb_app_state_sync). Lo escribe solo el servidor; el disparador whatsapp_config_guard_smb_sync lo protege del cliente.';
COMMENT ON COLUMN whatsapp_config.smb_state_sync_request_id IS
  'request_id que devolvió Meta para smb_app_state_sync. No NULL = ya pedida: Meta no admite una segunda. Solo servidor.';
COMMENT ON COLUMN whatsapp_config.smb_history_sync_requested_at IS
  'Reclamo de la sincronización de historial (history). Solo servidor.';
COMMENT ON COLUMN whatsapp_config.smb_history_sync_request_id IS
  'request_id que devolvió Meta para history. No NULL = ya pedida: Meta no admite una segunda. Solo servidor.';
COMMENT ON COLUMN whatsapp_config.smb_sync_error IS
  'Último fallo de las sincronizaciones SMB, truncado a 500 caracteres; NULL si todas terminaron bien. Nunca contiene el token. Solo servidor.';
