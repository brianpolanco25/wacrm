-- ============================================================
-- 060_whatsapp_bsuid.sql — Fase 6 (producto): identidad de WhatsApp
-- por BSUID (progress/spec_producto.md §5)
--
-- Desde abril de 2026 todo webhook de mensajes de Meta trae
-- `contacts[].user_id` (el BSUID, «business-scoped user id») y
-- `messages[].from_user_id`, SIEMPRE; el teléfono (`contacts[].wa_id`,
-- `messages[].from`) se OMITE cuando el usuario escribe con nombre de
-- usuario y no hemos hablado con él en 30 días ni está en la libreta
-- del negocio. Hasta hoy `contacts.phone` era NOT NULL y la única
-- identidad que este CRM sabía leer: un entrante sin teléfono no tenía
-- dónde aterrizar.
--
-- Esta migración abre el modelo a las DOS identidades:
--
--   * `wa_user_id`  — el BSUID. Formato `CC.<hasta 128 alfanuméricos>`
--                     (p. ej. `US.13497…`). Único por par
--                     portafolio-de-negocio/usuario, que en este
--                     esquema es la cuenta: de ahí el índice único
--                     parcial por `(account_id, wa_user_id)`.
--   * `wa_username` — el nombre de usuario público (`profile.username`),
--                     sin `@`. Es un dato de presentación: puede
--                     cambiar, no identifica y por eso NO lleva índice
--                     único.
--
-- y relaja `phone` a NULL con la invariante «teléfono o BSUID, al menos
-- uno»: un contacto sin ninguna de las dos identidades no es
-- alcanzable por WhatsApp y no tendría por qué existir.
--
-- Sin backfill: los BSUID llegan con el tráfico (§5 del spec). Las
-- filas existentes conservan su teléfono y quedan con `wa_user_id`
-- NULL hasta que su dueño vuelva a escribir.
--
-- Lo que NO hace falta tocar, revisado uno a uno:
--
--   * `contacts.phone_normalized` (022) es GENERATED ALWAYS AS
--     `regexp_replace(phone, '\D', '', 'g')`: con `phone` NULL la
--     expresión da NULL, no ''.
--   * `idx_contacts_account_phone_normalized` (022, ÚNICO) es parcial
--     `WHERE phone_normalized <> ''`, y NULL no satisface `<> ''`
--     (da NULL, no TRUE), así que las filas sin teléfono quedan fuera
--     del índice: mil contactos sin teléfono NO colisionan entre sí.
--   * `merge_duplicate_contacts()` (022) filtra por
--     `phone_normalized <> ''`, mismo razonamiento: nunca mira una fila
--     sin teléfono.
--   * `idx_contacts_phone` (001) es un índice normal, no único, y
--     admite NULL.
--
-- Ningún DROP, ningún CASCADE: solo se añaden columnas, se relaja un
-- NOT NULL y se reemplaza el cuerpo de una función por su versión
-- ampliada. Idempotente de principio a fin.
-- ============================================================

-- ------------------------------------------------------------
-- 1) Las dos columnas nuevas.
-- ------------------------------------------------------------
ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_user_id TEXT;

ALTER TABLE contacts
  ADD COLUMN IF NOT EXISTS wa_username TEXT;

COMMENT ON COLUMN contacts.wa_user_id IS
  'BSUID de Meta (formato CC.<alfanum>), único por cuenta. Llega en '
  'contacts[].user_id / messages[].from_user_id de cada webhook.';
COMMENT ON COLUMN contacts.wa_username IS
  'Nombre de usuario público de WhatsApp (profile.username), sin @. '
  'Presentación: puede cambiar y no identifica.';

-- ------------------------------------------------------------
-- 2) Un BSUID pertenece a un solo contacto dentro de la cuenta.
--
-- Parcial (`WHERE wa_user_id IS NOT NULL`) para que las filas que
-- todavía no tienen BSUID —todas, el día que esto se aplica— no
-- compitan por el mismo hueco. Es la garantía que impide que el
-- webhook duplique un contacto cuando Meta deja de mandar el teléfono.
-- ------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_contacts_account_wa_user_id
  ON contacts (account_id, wa_user_id)
  WHERE wa_user_id IS NOT NULL;

-- ------------------------------------------------------------
-- 3) `phone` deja de ser obligatorio…
-- ------------------------------------------------------------
ALTER TABLE contacts
  ALTER COLUMN phone DROP NOT NULL;

-- ------------------------------------------------------------
-- 4) …pero una de las dos identidades sigue siéndolo.
--
-- `ADD CONSTRAINT` no admite `IF NOT EXISTS` en Postgres 17, de ahí el
-- bloque: sin él, la segunda pasada del replay fallaría con 42710.
-- NOT VALID a propósito NO se usa: la tabla puede tener filas de antes
-- y todas cumplen (phone era NOT NULL), así que la validación completa
-- es gratis y deja la restricción en firme desde el primer minuto.
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'public.contacts'::regclass
      AND conname = 'contacts_phone_or_wa_user_id_check'
  ) THEN
    ALTER TABLE contacts
      ADD CONSTRAINT contacts_phone_or_wa_user_id_check
      CHECK (phone IS NOT NULL OR wa_user_id IS NOT NULL);
  END IF;
END
$$;

-- ------------------------------------------------------------
-- 5) La búsqueda de la lista de contactos aprende el username.
--
-- Misma firma y mismas garantías que la 025 (SECURITY INVOKER, RLS del
-- llamante): lo único que cambia es un `OR c.wa_username ILIKE …` en el
-- filtro, para que un contacto que solo tiene nombre de usuario se
-- pueda encontrar escribiéndolo. El buscador de la página acepta el
-- término con `@` o sin él; aquí se compara contra el valor guardado,
-- que va sin `@`.
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.filter_contacts_by_tags(
  p_tag_ids UUID[],
  p_search TEXT DEFAULT NULL,
  p_limit INT DEFAULT 25,
  p_offset INT DEFAULT 0
)
RETURNS TABLE (contact contacts, total_count BIGINT)
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public
AS $$
  WITH matched AS (
    SELECT DISTINCT c.id, c.created_at
    FROM contacts c
    JOIN contact_tags ct ON ct.contact_id = c.id
    WHERE ct.tag_id = ANY(p_tag_ids)
      AND (
        p_search IS NULL
        OR c.name ILIKE '%' || p_search || '%'
        OR c.phone ILIKE '%' || p_search || '%'
        OR c.email ILIKE '%' || p_search || '%'
        OR c.wa_username ILIKE '%' || ltrim(p_search, '@') || '%'
      )
  ),
  page AS (
    SELECT id, count(*) OVER() AS total_count
    FROM matched
    ORDER BY created_at DESC, id
    LIMIT p_limit OFFSET p_offset
  )
  SELECT c AS contact, page.total_count
  FROM page
  JOIN contacts c ON c.id = page.id
  ORDER BY c.created_at DESC, c.id;
$$;

ALTER FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) OWNER TO postgres;
REVOKE ALL ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.filter_contacts_by_tags(UUID[], TEXT, INT, INT) TO authenticated;
