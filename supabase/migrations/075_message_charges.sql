-- ============================================================
-- 075_message_charges.sql — Fase 10 (s10.1 `meta-pricing-capture`)
--
-- Lo que Meta dice que cobra por cada mensaje saliente, tal como llega
-- en el objeto `pricing` de los webhooks de estado (`sent`, `delivered`):
--   {"billable":true,"pricing_model":"PMP","category":"marketing","type":"regular"}
-- Es la fuente del corte mensual (s10.4) y del panel de consumo (s10.5).
--
-- Por qué una tabla propia y no columnas en `messages`
--   - Las difusiones NO escriben en `messages` (solo en
--     `broadcast_recipients`) y son el grueso del consumo de marketing.
--     Esta tabla une los dos orígenes: `message_id` o
--     `broadcast_recipient_id`, y cualquiera de los dos puede faltar (un
--     `sent` que le gana a la inserción del mensaje; un envío hecho fuera
--     del CRM con el mismo número).
--   - `messages` no tiene `delivered_at` ni `whatsapp_config_id` (la 053
--     los puso en `conversations` y `broadcasts`), y el número de una
--     conversación se vuelve a sellar cuando el cliente escribe a otro.
--     Aquí `whatsapp_config_id` es el número por el que llegó el estado,
--     o sea el que envió, y queda fijo.
--   - CP11: no se altera `messages`. Las dos claves foráneas toman un
--     lock SHARE ROW EXCLUSIVE sobre `messages` y `broadcast_recipients`
--     solo durante el CREATE TABLE (la tabla nueva está vacía y no hay que
--     validar nada), y `lock_timeout` hace que, si hay una transacción
--     larga, la migración falle en 5 s en vez de dejar en cola a los
--     INSERT del webhook entrante. Reintentar el `db push` es seguro.
--     Sin CONCURRENTLY: el `db push` corre cada archivo en una
--     transacción (mismo criterio que la 064), y la tabla es nueva.
--
-- Contenido
--   - `pricing_category` es texto libre y NOT NULL: una fila existe porque
--     Meta mandó categoría. Meta añade categorías (`marketing_lite`,
--     `referral_conversion`, variantes con guion) y un CHECK haría fallar
--     justo lo que hay que facturar; la lista conocida vive en código
--     (`src/lib/whatsapp/message-charges.ts`).
--   - `wamid` es UNIQUE en toda la tabla. Meta no garantiza que sea único
--     entre números (009), así que la función de escritura nunca toca una
--     fila de OTRA cuenta: el ON CONFLICT lleva `WHERE account_id = …`
--     (CP3) y devuelve `foreign` para que la app lo registre.
--   - `status` solo avanza (sent < delivered < read; `failed` solo desde
--     nada o `sent`): un `delivered` tardío no deshace un `read`.
--   - `delivered_at` es el primer momento en que se supo entregado: lo
--     fija `delivered`, o `read` si `delivered` no llegó (leído implica
--     entregado), y un `delivered` posterior y anterior en el tiempo lo
--     adelanta (LEAST). Es la columna por la que cuenta el corte.
--   - Nada se pisa con NULL: precio, referencias y teléfono se rellenan
--     solo si faltaban (COALESCE con lo existente primero).
--   - Lo anterior a esta migración no se reconstruye: no hay dato.
--
-- Borrado
--   `message_id` / `broadcast_recipient_id` / `whatsapp_config_id` con
--   ON DELETE SET NULL: la fila de cobro sobrevive al borrado del mensaje,
--   de la difusión o del número (Meta ya cobró). `account_id` en CASCADE,
--   como el resto de tablas de la cuenta.
--
-- RLS
--   SELECT para admin+ de la cuenta vía `can_read_account` (057: también
--   visible en una sesión de soporte). Escritura solo `service_role`: sin
--   políticas de INSERT/UPDATE/DELETE y sin privilegios para
--   anon/authenticated.
--
-- Idempotente — se puede re-ejecutar.
-- ============================================================

SET lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS message_charges (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id             uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  whatsapp_config_id     uuid REFERENCES whatsapp_config(id) ON DELETE SET NULL,
  wamid                  text NOT NULL,
  message_id             uuid REFERENCES messages(id) ON DELETE SET NULL,
  broadcast_recipient_id uuid REFERENCES broadcast_recipients(id) ON DELETE SET NULL,
  recipient_phone        text,
  pricing_category       text NOT NULL,
  pricing_billable       boolean,
  pricing_type           text,
  pricing_model          text,
  status                 text,
  sent_at                timestamptz,
  delivered_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_charges_wamid_key UNIQUE (wamid),
  CONSTRAINT message_charges_status_check
    CHECK (status IS NULL OR status IN ('sent', 'delivered', 'read', 'failed')),
  CONSTRAINT message_charges_category_check
    CHECK (length(btrim(pricing_category)) > 0)
);

