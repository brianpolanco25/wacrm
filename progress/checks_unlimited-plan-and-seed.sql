-- ============================================================
-- Comprobaciones de s9.7 `unlimited-plan-and-seed` contra el Postgres del
-- harness. Orden (desde el worktree):
--
--   KEEP=1 scripts/replay-migrations.sh "$(pwd)"            # 001…074 + verify
--   docker exec -i <c> psql -U supabase_admin -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_unlimited-plan-and-seed_gotrue-shim.sql
--   docker exec -i <c> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < supabase/seed.sql                # dos veces
--   docker exec -i <c> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_unlimited-plan-and-seed.sql
--
-- Cada bloque RAISE EXCEPTION si falla y NOTICE «…: OK» si pasa. Los
-- escenarios que modifican datos van en BEGIN … ROLLBACK.
-- ============================================================

-- 1. Seed aplicado dos veces: exactamente tres usuarios, tres identidades,
--    un operador y UNA fila plan_override del seed.
DO $$
BEGIN
  IF (SELECT count(*) FROM auth.users
      WHERE email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com',
                      'cliente.demo@example.com')) <> 3 THEN
    RAISE EXCEPTION 'expected 3 seed users';
  END IF;
  IF (SELECT count(*) FROM auth.identities i JOIN auth.users u ON u.id = i.user_id
      WHERE i.provider = 'email' AND i.provider_id = u.id::text
        AND i.email = u.email
        AND u.email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com',
                        'cliente.demo@example.com')) <> 3 THEN
    RAISE EXCEPTION 'expected 3 email identities';
  END IF;
  IF EXISTS (SELECT 1 FROM auth.users
             WHERE email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com',
                             'cliente.demo@example.com')
               AND (email_confirmed_at IS NULL OR confirmed_at IS NULL
                    OR aud <> 'authenticated' OR role <> 'authenticated'
                    OR instance_id <> '00000000-0000-0000-0000-000000000000'
                    OR confirmation_token <> '' OR recovery_token <> ''
                    OR email_change_token_new <> '' OR email_change <> ''
                    OR raw_app_meta_data <> '{"provider":"email","providers":["email"]}'::jsonb)) THEN
    RAISE EXCEPTION 'a seed user is not confirmed or has the wrong auth shape';
  END IF;
  -- La contraseña es bcmp1994 (bcrypt).
  IF EXISTS (SELECT 1 FROM auth.users
             WHERE email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com',
                             'cliente.demo@example.com')
               AND (encrypted_password NOT LIKE '$2%'
                    OR encrypted_password <> extensions.crypt('bcmp1994', encrypted_password))) THEN
    RAISE EXCEPTION 'a seed password is not bcrypt(bcmp1994)';
  END IF;
  IF (SELECT count(*) FROM profiles p JOIN auth.users u ON u.id = p.user_id
      WHERE u.email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com',
                        'cliente.demo@example.com')
        AND p.account_role = 'owner') <> 3 THEN
    RAISE EXCEPTION 'handle_new_user did not give each seed user an owner profile';
  END IF;
  IF (SELECT count(*) FROM impersonation_log
      WHERE action = 'plan_override' AND details ->> 'source' = 'seed') <> 1 THEN
    RAISE EXCEPTION 'the seed must log the plan override exactly once';
  END IF;
  RAISE NOTICE 'seed twice: 3 users, 3 identities, 1 override log: OK';
END $$;

-- 2. El operador: is_platform_admin() true; los otros dos, false.
DO $$
DECLARE
  v_op uuid := (SELECT id FROM auth.users WHERE email = 'brianpolancodisenos@gmail.com');
