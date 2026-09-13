-- ============================================================
-- 058_platform_panel.sql — Fase 4 (SaaS): panel de plataforma
-- (docs/saas/fase-4-plataforma.md §2, listado / ficha / suspender)
--
-- La 055 puso el operador y la bitácora; la 057, la lectura de soporte.
-- Aquí llega lo que el panel necesita para OPERAR: suspender y
-- reactivar a mano, una bitácora que también registre esos dos actos, y
-- las dos consultas que el listado y la ficha no pueden hacer fila a
-- fila desde TypeScript.
--
-- 1. SUSPENSIÓN MANUAL — tres columnas en `subscriptions`, no un estado
--
--    La tentación es escribir `status = 'suspended'`. No vale, y la
--    razón es exactamente el requisito «la reactivación por webhook de
--    PayPal NO debe levantar una suspensión manual»: `status` es la
--    columna que el webhook de la fase 3 reescribe con cada evento
--    (`BILLING.SUBSCRIPTION.ACTIVATED` la pone en `active`). Una
--    suspensión guardada ahí se levantaría sola en cuanto el moroso
--    pagase por otro concepto, sin que nadie lo decidiera.
--
--    `manual_hold_at` es un eje aparte: NULL = sin retención. El webhook
--    escribe `subscriptions` con un UPDATE parcial (`writeSubscription`
--    en `src/app/api/billing/webhook/route.ts`), así que no toca estas
--    columnas ni por accidente — pero además hay test que lo fija.
--
--    Van en `subscriptions` y no en una tabla nueva por una razón de
--    coste: `getEntitlements()` ya lee esa fila en CADA escritura de la
--    aplicación, y la retención tiene que entrar en `readOnly` sin
--    añadir un segundo viaje a la base en el camino caliente.
--    `subscriptions` tiene `account_id` como clave primaria, así que
--    «una retención por cuenta» sale gratis de la forma de la tabla.
--
--    NINGUNA política de escritura nueva: `subscriptions` no tiene
--    ninguna desde la 041 y sigue sin tenerla. Solo el rol de servicio,
--    desde `/api/platform/accounts/[id]/hold`.
--
-- 2. LA BITÁCORA SE GENERALIZA — `impersonation_log.action`
--
--    Suspender a mano es, como impersonar, un acto de la plataforma
--    sobre una empresa ajena, y el encargo pide que se audite en la
--    MISMA tabla: un operador que quiera saber qué se le ha hecho a una
--    cuenta debe mirar un sitio, no dos. Se añade `action`
--    ('impersonation' | 'suspend' | 'reactivate') con el valor por
--    defecto que hace que TODA fila anterior siga significando lo mismo.
--
--    `expires_at` pasa a ser nullable porque suspender no abre ninguna
--    ventana — pero solo para esas filas: el CHECK nuevo exige que una
--    fila de impersonación siga llevando su caducidad, que es lo que la
--    055 garantizaba y lo que la 057 usa como predicado de lectura.
--
--    `has_open_support_session()` se recrea con `action = 'impersonation'`
--    explícito. Hoy sería redundante (una fila de suspensión tiene
--    `expires_at` NULL y `expires_at > now()` es falso), pero el
--    permiso de leer la empresa de un cliente no debe depender de que
--    una columna siga siendo nula: se dice en voz alta.
--
-- 3. DOS CONSULTAS QUE NO PUEDEN SALIR DE TYPESCRIPT
--
--    `platform_account_list()` — el listado. Miembros, consumo del ciclo
--    y última actividad son agregados por cuenta; pedirlos desde la ruta
--    serían tres consultas POR FILA. Va sin `SECURITY DEFINER` a
--    propósito y concedida solo a `service_role`: si alguien le diera
--    EXECUTE a `authenticated` por error, la RLS de `accounts` seguiría
--    tapando las filas ajenas en vez de regalar el censo de clientes.
--
--    `billing_events_subscription_resource_idx` — la 056 indexó el
--    `billing_agreement_id` de las ventas, que es lo que necesitaba el
--    área de suscripción del cliente. La ficha del panel enseña el
--    historial COMPLETO (altas, bajas, suspensiones, fallos de cobro), y
--    esos eventos llevan el id de la suscripción en `resource.id`. Sin
--    este índice, abrir una ficha recorre la bitácora entera.
--
-- Idempotente — safe to re-run: ADD COLUMN IF NOT EXISTS, restricciones
-- e índices en drop-then-add / IF NOT EXISTS, CREATE OR REPLACE en las
-- dos funciones.
-- ============================================================

