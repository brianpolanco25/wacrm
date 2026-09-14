-- ============================================================
-- checks_whatsapp-bsuid.sql — comprobaciones contra Postgres real de
-- la migración 060 (fase 6 §5).
--
-- Cómo se corre:
--
--   cd /Users/brian/Documents/Dev/projects/wacrm/.claude/worktrees/producto
--   KEEP=1 /Users/brian/Documents/Dev/projects/wacrm/scripts/replay-migrations.sh "$(pwd)"
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 \
--     < /Users/brian/Documents/Dev/projects/wacrm/progress/checks_whatsapp-bsuid.sql
--
-- Todo ocurre dentro de una transacción que termina en ROLLBACK: la
-- base queda como estaba. Es SQL de superusuario comprobando el
-- esquema, no la app: la RLS no participa (la tenencia la cubren los
-- tests de fuga en vitest).
--
-- Las cuentas NO se insertan a mano: `on_auth_user_created` (trigger
-- sobre auth.users) crea cuenta + perfil + membresía por cada alta, y
-- `idx_accounts_one_per_owner` (017) admite una sola cuenta por dueño.
-- Por eso el guion da de alta dos usuarios y luego LEE las cuentas que
-- el trigger creó, guardándolas en una tabla temporal.
-- ============================================================

BEGIN;

INSERT INTO auth.users (id, email, instance_id, aud, role)
VALUES ('00000000-0000-0000-0000-0000000000a1', 'bsuid@example.test',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated'),
       ('00000000-0000-0000-0000-0000000000a2', 'vecina@example.test',
        '00000000-0000-0000-0000-000000000000', 'authenticated', 'authenticated');

CREATE TEMP TABLE ctx AS
SELECT 'cuenta1' AS k, id AS v FROM accounts
WHERE owner_user_id = '00000000-0000-0000-0000-0000000000a1'
UNION ALL
SELECT 'cuenta2', id FROM accounts
WHERE owner_user_id = '00000000-0000-0000-0000-0000000000a2';

DO $$
BEGIN
  IF (SELECT count(*) FROM ctx) <> 2 THEN
    RAISE EXCEPTION 'PREPARACIÓN FALLÓ: el trigger no creó las dos cuentas de laboratorio';
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 1) Alta por BSUID sin teléfono.
--    Es el caso nuevo: Meta omite `from`/`wa_id` y solo tenemos el
--    BSUID y el nombre de usuario.
-- ------------------------------------------------------------
INSERT INTO contacts (id, account_id, user_id, wa_user_id, wa_username, name)
VALUES ('00000000-0000-0000-0000-0000000000c1',
        (SELECT v FROM ctx WHERE k = 'cuenta1'),
        '00000000-0000-0000-0000-0000000000a1',
        'US.1349700000000001', 'anita', 'Ana');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = '00000000-0000-0000-0000-0000000000c1'
      AND phone IS NULL
      AND phone_normalized IS NULL
      AND wa_user_id = 'US.1349700000000001'
      AND wa_username = 'anita'
  ) THEN
    RAISE EXCEPTION 'CHECK 1 FALLÓ: no se pudo dar de alta un contacto solo con BSUID';
  END IF;
  RAISE NOTICE 'CHECK 1 OK — alta por BSUID sin teléfono';
END
$$;

-- ------------------------------------------------------------
-- 2) Dos contactos sin teléfono en la misma cuenta conviven.
--    El índice único de la 022 es parcial sobre `phone_normalized <> ''`
--    y NULL no lo satisface: si no fuera así, el segundo contacto sin
--    teléfono de cada cuenta sería imposible.
-- ------------------------------------------------------------
INSERT INTO contacts (id, account_id, user_id, wa_user_id, wa_username, name)
VALUES ('00000000-0000-0000-0000-0000000000c2',
        (SELECT v FROM ctx WHERE k = 'cuenta1'),
        '00000000-0000-0000-0000-0000000000a1',
        'US.1349700000000002', 'bruno', 'Bruno');

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM contacts
  WHERE account_id = (SELECT v FROM ctx WHERE k = 'cuenta1') AND phone IS NULL;
  IF v_n <> 2 THEN
    RAISE EXCEPTION 'CHECK 2 FALLÓ: se esperaban 2 contactos sin teléfono, hay %', v_n;
  END IF;
  RAISE NOTICE 'CHECK 2 OK — varios contactos sin teléfono por cuenta';