BEGIN
  IF NOT public.is_platform_admin(v_op) THEN
    RAISE EXCEPTION 'operator is not a platform admin';
  END IF;
  IF public.is_platform_admin((SELECT id FROM auth.users WHERE email = 'brianmpolanco@gmail.com'))
     OR public.is_platform_admin((SELECT id FROM auth.users WHERE email = 'cliente.demo@example.com')) THEN
    RAISE EXCEPTION 'a non-operator seed user is a platform admin';
  END IF;
  IF (SELECT count(*) FROM platform_admins) <> 1 THEN
    RAISE EXCEPTION 'expected exactly one operator';
  END IF;
  RAISE NOTICE 'is_platform_admin(operator) true, others false: OK';
END $$;

-- 3. Cabbity: equivalente SQL de getEntitlements() — la fila de
--    subscriptions (ilimitado/manual/active, sin pasarela ni fechas, sin
--    retención) y plans.limits con las ocho claves a null, todas las
--    features. Perfil completo y alta sellada.
DO $$
DECLARE
  r record;
BEGIN
  SELECT a.name, a.country, a.phone, a.industry, a.team_size,
         a.onboarding_completed_at, s.*, p.limits, p.features, p.is_public
  INTO r
  FROM accounts a
  JOIN auth.users u ON u.id = a.owner_user_id
  JOIN subscriptions s ON s.account_id = a.id
  JOIN plans p ON p.id = s.plan_id
  WHERE u.email = 'brianmpolanco@gmail.com';

  IF r.name <> 'Cabbity' OR r.country <> 'DO' OR r.phone IS NULL
     OR r.industry IS NULL OR r.team_size IS NULL
     OR r.onboarding_completed_at IS NULL THEN
    RAISE EXCEPTION 'Cabbity profile incomplete: %', row_to_json(r);
  END IF;
  IF r.plan_id <> 'ilimitado' OR r.provider <> 'manual' OR r.status <> 'active'
     OR r.provider_subscription_id IS NOT NULL OR r.cycle IS NOT NULL
     OR r.trial_ends_at IS NOT NULL OR r.grace_until IS NOT NULL
     OR r.current_period_end IS NOT NULL OR r.cancel_at_period_end
     OR r.manual_hold_at IS NOT NULL THEN
    RAISE EXCEPTION 'Cabbity subscription is not ilimitado/manual/active: %', row_to_json(r);
  END IF;
  IF (SELECT count(*) FROM jsonb_each(r.limits) WHERE jsonb_typeof(value) = 'null') <> 8
     OR (SELECT count(*) FROM jsonb_object_keys(r.limits)) <> 8 THEN
    RAISE EXCEPTION 'ilimitado limits are not eight nulls: %', r.limits;
  END IF;
  IF r.features <> ARRAY['ai_autoreply', 'ai_knowledge', 'auto_assign', 'api',
                         'webhooks', 'multi_number', 'priority_support']::text[] THEN
    RAISE EXCEPTION 'ilimitado features differ from the inventory: %', r.features;
  END IF;
  IF r.is_public THEN
    RAISE EXCEPTION 'ilimitado is public';
  END IF;
  RAISE NOTICE 'Cabbity on ilimitado/manual/active, 8 null limits, all features, onboarded: OK';
END $$;

-- 4. Empresa Demo: inicio/incomplete, sin perfil ni sello.
DO $$
DECLARE
  r record;
BEGIN
  SELECT a.name, a.country, a.onboarding_completed_at, s.plan_id, s.status,
         s.provider, s.provider_subscription_id
  INTO r
  FROM accounts a
  JOIN auth.users u ON u.id = a.owner_user_id
  JOIN subscriptions s ON s.account_id = a.id
  WHERE u.email = 'cliente.demo@example.com';
  IF r.name <> 'Empresa Demo' OR r.plan_id <> 'inicio' OR r.status <> 'incomplete'
     OR r.provider_subscription_id IS NOT NULL OR r.country IS NOT NULL
     OR r.onboarding_completed_at IS NOT NULL THEN
    RAISE EXCEPTION 'demo account is not a fresh incomplete: %', row_to_json(r);
  END IF;
  RAISE NOTICE 'Empresa Demo on inicio/incomplete, no profile: OK';
