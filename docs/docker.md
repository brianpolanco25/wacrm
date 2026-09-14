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
- `NEXT_PUBLIC_APP_LOCALE` picks the language of every screen. It
  defaults to **`es`** (Spanish) in the `Dockerfile` and in
  `docker-compose.yml`; the other two shipped catalogues are `en` and
  `ko`. There is no per-key fallback: an unknown value loads the English
  catalogue whole. Being a `NEXT_PUBLIC_*` it is baked in at build time,
  so changing the language means a rebuild, not a restart.
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
- `META_WEBHOOK_VERIFY_TOKEN` is for platform deployments: one Meta app
  in front of every tenant. Set it to the same random string you type
  into the Meta app's webhook settings and the `GET` verification
  compares against it in constant time instead of decrypting every
  `whatsapp_config` row. Leave it unset on a self-hosted install where
  each business brings its own Meta app — the per-tenant lookup then
  works as before. The value is trimmed, so an empty or whitespace-only
  one counts as unset. Details in `docs/security.md`.
  **It is optional only in self-hosted mode.** With the integrated
  sign-up enabled (see below) every row is saved with no per-tenant
  verify token, so this variable becomes the only thing Meta can verify
  the webhook against: without it, verification answers 403 forever and
  no inbound message arrives. Settings → WhatsApp shows a warning when
  the integrated sign-up is on and this is missing.

## Integrated WhatsApp sign-up (platform mode)

Optional, and off unless configured. With it, a company connects
WhatsApp from inside Settings → WhatsApp — Meta's own dialog, with **our**
app — instead of opening a developer account, creating an app, passing
business verification and pasting tokens. Without it the app is
self-hosted: the manual form is the only way in, and it keeps working
exactly as before.

| Variable             | Required         | What it does                                                                                                                                                                                                           |
| -------------------- | ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `META_APP_ID`        | in platform mode | Our Meta app id. It already existed for image-header templates; it is now also half of the code-for-token exchange.                                                                                                    |
| `META_CONFIG_ID`     | in platform mode | The Embedded Signup configuration created in the Meta app panel (App → WhatsApp → Embedded Signup). **This is the switch**: set, the Connect button appears and the route works; unset, the deployment is self-hosted. |
| `META_APP_SECRET`    | always           | Already required for webhook signature verification; the exchange needs it too. Never leaves the server.                                                                                                               |
| `META_GRAPH_VERSION` | no               | Defaults to `v21.0`, the same version the rest of the Graph calls use (`META_API_VERSION`). Lets you move the dialog and the exchange to a newer Graph version without a deploy — see the note below.                  |

> **Graph version:** Meta's Embedded Signup guide recommends `v25.0` in
> `FB.init`. The default here stays at `v21.0` on purpose, because that
> is the version every other Graph call in the app uses
> (`META_API_VERSION` in `src/lib/whatsapp/meta-api.ts`), and a single
> deployment straddling two versions is hard to debug. Setting
> `META_GRAPH_VERSION=v25.0` moves only the dialog and the code
> exchange, which is the supported way to follow Meta's recommendation
> without re-dating sends, media uploads and template sync.

None of these is a `NEXT_PUBLIC_*`, so none is baked into the image:
changing one is a container restart, not a rebuild. The browser asks the
server for the two public ids through `GET /api/whatsapp/embedded-signup`.

Before any of it works there is paperwork that is not code: business
verification, the app in live mode, and approval of the
`whatsapp_business_management` and `whatsapp_business_messaging`
permissions.

**Allow your domain in the app panel**, under Facebook Login for
Business → Settings → Client OAuth settings: the domain you serve Cabbity CRM
from has to be listed in both **Allowed Domains for the JavaScript SDK**
and **Valid OAuth redirect URIs**, and only `https://` domains are
accepted. Without it the dialog opens, the customer finishes it, and
nothing comes back to the page that opened it — no error, no row.

**Configure the webhook once, at app level** (Meta app panel → WhatsApp →
Configuration): URL `https://<your-domain>/api/whatsapp/webhook`, verify
token = the value of `META_WEBHOOK_VERIFY_TOKEN`, subscribed fields
`messages` and `message_template_status_update`. Tenants never configure
a webhook again.

> **Moving an existing self-hosted instance to platform mode:** rows
> connected the old way hold a token minted by the _customer's_ Meta app,
> and Meta signs their webhooks with _that_ app's secret — so those
> deliveries start failing signature verification with 401. That is the
> correct behaviour, not a bug. Each tenant has to reconnect once through
> the dialog. `whatsapp_config.provisioned_via` tells the two apart
> (`manual` vs `embedded_signup`).

