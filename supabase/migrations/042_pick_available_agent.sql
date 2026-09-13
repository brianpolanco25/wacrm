-- ============================================================
-- 042_pick_available_agent.sql — Fase 1 (SaaS): elegir al operador
-- disponible con menos carga.
--
-- Hoy existen dos caminos de asignación automática y ninguno consulta
-- presencia: la cesión de la IA va a una persona fija
-- (`ai_configs.handoff_agent_id`) y el «round robin» de las
-- automatizaciones hace `.limit(1)` sobre perfiles, así que siempre
-- asigna al mismo. Esta RPC es el insumo que les faltaba a ambos.
--
-- Elegibilidad
--   - Miembro de la cuenta con rol `owner`, `admin` o `agent`. Un
--     `viewer` nunca es elegible. Con `p_include_admins = false` solo
--     cuentan los `agent`.
--
--     OJO: `account_role_enum` está declarado como
--     ('owner','admin','agent','viewer'), en orden de MÁS a MENOS
--     privilegio. Una comparación `>= 'agent'` sobre el enum incluiría a
--     `viewer` y excluiría a `owner`, justo al revés de lo que se quiere.
--     Por eso la pertenencia se expresa con IN (...) explícito.
--   - Latido `online` en `member_presence` más reciente que
--     `now() - p_stale_after`. Los cinco minutos por defecto dan margen
--     a diez latidos perdidos (el cliente late cada 30 s). `away` no
--     cuenta: quien está inactivo no recibe conversaciones nuevas.
--
-- Orden
--   1. Menos conversaciones abiertas/pendientes asignadas (carga ASC).
--   2. Latido más reciente (reparte hacia quien está más activo).
--
-- Devuelve NULL cuando no hay nadie elegible. NULL es un resultado
-- válido, no un error: significa «déjala sin asignar en la cola
-- común», y todos los llamadores deben tratarlo así.
--
-- Rendimiento: la subconsulta de recuento corre por candidato y la
-- cubre `idx_conversations_account_assignee` (040). Con equipos de
-- decenas de operadores es irrelevante.
--
-- Permisos: SECURITY DEFINER fija con qué privilegios corre, no quién
-- puede llamarla. Los dos llamadores actuales son procesos de servidor
-- (webhook/auto-reply y motor de automatizaciones) que usan service_role.
-- No se concede a authenticated: aceptar un account_id arbitrario desde
-- el cliente expondría la disponibilidad de otra cuenta.
--
-- Idempotente — CREATE OR REPLACE y GRANT/REVOKE son re-ejecutables.
-- ============================================================

CREATE OR REPLACE FUNCTION public.pick_available_agent(
  p_account_id     uuid,
  p_stale_after    interval DEFAULT '5 minutes',
  p_include_admins boolean  DEFAULT true
) RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT p.user_id
    FROM profiles p
    JOIN member_presence mp
      ON mp.user_id = p.user_id
     AND mp.account_id = p.account_id
   WHERE p.account_id = p_account_id
     AND p.account_role IN ('owner', 'admin', 'agent')
     AND (p_include_admins OR p.account_role = 'agent')
     AND mp.status = 'online'
     AND mp.last_seen_at > now() - p_stale_after
   ORDER BY (
     SELECT count(*)
       FROM conversations c
      WHERE c.account_id = p_account_id
        AND c.assigned_agent_id = p.user_id
        AND c.status IN ('open', 'pending')
   ) ASC,
   mp.last_seen_at DESC
   LIMIT 1;
$$;

REVOKE ALL ON FUNCTION public.pick_available_agent(uuid, interval, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.pick_available_agent(uuid, interval, boolean) FROM anon;
REVOKE ALL ON FUNCTION public.pick_available_agent(uuid, interval, boolean) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.pick_available_agent(uuid, interval, boolean) TO service_role;
