-- Verificación de s9.13 (support-readonly-rpcs) contra el Postgres local de
-- scripts/replay-migrations.sh. Sin migración nueva: comprueba que la única
-- RPC que el navegador puede llamar durante una sesión de soporte,
-- `filter_contacts_by_tags`, responde con la cuenta impersonada y nada más.
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/support-readonly-rpcs
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_support-readonly-rpcs.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_support-readonly-rpcs: OK` o con la primera EXCEPTION.
--
--   0. La definición vigente es STABLE y SECURITY INVOKER (lo que la deja en
--      SUPPORT_READ_RPCS); touch_presence es SECURITY DEFINER y escribe.
--   1. Operador con sesión abierta sobre A, con las etiquetas de A (las que
--      la página carga con .eq('account_id', A)): contactos de A, ninguno de
--      B ni de su propia empresa O; total_count cuadra.
--   2. Con las etiquetas de B: nada (RLS de contacts/contact_tags).
--   3. Un contacto de B enlazado a mano a una etiqueta de A (contact_tags
--      solo comprueba la cuenta del contacto): sigue sin salir.
--   4. Sesión cerrada: con las etiquetas de A, nada.
--   5. Residual documentado: un contacto de O enlazado a una etiqueta de A
--      SÍ sale (el operador es miembro de O; no es una fuga hacia terceros,
--      es una fila suya mal rotulada). La página de contactos lo descarta
--      por account_id (ver impl_support-readonly-rpcs.md).

BEGIN;

-- 0. Lo que el test de vitest exige, en el catálogo real.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'filter_contacts_by_tags'
       AND p.provolatile = 's' AND NOT p.prosecdef
  ) THEN
    RAISE EXCEPTION 'filter_contacts_by_tags ya no es STABLE + SECURITY INVOKER';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public' AND p.proname = 'touch_presence'
       AND p.provolatile = 'v' AND p.prosecdef
  ) THEN
    RAISE EXCEPTION 'touch_presence dejó de ser VOLATILE + SECURITY DEFINER';
  END IF;
END
$$;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('91300000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'op-913@example.test',      '{}', '{"full_name":"Operator"}', now(), now()),
  ('91300000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-a-913@example.test', '{}', '{"full_name":"Owner A"}',  now(), now()),
  ('91300000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'owner-b-913@example.test', '{}', '{"full_name":"Owner B"}',  now(), now());

INSERT INTO public.platform_admins (user_id, granted_by, note)
VALUES ('91300000-0000-4000-8000-000000000001', '91300000-0000-4000-8000-000000000001', 'checks s9.13');

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '91300000-0000-4000-8000-000000000001') AS o_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '91300000-0000-4000-8000-000000000002') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '91300000-0000-4000-8000-000000000003') AS b_acc;
GRANT SELECT ON ids TO authenticated;

-- Una etiqueta «vip» en cada empresa y contactos etiquetados en las tres.
INSERT INTO public.tags (id, user_id, account_id, name)
SELECT '91300000-0000-4000-8000-0000000000a0'::uuid, '91300000-0000-4000-8000-000000000002'::uuid, a_acc, 'vip' FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000b0', '91300000-0000-4000-8000-000000000003', b_acc, 'vip' FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000c0', '91300000-0000-4000-8000-000000000001', o_acc, 'vip' FROM ids;

INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '91300000-0000-4000-8000-0000000000a1'::uuid, '91300000-0000-4000-8000-000000000002'::uuid, a_acc, '+19130000001', 'Ana A'   FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000a2', '91300000-0000-4000-8000-000000000002', a_acc, '+19130000002', 'Abel A'  FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000a3', '91300000-0000-4000-8000-000000000002', a_acc, '+19130000003', 'Sin tag' FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000b1', '91300000-0000-4000-8000-000000000003', b_acc, '+19130000004', 'Bea B'   FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000b2', '91300000-0000-4000-8000-000000000003', b_acc, '+19130000005', 'Bruno B' FROM ids UNION ALL
SELECT '91300000-0000-4000-8000-0000000000c1', '91300000-0000-4000-8000-000000000001', o_acc, '+19130000006', 'Olga O'  FROM ids;

INSERT INTO public.contact_tags (contact_id, tag_id) VALUES
  ('91300000-0000-4000-8000-0000000000a1', '91300000-0000-4000-8000-0000000000a0'),
  ('91300000-0000-4000-8000-0000000000a2', '91300000-0000-4000-8000-0000000000a0'),
  ('91300000-0000-4000-8000-0000000000b1', '91300000-0000-4000-8000-0000000000b0'),
  ('91300000-0000-4000-8000-0000000000c1', '91300000-0000-4000-8000-0000000000c0'),
  -- 3. Contacto de B enlazado a la etiqueta de A.
  ('91300000-0000-4000-8000-0000000000b2', '91300000-0000-4000-8000-0000000000a0');

-- La sesión de soporte de O sobre A, como la abre /api/platform/impersonate.
INSERT INTO public.impersonation_log (id, actor_user_id, account_id, account_name, reason, expires_at)
SELECT '91300000-0000-4000-8000-0000000000ff', '91300000-0000-4000-8000-000000000001', a_acc,
       'Cuenta A', 'checks s9.13: filtro por etiqueta', now() + interval '30 minutes'
FROM ids;

SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '91300000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"91300000-0000-4000-8000-000000000001","role":"authenticated"}', true);

DO $$
DECLARE
  a uuid; b uuid; o uuid;
  got uuid[]; accs uuid[]; total bigint;
BEGIN
  SELECT a_acc, b_acc, o_acc INTO a, b, o FROM ids;

  -- 1. Las etiquetas de A, como las pasa contacts/page.tsx.
  SELECT array_agg((r.contact).id ORDER BY (r.contact).id),
         array_agg(DISTINCT (r.contact).account_id),
         max(r.total_count)
    INTO got, accs, total
    FROM public.filter_contacts_by_tags(ARRAY['91300000-0000-4000-8000-0000000000a0']::uuid[], NULL, 25, 0) r;
  IF got IS DISTINCT FROM ARRAY['91300000-0000-4000-8000-0000000000a1',
                                '91300000-0000-4000-8000-0000000000a2']::uuid[] THEN
    RAISE EXCEPTION '1: con las etiquetas de A devolvió %', got;
  END IF;
  IF accs IS DISTINCT FROM ARRAY[a] THEN
    RAISE EXCEPTION '1: devolvió filas de otras cuentas: %', accs;
  END IF;
  IF total <> 2 THEN
    RAISE EXCEPTION '1: total_count % <> 2', total;
  END IF;

  -- Con búsqueda y paginación, sigue siendo A.
  SELECT array_agg((r.contact).id) INTO got
    FROM public.filter_contacts_by_tags(ARRAY['91300000-0000-4000-8000-0000000000a0']::uuid[], 'Ana', 25, 0) r;
  IF got IS DISTINCT FROM ARRAY['91300000-0000-4000-8000-0000000000a1']::uuid[] THEN
    RAISE EXCEPTION '1: con búsqueda devolvió %', got;
  END IF;

  -- 2. Las etiquetas de B: nada.
  IF EXISTS (SELECT 1 FROM public.filter_contacts_by_tags(
               ARRAY['91300000-0000-4000-8000-0000000000b0']::uuid[], NULL, 25, 0)) THEN
    RAISE EXCEPTION '2: con las etiquetas de B devolvió filas';
  END IF;

  -- Ninguna combinación saca un contacto de B.
  IF EXISTS (SELECT 1 FROM public.filter_contacts_by_tags(
               ARRAY['91300000-0000-4000-8000-0000000000a0',
                     '91300000-0000-4000-8000-0000000000b0',
                     '91300000-0000-4000-8000-0000000000c0']::uuid[], NULL, 100, 0) r
              WHERE (r.contact).account_id = b) THEN
    RAISE EXCEPTION '3: salió un contacto de B';
  END IF;
END
$$;

-- 5. Residual: un contacto de O enlazado a la etiqueta de A (contact_tags
--    solo mira la cuenta del contacto, y O es del operador).
RESET ROLE;
INSERT INTO public.contact_tags (contact_id, tag_id)
VALUES ('91300000-0000-4000-8000-0000000000c1', '91300000-0000-4000-8000-0000000000a0');
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  o uuid; n int;
BEGIN
  SELECT o_acc INTO o FROM ids;
  SELECT count(*) INTO n
    FROM public.filter_contacts_by_tags(ARRAY['91300000-0000-4000-8000-0000000000a0']::uuid[], NULL, 25, 0) r
   WHERE (r.contact).account_id = o;
  IF n <> 1 THEN
    RAISE EXCEPTION '5: el residual documentado cambió (% filas de O); revisar el informe', n;
  END IF;
  RAISE NOTICE '5: residual confirmado: un contacto de la empresa del operador enlazado a una etiqueta de A sale en el RPC; la página lo descarta por account_id';
END
$$;

-- 4. Sesión cerrada: nada de A.
RESET ROLE;
UPDATE public.impersonation_log SET ended_at = now(), ended_reason = 'manual'
 WHERE id = '91300000-0000-4000-8000-0000000000ff';
SET LOCAL ROLE authenticated;

DO $$
DECLARE
  a uuid;
BEGIN
  SELECT a_acc INTO a FROM ids;
  IF EXISTS (SELECT 1 FROM public.filter_contacts_by_tags(
               ARRAY['91300000-0000-4000-8000-0000000000a0']::uuid[], NULL, 25, 0) r
              WHERE (r.contact).account_id = a) THEN
    RAISE EXCEPTION '4: con la sesión cerrada siguió viendo contactos de A';
  END IF;
  RAISE NOTICE 'checks_support-readonly-rpcs: OK';
END
$$;

ROLLBACK;