RESET lock_timeout;

-- El corte (s10.4): entregados de una cuenta en un periodo, por orden de
-- entrega.
CREATE INDEX IF NOT EXISTS message_charges_account_delivered_idx
  ON message_charges (account_id, delivered_at);

-- El panel por número (s10.5) y la cuota gratis de servicio por número.
CREATE INDEX IF NOT EXISTS message_charges_config_delivered_idx
  ON message_charges (whatsapp_config_id, delivered_at);

-- Las dos claves foráneas con SET NULL: sin índice, borrar una
-- conversación (CASCADE sobre sus mensajes) recorrería esta tabla entera
-- por cada mensaje borrado.
CREATE INDEX IF NOT EXISTS message_charges_message_idx
  ON message_charges (message_id) WHERE message_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS message_charges_broadcast_recipient_idx
  ON message_charges (broadcast_recipient_id)
  WHERE broadcast_recipient_id IS NOT NULL;

ALTER TABLE message_charges ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS message_charges_select ON message_charges;
CREATE POLICY message_charges_select ON message_charges FOR SELECT
  USING (can_read_account(account_id, 'admin'));

-- Sin políticas de escritura a propósito, y además sin privilegio: un JWT
-- de usuario no puede fabricar ni alterar un cobro.
REVOKE INSERT, UPDATE, DELETE, TRUNCATE ON message_charges FROM anon, authenticated;

COMMENT ON TABLE message_charges IS
  'Lo que Meta cobra por cada mensaje saliente (objeto pricing del webhook '
  'de estados), de conversaciones y de difusiones. Fuente del corte '
  'mensual y del panel de consumo (migración 075). Escribe solo '
  'record_message_charge con service_role.';

-- ------------------------------------------------------------
-- Escalera de estados: el siguiente estado dado el actual y el entrante.
-- Desconocido = no cambia. `failed` es terminal y solo llega desde nada o
-- `sent`.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.message_charge_next_status(
  current_status text,
  incoming_status text
) RETURNS text
LANGUAGE sql
IMMUTABLE
SET search_path = public
AS $$
  SELECT CASE
    WHEN incoming_status IS NULL
      OR incoming_status NOT IN ('sent', 'delivered', 'read', 'failed')
      THEN current_status
    WHEN current_status IS NULL THEN incoming_status
    WHEN current_status = 'failed' THEN current_status
    WHEN incoming_status = 'failed' THEN
      CASE WHEN current_status = 'sent' THEN 'failed' ELSE current_status END
    WHEN array_position(ARRAY['sent', 'delivered', 'read'], incoming_status)
       > array_position(ARRAY['sent', 'delivered', 'read'], current_status)
      THEN incoming_status
    ELSE current_status
  END;
$$;

-- ------------------------------------------------------------
-- La única vía de escritura. Con categoría: INSERT … ON CONFLICT (wamid)
-- DO UPDATE que solo rellena y avanza. Sin categoría (un `read` sin
-- pricing): solo avanza una fila que ya exista; nunca crea.
-- Devuelve 'inserted' | 'updated' | 'skipped' (sin fila que avanzar) |
-- 'foreign' (el wamid es de otra cuenta: no se toca).
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.record_message_charge(
  p_account_id uuid,
  p_wamid text,
  p_status text,
  p_event_at timestamptz,
  p_whatsapp_config_id uuid DEFAULT NULL,
  p_message_id uuid DEFAULT NULL,
  p_broadcast_recipient_id uuid DEFAULT NULL,
  p_recipient_phone text DEFAULT NULL,
  p_pricing_category text DEFAULT NULL,
  p_pricing_billable boolean DEFAULT NULL,
  p_pricing_type text DEFAULT NULL,
  p_pricing_model text DEFAULT NULL
) RETURNS text
LANGUAGE plpgsql
SET search_path = public
AS $$
DECLARE
  v_status text := CASE
    WHEN p_status IN ('sent', 'delivered', 'read', 'failed') THEN p_status
  END;
  v_sent_at timestamptz := CASE WHEN v_status = 'sent' THEN p_event_at END;
  v_delivered_at timestamptz :=
    CASE WHEN v_status IN ('delivered', 'read') THEN p_event_at END;
  v_inserted boolean;
