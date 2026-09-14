-- ============================================================
-- f4.1 `embedded-signup` — comprobaciones contra Postgres real.
--
-- Lo que ningún test de vitest puede afirmar, porque depende del motor
-- y no del código: que `provisioned_via` nace en 'manual' para todo lo
-- heredado, que su CHECK rechaza una tercera grafía, y —lo importante—
-- que el UPSERT idempotente del registro integrado tiene destino de
-- ON CONFLICT y se comporta: repetir el diálogo con el mismo número
-- deja UNA fila con token nuevo, y el número de otra cuenta lo rechaza
-- la base aunque la ruta fallara en cortarlo antes.
--
-- Cómo se corre (deja el contenedor vivo primero):
--   KEEP=1 scripts/replay-migrations.sh \
--     .claude/worktrees/fase-4-multinumero
--   docker exec -i <contenedor> psql -U postgres -v ON_ERROR_STOP=1 \
--     < progress/checks_embedded-signup.sql
--
-- Cada bloque termina en RAISE NOTICE 'OK …'. Un fallo aborta con
-- ON_ERROR_STOP=1, así que no hay verde silencioso.
-- ============================================================

BEGIN;

-- ---- Datos mínimos ------------------------------------------
-- `whatsapp_config.user_id` es NOT NULL con FK a auth.users y
-- `accounts.owner_user_id` igual: hacen falta dos usuarios de verdad.
-- Todo se revierte al final.
INSERT INTO auth.users (id, email)
VALUES
  ('31111111-1111-4111-8111-111111111111', 'es-a@example.test'),
  ('32222222-2222-4222-8222-222222222222', 'es-b@example.test');

-- El disparador `on_auth_user_created` (fase 0) ya crea cuenta y perfil
-- por usuario, e `idx_accounts_one_per_owner` impide una segunda.
SELECT id AS acct_a FROM accounts
 WHERE owner_user_id = '31111111-1111-4111-8111-111111111111' \gset
SELECT id AS acct_b FROM accounts
 WHERE owner_user_id = '32222222-2222-4222-8222-222222222222' \gset

-- ------------------------------------------------------------
-- 1. `provisioned_via` nace en 'manual' sin que nadie lo escriba.
--    Es lo que hace que las filas anteriores a la 054 (y las del
--    formulario manual, que no pone la columna) queden clasificadas
--    como del cliente y no como nuestras.
-- ------------------------------------------------------------
INSERT INTO whatsapp_config
  (id, account_id, user_id, phone_number_id, waba_id, access_token, status)
VALUES
  ('cfe00000-0000-4000-8000-00000000cfe1',
   :'acct_a', '31111111-1111-4111-8111-111111111111',
   'pn-legacy', 'waba-a', 'enc:tok-legacy', 'connected');

DO $$
BEGIN
  IF (SELECT provisioned_via FROM whatsapp_config
      WHERE id = 'cfe00000-0000-4000-8000-00000000cfe1') <> 'manual' THEN
    RAISE EXCEPTION 'una fila que no escribe provisioned_via no queda en manual';
  END IF;
  IF (SELECT registration_pin IS NULL AND token_expires_at IS NULL
      FROM whatsapp_config WHERE id = 'cfe00000-0000-4000-8000-00000000cfe1') IS NOT TRUE THEN
    RAISE EXCEPTION 'registration_pin / token_expires_at deberían nacer NULL';
  END IF;
  RAISE NOTICE 'OK 1 — provisioned_via por defecto manual; PIN y vencimiento NULL (054)';
END $$;

-- ------------------------------------------------------------
-- 2. El CHECK cierra la lista de vías.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    UPDATE whatsapp_config SET provisioned_via = 'telepatia'
    WHERE id = 'cfe00000-0000-4000-8000-00000000cfe1';
    RAISE EXCEPTION 'el CHECK de provisioned_via aceptó un valor fuera de la lista';
  EXCEPTION WHEN check_violation THEN
    RAISE NOTICE 'OK 2 — whatsapp_config_provisioned_via_check rechaza vías inventadas (054)';
  END;
END $$;

-- ------------------------------------------------------------
-- 3. El UPSERT del registro integrado.
--
--    Es LA razón por la que la 053 tenía que ir antes: sin el índice
--    único (account_id, phone_number_id) esta sentencia no compila —
--    Postgres responde «there is no unique or exclusion constraint
--    matching the ON CONFLICT specification». Que pase aquí es la
--    prueba de que el camino idempotente de §1.7 existe de verdad.
-- ------------------------------------------------------------
INSERT INTO whatsapp_config
  (account_id, user_id, phone_number_id, waba_id, access_token,
   verify_token, registration_pin, token_expires_at, provisioned_via,
   status, connected_at, registered_at, subscribed_apps_at,
   last_registration_error, is_default)
