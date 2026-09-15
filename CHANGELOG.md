# Changelog

User-visible changes in `wacrm`. Self-hosters: when pulling an update,
check this file for any **migration required** notes and apply the
matching SQL files from `supabase/migrations/` against your Supabase
project before restarting the app.

Versions follow [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).
Pre-1.0, `MINOR` bumps cover new modules; `PATCH` bumps cover bug fixes
and polish.

## [Unreleased]

Fase 0 of the SaaS programme (`docs/saas/fase-0-cimientos.md`): the
database and server-side groundwork for billing. **No user-visible
behaviour changes**; nothing is limited by plan yet.

> **Migration required:** apply
> `supabase/migrations/040_conversation_assignment_integrity.sql`,
> `supabase/migrations/041_billing_model.sql`,
> `supabase/migrations/042_pick_available_agent.sql`,
> `supabase/migrations/043_ai_handoff_mode.sql`,
> `supabase/migrations/047_ai_platform_key.sql` and
> `supabase/migrations/051_automation_reply_marker.sql`. 040 nulls any
> `conversations.assigned_agent_id` that points at a deleted user before
> adding the foreign key, so a handful of stale "Assigned" badges may
> disappear — those chats return to the unassigned queue.

> **Migration required:** apply
> `supabase/migrations/045_billing_provider_plans.sql` before running the
> PayPal catalogue bootstrap script.

> **Migration required:** apply
> `supabase/migrations/048_checkout_intent.sql` before enabling checkout.
> It adds the `checkout_intents` table; no existing data is touched.
> Apply `supabase/migrations/049_redeem_invitation_checkout_intents.sql`
> together with it — 048 alone would break invitation redemption for
> anyone who ever abandoned a checkout.

> **Migration required:** apply
> `supabase/migrations/050_subscription_event_watermark.sql` before enabling
> the PayPal webhook. It adds `subscriptions.last_event_at` (NULL for every
> existing row) and an index; no existing data is touched.

> **Migration required:** apply
> `supabase/migrations/056_subscription_cycle_and_receipts.sql` before the
> subscription area in Settings. It adds `subscriptions.cycle` (backfilled from
> the checkout that created each subscription) and an index over the payment
> events; no existing data is changed.

> **Migration required:** apply
> `supabase/migrations/053_whatsapp_config_multi_number.sql` before an account
> can connect a second WhatsApp number. It drops the one-number-per-account
> constraint, adds `is_default` / `label` / the display metadata to
> `whatsapp_config`, and adds `whatsapp_config_id` to `conversations` and
> `broadcasts` — backfilled to the number each account already had, so
> nothing changes for a single-number account. Both new foreign keys are
> `ON DELETE SET NULL`: disconnecting a number never deletes a conversation
> or a campaign.

> **Migration required:** apply
> `supabase/migrations/054_embedded_signup.sql` before enabling the
> integrated WhatsApp sign-up. It adds three nullable/defaulted columns to
> `whatsapp_config` (`registration_pin`, `token_expires_at`,
> `provisioned_via`); existing rows are classified as `manual` and nothing
> is rewritten.

> **Migration required:** apply `supabase/migrations/046_seed_trials.sql` and
> `supabase/migrations/052_redeem_invitation_billing.sql` **together** before
> plan limits take effect. 046 gives every existing account — and every account
> created from then on — a 14-day Pro trial, counted from the moment you apply
> it, not from when the account was created. 052 is not optional: without it
> nobody can accept a team invitation any more, because the trial row 046
> creates blocks the deletion of the invitee's empty personal account.

> **Migration required:** apply
> `supabase/migrations/059_plan_inicio_35.sql` to publish the new Inicio
> price. It only rewrites two columns of one catalogue row; it does not
> touch subscriptions, stored PayPal plan ids or what anyone is being
> charged.

> **Migration required:** apply
> `supabase/migrations/060_whatsapp_bsuid.sql` before customers can write
> to you with a WhatsApp username. It adds `contacts.wa_user_id` /
> `contacts.wa_username`, makes `contacts.phone` nullable and replaces the
> NOT NULL with "a phone number or a WhatsApp user id, at least one". No
> row is rewritten and no data is lost; every existing contact keeps its
> number. Note the relaxed column: an integration that assumed
> `contacts.phone` was always present has to handle null from here on.

### Added

- **Customers who write with a WhatsApp username now arrive.** Since
  April 2026 Meta identifies who is writing with a business-scoped user
  id and stops sending their phone number when they use a username and
  have not talked to you in 30 days. Those inbound messages used to be
  dropped on the floor — no contact, no conversation, nothing in the
  inbox. Now:
  - The contact is created from the user id, with their `@username`
    shown wherever the phone number goes ("No number" when they have not
    published one). Searching by username finds them, with or without
    the `@`.
  - Replying works: the inbox composer, flows, automations, reactions
    and broadcasts all send to the user id when there is no phone
    number, and keep using the phone number whenever there is one.
  - Nobody gets duplicated. A contact you already had by phone number
    receives their user id the first time it arrives, and one created
    from a user id receives the phone number when Meta finally includes
    it — the same single row either way.
  - `POST /api/v1/messages` and `POST /api/v1/broadcasts` accept
    `to_user_id` next to `to`; `GET /api/v1/contacts` returns
    `wa_username` and `wa_user_id`. See `docs/public-api.md`.

