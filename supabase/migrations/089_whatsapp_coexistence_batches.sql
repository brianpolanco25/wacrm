-- ============================================================
-- 089 — Lotes de coexistencia: historial y libreta del teléfono (#1651).
--
-- Un número en coexistencia (088, #1650) recibe por webhook el historial
-- del chat (`history`, por fases y chunks desordenados, miles de mensajes
-- por entrega) y la libreta de contactos (`smb_app_state_sync`). Meta ya
-- tiene su 200 cuando el webhook procesa en `after()`, no reintenta, y
-- `smb_app_data` solo se puede pedir una vez: lo que no quepa en los 60 s
-- de la función se perdería. Por eso cada elemento se CAPTURA aquí antes
-- de procesar nada, y se drena por tramos con un cursor:
--
--   - el propio webhook, dentro del `after()`, con plazo de 45 s;
--   - el resto, `GET /api/whatsapp/coexistence/cron` (AUTOMATION_CRON_SECRET).
--
-- Columnas
--   field         'history' | 'smb_app_state_sync'.
--   sync_epoch    `whatsapp_config.coexistence_onboarded_at` al encolar
--                 (NULL si no lo hay): separa una reconexión de la anterior.
--   phase, chunk_order, progress   metadatos del chunk de historial
--                 (NULL en la libreta).
--   payload       los hilos o los contactos tal como llegaron; NULL al
--                 terminar el lote. Es dato de negocio (como `messages`).
--   item_count    hilos o contactos del lote; cursor = cuántos van hechos.
--   status        pending → processing (reclamado, locked_until) → done |
--                 failed (tras 5 intentos, last_error sin contenido).
--
-- Unicidad: un chunk de historial (whatsapp_config_id, sync_epoch,
--   phase, chunk_order) se encola una sola vez; la libreta no lleva índice único
--   (repetirla es inocuo: `add` es idempotente por teléfono).
--
-- RLS: activada y sin políticas; ni `anon` ni `authenticated` la leen ni
--   escriben. Solo el rol de servicio (webhook y cron), filtrando por
--   `account_id`.
--
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS whatsapp_coexistence_batches (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id         uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_config_id uuid NOT NULL REFERENCES whatsapp_config(id) ON DELETE CASCADE,
  field              text NOT NULL
    CHECK (field IN ('history', 'smb_app_state_sync')),
  sync_epoch         timestamptz,
  phase              smallint,
  chunk_order        integer,
  progress           smallint,
  payload            jsonb,
  item_count         integer NOT NULL DEFAULT 0,
  cursor             integer NOT NULL DEFAULT 0,
  status             text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  attempts           smallint NOT NULL DEFAULT 0,
  last_error         text,
  locked_until       timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  processed_at       timestamptz
);

-- Por si una base de desarrollo aplicó una versión anterior de este
-- archivo sin la columna.
ALTER TABLE whatsapp_coexistence_batches ADD COLUMN IF NOT EXISTS sync_epoch timestamptz;

RESET lock_timeout;

-- R37: un chunk de historial por número, época de sincronización, fase
-- y orden. `sync_epoch` es el `coexistence_onboarded_at` (088) vigente al
-- encolar: tras un PARTNER_REMOVED y un nuevo signup sobre la misma fila,
-- la sincronización nueva es otra época y sus chunks no chocan con los
-- lotes `done` de la anterior; las reentregas de Meta de la misma
-- sincronización siguen deduplicando. NULLS NOT DISTINCT (Postgres 15+,
-- como la 084): un chunk sin época, `phase` o `chunk_order` también se
-- encola una sola vez, incluso si dos entregas compiten (la segunda
-- recibe 23505 y se trata como repetición).
CREATE UNIQUE INDEX IF NOT EXISTS idx_wcb_history_chunk
  ON whatsapp_coexistence_batches (whatsapp_config_id, sync_epoch, phase, chunk_order)
  NULLS NOT DISTINCT
  WHERE field = 'history';

-- El barrido del cron: pendientes por antigüedad.
CREATE INDEX IF NOT EXISTS idx_wcb_pending
  ON whatsapp_coexistence_batches (created_at)
  WHERE status IN ('pending', 'processing');

ALTER TABLE whatsapp_coexistence_batches ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON whatsapp_coexistence_batches FROM anon, authenticated;
GRANT ALL ON whatsapp_coexistence_batches TO service_role;

COMMENT ON TABLE whatsapp_coexistence_batches IS
  'Lotes de coexistencia (#1651): cada chunk de historial (history) y cada '
  'entrega de libreta (smb_app_state_sync) del teléfono, capturados antes de '
  'procesarse y drenados por tramos con cursor por el webhook y por '
  '/api/whatsapp/coexistence/cron. Solo rol de servicio.';
COMMENT ON COLUMN whatsapp_coexistence_batches.payload IS
  'Hilos o contactos tal como llegaron de Meta; NULL al terminar el lote.';
COMMENT ON COLUMN whatsapp_coexistence_batches.cursor IS
  'Elementos ya procesados (hilos o contactos). El siguiente drenado sigue desde aquí.';
