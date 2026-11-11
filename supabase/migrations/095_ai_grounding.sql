-- ============================================================
-- 095 — IA con disponibilidad fundamentada (n13.7
-- `ai-grounded-availability`).
--
-- 092 reservada por n13.2 (flows); 096 la usa n15.1 en paralelo.
--
--   account_integrations.ai_live_reads  lecturas en vivo (operaciones GET
--       del catálogo con parámetros fijos y plantillas {{today}} /
--       {{today+Nd}}) que el sistema ejecuta ANTES de cada turno de IA y
--       cuyo resultado entra en el system prompt. Como mucho 3 (D8).
--   integration_operations.ai_policy    política de IA de una operación:
--       {"grounds": ["schedule"], "requires_prior": [["k1","k2"],["k3"]]}.
--       La forma fina la valida `validateOperationInput`; aquí solo que
--       sea un objeto.
--   integration_calls.conversation_id   conversación de una llamada de IA
--       en respuesta automática, para la guardia de operaciones
--       destructivas (evidencia de turnos anteriores). ON DELETE SET NULL:
--       borrar la conversación no borra el registro de llamadas.
--   integration_calls.ai_preload        true en las lecturas en vivo, que
--       nunca cuentan como evidencia (D5).
--
-- RLS sin cambios: las tres tablas siguen sin políticas (solo rol de
-- servicio). Idempotente: ADD COLUMN IF NOT EXISTS, índice IF NOT EXISTS
-- y CHECK con guarda.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE public.account_integrations
  ADD COLUMN IF NOT EXISTS ai_live_reads jsonb NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE public.integration_operations
  ADD COLUMN IF NOT EXISTS ai_policy jsonb;

ALTER TABLE public.integration_calls
  ADD COLUMN IF NOT EXISTS conversation_id uuid
    REFERENCES public.conversations(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS ai_preload boolean NOT NULL DEFAULT false;

CREATE INDEX IF NOT EXISTS integration_calls_conversation_idx
  ON public.integration_calls (account_id, conversation_id, created_at)
  WHERE conversation_id IS NOT NULL;

RESET lock_timeout;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.account_integrations'::regclass
                   AND conname = 'account_integrations_ai_live_reads_shape') THEN
    ALTER TABLE public.account_integrations
      ADD CONSTRAINT account_integrations_ai_live_reads_shape
      CHECK (jsonb_typeof(ai_live_reads) = 'array'
             AND jsonb_array_length(ai_live_reads) <= 3);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.integration_operations'::regclass
                   AND conname = 'integration_operations_ai_policy_shape') THEN
    ALTER TABLE public.integration_operations
      ADD CONSTRAINT integration_operations_ai_policy_shape
      CHECK (ai_policy IS NULL OR jsonb_typeof(ai_policy) = 'object');
  END IF;
END
$$;