VALUES
  (:'acct_a', '31111111-1111-4111-8111-111111111111',
   'pn-embedded', 'waba-a', 'enc:tok-v1',
   NULL, 'enc:pin-v1', NULL, 'embedded_signup',
   'connected', now(), now(), now(), 'algo falló antes', FALSE)
ON CONFLICT (account_id, phone_number_id) DO UPDATE SET
  access_token = EXCLUDED.access_token,
  registration_pin = EXCLUDED.registration_pin,
  last_registration_error = EXCLUDED.last_registration_error;

-- Segunda pasada por el diálogo con el MISMO número: token nuevo y el
-- error de registro anterior limpiado, sin fila duplicada.
INSERT INTO whatsapp_config
  (account_id, user_id, phone_number_id, waba_id, access_token,
   registration_pin, provisioned_via, status, is_default)
VALUES
  (:'acct_a', '31111111-1111-4111-8111-111111111111',
   'pn-embedded', 'waba-a', 'enc:tok-v2',
   'enc:pin-v2', 'embedded_signup', 'connected', FALSE)
ON CONFLICT (account_id, phone_number_id) DO UPDATE SET
  access_token = EXCLUDED.access_token,
  registration_pin = EXCLUDED.registration_pin,
  last_registration_error = NULL;

DO $$
DECLARE
  n INTEGER;
  tok TEXT;
  err TEXT;
BEGIN
  SELECT count(*) INTO n FROM whatsapp_config WHERE phone_number_id = 'pn-embedded';
  IF n <> 1 THEN
    RAISE EXCEPTION 'repetir el registro integrado creó % filas, no 1', n;
  END IF;
  SELECT access_token, last_registration_error INTO tok, err
    FROM whatsapp_config WHERE phone_number_id = 'pn-embedded';
  IF tok <> 'enc:tok-v2' THEN
    RAISE EXCEPTION 'el upsert no refrescó el token (quedó %)', tok;
  END IF;
  IF err IS NOT NULL THEN
    RAISE EXCEPTION 'el upsert no limpió last_registration_error (quedó %)', err;
  END IF;
  RAISE NOTICE 'OK 3 — upsert por (account_id, phone_number_id): una fila, token nuevo, error limpiado';
END $$;

-- ------------------------------------------------------------
-- 4. El upsert NO puede robar el número de otra cuenta.
--
--    La ruta lo corta antes con 409 (paso 2 de §1.3), pero si ese
--    control se perdiera, el UNIQUE global de la 013 es la última
--    línea: el ON CONFLICT solo cubre el par (cuenta, número), así que
--    el choque con OTRA cuenta sale como 23505 y no como un UPDATE
--    silencioso sobre la fila ajena.
-- ------------------------------------------------------------
DO $$
BEGIN
  BEGIN
    INSERT INTO whatsapp_config
      (account_id, user_id, phone_number_id, access_token, provisioned_via, status)
    VALUES
      ((SELECT id FROM accounts WHERE owner_user_id = '32222222-2222-4222-8222-222222222222'),
       '32222222-2222-4222-8222-222222222222',
       'pn-embedded', 'enc:tok-ladron', 'embedded_signup', 'connected')
    ON CONFLICT (account_id, phone_number_id) DO UPDATE SET
      access_token = EXCLUDED.access_token;
    RAISE EXCEPTION 'la cuenta B se quedó con un número de la cuenta A';
  EXCEPTION WHEN unique_violation THEN
    RAISE NOTICE 'OK 4 — el UNIQUE global de la 013 impide que el upsert cruce de cuenta';
  END;
END $$;

DO $$
BEGIN
  IF (SELECT account_id FROM whatsapp_config WHERE phone_number_id = 'pn-embedded')
     <> (SELECT id FROM accounts WHERE owner_user_id = '31111111-1111-4111-8111-111111111111') THEN
    RAISE EXCEPTION 'el número cambió de dueño';
  END IF;
  IF (SELECT access_token FROM whatsapp_config WHERE phone_number_id = 'pn-embedded')
     <> 'enc:tok-v2' THEN
    RAISE EXCEPTION 'el intento de la cuenta B llegó a escribir el token de A';
  END IF;
  RAISE NOTICE 'OK 5 — la fila de A quedó intacta tras el intento de B';
END $$;

ROLLBACK;
