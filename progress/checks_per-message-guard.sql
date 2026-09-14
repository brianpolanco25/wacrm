-- ============================================================
-- checks_per-message-guard.sql — f1.4, comprobaciones contra el
-- Postgres del harness.
--
--   KEEP=1 scripts/replay-migrations.sh .claude/worktrees/fase-1
--   docker exec -i <contenedor> psql -U postgres -d postgres \
--     -v ON_ERROR_STOP=1 -f - < progress/checks_per-message-guard.sql
--
-- Lo que prueba, y por qué no basta con vitest: la promesa de la feature
-- («el cliente nunca recibe dos respuestas automáticas al mismo
-- mensaje») no la cumple el código de aplicación sino la clave primaria
-- de `inbound_auto_replies`. Eso solo se puede comprobar contra Postgres
-- de verdad, y con dos sesiones concurrentes.
--
-- Cada parte lleva su control negativo: se comprueba que la operación
-- que DEBE fallar falla, no solo que la que debe pasar pasa.
-- ============================================================

\set ON_ERROR_STOP on

BEGIN;

-- ------------------------------------------------------------
-- Semilla: dos cuentas, cada una con su contacto, conversación y un
-- mensaje entrante.
-- ------------------------------------------------------------
INSERT INTO auth.users (id, email)
VALUES
  ('11111111-1111-1111-1111-111111111111', 'owner-a@example.com'),
  ('22222222-2222-2222-2222-222222222222', 'owner-b@example.com');

-- Cada alta de usuario crea su cuenta personal por trigger (017), con un
-- id generado y un índice único de una cuenta por dueño. Se reutilizan
-- esas dos cuentas (no se pueden renumerar: `profiles` ya las referencia)
-- y sus ids viajan en una tabla temporal para no repetir la subconsulta.
CREATE TEMP TABLE seed ON COMMIT DROP AS
SELECT
  (SELECT id FROM accounts WHERE owner_user_id = '11111111-1111-1111-1111-111111111111') AS acct_a,
  (SELECT id FROM accounts WHERE owner_user_id = '22222222-2222-2222-2222-222222222222') AS acct_b;

INSERT INTO contacts (id, user_id, account_id, phone) VALUES
  ('a0000000-0000-0000-0000-0000000000c1', '11111111-1111-1111-1111-111111111111', (SELECT acct_a FROM seed), '+34600000001'),
  ('b0000000-0000-0000-0000-0000000000c2', '22222222-2222-2222-2222-222222222222', (SELECT acct_b FROM seed), '+34600000002');

INSERT INTO conversations (id, user_id, account_id, contact_id) VALUES
  ('a0000000-0000-0000-0000-0000000000e1', '11111111-1111-1111-1111-111111111111', (SELECT acct_a FROM seed), 'a0000000-0000-0000-0000-0000000000c1'),
  ('b0000000-0000-0000-0000-0000000000e2', '22222222-2222-2222-2222-222222222222', (SELECT acct_b FROM seed), 'b0000000-0000-0000-0000-0000000000c2');

INSERT INTO messages (id, conversation_id, sender_type, content_type, content_text) VALUES
  ('a0000000-0000-0000-0000-0000000000f1', 'a0000000-0000-0000-0000-0000000000e1', 'customer', 'text', '¿a qué hora abrís?'),
  ('a0000000-0000-0000-0000-0000000000f2', 'a0000000-0000-0000-0000-0000000000e1', 'customer', 'text', '¿y los domingos?'),
  ('b0000000-0000-0000-0000-0000000000f3', 'b0000000-0000-0000-0000-0000000000e2', 'customer', 'text', 'hola');

INSERT INTO automations (id, user_id, account_id, name, trigger_type, is_active)
VALUES ('a0000000-0000-0000-0000-0000000000a9', '11111111-1111-1111-1111-111111111111',
        (SELECT acct_a FROM seed), 'Horarios', 'keyword_match', true);

-- ------------------------------------------------------------
-- A. Un solo respondedor por mensaje entrante.
-- ------------------------------------------------------------
INSERT INTO inbound_auto_replies (message_id, account_id, responder, automation_id)
VALUES ('a0000000-0000-0000-0000-0000000000f1', (SELECT acct_a FROM seed),
        'automation', 'a0000000-0000-0000-0000-0000000000a9');

