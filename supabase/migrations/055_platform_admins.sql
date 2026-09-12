-- ============================================================
-- 055_platform_admins.sql — Fase 4 (SaaS): operador de la plataforma
--
-- Base del panel de plataforma (docs/saas/fase-4-plataforma.md §2). Crea
-- el modelo de administrador de la PLATAFORMA — el que opera el servicio,
-- por encima de todas las cuentas — y la bitácora de impersonación de
-- soporte. El listado/ficha de cuentas y suspender/reactivar llegan en
-- una migración posterior; aquí solo está el modelo y su guarda.
--
-- Por qué una tabla aparte y NO un rol del enum
--   `account_role_enum` (owner/admin/agent/viewer) describe roles DENTRO
--   de una cuenta. El operador del servicio no está dentro de ninguna:
--   mezclar «administro mi empresa» con «administro todas las empresas»
--   en el mismo valor convierte cualquier fallo de asignación de rol en
--   una escalada total. El spec lo dice sin matices: no reutilizar
--   `owner` bajo ningún concepto. De ahí `platform_admins`, con su propia
--   función de pertenencia y su propio prefijo de rutas (`/api/platform`).
--
-- Dos tablas:
--
--   platform_admins    Quién opera la plataforma. Una fila por usuario.
--                      SIN semilla: el primer administrador se da de alta
--                      a mano con SQL contra la base (procedimiento en
--                      `progress/impl_impersonation-audit.md`). Sembrar
--                      aquí un correo o un uuid metería una puerta
--                      trasera en el repositorio.
--
--   impersonation_log  Bitácora de sesiones de soporte: quién, qué cuenta,
--                      cuándo empezó, cuándo acabó y por qué. Sin esto la
--                      impersonación es una puerta trasera (spec §2).
--
-- Semántica de borrado — decisión, y por qué
--   `platform_admins.user_id` → `auth.users(id) ON DELETE CASCADE`: es una
--   CONCESIÓN de permiso, no un registro histórico. Si el usuario deja de
--   existir, su permiso de operar la plataforma tiene que desaparecer con
--   él; conservar la fila dejaría un `user_id` colgando que un futuro
--   usuario con el mismo uuid heredaría. No es dato de cliente, así que
--   no choca con «ningún CASCADE que borre datos de clientes» (CP2).
--   `granted_by` va a `ON DELETE SET NULL`: quién concedió el permiso es
--   informativo y no puede impedir borrar a quien lo concedió.
--
--   `impersonation_log` NO tiene NINGUNA clave foránea, ni a `accounts`
--   ni a `auth.users`. Es deliberado y es el mismo criterio que
--   `billing_events` (041): una bitácora de auditoría que desaparece
--   cuando se borra la cuenta auditada no sirve para auditar nada —
--   justo el caso en el que alguien querría consultarla. RESTRICT
--   tampoco vale: convertiría «este cliente se dio de baja» en «no se
--   puede dar de baja a este cliente porque le dimos soporte una vez».
--   Sin FK, la fila sobrevive al borrado de la cuenta y del usuario, y
--   por eso guarda además `account_name` como instantánea: un uuid
--   huérfano no se puede leer seis meses después.
--
-- RLS
--   platform_admins    SELECT solo para administradores de plataforma.
--   impersonation_log  SELECT solo para administradores de plataforma.
--   Ninguna de las dos tiene política de escritura: desde el cliente NO
--   se escribe aquí ni una fila. `platform_admins` se toca a mano contra
--   la base; `impersonation_log` lo escribe el rol de servicio desde
--   `/api/platform/impersonate`. Un inquilino que pudiera insertarse en
--   `platform_admins` se regalaría todas las cuentas del servicio.
--
-- Idempotente — safe to re-run: CREATE TABLE IF NOT EXISTS, índices IF
-- NOT EXISTS, CREATE OR REPLACE FUNCTION, políticas drop-then-create.
-- ============================================================

-- ============================================================
-- 1. Tablas
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_admins (
  user_id     uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  granted_by  uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  granted_at  timestamptz NOT NULL DEFAULT now(),
  note        text
);

