-- ============================================================
-- 077_plan_gestionado.sql — Fase 10 (s10.3 `managed-plan`)
--
-- Un cliente que no le paga a Meta: le paga a Cabbity un paquete fijo
-- de mensajes más el excedente, y Cabbity paga a Meta. Esta migración
-- deja el catálogo y la suscripción listos para eso:
--
--   1. `plans.meta_pricing jsonb NOT NULL DEFAULT '{}'`: la política de
--      precio de Meta POR DEFECTO de un plan. Se copia a
--      `subscriptions.meta_pricing` (076) al asignar el plan, y allí el
--      superadmin la edita por cuenta. `{}` = el plan no trae política
--      (lo normal: Meta le cobra al cliente directamente).
--
--      La spec la ponía dentro de `plans.limits.meta_pricing`. No va ahí
--      porque `limits` tiene un contrato estricto de ocho claves numéricas
--      (`src/lib/billing/plan-catalog.ts`): el editor de planes de s9.3
--      reescribe `limits` entero con esas ocho claves, así que la primera
--      edición del plan BORRARÍA la política sin avisar, y
--      `validateLimits` rechaza cualquier otra clave. `normalizeLimits`
--      la descartaría al leer (no es número ni null), así que no rompía
--      los topes, pero tampoco sobrevivía. Una columna propia no la toca
--      nadie más. Su forma la valida `src/lib/billing/meta-pricing.ts`
--      (`parseMetaPricing`), igual que la de `subscriptions.meta_pricing`.
--
--   2. El plan `gestionado`: oculto (`is_public = false`: no sale en
--      `/api/billing/plans`, ni en el `PlanPicker` de /billing y del
--      onboarding, y el checkout lo rechaza), 1.036 USD al mes y sin
--      precio anual (solo ciclo mensual: la fecha de corte mensual es la
--      que hace legible el consumo). `limits` = los de `negocio` con
--      `messages_out` y `broadcast_recipients` a null (sin tope de
--      envíos: el precio es el tope), `numbers` 3; todas las features del
--      inventario de `plan-catalog.ts`. Política por defecto: 7.000
--      mensajes incluidos, cuota 1.036 USD, excedente a 2,5 × la tarifa
--      de Meta de cada categoría.
--
--   3. `subscriptions.payment_method text` (`paypal` | `manual`),
--      nullable: NULL = lo que diga `provider`, para no tocar filas
--      viejas. Con `manual` el estado de cuenta del corte (s10.4) lleva
--      cuota + excedente; con `paypal` la cuota la cobra la suscripción de
--      PayPal y el estado de cuenta solo el excedente.
--
-- RLS: nada nuevo. `plans` sigue legible por autenticados y sin
-- políticas de escritura (041); `subscriptions` legible por miembros y
-- sin políticas de escritura: el inquilino no puede cambiar su
-- `payment_method` (ni su `meta_billing`/`meta_pricing`, 076). Solo el
-- rol de servicio, detrás de `requirePlatformAdmin()`.
--
-- Idempotente — safe to re-run: ADD COLUMN IF NOT EXISTS, CHECKs
-- drop-then-add, el plan con ON CONFLICT DO NOTHING (una edición del
-- operador desde /platform/plans sobrevive a una segunda pasada) y la
-- política solo se siembra si el plan no tiene ninguna.
-- ============================================================

-- 1. plans.meta_pricing --------------------------------------------

ALTER TABLE plans
  ADD COLUMN IF NOT EXISTS meta_pricing jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE plans
  DROP CONSTRAINT IF EXISTS plans_meta_pricing_object_check;
ALTER TABLE plans
  ADD CONSTRAINT plans_meta_pricing_object_check
  CHECK (jsonb_typeof(meta_pricing) = 'object');

COMMENT ON COLUMN plans.meta_pricing IS
  'Política de precio de Meta por defecto del plan (fase 10, 077). Se copia a subscriptions.meta_pricing al asignar el plan. {} = sin política (Meta cobra al cliente). Forma validada por src/lib/billing/meta-pricing.ts.';

-- 2. El plan `gestionado` ------------------------------------------

INSERT INTO plans (
  id, name, description, price_usd_month, price_usd_year,
  limits, features, is_public, sort_order
) VALUES (
  'gestionado', 'Gestionado',
  'Cabbity paga a Meta y factura al corte del mes: cuota fija con 7.000 mensajes entregados incluidos y excedente por categoría. Solo se asigna a mano desde el panel de plataforma.',
  1036, NULL,
  '{"operators": 30, "contacts": 50000, "messages_out": null, "ai_replies": 15000, "broadcast_recipients": null, "knowledge_documents": 200, "numbers": 3, "retention_months": null}'::jsonb,
  ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api', 'webhooks',
        'multi_number', 'priority_support']::text[],
  false, 90
)
ON CONFLICT (id) DO NOTHING;

UPDATE plans
SET meta_pricing = '{
  "included_messages": 7000,
  "fee_usd": 1036,
  "overage": {
    "service": {"multiplier": 2.5},
    "utility": {"multiplier": 2.5},
    "marketing": {"multiplier": 2.5},
    "authentication": {"multiplier": 2.5},
    "authentication_international": {"multiplier": 2.5}
  }
}'::jsonb
WHERE id = 'gestionado'
  AND meta_pricing = '{}'::jsonb;

-- 3. subscriptions.payment_method ----------------------------------

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS payment_method text;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_payment_method_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_payment_method_check
  CHECK (payment_method IS NULL OR payment_method IN ('paypal', 'manual'));

COMMENT ON COLUMN subscriptions.payment_method IS
  'Cómo paga la cuenta la facturación gestionada (fase 10, 077): paypal (la cuota por la suscripción de PayPal) o manual (estado de cuenta confirmado a mano). NULL = lo que diga provider.';
