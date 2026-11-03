-- ============================================================
-- 091 — Catálogo de integraciones (n13.1 `integrations-catalog`).
--
-- 090 reservada por la fase 12 (`feat/invitacion-directa`); si al fusionar
-- no existe, el hueco es intencional (ya hay 081 y 085).
--
-- Modelo declarativo (D1): el operador de plataforma da de alta una
-- integración (origen HTTPS + esquema de autenticación) y sus operaciones
-- (método, ruta con marcadores, parámetros tipados) como FILAS; un único
-- ejecutor (`src/lib/integrations/execute.ts`) las convierte en peticiones.
--
-- Tablas
--   integrations            catálogo global, sin account_id. Nace en
--                           borrador (is_active = false).
--   integration_operations  operaciones de una integración.
--   account_integrations    activación por cuenta; `credential` es
--                           encrypt() de src/lib/whatsapp/encryption.ts y
--                           se pone a NULL al desactivar (D5).
--   integration_calls       registro de llamadas: resultado, código y
--                           latencia; NUNCA cuerpos, cabeceras ni params.
--
-- Hacia `integrations`, ON DELETE RESTRICT (no hay ruta de borrado; se
-- desactiva). Desde `accounts`, CASCADE: convención del repo para filas
-- de la propia cuenta, solo se dispara al borrar la empresa entera.
--
-- RLS: activada y sin políticas en las cuatro; ni `anon` ni
-- `authenticated` las tocan. Solo el rol de servicio, detrás de
-- /api/platform/integrations y /api/account/integrations.
--
-- Plan (D2): nueva clave booleana de `plans.features`; esta migración no
-- se la da a ningún plan.
-- Claves de `features` añadidas: integrations.
--
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug             text NOT NULL UNIQUE,
  name             text NOT NULL,
  description      text,
  logo_url         text,
  base_url         text NOT NULL,
  auth_scheme      text NOT NULL,
  auth_header_name text,
  credential_help  text,
  test_path        text NOT NULL,
  is_active        boolean NOT NULL DEFAULT false,
  sort_order       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  updated_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS integration_operations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  integration_id       uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  key                  text NOT NULL,
  name                 text NOT NULL,
  description          text NOT NULL,
  method               text NOT NULL,
  path                 text NOT NULL,
  params               jsonb NOT NULL DEFAULT '[]'::jsonb,
  outputs              jsonb NOT NULL DEFAULT '[]'::jsonb,
  response_description text,
  is_active            boolean NOT NULL DEFAULT true,
  sort_order           integer NOT NULL DEFAULT 0,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  UNIQUE (integration_id, key)
);

CREATE TABLE IF NOT EXISTS account_integrations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  integration_id   uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  is_enabled       boolean NOT NULL DEFAULT false,
  credential       text,
  credential_last4 text,
  enabled_by       uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  enabled_at       timestamptz,
  last_tested_at   timestamptz,
  last_test_status text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (account_id, integration_id)
);

CREATE TABLE IF NOT EXISTS integration_calls (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  integration_id  uuid NOT NULL REFERENCES integrations(id) ON DELETE RESTRICT,
  operation_key   text,
  source          text NOT NULL,
  outcome         text NOT NULL,
  status_code     integer,
  latency_ms      integer NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now()
);

RESET lock_timeout;

