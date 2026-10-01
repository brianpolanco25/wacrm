-- ============================================================
-- 084_meta_spend_snapshots.sql — Fase 10 (s10.7 `meta-reconciliation`)
--
-- Lo que Meta dice que costó un WABA, para conciliarlo con el estado de
-- cuenta (078). El barrido de `GET /api/billing/cron`
-- (`src/lib/billing/meta-reconciliation.ts`) baja `pricing_analytics`
-- del WABA de cada cuenta `managed` (COST + VOLUME por PHONE y
-- PRICING_CATEGORY, granularidad diaria, mes anterior y en curso) y
-- guarda una fila por día, número y categoría. La ficha del superadmin
-- suma `cost_usd` de los días de cada periodo y enseña la diferencia con
-- `statements.meta_cost_usd`. Meta advierte que ese COST es aproximado:
-- la factura de Meta es la verdad y la diferencia se ajusta a mano en el
-- siguiente estado; aquí no se ajusta nada.
--
-- Qué guarda
--   - `period_start`/`period_end`: el tramo del punto de Meta (un día UTC).
--   - `category`: la categoría de Meta en minúsculas, texto libre (como
--     `message_charges.pricing_category`, 075). `_none` es la marca de
--     «Meta respondió sin ningún dato» para ese día: volumen y costo 0;
--     así el barrido no vuelve a preguntar en el día y la ficha distingue
--     «Meta dice 0» de «sin dato de Meta».
--   - `whatsapp_config_id`: el número de la cuenta al que corresponde el
--     PHONE del punto; NULL si Meta no lo trae o no casa con ninguno. SIN
--     clave foránea a propósito: con `ON DELETE SET NULL` y el UNIQUE
--     NULLS NOT DISTINCT, borrar un número podía chocar con la fila NULL
--     del mismo día y categoría y hacer fallar el borrado del número.
--     El id queda como dato histórico.
--   - `raw`: el punto (o los puntos agregados) tal como vino, sin token.
--
-- Unicidad: (account_id, waba_id, period_start, period_end, category,
--   whatsapp_config_id) NULLS NOT DISTINCT (Postgres 15+): re-bajar el
--   mismo día actualiza la fila en vez de duplicarla, también con el
--   número en NULL.
--
-- RLS: activada y sin políticas. Ni `anon` ni `authenticated` leen ni
--   escriben (REVOKE ALL): es dato interno del superadmin, que lo lee
--   con rol de servicio filtrando por `account_id`.
--
-- CP11: tabla nueva; no se toca ninguna tabla del entrante.
-- Idempotente — se puede re-ejecutar.
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS meta_spend_snapshots (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_config_id uuid,
  waba_id            text NOT NULL,
  period_start       timestamptz NOT NULL,
  period_end         timestamptz NOT NULL,
  category           text NOT NULL,
  volume             integer NOT NULL DEFAULT 0,
  cost_usd           numeric(14,6) NOT NULL DEFAULT 0,
  fetched_at         timestamptz NOT NULL DEFAULT now(),
  raw                jsonb NOT NULL DEFAULT '{}'::jsonb,
  CONSTRAINT meta_spend_snapshots_key UNIQUE NULLS NOT DISTINCT
    (account_id, waba_id, period_start, period_end, category,
     whatsapp_config_id),
  CONSTRAINT meta_spend_snapshots_period_check
    CHECK (period_end > period_start),
  CONSTRAINT meta_spend_snapshots_amounts_check
    CHECK (volume >= 0 AND cost_usd >= 0),
  CONSTRAINT meta_spend_snapshots_category_check
    CHECK (length(btrim(category)) > 0),
  CONSTRAINT meta_spend_snapshots_waba_check
    CHECK (length(btrim(waba_id)) > 0)
);

RESET lock_timeout;

-- La ficha: los días de los periodos de una cuenta.
CREATE INDEX IF NOT EXISTS meta_spend_snapshots_account_period_idx
  ON meta_spend_snapshots (account_id, period_start);

-- El barrido: ¿cuándo se bajó por última vez esta cuenta?
CREATE INDEX IF NOT EXISTS meta_spend_snapshots_account_fetched_idx
  ON meta_spend_snapshots (account_id, fetched_at DESC);

ALTER TABLE meta_spend_snapshots ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON meta_spend_snapshots FROM anon, authenticated;
GRANT ALL ON meta_spend_snapshots TO service_role;

COMMENT ON TABLE meta_spend_snapshots IS
  'Costo y volumen que Meta reporta por WABA, día, número y categoría '
  '(pricing_analytics, 084, s10.7). Lo escribe el barrido de '
  '/api/billing/cron; lo lee la ficha del superadmin con rol de servicio.';
COMMENT ON COLUMN meta_spend_snapshots.category IS
  'Categoría de Meta en minúsculas. _none = Meta respondió sin datos ese día.';
COMMENT ON COLUMN meta_spend_snapshots.cost_usd IS
  'COST de pricing_analytics: aproximado según Meta. La factura de Meta manda.';
