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
  `META_APP_SECRET`, …) is read at **runtime** from `.env.local` via
  `env_file` and is never baked into the image — safe to change with
  just a container restart.

## Platform AI keys (optional)

By default every account brings its own OpenAI / Anthropic key in
Settings → AI. A deployment that wants to pay for AI on behalf of its
accounts (the SaaS model) can set a platform-level key per provider:

| Variable | Used when |
|---|---|
| `AI_PLATFORM_OPENAI_API_KEY` | an account's provider is `openai` and it has not saved its own key |
| `AI_PLATFORM_ANTHROPIC_API_KEY` | an account's provider is `anthropic` and it has not saved its own key |

Resolution order is always: the account's own key → the platform key
for its provider → AI not configured. Both variables are server-only
runtime secrets (never `NEXT_PUBLIC_*`); the app only ever tells the
browser _whether_ a platform key exists, never its value. With neither
variable set the behaviour is exactly the bring-your-own-key one: the
key field is required when saving an AI configuration.

## PayPal catalogue (optional until billing is enabled)

Create the initial product and six plans in the PayPal sandbox with
`node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts`. It requires
these server-only runtime variables; it is safe to run again because it keeps
the stored provider ids and uses stable PayPal request ids:

| Variable               | Purpose                                                              |
| ---------------------- | -------------------------------------------------------------------- |
| `PAYPAL_CLIENT_ID`     | PayPal REST API client credential                                   |
| `PAYPAL_CLIENT_SECRET` | PayPal REST API client secret                                       |
| `PAYPAL_ENV`           | `sandbox` (default) or `live`; create and check sandbox plans first |
| `PAYPAL_PRODUCT_NAME`  | Optional product name; defaults to `wacrm`                          |

The script also uses the existing `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` only to read the global `plans` catalogue and save
each resulting provider plan id. It does not run as part of the web app.

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
