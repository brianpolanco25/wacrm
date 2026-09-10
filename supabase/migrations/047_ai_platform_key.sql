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
-- Único cambio de esquema: `ai_configs.api_key` deja de ser NOT NULL.
-- Se guarda NULL —no cadena vacía— cuando la cuenta usa la clave de la
-- plataforma, para que «sin clave propia» y «clave vacía por error»
-- sigan siendo distinguibles.
--
-- Este cambio vivía en 041_billing_model.sql; sale de ahí porque
-- pertenece al apartado 4 del spec (decisión S1), no al modelo de
-- facturación del apartado 2.
--
-- Idempotente — safe to re-run: DROP NOT NULL es no-op si la columna ya
-- es nullable, y el bloque solo actúa si la tabla existe.
-- ============================================================

DO $$
BEGIN
  IF to_regclass('public.ai_configs') IS NOT NULL THEN
    ALTER TABLE public.ai_configs ALTER COLUMN api_key DROP NOT NULL;
  END IF;
END
$$;