- **The header says how long the free trial has left.** While the
  account's subscription is on trial, every member — owner, admin, agent
  or viewer — sees a countdown in the dashboard header ("Trial ends in 5
  days", "Trial ends today" on the last day) that links straight to
  `/billing`. It disappears the moment a plan is contracted, and it
  never shows for an account that is no longer on trial: the read-only
  and past-due notices already cover those. It costs no extra request —
  the billing status behind the existing dunning banner is now read once
  per account and shared by both. The pill is tinted with the accent the
  account picked in Settings → Appearance instead of a fixed amber, and
  is legible in light and dark mode.

- **Connect WhatsApp without leaving the app.** On a deployment that runs
  as a platform (one Meta app in front of every company), Settings →
  WhatsApp gains a **Connect WhatsApp** button: Meta's own dialog opens
  in place, the customer picks or creates their WhatsApp Business account
  and number, and the connection is finished — no developer account, no
  Meta console, no pasting tokens. The number is registered and the
  business account subscribed to the app automatically, so inbound
  messages start arriving at that company's inbox.
  - Closing the dialog half-way saves nothing at all, and going through
    it again with the same number refreshes it instead of adding a
    duplicate.
  - The manual form is still there, folded into **Manual connection
    (advanced)** — it is the recovery path when the dialog cannot reach a
    number, and the one support uses.
  - **Self-hosted installs are unaffected.** Without the platform
    variables the button does not appear, the webhook verify-token field
    and the webhook URL stay where they were, and connecting with your
    own Meta app works exactly as before.
  - **For operators:** the integrated sign-up needs `META_APP_ID`,
    `META_CONFIG_ID` and `META_APP_SECRET`, and makes
    `META_WEBHOOK_VERIFY_TOKEN` effectively required — Settings shows a
    warning when it is missing, and your HTTPS domain must be listed in
    the app's Facebook Login for Business → Client OAuth settings.
    `META_GRAPH_VERSION` is optional and defaults to the same Graph
    version as the rest of the app. See `docs/docker.md`.
- **Several WhatsApp numbers per company.** Settings → WhatsApp is now a
  list of connected numbers with an "Add number" button; each card shows
  its name, its connection and registration state, and can be renamed,
  made the default, or removed on its own. The number a message goes out
  through is the one the customer wrote to — the conversation remembers
  it — falling back to the account default for a chat that has never had
  one. A customer who writes to two of your numbers still has a single
  conversation; the replies simply follow whichever number they used
  last.
  - **Broadcasts** ask which number to send from when there is more than
    one, and freeze the answer on the campaign: pausing and resuming days
    later keeps the same sender instead of restarting the 24-hour window
    on another number.
  - **Public API:** `POST /api/v1/messages` accepts an optional `from`
    (a `phone_number_id` of your account) to choose the sender. See
    `docs/public-api.md`.
  - **Plan limits:** the `numbers` allowance is now real. Re-saving a
    number you already have is an edit and costs nothing; a second,
    different number on a one-number plan answers 402 with the upgrade
    link.
  - **Heads-up:** `DELETE /api/whatsapp/config` now requires an `?id=`.
    Called without one it used to delete every number the account had,
    which was the intent with one number and a disaster with three.
  - Known limitation: message templates and inbound-media downloads
    still work against the account's default number. That is correct
    when the numbers share one WhatsApp Business Account (the normal
    case) and wrong when they do not; templates are per-WABA in Meta and
    fixing it properly needs a schema change.
- **Available-agent handoff.** AI handoffs and automation round-robin
  assignment can route chats to the online owner, admin or agent with the
  lightest open/pending workload. If nobody is online, chats remain in the
  shared unassigned queue.
- **Handoff notice.** When the AI assistant steps back and hands a chat to
  a human, it now texts the customer first, so the conversation doesn't
  just go quiet. The text is editable in Settings → AI ("Message when
  handing off"); it is sent once per handoff, is marked as AI-generated
  and does **not** count towards the per-conversation auto-reply cap.
  **Heads-up for existing accounts:** migration 043 seeds the field with
  a default English notice ("Thanks for writing to us. A member of our
  team will continue this conversation shortly."), and Postgres applies
  that default to rows that already exist — so an account that already
  had the assistant configured starts sending it on its next handoff
  without changing any setting. To keep handing off silently, clear the
  field in Settings → AI and save: an empty value means "send nothing".
- **Who is attending, in the inbox list.** Every row now says whether the
  AI assistant is on it, which teammate owns it (with their presence dot)
  or that nobody is — so a chat the assistant handed off and no one picked
  up no longer looks identical to one the assistant is handling. A new
  "Unattended" filter in the list header shows exactly that queue. The
  indicator costs no extra per-chat queries and follows the assignment
  changes other members make, live. Closed chats never raise the "nobody
  on it" flag — the filter is a work queue, not the archive. Switching
  the assistant off in Settings → AI clears "AI replying" from the list
  within about half a minute, no reload needed.
- **Subscription area in Settings** (Settings → Subscription, owners and
  admins). It shows the current plan, the state it is in — trial, active,
  payment failed, suspended, cancelled or expired, with the grace period and a
  scheduled cancellation spelled out — and the date of the next charge. Below
  it, what the account has used this cycle against the plan's allowance, with
  bars, taken straight from the usage counters the server enforces with, so the
  figure on screen is the figure that blocks a send. Then the receipts: amount,
  date and PayPal transaction id of every payment, including payments made on a
  subscription that was later cancelled and replaced. A suspended account can
  still open this page — it is where the way out lives.
  - **Change plan** moves the _same_ PayPal subscription onto the new plan, so
    two subscriptions can never charge at once. There is no proration: the new
    plan applies at the next renewal, and PayPal may ask the customer to
    approve the new amount first, which the page says before anything happens.
    An account with nothing being charged (a trial, or a cancelled
    subscription) is sent to `/billing` to contract instead.
  - **Cancel** cancels at PayPal and keeps the service running to the end of
    the cycle that was already paid for. Nothing is deleted; the account
    becomes read-only afterwards and inbound WhatsApp messages keep arriving.
  - **Reactivate** resumes a subscription PayPal suspended. A subscription that
    was cancelled cannot be resumed — PayPal's cancel is final — so the page
    offers a new checkout instead, and contracting again now works while the
    old subscription is serving out its last paid cycle.
  - None of these actions turns a plan on by itself: as everywhere else in
    billing, the PayPal webhook is what changes the state.
- **A plan change no longer renews on the wrong cycle.** The billing cycle now
  lives on the subscription (`supabase/migrations/056_…`), not only on the
  checkout that created it, so a customer who moves from monthly to yearly has
  their period extended by a year instead of by a month.
- **Plan limits are now enforced.** Outbound messages, broadcast recipients, AI
  replies, operator seats, WhatsApp numbers and knowledge-base documents are
  checked against the plan before the action runs and counted after it
  succeeds, so a failed attempt never shows up on the bill. Going over a limit
  answers with an error that names the limit, what is already used and where to
  raise it, instead of a generic refusal. The public API (`/api/v1`) and
  outbound webhooks are plan features: a plan without them answers with the
  same kind of error and the API key itself stays valid, so upgrading restores
  access with nothing to re-issue. A broadcast is weighed as a **whole
  campaign** before its first message goes out — whether it was started from
  the wizard, from the public API, or resumed/retried from the campaign page —
  so a large send is refused up front instead of stopping half-delivered, and a
  campaign refused for going over the allowance no longer leaves its recipients
  behind as new contacts. Saving a new WhatsApp number over the one the account
  already has counts as changing that number, not as adding a second one, so
  the usual switch from Meta's test number to the production one works on every
  plan. **Inbound WhatsApp messages are never affected** — an account with an
  unpaid invoice and every allowance spent keeps receiving and storing what its
  customers send.
- **A subscription that lapses puts the account in read-only** instead of
  cutting it off. While it is suspended, expired, or past due beyond the grace
  period, everyone on the account behaves like a viewer: they can read
  everything, and sending, broadcasting and AI replies stop. Automations and
  chat flows stop replying too, so a suspended account no longer answers its
  customers by itself while the banner says nothing is going out. Nobody's role
  is changed, so settling the subscription restores the exact permissions each
  member had, with nothing to repair. Reading keeps working everywhere,
  including the AI spend summary and the team's pending invitations. A banner across the app says which of the
  two states the account is in and links straight to `/billing` — which stays
  reachable precisely so an overdue account can pay.
- **Every account now has a 14-day Pro trial with a real end date**
  (`supabase/migrations/046_seed_trials.sql`), including accounts created
  before this release and those created from now on. A trial can contract a
  plan at any time. Nothing expires the trial automatically yet.
- **PayPal webhook** (`POST /api/billing/webhook`). The plan turns on here and
  nowhere else: an approved payment activates the subscription even if the
  customer closed the browser instead of coming back. It handles activation,
  plan and quantity updates, cancellation (service runs to the end of the paid
  cycle), suspension, failed payments (seven days of grace) and renewals. Every
  delivery is verified with PayPal before anything is read from it, and a
  delivery that cannot be verified is rejected — set `PAYPAL_WEBHOOK_ID` or the
  endpoint accepts nothing. A repeated event is recorded once and applied once,
  and an event that arrives out of order can never undo a newer one. Events that
  cannot be matched to an account are kept unapplied in `billing_events` for
  reconciliation rather than guessed at, and resending such a delivery from
  PayPal's dashboard — once the cause is fixed — applies it. A customer who
  cancels and later contracts again is activated on the new subscription; an
  activation that reports a different plan than the one the customer asked for
  is refused instead of granting either. Nothing here limits what an account can
  do yet, and inbound WhatsApp messages are never affected.
- **Plan checkout** (`/billing`). An owner or admin picks a plan and a
  billing cycle, approves the payment on PayPal and comes back to
  `/billing/return`, which only says "we are confirming your payment".
  Activation is **not** done by that page: it waits for the PayPal
  webhook, so closing the browser after approving loses nothing and
  opening the return URL by hand grants nothing. Each attempt is recorded
  in `checkout_intents` (plan, cycle, PayPal subscription id, account) so
  the event can be matched to the right tenant. Contracting is refused
  while the account already has a PayPal subscription being charged —
  changing plan is a separate flow. Set `NEXT_PUBLIC_SITE_URL` so PayPal
  returns customers to your deployment.
- **PayPal catalogue bootstrap.** A server-only script creates one PayPal
  product and the six monthly/annual plan variants, then stores their provider
  ids in `plans`. It targets the sandbox unless `PAYPAL_ENV=live`, pages
  through the PayPal catalogue so it reuses its product even when that product
  is not on the first page, and expects sandbox and live to live in separate
  databases (the stored ids belong to one environment). Billing, checkout and
  webhooks are not enabled by this change.
- **Billing model** (`plans`, `subscriptions`, `usage_counters`,
  `billing_events`) with RLS, the atomic `increment_usage` RPC and the
  seeded `inicio` / `pro` / `negocio` catalogue. Prices and limits are
  provisional until the first paying customer. A tenant can read its own
  subscription and never write it: only the service role does, from the
  payment webhook.
- **Billing rows outlive account deletion.** `subscriptions` and
  `usage_counters` reference `accounts` with `ON DELETE RESTRICT`, so
  `DELETE FROM accounts` now fails while an account still has billing
  data instead of quietly taking it along. Closing an account is a
  deliberate sequence: cancel with the provider, clear (or archive) its
  `subscriptions` and `usage_counters` rows, then delete the account.
  `billing_events` has no foreign key to `accounts` and is kept as the
  audit trail.
- **Entitlements helper** (`src/lib/billing/entitlements.ts`): resolves an
  account's plan, limits, features and read-only state. It is what the
  enforcement layer of "Plan limits are now enforced" above is built on.
- **AI replies are now metered.** Every auto-reply the assistant actually
  delivers adds one — exactly one — to the account's `ai_replies` usage
  counter for the calendar month, and a reply that fails to send is not
  counted. The handoff notice is an acknowledgement rather than a reply
  and does not count either. Counters are per account whichever provider
  key paid for the call, and they are visible to owners and admins. It is
  this same counter that the plan allowance is checked against (see "Plan
  limits are now enforced" above), so the figure on screen is the figure
  that stops the next reply.
- **Platform AI keys.** New optional server variables
  `AI_PLATFORM_OPENAI_API_KEY` / `AI_PLATFORM_ANTHROPIC_API_KEY`. When set,
  an account may leave the API key blank in Settings → AI and the
  platform's key is used; an account's own key still takes precedence.
  Without them nothing changes. `ai_configs.api_key` is now nullable
  (migration 047). The fallback covers the chat key only — the
  embeddings key has no platform-level equivalent.
- **Switching back to the platform key.** An account that saved its own
  provider key can hand it back with **Use the platform's key instead**
  in Settings → AI (shown only when the deployment has a key for that
  provider); the stored key is forgotten on save and the platform's is
  used from then on. Previously a stored key could only be removed by
  deleting the whole AI configuration. The embeddings key gained the
  equivalent **Remove this key** action, which turns semantic
  knowledge-base search back into keyword search.
- **Who paid for each AI call.** `ai_usage_log` gained a `key_source`
  column (`'account'` or `'platform'`, migration 047) so a deployment can
  measure, per account, the model spend it is funding itself. Rows
  written before the change are all bring-your-own-key and are recorded
  as `'account'`.
- **The AI playground is counted too.** Test chats in the playground are
  real provider calls, and now log to `ai_usage_log` under a new
  `'playground'` mode (migration 047 widens the `mode` domain) with the
  same `key_source`. Before this they were the one LLM surface that spent
  tokens invisibly.

- **Encryption key rotation.** Stored secrets (WhatsApp tokens, AI
  provider keys, webhook signing secrets) are now written as
  `k<key-id>:<iv>:<ct>:<tag>`, naming the key they were encrypted with.
  `ENCRYPTION_KEY` stays the active key; a new optional
  `ENCRYPTION_KEY_PREVIOUS` (comma-separated) lets retired keys keep
  decrypting old rows, and values in the two pre-existing formats still
  decrypt with any key in the ring. `scripts/reencrypt-secrets.ts`
  (`--dry-run` to report) rewrites everything under the current key.
  See `docs/security.md`.

  > **One-way format.** Existing rows are rewritten in the new shape by
  > normal traffic (a send, a webhook re-verification), with or without
  > a rotation, and an older build cannot read them: rolling back after
  > this release asks affected accounts to re-enter their WhatsApp
  > token, AI provider key or webhook secret. Back up
  > `whatsapp_config`, `ai_configs` and `webhook_endpoints` first if a
  > rollback is part of your plan.

- **Platform webhook verify token.** When `META_WEBHOOK_VERIFY_TOKEN` is
  set, the WhatsApp webhook's `GET` verification compares against it and
  never reads `whatsapp_config`. Unset, the existing per-tenant lookup is
  unchanged. The value is trimmed (an empty or whitespace-only one counts
  as unset) and a mismatch is logged without echoing either token.
- **Private attachments.** Outbound media (inbox, public API, Flow
  `send_media`, template media headers in broadcasts) is now uploaded to
  Meta and sent by media id instead of a public bucket link, and the
  attachment path is checked against the sending account. The UI renders
  bucket-hosted attachments through 10-minute signed URLs that renew
  while open. Works with the media buckets public or private.

> **Migration (apply last):** `supabase/migrations/044_private_media_buckets.sql`
> makes `chat-media` and `flow-media` private and scopes reads to the
> owning account (legacy `<uid>/…` paths stay readable by every member of
> the uploader's account). Apply it **only after** this release is live and you have
> confirmed outbound attachments still arrive — see
> `docs/security.md`, "Private attachments".

### Security

- **The webhook verification endpoint no longer writes to the database.**
  Meta's `GET /api/whatsapp/webhook` check used to re-encrypt a legacy
  verify token on its way past — a database write reachable by anyone who
  guessed a verify token, with no session. It is gone: the stored token is
  read and compared, nothing else. Legacy encrypted values keep working
  (they are read as-is), and `scripts/reencrypt-secrets.ts` remains the
  supported way to rewrite them. The lookup also skips rows without a
  verify token and is bounded, so the check no longer scans the table.
- **Platform operator and audited support sessions.** A new
  `platform_admins` table names the people who operate the service, apart
  from — and never mixed with — the `owner`/`admin`/`agent`/`viewer` roles
  inside a company. They get their own routes under `/api/platform/*`,
  closed with 403 to everybody else including company owners, and can open
  a **support session** on a customer account with a written reason. While
  one is open, a permanent banner names the account being viewed and offers
  the way out, and every list in the panel — contacts, inbox, pipelines,
  broadcasts, settings — shows **that customer's** rows and only theirs,
  never the operator's own and never the two mixed. The operator can
  change none of it: reads are granted by row-level security, writes are
  not, and every save attempted anywhere in the app is refused, on the
  customer's account and on their own, including uploads. Attachments are
  the one thing a support session cannot see — the storage policies were
  deliberately left alone. The start and the end of the
  session are recorded with actor, account, moment and reason. Sessions
  last 30 minutes, expire on their own, and pressing "exit" ends one for
  good: the token cannot be reused afterwards. Nothing is seeded: the
  first operator is added with SQL against the database — see
  `docs/security.md`, "Platform operators and support sessions".

> **Migration required:** `supabase/migrations/055_platform_admins.sql`
> adds `platform_admins` and `impersonation_log`, both readable only by
> platform administrators and writable from no client at all. The audit
> table deliberately carries no foreign keys, so the trail survives
> deleting the account or the user it is about.
> `supabase/migrations/057_support_session_reads.sql` then extends every
> **read** policy in the schema with "…or an open support session on this
> account". No write policy is touched, and with no support session open
> nothing about who can see what changes.

- **Platform panel.** Operators of the service get their own section at
  `/platform`, visible only to them: every company on the service with its
  plan, subscription state, team size, consumption for the cycle, signup
  date and last activity, and a file per account with consumption against
  the plan's caps, the billing history from the payment provider, the
  team, and the state of every WhatsApp number connected to it. From that
  file an operator can open a support session (the audited impersonation
  above) or suspend and reactivate the account by hand. Both ask for a
  reason and both are recorded with who, when, which company and why.
  - **A manual suspension is not a billing status.** A suspended account
    behaves exactly like one that has not paid — everyone can read,
    nobody can write, and incoming WhatsApp messages keep arriving and
    keep being stored — but it is a separate switch, so paying an invoice
    (or any event from PayPal) does **not** lift it. The account is told
    so, and is not sent to the checkout, because the checkout cannot lift
    it. Only an operator can.
  - Customer access tokens and payment-provider payloads are never shown
    in the panel: it answers "what happened to this account", not "show
    me this customer's credentials".

> **Migration required:** `supabase/migrations/058_platform_panel.sql`
> adds the manual-hold columns to `subscriptions` (NULL for every existing
> row, so nothing is suspended by applying it), records suspend and
> reactivate in the same audit table as impersonation, and adds the
> function the account list is built from — granted to the service role
> and to no client role. Nothing about who can see or do what changes for
> an ordinary account.

### Fixed

- **A delivery receipt can no longer land on the wrong company's
  campaign.** Meta does not guarantee its message ids are unique across
  numbers, and the `delivered` / `read` webhook was matched by that id
  alone: two companies whose ids collided could see each other's
  broadcast counters move. The receipt is now resolved within the
  account that owns the number it arrived on, and when several rows
  still share an id, the recipient on the event itself decides which one
  it is.
- **One automation no longer silences the AI assistant everywhere.** A
  single active automation with a "new message received" or "keyword
  match" trigger used to mute the assistant across the whole company, in
  every chat, with nothing in the interface to say why — so adding a
  keyword reply for "opening hours" quietly switched the AI agent off.
  The assistant now stands back only on the individual messages an
  automation actually answered; every other message is still answered.
  The customer still never gets two automatic replies to the same
  message: both responders reserve it first and both stand back when
  they lose — including an automation that was waiting on a "wait" step
  and resumes minutes after the assistant already answered. Settings →
  AI now also warns when automations that can answer an incoming message
  exist (keyword, new-message and welcome ones alike), with a link to
  the list.
- **The assistant no longer talks over an automation that closed the
  chat.** A keyword automation whose only step is "close conversation" —
  the usual shape of a "stop"/"unsubscribe" reply — sends no message, so
  nothing stood in the assistant's way and it answered the customer who
  had just asked to be left alone. The assistant now stays out of closed
  conversations; a customer writing again re-opens the thread, and the
  assistant picks it up from there as before.
- **Contracting again after cancelling now turns the service back on.** The
  settings area lets a customer who cancelled buy a new subscription while the
  cycle they already paid for runs out; the webhook then refused that new
  subscription's activation, because the old row was still marked as running.
  The customer paid and got nothing, and their account fell into read-only when
  the old cycle ended. The new subscription is now adopted — and it is charged
  on the cycle that was just bought, so going from yearly back to monthly no
  longer extends the period by a year for a month of money. A subscription that
  is genuinely still being charged is still protected from another one's
  events.
- **Changing to the plan already in force no longer bounces off PayPal.** On
  accounts whose billing cycle was never recorded, asking for the plan and
  cycle already in force skipped the "that is already your plan" check and
  asked PayPal to revise the subscription anyway, which could send the customer
  off to approve what they already had.
- **Settings → Subscription says "admins only" to members who are not.** The
  section could be opened by URL by anyone; it used to answer with a failed
  request and an error card instead of the message meant for that case, and it
  no longer asks the server for billing data it may not read. A locked account
  that also cancelled now reads why it is locked instead of a cancellation
  notice with a date already past.
- **Accepting an invitation after abandoning a checkout.** Redeeming an
  invitation dissolves the invitee's empty personal account; a checkout
  they started and never approved used to block that with a raw database
  error, locking them out of the team for good. Abandoned attempts are
  now discarded with the account, while an account with a real
  subscription behind it is refused as before ("sign up with a different
  email") instead of being silently dissolved.
- **Checkout guard against a second charge.** If the subscription of the
  account could not be read, the check that stops a second PayPal
  subscription was skipped; the checkout now stops with an error instead
  of opening one.
- **Return page wording.** It shows the plan's name ("Pro") rather than
  its internal id, no longer claims a payment is active for an attempt it
  has no record of, and the plan list stops spinning forever when the
  catalogue request fails outright (offline, DNS): it says so.
- **The token usage card survives the playground.** With `'playground'`
  added to `ai_usage_log.mode`, the spend summary (Settings → AI)
  failed to load for any account that had used the test chat: the whole
  window came back empty. The breakdown now has its own "Playground"
  tile, tolerates modes added later, and always adds up to the headline
  total.
- **Focusing the AI key field no longer deletes the stored key.** Clicking
  or tabbing into the (masked) provider key in Settings → AI clears the
  placeholder so you can type. Leaving without typing and saving an
  unrelated change — a new prompt, a toggle — used to send "forget my
  key": the account's own key was silently dropped, or the save was
  refused for a missing key on deployments with no platform key. The key
  is now only forgotten when it is explicitly asked for. Same fix for the
  embeddings key field.
- **"Test key" tests the key that will actually be used.** After asking
  to go back to the platform's key, the button validates the platform key
  instead of the stored one it is about to replace.
- **Saving the AI settings with no key anywhere.** An account backed by
  the platform key (no key of its own) could no longer be saved at all —
  not even to turn the assistant off — once the deployment's
  `AI_PLATFORM_*_API_KEY` was rotated away. A key is now required only
  when the save actually has credentials to verify.
- **Dangling conversation assignments.** `conversations.assigned_agent_id`
  now references `auth.users` with `ON DELETE SET NULL`, so removing an
  operator returns their chats to the unassigned queue instead of leaving
  a nameless "Assigned" badge. A new `(account_id, assigned_agent_id)`
  index backs the "my chats" / "unassigned" lookups.

- **Flow editing scoped to the account.** Saving, deleting and
  activating a flow wrote through the service-role client filtering only
  by row id, so the account was never part of the query. Ownership is
  now resolved before the write and every query carries the caller's
  account. Same fix for the two lookups the runners did by id alone (the
  flow behind a live run, the automation behind a queued step).
- **Automation editing scoped to the account.** Saving an automation
  loaded and updated the row through the service-role client by row id
  alone, leaning on a per-author check in application code. Both queries
  now carry the caller's account, matching the RLS policy the
  service-role client bypasses.
- **Former team members can no longer touch the automations they left
  behind.** Reading, deleting and duplicating an automation matched on
  the author's user id only. Because removing a member (or accepting an
  invitation to another company) moves the profile to a different
  account while the automations they created stay put, someone who had
  left could still delete one of their old company's automations — the
  endpoint even answered `ok` — or clone it back inside that company.
  All three now filter by the caller's current account, and deleting an
  automation that isn't yours answers `404` instead of a blanket `ok`.

### Changed

- **The sign-in, sign-up and forgot-password screens wear the Cabbity
  brand.** They now open on a two-column storefront: a hero panel with
  the logo, a rotating headline (three value propositions, with dots to
  jump between them), the feature list and the brand photograph, next to
  a white card in the handoff palette — navy headings, the corporate
  amber for accents and warm greys for secondary text — regardless of
  the accent or light/dark mode the browser remembers from the
  dashboard. On desktop the frame is exactly the viewport, so the page
  never scrolls; a tall card scrolls inside its own column. Entrance and floating animations respect
  `prefers-reduced-motion`. The password field gains a show/hide toggle,
  the fields carry icons, and the copy is in the catalogue (`es`, `en`,
  `ko`). On phones the hero steps aside and only the card shows. The
  browser-tab icon is now the Cabbity rabbit on amber instead of the
  violet chat bubble.

- **The brand reaches the dashboard.** The sidebar shows the Cabbity
  rabbit next to the product name, and the "Amber" accent theme is now
  called "Cabbity" and painted in the corporate orange (#F2A81B). Anyone
  who had picked Amber keeps their choice — it maps to Cabbity
  automatically.

- **The product is now called Cabbity CRM.** The browser tab, the name
  beside the sidebar logo, the brand shown on PayPal's approval screen
  and receipts, and every sentence in the interface that used to say
  "wacrm" now say "Cabbity CRM" — in English and in Korean. Technical
  identifiers keep their current names on purpose, so nothing you have
  configured breaks: the `wacrm_live_` API-key prefix, the
  `X-Wacrm-Signature` / `X-Wacrm-Event` webhook headers, the
  `wacrm_support_*` cookies, the browser storage keys and the package
  name are unchanged.
- **`PAYPAL_PRODUCT_NAME` now defaults to `Cabbity CRM`** in
  `scripts/paypal-bootstrap-catalog.ts`. If you already bootstrapped a
  PayPal catalogue under the old default, set `PAYPAL_PRODUCT_NAME=wacrm`
  to keep reusing the existing product — otherwise the next run creates a
  second one. Plans that already exist are still skipped either way.
- **The Inicio plan now costs 35 USD/month (350 USD/year)**, up from
  29/290 (`supabase/migrations/059_plan_inicio_35.sql`). Pro (79/790) and
  Negocio (199/1990) are unchanged. `/billing` and Settings →
  Subscription read the price from the catalogue, so they show the new
  one as soon as the migration is applied. Anyone already subscribed
  keeps paying what they contracted: the price stored in PayPal is not
  touched, and moving them would mean new versioned PayPal plans (see
  `docs/docker.md`, "PayPal catalogue").
- **The interface now speaks Spanish by default.** `messages/es.json` is
  a full translation of every screen, and `NEXT_PUBLIC_APP_LOCALE`
  defaults to `es` — including the `Dockerfile` and `docker-compose.yml`
  build args. English (`en`) and Korean (`ko`) are unchanged and stay one
  rebuild away; set the variable and rebuild, since it is inlined into
  the client bundle. Dates in the contact list, the contact notes and
  the deal cards now follow the reader's locale instead of being pinned
  to US English.

## [0.8.1] — 2026-07-10

Fixes inbound chats fragmenting into multiple threads for the same
number.

> **Migration required:** apply `supabase/migrations/036_conversation_contact_dedup.sql`
> (merges any existing duplicate conversations into the oldest thread —
> no messages are lost — then adds a `UNIQUE (account_id, contact_id)`
> index so one contact can only ever have one conversation).

### Fixed

- **Duplicate chats for a single contact.** An inbound message could
  create a second conversation for a contact under a race (Meta retries a
  delivery, or a batch fans out to concurrent runs). Once two existed,
  the `.single()` lookup errored on every later message and the webhook
  created yet another conversation each time, snowballing into a wall of
  duplicate chats. The find-or-create now resolves to the oldest existing
  thread and a DB unique index makes the one-conversation-per-contact
  rule authoritative. The same hardening was applied to the public-API
  conversation resolver. (Issue #363)

## [0.8.0] — 2026-07-08

Polishes the AI auto-reply bot: it's now **visible and controllable from
the inbox**, its **handoff actually hands off**, and its **token spend is
logged**.

> **Migration required:** apply `supabase/migrations/033_ai_reply_polish.sql`
> (adds `messages.ai_generated`, `ai_configs.handoff_agent_id`,
> `conversations.ai_handoff_summary`, and the `ai_usage_log` table).

### Added

- **"AI" badge in the inbox.** Replies the bot sent are tagged with a
  small ✨ AI badge, so agents can tell an automated reply from their own
  or a Flow's at a glance. (New `messages.ai_generated` flag; only the
  auto-reply bot sets it.)
- **Take over / Resume from the thread.** A banner on AI-handled
  conversations lets an agent **Take over** (pauses the bot for that
  thread and assigns it to them) or **Resume AI** (hands the thread back
  and clears the pause). Backed by `POST /api/ai/autoreply/[id]`.
- **Real handoff.** When the bot bails (can't help, or hits the reply
  cap) it now (1) routes the conversation to a configurable **handoff
  target** — a specific agent, or the unassigned queue — and (2) leaves a
  short **internal note** summarizing the exchange for whoever picks it
  up. Assigning fires the existing assignment notification. Pick the
  target under **AI Agents → Setup → Hand off to**.
- **Token-usage logging + dashboard.** Every draft and auto-reply records
  its provider token counts to the new `ai_usage_log` table
  (admin-readable). A new **AI Agents → Usage** tab (admin-only) charts
  daily token spend on your BYO key with per-mode and per-model
  breakdowns, backed by `GET /api/ai/usage`. Counts only — no message
  content is stored or shown.

### Changed

- Auto-reply now has an **account-wide rate limit** (30/min) on top of
  the existing per-conversation cap, so a burst of inbound can't run your
  provider key past its limit. Over the limit, inbounds simply wait in
  the inbox for a human instead of being auto-answered.

## [0.7.0] — 2026-07-02

Promotes the AI assistant to a first-class **AI Agents** section in the
sidebar — it's no longer tucked inside Settings.

### Added

- **AI Agents (sidebar).** A dedicated `/agents` area with two tabs:
  - **Playground** — a test chat to message your agent and see its
    grounded, multi-turn replies (and where it would hand off to a human)
    _before_ it ever answers a real customer. Runs the exact same path as
    the auto-reply bot (knowledge-base retrieval + your provider), and
    works even before you flip the master switch on, so you can try, then
    enable. Backed by `POST /api/ai/playground`.
  - **Setup** — the provider/key, business context, knowledge base, and
    auto-reply controls (moved here from Settings → AI Assistant).

### Changed

- The AI configuration moved out of **Settings → AI Assistant** into the
  new **AI Agents** section. No data change — same account config, new
  home. No migration required.

## [0.6.0] — 2026-07-02

Adds an **AI knowledge base** so the assistant (0.5.0) can answer from
your own content instead of handing off. Paste FAQs, policies, or
product details under **Settings → AI Assistant → Knowledge base**; the
relevant excerpts are retrieved into every draft and auto-reply.

### Added

- **Knowledge base with hybrid retrieval.** Lexical Postgres full-text
  search works for every account with no extra credentials. Optional
  **semantic search** (pgvector, OpenAI `text-embedding-3-small`) turns
  on when you add an **embeddings key** — semantic-primary, topped up
  with lexical to fill the result set. Anthropic-only accounts (Anthropic
  has no embeddings API) keep the lexical path with zero extra setup.
- **Knowledge base manager** in Settings — add/edit/delete documents and
  a **Reindex** action to backfill embeddings after adding a key. Both
  drafts and the auto-reply bot are grounded in the retrieved excerpts,
  and the prompt still instructs the model to hand off (auto-reply) or
  say it will follow up (draft) when the KB doesn't cover the question.
  **Migration required:** apply `supabase/migrations/030_ai_knowledge.sql`
  (enables `pgvector`; adds `ai_knowledge_documents` + `ai_knowledge_chunks`
  and an `embeddings_api_key` column on `ai_configs`).

## [0.5.0] — 2026-07-02

Adds the **AI reply assistant** — bring-your-own-key. Each account
pastes its own OpenAI or Anthropic key under **Settings → AI
Assistant**; wacrm calls the provider directly with that key, so
there's no per-seat AI fee and your conversation data never leaves
your own infrastructure for a wacrm-run service. The key is stored
AES-256-GCM-encrypted at rest (same as WhatsApp tokens) and never
returned to the client after saving.

### Added

- **AI-drafted replies in the inbox.** A ✨ button in the composer
  (agent+) reads the recent conversation and drops a suggested reply
  into the box for the agent to edit and send. Read-only server-side —
  `POST /api/ai/draft` never sends or stores anything. Respects your
  business context / persona from the settings prompt.
- **AI auto-reply bot.** When enabled, inbound messages that no
  deterministic Flow consumed and that have no agent assigned get an
  automatic LLM reply. Bounded by a per-conversation cap
  (`auto_reply_max_per_conversation`, default 3) and a clean human
  handoff: when the model can't confidently help — or the customer
  asks for a person — it stays silent and leaves the message for a
  human, and won't auto-reply on that thread again until re-enabled.
  Flows always win over the bot.
- **Settings → AI Assistant** (admin+ to edit): pick provider + model,
  paste your key, add business context/tone, toggle the assistant and
  auto-reply, set the per-conversation cap, and **Test key** against
  the provider before saving.
- Providers: OpenAI (Chat Completions) and Anthropic (Messages) behind
  one interface; model is a free-text field with sensible defaults, so
  you can point it at any current model your key can access.
  **Migration required:** apply
  `supabase/migrations/029_ai_reply.sql` (adds `ai_configs` +
  per-conversation auto-reply columns on `conversations`).

## [0.4.0] — 2026-07-01

Completes the public API (#245): **outbound event webhooks** so
automations can _react_ to activity instead of polling.

### Added

- **Outbound event webhooks (`/api/v1/webhooks`).** Register an HTTPS
  endpoint (scope `webhooks:manage`) to be POSTed to when an event
  happens in your account — `message.received`, `message.status_updated`,
  or `conversation.created`. Manage endpoints with
  `GET/POST /api/v1/webhooks` and `GET/PATCH/DELETE /api/v1/webhooks/{id}`.
  Each delivery is signed with an `X-Wacrm-Signature`
  (HMAC-SHA256 over `timestamp.body`) so receivers can verify
  authenticity and reject replays; the signing secret is returned once
  at creation and stored encrypted. Delivery is best-effort — an
  endpoint that fails repeatedly is auto-disabled after a threshold of
  consecutive failures. See `docs/public-api.md`.
  **Migration required:** apply
  `supabase/migrations/028_webhook_endpoints.sql`.
  ([#245](https://github.com/ArnasDon/wacrm/issues/245))

## [0.3.0] — 2026-07-01

Multi-user accounts ship. Every wacrm install is multi-tenant on the
database side: a single user's signup creates a fresh "account", and
every row is scoped to that account rather than to the user directly.
This release also opens the user-visible **Members** surface — invite
teammates by link, manage their roles, transfer ownership — to all
users. The `'account_sharing'` beta gate that hid it during
development is removed (mirrors the Flows soft-GA in 0.2.0). Existing
self-hosted instances keep working: every existing user is backfilled
as the sole owner of their own account and sees identical data, and a
solo owner who never invites anyone sees the same single-user app they
always did.

### Added

- **Public REST API (`/api/v1`) — groundwork.** A scoped, revocable
  **API key** system so you can drive wacrm from your own scripts and
  automations. Create keys under **Settings → API keys** (admin+),
  grant only the scopes each integration needs, and authenticate with
  `Authorization: Bearer <key>`. Keys are account-scoped and stored
  hashed (plaintext shown once). This release ships the auth layer,
  scopes, per-key rate limiting, the management UI, and a
  `GET /api/v1/me` probe to verify a key. See
  `docs/public-api.md`. **Migration required:** apply
  `supabase/migrations/026_api_keys.sql`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))
- **Public REST API — data endpoints.** Built on the key auth above,
  so external automations can read and drive the CRM:
  - `POST /api/v1/messages` — send a text / template / media message to
    a phone number; finds-or-creates the contact + conversation
    (`messages:send`).
  - `GET/POST /api/v1/contacts`, `GET/PATCH /api/v1/contacts/{id}` —
    list (search + tag filter), create (find-or-create by phone), read,
    and update contacts, including tags (`contacts:read` /
    `contacts:write`).
  - `GET /api/v1/conversations`, `GET /api/v1/conversations/{id}`, and
    `GET /api/v1/conversations/{id}/messages` — browse conversations and
    their message history with delivery status (`conversations:read` /
    `messages:read`).
  - `POST /api/v1/broadcasts` + `GET /api/v1/broadcasts/{id}` — launch a
    template broadcast to a recipient list and poll its progress
    (`broadcasts:send`).
    All list endpoints share one cursor-pagination contract
    (`{ data, meta: { next_cursor } }`). No migration required — the
    scopes already existed and the tables are unchanged. Outbound event
    webhooks (react to inbound messages) are the remaining roadmap item.
    See `docs/public-api.md`. ([#245](https://github.com/ArnasDon/wacrm/issues/245))

### Changed

- **Tenancy moves from per-user to per-account.** RLS on every
  domain table (contacts, conversations, messages, broadcasts,
  automations, flows, pipelines, templates, tags, …) now checks
  account membership via a new SECURITY DEFINER helper
  `is_account_member(account_id, min_role)` instead of
  `auth.uid() = user_id`. The `user_id` columns stay on every row
  for assignment / audit but no longer enforce isolation.
- **WhatsApp config is one-per-account, not one-per-user.** The
  `whatsapp_config.UNIQUE(user_id)` constraint is replaced by
  `UNIQUE(account_id)`.
- **`flow_runs` idempotency key swaps to `(account_id, contact_id)`**
  so two accounts sharing a contact phone number can each run their
  own flows independently.
- **The signup trigger (`handle_new_user`) now also creates a
  personal account** and links the new profile to it as `owner`.

### Changed

- **Flow-media storage is now account-scoped.** Migration 016
  pathed uploaded files under `auth.uid()/...`, which orphaned
  flow media when a teammate left a shared account. New uploads
  go under `account-<account_id>/...` and any account member
  with the right role can edit them. Legacy paths remain
  writable by the original uploader for backward compatibility.
- **Webhook contact lookup now pre-filters in SQL.** Previously
  pulled every contact in an account just to JS-filter to one
  row by phone — fine when account = one user, painful when
  account = team. Pre-filter by phone suffix on the database
  side; re-apply `phonesMatch` on the (typically 0-2 row)
  candidate set.

### Migration required

- `supabase/migrations/020_account_sharing_followups.sql` —
  composite partial indexes on `automations(account_id,
trigger_type) WHERE is_active` and `flows(account_id) WHERE
status='active'` for the engine dispatch hot path; updated
  `flow-media` storage RLS to allow account-member writes under
  the new path convention. Idempotent.

- **Role-aware UI gating across the app.** The inbox composer's
  send button + textarea, the "New broadcast / automation / flow"
  buttons, the "Add pipeline / deal" buttons, and the "Add /
  Import contact" buttons are now disabled-with-tooltip for
  viewers (and for agents on settings-class actions). Choice:
  show-but-disable rather than hide, so the UI never feels
  silently broken to a teammate looking at a feature they don't
  yet have permission for.
- **Sidebar surfaces the active account** above the user info
  whenever the account name differs from your own — i.e. once
  you've renamed the account or joined a shared one. A default
  solo account is named after you, so the strip stays hidden to
  avoid duplicating your name in the footer.
- **Members is open to all users.** The `account_sharing` beta
  flag that hid the Settings → Members tab and the sidebar
  account strip during development is gone; the multi-user
  surface is now part of the standard app. (Same soft-GA move as
  Flows in 0.2.0.)

### Fixed

- **Inbound WhatsApp messages now land in the shared inbox.** The
  webhook + automations + flows engines used to route inbound
  events by `user_id`, which after the 017 migration only matched
  the WhatsApp config owner's automations / flows — teammates'
  rules never fired. PR 8 of the multi-user series flips every
  lookup to `account_id` so any member of the account sees the
  inbound message and any teammate's automation or flow can react
  to it. Also fixes incipient NOT NULL violations on
  `automation_logs`, `automation_pending_executions`, `flow_runs`,
  and `deals` — those tables gained `account_id NOT NULL` in 017
  but the engines hadn't yet been updated to populate it.

### Added

- **Duplicate phone numbers are now prevented across contacts.** A
  phone number can no longer become more than one contact in the same
  account. Adding a contact whose number already exists is blocked
  with a link to the existing record (and a softer warning for
  near-matches that share their last 8 digits); CSV import de-dupes
  within the file and against existing contacts, reporting
  "X imported, Y duplicates skipped". The rule is enforced by a
  database unique index on the normalized number, so the WhatsApp
  webhook, the form, import, and any future path all agree. Existing
  duplicates are merged into the oldest contact on upgrade (their
  conversations, deals, notes, and tags are re-pointed, nothing is
  lost). Closes #212.
- **Configurable default deal currency.** Each account can now pick
  its default currency under **Settings → Deals** (admin+); the app
  previously hardcoded USD throughout. New deals default to it, and
  pipeline-stage totals, the dashboard "Open Deals Value" card, the
  pipeline-value donut, and automation-created deals all use it.
  Existing deals keep the currency they were saved with — totals are
  shown in the account default with no exchange-rate conversion (one
  currency per account). Full guide:
  [Default currency](https://wacrm.tech/docs/settings#deals).
- **Members tab in Settings.** The user-facing surface for the
  multi-user APIs below, available to everyone (no beta flag). From
  Settings → **Members** an admin or owner can: see who's on the
  account with their role and join date, invite teammates by
  generating a one-time share link (pick the role + optional
  expiry), revoke pending invites, change a member's role, remove a
  member, and — as owner — transfer ownership. Recipients accept via
  a public `/join/[token]` page. Full guide:
  [Members docs](https://wacrm.tech/docs/members).
- **Account & member management API** — server-side endpoints
  backing the Members tab. All routes are role-gated and
  return Supabase-RLS-scoped data.
  - `GET /api/account` — caller's account + role. Any member.
  - `PATCH /api/account` — rename the account. Admin+.
  - `GET /api/account/members` — list members. Email visible to
    admin+ only; agents/viewers see name + avatar + role +
    joined date.
  - `PATCH /api/account/members/[userId]` — change a member's
    role. Admin+. Owner promotion/demotion goes through the
    transfer endpoint instead.
  - `DELETE /api/account/members/[userId]` — remove a member.
    Admin+. The removed user keeps their login and is moved to a
    freshly-created personal account (mirror of the signup flow).
  - `POST /api/account/transfer-ownership` — owner only. Atomic
    swap with the named member.
- **Invitation API + redeem flow** — the no-email, link-only
  invite path that powers the Members tab's "Invite member" button
  and the `/join/[token]` accept page.
  - `GET /api/account/invitations` — list outstanding (admin+).
  - `POST /api/account/invitations` — create an invite, returns
    the plaintext token + share URL **exactly once** (we store
    only the SHA-256 hash on the row). Body
    `{ role, expiresInDays?, label? }`. Admin+.
  - `DELETE /api/account/invitations/[id]` — revoke (admin+).
  - `GET /api/invitations/[token]/peek` — public, per-IP
    rate-limited. Returns `{ ok, account_name, role, expires_at }`
    or `{ ok: false, reason }` so the join page can render
    "You're being invited to <Account> as <Role>".
  - `POST /api/invitations/[token]/redeem` — authenticated.
    Atomically moves the caller's profile to the inviter's
    account and cleans up the orphan personal account. Refuses
    with 409 if the caller's current account already contains
    domain data (no silent data loss).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/017_account_sharing.sql` — introduces the
  `accounts` and `account_invitations` tables plus an
  `account_role_enum` type; adds `account_id` to every
  user-scoped table and backfills it; rewrites every RLS policy;
  replaces the new-user trigger. Idempotent. **No data loss** —
  every existing user is mapped to a freshly-created account
  with role `owner` and every existing row of theirs is linked
  to that account.
- `supabase/migrations/018_account_member_rpcs.sql` — adds three
  `SECURITY DEFINER` RPCs (`set_member_role`,
  `remove_account_member`, `transfer_account_ownership`) that
  back the member-management API. They self-check the caller's
  role and raise SQLSTATE `42501` / `22023` on forbidden / bad
  input so the API layer can map cleanly to 403 / 400.
  Idempotent.
- `supabase/migrations/019_invitation_rpcs.sql` — adds two
  `SECURITY DEFINER` RPCs: `peek_invitation` (anonymous read by
  token hash, returns a fixed-shape JSON envelope) and
  `redeem_invitation` (authenticated atomic move + orphan
  cleanup, with a domain-data safety check). Both bypass the
  RLS that would otherwise block their reads/writes. Idempotent.
- `supabase/migrations/021_account_default_currency.sql` — adds
  `accounts.default_currency` (`TEXT NOT NULL DEFAULT 'USD'`, with a
  3-letter-code `CHECK`) backing the configurable default currency.
  Idempotent; existing accounts backfill to `USD`. **Apply before
  deploying** — the app now reads this column when loading the
  account, so an un-migrated database breaks account loading.
- `supabase/migrations/022_contact_phone_dedup.sql` — adds the
  generated `contacts.phone_normalized` column, **merges existing
  duplicate contacts into the oldest** (re-pointing conversations,
  deals, notes, tags, custom values, and broadcast recipients — no
  data loss), then adds a `UNIQUE (account_id, phone_normalized)`
  index. Idempotent. **Apply before deploying** — CSV import reads
  `phone_normalized`, and the index is what enforces de-duplication
  for every write path. The one-shot merge runs inside the migration.

## [0.2.2] — 2026-05-29

Flow nodes can now send media. Closes the most-requested gap from user
feedback after the v0.2.0 Flows launch — flows were text-only and
couldn't deliver an invoice, receipt, product photo, or short demo
video mid-conversation.

### Added

- **`send_media` flow node.** Send an image (PNG / JPEG / WebP), video
  (MP4 / 3GP), or document (PDF, Word, Excel, PowerPoint, TXT) to the
  customer from any point in a flow. Pick a file in the builder, it
  uploads to the new `flow-media` Supabase Storage bucket, and Meta
  fetches the public URL at send time. Optional caption (1024 char cap,
  supports `{{vars.X}}` interpolation); documents also take an optional
  filename shown in the recipient's chat. Auto-advances after send —
  same suspend semantics as `send_message`.
  ([#156](https://github.com/ArnasDon/wacrm/pull/156))

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/016_flow_media.sql` — does two things:
  1. Adds `'send_media'` to the `flow_nodes.node_type` CHECK
     constraint. Without this the `send_media` node fails to save with
     a constraint violation.
  2. Creates the public `flow-media` Supabase Storage bucket (16 MB
     file-size cap, image / video / document MIME allowlist) plus
     per-user RLS policies (path prefix = `auth.uid()`). Without this
     the builder's file picker fails on upload. Same shape as the
     `avatars` bucket from migration 008 — the bucket is **public** so
     Meta can fetch the URL without credentials.

The migration is idempotent and safe to re-run.

## [0.2.1] — 2026-05-26

Bug-fix release. Plugs a silent inbound-message drop that triggered
when two users on the same instance saved the same WhatsApp
`phone_number_id`.

### Fixed

- **Inbound WhatsApp messages no longer silently disappear** when two
  users have claimed the same `phone_number_id`. Previously the
  webhook used `.single()` to look up the owning config, which errors
  `PGRST116` for both 0 rows _and_ ≥2 rows — the second user's save
  put the DB into the ≥2-row state and every inbound message was
  dropped while the log misleadingly reported _"No config found for
  phone_number_id"_. Three layers of fix: `POST /api/whatsapp/config`
  now returns **409** when another user has already claimed the
  number, the webhook lookup distinguishes 0 rows from ≥2 rows and
  logs the conflicting `user_id`s, and a new DB constraint
  (`UNIQUE(phone_number_id)`) prevents the bad state at the storage
  layer. Reported in
  [#136](https://github.com/ArnasDon/wacrm/issues/136), fixed in
  [#143](https://github.com/ArnasDon/wacrm/pull/143).

### Migration required

Apply against your Supabase project before deploying this version:

- `supabase/migrations/013_whatsapp_config_phone_number_id_unique.sql`
  — adds `UNIQUE(phone_number_id)` to `whatsapp_config`. **Fails
  loudly with a copy-pasteable resolution hint** if duplicate rows
  already exist; auto-deduping would destroy encrypted tokens, so
  the operator picks which row keeps the number. To check first:

  ```sql
  SELECT phone_number_id, array_agg(user_id) AS owners, count(*) AS n
  FROM whatsapp_config
  GROUP BY phone_number_id
  HAVING count(*) > 1;
  ```

  If that returns rows, `DELETE` the duplicate row(s) you want to
  drop, then re-run the migration.

### Note on multi-user setups

wacrm is intentionally **single-tenant per WhatsApp number**. RLS on
`conversations`/`messages` is `auth.uid() = user_id`, so a second
user physically cannot read messages routed to a different owner —
two users sharing one number was never supported. If you need
multiple humans handling the same inbox, run them under one shared
account.

## [0.2.0] — 2026-05-22

The **Flows** release. Adds a no-code, branching, button-driven WhatsApp
conversation engine that runs alongside Automations. Also ships a
5-theme color picker in Settings and opens Flows to all users.

### Added

#### Flows — branching chatbot conversations

- **Module + schema.** New `flows`, `flow_nodes`, `flow_runs`,
  `flow_run_events` tables with partial unique indexes that enforce
  one active run per contact. Widened `messages.content_type` CHECK
  to accept `'interactive'`; added `interactive_reply_id` column so
  the inbox can render button/list taps.
  ([#112](https://github.com/ArnasDon/wacrm/pull/112))
- **Runner engine.** `dispatchInboundToFlows` parses every inbound
  webhook, decides whether the message is a reply on an active run
  or a fresh trigger, advances the state machine, and reports back
  to the webhook so consumed messages don't also fire automations.
  Idempotent on Meta's `message_id`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))
- **No-code builder UI** at `/flows`. Linear-list editor with
  per-node config forms, live validator, draft/active/archived
  status, and a 5-route REST API (`GET/POST /api/flows`,
  `GET/PUT/DELETE /api/flows/[id]`, `POST /api/flows/[id]/activate`,
  `GET /api/flows/[id]/runs`, `GET /api/flows/templates`).
  ([#115](https://github.com/ArnasDon/wacrm/pull/115))
- **Templates + v1.5 node types.** Three starter templates
  (Welcome menu, FAQ bot, Lead capture) cloneable from the New-flow
  dialog. Three new node types: `collect_input` (capture customer
  text into a variable), `condition` (branch on var / tag / contact
  field), `set_tag` (add or remove a tag). `{{vars.X}}` interpolation
  in send_message + collect_input prompts. Per-flow run-history
  viewer at `/flows/[id]/runs`.
  ([#117](https://github.com/ArnasDon/wacrm/pull/117))
- **Stale-run sweep cron** at `GET /api/flows/cron` — marks runs
  past their configured timeout (default 24h) as `timed_out` so
  abandoned conversations free up the contact for new triggers.
  Reuses `AUTOMATION_CRON_SECRET`.
  ([#114](https://github.com/ArnasDon/wacrm/pull/114))

#### Color themes

- **5 color themes** (Violet default, Emerald, Cobalt, Amber, Rose)
  selectable from a new **Appearance** tab in Settings. CSS variables
  scoped under `html[data-theme="..."]`, applied at runtime via
  `dataset.theme`, persisted to `localStorage`. Inline boot script in
  `layout.tsx` replays the choice before first paint so there's no
  flash of the default.
  ([#132](https://github.com/ArnasDon/wacrm/pull/132))
- **Theme tokenization sweep** — every previously hard-coded
  `violet-*` Tailwind class replaced with `primary` tokens across
  ~49 files. Picking a non-violet theme now themes the whole app,
  not just the chrome.
  ([#133](https://github.com/ArnasDon/wacrm/pull/133))

### Changed

#### Flows — soft-GA

- **Flows is now available to every authenticated user.** The
  per-account beta gate is gone; the sidebar entry + page header
  carry a small "Beta" chip as the only remaining signal.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))
- **Editor UX**:
  - Internal `node_key` + per-button/row `reply_id` identifiers
    hidden behind a per-node "Show advanced" disclosure.
    ([#118](https://github.com/ArnasDon/wacrm/pull/118))
  - `send_list` nodes can have multiple sections.
    ([#119](https://github.com/ArnasDon/wacrm/pull/119))
  - Collapsed node cards show a 1-line content preview per node
    type (text excerpt, button titles, condition summary, etc.).
    ([#120](https://github.com/ArnasDon/wacrm/pull/120))
  - Validation issues are clickable: jump to + flash the offending
    node.
    ([#121](https://github.com/ArnasDon/wacrm/pull/121))
  - Unsaved-changes "● Edited" indicator + `beforeunload` reload
    guard.
    ([#122](https://github.com/ArnasDon/wacrm/pull/122))
  - New-flow dialog actually widens to fit the 3 template cards
    (was capped at 384px by a baked-in `sm:max-w-sm` from shadcn).
    ([#129](https://github.com/ArnasDon/wacrm/pull/129),
    [#131](https://github.com/ArnasDon/wacrm/pull/131))
  - Validation panel pinned to the viewport bottom so
    activate-readiness follows the user as they scroll through nodes.
    ([#130](https://github.com/ArnasDon/wacrm/pull/130))

#### Engine reliability

- **Atomic `execution_count` increment** via SECURITY DEFINER RPC —
  prevents lost counts when two webhooks start runs concurrently.
  Mirrors the automations engine pattern.
  ([#124](https://github.com/ArnasDon/wacrm/pull/124))
- **Preload all flow_nodes once per dispatch** — one SELECT per
  inbound instead of one per advance-loop iteration. A 5-node
  auto-advance chain now costs 1 round trip, not 5.
  ([#125](https://github.com/ArnasDon/wacrm/pull/125))
- **Wasted re-read dropped** after reprompt reset; `loadActiveRun`
  switched to defensive `.limit(1)` so a migration glitch producing
  duplicates can't crash dispatch.
  ([#126](https://github.com/ArnasDon/wacrm/pull/126))

### Security

- **PII redacted from `reply_received` event payload** — customer
  text is no longer persisted to `flow_run_events.payload`; only
  the length is. A `collect_input` prompt asking "what's your card
  number?" used to leave the PAN sitting in the events table.
  ([#123](https://github.com/ArnasDon/wacrm/pull/123))
- **Constant-time cron-secret compare** on `/api/flows/cron`
  (`crypto.timingSafeEqual`) to close a theoretical
  timing-side-channel on the `x-cron-secret` header check.
  ([#127](https://github.com/ArnasDon/wacrm/pull/127))

### Fixed

- **`/flows` no longer spuriously redirects to `/dashboard`** when
  navigating in. Root cause: `useAuth` flipped `loading: false`
  before the profile fetch resolved. `use-auth` now exposes a
  separate `profileLoading` boolean.
  ([#128](https://github.com/ArnasDon/wacrm/pull/128))

### Migration required

Apply, in order, against your Supabase project:

1. `supabase/migrations/010_flows.sql` — Flows core tables, indexes,
   RLS policies, and the `messages` schema widening.
2. `supabase/migrations/011_profile_beta_features.sql` — adds the
   `profiles.beta_features` column. Surviving for future betas;
   Flows no longer reads it.
3. `supabase/migrations/012_flows_increment_counter.sql` — atomic
   counter RPC. Without this the engine still runs but
   `flows.execution_count` is racy.

Each migration is idempotent — safe to re-run if you're not sure
whether you applied a previous one.

### Removed

- **`src/lib/flows/feature-flag.ts`** + its tests. Flows is open to
  all users; the `profiles.beta_features` column itself survives
  for future beta gates.
  ([#134](https://github.com/ArnasDon/wacrm/pull/134))

---

## [0.1.1] — 2026-05-19

### Added

- Chat actions in the inbox: emoji reactions, reply-with-quote, and
  copy-text on individual messages. Hover on desktop, long-press on
  touch. Outbound reactions and replies forward to WhatsApp via the
  Cloud API; inbound reactions and swipe-replies from customers
  arrive through the webhook and appear in real time.

### Migration required

- Apply `supabase/migrations/009_message_actions.sql` to your
  Supabase project. It adds `messages.reply_to_message_id` and the
  new `message_reactions` table (with RLS and realtime). The
  migration is idempotent — safe to re-run.

### Changed

- The webhook no longer stores inbound customer reactions as fake
  text messages. They are written to `message_reactions` instead,
  so any custom queries that counted reactions as messages will
  need updating.

---

## [0.1.0]

Initial template release. Core CRM: inbox, contacts, pipelines,
broadcasts, automations (with a Wait-step cron drain), WhatsApp
Cloud API integration, Supabase auth + RLS.
