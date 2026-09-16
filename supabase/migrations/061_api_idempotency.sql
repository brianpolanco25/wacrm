-- ============================================================
-- 061_api_idempotency.sql — Fase 7 §1: reintentos seguros en la API
-- pública.
--
-- Qué problema resuelve
--   Un cliente que llama a `POST /api/v1/messages` y pierde la respuesta
--   (timeout, corte de red, reinicio del worker) no sabe si el mensaje
--   salió. Si reintenta, manda dos veces; si no reintenta, puede no
--   haber mandado nunca. La salida estándar es que el cliente ponga una
--   cabecera `Idempotency-Key` y el servidor recuerde, durante un rato,
--   qué respondió a esa clave: el reintento devuelve la MISMA respuesta
--   sin volver a ejecutar nada.
--
--   Esta tabla es esa memoria. La escribe y la lee solo el servidor, con
--   el rol de servicio, desde `src/lib/api/v1/idempotency.ts`.
--
-- Alcance de la unicidad: `(api_key_id, idempotency_key)`
--   Por CLAVE DE API, no por cuenta. Dos integraciones distintas de la
--   misma empresa (cada una con su clave) generan sus propios
--   identificadores sin coordinarse; si el alcance fuera la cuenta, una
--   colisión fortuita entre ellas haría que una recibiera la respuesta
--   de la otra —una fuga de datos dentro de la propia cuenta, y un
--   mensaje que nunca se envió dado por enviado—. Con este alcance, lo
--   peor que puede pasar entre dos claves es que cada una tenga su fila.
--
--   `account_id` se guarda igualmente: es la columna por la que filtran
--   todas las consultas del rol de servicio (CP3) y la que permite
--   purgar por cuenta sin pasar por `api_keys`.
--
-- Qué se guarda y qué NO
--   `request_hash` es un SHA-256 de método + ruta + cuerpo crudo. Sirve
--   para distinguir «el mismo reintento» de «la misma clave reusada para
--   otra cosa» (que es un error del cliente y responde 409). Es un
--   digest, no el cuerpo: la tabla no se convierte en una segunda copia
--   del tráfico.
--   `response_body` sí es el sobre `{data:…}` que se devolvió, porque es
--   exactamente lo que hay que reproducir. Nunca contiene la clave de
--   API (el plaintext no existe en el servidor) ni secretos de webhook:
--   solo la reserva se escribe antes de ejecutar y el cuerpo se rellena
--   después, con lo que la ruta ya decidió publicar.
--
-- Caducidad: 24 h
--   La ventana de reintento de un cliente razonable se mide en minutos;
--   24 h da margen a una cola parada toda una noche y acota el tamaño de
--   la tabla. Pasada la fecha, la fila se ignora en la lectura (el
--   filtro va en `expires_at > now()`, no en un barrido) y se borra de
--   forma oportunista desde la aplicación.
--
-- RLS: sin políticas, a propósito
--   `ENABLE ROW LEVEL SECURITY` sin una sola política significa que
--   NADIE llega por RLS: ni `authenticated` ni `anon`. Solo el rol de
--   servicio, que la salta. Es lo correcto aquí porque el panel no tiene
--   nada que enseñar de esta tabla y porque `response_body` puede
--   contener datos de una petición que un miembro concreto no hizo. El
--   precedente en el repo es `checkout_intents` (048), que enseña solo
--   lo que admin+ necesita y deja la escritura al rol de servicio; aquí
--   ni siquiera hay lectura que ofrecer.
--
-- Sobre los `ON DELETE CASCADE` (CP2)
--   Los dos borran datos EFÍMEROS, nunca datos de cliente: una fila aquí
--   vive 24 h y solo describe una respuesta ya entregada. Si se borra la
--   cuenta, o si un administrador borra de verdad una clave de API (la
--   revocación normal es blanda, `revoked_at`), estas filas dejan de
--   tener significado: su unicidad está definida sobre `api_key_id`.
--   Dejarlas huérfanas obligaría a `api_key_id` nullable y rompería el
--   índice único.
--
-- Idempotente — se puede re-ejecutar: tabla e índices con IF NOT EXISTS.
-- ============================================================

CREATE TABLE IF NOT EXISTS api_idempotency_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id      uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  api_key_id      uuid NOT NULL REFERENCES api_keys(id) ON DELETE CASCADE,
  -- Lo que manda el cliente en la cabecera `Idempotency-Key` (1..255).
  idempotency_key text NOT NULL,
  -- SHA-256 hex de método + ruta + cuerpo crudo.
  request_hash    text NOT NULL,
  -- NULL mientras la petición original sigue en vuelo: un segundo
  -- intento simultáneo lo ve y responde 409 `conflict` en vez de
  -- ejecutar el trabajo dos veces.
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT (now() + interval '24 hours')
);

-- El índice ÚNICO es el mecanismo, no un adorno: la reserva se hace con
-- un INSERT y es la violación de unicidad la que decide quién ejecuta y
-- quién espera/reproduce. Sin él, dos peticiones simultáneas con la
-- misma clave harían ambas el trabajo.
CREATE UNIQUE INDEX IF NOT EXISTS api_idempotency_keys_key_idx
  ON api_idempotency_keys (api_key_id, idempotency_key);

-- Purga: «dame lo caducado». Lo usa el borrado oportunista de la
-- aplicación y lo usará el barrido de la fase 7 §4 cuando exista.
CREATE INDEX IF NOT EXISTS api_idempotency_keys_expires_at_idx
  ON api_idempotency_keys (expires_at);

ALTER TABLE api_idempotency_keys ENABLE ROW LEVEL SECURITY;

COMMENT ON TABLE api_idempotency_keys IS
  'Respuestas memorizadas por `Idempotency-Key` para las escrituras de '
  '/api/v1 (migración 061). Vida útil 24 h. Solo el rol de servicio: RLS '
  'habilitada SIN políticas a propósito.';
