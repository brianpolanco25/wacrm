-- Verificación RLS de f2.1 contra el Postgres local creado por
-- scripts/replay-migrations.sh. Ejecutar después del replay con:
-- docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--   -v ON_ERROR_STOP=1 < progress/checks_private-media.sql
--
-- Inserta dos miembros en A y un usuario en B. Comprueba las dos convenciones
-- de ruta, acceso de un compañero de A, y el aislamiento de B y anon. La API
-- de Storage es quien emite/verifica tokens firmados; su comprobación de TTL
-- y 403 está documentada como guion ejecutable en docs/security.md.

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'private-media-a-owner@example.test', '{}', '{"full_name":"Private media A owner"}', now(), now()),
  ('10000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'private-media-a-member@example.test', '{}', '{"full_name":"Private media A member"}', now(), now()),
  ('10000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'private-media-b-owner@example.test', '{}', '{"full_name":"Private media B owner"}', now(), now());

-- The signup trigger gives every user a personal account. Move A's second
-- user into A's account, just as invitation redemption does in production.
UPDATE public.profiles member
SET account_id = owner.account_id,
    account_role = 'agent'
FROM public.profiles owner
WHERE member.user_id = '10000000-0000-4000-8000-000000000002'
  AND owner.user_id = '10000000-0000-4000-8000-000000000001';

INSERT INTO storage.objects (bucket_id, name, owner, metadata)
SELECT 'chat-media', 'account-' || p.account_id::text || '/current-chat.txt', p.user_id, '{"mimetype":"text/plain"}'::jsonb
FROM public.profiles p
WHERE p.user_id = '10000000-0000-4000-8000-000000000001'
UNION ALL
SELECT 'flow-media', 'account-' || p.account_id::text || '/current-flow.txt', p.user_id, '{"mimetype":"text/plain"}'::jsonb
FROM public.profiles p
WHERE p.user_id = '10000000-0000-4000-8000-000000000001'
UNION ALL
SELECT 'flow-media', p.user_id::text || '/legacy-flow.txt', p.user_id, '{"mimetype":"text/plain"}'::jsonb
FROM public.profiles p
WHERE p.user_id = '10000000-0000-4000-8000-000000000001';

-- A's second member can read account paths and the legacy path uploaded by A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media')) <> 3 THEN
    RAISE EXCEPTION 'an A member cannot read every current and legacy media object';
  END IF;
END
$$;
RESET ROLE;

-- Account B cannot read A's objects, even with an authenticated JWT.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10000000-0000-4000-8000-000000000003', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media')) THEN
    RAISE EXCEPTION 'account B can read account A media';
  END IF;
END
$$;
RESET ROLE;

-- An unauthenticated direct Storage read is also denied by the SELECT policy.
SET LOCAL ROLE anon;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM storage.objects WHERE bucket_id IN ('chat-media', 'flow-media')) THEN
    RAISE EXCEPTION 'anonymous users can read private media';
  END IF;
END
$$;
RESET ROLE;

ROLLBACK;
