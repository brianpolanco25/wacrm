#!/usr/bin/env bash
# Replica en local lo que hace .github/workflows/migrations.yml:
# arranca un Postgres de Supabase limpio (con schemas auth/storage y roles
# anon/authenticated/service_role), aplica supabase/migrations/*.sql en
# orden con ON_ERROR_STOP y corre supabase/ci/verify-schema.sql.
#
# Uso: replay-migrations.sh [ruta-del-repo]   (por defecto: cwd)
# Salida 0 = todo aplicó y el verify pasó.
set -euo pipefail
REPO="${1:-$(pwd)}"
IMAGE="supabase/postgres:17.4.1.075"
NAME="wacrm-migrations-$$"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker run -d --name "$NAME" -e POSTGRES_PASSWORD=postgres "$IMAGE" >/dev/null
for i in $(seq 1 60); do
  if docker exec "$NAME" pg_isready -U supabase_admin -h localhost >/dev/null 2>&1 \
     && docker exec "$NAME" psql -U supabase_admin -h localhost -d postgres -tAc "select 1 from pg_namespace where nspname='storage'" 2>/dev/null | grep -q 1; then
    break
  fi
  sleep 2
done
# Espera a que terminen los init scripts de la imagen (auth/storage).
sleep 3

PSQL=(docker exec -i "$NAME" psql -U postgres -h localhost -d postgres -v ON_ERROR_STOP=1 -q)

# La imagen trae el esquema storage inicial; en Supabase real es storage-api
# quien añade las columnas modernas (public, file_size_limit, ...). Las
# añadimos aquí para igualar lo que ve `supabase db reset`.
docker exec -i "$NAME" psql -U supabase_admin -h localhost -d postgres -v ON_ERROR_STOP=1 -q <<'SQL'
ALTER TABLE storage.buckets
  ADD COLUMN IF NOT EXISTS public boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS avif_autodetection boolean DEFAULT false,
  ADD COLUMN IF NOT EXISTS file_size_limit bigint,
  ADD COLUMN IF NOT EXISTS allowed_mime_types text[],
  ADD COLUMN IF NOT EXISTS owner_id text;
ALTER TABLE storage.objects
  ADD COLUMN IF NOT EXISTS path_tokens text[] GENERATED ALWAYS AS (string_to_array(name, '/')) STORED,
  ADD COLUMN IF NOT EXISTS version text,
  ADD COLUMN IF NOT EXISTS owner_id text,
  ADD COLUMN IF NOT EXISTS user_metadata jsonb;
SQL
fail=0
for f in "$REPO"/supabase/migrations/*.sql; do
  if ! "${PSQL[@]}" < "$f" >/tmp/replay-out.txt 2>&1; then
    echo "FALLÓ: $(basename "$f")"; cat /tmp/replay-out.txt; fail=1; break
  fi
  echo "ok  $(basename "$f")"
done
if [ $fail -eq 0 ]; then
  if "${PSQL[@]}" < "$REPO/supabase/ci/verify-schema.sql" >/tmp/replay-out.txt 2>&1; then
    echo "verify-schema.sql: OK"
  else
    echo "verify-schema.sql FALLÓ:"; cat /tmp/replay-out.txt; fail=1
  fi
fi
# Deja el contenedor vivo si se pide, para depurar a mano.
if [ "${KEEP:-0}" = "1" ]; then trap - EXIT; echo "contenedor vivo: $NAME (docker exec -it $NAME psql -U postgres)"; fi
exit $fail
