-- ============================================================
-- f4.2 `multi-number` — comprobaciones contra Postgres real.
--
-- Lo que ningún test de vitest puede afirmar: que la BASE impide dos
-- predeterminados, que borrar un número NO borra conversaciones, que el
-- UNIQUE global de la 013 sigue vivo y que la RLS de la 017 sigue dando
-- acceso a los n números a cualquier miembro de la cuenta.
--
-- Cómo se corre (deja el contenedor vivo primero):
--   KEEP=1 scripts/replay-migrations.sh \
--     .claude/worktrees/fase-4-multinumero
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_multi-number.sql
--
-- Cada bloque termina en RAISE NOTICE 'OK …'. Un fallo aborta con
-- ON_ERROR_STOP=1, así que no hay verde silencioso.
-- ============================================================

BEGIN;

-- ---- Datos mínimos ------------------------------------------
-- `whatsapp_config.user_id` es NOT NULL con FK a auth.users, y
-- `accounts.owner_user_id` igual, así que hacen falta dos usuarios de
-- verdad. Se crean aquí y la transacción entera se revierte al final.
INSERT INTO auth.users (id, email)
VALUES
  ('11111111-1111-4111-8111-111111111111', 'a@example.test'),
  ('22222222-2222-4222-8222-222222222222', 'b@example.test');

-- El disparador `on_auth_user_created` ya crea una cuenta y un perfil
-- por usuario (fase 0), y `idx_accounts_one_per_owner` impide una
-- segunda: se reutilizan las suyas en vez de inventar otras. Sus ids
-- son aleatorios, así que se capturan en variables de psql.
SELECT id AS acct_a FROM accounts
 WHERE owner_user_id = '11111111-1111-4111-8111-111111111111' \gset
SELECT id AS acct_b FROM accounts
 WHERE owner_user_id = '22222222-2222-4222-8222-222222222222' \gset

-- La empresa A conecta DOS números. Esto es lo que el UNIQUE(account_id)
-- de la 017 hacía imposible; si la 053 no lo hubiera retirado, el
-- segundo INSERT fallaría aquí mismo con 23505.
INSERT INTO whatsapp_config
  (id, account_id, user_id, phone_number_id, waba_id, access_token, status, is_default, label)
VALUES
  ('cfa00000-0000-4000-8000-00000000cfa1',
   :'acct_a',
   '11111111-1111-4111-8111-111111111111',
   'pn-sales', 'waba-a', 'enc:tok-sales', 'connected', TRUE, 'Ventas'),
  ('cfa00000-0000-4000-8000-00000000cfa2',
   :'acct_a',
   '11111111-1111-4111-8111-111111111111',
   'pn-support', 'waba-a', 'enc:tok-support', 'connected', FALSE, 'Soporte');

DO $$
BEGIN
  IF (SELECT count(*) FROM whatsapp_config
      WHERE account_id = (SELECT id FROM accounts WHERE owner_user_id = '11111111-1111-4111-8111-111111111111')) <> 2 THEN
    RAISE EXCEPTION 'la cuenta A no tiene dos números: el UNIQUE(account_id) de 017 sigue vivo';
  END IF;
  RAISE NOTICE 'OK 1 — una cuenta puede tener varios números (053 retiró UNIQUE(account_id))';
END $$;

-- ---- 2. Un solo predeterminado por cuenta -------------------
-- El índice parcial `whatsapp_config_one_default_per_account` es lo que
-- impide que dos escrituras concurrentes de «hacer predeterminado»
-- dejen la cuenta con dos. Que lo garantice la base y no la aplicación
-- es el punto: la aplicación hace DOS escrituras.
DO $$
BEGIN
  BEGIN
    UPDATE whatsapp_config SET is_default = TRUE
    WHERE id = 'cfa00000-0000-4000-8000-00000000cfa2';
    RAISE EXCEPTION 'se aceptaron DOS predeterminados en la misma cuenta';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 2 — el índice parcial rechaza un segundo predeterminado';
  END;
END $$;

-- …y el orden que SÍ acepta es limpiar antes de marcar, que es
-- exactamente lo que hace `promoteDefault` (src/lib/whatsapp/default-number.ts).
UPDATE whatsapp_config SET is_default = FALSE
WHERE account_id = :'acct_a' AND is_default;
UPDATE whatsapp_config SET is_default = TRUE
WHERE id = 'cfa00000-0000-4000-8000-00000000cfa2';

DO $$
BEGIN
  IF (SELECT count(*) FROM whatsapp_config
      WHERE account_id = (SELECT id FROM accounts WHERE owner_user_id = '11111111-1111-4111-8111-111111111111') AND is_default) <> 1 THEN
    RAISE EXCEPTION 'la promoción en dos pasos no dejó exactamente un predeterminado';
  END IF;
  RAISE NOTICE 'OK 3 — limpiar-y-marcar es el orden que el índice acepta';
END $$;

