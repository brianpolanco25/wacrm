-- ============================================================
-- supabase/seed.sql — SOLO DESARROLLO LOCAL (fase 9, s9.7)
--
-- NUNCA contra un proyecto remoto. Las contraseñas de este archivo son de
-- laboratorio y públicas (están en el repositorio): cualquiera que lea
-- esto puede entrar con ellas. En producción los usuarios se crean desde
-- el panel de Supabase Auth con contraseñas propias, y la migración 074 da
-- el rol de operador y el plan ilimitado por correo (docs/security.md,
-- «Operators and the unlimited plan»).
--
-- Quién lo ejecuta: `supabase db reset --local` (sin `--no-seed`) y
-- `supabase start` en un volumen nuevo, por `[db.seed]` de config.toml
-- (`enabled = true`, `sql_paths = ["./seed.sql"]`, el valor por defecto
-- del CLI escrito a la vista). NO lo ejecuta
-- ninguna compuerta: CI corre `supabase db reset --local --no-seed`
-- (.github/workflows/migrations.yml) y scripts/replay-migrations.sh solo
-- aplica supabase/migrations/*.sql y verify-schema.sql.
--
-- Qué deja (las tres cuentas con la contraseña `bcmp1994`):
--
--   brianpolancodisenos@gmail.com  operador de la plataforma
--                                  (`platform_admins`): entra a /platform.
--   brianmpolanco@gmail.com        propietario de «Cabbity», con el plan
--                                  `ilimitado` asignado a mano (manual /
--                                  active) y el alta terminada.
--   cliente.demo@example.com       propietario de «Empresa Demo» en
--                                  `inicio` / `incomplete`, sin datos de
--                                  empresa: ve la puerta de alta de pago
--                                  (/onboarding) completa, paso 1 y 2.
--
-- El trigger `handle_new_user` (017) crea la cuenta y el perfil `owner`
-- de cada usuario, y el de la 046/073 siembra su suscripción
-- `inicio`/`incomplete`; este archivo solo retoca lo que difiere.
--
-- Idempotente: se puede ejecutar las veces que haga falta. Cada INSERT
-- lleva `WHERE NOT EXISTS` u `ON CONFLICT`, cada UPDATE escribe valores
-- absolutos, y todo se busca por correo, no por un id supuesto.
-- ============================================================

-- ============================================================
-- 1. Usuarios de Supabase Auth
--
-- Las columnas que GoTrue lee como texto sin admitir NULL
-- (confirmation_token, recovery_token, email_change_token_new,
-- email_change) van a '' o el inicio de sesión falla con «converting
-- NULL to string is unsupported». `confirmed_at` no se escribe: en GoTrue
-- es una columna generada desde `email_confirmed_at`.
-- ============================================================
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password,
  email_confirmed_at, raw_app_meta_data, raw_user_meta_data,
  created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
)
SELECT
  '00000000-0000-0000-0000-000000000000'::uuid,
  seed.id,
  'authenticated',
  'authenticated',
  seed.email,
  extensions.crypt('bcmp1994', extensions.gen_salt('bf')),
  now(),
  '{"provider": "email", "providers": ["email"]}'::jsonb,
  jsonb_build_object('full_name', seed.full_name),
  now(),
  now(),
  '', '', '', ''
FROM (VALUES
  ('5eed0000-0000-4000-8000-000000000001'::uuid,
   'brianpolancodisenos@gmail.com', 'Operador Cabbity'),
  ('5eed0000-0000-4000-8000-000000000002'::uuid,
   'brianmpolanco@gmail.com', 'Brian Polanco'),
  ('5eed0000-0000-4000-8000-000000000003'::uuid,
   'cliente.demo@example.com', 'Cliente Demo')
) AS seed(id, email, full_name)
WHERE NOT EXISTS (
  SELECT 1 FROM auth.users u WHERE lower(u.email) = seed.email
)
ON CONFLICT DO NOTHING;

-- La identidad `email` de cada uno: sin ella GoTrue no encuentra al
-- usuario al iniciar sesión con contraseña. `provider_id` es el id del
-- usuario (así lo escribe GoTrue para el proveedor email) y `email` es
-- una columna generada desde `identity_data`.
INSERT INTO auth.identities (
  provider_id, user_id, identity_data, provider,
  last_sign_in_at, created_at, updated_at
)
SELECT
  u.id::text,
  u.id,
  jsonb_build_object(
    'sub', u.id::text,
    'email', u.email,
    'email_verified', true,
    'phone_verified', false
  ),
  'email',
  now(),
  now(),
  now()
FROM auth.users u
WHERE lower(u.email) IN ('brianpolancodisenos@gmail.com',
                         'brianmpolanco@gmail.com',
                         'cliente.demo@example.com')
  AND NOT EXISTS (
    SELECT 1 FROM auth.identities i
    WHERE i.user_id = u.id AND i.provider = 'email'
  )
ON CONFLICT DO NOTHING;

-- ============================================================
-- 2. El operador de la plataforma
-- ============================================================
INSERT INTO platform_admins (user_id, granted_by, note)
SELECT u.id, u.id, 'Operador de Cabbity (seed local)'
FROM auth.users u
WHERE lower(u.email) = 'brianpolancodisenos@gmail.com'
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- 3. Cabbity: la empresa propietaria, en `ilimitado`
--
-- Mismo resultado que la 074 (que corrió antes de que este usuario
-- existiera y por eso no encontró a nadie): plan manual activo, sin
-- pasarela ni fechas, y una fila `plan_override` en la bitácora solo la
-- primera vez. Además el perfil de empresa completo y sellado, para que
-- entre directo al CRM (el CHECK de la 073 exige el perfil antes del
-- sello).
-- ============================================================
UPDATE accounts a
SET name = 'Cabbity',
    country = 'DO',
    phone = '+18095550100',
    industry = 'technology',
    team_size = '2-5',
    onboarding_completed_at = coalesce(a.onboarding_completed_at, now())
FROM auth.users u
WHERE u.id = a.owner_user_id
  AND lower(u.email) = 'brianmpolanco@gmail.com';

INSERT INTO impersonation_log (
  action, actor_user_id, account_id, account_name, reason,
  expires_at, details
)
SELECT
  'plan_override', a.owner_user_id, a.id, a.name,
  'Plan ilimitado de la empresa propietaria del servicio (seed local)',
  NULL,
  jsonb_build_object(
    'from_plan', s.plan_id,
    'to_plan', 'ilimitado',
    'from_provider', s.provider,
    'source', 'seed'
  )
FROM accounts a
JOIN auth.users u ON u.id = a.owner_user_id
LEFT JOIN subscriptions s ON s.account_id = a.id
WHERE lower(u.email) = 'brianmpolanco@gmail.com'
  AND NOT EXISTS (
    SELECT 1 FROM subscriptions cur
    WHERE cur.account_id = a.id
      AND cur.plan_id = 'ilimitado'
      AND cur.provider = 'manual'
      AND cur.status = 'active'
  );

INSERT INTO subscriptions (
  account_id, plan_id, provider, status, provider_subscription_id,
  cycle, trial_ends_at, grace_until, current_period_end,
  cancel_at_period_end
)
SELECT a.id, 'ilimitado', 'manual', 'active', NULL, NULL, NULL, NULL, NULL,
       false
FROM accounts a
JOIN auth.users u ON u.id = a.owner_user_id
WHERE lower(u.email) = 'brianmpolanco@gmail.com'
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

-- ============================================================
-- 4. Empresa Demo: un cliente que aún no ha pagado
--
-- Sin datos de empresa a propósito: la puerta de s9.6 le pide el paso 1
-- (empresa) y luego el 2 (plan y PayPal). La suscripción la sembró el
-- trigger en `inicio`/`incomplete`; el INSERT solo cubre una base donde
-- ese trigger no existiera, y nunca pisa un estado que alguien haya
-- cambiado probando el pago.
-- ============================================================
UPDATE accounts a
SET name = 'Empresa Demo'
FROM auth.users u
WHERE u.id = a.owner_user_id
  AND lower(u.email) = 'cliente.demo@example.com';

INSERT INTO subscriptions (account_id, plan_id, status)
SELECT a.id, 'inicio', 'incomplete'
FROM accounts a
JOIN auth.users u ON u.id = a.owner_user_id
WHERE lower(u.email) = 'cliente.demo@example.com'
ON CONFLICT (account_id) DO NOTHING;
