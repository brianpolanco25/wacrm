-- ============================================================
-- 064_tags_unique_name.sql — Fase 7 §2, deuda 2 de
-- `progress/review_tags-v1.md`: un nombre de etiqueta, una fila.
--
-- Qué problema resuelve
--   `POST /api/v1/tags` es find-or-create: lee si la cuenta ya tiene una
--   etiqueta con ese nombre (insensible a mayúsculas) y, si no, la
--   inserta. Entre la lectura y la escritura no había nada que impidiera
--   que dos peticiones simultáneas —o el panel y la API a la vez— vieran
--   las dos «no existe» y crearan dos filas. `Idempotency-Key` tapa el
--   reintento del MISMO cliente, no la concurrencia real.
--
--   El único sitio donde eso se puede arreglar de verdad es la base:
--   un índice único funcional sobre `(account_id, lower(name))`. A
--   partir de aquí el segundo INSERT falla con 23505 y la aplicación lo
--   trata como «ya existía» (find-or-create, 200), que es exactamente lo
--   que el cliente pidió.
--
-- Por qué `lower(name)` y no `lower(trim(name))`
--   Todas las escrituras del repo ya guardan el nombre recortado
--   (`tags.ts`, `resolve-import-tags.ts`, `tag-manager.tsx`), así que el
--   `trim` no aporta y sí complica: un índice sobre una expresión solo
--   se usa si la consulta escribe esa MISMA expresión, y `lower(name)`
--   es la forma que ya usa el código para comparar (`tagKey`).
--
-- Duplicados que ya existan: se fusionan ANTES de crear el índice
--   La tabla lleva versiones en producción sin esta restricción, así que
--   puede haber pares `Moroso`/`moroso` en la misma cuenta. Crear el
--   índice sin más fallaría y dejaría la migración —y el despliegue— a
--   medias. El bloque de abajo los fusiona con una regla explícita:
--
--     * Superviviente: la fila MÁS ANTIGUA del grupo (`created_at`
--       ascendente, `id` como desempate estable). Es la que llevan más
--       tiempo viendo los agentes y la que tiene más probabilidades de
--       estar referida desde una automatización o un flujo.
--     * Sus uniones se mueven: `INSERT … ON CONFLICT DO NOTHING` sobre
--       `contact_tags`, que ya es única por `(contact_id, tag_id)`. Un
--       contacto que tuviera las dos variantes se queda con una sola
--       unión, sin error. Se conserva el `created_at` de la unión más
--       antigua, no el de hoy: cuándo se etiquetó al contacto es dato.
--     * Las referencias por id que viven en JSON —`automations`,
--       `automation_steps`, `flows`, `flow_nodes`— se reapuntan al
--       superviviente. Sin esto, un disparador «se añadió la etiqueta X»
--       o un paso «poner la etiqueta X» dejaría de encontrar su etiqueta
--       y fallaría en silencio: la FK no los protege porque son ids
--       dentro de un `jsonb`, no columnas.
--     * Y solo entonces se borran las demás (la FK
--       `contact_tags.tag_id → tags.id ON DELETE CASCADE` se lleva lo
--       que haya quedado).
--
-- Idempotente — se puede re-ejecutar: la fusión no encuentra grupos la
-- segunda vez (el índice, además, ya no los permitiría) y el índice se
-- crea con IF NOT EXISTS.
-- ============================================================

DO $$
DECLARE
  grupo      RECORD;
  perdedores uuid[];
  fusionados int := 0;
BEGIN
  FOR grupo IN
    SELECT
      account_id,
      lower(name) AS clave,
      (array_agg(id ORDER BY created_at ASC NULLS LAST, id ASC))[1] AS superviviente,
      array_agg(id ORDER BY created_at ASC NULLS LAST, id ASC) AS ids
    FROM tags
    -- `account_id` quedó nullable en 017; una fila sin cuenta no colisiona
    -- con nada en un índice único (NULL nunca es igual a NULL), así que
    -- tampoco hay nada que fusionar.
    WHERE account_id IS NOT NULL
    GROUP BY account_id, lower(name)
    HAVING count(*) > 1
  LOOP
    perdedores := grupo.ids[2:];

    -- 1. Mover las uniones al superviviente. El contacto que tuviera las
    --    dos variantes ya tiene la del superviviente: ON CONFLICT la
    --    ignora en vez de romper la migración.
    INSERT INTO contact_tags (contact_id, tag_id, created_at)
    SELECT ct.contact_id, grupo.superviviente, min(ct.created_at)
    FROM contact_tags ct
    WHERE ct.tag_id = ANY(perdedores)
    GROUP BY ct.contact_id
    ON CONFLICT (contact_id, tag_id) DO NOTHING;

    -- 2. Reapuntar las referencias por id que viven dentro de un jsonb.
    UPDATE automations
       SET trigger_config = jsonb_set(
             trigger_config, '{tag_id}', to_jsonb(grupo.superviviente::text)
           )
     WHERE trigger_config->>'tag_id' = ANY(perdedores::text[]);

    UPDATE automation_steps
       SET step_config = jsonb_set(
             step_config, '{tag_id}', to_jsonb(grupo.superviviente::text)
           )
     WHERE step_config->>'tag_id' = ANY(perdedores::text[]);

    UPDATE flows
       SET trigger_config = jsonb_set(
             trigger_config, '{tag_id}', to_jsonb(grupo.superviviente::text)
           )
     WHERE trigger_config->>'tag_id' = ANY(perdedores::text[]);

    UPDATE flow_nodes
       SET config = jsonb_set(
             config, '{tag_id}', to_jsonb(grupo.superviviente::text)
           )
     WHERE config->>'tag_id' = ANY(perdedores::text[]);

    -- 3. Y fuera las duplicadas.
    DELETE FROM tags WHERE id = ANY(perdedores);

    fusionados := fusionados + array_length(perdedores, 1);
  END LOOP;

  IF fusionados > 0 THEN
    RAISE NOTICE '064: % etiqueta(s) duplicada(s) fusionada(s) por nombre', fusionados;
  END IF;
END
$$;

-- La restricción propiamente dicha. Índice y no `ADD CONSTRAINT UNIQUE`
-- porque es sobre una EXPRESIÓN (`lower(name)`), que la sintaxis de
-- constraint no admite. `IF NOT EXISTS` lo hace re-ejecutable; no se usa
-- CONCURRENTLY porque las migraciones corren dentro de una transacción.
CREATE UNIQUE INDEX IF NOT EXISTS tags_account_lower_name_idx
  ON tags (account_id, lower(name));

COMMENT ON INDEX tags_account_lower_name_idx IS
  'Un nombre de etiqueta por cuenta, insensible a mayúsculas (migración '
  '064). Es lo que convierte el find-or-create de POST /api/v1/tags en '
  'seguro ante concurrencia: el segundo INSERT recibe 23505 y la '
  'aplicación lo lee como "ya existía".';
