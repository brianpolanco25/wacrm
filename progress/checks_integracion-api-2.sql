-- Verificación de la 2.ª integración de la fase 7 (`api/recursos` +
-- `api/templates`) contra el Postgres local de scripts/replay-migrations.sh.
--
-- Qué comprueba: la migración 064 (`tags_unique_name`), que es la única
-- pieza nueva con SQL. Y no comprueba el caso fácil —una base limpia no
-- tiene duplicados, así que el replay no prueba nada— sino el que de
-- verdad puede tumbar un despliegue: **una base que YA tiene etiquetas
-- homónimas** (misma cuenta, mismo nombre en distinta caja). Si la
-- fusión previa no existiera o se dejara algo, el `CREATE UNIQUE INDEX`
-- fallaría y la migración —y el arranque— se quedarían a medias.
--
-- Cómo se ejecuta (la migración se copia dentro del contenedor para
-- poder re-ejecutarla desde aquí, en vez de duplicar su SQL y que se
-- desvíe):
--
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker cp <worktree>/supabase/migrations/064_tags_unique_name.sql \
--     <contenedor>:/tmp/064_tags_unique_name.sql
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_integracion-api-2.sql
--
-- Bloques:
--   A. Duplicados previos: tres etiquetas homónimas (`Moroso`, `moroso`,
--      `MOROSO`) sobreviven a la migración como UNA, la más antigua.
--   B. Las uniones se mudan al superviviente sin perder contactos y sin
--      chocar con `UNIQUE(contact_id, tag_id)` cuando un contacto tenía
--      dos de las variantes.
--   C. Las referencias por id que viven en jsonb (automatizaciones,
--      pasos, flujos, nodos) se reapuntan: sin esto un disparador «se
--      añadió la etiqueta X» quedaría mirando a una fila borrada.
--   D. Ya con el índice puesto, la base rechaza el homónimo: es el 23505
--      del que vive el find-or-create de `POST /api/v1/tags`.
--   E. Re-ejecutar la migración entera no rompe nada (idempotencia).
--
-- Salida esperada: cinco NOTICE «OK …» y ningún ERROR.

BEGIN;

-- ------------------------------------------------------------
-- Semilla. El estado PREVIO a 064: se tira el índice para recrear una
-- base como las que ya están en producción, con homónimos dentro.
-- ------------------------------------------------------------
DROP INDEX IF EXISTS tags_account_lower_name_idx;

INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('64000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'dedup@example.test', '{}', '{"full_name":"Dedup"}', now(), now());

CREATE TEMP TABLE t_acc AS
SELECT (SELECT account_id FROM public.profiles
         WHERE user_id = '64000000-0000-4000-8000-000000000001') AS a;

INSERT INTO contacts (id, account_id, user_id, phone, name)
SELECT '64000000-0000-4000-8000-0000000000c1', a,
       '64000000-0000-4000-8000-000000000001', '+15550000101', 'Uno' FROM t_acc;
INSERT INTO contacts (id, account_id, user_id, phone, name)
SELECT '64000000-0000-4000-8000-0000000000c2', a,
       '64000000-0000-4000-8000-000000000001', '+15550000102', 'Dos' FROM t_acc;

-- Tres homónimas. La MÁS ANTIGUA (T1) es la que debe sobrevivir; se
-- siembran en desorden para que no gane por casualidad de inserción.
INSERT INTO tags (id, account_id, user_id, name, color, created_at)
SELECT '64000000-0000-4000-8000-00000000000b', a,
       '64000000-0000-4000-8000-000000000001', 'moroso', '#222222',
       '2026-02-01T00:00:00Z' FROM t_acc;
INSERT INTO tags (id, account_id, user_id, name, color, created_at)
SELECT '64000000-0000-4000-8000-00000000000a', a,
       '64000000-0000-4000-8000-000000000001', 'Moroso', '#111111',
       '2026-01-01T00:00:00Z' FROM t_acc;
INSERT INTO tags (id, account_id, user_id, name, color, created_at)
SELECT '64000000-0000-4000-8000-00000000000c', a,
       '64000000-0000-4000-8000-000000000001', 'MOROSO', '#333333',
       '2026-03-01T00:00:00Z' FROM t_acc;
-- Una etiqueta sin homónimo, para comprobar que la fusión no se lleva
-- por delante lo que no toca.
INSERT INTO tags (id, account_id, user_id, name, color, created_at)
SELECT '64000000-0000-4000-8000-00000000000d', a,
       '64000000-0000-4000-8000-000000000001', 'VIP', '#444444',
       '2026-01-15T00:00:00Z' FROM t_acc;

-- Contacto 1: tiene la superviviente Y una duplicada → la mudanza tiene
-- que chocar con UNIQUE(contact_id, tag_id) y no romperse.
-- Contacto 2: solo duplicadas → sus uniones se mudan de verdad.
INSERT INTO contact_tags (contact_id, tag_id, created_at) VALUES
  ('64000000-0000-4000-8000-0000000000c1',
   '64000000-0000-4000-8000-00000000000a', '2026-04-01T00:00:00Z'),
  ('64000000-0000-4000-8000-0000000000c1',
   '64000000-0000-4000-8000-00000000000b', '2026-04-02T00:00:00Z'),
  ('64000000-0000-4000-8000-0000000000c2',
   '64000000-0000-4000-8000-00000000000b', '2026-04-03T00:00:00Z'),
  ('64000000-0000-4000-8000-0000000000c2',
   '64000000-0000-4000-8000-00000000000c', '2026-04-04T00:00:00Z');

-- Referencias por id dentro de jsonb, apuntando a las que van a morir.
INSERT INTO automations (id, account_id, user_id, name, trigger_type, trigger_config)
SELECT '64000000-0000-4000-8000-0000000000f1', a,
       '64000000-0000-4000-8000-000000000001', 'Al etiquetar', 'tag_added',
       '{"tag_id":"64000000-0000-4000-8000-00000000000b"}'::jsonb FROM t_acc;

INSERT INTO automation_steps (id, automation_id, step_type, step_config, position)
VALUES ('64000000-0000-4000-8000-0000000000f2',
        '64000000-0000-4000-8000-0000000000f1', 'add_tag',
        '{"tag_id":"64000000-0000-4000-8000-00000000000c"}'::jsonb, 0);

INSERT INTO flows (id, account_id, user_id, name, trigger_type, trigger_config)
SELECT '64000000-0000-4000-8000-0000000000f3', a,
       '64000000-0000-4000-8000-000000000001', 'Flujo', 'manual',
       '{}'::jsonb FROM t_acc;

INSERT INTO flow_nodes (id, flow_id, node_key, node_type, config)
VALUES ('64000000-0000-4000-8000-0000000000f4',
        '64000000-0000-4000-8000-0000000000f3', 'n1', 'set_tag',
        '{"mode":"add","tag_id":"64000000-0000-4000-8000-00000000000c"}'::jsonb);

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM tags
   WHERE lower(name) = 'moroso' AND account_id = (SELECT a FROM t_acc);
  IF n <> 3 THEN
    RAISE EXCEPTION 'semilla: se esperaban 3 homónimas antes de 064, hay %', n;
  END IF;
END $$;

-- ------------------------------------------------------------
-- La migración, tal cual está en el repo.
-- ------------------------------------------------------------
\i /tmp/064_tags_unique_name.sql

-- ------------------------------------------------------------
-- A. Una sola fila, y es la más antigua.
-- ------------------------------------------------------------
DO $$
DECLARE n INT; survivor uuid; survivor_name TEXT; otras INT;
BEGIN
  SELECT count(*) INTO n FROM tags
   WHERE lower(name) = 'moroso' AND account_id = (SELECT a FROM t_acc);
  IF n <> 1 THEN
    RAISE EXCEPTION 'A: quedaron % filas homónimas, se esperaba 1', n;
  END IF;

  SELECT id, name INTO survivor, survivor_name FROM tags
   WHERE lower(name) = 'moroso' AND account_id = (SELECT a FROM t_acc);
  IF survivor <> '64000000-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'A: sobrevivió % en vez de la más antigua', survivor;
  END IF;
  IF survivor_name <> 'Moroso' THEN
    RAISE EXCEPTION 'A: el nombre superviviente es «%», se esperaba «Moroso»', survivor_name;
  END IF;

  SELECT count(*) INTO otras FROM tags
   WHERE account_id = (SELECT a FROM t_acc) AND name = 'VIP';
  IF otras <> 1 THEN
    RAISE EXCEPTION 'A: la fusión se llevó por delante una etiqueta sin homónimo';
  END IF;
  RAISE NOTICE 'OK A — tres homónimas → una, la más antigua, y el resto del catálogo intacto';
END $$;

-- ------------------------------------------------------------
-- B. Las uniones. Ningún contacto pierde la etiqueta y ninguno la tiene
--    dos veces.
-- ------------------------------------------------------------
DO $$
DECLARE c1 INT; c2 INT; huerfanas INT; desde TIMESTAMPTZ;
BEGIN
  SELECT count(*) INTO c1 FROM contact_tags
   WHERE contact_id = '64000000-0000-4000-8000-0000000000c1';
  SELECT count(*) INTO c2 FROM contact_tags
   WHERE contact_id = '64000000-0000-4000-8000-0000000000c2';
  IF c1 <> 1 OR c2 <> 1 THEN
    RAISE EXCEPTION 'B: uniones tras la fusión c1=% c2=%, se esperaba 1 y 1', c1, c2;
  END IF;

  SELECT count(*) INTO huerfanas FROM contact_tags ct
   WHERE NOT EXISTS (SELECT 1 FROM tags t WHERE t.id = ct.tag_id);
  IF huerfanas <> 0 THEN
    RAISE EXCEPTION 'B: quedaron % uniones apuntando a una etiqueta borrada', huerfanas;
  END IF;

  -- El contacto 2 solo tenía duplicadas: su unión se mudó de verdad, y
  -- conserva la fecha de la más antigua (cuándo se etiquetó es dato).
  SELECT created_at INTO desde FROM contact_tags
   WHERE contact_id = '64000000-0000-4000-8000-0000000000c2';
  IF desde <> '2026-04-03T00:00:00Z'::timestamptz THEN
    RAISE EXCEPTION 'B: la unión mudada perdió su fecha (quedó %)', desde;
  END IF;
  RAISE NOTICE 'OK B — las uniones se mudan al superviviente, sin duplicar ni huérfanas';
END $$;

-- ------------------------------------------------------------
-- C. Las referencias por id en jsonb.
-- ------------------------------------------------------------
DO $$
DECLARE trig TEXT; paso TEXT; nodo TEXT;
BEGIN
  SELECT trigger_config->>'tag_id' INTO trig FROM automations
   WHERE id = '64000000-0000-4000-8000-0000000000f1';
  SELECT step_config->>'tag_id' INTO paso FROM automation_steps
   WHERE id = '64000000-0000-4000-8000-0000000000f2';
  SELECT config->>'tag_id' INTO nodo FROM flow_nodes
   WHERE id = '64000000-0000-4000-8000-0000000000f4';

  IF trig <> '64000000-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'C: el disparador quedó apuntando a %', trig;
  END IF;
  IF paso <> '64000000-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'C: el paso quedó apuntando a %', paso;
  END IF;
  IF nodo <> '64000000-0000-4000-8000-00000000000a' THEN
    RAISE EXCEPTION 'C: el nodo del flujo quedó apuntando a %', nodo;
  END IF;
  RAISE NOTICE 'OK C — automatizaciones, pasos y nodos siguen apuntando a una etiqueta viva';
END $$;

-- ------------------------------------------------------------
-- D. El índice ya impide el homónimo. Es la restricción de la que vive
--    el find-or-create de la API (23505 → «ya existía», 200).
-- ------------------------------------------------------------
DO $$
DECLARE colo BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO tags (account_id, user_id, name, color)
    SELECT a, '64000000-0000-4000-8000-000000000001', 'MoRoSo', '#555555' FROM t_acc;
    colo := TRUE;
  EXCEPTION WHEN unique_violation THEN
    NULL; -- esperado
  END;
  IF colo THEN
    RAISE EXCEPTION 'D: la base aceptó un cuarto «moroso»';
  END IF;

  -- Y otra cuenta SÍ puede llamar igual a la suya: la unicidad es por
  -- cuenta, no global.
  INSERT INTO auth.users (
    id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
  ) VALUES
    ('64000000-0000-4000-8000-000000000002', 'authenticated', 'authenticated',
     'dedup-b@example.test', '{}', '{"full_name":"Dedup B"}', now(), now());
  INSERT INTO tags (account_id, user_id, name, color)
  SELECT (SELECT account_id FROM public.profiles
           WHERE user_id = '64000000-0000-4000-8000-000000000002'),
         '64000000-0000-4000-8000-000000000002', 'moroso', '#666666';

  RAISE NOTICE 'OK D — un nombre por cuenta (23505 en el homónimo), y las cuentas no se estorban';
END $$;

-- ------------------------------------------------------------
-- E. Idempotencia: la migración entera, otra vez.
-- ------------------------------------------------------------
\i /tmp/064_tags_unique_name.sql

DO $$
DECLARE n INT;
BEGIN
  SELECT count(*) INTO n FROM tags
   WHERE lower(name) = 'moroso' AND account_id = (SELECT a FROM t_acc);
  IF n <> 1 THEN
    RAISE EXCEPTION 'E: tras re-ejecutar quedan % filas, se esperaba 1', n;
  END IF;
  RAISE NOTICE 'OK E — re-ejecutar 064 no falla ni cambia nada';
END $$;

ROLLBACK;