END
$$;

-- ------------------------------------------------------------
-- 3) El mismo BSUID no se puede partir en dos contactos de la misma
--    cuenta: es exactamente el duplicado que el webhook debe evitar y
--    el índice único parcial es la red de seguridad.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO contacts (account_id, user_id, wa_user_id, name)
    VALUES ((SELECT v FROM ctx WHERE k = 'cuenta1'),
            '00000000-0000-0000-0000-0000000000a1',
            'US.1349700000000001', 'Ana duplicada');
    RAISE EXCEPTION 'CHECK 3 FALLÓ: se aceptó un BSUID duplicado en la misma cuenta';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'CHECK 3 OK — BSUID duplicado rechazado (23505)';
  END;
END
$$;

-- ------------------------------------------------------------
-- 4) El MISMO BSUID en OTRA cuenta sí es válido: el índice es
--    (account_id, wa_user_id), y el BSUID de Meta es único por par
--    portafolio/usuario, no global.
-- ------------------------------------------------------------
INSERT INTO contacts (id, account_id, user_id, wa_user_id, name)
VALUES ('00000000-0000-0000-0000-0000000000c3',
        (SELECT v FROM ctx WHERE k = 'cuenta2'),
        '00000000-0000-0000-0000-0000000000a2',
        'US.1349700000000001', 'Ana en la cuenta vecina');

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contacts WHERE id = '00000000-0000-0000-0000-0000000000c3'
  ) THEN
    RAISE EXCEPTION 'CHECK 4 FALLÓ: el mismo BSUID no se aceptó en otra cuenta';
  END IF;
  RAISE NOTICE 'CHECK 4 OK — el BSUID es único POR CUENTA, no global';
END
$$;

-- ------------------------------------------------------------
-- 5) Casado de un contacto por teléfono al que llega su BSUID, sin
--    duplicar: el contacto de siempre (con teléfono) recibe el BSUID y
--    el username en un UPDATE y sigue siendo una sola fila.
-- ------------------------------------------------------------
INSERT INTO contacts (id, account_id, user_id, phone, name)
VALUES ('00000000-0000-0000-0000-0000000000c4',
        (SELECT v FROM ctx WHERE k = 'cuenta1'),
        '00000000-0000-0000-0000-0000000000a1',
        '34600111222', 'Carlos');

UPDATE contacts
SET wa_user_id = 'ES.1349700000000004', wa_username = 'carlos'
WHERE id = '00000000-0000-0000-0000-0000000000c4';

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n FROM contacts
  WHERE account_id = (SELECT v FROM ctx WHERE k = 'cuenta1')
    AND (phone_normalized = '34600111222' OR wa_user_id = 'ES.1349700000000004');
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CHECK 5 FALLÓ: el casado por teléfono dejó % filas', v_n;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = '00000000-0000-0000-0000-0000000000c4'
      AND phone = '34600111222'
      AND wa_user_id = 'ES.1349700000000004'
      AND wa_username = 'carlos'
  ) THEN
    RAISE EXCEPTION 'CHECK 5 FALLÓ: el contacto por teléfono no conserva ambas identidades';
  END IF;
  RAISE NOTICE 'CHECK 5 OK — teléfono + BSUID en una sola fila';
END
$$;