-- A.1 Control negativo: la IA intentando reservar el mismo mensaje NO
-- inserta. Es el `ON CONFLICT DO NOTHING` del helper: 0 filas = perdió.
WITH claim AS (
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('a0000000-0000-0000-0000-0000000000f1', (SELECT acct_a FROM seed), 'ai')
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT CASE WHEN count(*) = 0 THEN 'A.1 OK — la IA pierde la reserva del mensaje ya contestado'
            ELSE 'A.1 FALLO' END FROM claim;

-- A.2 Control negativo duro: sin ON CONFLICT, el segundo respondedor se
-- estrella contra la PK (23505). Esto es lo que hace que la garantía no
-- dependa del código de aplicación.
DO $$
BEGIN
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('a0000000-0000-0000-0000-0000000000f1', (SELECT acct_a FROM seed), 'ai');
  RAISE EXCEPTION 'A.2 FALLO: la PK dejó pasar una segunda respuesta automática';
EXCEPTION WHEN unique_violation THEN
  RAISE NOTICE 'A.2 OK — 23505: una sola respuesta automática por mensaje';
END
$$;

-- A.3 La reserva es POR MENSAJE, no por cuenta ni por conversación: el
-- siguiente entrante de la misma conversación sigue libre. Es
-- exactamente el fallo que la guarda global tenía.
WITH claim AS (
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('a0000000-0000-0000-0000-0000000000f2', (SELECT acct_a FROM seed), 'ai')
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT CASE WHEN count(*) = 1 THEN 'A.3 OK — el siguiente mensaje sigue siendo de la IA'
            ELSE 'A.3 FALLO' END FROM claim;

-- ------------------------------------------------------------
-- H. El titular de la reserva, que es lo que el motor consulta cuando
--    pierde el INSERT (`claimInboundAutoReplyForAutomation`). Desde la
--    revisión, el motor HONRA el resultado: si la reserva no es suya, no
--    envía. Para no callarse ante sí mismo necesita distinguir «la tengo
--    yo» de «la tiene otro», y eso es esta lectura.
-- ------------------------------------------------------------
-- H.1 Un segundo paso de envío del MISMO run: el INSERT no entra, pero
-- la lectura devuelve su propia automatización -> sigue hablando.
WITH claim AS (
  INSERT INTO inbound_auto_replies (message_id, account_id, responder, automation_id)
  VALUES ('a0000000-0000-0000-0000-0000000000f1', (SELECT acct_a FROM seed),
          'automation', 'a0000000-0000-0000-0000-0000000000a9')
  ON CONFLICT (message_id) DO NOTHING
  RETURNING message_id
)
SELECT CASE WHEN (SELECT count(*) FROM claim) = 0
             AND EXISTS (
               SELECT 1 FROM inbound_auto_replies
               WHERE message_id = 'a0000000-0000-0000-0000-0000000000f1'
                 AND account_id = (SELECT acct_a FROM seed)
                 AND responder = 'automation'
                 AND automation_id = 'a0000000-0000-0000-0000-0000000000a9')
            THEN 'H.1 OK — la reserva perdida es la suya: el run sigue enviando'
            ELSE 'H.1 FALLO' END;

-- H.2 La misma lectura acotada a la OTRA cuenta no devuelve nada: una
-- reserva ajena nunca se lee como propia (dirección segura, no envía).
SELECT CASE WHEN count(*) = 0
            THEN 'H.2 OK — la lectura del titular va acotada por cuenta'
            ELSE 'H.2 FALLO' END
FROM inbound_auto_replies
WHERE message_id = 'a0000000-0000-0000-0000-0000000000f1'
  AND account_id = (SELECT acct_b FROM seed);

-- H.3 Control negativo: si el titular es la IA (mensaje f2, reservado en
-- A.3), la lectura no encuentra ninguna automatización -> el motor calla.
-- Es el caso del `wait` que reanuda el cron media hora después.
SELECT CASE WHEN count(*) = 0
            THEN 'H.3 OK — con la IA como titular, el motor no reconoce la reserva'
            ELSE 'H.3 FALLO' END
FROM inbound_auto_replies
WHERE message_id = 'a0000000-0000-0000-0000-0000000000f2'
  AND account_id = (SELECT acct_a FROM seed)
  AND responder = 'automation'
  AND automation_id = 'a0000000-0000-0000-0000-0000000000a9';

-- ------------------------------------------------------------
-- B. Aislamiento entre cuentas.
-- ------------------------------------------------------------
-- B.1 Una consulta acotada por cuenta (como las del rol de servicio) no
-- ve las marcas de la otra.
INSERT INTO inbound_auto_replies (message_id, account_id, responder)
VALUES ('b0000000-0000-0000-0000-0000000000f3', (SELECT acct_b FROM seed), 'ai');

SELECT CASE WHEN count(*) = 2 THEN 'B.1 OK — la cuenta A solo ve sus dos marcas'
            ELSE 'B.1 FALLO: ' || count(*)::text END
FROM inbound_auto_replies WHERE account_id = (SELECT acct_a FROM seed);

-- B.2 Control negativo: la cuenta no es opcional. Una marca sin cuenta
-- sería invisible para toda consulta acotada.
DO $$
BEGIN
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('b0000000-0000-0000-0000-0000000000f3', NULL, 'ai');
  RAISE EXCEPTION 'B.2 FALLO: account_id acepta NULL';
EXCEPTION WHEN not_null_violation THEN
  RAISE NOTICE 'B.2 OK — account_id es NOT NULL';
END
$$;

-- B.3 Control negativo: `responder` no admite valores inventados (un
-- typo convertiría la marca en indescifrable en el diagnóstico).
DO $$
BEGIN
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('a0000000-0000-0000-0000-0000000000f2', (SELECT acct_a FROM seed), 'flow');
  RAISE EXCEPTION 'B.3 FALLO: el CHECK de responder no existe';
EXCEPTION WHEN check_violation THEN
  RAISE NOTICE 'B.3 OK — CHECK responder IN (automation, ai)';
END
$$;

-- ------------------------------------------------------------
-- C. RLS: nadie que no sea el rol de servicio toca esta tabla.
-- ------------------------------------------------------------
SET LOCAL ROLE authenticated;
SELECT CASE WHEN count(*) = 0 THEN 'C.1 OK — authenticated no lee ninguna marca'
            ELSE 'C.1 FALLO' END FROM inbound_auto_replies;

DO $$
BEGIN
  INSERT INTO inbound_auto_replies (message_id, account_id, responder)
  VALUES ('a0000000-0000-0000-0000-0000000000f2', (SELECT acct_a FROM seed), 'ai');
  RAISE EXCEPTION 'C.2 FALLO: authenticated pudo insertar una marca';
EXCEPTION WHEN insufficient_privilege THEN
  RAISE NOTICE 'C.2 OK — authenticated no puede insertar (RLS sin políticas)';
END
$$;
RESET ROLE;

-- ------------------------------------------------------------
-- D. Recogida de basura: la marca se va con el mensaje y con la cuenta,
-- y nunca al revés.
-- ------------------------------------------------------------
DELETE FROM messages WHERE id = 'a0000000-0000-0000-0000-0000000000f2';
SELECT CASE WHEN count(*) = 0 THEN 'D.1 OK — la marca se borra con su mensaje'
            ELSE 'D.1 FALLO' END
FROM inbound_auto_replies WHERE message_id = 'a0000000-0000-0000-0000-0000000000f2';

-- D.2 Borrar la automatización NO libera la reserva: el mensaje quedaría
-- abierto a una segunda respuesta automática.
DELETE FROM automations WHERE id = 'a0000000-0000-0000-0000-0000000000a9';
SELECT CASE WHEN count(*) = 1 THEN 'D.2 OK — la reserva sobrevive al borrado de la automatización'
            ELSE 'D.2 FALLO' END
FROM inbound_auto_replies WHERE message_id = 'a0000000-0000-0000-0000-0000000000f1';

SELECT CASE WHEN automation_id IS NULL THEN 'D.3 OK — automation_id quedó a NULL (SET NULL)'
            ELSE 'D.3 FALLO' END
FROM inbound_auto_replies WHERE message_id = 'a0000000-0000-0000-0000-0000000000f1';

ROLLBACK;

-- ------------------------------------------------------------
-- E. Concurrencia real: dos sesiones reservando a la vez.
--    Fuera del BEGIN/ROLLBACK anterior porque necesita dos sesiones; se
--    ejecuta a mano contra el contenedor que deja vivo `KEEP=1`, con la
--    semilla ya confirmada (auth.users -> contacts -> conversations ->
--    messages 'f1' y 'f9').
--
--    Sesión 1 (motor de automatizaciones):
--      BEGIN;
--      INSERT INTO inbound_auto_replies (message_id, account_id, responder)
--      VALUES ('<f1>', '<acct>', 'automation');
--      SELECT pg_sleep(4);          -- el envío a Meta, en la vida real
--      COMMIT;
--
--    Sesión 2 (IA), un segundo después:
--      INSERT INTO inbound_auto_replies (message_id, account_id, responder)
--      VALUES ('<f1>', '<acct>', 'ai')
--      ON CONFLICT (message_id) DO NOTHING
--      RETURNING message_id, responder;
--
--    Resultado medido en el harness:
--      E.1 COMMIT   -> la sesión 2 se BLOQUEA 2 969 ms (lo que le queda a
--                     la 1) y devuelve `INSERT 0 0`: la IA no envía.
--                     Tabla final: f1 -> 'automation'. Una sola respuesta.
--      E.2 ROLLBACK -> repetido sobre el mensaje 'f9' con ROLLBACK en la
--                     sesión 1: la 2 se desbloquea a los 3 026 ms y
--                     devuelve `INSERT 0 1` con responder 'ai'. Una
--                     reserva abortada no deja el mensaje mudo.
--
--    Es la propiedad entera de la feature: quien reserva primero es el
--    único que habla, y lo decide Postgres, no el orden de los dos
--    despachos del `after()`.
--
-- ------------------------------------------------------------
-- F. Controles negativos de `supabase/ci/verify-schema.sql` (misma
--    sesión, dentro de un BEGIN ... ROLLBACK):
--      F.1 PK cambiada a (account_id, message_id) ->
--          «inbound_auto_replies must be keyed on message_id alone».
--      F.2 CREATE POLICY tmp_read ... ->
--          «inbound_auto_replies must have no RLS policies».
--      F.3 DISABLE ROW LEVEL SECURITY ->
--          «inbound_auto_replies must have RLS enabled».
--    Las tres aserciones son detectores, no decoración.
--
-- G. Idempotencia: reaplicar 051_automation_reply_marker.sql sobre la
--    base ya migrada sale 0 (dos NOTICE de "already exists, skipping"),
--    no pierde las filas existentes y `verify-schema.sql` sigue pasando.

-- ------------------------------------------------------------
-- I. Carrera real contra la lectura del titular (dos sesiones, a mano
--    sobre el contenedor de KEEP=1). Es la que sostiene el cambio de la
--    revisión: el motor honra la reserva, así que necesita que, cuando
--    pierde, la lectura siguiente vea YA al ganador y no una foto vieja.
--
--    Sesión 1 (la IA, respondiendo):
--      BEGIN;
--      INSERT INTO inbound_auto_replies (message_id, account_id, responder)
--      VALUES ('<f4>', '<acct>', 'ai');
--      SELECT pg_sleep(4);
--      COMMIT;
--
--    Sesión 2 (el motor reanudando un `wait`), un segundo después:
--      WITH claim AS (
--        INSERT ... ON CONFLICT (message_id) DO NOTHING RETURNING message_id
--      ) SELECT count(*) FROM claim;          -- 0: perdió
--      SELECT responder FROM inbound_auto_replies
--       WHERE message_id='<f4>' AND account_id='<acct>';
--
--    Resultado medido en el harness:
--      I.1 el INSERT de la sesión 2 se BLOQUEA 2 950 ms (lo que le queda
--          a la 1) y devuelve 0 filas;
--      I.2 la lectura del titular, 2 ms después, devuelve 'ai'.
--
--    O sea: `ON CONFLICT DO NOTHING` espera a que el otro confirme o
--    revierta, así que para cuando el motor pregunta «¿de quién es?»
--    la respuesta ya está confirmada. No hay ventana en la que el motor
--    lea «libre» y envíe encima de la IA.
