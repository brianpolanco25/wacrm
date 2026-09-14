-- ============================================================
-- 059_plan_inicio_35.sql — Fase 6 (producto): precio del plan Inicio
-- (progress/spec_producto.md §3, supuesto S-P2)
--
-- La 041 sembró el catálogo con Inicio a 29/290 y dejó escrito que esos
-- números son revisables «hasta que haya un cliente pagando» y que una
-- revisión de precios viaja como una migración nueva. Esta es esa
-- migración: Inicio pasa a 35 USD/mes y el anual mantiene el descuento
-- relativo del catálogo (anual = mensual × 10 → 350). `pro` (79/790) y
-- `negocio` (199/1990) no cambian.
--
-- Por qué un UPDATE y no volver a sembrar el INSERT … ON CONFLICT de la
-- 041: ese bloque reescribe también `limits`, `features`, `is_public` y
-- `sort_order`, y aquí no cambia ninguno. Un UPDATE de las dos columnas
-- de precio deja fuera de riesgo todo lo demás —en particular
-- `provider_plan_id_month` / `_year` (045), que NO se tocan: los planes
-- de PayPal son inmutables una vez tienen suscriptores y el precio de
-- allí no se edita desde aquí (ver docs/docker.md, «PayPal catalogue»).
--
-- Efecto en lo que ya está contratado: ninguno de forma automática. Las
-- suscripciones vivas cobran lo que dice su plan de PayPal; esta fila
-- solo alimenta lo que la app enseña (`/billing`, Ajustes →
-- Suscripción, ambos leen de `plans`) y el precio con el que se crearán
-- los planes de PayPal la próxima vez que se ejecute el bootstrap de
-- f3.1 contra una base sin ids guardados.
--
-- Idempotente: un UPDATE de valores absolutos, sin incrementos. Correrlo
-- dos veces deja la misma fila. Si el catálogo aún no existe (base a
-- medio migrar) el UPDATE afecta a 0 filas y no falla.
-- ============================================================

UPDATE plans
SET price_usd_month = 35,
    price_usd_year  = 350
WHERE id = 'inicio';
