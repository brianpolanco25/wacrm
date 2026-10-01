-- ============================================================
-- checks_meta-reconciliation.sql — s10.7, migración 084.
-- Corrido el 2026-10-01 contra la base local (084 aplicada): OK.
--
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_meta-reconciliation.sql
--
-- Todo va en una transacción con ROLLBACK: no deja nada. Cada bloque
-- lanza EXCEPTION si el comportamiento no es el esperado.
-- ============================================================

BEGIN;

-- Dos cuentas de prueba. `accounts.owner_user_id` es NOT NULL con FK a
-- auth.users, así que primero dos usuarios (el trigger de alta les crea su
-- cuenta personal; sobra y se va con el ROLLBACK).
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('10840000-0000-4000-8000-000000000001', 'authenticated', 'authenticated', 'owner-a-084@example.test', '{}', '{"full_name":"Owner A"}', now(), now()),
  ('10840000-0000-4000-8000-000000000002', 'authenticated', 'authenticated', 'owner-b-084@example.test', '{}', '{"full_name":"Owner B"}', now(), now());
-- El trigger ya les creó su cuenta personal y idx_accounts_one_per_owner no
-- deja una segunda por dueño. El índice se suelta solo dentro de esta
-- transacción (vuelve con el ROLLBACK); el check no trata de accounts.
DROP INDEX IF EXISTS idx_accounts_one_per_owner;
INSERT INTO accounts (id, name, owner_user_id) VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a1', 'check A', '10840000-0000-4000-8000-000000000001'),
  ('bbbbbbbb-0000-4000-8000-0000000000b1', 'check B', '10840000-0000-4000-8000-000000000002');

-- 1. Idempotencia: fuera de este archivo, re-aplica
--    supabase/migrations/084_meta_spend_snapshots.sql dos veces seguidas
--    sobre la base ya migrada; las dos deben salir con 0.

-- 2. UNIQUE NULLS NOT DISTINCT: un upsert con whatsapp_config_id NULL
--    actualiza la fila en vez de duplicarla.
INSERT INTO meta_spend_snapshots
  (account_id, whatsapp_config_id, waba_id, period_start, period_end, category, volume, cost_usd)
VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a1', NULL, 'W-A',
   '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', 'marketing', 100, 7.4)
ON CONFLICT (account_id, waba_id, period_start, period_end, category, whatsapp_config_id)
DO UPDATE SET volume = EXCLUDED.volume, cost_usd = EXCLUDED.cost_usd;

INSERT INTO meta_spend_snapshots
  (account_id, whatsapp_config_id, waba_id, period_start, period_end, category, volume, cost_usd)
VALUES
  ('aaaaaaaa-0000-4000-8000-0000000000a1', NULL, 'W-A',
   '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', 'marketing', 120, 8.88)
ON CONFLICT (account_id, waba_id, period_start, period_end, category, whatsapp_config_id)
DO UPDATE SET volume = EXCLUDED.volume, cost_usd = EXCLUDED.cost_usd;

DO $$
BEGIN
  IF (SELECT count(*) FROM meta_spend_snapshots
      WHERE account_id = 'aaaaaaaa-0000-4000-8000-0000000000a1') <> 1 THEN
    RAISE EXCEPTION 'NULLS NOT DISTINCT: the NULL-config upsert duplicated the row';
  END IF;
  IF (SELECT cost_usd FROM meta_spend_snapshots
      WHERE account_id = 'aaaaaaaa-0000-4000-8000-0000000000a1') <> 8.88 THEN
    RAISE EXCEPTION 'the upsert did not update the row';
  END IF;
END $$;

-- 3. CHECKs: periodo invertido, negativos, categoría vacía.
DO $$
BEGIN
  BEGIN
    INSERT INTO meta_spend_snapshots (account_id, waba_id, period_start, period_end, category)
    VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1', 'W-A',
            '2026-10-06T00:00:00Z', '2026-10-05T00:00:00Z', 'marketing');
    RAISE EXCEPTION 'period_check did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO meta_spend_snapshots (account_id, waba_id, period_start, period_end, category, cost_usd)
    VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1', 'W-A',
            '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z', 'marketing', -1);
    RAISE EXCEPTION 'amounts_check did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
  BEGIN
    INSERT INTO meta_spend_snapshots (account_id, waba_id, period_start, period_end, category)
    VALUES ('aaaaaaaa-0000-4000-8000-0000000000a1', 'W-A',
            '2026-10-07T00:00:00Z', '2026-10-08T00:00:00Z', '  ');
    RAISE EXCEPTION 'category_check did not fire';
  EXCEPTION WHEN check_violation THEN NULL;
  END;
END $$;

-- 4. Borrar un número no falla aunque tenga snapshots (sin FK a
--    whatsapp_config a propósito; el id queda como dato histórico).
--    (Requiere una fila de whatsapp_config de la cuenta; si el esquema
--     exige user_id, crea antes un auth.users de prueba.)

-- 5. RLS / privilegios: ni authenticated ni anon leen ni escriben, ni
--    siquiera un miembro de la cuenta.
INSERT INTO meta_spend_snapshots
  (account_id, waba_id, period_start, period_end, category, volume, cost_usd)
VALUES ('bbbbbbbb-0000-4000-8000-0000000000b1', 'W-B',
        '2026-10-05T00:00:00Z', '2026-10-06T00:00:00Z', 'marketing', 1, 0.074);

SET LOCAL ROLE authenticated;
DO $$
BEGIN
  BEGIN
    PERFORM 1 FROM meta_spend_snapshots;
    RAISE EXCEPTION 'authenticated can SELECT meta_spend_snapshots';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
  BEGIN
    INSERT INTO meta_spend_snapshots (account_id, waba_id, period_start, period_end, category)
    VALUES ('bbbbbbbb-0000-4000-8000-0000000000b1', 'W-B',
            '2026-10-09T00:00:00Z', '2026-10-10T00:00:00Z', 'marketing');
    RAISE EXCEPTION 'authenticated can INSERT meta_spend_snapshots';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END $$;
RESET ROLE;

SET LOCAL ROLE anon;
DO $$
BEGIN
  PERFORM 1 FROM meta_spend_snapshots;
  RAISE EXCEPTION 'anon can SELECT meta_spend_snapshots';
EXCEPTION WHEN insufficient_privilege THEN NULL;
END $$;
RESET ROLE;

-- 6. service_role lee y escribe.
SET LOCAL ROLE service_role;
DO $$
BEGIN
  IF (SELECT count(*) FROM meta_spend_snapshots) < 2 THEN
    RAISE EXCEPTION 'service_role cannot read meta_spend_snapshots';
  END IF;
END $$;
RESET ROLE;

-- 7. La FK a accounts es ON DELETE CASCADE. Se comprueba por catálogo:
--    borrar una cuenta de verdad lo impide subscriptions (RESTRICT, 041),
--    igual que con message_charges (075) y statements (078).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.meta_spend_snapshots'::regclass
      AND contype = 'f'
      AND confrelid = 'public.accounts'::regclass
      AND confdeltype = 'c'
  ) THEN
    RAISE EXCEPTION 'meta_spend_snapshots.account_id is not ON DELETE CASCADE to accounts';
  END IF;
END $$;

\echo 'checks_meta-reconciliation: OK'
ROLLBACK;
