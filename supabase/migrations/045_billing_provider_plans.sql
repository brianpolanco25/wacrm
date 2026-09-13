-- ============================================================
-- 045_billing_provider_plans.sql — Fase 3 (SaaS): vínculo con PayPal
--
-- El modelo de la fase 0 (041) es agnóstico a la pasarela. Esta
-- migración añade lo mínimo que hace falta para publicar el catálogo de
-- PayPal sin reescribir nada:
--
--   plans.provider_plan_id_month / _year
--     Identificadores de los planes de facturación creados en PayPal
--     (un producto, seis planes: tres niveles × dos ciclos). Los rellena
--     `scripts/paypal-bootstrap-catalog.ts`; NULL significa "todavía no
--     contratable por este ciclo" y el checkout responde 400.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS.
-- ============================================================

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS provider_plan_id_month text,
  ADD COLUMN IF NOT EXISTS provider_plan_id_year  text;

-- RLS: sin cambios. `plans` sigue siendo solo lectura desde el cliente.
