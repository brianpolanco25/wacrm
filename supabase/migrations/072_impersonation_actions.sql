-- ============================================================
-- 072_impersonation_actions.sql — Fase 9 (s9.5): la sesión de soporte
-- ESCRIBE, con rol efectivo `admin`, y cada escritura queda registrada.
--
-- Decisión del humano (spec fase 9, decisión 1): impersonar CON
-- escritura. Hasta aquí la sesión de soporte era de solo lectura en tres
-- capas: el middleware devolvía 403 a toda mutación, el rol efectivo era
-- `viewer`, y la RLS (057) solo ampliaba las políticas de SELECT.
--
-- Por qué la escritura tiene que abrirse AQUÍ, en la RLS
--   La mayor parte del panel escribe en Supabase DESDE EL NAVEGADOR con el
--   JWT del operador (`contacts/page.tsx`, `tag-manager.tsx`,
--   `pipeline-settings.tsx`, `deal-form.tsx`, `use-broadcast-sending.ts`…:
--   47 llamadas de escritura en 17 archivos). Esas peticiones no pasan por
--   Next: ninguna ruta, ni `supabaseAdmin()`, ni el middleware las ve. Si
--   la escritura se abriera solo en las rutas de API (usando el rol de
--   servicio cuando hay sesión de soporte), el operador seguiría sin poder
--   editar un contacto, una etiqueta o un pipeline — que es precisamente
--   para lo que el humano pidió la escritura. La única capa que ve esas
--   peticiones es la RLS, igual que la 057 concluyó para la lectura.
--
-- Qué hace
--   1. `impersonation_actions` — la bitácora de acciones de cada sesión.
--      La escriben DOS caminos, y por eso `source`:
--        'http' — `recordSupportAction()` en el servidor, una fila por
--                 petición mutante que llega a una ruta de Next con una
--                 sesión de soporte válida (`request_id` único la
--                 deduplica aunque la ruta resuelva la sesión dos veces).
--        'db'   — el trigger `record_support_write()` de abajo, una fila
--                 por fila escrita con el JWT del operador. Es lo único
--                 que ve las escrituras que el navegador manda directo a
--                 PostgREST.
--   2. `can_write_account(acc, min_role)` = `is_account_member(acc,
--      min_role) OR (min_role <> 'owner' AND has_open_support_session(acc))`.
--      Rol efectivo `admin`: una política que exija `owner` NO se abre al
--      soporte. Hoy ninguna política de escritura pide `owner` (la única
--      acción de owner, transferir la propiedad, va por RPC y por
--      `requireRole('owner')`); la condición está para la siguiente.
--   3. Reescribe las políticas de INSERT/UPDATE/DELETE/ALL de las tablas
--      de inquilino que llamaban a `is_account_member` para que llamen a
--      `can_write_account` — mismo bucle sobre `pg_policies` que la 057,
--      misma sustitución de nombre y nada más. 59 políticas al aplicar
--      al escribir esta migración (el NOTICE lo dice).
--   4. Cuelga `record_support_write()` de cada tabla cuya política de
--      escritura acabe llamando a `can_write_account`.
--
-- Qué NO se abre al soporte, y por qué cada una
--   accounts             renombrar / moneda de la cuenta y, sobre todo, la
--                        fila que decide la propiedad: no es de `admin`.
--   account_invitations  una invitación crea un acceso que SOBREVIVE a la
--                        sesión de 30 minutos (el operador podría
--                        invitarse a sí mismo). Los miembros se añaden
--                        desde el panel (s9.4), con su propia bitácora.
--   api_keys             una clave de API es una credencial permanente que
--                        el operador vería en claro: el mismo acceso que
--                        sobrevive a la sesión.
--   subscriptions,       facturación / PayPal del cliente. `subscriptions`
--   checkout_intents     no tiene política de escritura y sigue sin ella
--                        (058 lo afirma); `checkout_intents` tampoco.
--   platform_admins,     la plataforma no se administra desde dentro de
--   impersonation_log,   una cuenta de cliente, y la bitácora no la
--   impersonation_actions  reescribe quien está siendo auditado.
--   profiles,            sus políticas van por `auth.uid() = user_id`, no
--   notifications        por cuenta: durante la sesión serían las filas
--                        del PROPIO operador bajo el cartel del cliente.
--   storage.objects      fuera, como en la 057 (esquema de Supabase). Los
--                        adjuntos no se suben durante una sesión de
--                        soporte; `guardReadOnly` lo rechaza en el
--                        navegador.
--
-- Coste en la vía normal (sin sesión de soporte)
--   Políticas: `is_account_member` se evalúa primero; el segundo término
--   solo corre para quien no es miembro, y es un EXISTS sobre el índice
--   parcial `idx_impersonation_log_open_actor_account`.
--   Trigger: sale en la primera línea cuando `auth.uid()` es NULL — el rol
--   de servicio: el webhook de WhatsApp, los crons, `/api/v1` — así que
--   lo entrante no paga nada (CP11). Para un usuario normal, un EXISTS
--   sobre el mismo índice parcial, que no encuentra fila.
--
-- Idempotente — safe to re-run: CREATE TABLE/INDEX IF NOT EXISTS, CREATE
-- OR REPLACE en las funciones, DROP POLICY IF EXISTS antes de cada
-- CREATE POLICY propia, el bucle solo encuentra políticas que todavía
-- nombran `is_account_member`, y los triggers se recrean con DROP IF
-- EXISTS.
-- ============================================================

