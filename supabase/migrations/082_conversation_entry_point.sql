-- ============================================================
-- 082_conversation_entry_point.sql — Fase 11 (p11.6 `free-entry-point-badge`)
--
-- Punto de entrada de la conversación: si el cliente escribió desde un
-- anuncio Click to WhatsApp (CTWA), el entrante trae `referral` y Meta
-- abre una ventana de 72 h en la que no cobra los mensajes del negocio.
-- La bandeja lo avisa ANTES de responder con la insignia «Ventana gratis
-- hasta …» (el `pricing.type = 'free_entry_point'` de `message_charges`
-- llega después de enviar, en el estado de entrega).
--
--   entry_point_source    ctwa_ad | ctwa_organic | ctwa_other
--   entry_point_at        cuándo entró (timestamp del mensaje)
--   free_window_until     fin de la ventana gratis (entrada + 72 h) o NULL
--   entry_point_referral  lista blanca del referral (source_type,
--                         source_id, source_url, headline, ctwa_clid),
--                         cadenas de <= 500 caracteres
--
-- Por qué en `conversations` y no en `messages`
--   - La insignia es de la conversación y la lista de la bandeja no carga
--     mensajes. `conversations` es una fila por contacto y cuenta (036),
--     así que la última entrada por anuncio es justo el estado a mostrar.
--   - `messages` es la tabla más caliente del entrante.
--
-- CP11 (el webhook toca `conversations` en cada entrante)
--   - Columnas anulables SIN DEFAULT: Postgres no reescribe la tabla.
--   - CHECK `NOT VALID`: todas las filas previas son NULL, no hay nada que
--     validar, y validarlo recorrería la tabla con lock. Las filas nuevas
--     y las actualizadas sí se comprueban.
--   - `lock_timeout = 5s`, como en la 075: si hay una transacción larga,
--     la migración falla en vez de dejar en cola al webhook. Reintentar
--     el `db push` es seguro (todo es idempotente).
--
-- RLS: no cambia (políticas de la 017). Sin disparador de guarda: el dato
-- solo pinta una insignia de la propia cuenta y no se factura con él.
--
-- Supuestos de Meta SIN verificar (specs/free-entry-point-badge/design.md)
--   S-E1 `messages[].referral` es un objeto con `source_type` ('ad'|'post').
--   S-E2 solo los anuncios (`ad`) abren la ventana gratis.
--   S-E3 la ventana dura 72 h desde el mensaje del cliente. Si fuera
--        menos, se baja aquí el CHECK y `FREE_WINDOW_HOURS` en código.
-- ============================================================

SET lock_timeout = '5s';

ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_source   TEXT;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_at       TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS free_window_until    TIMESTAMPTZ;
ALTER TABLE conversations ADD COLUMN IF NOT EXISTS entry_point_referral JSONB;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.conversations'::regclass
                   AND conname = 'conversations_entry_point_source_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_entry_point_source_check
      CHECK (entry_point_source IS NULL
             OR entry_point_source IN ('ctwa_ad', 'ctwa_organic', 'ctwa_other')) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.conversations'::regclass
                   AND conname = 'conversations_free_window_check') THEN
    ALTER TABLE conversations ADD CONSTRAINT conversations_free_window_check
      CHECK (free_window_until IS NULL
             OR (entry_point_at IS NOT NULL
                 AND free_window_until <= entry_point_at + interval '72 hours')) NOT VALID;
  END IF;
END
$$;

RESET lock_timeout;
