-- ============================================================
-- 041_billing_model.sql — Fase 0 (SaaS): modelo de facturación
--
-- Crea el modelo de datos de la capa comercial SIN aplicar límites ni
-- cambiar ningún comportamiento visible. Cablear las cuotas y la
-- pasarela de pago es la fase 3; aquí solo existe el esquema, la RPC
-- de incremento atómico y la semilla del catálogo de planes.
--
-- Cuatro tablas:
--
--   plans            Catálogo. Se siembra desde esta migración; el
--                    inquilino no lo edita.
--   subscriptions    Una por cuenta. La pasarela queda detrás de la
--                    columna `provider` para que añadir tarjetas más
--                    adelante sea aditivo y no una reescritura.
--   usage_counters   Contadores de consumo por métrica y periodo
--                    (mes natural). Se escriben SOLO vía la RPC
--                    `increment_usage`.
--   billing_events   Bitácora de eventos de la pasarela.
--                    UNIQUE(provider, provider_event_id) es la
--                    idempotencia: PayPal reenvía eventos y no podemos
--                    procesarlos dos veces.
--
-- RLS
--   plans           SELECT para cualquier usuario autenticado (catálogo
--                   público). Sin escritura desde el cliente.
--   subscriptions   SELECT para miembros de la cuenta. SIN escritura
--                   desde el cliente bajo ninguna circunstancia — solo
--                   el rol de servicio, desde el webhook de la pasarela.
--                   Un inquilino que pueda escribir su propia
--                   suscripción se regala el plan Negocio.
--   usage_counters  SELECT para admin+. Escritura solo por RPC.
--   billing_events  RLS activada sin políticas: nadie desde el cliente.
--
-- Supuesto S1 (confirmado): la IA la paga el servicio. La clave del
-- proveedor pasa a poder venir de la plataforma (variable de entorno),
-- así que `ai_configs.api_key` deja de ser NOT NULL.
--
-- Idempotente — safe to re-run: CREATE TABLE IF NOT EXISTS, políticas
-- drop-then-create, CREATE OR REPLACE FUNCTION, semilla con
-- ON CONFLICT DO UPDATE, DROP NOT NULL es no-op si ya es nullable.
-- ============================================================

-- ============================================================
-- 1. Tablas
-- ============================================================