-- ============================================================
-- 1. La bitácora de acciones
--
-- `log_id` → `impersonation_log(id) ON DELETE RESTRICT`: una acción no
-- existe sin la sesión que la abrió, y borrar la sesión no puede borrar
-- lo que se hizo en ella. `impersonation_log` no se borra nunca (sin
-- política de DELETE y sin FK a `accounts`), así que RESTRICT no bloquea
-- ninguna baja de cliente.
--
-- `account_id` y `actor_user_id` SIN clave foránea, mismo criterio que
-- `impersonation_log` (055) y `billing_events` (041): la auditoría tiene
-- que sobrevivir al borrado de la cuenta auditada y del operador.
--
-- `status`: el código HTTP cuando se conoce. Una fila 'http' se escribe
-- ANTES de que la ruta responda (es la condición para que responda), así
-- que nace NULL; `requireRole` la marca 403 cuando la sesión no alcanza
-- (acción de `owner`, facturación). Las filas 'db' no tienen status: un
-- trigger AFTER solo corre si la escritura se hizo, y si la transacción
-- se deshace, la fila de auditoría se deshace con ella.
-- ============================================================
CREATE TABLE IF NOT EXISTS impersonation_actions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  log_id        uuid NOT NULL REFERENCES impersonation_log(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  account_id    uuid NOT NULL,
  method        text NOT NULL CHECK (method IN ('POST', 'PUT', 'PATCH', 'DELETE')),
  path          text NOT NULL CHECK (char_length(path) BETWEEN 1 AND 2048),
  status        integer CHECK (status IS NULL OR status BETWEEN 100 AND 599),
  source        text NOT NULL DEFAULT 'http' CHECK (source IN ('http', 'db')),
  request_id    uuid UNIQUE,
  occurred_at   timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE impersonation_actions IS
  'Cada mutación hecha durante una sesión de soporte (s9.5). source=http: '
  'una fila por petición a una ruta de Next; source=db: una fila por fila '
  'escrita con el JWT del operador (trigger record_support_write).';

CREATE INDEX IF NOT EXISTS idx_impersonation_actions_log
  ON impersonation_actions(log_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_impersonation_actions_account
  ON impersonation_actions(account_id, occurred_at);

-- RLS: lectura solo para operadores; escritura solo con el rol de
-- servicio (sin política) o desde el trigger SECURITY DEFINER.
ALTER TABLE impersonation_actions ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS impersonation_actions_select ON impersonation_actions;
CREATE POLICY impersonation_actions_select ON impersonation_actions FOR SELECT
  TO authenticated
  USING (is_platform_admin(auth.uid()));

-- ============================================================
-- 2. Quién puede ESCRIBIR en esta cuenta
--
-- SECURITY DEFINER y STABLE por las mismas razones que `can_read_account`
-- (057). `min_role` sí cuenta en la rama de soporte, a diferencia de la
-- lectura: el rol efectivo es `admin`, así que todo lo que pida `owner`
-- queda fuera.
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_write_account(
  target_account_id uuid,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id, min_role)
      OR (min_role IS DISTINCT FROM 'owner'::account_role_enum
          AND has_open_support_session(target_account_id));
$$;

ALTER FUNCTION public.can_write_account(uuid, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_write_account(uuid, account_role_enum)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.can_write_account(uuid, account_role_enum) IS
  'Quién puede ESCRIBIR en esta cuenta: sus miembros con rol suficiente, o '
  'un operador con sesión de soporte abierta sobre ella, con rol efectivo '
  'admin (nunca owner). Solo en políticas de escritura (migración 072).';

-- ============================================================
-- 3. El registro de las escrituras que no pasan por Next
--
-- Una fila por fila escrita con el JWT de un operador que tiene una sesión
-- de soporte abierta, SOBRE LA CUENTA DE ESA SESIÓN. Si el operador
-- escribe en su propia empresa durante la sesión, eso no es una acción de
-- soporte y no se apunta aquí.
--
-- La cuenta de la fila: su propia columna `account_id` o, en las tablas
-- hijas que no la tienen, la de su padre. Para esas el trigger recibe dos
-- argumentos: la consulta que resuelve la cuenta del padre y la columna
-- de la fila que la alimenta. Un borrado en cascada de una hija no se
-- apunta (el padre ya no existe cuando el trigger AFTER corre, y su
-- borrado ya está apuntado).
--
-- `path` = 'db:<tabla>/<id>' — no es una ruta HTTP, es la fila; el método
-- traduce la operación (INSERT → POST, UPDATE → PATCH, DELETE → DELETE).
-- ============================================================
CREATE OR REPLACE FUNCTION public.record_support_write()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  uid         uuid := auth.uid();
  session_id  uuid;
  session_acc uuid;
  rec         jsonb;
  row_account uuid;
BEGIN
  -- Rol de servicio, webhook, crons: no hay operador. Nada que hacer, y
  -- nada que cueste (CP11).
  IF uid IS NULL THEN
    RETURN NULL;
  END IF;

  SELECT l.id, l.account_id
    INTO session_id, session_acc
    FROM impersonation_log l
   WHERE l.actor_user_id = uid
     AND l.action = 'impersonation'
     AND l.ended_at IS NULL
     AND l.expires_at > now()
   ORDER BY l.started_at DESC
   LIMIT 1;

  IF session_id IS NULL THEN
    RETURN NULL;
  END IF;

  rec := to_jsonb(CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END);

  IF TG_NARGS >= 2 THEN
    EXECUTE TG_ARGV[0] INTO row_account USING (rec ->> TG_ARGV[1])::uuid;
  ELSE
    row_account := (rec ->> 'account_id')::uuid;
  END IF;

  IF row_account IS DISTINCT FROM session_acc THEN
    RETURN NULL;
  END IF;

  INSERT INTO impersonation_actions
    (log_id, actor_user_id, account_id, method, path, source)
  VALUES (
    session_id,
    uid,
    session_acc,
    CASE TG_OP WHEN 'INSERT' THEN 'POST' WHEN 'UPDATE' THEN 'PATCH' ELSE 'DELETE' END,
    'db:' || TG_TABLE_NAME || COALESCE('/' || (rec ->> 'id'), ''),
    'db'
  );
  RETURN NULL;
END;
$$;

ALTER FUNCTION public.record_support_write() OWNER TO postgres;
REVOKE ALL ON FUNCTION public.record_support_write() FROM PUBLIC;

COMMENT ON FUNCTION public.record_support_write() IS
  'Trigger AFTER ROW: apunta en impersonation_actions (source=db) cada fila '
  'que un operador escribe con su JWT sobre la cuenta de su sesión de '
  'soporte abierta (migración 072).';

-- ============================================================
-- 4. Reescritura de las políticas de escritura y triggers
--
-- Mismo método que la 057: recorrer `pg_policies`, sustituir el nombre de
-- la función en el texto normalizado y recrear la política con sus roles,
-- su permisividad y su comando. La lista de excluidas es la de la
-- cabecera; `verify-schema.sql` afirma que ninguna de ellas gana el
-- predicado y que ninguna política de escritura de las demás se quedó
-- llamando a `is_account_member` directamente.
--
-- Tablas hijas (sin `account_id`): la consulta que resuelve la cuenta.
-- Si una política de escritura nueva cae en una tabla sin `account_id` y
-- sin entrada aquí, la migración FALLA en vez de colgar un trigger que no
-- sabría a qué cuenta apuntar.
-- ============================================================
DO $$
DECLARE
  excluded  text[] := ARRAY[
    'accounts', 'account_invitations', 'api_keys',
    'subscriptions', 'checkout_intents',
    'platform_admins', 'impersonation_log', 'impersonation_actions',
    'profiles', 'notifications'
  ];
  parents   jsonb := jsonb_build_object(
    'automation_steps',      jsonb_build_array('SELECT account_id FROM automations WHERE id = $1', 'automation_id'),
    'broadcast_recipients',  jsonb_build_array('SELECT account_id FROM broadcasts WHERE id = $1', 'broadcast_id'),
    'contact_custom_values', jsonb_build_array('SELECT account_id FROM contacts WHERE id = $1', 'contact_id'),
    'contact_tags',          jsonb_build_array('SELECT account_id FROM contacts WHERE id = $1', 'contact_id'),
    'flow_nodes',            jsonb_build_array('SELECT account_id FROM flows WHERE id = $1', 'flow_id'),
    'messages',              jsonb_build_array('SELECT account_id FROM conversations WHERE id = $1', 'conversation_id'),
    'message_reactions',     jsonb_build_array('SELECT c.account_id FROM messages m JOIN conversations c ON c.id = m.conversation_id WHERE m.id = $1', 'message_id'),
    'pipeline_stages',       jsonb_build_array('SELECT account_id FROM pipelines WHERE id = $1', 'pipeline_id')
  );
  pol        record;
  tbl        record;
  role_list  text;
  using_sql  text;
  check_sql  text;
  touched    int := 0;
  triggered  int := 0;
  has_col    boolean;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, permissive, cmd,
           pg_policies.roles AS role_names, qual, with_check
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%is_account_member(%'
      AND tablename <> ALL (excluded)
    ORDER BY tablename, policyname
  LOOP
    SELECT string_agg(
             CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END, ', ')
      INTO role_list
      FROM unnest(pol.role_names) AS r;

    using_sql := CASE WHEN pol.qual IS NULL THEN ''
      ELSE format(' USING (%s)', replace(pol.qual, 'is_account_member(', 'can_write_account(')) END;
    check_sql := CASE WHEN pol.with_check IS NULL THEN ''
      ELSE format(' WITH CHECK (%s)', replace(pol.with_check, 'is_account_member(', 'can_write_account(')) END;

    EXECUTE format('DROP POLICY %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR %s TO %s%s%s',
                   pol.policyname, pol.schemaname, pol.tablename,
                   CASE WHEN pol.permissive = 'PERMISSIVE'
                        THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                   pol.cmd, role_list, using_sql, check_sql);
    touched := touched + 1;
  END LOOP;

  RAISE NOTICE '072: % políticas de escritura abiertas a la sesión de soporte (can_write_account)', touched;

  -- Un trigger por tabla que acabe con una política de escritura que
  -- llama a `can_write_account` — también en la segunda pasada, cuando el
  -- bucle de arriba ya no encuentra nada que reescribir.
  FOR tbl IN
    SELECT DISTINCT tablename
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd IN ('INSERT', 'UPDATE', 'DELETE', 'ALL')
      AND (COALESCE(qual, '') || COALESCE(with_check, '')) LIKE '%can_write_account(%'
    ORDER BY tablename
  LOOP
    SELECT EXISTS (
      SELECT 1 FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = tbl.tablename
        AND column_name = 'account_id'
    ) INTO has_col;

    EXECUTE format('DROP TRIGGER IF EXISTS record_support_write ON public.%I', tbl.tablename);

    IF has_col THEN
      EXECUTE format(
        'CREATE TRIGGER record_support_write AFTER INSERT OR UPDATE OR DELETE '
        'ON public.%I FOR EACH ROW EXECUTE FUNCTION public.record_support_write()',
        tbl.tablename);
    ELSIF parents ? tbl.tablename THEN
      EXECUTE format(
        'CREATE TRIGGER record_support_write AFTER INSERT OR UPDATE OR DELETE '
        'ON public.%I FOR EACH ROW EXECUTE FUNCTION public.record_support_write(%L, %L)',
        tbl.tablename,
        parents -> tbl.tablename ->> 0,
        parents -> tbl.tablename ->> 1);
    ELSE
      RAISE EXCEPTION
        '072: % has a support-writable policy but no account_id and no parent mapping; add it to `parents`',
        tbl.tablename;
    END IF;
    triggered := triggered + 1;
  END LOOP;

  RAISE NOTICE '072: record_support_write colgado de % tablas', triggered;
END
$$;
