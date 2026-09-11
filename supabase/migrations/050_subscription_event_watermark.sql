-- ============================================================
-- 050_subscription_event_watermark.sql — Fase 3 (SaaS): webhook
--
-- Lo que necesita el manejador de eventos de PayPal (§3 de
-- docs/saas/fase-3-facturacion.md) para que el desorden de entrega no
-- deje una suscripción en un estado imposible.
--
--   subscriptions.last_event_at
--     Marca de agua: `create_time` del último evento de la pasarela
--     que cambió el estado de esta suscripción. Un evento con
--     `create_time` anterior llegó tarde (PayPal no promete orden y
--     reintenta con su propio calendario) y solo puede empujar
--     `current_period_end` hacia adelante: nunca cambia estado, plan,
--     gracia ni la marca de cancelación.
--
--     Sin esta columna, un `ACTIVATED` reentregado después del
--     `CANCELLED` que lo siguió reactivaría una suscripción cancelada,
--     y un `PAYMENT.FAILED` viejo devolvería a `past_due` una cuenta
--     que ya pagó. El spec lo pide así: «cada manejador comprueba
--     coherencia antes de escribir en vez de asumir secuencia».
--
--     Nace NULL para las filas existentes, que es exactamente lo que
--     significa: todavía no se ha aplicado ningún evento, así que el
--     primero que llegue no es viejo.
--
--   billing_events_unprocessed_idx
--     Índice parcial de la cola de reconciliación. Un evento que se
--     verificó y se guardó pero que no se pudo aplicar (por ejemplo:
--     llega con un id de suscripción que no está en `checkout_intents`
--     ni en `subscriptions`) queda con `processed_at IS NULL` y
--     `error` puesto. La consulta del runbook —«qué eventos de
--     facturación quedaron sin aplicar»— es esta y solo esta; el
--     índice parcial la deja barata sin cargar con la bitácora entera,
--     que crece con cada renovación de cada cliente.
--
-- No se crea ninguna tabla ni se toca ninguna política: el webhook
-- escribe con el rol de servicio, y `subscriptions` / `billing_events`
-- ya tienen desde 041 la RLS que impide que un inquilino escriba su
-- propia suscripción.
--
-- Idempotente — safe to re-run: ADD COLUMN IF NOT EXISTS y
-- CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS last_event_at timestamptz;

COMMENT ON COLUMN subscriptions.last_event_at IS
  'create_time del último evento de la pasarela que cambió esta fila. '
  'Un evento anterior a esta marca llegó desordenado y solo puede '
  'empujar current_period_end hacia adelante (migración 050).';

CREATE INDEX IF NOT EXISTS billing_events_unprocessed_idx
  ON billing_events (received_at DESC)
  WHERE processed_at IS NULL;