DO $$
BEGIN
  -- integrations ---------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integrations'::regclass
                   AND conname = 'integrations_slug_format') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_slug_format
      CHECK (slug ~ '^[a-z][a-z0-9-]{1,39}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integrations'::regclass
                   AND conname = 'integrations_base_url_https') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_base_url_https
      CHECK (base_url LIKE 'https://%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integrations'::regclass
                   AND conname = 'integrations_auth_scheme') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_auth_scheme
      CHECK (auth_scheme IN ('bearer', 'header'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integrations'::regclass
                   AND conname = 'integrations_header_name') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_header_name
      CHECK (auth_scheme <> 'header' OR auth_header_name IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integrations'::regclass
                   AND conname = 'integrations_test_path') THEN
    ALTER TABLE integrations ADD CONSTRAINT integrations_test_path
      CHECK (test_path LIKE '/%');
  END IF;

  -- integration_operations ----------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_key_format') THEN
    ALTER TABLE integration_operations ADD CONSTRAINT integration_operations_key_format
      CHECK (key ~ '^[a-z][a-z0-9_]{1,63}$');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_method') THEN
    ALTER TABLE integration_operations ADD CONSTRAINT integration_operations_method
      CHECK (method IN ('GET', 'POST', 'PUT', 'PATCH', 'DELETE'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_path') THEN
    ALTER TABLE integration_operations ADD CONSTRAINT integration_operations_path
      CHECK (path LIKE '/%');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_params_array') THEN
    ALTER TABLE integration_operations ADD CONSTRAINT integration_operations_params_array
      CHECK (jsonb_typeof(params) = 'array');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_outputs_array') THEN
    ALTER TABLE integration_operations ADD CONSTRAINT integration_operations_outputs_array
      CHECK (jsonb_typeof(outputs) = 'array');
  END IF;

  -- account_integrations ------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.account_integrations'::regclass
                   AND conname = 'account_integrations_enabled_has_credential') THEN
    ALTER TABLE account_integrations ADD CONSTRAINT account_integrations_enabled_has_credential
      CHECK (NOT is_enabled OR credential IS NOT NULL);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.account_integrations'::regclass
                   AND conname = 'account_integrations_test_status') THEN
    ALTER TABLE account_integrations ADD CONSTRAINT account_integrations_test_status
      CHECK (last_test_status IS NULL
             OR last_test_status IN ('ok', 'auth_failed', 'unreachable', 'error'));
  END IF;

  -- integration_calls ---------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_calls'::regclass
                   AND conname = 'integration_calls_source') THEN
    ALTER TABLE integration_calls ADD CONSTRAINT integration_calls_source
      CHECK (source IN ('test', 'flow', 'ai', 'automation'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_calls'::regclass
                   AND conname = 'integration_calls_outcome') THEN
    ALTER TABLE integration_calls ADD CONSTRAINT integration_calls_outcome
      CHECK (outcome IN ('ok', 'http_error', 'timeout', 'too_large', 'unreachable',
                         'blocked', 'rate_limited', 'invalid_params', 'not_enabled',
                         'error'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS integration_calls_account_created_idx
  ON integration_calls (account_id, created_at DESC);
CREATE INDEX IF NOT EXISTS account_integrations_integration_idx
  ON account_integrations (integration_id) WHERE is_enabled;

DROP TRIGGER IF EXISTS set_updated_at ON integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON integration_operations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON integration_operations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
DROP TRIGGER IF EXISTS set_updated_at ON account_integrations;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON account_integrations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

ALTER TABLE integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE account_integrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE integration_calls ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON integrations FROM anon, authenticated;
REVOKE ALL ON integration_operations FROM anon, authenticated;
REVOKE ALL ON account_integrations FROM anon, authenticated;
REVOKE ALL ON integration_calls FROM anon, authenticated;
GRANT ALL ON integrations TO service_role;
GRANT ALL ON integration_operations TO service_role;
GRANT ALL ON account_integrations TO service_role;
GRANT ALL ON integration_calls TO service_role;

COMMENT ON TABLE integrations IS
  'Catálogo global de integraciones (n13.1): origen HTTPS fijado por el operador '
  'de plataforma y esquema de autenticación. Sin account_id. Solo rol de servicio.';
COMMENT ON TABLE integration_operations IS
  'Operaciones declarativas de una integración: método, ruta con marcadores, '
  'parámetros tipados y salidas. Solo rol de servicio.';
COMMENT ON TABLE account_integrations IS
  'Activación de una integración por cuenta, con su credencial cifrada. Solo rol de servicio.';
COMMENT ON COLUMN account_integrations.credential IS
  'encrypt(); nunca en claro. NULL al desactivar (D5).';
COMMENT ON TABLE integration_calls IS
  'Registro de llamadas a integraciones: resultado, código HTTP y latencia. '
  'Sin cuerpos, cabeceras ni parámetros. Solo rol de servicio.';
