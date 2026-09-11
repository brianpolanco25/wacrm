-- ============================================================
-- 057_support_session_reads.sql — Fase 4 (SaaS): la sesión de soporte
-- LEE de verdad la cuenta impersonada, y lo hace desde la RLS.
--
-- Por qué existe esta migración
--   La 055 montó la sesión de soporte enteramente en el servidor: cookie
--   firmada, rol efectivo `viewer`, bitácora. Eso basta para lo que entra
--   por Next — y en este panel lo que entra por Next es la minoría. La
--   mayor parte de la aplicación habla con Supabase DESDE EL NAVEGADOR
--   (`@/lib/supabase/client`) con el JWT del operador, sin pasar por
--   ninguna ruta de Next. Consecuencia: durante una sesión de soporte el
--   operador veía SUS PROPIOS datos con el cartel de la empresa del
--   cliente encima. Una vista mal etiquetada es peor que una vista vacía.
--
--   La RLS es lo único que ve esas peticiones. Así que el permiso de
--   lectura de la sesión de soporte tiene que vivir aquí, no en TypeScript.
--
-- Qué hace
--   1. `has_open_support_session(target_account_id)` — el predicado:
--      ¿este usuario tiene AHORA MISMO una sesión de soporte abierta y sin
--      caducar sobre esa cuenta, y sigue siendo operador de la plataforma?
--   2. `can_read_account(acc, min_role)` — `is_account_member(acc, min_role)
--      OR has_open_support_session(acc)`. Un solo sitio donde vive el «o».
--   3. Recorre `pg_policies` y recrea CADA política de SELECT del esquema
--      `public` que llamaba a `is_account_member` para que llame a
--      `can_read_account`. Solo SELECT.
--
-- Qué NO hace, y es el punto entero
--   NINGUNA política de INSERT / UPDATE / DELETE / ALL se toca. Una sesión
--   de soporte es de lectura y tiene que serlo en el único sitio donde el
--   navegador no puede saltársela. `verify-schema.sql` lo afirma: si
--   alguien mete el predicado nuevo en una política de escritura, CI falla.
--
--   Tampoco se tocan las dos políticas de `storage.objects` (044): los
--   adjuntos se sirven con URLs firmadas que genera el servidor con el rol
--   de servicio, ya acotadas por cuenta, así que la lectura directa del
--   bucket no es la vía por la que el panel pinta media. Dejarlas fuera
--   mantiene esta migración dentro de `public` y evita tocar políticas de
--   un esquema que administra el propio Supabase.
--
-- Sobre el alcance de lectura: `can_read_account` ignora `min_role` para la
--   rama de soporte. Es deliberado. Tres políticas de SELECT piden `admin`
--   (`account_invitations`, `ai_usage_log`, `usage_counters`) y son
--   exactamente las que un operador necesita mirar cuando el cliente
--   escribe «no me deja invitar a nadie» o «dice que superé el límite».
--   El operador ya alcanza esos datos por el rol de servicio desde
--   `/api/platform/*`; limitarlo aquí a nivel `viewer` no le quitaría
--   ningún dato, solo se los daría por un camino peor auditado.
--
-- Coste en la vía normal (sin sesión de soporte): una llamada más por fila
--   evaluada, que resuelve en un EXISTS sobre el índice parcial de abajo
--   con `auth.uid()` y devuelve falso. `is_account_member` se evalúa
--   primero y la mayoría de las filas ni llegan al segundo término.
--
-- Idempotente — safe to re-run: CREATE OR REPLACE en las funciones, índice
-- con IF NOT EXISTS, y el bucle filtra por «la política todavía nombra
-- is_account_member», así que en la segunda pasada no encuentra ninguna.
-- ============================================================

-- ============================================================
-- 1. El predicado
--
-- SECURITY DEFINER por la misma razón que `is_account_member` (017) y que
-- `is_platform_admin` (055): lo llaman políticas, y sin DEFINER la lectura
-- de `impersonation_log` dentro de una política sería a su vez una lectura
-- con RLS — recursiva y, para un miembro normal, indistinguible de «no hay
-- fila».
--
-- STABLE: se evalúa una vez por fila dentro de la política, no por tupla
-- intermedia, y el planificador puede reordenarla detrás de
-- `is_account_member`.
--
-- Las cuatro condiciones, y por qué cada una:
--   actor_user_id = auth.uid()   la sesión es de quien la abrió; nadie
--                                hereda la de otro.
--   account_id = target          el permiso es sobre UNA cuenta, la que
--                                consta en la bitácora — no «las cuentas».
--   ended_at IS NULL             pulsar «salir» corta el acceso AQUÍ
--                                también, no solo en la cookie.
--   expires_at > now()           la ventana de 30 minutos la impone la
--                                base, no la caducidad de una cookie que
--                                su dueño puede reponer.
--   + sigue en platform_admins   revocar a un operador termina sus
--                                sesiones abiertas en la consulta
--                                siguiente, sin perseguir filas.
-- ============================================================
CREATE OR REPLACE FUNCTION public.has_open_support_session(target_account_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM impersonation_log l
    WHERE l.actor_user_id = auth.uid()
      AND l.account_id = target_account_id
      AND l.ended_at IS NULL
      AND l.expires_at > now()
  ) AND EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = auth.uid()
  );
$$;

