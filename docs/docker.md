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

### Fonts: no network needed at build time

The UI font (Inter) ships in the repository, under `src/app/fonts/`
(SIL Open Font License 1.1, see `LICENSE-Inter.txt` next to the files),
and is loaded with `next/font/local`. `next build` — and so
`docker compose ... up --build` — no longer downloads anything from
Google Fonts, so the image builds on a machine or CI runner without
outbound internet access. There is no font-related variable to set.

## Build-time vs runtime variables

- `NEXT_PUBLIC_*` variables are **inlined into the client bundle at
  build time**. They are passed as Docker build args by
  `docker-compose.yml`. If you change any of them, rebuild:
  `docker compose --env-file .env.local up --build -d`.
- `NEXT_PUBLIC_APP_LOCALE` picks the language of every screen. It
  defaults to **`es`** (Spanish) in the `Dockerfile` and in
  `docker-compose.yml`; the only other shipped catalogue is `en`. Any
  other value — including `ko`, no longer shipped — falls back to `es`
  whole; there is no per-key fallback. Being a `NEXT_PUBLIC_*` it is baked in at build time,
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

By default every account brings its own OpenAI / Anthropic / Gemini key in
Settings → AI. A deployment that wants to pay for AI on behalf of its
accounts (the SaaS model) can set a platform-level key per provider:

| Variable                        | Used when                                                             |
| ------------------------------- | --------------------------------------------------------------------- |
| `AI_PLATFORM_OPENAI_API_KEY`    | an account's provider is `openai` and it has not saved its own key    |
| `AI_PLATFORM_ANTHROPIC_API_KEY` | an account's provider is `anthropic` and it has not saved its own key |
| `AI_PLATFORM_GEMINI_API_KEY`    | an account's provider is `gemini` and it has not saved its own key    |

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
`AI_PLATFORM_OPENAI_API_KEY` set. The embeddings key belongs to the
**embeddings provider** the account picks in Settings → AI (migration
068): OpenAI (`text-embedding-3-small`) or Google Gemini
(`gemini-embedding-2`, requested at 1536 dimensions to fit the same
`vector(1536)` column). It is independent of the chat provider — an
account on Anthropic saves whichever of the two it prefers. Vectors from
the two are not comparable: after switching provider, press **Reindex**
in the knowledge base, or semantic search returns noise until every
document is re-embedded.

These variables are server-only runtime secrets (never `NEXT_PUBLIC_*`);
the app only ever tells the browser _whether_ a platform key exists,
never its value. With none of them set the behaviour is exactly the
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

## Auth email links (`/auth/callback`, `/reset-password`)

**No new environment variables.** Every email Supabase Auth sends for this app
(sign-up confirmation, password recovery, and the invitations the operator
panel sends when it creates a company or adds a member) points at
`<site>/auth/callback`, which opens the
session and sends the person on: invitations and recoveries to
`/reset-password` to choose a password, then to `/join/<token>` if there is a
team invitation, to `/platform` for an operator, or to `/dashboard`. The URLs
are built by `authCallbackUrl()` in `src/lib/auth/redirects.ts`.

**Supabase Auth → URL Configuration.** Set **Site URL** to the deployment's
origin (the same value as `NEXT_PUBLIC_SITE_URL`) and add these to **Redirect
URLs**, for each origin the app is served from (production, staging,
`http://localhost:3000`):

| Redirect URL              | Why                                                                                    |
| ------------------------- | -------------------------------------------------------------------------------------- |
| `<site>/auth/callback**`  | Every auth email. The `**` covers the query string (`?next=/reset-password&invite=…`). |
| `<site>/reset-password**` | Only if you point a custom template straight at it.                                    |
| `<site>/join/**`          | Invitation links sent before this change, which pointed at `/join/<token>` directly.   |

A `redirectTo` that is not allowed is silently replaced by the Site URL, and the
person lands on the home page with a link nobody reads.

**Email templates.** The app accepts both link formats, so the templates can
stay as they are:

- **Default template** (`{{ .ConfirmationURL }}`): the link goes to Supabase
  first, which then redirects to `/auth/callback`. For a sign-up or a recovery
  requested from this app's pages (PKCE) it arrives as `?code=…`, exchanged on
  the server — it only works in **the same browser** that asked for it. For an
  invitation (`inviteUserByEmail`, which cannot use PKCE) it arrives with the
  tokens in the fragment (`#access_token=…&type=invite`), which the server never
  sees; `/auth/callback` passes it to `/auth/callback/complete`, which opens the
  session in the browser.