-- Catálogo. Se siembra desde la migración; el inquilino no lo edita.
CREATE TABLE IF NOT EXISTS plans (
  id                text PRIMARY KEY,          -- 'inicio' | 'pro' | 'negocio'
  name              text NOT NULL,
  price_usd_month   numeric(10,2) NOT NULL,
  price_usd_year    numeric(10,2),
  limits            jsonb NOT NULL DEFAULT '{}'::jsonb,
  features          text[] NOT NULL DEFAULT '{}',
  is_public         boolean NOT NULL DEFAULT true,
  sort_order        integer NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS subscriptions (
  account_id               uuid PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  plan_id                  text NOT NULL REFERENCES plans(id),
  provider                 text NOT NULL DEFAULT 'paypal',
  provider_subscription_id text UNIQUE,
  status                   text NOT NULL DEFAULT 'trialing'
                             CHECK (status IN ('trialing','active','past_due',
                                               'suspended','cancelled','expired')),
  trial_ends_at            timestamptz,
  current_period_end       timestamptz,
  grace_until              timestamptz,
  cancel_at_period_end     boolean NOT NULL DEFAULT false,
  addons                   jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- Mismo trigger de updated_at que usan el resto de tablas (001/006/017).
DROP TRIGGER IF EXISTS set_updated_at ON subscriptions;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON subscriptions
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- Contadores de consumo del ciclo. Una fila por métrica y periodo.
CREATE TABLE IF NOT EXISTS usage_counters (
  account_id   uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  metric       text NOT NULL,      -- 'messages_out'|'ai_replies'|'broadcast_recipients'
  period_start date NOT NULL,
  value        bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (account_id, metric, period_start)
);

-- Bitácora de eventos de la pasarela. `provider_event_id` único es la
-- idempotencia: PayPal reenvía eventos y no podemos procesarlos dos veces.
CREATE TABLE IF NOT EXISTS billing_events (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider          text NOT NULL,
  provider_event_id text NOT NULL,
  event_type        text NOT NULL,
  payload           jsonb NOT NULL,
  received_at       timestamptz NOT NULL DEFAULT now(),
  processed_at      timestamptz,
  error             text,
  UNIQUE (provider, provider_event_id)
);

-- ============================================================
-- 2. RLS
-- ============================================================

ALTER TABLE plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE usage_counters ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_events ENABLE ROW LEVEL SECURITY;

-- plans: catálogo legible por cualquier autenticado. Sin políticas de
-- escritura → ningún cliente puede INSERT/UPDATE/DELETE.
DROP POLICY IF EXISTS plans_select ON plans;
CREATE POLICY plans_select ON plans FOR SELECT
  TO authenticated
  USING (true);

-- subscriptions: lectura para miembros. Sin políticas de escritura a
-- propósito — solo el rol de servicio (que salta la RLS) escribe aquí.
DROP POLICY IF EXISTS subscriptions_select ON subscriptions;
CREATE POLICY subscriptions_select ON subscriptions FOR SELECT
  USING (is_account_member(account_id));

-- usage_counters: lectura solo para admin+ (el consumo es dato de
-- facturación, no algo que un agente o viewer necesite). Escritura solo
-- por la RPC increment_usage bajo el rol de servicio.
DROP POLICY IF EXISTS usage_counters_select ON usage_counters;
CREATE POLICY usage_counters_select ON usage_counters FOR SELECT
  USING (is_account_member(account_id, 'admin'));

-- billing_events: RLS activada y sin políticas → nadie desde el cliente.

-- ============================================================
-- 3. Incremento atómico
--
-- Mismo patrón que `claim_ai_reply_slot` (029/031): la comprobación y el
-- incremento ocurren en una sola sentencia para que dos peticiones
-- simultáneas no puedan pasarse del límite. El periodo se ancla al mes
-- natural y no al ciclo de facturación del cliente, a propósito: es más
-- simple de razonar y de auditar. Si más adelante hay que alinearlo al
-- ciclo, se cambia aquí y en un solo sitio.
-- ============================================================
CREATE OR REPLACE FUNCTION public.increment_usage(
  p_account_id uuid,
  p_metric     text,
  p_delta      bigint DEFAULT 1
) RETURNS bigint
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO usage_counters (account_id, metric, period_start, value)
  VALUES (p_account_id, p_metric, date_trunc('month', now())::date, p_delta)
  ON CONFLICT (account_id, metric, period_start)
  DO UPDATE SET value = usage_counters.value + EXCLUDED.value
  RETURNING value;
$$;

-- SECURITY DEFINER fija con qué privilegios corre, no quién puede
-- llamarla. Solo el rol de servicio incrementa contadores; nunca se
-- expone una función que muta contadores a usuarios finales (mismo
-- criterio que 007 / 012 / 031).
REVOKE ALL ON FUNCTION public.increment_usage(uuid, text, bigint) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.increment_usage(uuid, text, bigint) FROM anon;
REVOKE ALL ON FUNCTION public.increment_usage(uuid, text, bigint) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.increment_usage(uuid, text, bigint) TO service_role;

-- ============================================================
-- 4. Semilla de planes
--
-- ATENCIÓN: estos números son REVISABLES hasta que haya un cliente
-- pagando; después, cambiarlos a la baja rompe contratos. Se revisan con
-- el consumo real medido durante la beta cerrada (ver docs/saas/README.md).
--
-- En `limits`, `null` significa sin límite. Claves de `limits`:
--   operators, contacts, messages_out, ai_replies, broadcast_recipients,
--   knowledge_documents, numbers, retention_months.
-- Claves de `features`:
--   ai_autoreply, ai_knowledge, auto_assign, api, webhooks, multi_number,
--   priority_support.
--
-- ON CONFLICT DO UPDATE para que la migración sea re-ejecutable y para
-- que una revisión de precios/límites viaje como una migración nueva que
-- vuelve a sembrar.
-- ============================================================
INSERT INTO plans (id, name, price_usd_month, price_usd_year, limits, features, is_public, sort_order)
VALUES
  (
    'inicio', 'Inicio', 29, 290,
    '{"operators": 3, "contacts": 2000, "messages_out": 3000, "ai_replies": 500,
      "broadcast_recipients": 2000, "knowledge_documents": 10, "numbers": 1,
      "retention_months": 12}'::jsonb,
    ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign'],
    true, 1
  ),
  (
    'pro', 'Pro', 79, 790,
    '{"operators": 10, "contacts": 10000, "messages_out": 15000, "ai_replies": 3000,
      "broadcast_recipients": 10000, "knowledge_documents": 50, "numbers": 1,
      "retention_months": 24}'::jsonb,
    ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api', 'webhooks'],
    true, 2
  ),
  (
    'negocio', 'Negocio', 199, 1990,
    '{"operators": 30, "contacts": 50000, "messages_out": 60000, "ai_replies": 15000,
      "broadcast_recipients": 50000, "knowledge_documents": 200, "numbers": 3,
      "retention_months": null}'::jsonb,
    ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api', 'webhooks',
          'multi_number', 'priority_support'],
    true, 3
  )
ON CONFLICT (id) DO UPDATE SET
  name            = EXCLUDED.name,
  price_usd_month = EXCLUDED.price_usd_month,
  price_usd_year  = EXCLUDED.price_usd_year,
  limits          = EXCLUDED.limits,
  features        = EXCLUDED.features,
  is_public       = EXCLUDED.is_public,
  sort_order      = EXCLUDED.sort_order;

-- ============================================================
-- 5. Supuesto S1 — la IA la paga el servicio
--
-- La clave del proveedor puede venir ahora de la plataforma
-- (AI_PLATFORM_OPENAI_API_KEY / AI_PLATFORM_ANTHROPIC_API_KEY en el
-- servidor). Una cuenta que no trae clave propia guarda NULL aquí y el
-- código resuelve: clave propia → clave de plataforma → IA no
-- configurada. DROP NOT NULL es no-op si la columna ya es nullable.
-- ============================================================
ALTER TABLE ai_configs
  ALTER COLUMN api_key DROP NOT NULL;
