-- ============================================================
-- 078_statements.sql — Fase 10 (s10.4 `statements`)
--
-- Estado de cuenta al corte de una cuenta con facturación gestionada de
-- Meta (`subscriptions.meta_billing = 'managed'`, 076/077): cuota fija +
-- excedente de mensajes entregados, pagado al corte del mes. Lo emite el
-- cron `GET /api/billing/cron` y lo confirma (o anula) un operador desde
-- la ficha del superadmin.
--
-- Qué guarda
--   - Un estado por cuenta y fecha de corte: UNIQUE (account_id,
--     period_end). Es lo que hace idempotente al cron: correrlo tres
--     veces el mismo día choca con el UNIQUE y emite uno solo.
--   - Columnas resumen para listar sin abrir el jsonb: cuota
--     (`plan_fee_usd`, 0 con PayPal: la cobra la suscripción), excedente
--     (`usage_charge_usd`), total, costo real de Meta (`meta_cost_usd`,
--     solo de los mensajes que Meta marcó `billable`), mensajes incluidos,
--     entregados con categoría y de excedente.
--   - `usage` (jsonb): el desglose por número y categoría (entregados,
--     cuántos le costaron a Meta, tarifa de Meta, precio aplicado, costo
--     real, importe) y los entregados sin categoría conocida, que se
--     listan y no se cobran. Lo calcula `src/lib/billing/statements.ts`.
--   - Pago: `paid_at`, `paid_by`, `paid_reference`, `paid_note`. Y la nota
--     «Ya pagué» del cliente (`claimed_*`), que no cambia el estado.
--
-- RLS
--   El inquilino `admin+` lee los suyos (`can_read_account`, 057: también
--   en una sesión de soporte) PERO no todas las columnas: el costo de
--   Meta, el desglose interno (`usage` lleva la marca `billable` y la
--   tarifa de Meta) y los datos del pago son del superadmin. Por eso el
--   SELECT de `authenticated` es por columnas; el cliente ve el desglose
--   por `GET /api/billing/statements`, que quita lo interno. Escritura
--   solo `service_role`: sin políticas de escritura y sin privilegios.
--
-- Bitácora
--   `impersonation_log.action` admite `payment_confirmed` y
--   `statement_void` (se amplía el CHECK de la 071 sin perder ninguno).
--
-- CP11: no se toca ninguna tabla del entrante.
--
-- Idempotente — se puede re-ejecutar.
-- ============================================================

CREATE TABLE IF NOT EXISTS statements (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id        uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  period_start      timestamptz NOT NULL,
  period_end        timestamptz NOT NULL,
  plan_fee_usd      numeric(10,2) NOT NULL DEFAULT 0,
  usage             jsonb NOT NULL DEFAULT '{}'::jsonb,
  meta_cost_usd     numeric(10,2) NOT NULL DEFAULT 0,
  usage_charge_usd  numeric(10,2) NOT NULL DEFAULT 0,
  total_usd         numeric(10,2) NOT NULL DEFAULT 0,
  included_messages integer NOT NULL DEFAULT 0,
  messages_total    integer NOT NULL DEFAULT 0,
  overage_messages  integer NOT NULL DEFAULT 0,
  status            text NOT NULL DEFAULT 'issued',
  issued_at         timestamptz NOT NULL DEFAULT now(),
  due_at            timestamptz NOT NULL,
  paid_at           timestamptz,
  paid_by           uuid,
  paid_reference    text,
  paid_note         text,
  claimed_paid_at   timestamptz,
  claimed_by        uuid,
  claim_note        text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT statements_account_period_key UNIQUE (account_id, period_end),
  CONSTRAINT statements_status_check
    CHECK (status IN ('issued', 'paid', 'void')),
  CONSTRAINT statements_period_check CHECK (period_end > period_start),
  CONSTRAINT statements_due_check CHECK (due_at >= period_end),
  CONSTRAINT statements_amounts_check CHECK (
    plan_fee_usd >= 0 AND meta_cost_usd >= 0 AND usage_charge_usd >= 0
    AND total_usd >= 0
    AND included_messages >= 0 AND messages_total >= 0
    AND overage_messages >= 0
  ),
  CONSTRAINT statements_paid_check
    CHECK (status <> 'paid' OR paid_at IS NOT NULL),
  CONSTRAINT statements_usage_object_check
    CHECK (jsonb_typeof(usage) = 'object')
);

-- El estado abierto de una cuenta (entitlements, banner): issued por
-- vencimiento.
CREATE INDEX IF NOT EXISTS statements_account_open_idx
  ON statements (account_id, due_at)
  WHERE status = 'issued';

ALTER TABLE statements ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS statements_select ON statements;
CREATE POLICY statements_select ON statements FOR SELECT TO authenticated
  USING (can_read_account(account_id, 'admin'));

-- Sin escritura para nadie más que service_role, y lectura por columnas:
-- nada de `usage`, `meta_cost_usd`, `paid_*` ni `claim*` para un JWT.
REVOKE ALL ON statements FROM anon, authenticated;
GRANT SELECT (
  id, account_id, period_start, period_end, plan_fee_usd, usage_charge_usd,
  total_usd, included_messages, messages_total, overage_messages, status,
  issued_at, due_at, paid_at, created_at
) ON statements TO authenticated;

COMMENT ON TABLE statements IS
  'Estado de cuenta al corte de una cuenta con Meta gestionado (078, s10.4). '
  'Lo emite /api/billing/cron; lo confirma o anula un operador.';
COMMENT ON COLUMN statements.usage IS
  'Desglose por número y categoría, con la marca billable y la tarifa de Meta '
  '(interno: el cliente lo ve sin ellas por /api/billing/statements).';
COMMENT ON COLUMN statements.meta_cost_usd IS
  'Lo que Meta cobró: solo los mensajes billable. La diferencia con '
  'usage_charge_usd + plan_fee_usd es el margen.';

-- ============================================================
-- Bitácora: los dos actos nuevos
-- ============================================================

ALTER TABLE impersonation_log
  DROP CONSTRAINT IF EXISTS impersonation_log_action_check;
ALTER TABLE impersonation_log
  ADD CONSTRAINT impersonation_log_action_check
  CHECK (action IN (
    'impersonation', 'suspend', 'reactivate',
    'plan_override', 'account_create', 'member_invite',
    'operator_grant', 'operator_revoke',
    'payment_confirmed', 'statement_void'
  ));

COMMENT ON COLUMN impersonation_log.action IS
  'Qué hizo el operador: impersonation (sesión de soporte, el valor por '
  'defecto), suspend/reactivate (058), plan_override, account_create, '
  'member_invite, operator_grant, operator_revoke (071), '
  'payment_confirmed, statement_void (078).';