-- ---- 4. El UNIQUE global de la 013 sigue vivo ---------------
-- Es lo que hace que el webhook resuelva un único dueño por número. Si
-- se hubiera caído con el de la 017, dos cuentas podrían reclamar el
-- mismo número y todo lo entrante de las dos se descartaría (issue #136).
DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_config
      (account_id, user_id, phone_number_id, access_token, status)
    VALUES
      ((SELECT id FROM accounts WHERE owner_user_id = '22222222-2222-4222-8222-222222222222'),
       '22222222-2222-4222-8222-222222222222',
       'pn-sales', 'enc:tok-b', 'connected');
    RAISE EXCEPTION 'otra cuenta pudo reclamar un phone_number_id ya usado';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 4 — UNIQUE(phone_number_id) de la 013 sigue rechazando el número ajeno';
  END;
END $$;

-- ---- 5. Borrar un número NO borra el historial --------------
-- Las dos FK nuevas son ON DELETE SET NULL. Un CASCADE aquí borraría
-- conversaciones y campañas del cliente al desconectar un número (CP2).
INSERT INTO contacts (id, account_id, user_id, phone, name)
VALUES ('c0a00000-0000-4000-8000-0000000000c1',
        :'acct_a',
        '11111111-1111-4111-8111-111111111111',
        '+15551230000', 'Cliente');

INSERT INTO conversations (id, account_id, user_id, contact_id, whatsapp_config_id)
VALUES ('c0000000-0000-4000-8000-0000000000c1',
        :'acct_a',
        '11111111-1111-4111-8111-111111111111',
        'c0a00000-0000-4000-8000-0000000000c1',
        'cfa00000-0000-4000-8000-00000000cfa1');

INSERT INTO broadcasts
  (id, account_id, user_id, name, template_name, status, whatsapp_config_id)
VALUES ('b0000000-0000-4000-8000-0000000000b1',
        :'acct_a',
        '11111111-1111-4111-8111-111111111111',
        'Campaña', 'promo', 'sending',
        'cfa00000-0000-4000-8000-00000000cfa1');

DELETE FROM whatsapp_config WHERE id = 'cfa00000-0000-4000-8000-00000000cfa1';

DO $$
DECLARE
  conv_cfg UUID;
  bc_cfg   UUID;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM conversations
                 WHERE id = 'c0000000-0000-4000-8000-0000000000c1') THEN
    RAISE EXCEPTION 'CASCADE: borrar un número borró la conversación';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM broadcasts
                 WHERE id = 'b0000000-0000-4000-8000-0000000000b1') THEN
    RAISE EXCEPTION 'CASCADE: borrar un número borró la campaña';
  END IF;

  SELECT whatsapp_config_id INTO conv_cfg FROM conversations
   WHERE id = 'c0000000-0000-4000-8000-0000000000c1';
  SELECT whatsapp_config_id INTO bc_cfg FROM broadcasts
   WHERE id = 'b0000000-0000-4000-8000-0000000000b1';

  IF conv_cfg IS NOT NULL OR bc_cfg IS NOT NULL THEN
    RAISE EXCEPTION 'la FK no es ON DELETE SET NULL (conv=%, bc=%)', conv_cfg, bc_cfg;
  END IF;
  RAISE NOTICE 'OK 5 — desconectar un número deja vivas conversaciones y campañas, con la columna a NULL';
END $$;

-- ---- 6. El índice (account_id, contact_id) de la 036 se mantiene ----
-- Decisión de alcance: un contacto que escribe a dos números de la misma
-- empresa sigue teniendo UNA conversación.
DO $$
BEGIN
  BEGIN
    INSERT INTO conversations (account_id, user_id, contact_id)
    VALUES ((SELECT id FROM accounts WHERE owner_user_id = '11111111-1111-4111-8111-111111111111'),
            '11111111-1111-4111-8111-111111111111',
            'c0a00000-0000-4000-8000-0000000000c1');
    RAISE EXCEPTION 'se creó una segunda conversación para el mismo contacto: la 036 se perdió';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 6 — idx_conversations_account_contact sigue imponiendo una conversación por contacto';
  END;
END $$;

-- ---- 7. RLS de la 017: los n números son de toda la cuenta ----
-- La 017 filtra por `is_account_member(account_id)`, no por unicidad, así
-- que con varios números un miembro cualquiera los ve todos y un
-- extraño no ve ninguno. Se comprueba con el rol `authenticated` y un
-- `request.jwt.claims` falsificado, que es de donde sale `auth.uid()`.
-- Los perfiles ya existen y ya apuntan a su cuenta (mismo disparador);
-- solo se asegura el rol, que es lo que lee `is_account_member`.
UPDATE profiles SET account_role = 'owner'
 WHERE user_id IN ('11111111-1111-4111-8111-111111111111',
                   '22222222-2222-4222-8222-222222222222');

-- Un tercer número, para que «todos» sean dos de verdad tras el borrado.
INSERT INTO whatsapp_config
  (id, account_id, user_id, phone_number_id, waba_id, access_token, status, is_default)
VALUES
  ('cfa00000-0000-4000-8000-00000000cfa3',
   :'acct_a',
   '11111111-1111-4111-8111-111111111111',
   'pn-billing', 'waba-a', 'enc:tok-billing', 'connected', FALSE);

DO $$
DECLARE
  visible_to_a INT;
  visible_to_b INT;
BEGIN
  SET LOCAL ROLE authenticated;
  -- `auth.uid()` en esta imagen lee `request.jwt.claim.sub` (singular),
  -- no el JSON completo; ponerlo mal deja uid NULL y la RLS devuelve
  -- cero filas para todo el mundo, que es un falso verde.
  PERFORM set_config('request.jwt.claim.sub',
    '11111111-1111-4111-8111-111111111111', TRUE);
  SELECT count(*) INTO visible_to_a FROM whatsapp_config;

  PERFORM set_config('request.jwt.claim.sub',
    '22222222-2222-4222-8222-222222222222', TRUE);
  SELECT count(*) INTO visible_to_b FROM whatsapp_config;

  RESET ROLE;

  IF visible_to_a <> 2 THEN
    RAISE EXCEPTION 'un miembro de A ve % números en vez de 2', visible_to_a;
  END IF;
  IF visible_to_b <> 0 THEN
    RAISE EXCEPTION 'un miembro de B ve % números de A', visible_to_b;
  END IF;
  RAISE NOTICE 'OK 7 — la RLS de la 017 da los DOS números a la cuenta y ninguno a la otra';
END $$;

ROLLBACK;