-- ------------------------------------------------------------
-- 6) El camino inverso: un contacto nacido por BSUID recibe el
--    teléfono cuando Meta lo incluye. `phone_normalized` (generada)
--    se rellena sola y la fila entra en el índice único de la 022.
-- ------------------------------------------------------------
UPDATE contacts SET phone = '+34 600 333 444'
WHERE id = '00000000-0000-0000-0000-0000000000c1';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM contacts
    WHERE id = '00000000-0000-0000-0000-0000000000c1'
      AND phone_normalized = '34600333444'
  ) THEN
    RAISE EXCEPTION 'CHECK 6 FALLÓ: phone_normalized no se regeneró al completar el teléfono';
  END IF;
  RAISE NOTICE 'CHECK 6 OK — teléfono completado a posteriori';
END
$$;

-- ------------------------------------------------------------
-- 7) Rechazo de una fila sin ninguna de las dos identidades.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO contacts (account_id, user_id, name)
    VALUES ((SELECT v FROM ctx WHERE k = 'cuenta1'),
            '00000000-0000-0000-0000-0000000000a1',
            'Fantasma');
    RAISE EXCEPTION 'CHECK 7 FALLÓ: se aceptó un contacto sin teléfono ni BSUID';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'CHECK 7 OK — contacto sin identidad rechazado (23514)';
  END;
END
$$;

-- ------------------------------------------------------------
-- 8) Vaciar el teléfono de un contacto que tampoco tiene BSUID está
--    prohibido: la invariante se comprueba también en UPDATE.
-- ------------------------------------------------------------
INSERT INTO contacts (id, account_id, user_id, phone, name)
VALUES ('00000000-0000-0000-0000-0000000000c5',
        (SELECT v FROM ctx WHERE k = 'cuenta1'),
        '00000000-0000-0000-0000-0000000000a1',
        '34600555666', 'Dolores');

DO $$
BEGIN
  BEGIN
    UPDATE contacts SET phone = NULL
    WHERE id = '00000000-0000-0000-0000-0000000000c5';
    RAISE EXCEPTION 'CHECK 8 FALLÓ: se pudo dejar un contacto sin ninguna identidad';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'CHECK 8 OK — el UPDATE que deja la fila sin identidad se rechaza';
  END;
END
$$;

-- ------------------------------------------------------------
-- 9) La búsqueda de la lista de contactos encuentra por username.
--    `filter_contacts_by_tags` es SECURITY INVOKER: como superusuario
--    la RLS no aplica, así que lo que se comprueba aquí es el filtro
--    de texto, no la tenencia.
-- ------------------------------------------------------------
INSERT INTO tags (id, user_id, account_id, name, color)
VALUES ('00000000-0000-0000-0000-0000000000d1',
        '00000000-0000-0000-0000-0000000000a1',
        (SELECT v FROM ctx WHERE k = 'cuenta1'), 'vip', '#000000');

INSERT INTO contact_tags (contact_id, tag_id)
VALUES ('00000000-0000-0000-0000-0000000000c2',
        '00000000-0000-0000-0000-0000000000d1');

DO $$
DECLARE v_n INT;
BEGIN
  SELECT count(*) INTO v_n
  FROM public.filter_contacts_by_tags(
    ARRAY['00000000-0000-0000-0000-0000000000d1']::uuid[], 'brun', 25, 0);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CHECK 9 FALLÓ: buscar por username devolvió % filas', v_n;
  END IF;

  -- Con el arroba delante también, que es como lo escribe el usuario.
  SELECT count(*) INTO v_n
  FROM public.filter_contacts_by_tags(
    ARRAY['00000000-0000-0000-0000-0000000000d1']::uuid[], '@bruno', 25, 0);
  IF v_n <> 1 THEN
    RAISE EXCEPTION 'CHECK 9 FALLÓ: buscar "@bruno" devolvió % filas', v_n;
  END IF;
  RAISE NOTICE 'CHECK 9 OK — búsqueda por nombre de usuario';
END
$$;

ROLLBACK;
