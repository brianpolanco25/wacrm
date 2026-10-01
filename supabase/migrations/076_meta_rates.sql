-- ============================================================
-- 076_meta_rates.sql — Fase 10 (s10.2 `meta-rate-card`)
--
-- Tarifario de Meta y política de precio por cuenta para la facturación
-- gestionada (el cliente le paga a Cabbity y Cabbity a Meta).
--
--   1. `meta_rates`: precio por mensaje entregado que Meta cobra, por
--      mercado y categoría, con fecha de vigencia. Una tarifa vigente
--      NUNCA se edita: un cambio de precio es una fila nueva con otra
--      `effective_from`, y la tarifa de un mensaje es la de la fila con
--      la `effective_from` más reciente que no sea posterior al día (UTC)
--      de entrega (`src/lib/billing/meta-rates.ts`).
--   2. `meta_market_countries`: país del destinatario (ISO-3166 alfa-2)
--      → mercado de la tarjeta de Meta. Un país sin fila cae en
--      `rest_of_world` si ese mercado tiene tarifa; si no, el cálculo
--      falla de forma visible (nunca resuelve a 0).
--   3. `subscriptions.meta_billing` (`direct` | `managed`) y
--      `subscriptions.meta_pricing` (jsonb, la política de precio de la
--      cuenta; `{}` = `direct`, sin precio). Su forma la valida
--      `src/lib/billing/meta-pricing.ts`, no la base: es lo que permite
--      cambiar el precio por mensaje de una cuenta sin migración.
--
-- Semilla: SOLO lo que consta en el repo (spec de la fase 10, cambio de
-- precios de Meta del 2026-10-01): «Resto de Latinoamérica» a 0,0113 USD
-- servicio y utilidad y 0,0740 USD marketing. Autenticación, México,
-- Colombia, Brasil, Norteamérica, España y `rest_of_world` no tienen dato
-- local y quedan sin tarifa (sus países sí se asignan a su mercado): las
-- carga el superadmin desde /platform/rates (importador CSV con la
-- tarjeta de Meta). Mientras no estén, un mensaje de esos mercados o de
-- autenticación falla con `MetaRateMissingError`.
--
-- RLS: lectura para cualquier autenticado (como `plans`), sin políticas de
-- escritura → solo el rol de servicio escribe, detrás de
-- `requirePlatformAdmin()` en /api/platform/rates.
--
-- Idempotente: IF NOT EXISTS, DROP … IF EXISTS antes de cada CHECK y
-- política, ON CONFLICT DO NOTHING en la semilla (una segunda pasada no
-- pisa una tarifa ni un país que el superadmin haya cambiado).
-- ============================================================

-- 1. meta_rates ---------------------------------------------------

CREATE TABLE IF NOT EXISTS meta_rates (
  market          text          NOT NULL,
  category        text          NOT NULL,
  usd_per_message numeric(8,5)  NOT NULL,
  effective_from  date          NOT NULL,
  created_at      timestamptz   NOT NULL DEFAULT now(),
  created_by      uuid,
  PRIMARY KEY (market, category, effective_from)
);

ALTER TABLE meta_rates DROP CONSTRAINT IF EXISTS meta_rates_category_check;
ALTER TABLE meta_rates
  ADD CONSTRAINT meta_rates_category_check
  CHECK (category IN ('service', 'utility', 'marketing', 'authentication',
                      'authentication_international'));

ALTER TABLE meta_rates DROP CONSTRAINT IF EXISTS meta_rates_usd_check;
ALTER TABLE meta_rates
  ADD CONSTRAINT meta_rates_usd_check CHECK (usd_per_message > 0);

ALTER TABLE meta_rates DROP CONSTRAINT IF EXISTS meta_rates_market_check;
ALTER TABLE meta_rates
  ADD CONSTRAINT meta_rates_market_check
  CHECK (market ~ '^[a-z][a-z0-9_]{1,39}$');

-- 2. meta_market_countries ---------------------------------------

