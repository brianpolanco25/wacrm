-- ============================================================
-- 066_ai_provider_gemini.sql — Google Gemini como tercer proveedor de IA
--
-- p8.3, pedido y autorizado por el humano el 2026-09-23. El asistente de
-- IA (borrador, auto-respuesta, playground) ya hablaba con OpenAI y
-- Anthropic; la app añade Gemini (`generateContent`) y las dos tablas que
-- guardan el proveedor tienen que aceptarlo:
--
--   * ai_configs.provider   — el proveedor elegido por la cuenta (029).
--   * ai_usage_log.provider — el proveedor que gastó los tokens (033).
--
-- Los CHECK se crearon inline en el CREATE TABLE, así que Postgres les
-- puso el nombre por defecto `<tabla>_<columna>_check`; comprobado contra
-- una base limpia (pg_constraint) antes de escribir esto:
-- `ai_configs_provider_check` y `ai_usage_log_provider_check`.
--
-- Idempotente: DROP IF EXISTS + ADD. Las filas existentes solo pueden
-- tener 'openai' o 'anthropic', que siguen dentro del dominio, así que la
-- validación del nuevo CHECK no puede fallar.
-- ============================================================

ALTER TABLE ai_configs DROP CONSTRAINT IF EXISTS ai_configs_provider_check;
ALTER TABLE ai_configs
  ADD CONSTRAINT ai_configs_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));

ALTER TABLE ai_usage_log DROP CONSTRAINT IF EXISTS ai_usage_log_provider_check;
ALTER TABLE ai_usage_log
  ADD CONSTRAINT ai_usage_log_provider_check
  CHECK (provider IN ('openai', 'anthropic', 'gemini'));
