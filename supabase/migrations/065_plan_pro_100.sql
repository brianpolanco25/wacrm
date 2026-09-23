-- ============================================================
-- 065_plan_pro_100.sql — precio del plan Pro y acceso a la API
--
-- Revisión de catálogo pedida por el humano el 2026-09-23:
--
--   * Pro pasa de 79/790 a 100 USD/mes. El anual mantiene el descuento
--     relativo del catálogo (anual = mensual × 10 → 1000), igual que hizo
--     la 059 con Inicio.
--   * La API pública (`/api/v1`, feature `api`) es de Pro y Negocio; Inicio
--     no la incluye. La semilla de la 041 ya lo dejó así, pero aquí se fija
--     de forma explícita e idempotente para que una base cuyo catálogo se
--     haya tocado a mano quede con la regla correcta. `webhooks` sigue a
--     `api` por la misma razón: sin API no hay a quién avisar.
--
-- Mismo criterio que la 059: UPDATE de columnas concretas, no re-sembrar
-- el INSERT … ON CONFLICT de la 041 (que reescribiría limits, is_public y
-- sort_order). `provider_plan_id_month` / `_year` NO se tocan: los planes
-- de PayPal son inmutables una vez tienen suscriptores. Si Pro ya tenía
-- planes creados en PayPal a 79, la app enseñará 100 pero PayPal cobrará
-- 79 hasta que se creen planes nuevos (ver docs/docker.md, «PayPal
-- catalogue»).
--
-- Idempotente: valores absolutos; array_remove/array_append con guarda.
-- Si el catálogo no existe, afecta a 0 filas y no falla.
-- ============================================================

UPDATE plans
SET price_usd_month = 100,
    price_usd_year  = 1000
WHERE id = 'pro';

UPDATE plans
SET features = array_remove(array_remove(features, 'api'), 'webhooks')
WHERE id = 'inicio';

UPDATE plans
SET features = array_append(features, 'api')
WHERE id IN ('pro', 'negocio') AND NOT ('api' = ANY (features));

UPDATE plans
SET features = array_append(features, 'webhooks')
WHERE id IN ('pro', 'negocio') AND NOT ('webhooks' = ANY (features));
