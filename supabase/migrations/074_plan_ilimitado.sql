-- ============================================================
-- 074_plan_ilimitado.sql — Fase 9 (s9.7 `unlimited-plan-and-seed`)
--
-- La empresa propietaria del servicio (Cabbity) usa su propio CRM sin
-- pagarse a sí misma, y su operador entra al panel de plataforma. Hasta
-- aquí las dos cosas exigían SQL a mano en cada base. Esta migración:
--
--   1. Crea el plan `ilimitado`: todos los `limits` a `null` (= sin
--      límite para `assertQuota` / `assertStockLimit`), todas las
--      features del inventario de `src/lib/billing/plan-catalog.ts`,
--      precio 0, `is_public = false` (no sale en `/api/billing/plans` y
--      el checkout lo rechaza) y `sort_order 99`. NUNCA se publica en
--      PayPal: `provider_plan_id_*` no se escribe aquí, y el sync de
--      s9.3 rechaza un precio 0 (`no_price`).
--   2. Se lo asigna a mano (`provider = 'manual'`, `active`) a la cuenta
--      cuyo propietario es `brianmpolanco@gmail.com`. Mismo contrato que
--      la asignación del panel (s9.4, `overridePlan`): sin id de la
--      pasarela, sin ciclo ni fechas, sin tocar `manual_hold_*`, y NO se
--      pisa una suscripción viva de PayPal (active/past_due con id): eso
--      dejaría a PayPal cobrando una suscripción que la app ya no ve. En
--      ese caso se avisa con NOTICE y el humano la cancela antes.
--      Una fila `plan_override` en `impersonation_log` (071) por cada
--      asignación que CAMBIA algo; la segunda pasada no escribe nada.
--   3. Concede `platform_admins` al usuario `brianpolancodisenos@gmail.com`
--      (decisión 2 del humano: en producción ese usuario se crea en
--      Supabase Auth con una contraseña propia, y esta migración le da el
--      rol por correo).
--
-- Solo usuarios CONFIRMADOS (`auth.users.confirmed_at`; en GoTrue es una
-- columna generada, LEAST(email_confirmed_at, phone_confirmed_at), y
-- existe también en el esquema auth base de la imagen de Postgres que usa
-- `scripts/replay-migrations.sh`, que no trae `email_confirmed_at`). En un
-- proyecto con registro abierto, cualquiera puede crear una fila en
-- `auth.users` con un correo ajeno antes de que corra la migración; sin
-- confirmar no puede iniciar sesión, pero el rol quedaría esperando a
-- que alguien confirme esa fila. Crear el usuario desde el panel de
-- Supabase con «Auto Confirm User» cumple la condición.
--
-- Si un usuario no existe (o no está confirmado) en esta base: 0 filas,
-- sin error. Volver a ejecutar la migración —o el INSERT documentado en
-- docs/security.md— tras crearlo termina el trabajo.
--
-- La puerta de onboarding (s9.6): la 074 NO sella
-- `onboarding_completed_at`. No puede: el CHECK
-- `accounts_onboarding_needs_profile` (073) exige país, teléfono, sector
-- y tamaño, y esos datos no los conoce la migración. Tampoco serviría: la
-- puerta decide por el perfil, no por el sello. Con el plan manual activo
-- el propietario ve UNA vez el paso 1 (datos de la empresa, sin pago) y
-- su equipo entra sin puerta; al guardar, el servidor sella.
--
-- Idempotente — safe to re-run: INSERT … ON CONFLICT DO UPDATE del plan,
-- asignación con guarda «ya está así», ON CONFLICT DO NOTHING del
-- operador.
-- ============================================================

-- ============================================================
-- 1. El plan
-- ============================================================
INSERT INTO plans (
  id, name, description, price_usd_month, price_usd_year,
  limits, features, is_public, sort_order
) VALUES (
  'ilimitado', 'Ilimitado',
  'Sin límites y con todas las funciones. Solo se asigna a mano desde el panel de plataforma. No se vende ni se publica en PayPal.',
  0, 0,
  '{"operators": null, "contacts": null, "messages_out": null, "ai_replies": null, "broadcast_recipients": null, "knowledge_documents": null, "numbers": null, "retention_months": null}'::jsonb,
  ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api', 'webhooks',
        'multi_number', 'priority_support']::text[],
  false, 99
)
ON CONFLICT (id) DO UPDATE SET
  name            = EXCLUDED.name,
  description     = EXCLUDED.description,
  price_usd_month = EXCLUDED.price_usd_month,
  price_usd_year  = EXCLUDED.price_usd_year,
  limits          = EXCLUDED.limits,
  features        = EXCLUDED.features,
  is_public       = EXCLUDED.is_public,
  sort_order      = EXCLUDED.sort_order;

