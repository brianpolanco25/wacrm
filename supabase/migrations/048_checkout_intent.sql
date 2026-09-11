-- ============================================================
-- 048_checkout_intent.sql — Fase 3 (SaaS): intención de contratación
--
-- El checkout (§2 de docs/saas/fase-3-facturacion.md) crea la
-- suscripción en PayPal y devuelve un enlace de aprobación. Entre ese
-- momento y el evento `BILLING.SUBSCRIPTION.ACTIVATED` (fase 3, §3) no
-- hay nada en la base que diga qué plan y qué ciclo eligió quién: la
-- suscripción de PayPal existe, la nuestra todavía no. Esta tabla es
-- ese registro intermedio.
--
--   checkout_intents
--     Una fila por intento de contratación. La escribe **solo** el
--     rol de servicio, desde `POST /api/billing/checkout`, con el
--     `account_id` del contexto autenticado — nunca con uno que venga
--     del cuerpo de la petición.
--
-- Por qué una tabla y no columnas en `subscriptions`
--   `subscriptions` es la verdad del servicio contratado y la escribe
--   el webhook. Si el checkout tocara `subscriptions` (aunque fuese
--   solo `provider_subscription_id`), una redirección o un intento
--   abandonado dejarían huella en la fila que decide si la cuenta
--   tiene servicio, que es justo la trampa que el spec manda evitar.
--   Aquí el checkout escribe en su propia tabla y no puede activar
--   nada.
--
-- Por qué NADIE puede escribirla desde el cliente
--   `provider_subscription_id` es la llave con la que el webhook casará
--   el evento con una cuenta y un plan. Un inquilino que pudiera
--   insertar filas aquí reclamaría la suscripción pagada por otro —o
--   se auto-asignaría el plan Negocio contratando el Inicio—. Igual que
--   `subscriptions` en 041: RLS con SELECT para admin+ y ninguna
--   política de escritura.
--
-- `status` lo mueve la fase 3 §3 (webhook). El checkout solo escribe
-- 'pending'; 'activated' y 'cancelled' pertenecen al manejador de
-- eventos y se declaran aquí para no tener que alterar el CHECK luego.
--
-- Idempotente — safe to re-run: CREATE TABLE / INDEX IF NOT EXISTS,
-- FK con nombre explícito en drop-then-add (patrón de 040/041) y
-- políticas drop-then-create.
-- ============================================================

CREATE TABLE IF NOT EXISTS checkout_intents (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id               uuid NOT NULL,
  plan_id                  text NOT NULL REFERENCES plans(id),
  cycle                    text NOT NULL CHECK (cycle IN ('month','year')),
  provider                 text NOT NULL DEFAULT 'paypal',
  -- El id del plan EN EL PROVEEDOR con el que se creó la suscripción.
  -- El webhook lo contrasta con el `plan_id` que trae el evento: si no
  -- coinciden, el cliente aprobó otra cosa distinta de la que pidió.
  provider_plan_id         text NOT NULL,
  provider_subscription_id text NOT NULL,
  status                   text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','activated','cancelled')),
  -- Quién pulsó «contratar». Auditoría: que el miembro se vaya no
  -- puede borrar el rastro de una contratación (ON DELETE SET NULL,
  -- igual que api_keys.created_by en 026).
  created_by               uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  -- La idempotencia del webhook: un id de suscripción del proveedor
  -- pertenece a una sola intención, y por tanto a una sola cuenta.
  CONSTRAINT checkout_intents_provider_subscription_key
    UNIQUE (provider, provider_subscription_id)
);

-- Mismo criterio que `subscriptions` y `usage_counters`: el rastro de
-- facturación es dato contable. RESTRICT, nunca CASCADE; borrar una
-- cuenta con contrataciones registradas es una decisión explícita, no
-- un efecto colateral.
--
-- Ojo con el precedente: 041 tal y como está EN ESTA RAMA todavía
-- declara esas dos claves con `ON DELETE CASCADE`. La fase 0 ya las
-- pasó a RESTRICT (commit 324f087 de `saas/fase-0-cimientos`) y el
-- cambio llega aquí por merge; hasta entonces el criterio de 041 y el
-- de esta tabla no coinciden en el árbol, aunque sí en la intención.
--
-- Consecuencia deliberada: borrar una cuenta con intentos registrados
-- falla con 23503. El único flujo del producto que borra cuentas es
-- `redeem_invitation()` (019), que disuelve la cuenta personal vacía
-- del invitado; 049 le enseña a borrar sus intentos `pending` (una
-- aprobación abandonada no vale nada) y a tratar cualquier otro estado
-- como «la cuenta no está vacía».
ALTER TABLE checkout_intents
  DROP CONSTRAINT IF EXISTS checkout_intents_account_id_fkey;
ALTER TABLE checkout_intents
  ADD CONSTRAINT checkout_intents_account_id_fkey
  FOREIGN KEY (account_id) REFERENCES accounts(id) ON DELETE RESTRICT;

-- La consulta caliente es «la última intención de esta cuenta», que la
-- página de retorno sondea mientras espera el webhook.
CREATE INDEX IF NOT EXISTS checkout_intents_account_created_idx
  ON checkout_intents (account_id, created_at DESC);

-- Mismo trigger de updated_at que el resto de tablas (001/006/017/041).
DROP TRIGGER IF EXISTS set_updated_at ON checkout_intents;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON checkout_intents
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE checkout_intents ENABLE ROW LEVEL SECURITY;

-- SELECT para admin+ de la cuenta: es dato de facturación, igual que
-- `usage_counters`. Sin políticas de escritura a propósito — solo el
-- rol de servicio, desde la ruta de checkout.
DROP POLICY IF EXISTS checkout_intents_select ON checkout_intents;
CREATE POLICY checkout_intents_select ON checkout_intents FOR SELECT
  USING (is_account_member(account_id, 'admin'));
