-- ============================================================
-- 053 — Varios números de WhatsApp por empresa (fase 4 §1, f4.2)
--
-- La 017 puso `UNIQUE(account_id)` sobre `whatsapp_config`: una
-- empresa, un número. El plan Negocio se vende con varios, así que
-- esa restricción se retira y la relación pasa a ser uno-a-varios.
--
-- Lo que NO se toca, a propósito:
--
--   * `whatsapp_config_phone_number_id_key` (UNIQUE global de la 013).
--     Es lo que garantiza que el webhook resuelva un único dueño por
--     `phone_number_id`. Sin él, un entrante sería ambiguo entre dos
--     cuentas y `processMessage` lo descartaría (issue #136).
--   * El índice único `(account_id, contact_id)` de la 036. Un
--     contacto que escribe a dos números de la misma empresa sigue
--     teniendo UNA conversación; partirla reintroduciría la
--     ambigüedad de lectura que la 036 arregló (issue #363).
--   * Las políticas RLS de la 017, que filtran por
--     `is_account_member(account_id)` y no por unicidad.
--
-- Idempotente: todo va con IF NOT EXISTS / IF EXISTS y el relleno es
-- re-ejecutable.
-- ============================================================

-- ------------------------------------------------------------
-- 1. Retirar el UNIQUE(account_id) de la 017.
-- ------------------------------------------------------------
ALTER TABLE whatsapp_config
  DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- ------------------------------------------------------------
-- 2. Unicidad del par (cuenta, número).
--
-- En garantía es redundante con el UNIQUE global de la 013 — si un
-- `phone_number_id` solo puede estar una vez en toda la tabla, tampoco
-- puede repetirse dentro de una cuenta. Hace falta igual por dos
-- razones y ninguna es decorativa:
--
--   a) es el destino de `ON CONFLICT` del upsert con el que f4.1
--      (registro integrado) persiste la fila de forma idempotente;
--      Postgres exige un índice único sobre EXACTAMENTE esas columnas.
--   b) expresa la invariante en la forma en que la lee el código.
--
-- No lo "simplifiques" borrándolo porque la 013 ya lo cubre.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_account_phone_key
  ON whatsapp_config(account_id, phone_number_id);

-- ------------------------------------------------------------
-- 3. Columnas nuevas.
-- ------------------------------------------------------------
-- El número por el que se envía cuando nadie elige y la conversación
-- no lo sabe (conversaciones anteriores a esta migración, envíos por
-- contacto sin hilo previo, difusiones sin selector).
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT FALSE;

-- Metadatos que Meta devuelve en `verifyPhoneNumber` y que la lista de
-- números necesita para ser legible. Hasta ahora se pedían a Meta en
-- cada carga de Ajustes; con n números eso serían n llamadas.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS display_phone_number TEXT;
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS verified_name TEXT;

-- Nombre que pone la empresa («Ventas», «Soporte»). La UI cae de
-- vuelta a verified_name → display_phone_number → phone_number_id.
ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS label TEXT;

-- ------------------------------------------------------------
-- 4. Un solo predeterminado por cuenta, garantizado por la base.
--
-- Índice PARCIAL: solo indexa las filas con is_default, así que no
-- estorba a las demás. Que sea la base y no la aplicación quien lo
-- garantice importa porque «hacer predeterminado» son dos escrituras
-- (limpiar las otras, marcar esta) y dos admins a la vez podrían
-- dejar dos.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS whatsapp_config_one_default_per_account
  ON whatsapp_config(account_id) WHERE is_default;

-- ------------------------------------------------------------
-- 5. Relleno: la fila más antigua de cada cuenta pasa a predeterminada.
--
-- Antes de esta migración había como mucho una por cuenta, así que
-- `DISTINCT ON` elige justo esa. Re-ejecutar no hace nada: el WHERE
-- ya excluye las que están marcadas, y el índice parcial rechazaría
-- una segunda.
-- ------------------------------------------------------------
UPDATE whatsapp_config
SET is_default = TRUE
WHERE is_default = FALSE
  AND id IN (
    SELECT DISTINCT ON (account_id) id
    FROM whatsapp_config
    ORDER BY account_id, created_at ASC, id ASC
  )
  AND account_id NOT IN (
    SELECT account_id FROM whatsapp_config WHERE is_default
  );

-- ------------------------------------------------------------
-- 6. El número por el que va cada conversación y cada difusión.
--
-- `ON DELETE SET NULL`, NUNCA CASCADE: desconectar un número no puede
-- borrar las conversaciones ni las campañas del cliente. Con NULL, el
-- resolvedor cae al predeterminado (conversaciones) o falla con
-- `whatsapp_not_configured` nombrando la causa (difusiones al
-- reanudar), que es recuperable; borrar el historial no lo es.
-- ------------------------------------------------------------
ALTER TABLE conversations
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_conversations_whatsapp_config
  ON conversations(whatsapp_config_id);

ALTER TABLE broadcasts
  ADD COLUMN IF NOT EXISTS whatsapp_config_id UUID
  REFERENCES whatsapp_config(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_broadcasts_whatsapp_config
  ON broadcasts(whatsapp_config_id);

-- ------------------------------------------------------------
-- 7. Relleno de las dos columnas anteriores con el predeterminado.
--
-- Seguro porque antes de esta migración cada cuenta tenía como mucho
-- un número: el predeterminado ES el número por el que salió todo lo
-- histórico. Idempotente por el `IS NULL`.
-- ------------------------------------------------------------
UPDATE conversations c
SET whatsapp_config_id = w.id
FROM whatsapp_config w
WHERE w.account_id = c.account_id
  AND c.whatsapp_config_id IS NULL
  AND w.is_default;

UPDATE broadcasts b
SET whatsapp_config_id = w.id
FROM whatsapp_config w
WHERE w.account_id = b.account_id
  AND b.whatsapp_config_id IS NULL
  AND w.is_default;

COMMENT ON COLUMN whatsapp_config.is_default IS
  'Número por el que se envía cuando el llamante no elige y la conversación no lo sabe. Uno por cuenta (índice parcial whatsapp_config_one_default_per_account).';
COMMENT ON COLUMN conversations.whatsapp_config_id IS
  'Número por el que va este hilo. Se sella con el número al que escribió el cliente en cada entrante. NULL = usar el predeterminado de la cuenta.';
COMMENT ON COLUMN broadcasts.whatsapp_config_id IS
  'Número con el que se lanzó la campaña. Reanudar usa ESTE, nunca el predeterminado: cambiar de remitente a media campaña rompe la ventana de 24 h y degrada la calidad de los dos números.';
