-- ============================================================
-- Shim de GoTrue para el Postgres del harness (s9.7). NO es del repo.
--
-- La imagen supabase/postgres:17.4.1.075 trae el esquema `auth` base
-- (sin las migraciones de GoTrue): ni `email_confirmed_at`, ni
-- `auth.identities`, y `confirmed_at` es una columna normal. En
-- `supabase db reset --local` ese esquema lo completa GoTrue antes del
-- seed. Esto reproduce, a mano y solo para probar supabase/seed.sql, las
-- columnas que el seed escribe con la forma que tienen en GoTrue v2.
-- Ejecutar como supabase_admin, una vez, tras replay-migrations.sh.
-- ============================================================
ALTER TABLE auth.users
  ADD COLUMN IF NOT EXISTS email_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS phone text,
  ADD COLUMN IF NOT EXISTS phone_confirmed_at timestamptz,
  ADD COLUMN IF NOT EXISTS email_change_token_new varchar(255),
  ADD COLUMN IF NOT EXISTS email_change_token_current varchar(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone_change text DEFAULT '',
  ADD COLUMN IF NOT EXISTS phone_change_token varchar(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS reauthentication_token varchar(255) DEFAULT '',
  ADD COLUMN IF NOT EXISTS is_sso_user boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS is_anonymous boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS deleted_at timestamptz;

-- En GoTrue `confirmed_at` es generada; el seed no debe escribirla.
ALTER TABLE auth.users DROP COLUMN IF EXISTS confirmed_at;
ALTER TABLE auth.users
  ADD COLUMN confirmed_at timestamptz
  GENERATED ALWAYS AS (LEAST(email_confirmed_at, phone_confirmed_at)) STORED;

CREATE TABLE IF NOT EXISTS auth.identities (
  provider_id     text NOT NULL,
  user_id         uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  identity_data   jsonb NOT NULL,
  provider        text NOT NULL,
  last_sign_in_at timestamptz,
  created_at      timestamptz,
  updated_at      timestamptz,
  email           text GENERATED ALWAYS AS (lower(identity_data ->> 'email')) STORED,
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  CONSTRAINT identities_provider_id_provider_unique UNIQUE (provider_id, provider)
);

-- Mismo dueño y permisos que auth.users en la imagen (y que en Supabase).
ALTER TABLE auth.identities OWNER TO supabase_auth_admin;
GRANT ALL ON auth.identities TO postgres, dashboard_user;
