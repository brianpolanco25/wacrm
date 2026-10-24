-- ============================================================
-- 086_whatsapp_config_app_secret.sql — secreto de app de Meta por número
--
-- Un número conectado a través de la app de Meta DEL CLIENTE (su propio
-- WABA, su propio token de usuario de sistema — la forma que exige la
-- coexistencia con la app WhatsApp Business mientras la app de Cabbity
-- no tenga la App Review aprobada para terceros) apunta el webhook de
-- esa app a la misma URL del CRM, y Meta firma esas entregas con el
-- secreto de ESA app, no con `META_APP_SECRET`. Esta columna guarda ese
-- secreto, cifrado igual que `access_token` (AES-256-GCM con
-- `ENCRYPTION_KEY`), y `src/lib/whatsapp/tenant-app-secret.ts` lo usa
-- como segunda verificación de firma cuando la del secreto de la
-- plataforma falla. NULL = el número va por la app de la plataforma.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS app_secret TEXT;

COMMENT ON COLUMN whatsapp_config.app_secret IS
  'Secreto de la app de Meta propia del cliente, cifrado como access_token. NULL = el número usa la app de la plataforma (META_APP_SECRET).';