-- ============================================================
-- 1. Suspensión manual
-- ============================================================

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS manual_hold_at     timestamptz,
  ADD COLUMN IF NOT EXISTS manual_hold_by     uuid,
  ADD COLUMN IF NOT EXISTS manual_hold_reason text;

COMMENT ON COLUMN subscriptions.manual_hold_at IS
  'Retención manual puesta por un operador de plataforma. NULL = sin '
  'retención. Eje INDEPENDIENTE de `status`: el webhook de PayPal '
  'reescribe `status` y NO puede levantar esto.';
COMMENT ON COLUMN subscriptions.manual_hold_by IS
  'auth.users.id del operador que la puso. SET NULL al borrarlo: quién '
  'la puso es informativo y no puede sostener la retención.';
COMMENT ON COLUMN subscriptions.manual_hold_reason IS
  'Motivo de la retención, tal y como lo escribió el operador. La '
  'bitácora completa está en impersonation_log (action = suspend).';

-- Nombre explícito y drop-then-add, como el resto de FKs de 040/041.
-- SET NULL y no CASCADE: borrar al operador no puede reactivar a un
-- moroso como efecto colateral.
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_manual_hold_by_fkey;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_manual_hold_by_fkey
  FOREIGN KEY (manual_hold_by) REFERENCES auth.users(id) ON DELETE SET NULL;

-- Un motivo vacío no es un motivo. Mismo mínimo que la bitácora (055).
ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_manual_hold_reason_check;
ALTER TABLE subscriptions
  ADD CONSTRAINT subscriptions_manual_hold_reason_check
  CHECK (
    manual_hold_at IS NULL
    OR char_length(btrim(coalesce(manual_hold_reason, ''))) >= 10
  );

-- «¿Quién está retenido ahora mismo?» es la consulta del panel, y son
-- siempre unas pocas filas de todas las cuentas del servicio.
CREATE INDEX IF NOT EXISTS idx_subscriptions_manual_hold
  ON subscriptions(manual_hold_at DESC)
  WHERE manual_hold_at IS NOT NULL;

-- ============================================================
-- 2. La bitácora registra también suspender y reactivar
-- ============================================================

ALTER TABLE impersonation_log
  ADD COLUMN IF NOT EXISTS action text NOT NULL DEFAULT 'impersonation';

ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN ('impersonation', 'suspend', 'reactivate'));

COMMENT ON COLUMN impersonation_log.action IS
  'Qué hizo el operador sobre esta cuenta: abrir una sesión de soporte '
  '(impersonation, el valor por defecto y el de toda fila anterior a '
  '058), suspenderla a mano o reactivarla.';

-- Suspender no abre ninguna ventana: no hay caducidad que apuntar.
ALTER TABLE impersonation_log ALTER COLUMN expires_at DROP NOT NULL;

-- …pero una sesión de soporte SÍ la lleva, y eso es lo que garantizaba
-- el NOT NULL de la 055. El CHECK conserva la garantía donde importa.
ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_session_needs_expiry;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_session_needs_expiry
  CHECK (action <> 'impersonation' OR expires_at IS NOT NULL);

-- Recreada con `action` explícito. Ver el punto 2 de la cabecera.
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
      AND l.action = 'impersonation'
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
  'SELECT: una sesión de soporte NUNCA escribe. Desde 058, solo cuentan '
  'las filas con action = impersonation.';

-- ============================================================
-- 3. El listado del panel
-- ============================================================

