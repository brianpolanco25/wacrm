-- ============================================================
-- 047_ai_platform_key.sql — Fase 0 (SaaS): supuesto S1 confirmado
--
-- «La IA la paga el servicio». La clave del proveedor de modelos puede
-- venir ahora de la plataforma (AI_PLATFORM_OPENAI_API_KEY /
-- AI_PLATFORM_ANTHROPIC_API_KEY, variables de servidor), así que una
-- cuenta ya no está obligada a traer la suya. El código resuelve en este
-- orden: clave propia de la cuenta → clave de plataforma → IA no
-- configurada (ver `src/lib/ai/platform-key.ts`).
--
-- Dos cambios de esquema:
--
-- 1. `ai_configs.api_key` deja de ser NOT NULL. Se guarda NULL —no
--    cadena vacía— cuando la cuenta usa la clave de la plataforma, para
--    que «sin clave propia» y «clave vacía por error» sigan siendo
--    distinguibles.
-- 2. `ai_usage_log.key_source` dice quién pagó cada llamada: la cuenta
--    con su clave ('account') o la plataforma ('platform'). Sin esta
--    columna el consumo que financia el servicio es indistinguible del
--    BYO y la fase 3 no puede facturarlo. Las filas anteriores a S1 son
--    todas BYO por construcción (la columna era NOT NULL), así que el
--    DEFAULT 'account' las clasifica correctamente y no hay backfill.
--
-- Este cambio vivía en 041_billing_model.sql; sale de ahí porque
-- pertenece al apartado 4 del spec (decisión S1), no al modelo de
-- facturación del apartado 2.
--
-- Idempotente — safe to re-run: DROP NOT NULL es no-op si la columna ya
-- es nullable, ADD COLUMN lleva IF NOT EXISTS, y los bloques solo actúan
-- si la tabla existe.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.ai_configs') IS NOT NULL THEN
    ALTER TABLE public.ai_configs ALTER COLUMN api_key DROP NOT NULL;
  END IF;

  IF to_regclass('public.ai_usage_log') IS NOT NULL THEN
    -- NOT NULL con DEFAULT: toda fila —vieja o nueva— dice de quién era
    -- la clave. El CHECK deja el dominio cerrado, igual que `mode` y
    -- `provider` en 033.
    ALTER TABLE public.ai_usage_log
      ADD COLUMN IF NOT EXISTS key_source text NOT NULL DEFAULT 'account';

    ALTER TABLE public.ai_usage_log
      DROP CONSTRAINT IF EXISTS ai_usage_log_key_source_check;
    ALTER TABLE public.ai_usage_log
      ADD CONSTRAINT ai_usage_log_key_source_check
      CHECK (key_source IN ('account', 'platform'));

    -- El consumo se agrega siempre por cuenta; separarlo por quién puso
    -- la clave es justo la consulta que necesita la facturación de la
    -- fase 3 («cuánto le costé a la plataforma este mes»).
    CREATE INDEX IF NOT EXISTS idx_ai_usage_log_account_source_created
      ON public.ai_usage_log(account_id, key_source, created_at DESC);
  END IF;
END
$$;
