-- Verificación de las migraciones 055 y 057 (f4.4 impersonation-audit) contra el
-- Postgres local que levanta scripts/replay-migrations.sh. Ejecutar tras el
-- replay con:
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fase-4
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_impersonation-audit.sql
--
-- Comprueba lo que ningún test de vitest puede comprobar porque vive en la
-- base: la RLS de `platform_admins` / `impersonation_log`, la función
-- `is_platform_admin`, el CHECK del motivo y la supervivencia de la bitácora
-- al borrado de la cuenta auditada.
--
-- Y, desde la segunda ronda, lo que de verdad decide qué ve el operador
-- (bloque 6): con sesión abierta lee los datos de la cuenta impersonada y
-- NO puede escribir en ella; sin sesión, caducada, o revocado como
-- operador, no lee nada. Esa es la única capa que ve las peticiones que el
-- navegador manda directamente a Supabase, sin pasar por Next.

BEGIN;

-- Tres usuarios: un operador de la plataforma, un `owner` normal (que NO es
-- operador) y el dueño de la cuenta a la que se le dará soporte.
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('40000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'platform-operator@example.test', '{}', '{"full_name":"Platform operator"}', now(), now()),
  ('40000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'plain-owner@example.test',       '{}', '{"full_name":"Plain owner"}',       now(), now()),
  ('40000000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'target-owner@example.test',      '{}', '{"full_name":"Target owner"}',      now(), now());

-- El alta del operador es exactamente el SQL manual que documenta el informe.
INSERT INTO public.platform_admins (user_id, granted_by, note)
VALUES ('40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        'bootstrap del operador')
ON CONFLICT (user_id) DO NOTHING;

-- ============================================================
-- 1. is_platform_admin distingue al operador del owner normal.
-- ============================================================
DO $$
BEGIN
  IF NOT public.is_platform_admin('40000000-0000-4000-8000-000000000001') THEN
    RAISE EXCEPTION 'is_platform_admin dice que el operador no lo es';
  END IF;
  IF public.is_platform_admin('40000000-0000-4000-8000-000000000002') THEN
    RAISE EXCEPTION 'is_platform_admin da por operador a un owner normal';
  END IF;
  -- Un uuid que no existe tampoco pasa (la función no falla, devuelve false).
  IF public.is_platform_admin('00000000-0000-4000-8000-00000000dead') THEN
    RAISE EXCEPTION 'is_platform_admin da por operador a un uuid inexistente';
  END IF;
END
$$;

-- ============================================================
-- 2. Una sesión de soporte de ejemplo, escrita por el rol de servicio
--    (el que usa /api/platform/impersonate).
-- ============================================================
INSERT INTO public.impersonation_log
  (id, actor_user_id, account_id, account_name, reason, expires_at)
SELECT '40000000-0000-4000-8000-0000000000aa',
       '40000000-0000-4000-8000-000000000001',
       p.account_id,
       'Cuenta objetivo',
       'ticket 1234: el cliente no ve sus difusiones',
       now() + interval '30 minutes'
FROM public.profiles p
WHERE p.user_id = '40000000-0000-4000-8000-000000000003';

-- ============================================================
-- 3. El motivo es obligatorio y no trivial: el CHECK rechaza lo vacío y
--    lo simbólico ("ok", "-"). Sin esto la bitácora no audita nada.
-- ============================================================
DO $$
DECLARE
  target uuid;
BEGIN
  SELECT account_id INTO target FROM public.profiles
  WHERE user_id = '40000000-0000-4000-8000-000000000003';

  BEGIN
    INSERT INTO public.impersonation_log
      (actor_user_id, account_id, reason, expires_at)
    VALUES ('40000000-0000-4000-8000-000000000001', target, '   ', now());
    RAISE EXCEPTION 'la bitácora aceptó un motivo en blanco';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;

  BEGIN
    INSERT INTO public.impersonation_log
      (actor_user_id, account_id, reason, expires_at)
    VALUES ('40000000-0000-4000-8000-000000000001', target, 'ok', now());
    RAISE EXCEPTION 'la bitácora aceptó un motivo de dos caracteres';
  EXCEPTION WHEN check_violation THEN
    NULL;
  END;
END
$$;

-- ============================================================
-- 4. RLS: un usuario normal (incluido un `owner`) no lee nada de las dos
--    tablas, ni siquiera la fila que le concierne.
-- ============================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.platform_admins) THEN
    RAISE EXCEPTION 'un owner normal lee platform_admins';
  END IF;
  IF EXISTS (SELECT 1 FROM public.impersonation_log) THEN
    RAISE EXCEPTION 'un owner normal lee la bitácora de impersonación';
  END IF;
END
$$;
RESET ROLE;

-- El dueño de la cuenta impersonada tampoco: la bitácora es del operador.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000003', true);
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM public.impersonation_log) THEN
    RAISE EXCEPTION 'el dueño de la cuenta objetivo lee la bitácora';
  END IF;
END
$$;
RESET ROLE;

-- ============================================================
-- 5. RLS: nadie escribe desde el cliente. Ni el owner normal (que se
--    regalaría todas las cuentas del servicio insertándose en
--    platform_admins) ni el propio operador (que podría falsificar o
--    borrar su bitácora).
-- ============================================================
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000002', true);
DO $$
BEGIN
  BEGIN
    INSERT INTO public.platform_admins (user_id)
    VALUES ('40000000-0000-4000-8000-000000000002');
    RAISE EXCEPTION 'un owner normal se pudo dar de alta como operador';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;
RESET ROLE;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visible int;
  deleted int;
BEGIN
  -- El operador SÍ lee: es lo que hace auditable la impersonación.
  SELECT count(*) INTO visible FROM public.platform_admins;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'el operador no lee platform_admins (ve % filas)', visible;
  END IF;
  SELECT count(*) INTO visible FROM public.impersonation_log;
  IF visible <> 1 THEN
    RAISE EXCEPTION 'el operador no lee la bitácora (ve % filas)', visible;
  END IF;

  -- …pero no puede reescribirla. Sin política de UPDATE/DELETE la RLS no
  -- lanza error: simplemente no afecta a ninguna fila. Eso también vale,
  -- y es lo que se comprueba aquí.
  BEGIN
    UPDATE public.impersonation_log SET reason = 'motivo reescrito a posteriori';
    GET DIAGNOSTICS deleted = ROW_COUNT;
    IF deleted <> 0 THEN
      RAISE EXCEPTION 'el operador reescribió % filas de la bitácora', deleted;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.impersonation_log;
    GET DIAGNOSTICS deleted = ROW_COUNT;
    IF deleted <> 0 THEN
      RAISE EXCEPTION 'el operador borró % filas de la bitácora', deleted;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;
RESET ROLE;

-- ============================================================
-- 6. Migración 057 — LO QUE VE EL OPERADOR, y lo que no puede tocar.
--
-- Esto es lo único que comprueba de verdad la vía por la que el panel
-- habla con Supabase: el navegador, con el JWT del operador, sin pasar por
-- Next. Si la RLS no concede la lectura, el operador ve SUS datos con el
-- cartel del cliente; si concede algo más que lectura, la sesión de
-- soporte puede escribir en la empresa del cliente.
-- ============================================================

-- Un contacto de la cuenta objetivo, escrito con el rol de servicio.
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '40000000-0000-4000-8000-0000000000c1',
       '40000000-0000-4000-8000-000000000003',
       p.account_id, '+15550001111', 'Contacto de la empresa objetivo'
FROM public.profiles p
WHERE p.user_id = '40000000-0000-4000-8000-000000000003';

-- 6.1 CON sesión abierta (la fila del bloque 2, viva y sin caducar): el
--     operador LEE los contactos de la cuenta objetivo…
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visibles int;
  afectadas int;
  target uuid;
BEGIN
  SELECT count(*) INTO visibles FROM public.contacts
  WHERE id = '40000000-0000-4000-8000-0000000000c1';
  IF visibles <> 1 THEN
    RAISE EXCEPTION 'con sesión de soporte abierta el operador NO lee los contactos de la cuenta objetivo (ve % filas)', visibles;
  END IF;

  -- …y también la cuenta en sí, que es lo que pinta el nombre del cartel.
  SELECT count(*) INTO visibles FROM public.accounts a
  JOIN public.profiles p ON p.account_id = a.id
  WHERE p.user_id = '40000000-0000-4000-8000-000000000003';
  IF visibles <> 1 THEN
    RAISE EXCEPTION 'el operador no lee la cuenta impersonada';
  END IF;

  -- …PERO NO ESCRIBE. Ni una fila, por ninguno de los tres verbos. Las
  -- políticas de escritura no aprendieron el predicado nuevo y esa es
  -- exactamente la garantía.
  BEGIN
    UPDATE public.contacts SET name = 'reescrito por soporte'
    WHERE id = '40000000-0000-4000-8000-0000000000c1';
    GET DIAGNOSTICS afectadas = ROW_COUNT;
    IF afectadas <> 0 THEN
      RAISE EXCEPTION 'la sesión de soporte MODIFICÓ % contactos del cliente', afectadas;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  BEGIN
    DELETE FROM public.contacts
    WHERE id = '40000000-0000-4000-8000-0000000000c1';
    GET DIAGNOSTICS afectadas = ROW_COUNT;
    IF afectadas <> 0 THEN
      RAISE EXCEPTION 'la sesión de soporte BORRÓ % contactos del cliente', afectadas;
    END IF;
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;

  SELECT p.account_id INTO target FROM public.profiles p
  WHERE p.user_id = '40000000-0000-4000-8000-000000000003';
  BEGIN
    INSERT INTO public.contacts (user_id, account_id, phone, name)
    VALUES ('40000000-0000-4000-8000-000000000001', target, '+15559998888', 'alta de soporte');
    RAISE EXCEPTION 'la sesión de soporte INSERTÓ un contacto en la cuenta del cliente';
  EXCEPTION WHEN insufficient_privilege THEN
    NULL;
  END;
END
$$;
RESET ROLE;

-- 6.2 SIN sesión: el mismo operador no ve nada de esa cuenta. El permiso
--     lo da la fila de la bitácora, no ser operador de la plataforma.
UPDATE public.impersonation_log
SET ended_at = now(), ended_reason = 'manual'
WHERE id = '40000000-0000-4000-8000-0000000000aa';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visibles int;
BEGIN
  SELECT count(*) INTO visibles FROM public.contacts
  WHERE id = '40000000-0000-4000-8000-0000000000c1';
  IF visibles <> 0 THEN
    RAISE EXCEPTION 'tras cerrar la sesión el operador sigue leyendo los contactos del cliente (% filas)', visibles;
  END IF;
END
$$;
RESET ROLE;

-- 6.3 Una fila reabierta pero CADUCADA tampoco concede nada: la ventana de
--     30 minutos la impone la base, no la cookie.
UPDATE public.impersonation_log
SET ended_at = NULL, ended_reason = NULL, expires_at = now() - interval '1 minute'
WHERE id = '40000000-0000-4000-8000-0000000000aa';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visibles int;
BEGIN
  SELECT count(*) INTO visibles FROM public.contacts
  WHERE id = '40000000-0000-4000-8000-0000000000c1';
  IF visibles <> 0 THEN
    RAISE EXCEPTION 'una sesión caducada sigue leyendo los contactos del cliente (% filas)', visibles;
  END IF;
END
$$;
RESET ROLE;

-- 6.4 Revocar al operador termina la sesión aunque la fila siga abierta.
UPDATE public.impersonation_log
SET expires_at = now() + interval '30 minutes'
WHERE id = '40000000-0000-4000-8000-0000000000aa';
DELETE FROM public.platform_admins
WHERE user_id = '40000000-0000-4000-8000-000000000001';

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000001', true);
DO $$
DECLARE
  visibles int;
BEGIN
  SELECT count(*) INTO visibles FROM public.contacts
  WHERE id = '40000000-0000-4000-8000-0000000000c1';
  IF visibles <> 0 THEN
    RAISE EXCEPTION 'un operador revocado sigue leyendo los contactos del cliente (% filas)', visibles;
  END IF;
END
$$;
RESET ROLE;

-- Se restituye el permiso: los bloques siguientes lo dan por hecho.
INSERT INTO public.platform_admins (user_id, granted_by, note)
VALUES ('40000000-0000-4000-8000-000000000001',
        '40000000-0000-4000-8000-000000000001',
        'bootstrap del operador')
ON CONFLICT (user_id) DO NOTHING;

-- 6.5 Y un `owner` normal, con o sin filas en la bitácora, jamás ve la
--     cuenta ajena: el predicado nuevo pasa por platform_admins.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '40000000-0000-4000-8000-000000000002', true);
DO $$
DECLARE
  visibles int;
BEGIN
  SELECT count(*) INTO visibles FROM public.contacts
  WHERE id = '40000000-0000-4000-8000-0000000000c1';
  IF visibles <> 0 THEN
    RAISE EXCEPTION 'un owner ajeno lee los contactos de otra empresa (% filas)', visibles;
  END IF;
END
$$;
RESET ROLE;

-- 6.6 Ninguna política de ESCRITURA lleva el predicado nuevo. Es la misma
--     aserción que hace CI en verify-schema.sql, repetida aquí porque es
--     la propiedad de la que depende todo lo anterior.
DO $$
DECLARE
  malas text;
BEGIN
  SELECT string_agg(tablename || '.' || policyname, ', ') INTO malas
  FROM pg_policies
  WHERE schemaname = 'public' AND cmd <> 'SELECT'
    AND (COALESCE(qual, '') || COALESCE(with_check, ''))
        ~ '(has_open_support_session|can_read_account)';
  IF malas IS NOT NULL THEN
    RAISE EXCEPTION 'políticas de escritura con el predicado de soporte: %', malas;
  END IF;
END
$$;

-- Se deja la bitácora como estaba para el bloque 7.
UPDATE public.impersonation_log
SET ended_at = NULL, ended_reason = NULL
WHERE id = '40000000-0000-4000-8000-0000000000aa';

DELETE FROM public.contacts WHERE id = '40000000-0000-4000-8000-0000000000c1';

-- ============================================================
-- 7. La bitácora sobrevive al borrado de la cuenta auditada y del usuario
--    auditor. Es la razón de que impersonation_log no tenga NINGUNA clave
--    foránea: con CASCADE desaparecería justo cuando hace falta, y con
--    RESTRICT «este cliente se dio de baja» sería imposible.
-- ============================================================
DO $$
DECLARE
  target uuid;
  quedan int;
BEGIN
  SELECT account_id INTO target FROM public.profiles
  WHERE user_id = '40000000-0000-4000-8000-000000000003';

  DELETE FROM public.subscriptions WHERE account_id = target;   -- 041: RESTRICT
  DELETE FROM public.usage_counters WHERE account_id = target;  -- 041: RESTRICT
  -- La cuenta primero: `accounts.owner_user_id` apunta a auth.users, así que
  -- borrar el usuario antes choca contra esa FK.
  DELETE FROM public.accounts WHERE id = target;
  DELETE FROM auth.users WHERE id = '40000000-0000-4000-8000-000000000003';

  SELECT count(*) INTO quedan FROM public.impersonation_log WHERE account_id = target;
  IF quedan <> 1 THEN
    RAISE EXCEPTION 'la bitácora no sobrevivió al borrado de la cuenta (quedan % filas)', quedan;
  END IF;
END
$$;

-- Borrar al operador SÍ retira su permiso: platform_admins es una concesión,
-- no un histórico, y un uuid reutilizado no puede heredar el permiso.
DO $$
DECLARE
  quedan int;
  bitacora int;
BEGIN
  -- Su cuenta personal (la que crea el trigger de alta) primero, por la
  -- misma FK `accounts.owner_user_id` del bloque anterior.
  DELETE FROM public.subscriptions s USING public.profiles p
    WHERE p.user_id = '40000000-0000-4000-8000-000000000001' AND s.account_id = p.account_id;
  DELETE FROM public.usage_counters u USING public.profiles p
    WHERE p.user_id = '40000000-0000-4000-8000-000000000001' AND u.account_id = p.account_id;
  DELETE FROM public.accounts a USING public.profiles p
    WHERE p.user_id = '40000000-0000-4000-8000-000000000001' AND a.id = p.account_id;
  DELETE FROM auth.users WHERE id = '40000000-0000-4000-8000-000000000001';

  SELECT count(*) INTO quedan FROM public.platform_admins
  WHERE user_id = '40000000-0000-4000-8000-000000000001';
  IF quedan <> 0 THEN
    RAISE EXCEPTION 'el permiso de operador sobrevivió al borrado del usuario';
  END IF;

  SELECT count(*) INTO bitacora FROM public.impersonation_log
  WHERE actor_user_id = '40000000-0000-4000-8000-000000000001';
  IF bitacora <> 1 THEN
    RAISE EXCEPTION 'la bitácora no sobrevivió al borrado del actor';
  END IF;
END
$$;

DO $$ BEGIN RAISE NOTICE 'checks_impersonation-audit: OK'; END $$;

ROLLBACK;
