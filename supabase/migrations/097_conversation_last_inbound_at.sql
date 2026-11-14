-- ============================================================
-- 097 — conversations.last_inbound_at (n15.5 cabbity-health-chat-api)
--
-- Momento del último mensaje ENTRANTE de la conversación. Con él la API
-- pública calcula la ventana de servicio de 24 h de WhatsApp
-- (`service_window_expires_at = last_inbound_at + 24 h`) sin recorrer el
-- historial de mensajes en cada listado.
--
-- Se mantiene dentro de `bump_conversation_on_inbound` (la misma
-- sentencia que ya sube `unread_count`), así que el webhook de Meta no
-- cambia y una repetición de entrega (que no llega a esa función) no lo
-- mueve. Relleno inicial desde `messages`. Idempotente.
-- ============================================================

ALTER TABLE public.conversations
  ADD COLUMN IF NOT EXISTS last_inbound_at TIMESTAMPTZ;

UPDATE public.conversations c
SET last_inbound_at = m.last_inbound
FROM (
  SELECT conversation_id, MAX(created_at) AS last_inbound
  FROM public.messages
  WHERE sender_type = 'customer'
  GROUP BY conversation_id
) m
WHERE m.conversation_id = c.id
  AND c.last_inbound_at IS NULL;

CREATE OR REPLACE FUNCTION public.bump_conversation_on_inbound(
  p_conversation_id UUID,
  p_last_message_text TEXT
)
RETURNS VOID
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  UPDATE conversations
  SET unread_count      = COALESCE(unread_count, 0) + 1,
      last_message_text = p_last_message_text,
      last_message_at   = NOW(),
      last_inbound_at   = NOW(),
      updated_at        = NOW()
  WHERE id = p_conversation_id;
$$;

REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM anon;
REVOKE ALL ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.bump_conversation_on_inbound(UUID, TEXT) TO service_role;

-- Listado por última actividad (`sort=last_activity`): cuenta + orden.
CREATE INDEX IF NOT EXISTS idx_conversations_account_last_message
  ON public.conversations (account_id, last_message_at DESC, id DESC);
