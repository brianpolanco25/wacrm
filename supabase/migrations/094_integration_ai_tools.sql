-- ============================================================
-- 094 — Herramientas de IA desde integraciones (n13.3
-- `integration-ai-tools`).
--
-- 092 reservada por n13.2 (flows); si al fusionar no existe, el hueco es
-- intencional. n13.5 trabaja en paralelo: si también necesita migración,
-- quien fusione segundo renumera (esta no depende del número).
--
-- `account_integrations` gana tres columnas que decide el admin de la
-- cuenta desde Ajustes → Integraciones:
--   ai_enabled       la IA de respuesta automática puede usar las
--                    operaciones de la integración como herramientas.
--                    Por defecto false: activar una integración NO la da
--                    a la IA (D1).
--   ai_instructions  instrucciones del negocio para la IA sobre esta
--                    integración (≤ 2000 caracteres, D7).
--   ai_timezone      zona IANA para que la IA mande fechas con el offset
--                    correcto (≤ 64 caracteres, D8). La validez IANA la
--                    comprueba la ruta; aquí solo la longitud.
--
-- RLS sin cambios: sigue activada y sin políticas (solo rol de servicio).
-- Idempotente: ADD COLUMN IF NOT EXISTS y CHECK con guarda.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.account_integrations
  ADD COLUMN IF NOT EXISTS ai_enabled boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS ai_instructions text,
  ADD COLUMN IF NOT EXISTS ai_timezone text;

RESET lock_timeout;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.account_integrations'::regclass
                   AND conname = 'account_integrations_ai_instructions_len') THEN
    ALTER TABLE public.account_integrations
      ADD CONSTRAINT account_integrations_ai_instructions_len
      CHECK (ai_instructions IS NULL OR char_length(ai_instructions) <= 2000);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.account_integrations'::regclass
                   AND conname = 'account_integrations_ai_timezone_len') THEN
    ALTER TABLE public.account_integrations
      ADD CONSTRAINT account_integrations_ai_timezone_len
      CHECK (ai_timezone IS NULL OR char_length(ai_timezone) BETWEEN 1 AND 64);
  END IF;
END
$$;
