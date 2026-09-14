-- Comprobación local de p6.3 (`plan-prices-35`) después de:
--   KEEP=1 scripts/replay-migrations.sh /ruta/al/worktree
-- Ejecutar con el nombre que imprime el script:
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_plan-prices-35.sql
--
-- La 059 es un UPDATE de dos columnas sobre una fila. Lo que hay que ver en
-- una base real no es el UPDATE, es lo que queda DESPUÉS de replicar las 59
-- migraciones en orden: el catálogo con Inicio a 35/350 y los otros dos
-- niveles intactos, los `provider_plan_id_*` todavía en NULL (el precio de
-- PayPal no se toca desde aquí) y la migración repetible sin cambiar nada.

BEGIN;

-- 1. Catálogo vigente: los tres niveles, con sus precios y su orden.
DO $$
DECLARE
  n integer;
BEGIN
  SELECT count(*) INTO n FROM plans;
  IF n <> 3 THEN
    RAISE EXCEPTION 'expected 3 plans, found %', n;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = 'inicio' AND price_usd_month = 35 AND price_usd_year = 350
  ) THEN
    RAISE EXCEPTION 'inicio is not 35/350: %/%',
      (SELECT price_usd_month FROM plans WHERE id = 'inicio'),
      (SELECT price_usd_year  FROM plans WHERE id = 'inicio');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = 'pro' AND price_usd_month = 79 AND price_usd_year = 790
  ) THEN
    RAISE EXCEPTION 'pro moved off 79/790: %/%',
      (SELECT price_usd_month FROM plans WHERE id = 'pro'),
      (SELECT price_usd_year  FROM plans WHERE id = 'pro');
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = 'negocio' AND price_usd_month = 199 AND price_usd_year = 1990
  ) THEN
    RAISE EXCEPTION 'negocio moved off 199/1990: %/%',
      (SELECT price_usd_month FROM plans WHERE id = 'negocio'),
      (SELECT price_usd_year  FROM plans WHERE id = 'negocio');
  END IF;
END $$;

-- 2. El resto de la fila de Inicio no se movió: la 059 solo toca precio.
--    Si alguien la reescribe como un nuevo INSERT … ON CONFLICT y se deja
--    una clave de `limits` por el camino, esto lo caza.
DO $$
DECLARE
  p plans%ROWTYPE;
BEGIN
  SELECT * INTO p FROM plans WHERE id = 'inicio';

  IF p.name <> 'Inicio' OR p.is_public IS NOT TRUE OR p.sort_order <> 1 THEN
    RAISE EXCEPTION 'inicio metadata changed: name=%, is_public=%, sort_order=%',
      p.name, p.is_public, p.sort_order;
  END IF;

  IF (p.limits->>'operators')::int <> 3
     OR (p.limits->>'contacts')::int <> 2000
     OR (p.limits->>'messages_out')::int <> 3000
     OR (p.limits->>'ai_replies')::int <> 500
     OR (p.limits->>'broadcast_recipients')::int <> 2000
     OR (p.limits->>'knowledge_documents')::int <> 10
     OR (p.limits->>'numbers')::int <> 1
     OR (p.limits->>'retention_months')::int <> 12 THEN
    RAISE EXCEPTION 'inicio limits changed: %', p.limits;
  END IF;

  IF p.features
     <> ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign']::text[] THEN
    RAISE EXCEPTION 'inicio features changed: %', p.features;
  END IF;

  -- Los ids de PayPal siguen sin existir en una base recién migrada: subir
  -- el precio NO edita un plan de PayPal (son inmutables con suscriptores),
  -- y el bootstrap de f3.1 los creará con el precio nuevo.
  IF p.provider_plan_id_month IS NOT NULL
     OR p.provider_plan_id_year IS NOT NULL THEN
    RAISE EXCEPTION 'a freshly migrated database already has PayPal ids for inicio';
  END IF;
END $$;

-- 3. Idempotencia: la migración otra vez, y una tercera con el precio
--    manipulado a mano, para ver que converge al valor que fija la 059.
UPDATE plans SET price_usd_month = 35, price_usd_year = 350 WHERE id = 'inicio';
UPDATE plans SET price_usd_month = 29, price_usd_year = 290 WHERE id = 'inicio';
UPDATE plans SET price_usd_month = 35, price_usd_year = 350 WHERE id = 'inicio';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM plans
    WHERE id = 'inicio' AND price_usd_month = 35 AND price_usd_year = 350
  ) THEN
    RAISE EXCEPTION 'the 059 UPDATE is not idempotent';
  END IF;
END $$;

-- 4. El camino de lectura de la app: el mismo SELECT que hace
--    `/api/billing/plans` (columnas de src/app/api/billing/plans/route.ts)
--    ya devuelve 35 sin cambiar una línea de TypeScript.
DO $$
DECLARE
  precio numeric;
BEGIN
  SELECT price_usd_month INTO precio
  FROM plans
  WHERE is_public = true
  ORDER BY sort_order
  LIMIT 1;

  IF precio <> 35 THEN
    RAISE EXCEPTION 'the first public plan is priced %, expected 35', precio;
  END IF;
END $$;

-- 5. La prueba gratuita sigue apuntando a un plan que existe (046 usa 'pro';
--    la 059 no lo toca, pero el catálogo es la misma tabla).
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM plans WHERE id = 'pro') THEN
    RAISE EXCEPTION 'the trial plan ''pro'' vanished from the catalogue';
  END IF;
END $$;

ROLLBACK;