- **Token-hash template** (recommended for **Invite user** and **Reset
  password** only): link straight to the app with
  `{{ .RedirectTo }}&token_hash={{ .TokenHash }}&type=invite` (and
  `type=recovery` in the reset template). The server verifies it with
  `verifyOtp`; it works in any browser, and the tokens never appear in the URL.
  `{{ .RedirectTo }}` keeps the `?next=/reset-password&invite=…` the app put
  there — without it a member invited to a team would not reach `/join/<token>`
  — and the app always sends a query string on these two emails, so the `&` is
  safe. Leave **Confirm signup** on the default template: its redirect may have
  no query string, and the PKCE `code` already covers it.

  **Only switch to this template when every sender uses `authCallbackUrl()`.**
  It works only when the app's `redirectTo` already carries a query string
  (`/auth/callback?next=…`), which is the case for `/forgot-password` and for
  the invitations of the operator panel (new company: `?next=/reset-password`;
  new member: `?next=/reset-password&invite=<token>`). It does **not** work for
  emails sent from the Supabase dashboard (Authentication → Users → "Invite
  user" / "Send password recovery"): there `{{ .RedirectTo }}` is the bare Site URL, so the
  link comes out as `https://site&token_hash=…` and breaks. The same happens if
  a `redirectTo` is rejected by the Redirect URLs above. If you need those
  emails too, keep the default template.

An expired or reused link shows "This link no longer works" with a button to
`/forgot-password`.

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
- **Outbound webhooks need their own scheduler.** `GET /api/webhooks/cron`
  drains the delivery queue (`webhook_deliveries`, migration 062): it
  retries what failed on the S-A6 ladder — 1 min, 5 min, 30 min, 2 h,
  12 h — and purges deliveries older than 30 days. Same contract as the
  two above: the shared secret travels in `x-cron-secret`, this time
  `WEBHOOK_CRON_SECRET`, and the route answers 503 until the variable is
  set.

  | Variable              | Required                         | What it is                                                                                                         |
  | --------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
  | `WEBHOOK_CRON_SECRET` | to retry failed webhook delivery | Random string, compared in constant time. Without it the first attempt still happens, but nothing is ever retried. |

  Run it **every minute**: one minute is the first step of the ladder, so
  a slower schedule delays every retry. Each sweep is bounded (a cap per
  account, so one busy tenant cannot starve another) and overlapping runs
  are safe — the claim is an optimistic `UPDATE` on `attempt`, so two
  sweeps never deliver the same row twice.

  ```bash
  * * * * * curl -fsS -H "x-cron-secret: $WEBHOOK_CRON_SECRET" \
    https://your-crm.example.com/api/webhooks/cron >/dev/null
  ```

  The same sweep also finishes the export jobs of
  `POST /api/v1/exports` (migration 063) whose first attempt was cut
  short, and deletes export files and rows older than 7 days. It runs on
  a separate budget — at most five exports per sweep, one per account —
  so a tenant exporting a year of history never delays anybody's webhook
  retries. No extra variable: without the scheduler an export that was
  interrupted stays `queued` and expired files are never removed.

  **The same sweep also renews the WhatsApp tokens of Embedded Signup**
  (migration 067). The Embedded Signup configuration of a platform
  deployment mints business tokens that expire after 60 days (Meta's
  WhatsApp template fixes that lifetime), so every number connected
  through the dialog would go silent two months later. Each run looks
  for `embedded_signup` rows whose `token_expires_at` is less than 14
  days away, exchanges the token with Meta
  (`grant_type=fb_exchange_token`) and stores the fresh one encrypted.
  A refusal is recorded on the row (`token_renewal_error`) and retried
  no sooner than 6 hours later; a token that expired without a renewal
  cannot be refreshed — the customer reconnects the number from
  Settings → WhatsApp. The response carries a `tokens` block
  (`enabled`, `scanned`, `renewed`, `failed`, `skipped`); `enabled` is
  `false` on a self-hosted deployment, where there is nothing to renew.
  **This is the only thing keeping platform tokens alive: a platform
  deployment without this scheduler loses every connected number after
  60 days.**

  **And it checks whether each WhatsApp Business account has a payment
  method in Meta** (migration 079, p11.1). Since 2026-10-01 Meta stops
  delivering messages from a WABA without one, and the CRM showed such a
  number as "Connected". Each run checks at most 25 connected numbers
  that are due — never checked, `missing` for an hour, `unknown` for 6 h,
  `ok` for 24 h — with one `GET /{waba_id}?fields=id,primary_funding_id`
  per number and that number's own token, and stores the answer on the
  row. The CRM then shows a red banner while a number is `missing` (with
  a link to Meta's Billing Hub) and nothing for accounts whose Meta bill
  Cabbity pays (`subscriptions.meta_billing = 'managed'`). The same check
  runs when a number is connected and from «Check again» in Settings →
  WhatsApp. The response carries a `payments` block (`enabled`,
  `scanned`, `checked`, `ok`, `missing`, `unknown`). Inbound messages and
  sends are never blocked by it: the notice is informative.

  | Variable                      | Required | What it is                                                                                                                                                                        |
  | ----------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `META_PAYMENT_CHECK_DISABLED` | no       | `1` switches the payment-method check off entirely: no call to Meta (signup, manual save, sweep or button) and no banner; «Check again» answers 409. Unset or anything else = on. |

  The Meta field this relies on (`primary_funding_id` on the WABA node,
  absent when there is no payment method) is an **unverified assumption**
  (S-M1/S-M2 in `specs/meta-payment-method-check/design.md`): Graph also
  omits fields a token cannot see, which would read as a false "no
  payment method". The interpretation is conservative — only a 2xx that
  echoes the requested WABA `id` with no `primary_funding_id` counts as
  `missing`; any error, permission problem or odd answer is `unknown`,
  which never shows the red banner — but until someone has checked a
  WABA with and without a card in the Graph API Explorer, keep
  `META_PAYMENT_CHECK_DISABLED=1` at hand: if the field does not behave
  as described, set it and the whole feature goes quiet.

- **Managed Meta billing needs the cut-off scheduler** (migration 078).
  `GET /api/billing/cron` issues the monthly statement of every account
  whose Meta messages Cabbity CRM pays (`meta_billing = 'managed'`) once
  its statement cut-off (`subscriptions.statement_period_end`, its own
  anchor: a PayPal renewal moving `current_period_end` never skips a
  month) has passed: package fee plus the overage of
  delivered messages, due three days after the cut-off. Until it is paid
  the account is `past_due`; past the due date it is read-only (it can
  still read, and inbound messages keep arriving). A PayPal account with
  no overage gets no statement and its cut-off simply moves on a month.
  Same contract as the crons above: the secret travels in
  `x-cron-secret`, and the route answers 503 until the variable is set.

  | Variable              | Required                                 | What it is                                                                                              |
  | --------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------- |
  | `BILLING_CRON_SECRET` | to bill accounts on managed Meta billing | Random string, compared in constant time. Without it no statement is ever issued and nobody is cut off. |

  Run it **at least hourly** (it is idempotent: one statement per account
  and cut-off, so running it every few minutes is safe too). The response
  carries a `statements` block (`scanned`, `issued`, `existing`,
  `extended`, `failed`, `errors`); an account whose deliveries have no
  Meta rate loaded is skipped with a `rate_missing` error naming the
  market and category — load it from `/platform/rates` and the next run
  bills it.

  ```bash
  0 * * * * curl -fsS -H "x-cron-secret: $BILLING_CRON_SECRET" \
    https://your-crm.example.com/api/billing/cron >/dev/null
  ```

  The same run also reconciles with Meta (migration 084): at most once a
  day per managed account with a connected number (WABA id and token),
  it asks Graph for the WABA's `pricing_analytics` from the first day of
  the previous month (UTC) until now and stores one row per day, number
  and category in `meta_spend_snapshots`. The operator's statement card
  shows the difference between our Meta cost and Meta's. Its counts
  travel in a `reconciliation` block (`scanned`, `fetched`, `skipped`,
  `failed`); `skipped` is an account already read in the last 24 hours
  or beyond the batch of 10 per run. No new variable.

  **Unverified assumption** (written without network access): the call
  is
  `GET /v21.0/{waba_id}?fields=pricing_analytics.start(<unix>).end(<unix>).granularity(DAILY).metric_types(["COST","VOLUME"]).dimensions(["PHONE","PRICING_CATEGORY"])`
  with the account's own token, answering
  `{"pricing_analytics":{"data":[{"data_points":[{"start":…,"end":…,"phone_number":"1809…","pricing_category":"MARKETING","volume":120,"cost":8.88}]}]}}`.
  Any other shape — a missing field, a point without `cost` or
  `volume`, a negative figure — stores nothing for that WABA (it counts
  as `failed` and is retried on the next run) and the statement says
  «no Meta data»; it never makes the cron fail. An empty `data` is
  stored as a zero mark for the day. Meta calls this cost approximate:
  its invoice is what counts.
