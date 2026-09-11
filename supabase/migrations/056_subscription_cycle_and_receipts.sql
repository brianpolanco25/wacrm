-- ============================================================
-- 056_subscription_cycle_and_receipts.sql — Fase 3 (SaaS): área de
-- suscripción (§6 de docs/saas/fase-3-facturacion.md)
--
-- Dos objetos, los dos exigidos por §6, ninguno de ellos una tabla
-- nueva ni un cambio de política.
--
--   subscriptions.cycle
--     El ciclo de facturación con el que se está cobrando esta
--     suscripción. Hasta ahora vivía SOLO en `checkout_intents.cycle`,
--     que es el ciclo con el que se CONTRATÓ; la deuda 3 de
--     `progress/impl_paypal-webhook.md` ya lo dejó anotado para esta
--     feature. §6 la vuelve obligatoria: cambiar de plan usa el
--     `revise` de PayPal sobre la MISMA suscripción, así que un cliente
--     que pasa de mensual a anual sigue teniendo un intento que dice
--     `month`. La renovación (`PAYMENT.SALE.COMPLETED`, que no trae
--     `plan_id`) extendería el periodo un mes después de cobrarle un
--     año, y a las cuatro semanas la cuenta se quedaría en solo
--     lectura habiendo pagado.
--
--     Nullable a propósito: NULL significa «no lo sabemos todavía» y el
--     manejador de renovación cae entonces al ciclo del intento, que es
--     el comportamiento anterior a esta migración. No hay valor por
--     defecto que sea verdad para todas las filas.
--
--   billing_events_sale_subscription_idx
--     Los recibos de §6 son los `PAYMENT.SALE.COMPLETED` de la
--     bitácora, y la única forma de atarlos a un inquilino es el
--     `billing_agreement_id` que el recurso de la venta lleva dentro
--     del payload (la tabla no tiene `account_id`: es el registro
--     global de la pasarela). Sin índice, pintar el área de suscripción
--     de un cliente sería un recorrido secuencial de los eventos de
--     TODOS los clientes, y esa tabla crece con cada renovación de cada
--     cuenta. Índice de expresión y parcial, para que solo pese lo que
--     de verdad se consulta.
--
-- El backfill del ciclo sale de `checkout_intents`: para cada
-- suscripción con id de proveedor, el ciclo del intento que la creó.
-- Es exactamente lo que el código venía usando, así que aplicar esta
-- migración no cambia el cobro de nadie; solo lo materializa donde el
-- cambio de plan pueda moverlo.
--
-- Idempotente — safe to re-run: ADD COLUMN IF NOT EXISTS, restricción
-- en drop-then-add y CREATE INDEX IF NOT EXISTS. El backfill solo
-- escribe donde `cycle IS NULL`, así que repetirlo no pisa un ciclo que
-- el webhook ya haya corregido.
-- ============================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS cycle text;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_cycle_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_cycle_check
  CHECK (cycle IS NULL OR cycle IN ('month', 'year'));

COMMENT ON COLUMN subscriptions.cycle IS
  'Ciclo con el que se cobra HOY esta suscripción (month|year). NULL = '
  'desconocido: la renovación cae al ciclo de checkout_intents. Lo '
  'mueve el webhook cuando PayPal confirma un cambio de plan '
  '(migración 056).';

-- Backfill: el ciclo del intento que creó cada suscripción viva.
UPDATE subscriptions s
SET cycle = ci.cycle
FROM checkout_intents ci
WHERE s.cycle IS NULL
  AND s.provider_subscription_id IS NOT NULL
  AND ci.provider = s.provider
  AND ci.provider_subscription_id = s.provider_subscription_id
  AND ci.cycle IN ('month', 'year');

CREATE INDEX IF NOT EXISTS billing_events_sale_subscription_idx
  ON billing_events ((payload -> 'resource' ->> 'billing_agreement_id'))
  WHERE event_type = 'PAYMENT.SALE.COMPLETED';