COMMENT ON TABLE platform_admins IS
  'Operadores de la plataforma (por encima de todas las cuentas). Fuera de '
  'account_role_enum a propósito. Sin política de escritura: se administra '
  'con SQL contra la base.';

-- Bitácora de impersonación. Sin FK a propósito (ver cabecera).
CREATE TABLE IF NOT EXISTS impersonation_log (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id  uuid NOT NULL,
  account_id     uuid NOT NULL,
  -- Instantánea del nombre en el momento de abrir la sesión: la fila
  -- sobrevive al borrado de la cuenta y un uuid suelto no es auditable.
  account_name   text,
  -- Motivo obligatorio y no trivial. El mínimo se comprueba también en la
  -- ruta (400 sin motivo), pero vive aquí porque la bitácora tiene que
  -- ser fiable aunque alguien inserte por otro camino.
  reason         text NOT NULL CHECK (char_length(btrim(reason)) >= 10),
  started_at     timestamptz NOT NULL DEFAULT now(),
  -- Cuándo caduca la sesión de soporte. La cookie firmada lleva la misma
  -- marca; esta columna permite auditar la ventana sin leer cookies.
  expires_at     timestamptz NOT NULL,
  ended_at       timestamptz,
  ended_reason   text CHECK (ended_reason IN ('manual', 'expired', 'superseded'))
);

COMMENT ON TABLE impersonation_log IS
  'Sesiones de soporte con impersonación: actor, cuenta, momento y motivo. '
  'Sin FK a accounts/auth.users para que la bitácora sobreviva al borrado '
  'de la cuenta o del usuario auditado (mismo criterio que billing_events).';

CREATE INDEX IF NOT EXISTS idx_impersonation_log_account
  ON impersonation_log(account_id, started_at DESC);

CREATE INDEX IF NOT EXISTS idx_impersonation_log_actor
  ON impersonation_log(actor_user_id, started_at DESC);

-- Sesiones abiertas: lo que consulta el cierre por caducidad.
CREATE INDEX IF NOT EXISTS idx_impersonation_log_open
  ON impersonation_log(actor_user_id, started_at DESC)
  WHERE ended_at IS NULL;

-- ============================================================
-- 2. Pertenencia
--
-- SECURITY DEFINER por la misma razón que `is_account_member` (017): la
-- política de `platform_admins` la llama para decidir quién ve
-- `platform_admins`, y sin DEFINER eso sería recursión de RLS.
--
-- STABLE (no VOLATILE) para que el planificador la evalúe una vez por
-- consulta dentro de una política.
--
-- El parámetro lleva `DEFAULT auth.uid()` para que las políticas la
-- llamen sin argumentos, pero la guarda de servidor le pasa el uuid
-- explícito: allí el usuario ya está resuelto.
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_platform_admin(uid uuid DEFAULT auth.uid())
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1 FROM platform_admins pa WHERE pa.user_id = uid
  );
$$;

ALTER FUNCTION public.is_platform_admin(uuid) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION public.is_platform_admin(uuid) TO authenticated, service_role;

-- ============================================================
-- 3. RLS
--
-- Lectura para administradores de plataforma; escritura para nadie desde
-- el cliente. La ausencia de políticas INSERT/UPDATE/DELETE es la
-- protección, no un olvido: con RLS activada, lo que no tiene política
-- está denegado.
-- ============================================================

ALTER TABLE platform_admins ENABLE ROW LEVEL SECURITY;
ALTER TABLE impersonation_log ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS platform_admins_select ON platform_admins;
CREATE POLICY platform_admins_select ON platform_admins FOR SELECT
  TO authenticated
  USING (is_platform_admin(auth.uid()));

DROP POLICY IF EXISTS impersonation_log_select ON impersonation_log;
CREATE POLICY impersonation_log_select ON impersonation_log FOR SELECT
  TO authenticated
  USING (is_platform_admin(auth.uid()));

-- Sin semilla de administradores a propósito. Alta del primero:
--
--   INSERT INTO platform_admins (user_id, granted_by, note)
--   SELECT id, id, 'bootstrap del operador'
--   FROM auth.users WHERE email = 'operador@ejemplo.com'
--   ON CONFLICT (user_id) DO NOTHING;
--
-- Ver `progress/impl_impersonation-audit.md`.