CREATE TABLE IF NOT EXISTS meta_market_countries (
  country_code text        PRIMARY KEY,
  market       text        NOT NULL,
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE meta_market_countries
  DROP CONSTRAINT IF EXISTS meta_market_countries_country_check;
ALTER TABLE meta_market_countries
  ADD CONSTRAINT meta_market_countries_country_check
  CHECK (country_code ~ '^[A-Z]{2}$');

ALTER TABLE meta_market_countries
  DROP CONSTRAINT IF EXISTS meta_market_countries_market_check;
ALTER TABLE meta_market_countries
  ADD CONSTRAINT meta_market_countries_market_check
  CHECK (market ~ '^[a-z][a-z0-9_]{1,39}$');

-- 3. RLS ----------------------------------------------------------

ALTER TABLE meta_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE meta_market_countries ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS meta_rates_select ON meta_rates;
CREATE POLICY meta_rates_select ON meta_rates FOR SELECT
  TO authenticated
  USING (true);

DROP POLICY IF EXISTS meta_market_countries_select ON meta_market_countries;
CREATE POLICY meta_market_countries_select ON meta_market_countries FOR SELECT
  TO authenticated
  USING (true);

-- 4. subscriptions: facturación de Meta por cuenta ----------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS meta_billing text NOT NULL DEFAULT 'direct';
ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS meta_pricing jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_meta_billing_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_meta_billing_check
  CHECK (meta_billing IN ('direct', 'managed'));

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_meta_pricing_object_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_meta_pricing_object_check
  CHECK (jsonb_typeof(meta_pricing) = 'object');

-- 5. Semilla ------------------------------------------------------

-- Tarjeta de Meta vigente desde el 2026-10-01, «Resto de Latinoamérica».
-- Sin fila de autenticación: no hay dato en el repo.
INSERT INTO meta_rates (market, category, usd_per_message, effective_from)
VALUES
  ('rest_of_latam', 'service',   0.01130, DATE '2026-10-01'),
  ('rest_of_latam', 'utility',   0.01130, DATE '2026-10-01'),
  ('rest_of_latam', 'marketing', 0.07400, DATE '2026-10-01')
ON CONFLICT (market, category, effective_from) DO NOTHING;

-- RD y sus vecinos del Caribe, Centroamérica y Sudamérica que Meta agrupa
-- en «Resto de Latinoamérica» (Argentina, Chile, Perú, Colombia, México y
-- Brasil son mercados propios en la tarjeta de Meta y quedan fuera).
-- Editable desde /platform/rates.
INSERT INTO meta_market_countries (country_code, market)
VALUES
  ('DO', 'rest_of_latam'),
  ('HT', 'rest_of_latam'),
  ('JM', 'rest_of_latam'),
  ('GT', 'rest_of_latam'),
  ('SV', 'rest_of_latam'),
  ('HN', 'rest_of_latam'),
  ('NI', 'rest_of_latam'),
  ('CR', 'rest_of_latam'),
  ('PA', 'rest_of_latam'),
  ('EC', 'rest_of_latam'),
  ('VE', 'rest_of_latam'),
  ('BO', 'rest_of_latam'),
  ('PY', 'rest_of_latam'),
  ('UY', 'rest_of_latam')
ON CONFLICT (country_code) DO NOTHING;

-- Países que Meta factura en un mercado PROPIO. Van con su mercado aunque
-- todavía no haya tarifa: así un destinatario de México falla con
-- «falta la tarifa de mexico» en vez de caer en `rest_of_world` y
-- cobrarse a un precio que no es el suyo. Sus tarifas las carga el
-- superadmin.
INSERT INTO meta_market_countries (country_code, market)
VALUES
  ('MX', 'mexico'),
  ('CO', 'colombia'),
  ('BR', 'brazil'),
  ('AR', 'argentina'),
  ('CL', 'chile'),
  ('PE', 'peru'),
  ('US', 'north_america'),
  ('CA', 'north_america'),
  ('ES', 'spain')
ON CONFLICT (country_code) DO NOTHING;
