-- ============================================================
-- 067 — Renovación automática del token de Embedded Signup
--
-- La 054 guardó `token_expires_at` "como dato" porque los tokens de
-- integración de negocio no caducaban. Ya no es así: la configuración
-- de Embedded Signup de la app de Cabbity (4722841751306607) se creó
-- desde la plantilla de WhatsApp de Meta, que fija tokens de **60
-- días** y no deja cambiarlo; el asistente manual, que sí ofrece
-- "Nunca", no lista "Cuentas de WhatsApp" como activo. Así que cada
-- número conectado por el diálogo dejaría de enviar a los 60 días si
-- nadie renovara el token.
--
-- Lo renueva el barrido de `GET /api/webhooks/cron`
-- (`src/lib/whatsapp/token-renewal.ts`): busca filas con
-- `token_expires_at` a menos de 14 días, pide a Meta un token nuevo
-- (`grant_type=fb_exchange_token`) y lo guarda cifrado. Estas columnas
-- son su memoria:
--
--   * `token_renewed_at`            — última renovación con éxito.
--     Diagnóstico: "¿se está renovando?" sin descifrar nada.
--   * `token_renewal_attempted_at`  — último intento, con o sin éxito.
--     Es lo que frena los reintentos: el barrido corre cada minuto y
--     sin esta marca un fallo de Meta se reintentaría 1 440 veces al
--     día durante dos semanas.
--   * `token_renewal_error`         — mensaje del último fallo, NULL
--     tras un éxito. Solo el `error.message` de Meta: nunca el token,
--     nunca la URL (lleva el secreto de la app).
--
-- Índice parcial sobre `token_expires_at`: la tabla es pequeña hoy,
-- pero el barrido pasa cada minuto y el predicado `IS NOT NULL` deja
-- fuera todas las filas manuales (que son la mayoría en una instancia
-- autoalojada) sin costar nada en las inserciones.
--
-- Lo que NO se toca: RLS (las políticas de la 017 siguen valiendo para
-- las columnas nuevas: el barrido usa el rol de servicio), ninguna
-- restricción, ningún estado. Un token que ya caducó sin renovarse no
-- cambia `status`: el remedio es reconectar el número, y eso ya
-- consume el mismo camino de siempre (upsert idempotente de la 054).
--
-- Idempotente: solo ADD COLUMN / CREATE INDEX IF NOT EXISTS.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS token_renewed_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS token_renewal_attempted_at TIMESTAMPTZ;

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS token_renewal_error TEXT;

CREATE INDEX IF NOT EXISTS whatsapp_config_token_expires_idx
  ON whatsapp_config (token_expires_at)
  WHERE token_expires_at IS NOT NULL;

COMMENT ON COLUMN whatsapp_config.token_expires_at IS
  'Vencimiento del access_token según Meta. NULL cuando el intercambio no devuelve `expires_in` (configuraciones con caducidad "Nunca"). Con la configuración actual de Cabbity son 60 días y el barrido del cron lo renueva antes (067).';
COMMENT ON COLUMN whatsapp_config.token_renewed_at IS
  'Última renovación del access_token con éxito (barrido de /api/webhooks/cron). NULL si nunca se renovó.';
COMMENT ON COLUMN whatsapp_config.token_renewal_attempted_at IS
  'Último intento de renovación, con o sin éxito. El barrido no reintenta una fila hasta 6 horas después de esta marca.';
COMMENT ON COLUMN whatsapp_config.token_renewal_error IS
  'Mensaje de Meta del último intento fallido de renovación; NULL tras un éxito. Nunca contiene el token.';