END $$;

-- 5. platform_metrics() (como service_role): la cuenta ilimitada cuenta
--    como comped y NO entra en el MRR ni en paying_accounts. Con el seed:
--    operador y demo `incomplete`, Cabbity manual → MRR 0, comped 1.
BEGIN;
SET LOCAL ROLE service_role;
DO $$
DECLARE
  m jsonb := public.platform_metrics();
BEGIN
  IF (m ->> 'comped')::int <> 1 THEN
    RAISE EXCEPTION 'comped should be 1: %', m;
  END IF;
  IF (m -> 'revenue' ->> 'mrr_usd')::numeric <> 0
     OR (m -> 'revenue' ->> 'paying_accounts')::int <> 0 THEN
    RAISE EXCEPTION 'ilimitado leaked into MRR: %', m -> 'revenue';
  END IF;
  IF (m -> 'accounts' -> 'by_status' ->> 'incomplete')::int <> 2
     OR (m -> 'accounts' -> 'by_status' ->> 'active')::int <> 1 THEN
    RAISE EXCEPTION 'by_status unexpected: %', m -> 'accounts';
  END IF;
  RAISE NOTICE 'platform_metrics: comped 1, MRR 0, 2 incomplete + 1 active: OK';
END $$;
ROLLBACK;

-- 6. Catálogo público: lo que lee /api/billing/plans (is_public = true)
--    no incluye ilimitado; un usuario autenticado lo ve por RLS pero la
--    ruta filtra. Aquí, la consulta tal cual la hace la ruta.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM plans WHERE is_public AND id = 'ilimitado') THEN
    RAISE EXCEPTION 'ilimitado is in the public catalogue';
  END IF;
  IF (SELECT array_agg(id ORDER BY sort_order) FROM plans WHERE is_public)
     <> ARRAY['inicio', 'pro', 'negocio'] THEN
    RAISE EXCEPTION 'public catalogue changed';
  END IF;
  RAISE NOTICE 'public catalogue = inicio, pro, negocio: OK';
END $$;

-- 7. La 074 en producción: el usuario ya existe (creado en Supabase Auth)
--    y la migración corre DESPUÉS. Se simula devolviendo Cabbity al
--    estado del trigger, quitando al operador y re-ejecutando el cuerpo de
--    la 074 (vía \i para no copiarlo). Primera pasada: asigna, UNA fila
--    de bitácora `migration_074`, concede el operador. Segunda: nada.
BEGIN;
UPDATE subscriptions SET plan_id = 'inicio', provider = 'paypal', status = 'incomplete'
WHERE account_id = (SELECT a.id FROM accounts a JOIN auth.users u ON u.id = a.owner_user_id
                    WHERE u.email = 'brianmpolanco@gmail.com');
DELETE FROM platform_admins;
\i /work/074_plan_ilimitado.sql
\i /work/074_plan_ilimitado.sql
DO $$
DECLARE
  v_acc uuid := (SELECT a.id FROM accounts a JOIN auth.users u ON u.id = a.owner_user_id
                 WHERE u.email = 'brianmpolanco@gmail.com');
  l record;
BEGIN
  IF (SELECT count(*) FROM impersonation_log
      WHERE details ->> 'source' = 'migration_074') <> 1 THEN
    RAISE EXCEPTION '074 twice must log exactly once';
  END IF;
  SELECT * INTO l FROM impersonation_log WHERE details ->> 'source' = 'migration_074';
  IF l.action <> 'plan_override' OR l.account_id <> v_acc
     OR l.actor_user_id <> (SELECT id FROM auth.users WHERE email = 'brianmpolanco@gmail.com')
     OR l.reason <> 'Plan ilimitado de la empresa propietaria del servicio (migración 074)'
     OR l.expires_at IS NOT NULL
     OR l.details ->> 'from_plan' <> 'inicio' OR l.details ->> 'from_provider' <> 'paypal'
     OR l.details ->> 'to_plan' <> 'ilimitado' THEN
    RAISE EXCEPTION 'unexpected 074 log row: %', row_to_json(l);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE account_id = v_acc
                 AND plan_id = 'ilimitado' AND provider = 'manual' AND status = 'active') THEN
    RAISE EXCEPTION '074 did not assign ilimitado';
  END IF;
  IF NOT public.is_platform_admin((SELECT id FROM auth.users WHERE email = 'brianpolancodisenos@gmail.com'))
     OR (SELECT count(*) FROM platform_admins) <> 1 THEN
    RAISE EXCEPTION '074 did not grant the operator exactly once';
  END IF;
  RAISE NOTICE '074 after the users exist: assigns once, logs once, grants the operator: OK';
