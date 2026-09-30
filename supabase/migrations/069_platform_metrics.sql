-- ============================================================
-- 069_platform_metrics.sql — Fase 9 (superadmin): el Resumen del panel
-- (progress/spec_superadmin.md §s9.2)
--
-- Una sola función, `platform_metrics()`, que devuelve en un jsonb todo
-- lo que pintan las tarjetas de `/platform`: cuentas por estado, altas,
-- MRR/ARR, comped, morosos, números de WhatsApp y mensajes del mes.
--
-- 1. POR QUÉ UNA FUNCIÓN Y NO CONSULTAS DESDE TYPESCRIPT
--
--    Son una docena de agregados sobre tablas de TODOS los clientes.
--    Desde la ruta serían una docena de viajes a la base, y varios
--    (la serie semanal, el MRR con su JOIN al catálogo) no se expresan
--    con el constructor de consultas de supabase-js sin traerse las
--    filas enteras. Un único viaje, un único jsonb.
--
-- 2. LA GUARDA ES LA MISMA QUE LA DE `platform_account_list` (058)
--
--    Sin SECURITY DEFINER: corre con los privilegios de quien la llama.
--    Concedida solo a `service_role`; si alguien le diera EXECUTE a
--    `authenticated` por error, la RLS de `accounts`/`subscriptions`
--    seguiría recortando a la cuenta propia en vez de regalar las cifras
--    del negocio. La única llamada es `GET /api/platform/metrics`, detrás
--    de `requirePlatformAdmin()`.
--
-- 3. EL CICLO SE LEE DE `subscriptions.cycle`, QUE YA EXISTE
--
--    El spec pide «añadir `billing_cycle` si no está». Está: la 056 creó
--    `subscriptions.cycle` (CHECK month|year, nullable) y el webhook de
--    PayPal ya la escribe al activar, al cambiar de plan y al renovar
--    (`src/lib/billing/webhook-events.ts`). Una segunda columna con el
--    mismo significado serían dos verdades que acabarían discrepando,
--    así que esta migración NO añade ninguna columna. Filas con
--    `cycle` NULL cuentan como mensuales, como pide el spec.
--
-- 4. QUÉ CUENTA CADA CIFRA
--
--    - accounts.by_status: una clave por `subscriptions.status`
--      presente, más `none` para las cuentas sin fila. Agregado dinámico:
--      un estado nuevo (la 071 trae `incomplete`) aparece solo.
--    - revenue.mrr_usd: Σ sobre `active`/`past_due` con
--      `provider <> 'manual'` de `price_usd_month` (ciclo mensual o
--      desconocido) o `price_usd_year / 12` (anual; si el plan no tiene
--      precio anual, cae al mensual). Precio del catálogo VIGENTE: la
--      base no guarda el precio con el que se contrató cada
--      suscripción, así que un suscriptor que conserva un precio
--      anterior (065) cuenta al precio de hoy.
--    - comped: `provider = 'manual'` y estado vivo (ni `cancelled` ni
--      `expired`). Fuera del MRR, siempre.
--    - delinquent: `past_due` y `suspended`, por separado y en total.
--    - whatsapp.connected: filas de `whatsapp_config` en `connected`
--      (una por número desde la 053).
--    - messages_month: mes natural en curso, con el MISMO anclaje que
--      `increment_usage` (041). Entrantes = mensajes con
--      `sender_type = 'customer'`. Salientes = `messages_out` +
--      `broadcast_recipients` de `usage_counters`: es el contador que ya
--      se lleva por cuenta y mes, y evita recorrer `messages` dos veces.
--      Las respuestas de IA se cobran como `messages_out` al enviarse, así
--      que ya están dentro.
--
--    `messages` no tiene índice por `created_at`; el recuento de
--    entrantes es un recorrido de la tabla. Es una consulta de operador,
--    a demanda, y crear ese índice aquí bloquearía las escrituras de
--    `messages` (lo que guarda el webhook entrante, CP11) mientras se
--    construye: no se crea en una migración transaccional.
--
-- Idempotente — safe to re-run: CREATE OR REPLACE y REVOKE/GRANT.
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_metrics()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH
  bounds AS (
    SELECT
      now() AS at,
      date_trunc('month', now())::date AS month_start,
      date_trunc('week', now()) AS week_start
  ),
  acc AS (
    SELECT a.id, a.created_at, s.status, s.provider, s.plan_id, s.cycle
    FROM accounts a
    LEFT JOIN subscriptions s ON s.account_id = a.id
  ),
  by_status AS (
    SELECT coalesce(jsonb_object_agg(k, n), '{}'::jsonb) AS j
    FROM (
      SELECT coalesce(status, 'none') AS k, count(*) AS n
      FROM acc
      GROUP BY 1
    ) x
  ),
  weeks AS (
    SELECT coalesce(
      jsonb_agg(
        jsonb_build_object(
          'week_start', to_char(w.week, 'YYYY-MM-DD'),
          'count', (
            SELECT count(*) FROM acc
            WHERE acc.created_at >= w.week
              AND acc.created_at < w.week + interval '1 week'
          )
        )
        ORDER BY w.week
      ),
      '[]'::jsonb
    ) AS j
    FROM bounds b,
    LATERAL generate_series(
      b.week_start - interval '11 weeks',
      b.week_start,
      interval '1 week'
    ) AS w(week)
  ),
  revenue AS (
    SELECT
      coalesce(sum(
        CASE
          WHEN acc.cycle = 'year'
            THEN coalesce(p.price_usd_year / 12, p.price_usd_month)
          ELSE p.price_usd_month
        END
      ), 0) AS mrr,
      count(*) AS paying
    FROM acc
    JOIN plans p ON p.id = acc.plan_id
    WHERE acc.status IN ('active', 'past_due')
      AND acc.provider <> 'manual'
  )
  SELECT jsonb_build_object(
    'generated_at', (SELECT at FROM bounds),
    'accounts', jsonb_build_object(
      'total', (SELECT count(*) FROM acc),
      'by_status', (SELECT j FROM by_status)
    ),
    'signups', jsonb_build_object(
      'last_7_days',
        (SELECT count(*) FROM acc WHERE created_at >= now() - interval '7 days'),
      'last_30_days',
        (SELECT count(*) FROM acc WHERE created_at >= now() - interval '30 days'),
      'weekly', (SELECT j FROM weeks)
    ),
    'revenue', jsonb_build_object(
      'mrr_usd', (SELECT round(mrr, 2) FROM revenue),
      'arr_usd', (SELECT round(mrr * 12, 2) FROM revenue),
      'paying_accounts', (SELECT paying FROM revenue)
    ),
    'comped', (
      SELECT count(*) FROM acc
      WHERE provider = 'manual'
        AND status NOT IN ('cancelled', 'expired')
    ),
    'delinquent', jsonb_build_object(
      'past_due', (SELECT count(*) FROM acc WHERE status = 'past_due'),
      'suspended', (SELECT count(*) FROM acc WHERE status = 'suspended'),
      'total', (SELECT count(*) FROM acc WHERE status IN ('past_due', 'suspended'))
    ),
    'whatsapp', jsonb_build_object(
      'connected', (SELECT count(*) FROM whatsapp_config WHERE status = 'connected')
    ),
    'messages_month', jsonb_build_object(
      'period_start', (SELECT to_char(month_start, 'YYYY-MM-DD') FROM bounds),
      'inbound', (
        SELECT count(*) FROM messages m
        WHERE m.sender_type = 'customer'
          AND m.created_at >= (SELECT month_start FROM bounds)
      ),
      'outbound', (
        SELECT coalesce(sum(u.value), 0) FROM usage_counters u
        WHERE u.period_start = (SELECT month_start FROM bounds)
          AND u.metric IN ('messages_out', 'broadcast_recipients')
      )
    )
  );
$$;

-- Ver el punto 2 de la cabecera: sin SECURITY DEFINER y solo service_role.
REVOKE ALL ON FUNCTION public.platform_metrics() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_metrics() FROM anon;
REVOKE ALL ON FUNCTION public.platform_metrics() FROM authenticated;
GRANT EXECUTE ON FUNCTION public.platform_metrics() TO service_role;

COMMENT ON FUNCTION public.platform_metrics() IS
  'Resumen del panel de plataforma (s9.2): cuentas por estado, altas, '
  'MRR/ARR (sin comped), comped, morosos, WhatsApp conectados y mensajes '
  'del mes, en un jsonb. Solo service_role, y solo desde '
  '/api/platform/metrics, que exige requirePlatformAdmin().';
