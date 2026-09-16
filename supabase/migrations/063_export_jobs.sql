-- ============================================================
-- 063_export_jobs.sql — Fase 7 §5: exportación de conversaciones.
--
-- Qué problema resuelve
--   Un cliente quiere llevarse sus chats (auditoría, migración, un
--   informe). Para una conversación suelta basta con devolver el
--   archivo en la misma respuesta (`GET /api/v1/conversations/{id}/
--   export`), pero «todas las conversaciones cerradas del último año»
--   no cabe en una petición HTTP: hay que aceptar el encargo, trabajar
--   aparte y entregar un archivo. Esta tabla es ese encargo.
--
-- El ciclo de vida
--   queued  → aceptado, nadie lo ha tomado todavía (202 al cliente)
--   running → un proceso lo está construyendo (`started_at` = cuándo)
--   done    → `file_path` apunta al objeto del bucket, `row_count` dice
--             cuántos mensajes salieron
--   failed  → `error` explica por qué, en texto apto para el cliente
--
--   El primer intento corre en `after()` de la propia petición. Si el
--   proceso muere ahí, la fila queda `queued` (o `running` sin avanzar)
--   y la retoma el barrido de `GET /api/webhooks/cron`, que es el único
--   programador que este despliegue tiene. De ahí `started_at`: sin él
--   un barrido no puede distinguir «lo está haciendo alguien ahora
--   mismo» de «lo empezó un proceso que ya no existe», y o bien nunca
--   retoma nada o bien duplica el trabajo de un job sano. No está en la
--   lista de columnas de la spec porque la spec describe la forma, no
--   el mecanismo de reanudación; sin esta columna el requisito «si se
--   corta, lo retoma el cron» no se puede cumplir de forma segura.
--
-- Por qué `params` y no columnas sueltas
--   Los filtros del encargo (`status`, `contact_id`, `from`, `to`) son
--   contrato de la API, no del esquema: una exportación futura de otro
--   `kind` traerá otros filtros. Se guarda el objeto ya validado por la
--   ruta, de modo que el barrido reconstruye exactamente la consulta que
--   pidió el cliente. `account_id` NUNCA sale de aquí: el filtro de
--   cuenta lo pone el código desde `export_jobs.account_id`, así que un
--   `params` manipulado no puede ampliar el alcance.
--
-- Retención: 7 días (S-A6)
--   `expires_at` por defecto es `created_at + 7 días`. El barrido borra
--   primero el objeto del bucket y después la fila; mientras la fila
--   exista, `GET /api/v1/exports/{id}` sigue contando qué pasó.
--
-- El bucket `exports`
--   Privado y SIN políticas de `storage.objects`: solo el rol de
--   servicio escribe, lee y firma. Un archivo de exportación es una
--   copia plana de toda la mensajería de una cuenta — el activo más
--   sensible que este producto guarda— y la única forma de leerlo es
--   una URL firmada de 15 minutos que acuña `GET /api/v1/exports/{id}`
--   tras comprobar que el job es de la cuenta de la clave. Ninguna
--   sesión de navegador llega al objeto por su cuenta, ni siquiera la
--   del dueño: no hay panel que lo necesite y cada política de más es
--   una vía de lectura que auditar.
--
-- `ON DELETE CASCADE` (CP2)
--   `account_id`: borrada la cuenta, un encargo suyo no significa nada.
--   `api_key_id` es `ON DELETE SET NULL`: la clave que pidió el
--   export es trazabilidad, y borrarla no debe llevarse el encargo ni
--   el archivo por delante.
--
-- Idempotente — se puede re-ejecutar.
-- ============================================================

CREATE TABLE IF NOT EXISTS export_jobs (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id  uuid NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  -- Quién lo pidió. NULL si esa clave se borró de verdad después.
  api_key_id  uuid REFERENCES api_keys(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  -- Filtros ya validados por la ruta. Nunca contiene `account_id`.
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  format      text NOT NULL,
  status      text NOT NULL DEFAULT 'queued',
  row_count   integer,
  -- Ruta del objeto dentro del bucket `exports`, sin el bucket.
  file_path   text,
  -- Motivo del fallo, en texto publicable (nunca SQL ni rutas).
  error       text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  -- Cuándo lo reclamó el proceso que lo está construyendo. Es el reloj
  -- del que se sirve el barrido para retomar un job huérfano.
  started_at  timestamptz,
  finished_at timestamptz,
  expires_at  timestamptz NOT NULL DEFAULT (now() + interval '7 days'),
  CONSTRAINT export_jobs_kind_check
    CHECK (kind IN ('conversations')),
  CONSTRAINT export_jobs_format_check
    CHECK (format IN ('json', 'csv')),
  CONSTRAINT export_jobs_status_check
    CHECK (status IN ('queued', 'running', 'done', 'failed'))
);

-- La lista de la API: los encargos de una cuenta, el último primero.
-- Es además el orden de la paginación keyset `(created_at, id)`.
CREATE INDEX IF NOT EXISTS export_jobs_account_created_idx
  ON export_jobs (account_id, created_at DESC);

-- El barrido: lo que sigue sin terminar. Parcial porque `done`/`failed`
-- son el 99 % de la tabla y no se barren nunca.
CREATE INDEX IF NOT EXISTS export_jobs_pending_idx
  ON export_jobs (created_at)
  WHERE status IN ('queued', 'running');

-- La purga a los 7 días.
CREATE INDEX IF NOT EXISTS export_jobs_expires_at_idx
  ON export_jobs (expires_at);

ALTER TABLE export_jobs ENABLE ROW LEVEL SECURITY;

-- SELECT: cualquier miembro de la cuenta ve sus encargos. Igual que
-- `webhook_deliveries` (062), `can_read_account` y no `is_account_member`
-- para que una sesión de soporte (057) no vea la tabla desaparecer.
-- La fila NO contiene el archivo: `file_path` es una ruta de un bucket
-- que solo el rol de servicio puede leer.
DROP POLICY IF EXISTS export_jobs_select ON export_jobs;
CREATE POLICY export_jobs_select ON export_jobs FOR SELECT
  USING (can_read_account(account_id));

-- Sin políticas de escritura a propósito: crear, reclamar, terminar y
-- purgar un encargo es solo del rol de servicio. Un INSERT desde un JWT
-- de usuario sería un encargo de exportación que nadie autorizó.

-- ============================================================
-- Bucket `exports` — privado, sin políticas
--
-- Mismo UPSERT que los buckets de media (016/023/039) para que los
-- cuatro se lean igual. Diferencias deliberadas:
--   - `public = FALSE` desde el primer día (los otros nacieron públicos
--     y los cerró la 044).
--   - 256 MB: una cuenta grande exportando un año de mensajería en CSV
--     pasa holgadamente de los 16 MB de `chat-media`.
--   - Solo los dos tipos que este código escribe.
-- ============================================================
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'exports',
  'exports',
  FALSE,
  268435456, -- 256 MB
  ARRAY['application/json', 'text/csv']
)
ON CONFLICT (id) DO UPDATE
SET
  public = EXCLUDED.public,
  file_size_limit = EXCLUDED.file_size_limit,
  allowed_mime_types = EXCLUDED.allowed_mime_types;

-- Nada de `CREATE POLICY ... ON storage.objects` para este bucket: ver
-- la cabecera. `verify-schema.sql` afirma que sigue sin ninguna.
