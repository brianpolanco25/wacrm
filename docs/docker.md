# Running with Docker

The repo ships a multi-stage `Dockerfile` (Next.js standalone output,
runs as a non-root user) and a `docker-compose.yml` with a single
`app` service. Supabase is external — point the app at your hosted
(or self-hosted) Supabase project via env vars; no database container
is included.

## Quick start

1. Copy the env template and fill it in:

   ```bash
   cp .env.local.example .env.local
   ```

2. Build and start (the `--env-file` flag is required — Compose only
   reads `.env` by default for `${VAR}` substitution, and this project
   keeps its config in `.env.local`):

   ```bash
   docker compose --env-file .env.local up --build -d
   ```

3. The app is served on [http://localhost:3000](http://localhost:3000)
   (publish it elsewhere with `HOST_PORT=8080` in `.env.local`).

> Use `HOST_PORT`, not `PORT`, to move the published port. `PORT` is
> what the server listens on _inside_ the container, and `env_file`
> would inject it there — leaving the app on a port the mapping and
> the healthcheck don't target. Compose pins it to 3000 for that
> reason.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- Everything else (`SUPABASE_SERVICE_ROLE_KEY`, `ENCRYPTION_KEY`,
  `ENCRYPTION_KEY_PREVIOUS`, `META_APP_SECRET`,
  `META_WEBHOOK_VERIFY_TOKEN`, …) is read at
  **runtime** from `.env.local` via `env_file` and is never baked into
  the image — safe to change with just a container restart.
- `ENCRYPTION_KEY_PREVIOUS` is optional and normally unset. It holds
  retired encryption keys (comma-separated, same 64-hex-character
  format as `ENCRYPTION_KEY`) so secrets written before a key rotation
  keep decrypting while they are re-encrypted. Set it, restart, run
  `node --env-file=.env.local scripts/reencrypt-secrets.ts`, then unset
  it and restart again — the full runbook is in `docs/security.md`.
  Leaving a retired key in place indefinitely means a leaked old key
  still reads every row it ever wrote.
- `META_WEBHOOK_VERIFY_TOKEN` is optional and only for platform
  deployments: one Meta app in front of every tenant. Set it to the same
  random string you type into the Meta app's webhook settings and the
  `GET` verification compares against it in constant time instead of
  decrypting every `whatsapp_config` row. Leave it unset on a
  self-hosted install where each business brings its own Meta app — the
  per-tenant lookup then works as before. The value is trimmed, so an
  empty or whitespace-only one counts as unset. Details in
  `docs/security.md`.

## Plain Docker (no Compose)

```bash
docker build \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://your-project.supabase.co \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key \
  -t wacrm .

docker run -d --env-file .env.local -e PORT=3000 -p 3000:3000 wacrm
```

## Notes

- Database migrations under `supabase/` are **not** run by the
  container — apply them with the Supabase CLI as described in the
  README.
- Received attachments are copied into the `chat-media` Supabase
  Storage bucket, because Meta deletes media roughly 30 days after it
  arrives and the copy is the only thing that outlives that. It grows
  with inbound volume, so it's worth watching your project's storage
  quota. Turn it off per account under Settings → WhatsApp →
  Attachment Storage; attachments received while it's off become
  unviewable once Meta drops them. Files over 16 MB (the bucket's
  limit) are never copied.
- Nothing inside the container is scheduled. If you use automation
  Wait steps or flows, point an external scheduler at
  `GET /api/automations/cron` and `GET /api/flows/cron` on this
  deployment, sending the shared secret in the `x-cron-secret` header
  (`AUTOMATION_CRON_SECRET`, see `.env.local.example`). Both return
  503 until that variable is set.
