-- Verificación de s10.1 (meta-pricing-capture) contra el Postgres local de
-- scripts/replay-migrations.sh (migración 075, tabla message_charges).
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fg-pricing-capture
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_meta-pricing-capture.sql
--
-- Todo en una transacción que termina en ROLLBACK. Sale con
-- `NOTICE: checks_meta-pricing-capture: OK` o con la primera EXCEPTION.
--
--   1. sent con pricing crea la fila; delivered con pricing distinto no pisa
--      el precio y fija delivered_at; read sin pricing avanza; delivered
--      tardío no retrocede status y adelanta delivered_at (LEAST).
--   2. Sin pricing y sin fila: no crea nada ('skipped').
--   3. El wamid de A llamado como B: 'foreign', A intacta, B sin fila (CP3).
--   4. failed: desde sent sí, desde delivered no.
--   5. Categoría desconocida (marketing_lite) se guarda tal cual.
--   6. UNIQUE(wamid), CHECK de status y categoría vacía, en la base real.
--   7. RLS: owner de A ve lo suyo; owner de B no ve nada de A; agent de A no
--      ve nada (admin+); authenticated no inserta ni llama a la RPC.
--   8. ON DELETE SET NULL: borrar el mensaje deja la fila de cobro.

BEGIN;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10100000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a-101@example.test', '{}', '{"full_name":"Owner A"}', now(), now()),
  ('10100000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b-101@example.test', '{}', '{"full_name":"Owner B"}', now(), now()),
  ('10100000-0000-4000-8000-000000000003', 'authenticated', 'authenticated', 'agent-a-101@example.test', '{}', '{"full_name":"Agent A"}', now(), now());

CREATE TEMP TABLE ids ON COMMIT DROP AS
SELECT
  (SELECT account_id FROM public.profiles WHERE user_id = '10100000-0000-4000-8000-000000000001') AS a_acc,
  (SELECT account_id FROM public.profiles WHERE user_id = '10100000-0000-4000-8000-000000000002') AS b_acc;
GRANT SELECT ON ids TO authenticated;

-- El agente pasa a ser miembro de A con rol agent.
UPDATE public.profiles
   SET account_id = (SELECT a_acc FROM ids), account_role = 'agent'
 WHERE user_id = '10100000-0000-4000-8000-000000000003';

-- Un mensaje real de A para el caso de ON DELETE SET NULL.
INSERT INTO public.contacts (id, user_id, account_id, phone, name)
SELECT '10100000-0000-4000-8000-0000000000c1'::uuid,
       '10100000-0000-4000-8000-000000000001'::uuid, a_acc, '+18095550101', 'Cliente A'
FROM ids;
INSERT INTO public.conversations (id, user_id, account_id, contact_id)
SELECT '10100000-0000-4000-8000-0000000000d1'::uuid,
       '10100000-0000-4000-8000-000000000001'::uuid, a_acc,
       '10100000-0000-4000-8000-0000000000c1'::uuid
FROM ids;
INSERT INTO public.messages (id, conversation_id, sender_type, content_type, content_text, message_id, status)
VALUES ('10100000-0000-4000-8000-0000000000e1', '10100000-0000-4000-8000-0000000000d1',
        'agent', 'template', 'hola', 'wamid.A1', 'sent');

DO $$
DECLARE
  a uuid := (SELECT a_acc FROM ids);
  b uuid := (SELECT b_acc FROM ids);
  r text;
  mc record;