-- ============================================================
-- 2. La empresa propietaria del servicio, en `ilimitado`
-- ============================================================
DO $$
DECLARE
  v_acc  record;
  v_prev record;
  v_had  boolean;
BEGIN
  FOR v_acc IN
    SELECT a.id, a.name, a.owner_user_id
    FROM accounts a
    JOIN auth.users u ON u.id = a.owner_user_id
    WHERE lower(btrim(u.email)) = 'brianmpolanco@gmail.com'
      AND u.confirmed_at IS NOT NULL
  LOOP
    SELECT s.plan_id, s.provider, s.status, s.provider_subscription_id,
           s.cycle, s.trial_ends_at, s.grace_until, s.current_period_end,
           s.cancel_at_period_end
    INTO v_prev
    FROM subscriptions s
    WHERE s.account_id = v_acc.id;
    v_had := FOUND;

    -- Ya está así: nada que escribir ni que auditar.
    IF v_had
       AND v_prev.plan_id = 'ilimitado'
       AND v_prev.provider = 'manual'
       AND v_prev.status = 'active'
       AND v_prev.provider_subscription_id IS NULL
       AND v_prev.cycle IS NULL
       AND v_prev.trial_ends_at IS NULL
       AND v_prev.grace_until IS NULL
       AND v_prev.current_period_end IS NULL
       AND v_prev.cancel_at_period_end = false
    THEN
      CONTINUE;
    END IF;

    -- Misma regla que `isLivePayPalSubscription` (s9.4).
    IF v_had
       AND v_prev.provider_subscription_id IS NOT NULL
       AND v_prev.status IN ('active', 'past_due')
    THEN
      RAISE NOTICE 'La cuenta % tiene una suscripción viva de PayPal (%); cancélala y vuelve a ejecutar la 074',
        v_acc.id, v_prev.provider_subscription_id;
      CONTINUE;
    END IF;

    INSERT INTO impersonation_log (
      action, actor_user_id, account_id, account_name, reason,
      expires_at, details
    ) VALUES (
      'plan_override', v_acc.owner_user_id, v_acc.id, v_acc.name,
      'Plan ilimitado de la empresa propietaria del servicio (migración 074)',
      NULL,
      jsonb_build_object(
        'from_plan', CASE WHEN v_had THEN v_prev.plan_id END,
        'to_plan', 'ilimitado',
        'from_provider', CASE WHEN v_had THEN v_prev.provider END,
        'source', 'migration_074'
      )
    );

    INSERT INTO subscriptions (
      account_id, plan_id, provider, status, provider_subscription_id,
      cycle, trial_ends_at, grace_until, current_period_end,
      cancel_at_period_end
    ) VALUES (
      v_acc.id, 'ilimitado', 'manual', 'active', NULL,
      NULL, NULL, NULL, NULL, false
    )
    ON CONFLICT (account_id) DO UPDATE SET
      plan_id                  = EXCLUDED.plan_id,
      provider                 = EXCLUDED.provider,
      status                   = EXCLUDED.status,
      provider_subscription_id = EXCLUDED.provider_subscription_id,
      cycle                    = EXCLUDED.cycle,
      trial_ends_at            = EXCLUDED.trial_ends_at,
      grace_until              = EXCLUDED.grace_until,
      current_period_end       = EXCLUDED.current_period_end,
      cancel_at_period_end     = EXCLUDED.cancel_at_period_end;
  END LOOP;
END
$$;

-- ============================================================
-- 3. El operador de la plataforma, por correo
-- ============================================================
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT u.id, u.id, 'Operador de Cabbity (migración 074)'
FROM auth.users u
WHERE lower(btrim(u.email)) = 'brianpolancodisenos@gmail.com'
  AND u.confirmed_at IS NOT NULL
ON CONFLICT (user_id) DO NOTHING;
