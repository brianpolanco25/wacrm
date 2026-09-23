-- Verificación de a7.2 (`tags-v1`) contra el Postgres local que crea
-- scripts/replay-migrations.sh. Ejecutar después del replay con:
--   KEEP=1 scripts/replay-migrations.sh <worktree>
--   docker exec -i <contenedor> psql -U postgres -h localhost -d postgres \
--     -v ON_ERROR_STOP=1 < progress/checks_tags-v1.sql
--
-- a7.2 no trae migración: se apoya en el esquema de 001 + 017. Lo que
-- comprueba este archivo es precisamente eso — que las tres promesas del
-- código sobre la base son ciertas en una base real, no en el doble en
-- memoria de los tests:
--
--   A. `DELETE /api/v1/tags/{id}` quita también sus `contact_tags`. No lo
--      hace una segunda consulta de la ruta: lo hace la FK
--      `contact_tags.tag_id → tags(id) ON DELETE CASCADE`. Si esa FK
--      dejara de cascadear, la ruta fallaría con violación de FK (o, peor,
--      dejaría uniones huérfanas) y ningún test con mocks lo vería.
--   B. `UNIQUE (contact_id, tag_id)` es lo que hace que reetiquetar sea un
--      no-op en vez de un segundo evento: `addContactTagIfAbsent` NO lee
--      antes de insertar, se apoya en el 23505. Sin la restricción habría
--      dos filas y dos `contact.tag_added` por la misma etiqueta.
--   C. `DELETE … RETURNING id` distingue borrar una fila de no borrar
--      ninguna. Es el `.select('id')` que añadió esta feature (hallazgo 2
--      de `review_webhooks-durable.md`) y de esa diferencia cuelga que
--      salga o no `contact.tag_removed`.
--   D. La base SÍ impide dos etiquetas que solo difieren en mayúsculas,
--      desde la migración 064 (`tags_account_lower_name_idx`). Cuando se
--      escribió este archivo no era así y el bloque afirmaba lo
--      contrario — con la nota de que había que cambiarlo el día que
--      llegara el índice. Ese día fue la 2.ª integración de la fase 7:
--      ahora el find-or-create de `POST /api/v1/tags` no solo compara en
--      minúsculas en Node, se apoya en el 23505 de la base para la
--      carrera que Node no puede ver.
--
-- Salida esperada: cuatro NOTICE «OK …» y ningún ERROR.

BEGIN;

-- ------------------------------------------------------------
-- Semilla: un usuario → su cuenta personal (la crea el trigger de alta),
-- un contacto, dos etiquetas y las dos uniones.
-- ------------------------------------------------------------
INSERT INTO auth.users (
  id, aud, role, email, raw_app_meta_data, raw_user_meta_data, created_at, updated_at
) VALUES
  ('41000000-0000-4000-8000-000000000001', 'authenticated', 'authenticated',
   'tags-a@example.test', '{}', '{"full_name":"Tags A"}', now(), now());

CREATE TEMP TABLE t_acc AS
SELECT (SELECT account_id FROM public.profiles
         WHERE user_id = '41000000-0000-4000-8000-000000000001') AS a;

INSERT INTO contacts (id, account_id, user_id, phone, name)
SELECT '42000000-0000-4000-8000-00000000000c', a,
       '41000000-0000-4000-8000-000000000001', '+15550000001', 'Cliente'
  FROM t_acc;

INSERT INTO tags (id, account_id, user_id, name, color)
SELECT '43000000-0000-4000-8000-000000000001', a,
       '41000000-0000-4000-8000-000000000001', 'VIP', '#222222' FROM t_acc;
INSERT INTO tags (id, account_id, user_id, name, color)
SELECT '43000000-0000-4000-8000-000000000002', a,
       '41000000-0000-4000-8000-000000000001', 'Moroso', '#333333' FROM t_acc;

INSERT INTO contact_tags (contact_id, tag_id) VALUES
  ('42000000-0000-4000-8000-00000000000c', '43000000-0000-4000-8000-000000000001'),
  ('42000000-0000-4000-8000-00000000000c', '43000000-0000-4000-8000-000000000002');

-- ------------------------------------------------------------
-- B. La restricción única. Va antes que el borrado porque necesita las
--    dos uniones vivas.
-- ------------------------------------------------------------
DO $$
DECLARE dup BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO contact_tags (contact_id, tag_id)
    VALUES ('42000000-0000-4000-8000-00000000000c',
            '43000000-0000-4000-8000-000000000001');
    dup := TRUE;
  EXCEPTION WHEN unique_violation THEN
    NULL; -- esperado: es el 23505 del que vive addContactTagIfAbsent
  END;

  IF dup THEN
    RAISE EXCEPTION 'B: la misma etiqueta entró dos veces en el mismo contacto';
  END IF;
  RAISE NOTICE 'OK B — UNIQUE(contact_id, tag_id): reetiquetar es un no-op, no un segundo evento';