BEGIN
  -- 1. sent con pricing.
  r := record_message_charge(a, 'wamid.A1', 'sent', '2026-10-01 10:00:00+00',
         NULL, '10100000-0000-4000-8000-0000000000e1', NULL, '18095550101',
         'marketing', true, 'regular', 'PMP');
  IF r <> 'inserted' THEN RAISE EXCEPTION '1a: esperaba inserted, fue %', r; END IF;

  -- delivered con pricing distinto: no pisa el precio.
  r := record_message_charge(a, 'wamid.A1', 'delivered', '2026-10-01 10:00:05+00',
         NULL, NULL, NULL, NULL, 'utility', false, 'free_customer_service', 'X');
  IF r <> 'updated' THEN RAISE EXCEPTION '1b: esperaba updated, fue %', r; END IF;
  SELECT * INTO mc FROM message_charges WHERE wamid = 'wamid.A1';
  IF mc.pricing_category <> 'marketing' OR mc.pricing_billable IS NOT TRUE
     OR mc.pricing_type <> 'regular' OR mc.pricing_model <> 'PMP' THEN
    RAISE EXCEPTION '1b: el segundo estado pisó el precio: %', mc;
  END IF;
  IF mc.status <> 'delivered' OR mc.delivered_at <> '2026-10-01 10:00:05+00'
     OR mc.sent_at <> '2026-10-01 10:00:00+00'
     OR mc.message_id <> '10100000-0000-4000-8000-0000000000e1'
     OR mc.recipient_phone <> '18095550101' THEN
    RAISE EXCEPTION '1b: estado/fechas/refs: %', mc;
  END IF;

  -- read sin pricing: avanza sin crear ni pisar.
  r := record_message_charge(a, 'wamid.A1', 'read', '2026-10-01 10:05:00+00');
  IF r <> 'updated' THEN RAISE EXCEPTION '1c: esperaba updated, fue %', r; END IF;
  SELECT * INTO mc FROM message_charges WHERE wamid = 'wamid.A1';
  IF mc.status <> 'read' OR mc.delivered_at <> '2026-10-01 10:00:05+00'
     OR mc.pricing_billable IS NOT TRUE OR mc.message_id IS NULL THEN
    RAISE EXCEPTION '1c: read sin pricing: %', mc;
  END IF;

  -- delivered tardío (anterior en el tiempo) tras read.
  r := record_message_charge(a, 'wamid.A1', 'delivered', '2026-10-01 10:00:03+00',
         NULL, NULL, NULL, NULL, 'marketing', true, 'regular', 'PMP');
  SELECT * INTO mc FROM message_charges WHERE wamid = 'wamid.A1';
  IF mc.status <> 'read' THEN RAISE EXCEPTION '1d: status retrocedió a %', mc.status; END IF;
  IF mc.delivered_at <> '2026-10-01 10:00:03+00' THEN
    RAISE EXCEPTION '1d: delivered_at no tomó el más temprano: %', mc.delivered_at;
  END IF;

  -- read sin delivered previo fija delivered_at.
  PERFORM record_message_charge(a, 'wamid.A2', 'sent', '2026-10-01 11:00:00+00',
         NULL, NULL, NULL, NULL, 'utility', true, 'regular', 'PMP');
  PERFORM record_message_charge(a, 'wamid.A2', 'read', '2026-10-01 11:01:00+00');
  IF (SELECT delivered_at FROM message_charges WHERE wamid = 'wamid.A2')
     <> '2026-10-01 11:01:00+00' THEN
    RAISE EXCEPTION '1e: read sin delivered no fijó delivered_at';
  END IF;

  -- 2. Sin pricing y sin fila.
  r := record_message_charge(a, 'wamid.NOPE', 'delivered', now());
  IF r <> 'skipped' OR EXISTS (SELECT 1 FROM message_charges WHERE wamid = 'wamid.NOPE') THEN
    RAISE EXCEPTION '2: un estado sin pricing creó fila (%)', r;
  END IF;

  -- 3. El wamid de A llamado como B.
  r := record_message_charge(b, 'wamid.A1', 'failed', now(),
         NULL, NULL, NULL, '19999999999', 'authentication', false, 'x', 'y');
  IF r <> 'foreign' THEN RAISE EXCEPTION '3a: esperaba foreign, fue %', r; END IF;
  r := record_message_charge(b, 'wamid.A1', 'read', now());
  IF r <> 'foreign' THEN RAISE EXCEPTION '3b: esperaba foreign, fue %', r; END IF;
  SELECT * INTO mc FROM message_charges WHERE wamid = 'wamid.A1';
  IF mc.account_id <> a OR mc.pricing_category <> 'marketing'
     OR mc.recipient_phone <> '18095550101' OR mc.status <> 'read' THEN
    RAISE EXCEPTION '3: B tocó la fila de A: %', mc;
  END IF;
  IF EXISTS (SELECT 1 FROM message_charges WHERE account_id = b) THEN
    RAISE EXCEPTION '3: B quedó con fila';
  END IF;

  -- 4. failed.
  PERFORM record_message_charge(a, 'wamid.A3', 'sent', now(),
         NULL, NULL, NULL, NULL, 'marketing', true, 'regular', 'PMP');
  PERFORM record_message_charge(a, 'wamid.A3', 'failed', now());
  IF (SELECT status FROM message_charges WHERE wamid = 'wamid.A3') <> 'failed' THEN
    RAISE EXCEPTION '4a: sent→failed no aplicó';
  END IF;
  PERFORM record_message_charge(a, 'wamid.A2', 'failed', now());
  IF (SELECT status FROM message_charges WHERE wamid = 'wamid.A2') <> 'read' THEN
    RAISE EXCEPTION '4b: read→failed retrocedió';
  END IF;

  -- 5. Categoría desconocida, tal cual.
  r := record_message_charge(a, 'wamid.A4', 'sent', now(),
         NULL, NULL, NULL, NULL, 'marketing_lite', true, 'regular', 'PMP');
  IF r <> 'inserted' OR (SELECT pricing_category FROM message_charges WHERE wamid = 'wamid.A4')
     <> 'marketing_lite' THEN
    RAISE EXCEPTION '5: marketing_lite no se guardó tal cual';
  END IF;

  -- 6. Restricciones en la base real.
  BEGIN
    INSERT INTO message_charges (account_id, wamid, pricing_category)
    VALUES (b, 'wamid.A1', 'marketing');
    RAISE EXCEPTION '6a: wamid duplicado aceptado';
  EXCEPTION WHEN unique_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO message_charges (account_id, wamid, pricing_category, status)
    VALUES (a, 'wamid.BAD', 'marketing', 'pending');
    RAISE EXCEPTION '6b: status fuera de lista aceptado';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO message_charges (account_id, wamid, pricing_category)
    VALUES (a, 'wamid.BAD2', '  ');
    RAISE EXCEPTION '6c: categoría vacía aceptada';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO message_charges (account_id, wamid)
    VALUES (a, 'wamid.BAD3');
    RAISE EXCEPTION '6d: categoría NULL aceptada';
  EXCEPTION WHEN not_null_violation THEN NULL;
  END;