END $$;
ROLLBACK;

-- 8. La 074 no pisa una suscripción viva de PayPal ni toca manual_hold_*.
BEGIN;
UPDATE subscriptions SET plan_id = 'pro', provider = 'paypal', status = 'active',
  provider_subscription_id = 'I-LIVE-074', manual_hold_at = NULL
WHERE account_id = (SELECT a.id FROM accounts a JOIN auth.users u ON u.id = a.owner_user_id
                    WHERE u.email = 'brianmpolanco@gmail.com');
\i /work/074_plan_ilimitado.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE provider_subscription_id = 'I-LIVE-074'
                 AND plan_id = 'pro' AND status = 'active') THEN
    RAISE EXCEPTION '074 overwrote a live PayPal subscription';
  END IF;
  IF EXISTS (SELECT 1 FROM impersonation_log WHERE details ->> 'source' = 'migration_074') THEN
    RAISE EXCEPTION '074 logged an override it did not make';
  END IF;
  RAISE NOTICE '074 leaves a live PayPal subscription alone: OK';
END $$;
ROLLBACK;

BEGIN;
UPDATE subscriptions SET plan_id = 'inicio', provider = 'paypal', status = 'incomplete',
  manual_hold_at = now(), manual_hold_reason = 'retención de prueba 074'
WHERE account_id = (SELECT a.id FROM accounts a JOIN auth.users u ON u.id = a.owner_user_id
                    WHERE u.email = 'brianmpolanco@gmail.com');
\i /work/074_plan_ilimitado.sql
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM subscriptions WHERE plan_id = 'ilimitado'
                 AND manual_hold_reason = 'retención de prueba 074' AND manual_hold_at IS NOT NULL) THEN
    RAISE EXCEPTION '074 touched manual_hold_*';
  END IF;
  RAISE NOTICE '074 keeps manual_hold_*: OK';
END $$;
ROLLBACK;

-- 9. Un usuario SIN confirmar con el correo del operador no recibe el rol
--    (un registro ajeno adelantado a la migración).
BEGIN;
DELETE FROM platform_admins;
UPDATE auth.users SET email_confirmed_at = NULL
WHERE email = 'brianpolancodisenos@gmail.com';
\i /work/074_plan_ilimitado.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_admins) THEN
    RAISE EXCEPTION '074 granted the operator role to an unconfirmed user';
  END IF;
  RAISE NOTICE '074 ignores an unconfirmed user: OK';
END $$;
ROLLBACK;

-- 10. Base sin esos usuarios: la 074 aplica con 0 filas y sin error.
BEGIN;
DELETE FROM platform_admins;
UPDATE auth.users SET email = 'otro-' || email
WHERE email IN ('brianpolancodisenos@gmail.com', 'brianmpolanco@gmail.com');
\i /work/074_plan_ilimitado.sql
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM platform_admins)
     OR EXISTS (SELECT 1 FROM impersonation_log WHERE details ->> 'source' = 'migration_074') THEN
    RAISE EXCEPTION '074 acted without its users';
  END IF;
  RAISE NOTICE '074 without its users: 0 rows, no error: OK';
END $$;
ROLLBACK;
