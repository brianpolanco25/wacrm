-- ============================================================
-- 040_conversation_assignment_integrity.sql — Fase 0 (SaaS)
--
-- `conversations.assigned_agent_id` se creó en 001_initial_schema.sql
-- como `UUID` a secas: sin `REFERENCES`, sin índice. Dos consecuencias
-- reales:
--
--   - Al expulsar a un operador de la empresa, sus conversaciones
--     quedan apuntando a un usuario que ya no existe. La interfaz
--     muestra «Asignado» sin nombre y no hay forma de reasignarlas en
--     bloque.
--   - Cualquier consulta del tipo «mis chats» o «chats sin asignar»
--     hace recorrido de tabla.
--
-- Esta migración:
--
--   1. Limpia las referencias huérfanas (assigned_agent_id que no
--      existe en auth.users) poniéndolas a NULL. Hay que hacerlo ANTES
--      de imponer la restricción o el ADD CONSTRAINT falla.
--   2. Añade la FK a auth.users(id) con ON DELETE SET NULL — y no
--      CASCADE: borrar a un operador NUNCA puede borrar conversaciones
--      de clientes. La conversación vuelve a la cola sin asignar, que
--      es el comportamiento correcto.
--   3. Crea el índice compuesto (account_id, assigned_agent_id). La
--      consulta caliente es "conversaciones de esta empresa por
--      asignado", incluida la variante "sin asignar"
--      (assigned_agent_id IS NULL).
--
-- No cambia ningún comportamiento visible de la aplicación.
--
-- Idempotente — safe to re-run: el UPDATE no encuentra nada la
-- segunda vez, la constraint se suelta y se vuelve a crear, el índice
-- lleva IF NOT EXISTS.
-- ============================================================

-- 1. Limpiar referencias huérfanas antes de imponer la restricción.
UPDATE conversations c
   SET assigned_agent_id = NULL
 WHERE c.assigned_agent_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM auth.users u WHERE u.id = c.assigned_agent_id);

-- 2. FK a auth.users con ON DELETE SET NULL.
ALTER TABLE conversations
  DROP CONSTRAINT IF EXISTS conversations_assigned_agent_id_fkey;

ALTER TABLE conversations
  ADD CONSTRAINT conversations_assigned_agent_id_fkey
  FOREIGN KEY (assigned_agent_id) REFERENCES auth.users(id) ON DELETE SET NULL;

-- 3. Índice para "conversaciones de esta empresa por asignado".
CREATE INDEX IF NOT EXISTS idx_conversations_account_assignee
  ON conversations(account_id, assigned_agent_id);