END
$$;

-- 7. RLS, owner de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10100000-0000-4000-8000-000000000001', true);
SELECT set_config('request.jwt.claims', '{"sub":"10100000-0000-4000-8000-000000000001","role":"authenticated"}', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM message_charges) <> 4 THEN
    RAISE EXCEPTION '7a: owner de A ve % filas, esperaba 4', (SELECT count(*) FROM message_charges);
  END IF;
  BEGIN
    INSERT INTO message_charges (account_id, wamid, pricing_category)
    VALUES ((SELECT a_acc FROM ids), 'wamid.FAKE', 'marketing');
    RAISE EXCEPTION '7b: authenticated insertó un cobro';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    UPDATE message_charges SET pricing_billable = false;
    RAISE EXCEPTION '7c: authenticated actualizó un cobro';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    PERFORM record_message_charge((SELECT a_acc FROM ids), 'wamid.FAKE', 'sent', now(),
      NULL, NULL, NULL, NULL, 'marketing', true, 'regular', 'PMP');
    RAISE EXCEPTION '7d: authenticated llamó a record_message_charge';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$$;
RESET ROLE;

-- Owner de B: nada de A.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10100000-0000-4000-8000-000000000002', true);
SELECT set_config('request.jwt.claims', '{"sub":"10100000-0000-4000-8000-000000000002","role":"authenticated"}', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM message_charges) <> 0 THEN
    RAISE EXCEPTION '7e: owner de B ve cobros de A';
  END IF;
END
$$;
RESET ROLE;

-- Agent de A: admin+ solamente.
SET LOCAL ROLE authenticated;
SELECT set_config('request.jwt.claim.sub', '10100000-0000-4000-8000-000000000003', true);
SELECT set_config('request.jwt.claims', '{"sub":"10100000-0000-4000-8000-000000000003","role":"authenticated"}', true);
DO $$
BEGIN
  IF (SELECT count(*) FROM message_charges) <> 0 THEN
    RAISE EXCEPTION '7f: un agent ve los cobros (debe ser admin+)';
  END IF;
END
$$;
RESET ROLE;

-- 8. ON DELETE SET NULL.
DELETE FROM public.messages WHERE id = '10100000-0000-4000-8000-0000000000e1';
DO $$
DECLARE mc record;
BEGIN
  SELECT * INTO mc FROM message_charges WHERE wamid = 'wamid.A1';
  IF mc IS NULL OR mc.message_id IS NOT NULL THEN
    RAISE EXCEPTION '8: borrar el mensaje no dejó la fila con message_id NULL: %', mc;
  END IF;
  RAISE NOTICE 'checks_meta-pricing-capture: OK';
END
$$;

ROLLBACK;
