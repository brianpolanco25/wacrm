-- ============================================================
-- 068_embeddings_provider.sql — Gemini como proveedor de embeddings
--
-- Pedido por el humano el 2026-09-25: quiere la opción más barata para
-- la búsqueda semántica de la base de conocimiento, y la API de
-- embeddings de Gemini tiene capa gratuita. Hasta aquí
-- `ai_configs.embeddings_api_key` (030) era siempre una clave de OpenAI
-- (`text-embedding-3-small`), fuera cual fuera el proveedor de chat.
--
-- Esta columna dice de quién es esa clave. Por defecto 'openai' y NOT
-- NULL: todas las filas existentes con clave son de OpenAI, así que el
-- DEFAULT las deja exactamente como estaban.
--
-- Lo que NO cambia: `ai_knowledge_chunks.embedding` sigue siendo
-- `vector(1536)` (030). Gemini se pide con `outputDimensionality: 1536`
-- para caber en la misma columna. Los vectores de un proveedor NO son
-- comparables con los del otro: al cambiar de proveedor hay que
-- reindexar (botón "Reindexar" de Ajustes → IA → Base de conocimiento),
-- y la app lo avisa. No se borran vectores aquí: una migración no debe
-- decidir por la cuenta cuándo pagar (o gastar cupo) en reembeber.
--
-- Idempotente: ADD COLUMN IF NOT EXISTS y DO para el CHECK.
-- ============================================================

ALTER TABLE ai_configs
  ADD COLUMN IF NOT EXISTS embeddings_provider TEXT NOT NULL DEFAULT 'openai';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.ai_configs'::regclass
      AND conname = 'ai_configs_embeddings_provider_check'
  ) THEN
    ALTER TABLE ai_configs
      ADD CONSTRAINT ai_configs_embeddings_provider_check
      CHECK (embeddings_provider IN ('openai', 'gemini'));
  END IF;
END
$$;

COMMENT ON COLUMN ai_configs.embeddings_provider IS
  'Proveedor al que pertenece embeddings_api_key: openai (text-embedding-3-small) o gemini (gemini-embedding-2 a 1536 dimensiones). Cambiarlo exige reindexar la base de conocimiento.';
