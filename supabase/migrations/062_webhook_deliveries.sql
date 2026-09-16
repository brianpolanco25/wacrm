-- ============================================================
-- 062_webhook_deliveries.sql — Cola duradera de entregas de webhook
--
-- La 028 dejó los endpoints salientes con una entrega «a lo sumo una
-- vez»: un intento dentro de `after()` y, si el receptor estaba caído,
-- el evento se perdía. Esta tabla es la cola: `dispatchWebhookEvent`
-- persiste una fila por endpoint suscrito ANTES de intentar nada, así
-- que un fallo de red, un despliegue a medias o un receptor en
-- mantenimiento ya no pierden el evento — lo recoge el barrido de
-- `GET /api/webhooks/cron`.
--
-- Diseño
--   - `payload` guarda el sobre EXACTO que se firma y se envía (id de
--     evento incluido), de modo que un reintento manda el mismo cuerpo
--     y el receptor puede deduplicar por `payload->>'id'`. La firma sí
--     cambia en cada intento: lleva el reloj del intento (protección
--     anti-repetición del receptor).
--   - `attempt` cuenta intentos EMPEZADOS y es además el candado
--     optimista del barrido: el reclamo es
--     `UPDATE … SET attempt = attempt + 1 WHERE id = ? AND attempt = ?`,
--     así que dos barridos solapados no entregan la misma fila dos
--     veces (mismo patrón de reclamo que `/api/automations/cron`).
--   - `next_attempt_at` es la escalera de S-A6 (1 min, 5 min, 30 min,
--     2 h, 12 h). Agotada, la fila queda `dead` y nadie la vuelve a
--     tocar salvo un reintento manual desde el panel o la API.
--   - `status` incluye `pending` (encolada o reclamada) y `failed`
--     (intento fallido con reintento programado); ambas son elegibles
--     para el barrido cuando `next_attempt_at <= now()`.
--   - La autodesactivación del endpoint a los 15 fallos consecutivos
--     (`record_webhook_failure`, 028) se conserva tal cual.
--
-- Borrado en cascada
--   `endpoint_id … ON DELETE CASCADE` es deliberado y no contradice el
--   CP2: la bitácora de entregas es subordinada al endpoint (solo se
--   lista como `/webhooks/{id}/deliveries`) y su `payload` contiene
--   datos del cliente final. Dejar filas huérfanas tras borrar la
--   integración sería conservar esos payloads sin ninguna vía de
--   consulta ni de borrado. `account_id` replica lo que ya hace
--   `webhook_endpoints` desde la 028.
--
-- RLS
--   Lectura para cualquier miembro (el panel la lista); escritura solo
--   `service_role` — no hay política de INSERT/UPDATE/DELETE, así que
--   ningún cliente con JWT de usuario puede fabricar ni alterar una
--   entrega.
--
-- Idempotente — se puede re-ejecutar.
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id       uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  endpoint_id      uuid NOT NULL REFERENCES webhook_endpoints(id) ON DELETE CASCADE,
  event            text NOT NULL,
  payload          jsonb NOT NULL,
  attempt          integer NOT NULL DEFAULT 0,
  status           text NOT NULL DEFAULT 'pending',
  next_attempt_at  timestamptz NOT NULL DEFAULT now(),
  last_status_code integer,
  last_error       text,
  created_at       timestamptz NOT NULL DEFAULT now(),
  delivered_at     timestamptz,
  CONSTRAINT webhook_deliveries_status_check
    CHECK (status IN ('pending', 'delivered', 'failed', 'dead'))
);

-- El barrido: lo vencido, por antigüedad de vencimiento. Parcial
-- porque `delivered`/`dead` son el 99 % de la tabla y nunca se barren.
CREATE INDEX IF NOT EXISTS webhook_deliveries_due_idx
  ON webhook_deliveries (next_attempt_at)
  WHERE status IN ('pending', 'failed');

-- La lista del panel / de la API: últimas entregas de un endpoint.
CREATE INDEX IF NOT EXISTS webhook_deliveries_endpoint_idx
  ON webhook_deliveries (endpoint_id, created_at DESC);

-- La purga a 30 días y cualquier consulta acotada por cuenta.
CREATE INDEX IF NOT EXISTS webhook_deliveries_account_created_idx
  ON webhook_deliveries (account_id, created_at DESC);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier miembro de la cuenta (viewer+) ve la bitácora.
-- `can_read_account` y no `is_account_member` (migración 057): si no,
-- la tabla sería invisible durante una sesión de soporte y
-- `verify-schema.sql` lo rechaza.
DROP POLICY IF EXISTS webhook_deliveries_select ON webhook_deliveries;
CREATE POLICY webhook_deliveries_select ON webhook_deliveries FOR SELECT
  USING (can_read_account(account_id));

-- Sin políticas de escritura a propósito: solo `service_role` (que
-- salta la RLS) encola, reclama y marca entregas.
