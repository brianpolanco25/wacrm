-- ============================================================
-- 083 — Bitácora de correos de facturación (p11.7).
--
-- Una fila por aviso mandado (o intentado) a una cuenta:
--
--   service_quota_80   un número `direct` llegó a 800 de sus 1.000
--                      mensajes de servicio gratis del mes (p11.3);
--   service_quota_100  ese número los agotó;
--   statement_issued   se emitió un estado de cuenta (s10.4);
--   statement_due      venció sin pagar.
--
-- `ref` identifica el evento dentro de su `kind`: `<whatsapp_config_id>:
-- <YYYY-MM>` para la cuota y `statements.id` para el estado de cuenta.
-- UNIQUE (account_id, kind, ref) es lo que impide repetir un aviso: el
-- barrido (GET /api/billing/cron) RESERVA el evento con un INSERT … ON
-- CONFLICT DO NOTHING antes de llamar al proveedor, y solo envía si la
-- inserción devolvió fila. Dos barridos solapados mandan un correo.
--
-- Protocolo de estados: pending (reservado) → sent | failed | skipped
-- (sin destinatarios). Una reserva `failed`, o `pending` de más de 1 h,
-- se reintenta con un UPDATE optimista sobre `attempts`, como mucho 3.
--
-- `ref` no tiene FK a `statements` ni a `whatsapp_config` a propósito: la
-- bitácora sobrevive a un estado de cuenta anulado o a un número borrado,
-- y así no se reenvía.
--
-- RLS activa y SIN políticas, y REVOKE a anon/authenticated: ningún
-- cliente la lee ni la escribe; solo el rol de servicio (que se salta la
-- RLS) desde el cron. CP3.
--
-- ON DELETE CASCADE desde accounts: es una bitácora de avisos, no dato
-- del cliente; si la cuenta se borra, sus avisos no tienen sentido. No
-- hay CASCADE desde esta tabla hacia ninguna otra.
--
-- CP11: no toca messages, conversations, statements ni subscriptions.
-- Idempotente: se puede aplicar dos veces.
-- ============================================================

CREATE TABLE IF NOT EXISTS notification_emails (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  kind        text NOT NULL,
  ref         text NOT NULL,
  status      text NOT NULL DEFAULT 'pending',
  attempts    integer NOT NULL DEFAULT 0,
  recipients  integer,
  last_error  text,
  sent_at     timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT notification_emails_key UNIQUE (account_id, kind, ref),
  CONSTRAINT notification_emails_kind_check CHECK (kind IN
    ('service_quota_80', 'service_quota_100', 'statement_issued', 'statement_due')),
  CONSTRAINT notification_emails_status_check CHECK (status IN
    ('pending', 'sent', 'failed', 'skipped')),
  CONSTRAINT notification_emails_attempts_check CHECK (attempts >= 0),
  CONSTRAINT notification_emails_ref_check CHECK (length(ref) BETWEEN 1 AND 200)
);

ALTER TABLE notification_emails ENABLE ROW LEVEL SECURITY;

-- Sin políticas: authenticated/anon no ven ni escriben nada (R3).
REVOKE ALL ON notification_emails FROM anon, authenticated;

COMMENT ON TABLE notification_emails IS
  'p11.7: bitácora de correos de facturación (cuota gratis 80/100 %, estado de cuenta emitido/vencido). UNIQUE (account_id, kind, ref) = un aviso por evento. Solo service_role.';