## Platform AI keys (optional)

By default every account brings its own OpenAI / Anthropic key in
Settings → AI. A deployment that wants to pay for AI on behalf of its
accounts (the SaaS model) can set a platform-level key per provider:

| Variable                        | Used when                                                             |
| ------------------------------- | --------------------------------------------------------------------- |
| `AI_PLATFORM_OPENAI_API_KEY`    | an account's provider is `openai` and it has not saved its own key    |
| `AI_PLATFORM_ANTHROPIC_API_KEY` | an account's provider is `anthropic` and it has not saved its own key |

Resolution order for the **chat** key (drafts, auto-reply, playground,
"Test key", save): the account's own key → the platform key for its
provider → AI not configured. An account that saved its own key can hand
it back with **Use the platform's key instead** in Settings → AI (the
link only appears when this deployment has a key for that provider);
the platform key takes over from the next save on. Simply clearing the
input does not drop a stored key — that gesture is reserved for the
explicit link, so focusing the field cannot cost an account its key.

This fallback covers the chat key only. The **embeddings** key
(`ai_configs.embeddings_api_key`, used to index the knowledge base) has
no platform-level equivalent: an account that does not save one keeps
using lexical search even on a deployment with
`AI_PLATFORM_OPENAI_API_KEY` set.

Both variables are server-only runtime secrets (never `NEXT_PUBLIC_*`);
the app only ever tells the browser _whether_ a platform key exists,
never its value. With neither variable set the behaviour is exactly the
bring-your-own-key one: the key field is required when saving an AI
configuration.

Every LLM call is logged to `ai_usage_log` with a `key_source` column
(`'account'` or `'platform'`), so the spend a deployment funds for its
tenants can be measured per account. All three surfaces that call a
provider write a row, told apart by `mode`: `auto_reply`, `draft` and
`playground`.

## PayPal catalogue (optional until billing is enabled)

Create the initial product and six plans in the PayPal sandbox with
`node --env-file=.env.local scripts/paypal-bootstrap-catalog.ts`. It requires
these server-only runtime variables; it is safe to run again **against the same
environment's database** because it keeps the stored provider ids and uses
stable PayPal request ids:

| Variable               | Purpose                                                             |
| ---------------------- | ------------------------------------------------------------------- |
| `PAYPAL_CLIENT_ID`     | PayPal REST API client credential                                   |
| `PAYPAL_CLIENT_SECRET` | PayPal REST API client secret                                       |
| `PAYPAL_ENV`           | `sandbox` (default) or `live`; create and check sandbox plans first |
| `PAYPAL_PRODUCT_NAME`  | Optional product name; defaults to `Cabbity CRM`                    |

The script also uses the existing `NEXT_PUBLIC_SUPABASE_URL` and
`SUPABASE_SERVICE_ROLE_KEY` only to read the global `plans` catalogue and save
each resulting provider plan id. It does not run as part of the web app.

### Going from sandbox to live

`plans.provider_plan_id_month` and `plans.provider_plan_id_year` hold the ids
of exactly **one** PayPal environment, and a sandbox id is indistinguishable
from a live one by sight. So sandbox and live need **separate databases**
(separate Supabase projects); never point a live run at the sandbox database,
and never copy sandbox ids into production. The procedure:

1. Against the sandbox database, with `PAYPAL_ENV=sandbox` and the sandbox
   credentials, run the command and try checkout, payment failure and
   cancellation with sandbox buyers.
2. Apply the migrations up to `045_billing_provider_plans.sql` to the live
   database and confirm its `plans` rows still have `NULL` provider ids.
3. In the shell of that live deployment, set `PAYPAL_ENV=live`, the live PayPal
   credentials and that database's `NEXT_PUBLIC_SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY`. Run the command once and record the six ids.
4. Run it a second time as an idempotency check: it must log six `skipping`
   lines and create nothing. A live run that finds ids already stored also
   prints a `WARNING:` line — expected while resuming a crashed run, a red flag
   if the database was supposed to be empty (usually the wrong database).

Do not edit a stored id to change a price. PayPal plans are effectively
immutable once they have subscribers; create a versioned replacement plan
instead, in a later migration.

A price revision in the database (`059_plan_inicio_35.sql` raised Inicio to
35 USD/month) does **not** reach PayPal on its own, and re-running the script
will not push it either: the script skips any cycle whose
`provider_plan_id_*` is already stored. On a deployment that has already
bootstrapped, the replacement is three steps — a migration that clears the two
ids of the repriced plan (keeping the old ones on record for the subscribers
still on them), bumping the `-v1` suffix of the `PayPal-Request-Id` in
`scripts/paypal-bootstrap-catalog.ts` so PayPal does not return the old plan
for the same idempotency key, and a run of the script. Existing subscribers
keep paying the plan they contracted until they are migrated one by one.

