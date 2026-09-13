-- ============================================================
-- 054 — Registro integrado (Embedded Signup) (fase 4 §1, f4.1)
--
-- La 053 dejó la tabla preparada para varios números por cuenta. Esta
-- añade lo que el registro integrado necesita guardar y que el
-- formulario manual nunca tuvo dónde poner:
--
--   * `registration_pin`   — el PIN de verificación en dos pasos que
--     generamos nosotros, CIFRADO. Los números creados por Embedded
--     Signup no traen 2FA, así que `POST /{phone_number_id}/register`
--     exige un PIN que elegimos; sin guardarlo, una re-registración
--     futura (cambio de app, recuperación) sería imposible sin pasar
--     por el soporte de Meta. Es un secreto del mismo nivel que el
--     token y viaja por el mismo mecanismo de cifrado y rotación
--     (f2.3, formato versionado).
--   * `token_expires_at`   — vencimiento del token que devuelve el
--     intercambio de código. Los tokens de integración de negocio
--     normalmente no expiran (Meta omite `expires_in`), de ahí el
--     NULL. Se GUARDA el dato; no se actúa sobre él todavía: la
--     renovación automática está explícitamente fuera de alcance.
--   * `provisioned_via`    — por qué vía llegó la fila. `'manual'`
--     para todo lo existente y para el formulario de siempre,
--     `'embedded_signup'` para lo que entra por el diálogo de Meta.
--     Es lo que permite distinguir, al migrar una instancia
--     autoalojada a plataforma, qué filas traen token de la app del
--     cliente (y por tanto fallarán la verificación de firma con
--     nuestro `META_APP_SECRET`) de las que ya son nuestras.
--
-- Lo que NO se toca: ninguna restricción, ningún índice, ninguna
-- política RLS. Las de la 017 filtran por `is_account_member(account_id)`
-- y siguen valiendo tal cual para las columnas nuevas; las de la 013 y
-- la 053 son las que garantizan la unicidad sobre la que el upsert
-- idempotente del registro integrado se apoya.
--
-- Idempotente: solo ADD COLUMN IF NOT EXISTS y un DO para la
-- restricción CHECK (Postgres no acepta ADD CONSTRAINT IF NOT EXISTS).
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS registration_pin TEXT;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS token_expires_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS provisioned_via TEXT NOT NULL DEFAULT 'manual';

-- Lista cerrada de vías. Un valor libre aquí acabaría en tres grafías
-- del mismo concepto y en una consulta de operación que se equivoca.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.whatsapp_config'::regclass
      AND conname = 'whatsapp_config_provisioned_via_check'
  ) THEN
    ALTER TABLE whatsapp_config
      ADD CONSTRAINT whatsapp_config_provisioned_via_check
      CHECK (provisioned_via IN ('manual', 'embedded_signup'));
  END IF;
END
$$;

COMMENT ON COLUMN whatsapp_config.registration_pin IS
  'PIN de verificación en dos pasos de 6 dígitos, CIFRADO (mismo formato versionado que access_token). Lo genera el servidor en el registro integrado; el formulario manual lo deja NULL porque el PIN es del cliente y no lo guardamos.';
COMMENT ON COLUMN whatsapp_config.token_expires_at IS
  'Vencimiento del access_token según Meta. NULL cuando el intercambio no devuelve `expires_in` (lo normal en tokens de integración de negocio). Se guarda como dato; la renovación automática no está implementada.';
COMMENT ON COLUMN whatsapp_config.provisioned_via IS
  'Vía por la que se creó la fila: manual (formulario, app del propio cliente) o embedded_signup (diálogo de Meta con NUESTRA app). Distingue qué filas verifican firma con nuestro META_APP_SECRET al migrar una instancia autoalojada a plataforma.';