ALTER FUNCTION public.has_open_support_session(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.has_open_support_session(uuid)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.has_open_support_session(uuid) IS
  'True si quien consulta tiene una sesión de soporte abierta y no caducada '
  'sobre esa cuenta y sigue en platform_admins. Solo para políticas de '
  'SELECT: una sesión de soporte NUNCA escribe.';

-- El índice que hace barata la comprobación anterior. El de 055
-- (`idx_impersonation_log_open`) lleva `started_at` como segunda columna,
-- que aquí no se filtra.
CREATE INDEX IF NOT EXISTS idx_impersonation_log_open_actor_account
  ON impersonation_log(actor_user_id, account_id)
  WHERE ended_at IS NULL;

-- ============================================================
-- 2. El «o», en un solo sitio
--
-- Misma firma que `is_account_member` para que la reescritura de las
-- políticas sea una sustitución de nombre y nada más: cualquier otra
-- transformación sobre expresiones que ya funcionan es una oportunidad de
-- equivocarse en la que no se gana nada.
-- ============================================================
CREATE OR REPLACE FUNCTION public.can_read_account(
  target_account_id uuid,
  min_role account_role_enum DEFAULT 'viewer'
) RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT is_account_member(target_account_id, min_role)
      OR has_open_support_session(target_account_id);
$$;

ALTER FUNCTION public.can_read_account(uuid, account_role_enum) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.can_read_account(uuid, account_role_enum)
  TO authenticated, service_role;

COMMENT ON FUNCTION public.can_read_account(uuid, account_role_enum) IS
  'Quién puede LEER esta cuenta: sus miembros con rol suficiente, o un '
  'operador de plataforma con sesión de soporte abierta sobre ella. Solo '
  'para políticas de SELECT (migración 057).';

-- ============================================================
-- 3. Reescritura sistemática de las políticas de SELECT
--
-- Se hace recorriendo `pg_policies` en vez de listando las 36 políticas a
-- mano por una razón concreta: una lista escrita a mano se queda corta en
-- silencio. Si mañana alguien añade una tabla con su política de SELECT,
-- la lista no se entera; este bucle, re-ejecutado, sí. (Y para que no haga
-- falta re-ejecutarlo, `verify-schema.sql` falla si queda alguna política
-- de SELECT llamando a `is_account_member` directamente: quien añada una
-- tabla nueva se entera en CI, no en producción.)
--
-- La reescritura es textual sobre `pg_policies.qual`, que es la expresión
-- ya normalizada por Postgres (`pg_get_expr`): sirve tal cual como cuerpo
-- de `USING`, incluidas las que van por subconsulta a la tabla padre
-- (`messages` vía `conversations`, `contact_tags` vía `contacts`…).
--
-- Políticas recreadas por este bloque (36; las 9 con `→ padre` no tienen
-- `account_id` propio y llegan a la cuenta por su tabla padre):
--
--   account_invitations_select (admin)   ai_usage_log_select (admin)
--   usage_counters_select (admin)        accounts_select (por id)
--   profiles_select (o el propio user_id)
--   ai_configs_select                    ai_knowledge_chunks_select
--   ai_knowledge_documents_select        api_keys_select
--   automation_logs_select               automations_select
--   broadcasts_select                    contact_notes_select
--   contacts_select                      conversations_select
--   custom_fields_select                 deals_select
--   flow_runs_select                     flows_select
--   member_presence_select               message_templates_select
--   pipelines_select                     quick_replies_select
--   subscriptions_select                 tags_select
--   webhook_endpoints_select             whatsapp_config_select
--   automation_steps_select   → automations
--   broadcast_recipients_select → broadcasts
--   contact_custom_values_select → contacts
--   contact_tags_select       → contacts
--   flow_nodes_select         → flows
--   flow_run_events_select    → flow_runs
--   message_reactions_select  → messages/conversations
--   messages_select           → conversations
--   pipeline_stages_select    → pipelines
--
-- `platform_admins` e `impersonation_log` no aparecen: sus políticas van
-- por `is_platform_admin`, no por `is_account_member`, y una sesión de
-- soporte no da acceso a la bitácora de nadie.
-- ============================================================
DO $$
DECLARE
  pol      record;
  new_qual text;
  role_list text;
  touched  int := 0;
BEGIN
  FOR pol IN
    SELECT schemaname, tablename, policyname, permissive, pg_policies.roles AS role_names, qual
    FROM pg_policies
    WHERE schemaname = 'public'
      AND cmd = 'SELECT'
      AND qual LIKE '%is_account_member(%'
    ORDER BY tablename, policyname
  LOOP
    new_qual := replace(pol.qual, 'is_account_member(', 'can_read_account(');

    -- `TO PUBLIC` es una palabra clave y no se puede citar como
    -- identificador; el resto de roles sí.
    SELECT string_agg(
             CASE WHEN r = 'public' THEN 'PUBLIC' ELSE quote_ident(r) END, ', ')
      INTO role_list
      FROM unnest(pol.role_names) AS r;

    EXECUTE format('DROP POLICY %I ON %I.%I',
                   pol.policyname, pol.schemaname, pol.tablename);
    EXECUTE format('CREATE POLICY %I ON %I.%I AS %s FOR SELECT TO %s USING (%s)',
                   pol.policyname, pol.schemaname, pol.tablename,
                   CASE WHEN pol.permissive = 'PERMISSIVE'
                        THEN 'PERMISSIVE' ELSE 'RESTRICTIVE' END,
                   role_list, new_qual);
    touched := touched + 1;
  END LOOP;

  RAISE NOTICE '057: % políticas de SELECT ampliadas con has_open_support_session', touched;
END
$$;