## Checkout (`/billing`)

Contracting a plan runs in the web app and needs the same
`PAYPAL_CLIENT_ID` / `PAYPAL_CLIENT_SECRET` / `PAYPAL_ENV` as the catalogue
script, plus one variable that is not PayPal's:

| Variable               | Purpose                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------- |
| `NEXT_PUBLIC_SITE_URL` | Canonical URL of this deployment. PayPal returns approvers to `<url>/billing/return`. |

`NEXT_PUBLIC_SITE_URL` already existed for invite links, and checkout reuses
it. Without it the return URL is derived from the request headers
(`x-forwarded-host`, then `Host`), which works behind a well-configured proxy
but breaks the moment one is misconfigured — the customer pays and lands
nowhere. Set it. Being a `NEXT_PUBLIC_*` variable it is **baked into the
image at build time** (see the build arguments below), not read at runtime.

Nothing here activates a subscription: the return page only reports status
and the plan turns on when the PayPal webhook arrives.

## PayPal webhook (`/api/billing/webhook`)

This endpoint is what actually turns a payment into service. Point a PayPal
webhook at `https://<your deployment>/api/billing/webhook` and subscribe it to
the six events the app acts on:

```
BILLING.SUBSCRIPTION.ACTIVATED
BILLING.SUBSCRIPTION.UPDATED
BILLING.SUBSCRIPTION.CANCELLED
BILLING.SUBSCRIPTION.SUSPENDED
BILLING.SUBSCRIPTION.PAYMENT.FAILED
PAYMENT.SALE.COMPLETED
```

| Variable            | Purpose                                                          |
| ------------------- | ---------------------------------------------------------------- |
| `PAYPAL_WEBHOOK_ID` | Id of that webhook in PayPal. Required to verify every delivery. |

PayPal does not sign with HMAC: every delivery is verified by calling PayPal
back with the five `paypal-transmission-*` headers, the raw body and this id.
**Without `PAYPAL_WEBHOOK_ID` the endpoint rejects everything** — it fails
closed on purpose, the same way the Meta webhook does without
`META_APP_SECRET`. A forgotten variable must mean "nobody gets service", never
"anybody can grant themselves service". It is server-only and, like the rest of
the PayPal credentials, belongs to one environment: the sandbox webhook id and
the live one are different values.

Sandbox and live each need their own webhook and their own id. After changing
the deployment URL, update the webhook in PayPal and re-copy the id — a webhook
that still points at the old host delivers nothing, and subscriptions silently
stop activating.

### When an event could not be applied

A delivery that verifies but cannot be matched to an account (for instance a
PayPal subscription created outside the app) is still stored, and left in the
reconciliation queue instead of being guessed at:

```sql
SELECT received_at, event_type, error, payload
  FROM billing_events
 WHERE processed_at IS NULL AND error IS NOT NULL
 ORDER BY received_at DESC;
```

Nothing is lost — the full payload is on the row — but nothing is applied
either. Fix the cause and hit **Resend** on that delivery in PayPal's webhook
dashboard: a redelivery of an event that was never applied (`processed_at IS
NULL`) is processed again, so no row has to be deleted by hand. An event that
_did_ complete is never applied twice, however often PayPal resends it.

## Subscription area (Settings → Subscription)

**No new environment variables.** It reuses `PAYPAL_CLIENT_ID`,
`PAYPAL_CLIENT_SECRET`, `PAYPAL_ENV`, `PAYPAL_WEBHOOK_ID` and
`NEXT_PUBLIC_SITE_URL` from the sections above. Two operational notes:

- **`BILLING.SUBSCRIPTION.UPDATED` is not optional.** It is the event that
  applies a plan change made from Settings: the app revises the _same_ PayPal
  subscription (no second subscription, no double charge) and the change lands
  only when that event arrives. If the webhook is not subscribed to it, a
  customer who changes plan keeps being billed and served on the old one.
- **`NEXT_PUBLIC_SITE_URL` is used again here.** A plan change that raises the
  amount needs the buyer's approval at PayPal, which returns them to
  `<url>/billing/return`, exactly like a first checkout. Remember it is baked in
  at build time.

Migration `056_subscription_cycle_and_receipts.sql` must be applied before this
page is used: without `subscriptions.cycle`, a subscription moved from monthly
to yearly would be charged for a year and extended by a month. Existing rows are
backfilled from the checkout that created them, so nothing changes for anyone
who has not changed plan.

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