CREATE OR REPLACE FUNCTION public.platform_account_list(
  p_search text DEFAULT NULL,
  p_limit  integer DEFAULT 50,
  p_offset integer DEFAULT 0
)
RETURNS TABLE (
  account_id          uuid,
  name                text,
  created_at          timestamptz,
  member_count        bigint,
  plan_id             text,
  subscription_status text,
  manual_hold_at      timestamptz,
  trial_ends_at       timestamptz,
  current_period_end  timestamptz,
  grace_until         timestamptz,
  last_activity_at    timestamptz,
  usage               jsonb,
  total_count         bigint
)
LANGUAGE sql
STABLE
SET search_path = public
AS $$
  WITH filtered AS (
    SELECT a.id, a.name, a.created_at
    FROM accounts a
    WHERE p_search IS NULL
       OR btrim(p_search) = ''
       -- El nombre, o el uuid entero. Un uuid a medias no busca nada:
       -- `id::text LIKE '%…%'` sobre toda la tabla es un recorrido
       -- secuencial por cada tecla que pulse el operador.
       OR a.name ILIKE '%' || btrim(p_search) || '%'
       OR a.id::text = btrim(p_search)
  ),
  total AS (
    SELECT count(*) AS n FROM filtered
  ),
  page AS (
    SELECT f.id, f.name, f.created_at
    FROM filtered f
    -- `id` como desempate: sin él, dos cuentas creadas en el mismo
    -- instante pueden salir dos veces o ninguna al paginar.
    ORDER BY f.created_at DESC, f.id
    LIMIT greatest(1, least(coalesce(p_limit, 50), 200))
    OFFSET greatest(0, coalesce(p_offset, 0))
  )
  SELECT
    p.id,
    p.name,
    p.created_at,
    (SELECT count(*) FROM profiles pr WHERE pr.account_id = p.id),
    s.plan_id,
    s.status,
    s.manual_hold_at,
    s.trial_ends_at,
    s.current_period_end,
    s.grace_until,
    -- Última actividad = el último mensaje de cualquier conversación de
    -- la cuenta. `conversations.last_message_at` lo mantiene el webhook
    -- (037) y cubre entrada y salida.
    (SELECT max(c.last_message_at) FROM conversations c WHERE c.account_id = p.id),
    -- Consumo del ciclo en curso, con el MISMO anclaje al mes natural
    -- que `increment_usage` (041). Verbatim: ni escalado ni recortado
    -- al límite del plan.
    coalesce((
      SELECT jsonb_object_agg(u.metric, u.value)
      FROM usage_counters u
      WHERE u.account_id = p.id
        AND u.period_start = date_trunc('month', now())::date
    ), '{}'::jsonb),
    (SELECT n FROM total)
  FROM page p
  LEFT JOIN subscriptions s ON s.account_id = p.id
  ORDER BY p.created_at DESC, p.id;
$$;

-- SIN SECURITY DEFINER, y eso es la mitad de la defensa: la función
-- corre con los privilegios de quien la llama, así que el rol de
-- servicio (que salta la RLS) ve todas las cuentas y cualquier otro
-- rol vería solo lo que su RLS le deje. Los GRANT son la otra mitad.
REVOKE ALL ON FUNCTION public.platform_account_list(text, integer, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.platform_account_list(text, integer, integer) FROM anon;
REVOKE ALL ON FUNCTION public.platform_account_list(text, integer, integer) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.platform_account_list(text, integer, integer) TO service_role;

COMMENT ON FUNCTION public.platform_account_list(text, integer, integer) IS
  'Listado del panel de plataforma: una fila por cuenta con plan, estado, '
  'miembros, consumo del ciclo y última actividad. Solo service_role, y '
  'solo desde /api/platform/accounts, que exige requirePlatformAdmin().';

-- ============================================================
-- 4. El historial de facturación de UNA cuenta
--
-- La 056 indexó `billing_agreement_id` para las ventas. Los eventos de
-- suscripción (alta, suspensión, baja, fallo de cobro) llevan el id en
-- `resource.id`, y son justo los que el operador mira cuando el cliente
-- dice «me habéis cortado sin avisar».
-- ============================================================
CREATE INDEX IF NOT EXISTS billing_events_subscription_resource_idx
  ON billing_events ((payload -> 'resource' ->> 'id'))
  WHERE event_type LIKE 'BILLING.SUBSCRIPTION.%';
