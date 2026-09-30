-- ============================================================
-- 070_plan_provider_history.sql — Fase 9 (s9.3): planes desde el panel
-- del operador y su sincronización con PayPal.
--
-- 1. `plan_provider_history`
--    Un plan de PayPal con suscriptores no se reescribe: cambiar el precio
--    de un plan nuestro obliga a crear un plan NUEVO en PayPal y a apuntar
--    `plans.provider_plan_id_<ciclo>` a él. Esta tabla guarda cada id que
--    ha tenido un plan por ciclo y el precio con el que se creó, para:
--      - saber si el precio actual de `plans` coincide con el que cobra
--        PayPal («sincronizado» / «precio desincronizado»);
--      - no perder los ids antiguos: los suscriptores que ya estaban siguen
--        en ellos al precio viejo (decisión 5 del humano, mismo criterio
--        que la 065). Nada aquí los migra.
--    La fila vigente de un plan y ciclo es la que no tiene `replaced_at`;
--    al sustituirla se rellenan `replaced_at` y `replaced_by` (la fila
--    nueva). `provider_env` dice en qué entorno de PayPal existe el id: un
--    id de sandbox no vale en live y no hay forma de distinguirlos a ojo.
--
--    FK a `plans` ON DELETE RESTRICT: el historial de lo que se ha cobrado
--    no se borra con el plan (ni el panel borra planes: los despublica).
--
--    RLS: lectura solo para `is_platform_admin()`; SIN políticas de
--    escritura. Escribe únicamente el rol de servicio, desde las rutas
--    `/api/platform/plans/*` detrás de `requirePlatformAdmin()`.
--
-- 2. `plans.created_at`, `plans.updated_at`, `plans.description`
--    Metadatos del editor. `updated_at` lo mantiene el mismo trigger que
--    el resto de tablas (`update_updated_at_column`). `plans` sigue sin
--    política de escritura: el inquilino la lee, el operador la escribe
--    con el rol de servicio.
--
-- Idempotente: CREATE TABLE / ADD COLUMN / CREATE INDEX IF NOT EXISTS,
-- constraints y políticas drop-then-create.
-- ============================================================

-- ------------------------------------------------------------
-- 1. plans: metadatos
-- ------------------------------------------------------------
ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS created_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS updated_at  timestamptz NOT NULL DEFAULT now(),
  ADD COLUMN IF NOT EXISTS description text;

DROP TRIGGER IF EXISTS set_updated_at ON plans;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- 2. plan_provider_history
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS plan_provider_history (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id          text NOT NULL,
  cycle            text NOT NULL,
  provider         text NOT NULL DEFAULT 'paypal',
  provider_plan_id text NOT NULL,
  price_usd        numeric(10,2) NOT NULL,
  provider_env     text NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  replaced_at      timestamptz,
  replaced_by      uuid,
  created_by       uuid
);

ALTER TABLE plan_provider_history
  DROP CONSTRAINT IF EXISTS plan_provider_history_plan_id_fkey;
ALTER TABLE plan_provider_history
  ADD CONSTRAINT plan_provider_history_plan_id_fkey
  FOREIGN KEY (plan_id) REFERENCES plans(id) ON DELETE RESTRICT;

ALTER TABLE plan_provider_history
  DROP CONSTRAINT IF EXISTS plan_provider_history_replaced_by_fkey;
ALTER TABLE plan_provider_history
  ADD CONSTRAINT plan_provider_history_replaced_by_fkey
  FOREIGN KEY (replaced_by) REFERENCES plan_provider_history(id) ON DELETE SET NULL;

ALTER TABLE plan_provider_history
  DROP CONSTRAINT IF EXISTS plan_provider_history_cycle_check;
ALTER TABLE plan_provider_history
  ADD CONSTRAINT plan_provider_history_cycle_check
  CHECK (cycle IN ('month', 'year'));

ALTER TABLE plan_provider_history
  DROP CONSTRAINT IF EXISTS plan_provider_history_provider_env_check;
ALTER TABLE plan_provider_history
  ADD CONSTRAINT plan_provider_history_provider_env_check
  CHECK (provider_env IN ('sandbox', 'live'));

-- PayPal nunca da el mismo id a dos planes: un id aparece una sola vez por
-- entorno. Es también lo que convierte dos sincronizaciones simultáneas del
-- mismo plan (misma PayPal-Request-Id → mismo id) en un conflicto visible
-- en vez de en dos filas vigentes.
CREATE UNIQUE INDEX IF NOT EXISTS plan_provider_history_provider_id_key
  ON plan_provider_history (provider, provider_env, provider_plan_id);

-- La consulta del estado de sincronización: fila vigente por plan y ciclo.
CREATE INDEX IF NOT EXISTS idx_plan_provider_history_plan_cycle
  ON plan_provider_history (plan_id, cycle, created_at DESC);

ALTER TABLE plan_provider_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS plan_provider_history_select ON plan_provider_history;
CREATE POLICY plan_provider_history_select ON plan_provider_history FOR SELECT
  TO authenticated
  USING (is_platform_admin(auth.uid()));