END $$;

-- ------------------------------------------------------------
-- C. `DELETE … RETURNING id` sabe si quitó algo. Dos borrados seguidos
--    de la MISMA unión: el primero devuelve una fila, el segundo cero.
-- ------------------------------------------------------------
DO $$
DECLARE first_rows INT; second_rows INT;
BEGIN
  WITH gone AS (
    DELETE FROM contact_tags
     WHERE contact_id = '42000000-0000-4000-8000-00000000000c'
       AND tag_id = '43000000-0000-4000-8000-000000000002'
    RETURNING id
  ) SELECT count(*) INTO first_rows FROM gone;

  WITH gone AS (
    DELETE FROM contact_tags
     WHERE contact_id = '42000000-0000-4000-8000-00000000000c'
       AND tag_id = '43000000-0000-4000-8000-000000000002'
    RETURNING id
  ) SELECT count(*) INTO second_rows FROM gone;

  IF first_rows <> 1 THEN
    RAISE EXCEPTION 'C: el primer DELETE devolvió % filas, se esperaba 1', first_rows;
  END IF;
  IF second_rows <> 0 THEN
    RAISE EXCEPTION 'C: el DELETE repetido devolvió % filas, se esperaba 0', second_rows;
  END IF;
  RAISE NOTICE 'OK C — RETURNING distingue quitar una fila de no quitar ninguna (base de contact.tag_removed)';
END $$;

-- ------------------------------------------------------------
-- A. La cascada. Borrar la etiqueta se lleva sus uniones y deja en pie
--    el contacto y el resto del catálogo.
-- ------------------------------------------------------------
DO $$
DECLARE joins_left INT; contact_left INT; tags_left INT;
BEGIN
  -- Vuelve a poner la unión que C acaba de quitar, para borrar una
  -- etiqueta que SÍ está puesta en alguien.
  INSERT INTO contact_tags (contact_id, tag_id)
  VALUES ('42000000-0000-4000-8000-00000000000c',
          '43000000-0000-4000-8000-000000000002');

  DELETE FROM tags WHERE id = '43000000-0000-4000-8000-000000000001';

  SELECT count(*) INTO joins_left FROM contact_tags
   WHERE tag_id = '43000000-0000-4000-8000-000000000001';
  SELECT count(*) INTO contact_left FROM contacts
   WHERE id = '42000000-0000-4000-8000-00000000000c';
  SELECT count(*) INTO tags_left FROM contact_tags
   WHERE contact_id = '42000000-0000-4000-8000-00000000000c';

  IF joins_left <> 0 THEN
    RAISE EXCEPTION 'A: quedaron % uniones huérfanas de la etiqueta borrada', joins_left;
  END IF;
  IF contact_left <> 1 THEN
    RAISE EXCEPTION 'A: borrar la etiqueta se llevó por delante el contacto';
  END IF;
  IF tags_left <> 1 THEN
    RAISE EXCEPTION 'A: el contacto quedó con % etiquetas en vez de 1', tags_left;
  END IF;
  RAISE NOTICE 'OK A — la FK ON DELETE CASCADE limpia contact_tags y no toca nada más';
END $$;

-- ------------------------------------------------------------
-- D. La base rechaza «moroso» junto a «Moroso» en la misma cuenta
--    (índice único funcional de la migración 064). De ese 23505 vive el
--    find-or-create: perder la carrera contra otra petición —o contra el
--    panel, que inserta directo— devuelve 200 con la fila que ganó, no
--    un 500 ni una segunda fila. Entre cuentas distintas no hay estorbo.
-- ------------------------------------------------------------
DO $$
DECLARE homonyms INT; colo BOOLEAN := FALSE;
BEGIN
  BEGIN
    INSERT INTO tags (account_id, user_id, name, color)
    SELECT a, '41000000-0000-4000-8000-000000000001', 'moroso', '#444444' FROM t_acc;
    colo := TRUE;
  EXCEPTION WHEN unique_violation THEN
    NULL; -- esperado: es el 23505 que findOrCreateTag lee como «ya existía»
  END;

  IF colo THEN
    RAISE EXCEPTION 'D: la base aceptó un segundo «moroso» en la misma cuenta';
  END IF;

  SELECT count(*) INTO homonyms FROM tags
   WHERE lower(name) = 'moroso'
     AND account_id = (SELECT a FROM t_acc);

  IF homonyms <> 1 THEN
    RAISE EXCEPTION 'D: se esperaba 1 fila con ese nombre, hay %', homonyms;
  END IF;
  RAISE NOTICE 'OK D — un nombre por cuenta lo impone la base (064); el 23505 es el find-or-create';
END $$;

ROLLBACK;
