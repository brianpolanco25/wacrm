-- Comprobación local de f3.1 después de:
--   KEEP=1 scripts/replay-migrations.sh /ruta/al/worktree
-- Ejecutar con el nombre que imprime el script:
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_paypal-client-catalog.sql
--
-- El bootstrap nunca se apunta al Postgres local: crea recursos de PayPal y
-- exige credenciales. El flujo unitario (paypal-bootstrap-catalog.test.ts)
-- prueba los seis IDs persistidos y la segunda ejecución inerte; este SQL
-- comprueba, en una base limpia, que el esquema sobre el que ese flujo escribe
-- es el esperado y que sus dos pasadas se comportan igual contra Postgres.

BEGIN;

-- 1. Esquema: las dos columnas nuevas, de texto y anulables (una base recién
--    migrada —la de live antes de promocionar— tiene que empezar sin IDs).
DO $$
DECLARE
  plan_count integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'provider_plan_id_month'
      AND data_type = 'text' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plans.provider_plan_id_month text NULL is missing';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'provider_plan_id_year'
      AND data_type = 'text' AND is_nullable = 'YES'
  ) THEN
    RAISE EXCEPTION 'plans.provider_plan_id_year text NULL is missing';
  END IF;

  -- 2. Las tres filas con precio: son las que el bootstrap convierte en seis
  --    planes de PayPal (tres niveles x mensual/anual).
  SELECT count(*) INTO plan_count
  FROM public.plans
  WHERE id IN ('inicio', 'pro', 'negocio')
    AND price_usd_month IS NOT NULL
    AND price_usd_year IS NOT NULL;

  IF plan_count <> 3 THEN
    RAISE EXCEPTION
      'expected the three priced catalogue rows, found %', plan_count;
  END IF;
END
$$;

-- 3. Una base limpia no puede traer IDs de PayPal. Es la comprobación del
--    procedimiento sandbox/live: los IDs solo los escribe una ejecución
--    contra su propia base (docs/docker.md, «Going from sandbox to live»).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM public.plans
    WHERE provider_plan_id_month IS NOT NULL
       OR provider_plan_id_year IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'clean local catalogue unexpectedly has provider IDs';
  END IF;
END
$$;

-- 4. Las dos pasadas del bootstrap contra Postgres: la primera escribe seis
--    IDs (uno por fila y ciclo); la segunda, que solo toca lo que sigue en
--    NULL, no actualiza ninguna fila.
DO $$
DECLARE
  written integer;
  rewritten integer;
  stored integer;
BEGIN
  WITH first_pass AS (
    UPDATE public.plans SET
      provider_plan_id_month = 'P-CHECK-' || id || '-month',
      provider_plan_id_year  = 'P-CHECK-' || id || '-year'
    WHERE id IN ('inicio', 'pro', 'negocio')
      AND provider_plan_id_month IS NULL
      AND provider_plan_id_year IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO written FROM first_pass;

  IF written <> 3 THEN
    RAISE EXCEPTION 'first pass touched % rows, expected 3', written;
  END IF;

  SELECT count(*) INTO stored
  FROM public.plans, LATERAL (VALUES
    (provider_plan_id_month), (provider_plan_id_year)
  ) AS ids(value)
  WHERE ids.value LIKE 'P-CHECK-%';

  IF stored <> 6 THEN
    RAISE EXCEPTION 'expected six stored provider IDs, found %', stored;
  END IF;

  WITH second_pass AS (
    UPDATE public.plans SET
      provider_plan_id_month = 'P-SECOND-' || id || '-month'
    WHERE id IN ('inicio', 'pro', 'negocio')
      AND provider_plan_id_month IS NULL
    RETURNING 1
  )
  SELECT count(*) INTO rewritten FROM second_pass;

  IF rewritten <> 0 THEN
    RAISE EXCEPTION 'second pass updated % rows, expected 0', rewritten;
  END IF;
END
$$;

-- 5. `plans` es el catálogo global: no tiene `account_id`, así que no hay
--    consulta de rol de servicio que filtrar por cuenta (CP3 no aplica).
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public' AND table_name = 'plans'
      AND column_name = 'account_id'
  ) THEN
    RAISE EXCEPTION 'plans unexpectedly has account_id';
  END IF;
END
$$;

ROLLBACK;