BEGIN
  IF p_account_id IS NULL OR p_wamid IS NULL OR btrim(p_wamid) = '' THEN
    RETURN 'skipped';
  END IF;

  IF p_pricing_category IS NULL OR btrim(p_pricing_category) = '' THEN
    UPDATE message_charges mc SET
      status = message_charge_next_status(mc.status, v_status),
      sent_at = COALESCE(mc.sent_at, v_sent_at),
      delivered_at = CASE
        WHEN message_charge_next_status(mc.status, v_status) IN ('delivered', 'read')
          THEN LEAST(mc.delivered_at, v_delivered_at)
        ELSE mc.delivered_at
      END,
      whatsapp_config_id = COALESCE(mc.whatsapp_config_id, p_whatsapp_config_id),
      message_id = COALESCE(mc.message_id, p_message_id),
      broadcast_recipient_id = COALESCE(mc.broadcast_recipient_id, p_broadcast_recipient_id),
      recipient_phone = COALESCE(mc.recipient_phone, p_recipient_phone)
    WHERE mc.wamid = p_wamid
      AND mc.account_id = p_account_id;
    IF FOUND THEN
      RETURN 'updated';
    END IF;
    RETURN CASE
      WHEN EXISTS (SELECT 1 FROM message_charges WHERE wamid = p_wamid)
        THEN 'foreign'
      ELSE 'skipped'
    END;
  END IF;

  INSERT INTO message_charges AS mc (
    account_id, whatsapp_config_id, wamid, message_id,
    broadcast_recipient_id, recipient_phone, pricing_category,
    pricing_billable, pricing_type, pricing_model, status, sent_at,
    delivered_at
  ) VALUES (
    p_account_id, p_whatsapp_config_id, p_wamid, p_message_id,
    p_broadcast_recipient_id, p_recipient_phone, p_pricing_category,
    p_pricing_billable, p_pricing_type, p_pricing_model, v_status,
    v_sent_at, v_delivered_at
  )
  ON CONFLICT (wamid) DO UPDATE SET
    status = message_charge_next_status(mc.status, EXCLUDED.status),
    sent_at = COALESCE(mc.sent_at, EXCLUDED.sent_at),
    delivered_at = CASE
      WHEN message_charge_next_status(mc.status, EXCLUDED.status) IN ('delivered', 'read')
        THEN LEAST(mc.delivered_at, EXCLUDED.delivered_at)
      ELSE mc.delivered_at
    END,
    whatsapp_config_id = COALESCE(mc.whatsapp_config_id, EXCLUDED.whatsapp_config_id),
    message_id = COALESCE(mc.message_id, EXCLUDED.message_id),
    broadcast_recipient_id = COALESCE(mc.broadcast_recipient_id, EXCLUDED.broadcast_recipient_id),
    recipient_phone = COALESCE(mc.recipient_phone, EXCLUDED.recipient_phone),
    pricing_billable = COALESCE(mc.pricing_billable, EXCLUDED.pricing_billable),
    pricing_type = COALESCE(mc.pricing_type, EXCLUDED.pricing_type),
    pricing_model = COALESCE(mc.pricing_model, EXCLUDED.pricing_model)
  WHERE mc.account_id = EXCLUDED.account_id
  RETURNING (xmax = 0) INTO v_inserted;

  IF v_inserted IS NULL THEN
    RETURN 'foreign';
  END IF;
  RETURN CASE WHEN v_inserted THEN 'inserted' ELSE 'updated' END;
END;
$$;

REVOKE ALL ON FUNCTION public.message_charge_next_status(text, text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.message_charge_next_status(text, text) FROM anon;
REVOKE ALL ON FUNCTION public.message_charge_next_status(text, text) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.message_charge_next_status(text, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.record_message_charge(
  uuid, text, text, timestamptz, uuid, uuid, uuid, text, text, boolean, text, text
) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.record_message_charge(
  uuid, text, text, timestamptz, uuid, uuid, uuid, text, text, boolean, text, text
) FROM anon;
REVOKE ALL ON FUNCTION public.record_message_charge(
  uuid, text, text, timestamptz, uuid, uuid, uuid, text, text, boolean, text, text
) FROM authenticated;
GRANT EXECUTE ON FUNCTION public.record_message_charge(
  uuid, text, text, timestamptz, uuid, uuid, uuid, text, text, boolean, text, text
) TO service_role;

COMMENT ON FUNCTION public.record_message_charge(
  uuid, text, text, timestamptz, uuid, uuid, uuid, text, text, boolean, text, text
) IS
  'Registra o avanza el cobro de Meta de un wamid (migración 075). Nunca '
  'pisa con NULL, nunca retrocede status, nunca toca la fila de otra '
  'cuenta. Solo service_role (webhook de estados).';
