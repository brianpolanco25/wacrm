# Public API (`/api/v1`)

The public API lets you drive your wacrm instance from your own
scripts and automations — send messages, manage contacts, launch
broadcasts — without going through the dashboard UI.

> **Status:** stable. Authentication, scopes, rate limiting, the
> messages / contacts / conversations / broadcasts endpoints, and
> outbound event [webhooks](#webhooks) all ship now.

## Authentication

Every request authenticates with an **API key**, sent as a bearer
token:

```
Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

Keys are **account-scoped**: a key acts on exactly one account, the
one it was created in. There is no cross-account access.

### Creating a key

In the dashboard: **Settings → API keys → New API key**. Only
**admins and owners** can create keys.

1. Give the key a name (after the integration that will use it).
2. Grant the **scopes** it needs — nothing more (see below).
3. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Revoking a key

**Settings → API keys → Revoke.** Revocation is effective on the
key's next request. Revoked keys stay in the list as an audit trail.

## Scopes

A key can do only what its scopes allow — independent of who created
it. Grant the minimum.

| Scope                | Allows                                |
| -------------------- | ------------------------------------- |
| `messages:send`      | Send WhatsApp messages                |
| `messages:read`      | Read messages and delivery status     |
| `contacts:read`      | List and read contacts                |
| `contacts:write`     | Create and update contacts            |
| `conversations:read` | List and read conversations           |
| `broadcasts:send`    | Launch broadcast campaigns            |
| `webhooks:manage`    | Register and manage outbound webhooks |

A key with **no scopes** still authenticates and can call
`GET /api/v1/me` — useful for verifying a key works.

## Response envelope

Every response uses one of two shapes:

```jsonc
// success
{ "data": { /* ... */ } }

// failure
{ "error": { "code": "forbidden", "message": "This API key is missing the 'messages:send' scope" } }
```

Branch on `error.code` (stable); `error.message` is for humans and
may be reworded.

| Status | `code`         | Meaning                                               |
| ------ | -------------- | ----------------------------------------------------- |
| 401    | `unauthorized` | Missing / malformed / unknown / revoked / expired key |
| 403    | `forbidden`    | Valid key, but missing the required scope             |
| 429    | `rate_limited` | Per-key rate limit exceeded                           |
| 400    | `bad_request`  | Malformed input                                       |
| 404    | `not_found`    | No such resource                                      |
| 500    | `internal`     | Server error                                          |

## Rate limits

Requests are limited **per key**: **120 requests per minute**. On a
`429`, these headers tell you when to retry:

- `Retry-After` — seconds until the window resets
- `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`

> The limiter is in-memory and **per process**. A single-instance
> deploy (the common case for a self-hosted fork) is fine as-is. If
> you scale to multiple instances, swap the limiter for a shared
> store (Redis/Upstash) — see the note at the top of
> `src/lib/rate-limit.ts`. The limit is otherwise unenforced across
> instances.

## Endpoints

### `GET /api/v1/me`

Returns the account a key is bound to and the scopes it carries.
Requires only a valid key (no scope). Use it to verify a key works
and to discover its scopes.

```bash
curl https://your-crm.example.com/api/v1/me \
  -H "Authorization: Bearer wacrm_live_xxx"
```

```json
{
  "data": {
    "account": { "id": "…", "name": "Acme Inc" },
    "key": { "id": "…", "scopes": ["messages:send"] }
  }
}
```

### `POST /api/v1/messages`

Send a WhatsApp message to a phone number. Scope: `messages:send`. You
pass an **E.164 number**, not an internal id — the endpoint
finds-or-creates the contact + conversation, then sends.

```bash
curl -X POST https://your-crm.example.com/api/v1/messages \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "to": "+14155550123", "type": "text", "text": "Hi 👋" }'
```

`type` is `text` (default), `template`, or a media kind (`image` /
`video` / `document` / `audio`). Media needs `media_url` (and optional
`filename`); `text` doubles as the caption. `template` needs a
`template` object:

```jsonc
{
  "to": "+14155550123",
  "type": "template",
  "template": {
    "name": "order_update",
    "language": "en_US",
    "params": ["A123"], // positional body vars, or a structured object
  },
  "reply_to_message_id": "<uuid>", // optional; must be in the same conversation
}
```

#### Choosing which number it goes out from

An account can have several WhatsApp numbers connected. By default the
message leaves through the number the conversation already runs on (the
one the customer last wrote to), falling back to the account's default
number for a brand-new conversation.

To pick one explicitly, pass `from` with the **`phone_number_id`** Meta
gave you for that number — the same value you see in Settings →
WhatsApp, not an internal wacrm id:

```jsonc
{
  "to": "+14155550123",
  "type": "text",
  "text": "Hi 👋",
  "from": "100234567890123", // optional; a phone_number_id of YOUR account
}
```

A `from` that is not one of your connected numbers is refused with
`bad_request` (400, `'from' is not a connected number`) — including when
it is a real number belonging to somebody else. Nothing is sent and no
contact or conversation is created.

#### Writing to somebody whose number you do not have

Since April 2026 a customer can message you with a WhatsApp **username**
instead of a phone number. When that happens Meta identifies them with a
**BSUID** (business-scoped user id, `CC.<alphanumerics>` — e.g.
`US.1349700000000001`) and sends no phone number at all, so the contact
this CRM stores has `phone: null`.

To write to such a contact, pass `to_user_id` instead of `to`:

```jsonc
{
  "to_user_id": "US.1349700000000001",
  "type": "text",
  "text": "Hi 👋",
}
```

- Exactly one of `to` / `to_user_id` is required. Passing both is allowed
  and **`to` wins** — a phone number is the more stable identity, and it
  is what Meta itself picks when a send carries the two.
- The BSUID comes from the CRM itself: `GET /api/v1/contacts` returns it
  as `wa_user_id`. It is scoped to your business — a BSUID issued to
  another company means nothing here.
- A malformed value is refused with `bad_request` (400,
  `'to_user_id' must be a WhatsApp user id in the form CC.<alphanumerics>`).
  Nothing is sent and no contact or conversation is created.

Response (201):

```json
{
  "data": {
    "message_id": "…",
    "whatsapp_message_id": "wamid.…",
    "conversation_id": "…",
    "contact_id": "…",
    "contact_created": true
  }
}
```

Domain error codes beyond the table above: `whatsapp_not_configured`
(400), `meta_error` (502 — the request reached Meta and it rejected the
send), `template_malformed` (500).

### `GET /api/v1/contacts`

List contacts, newest first. Scope: `contacts:read`. Paginated (see
[Pagination](#pagination)). Optional filters: `?search=` (matches name
or phone) and `?tag=<tagId>`.

`phone` is **null** for a contact that only ever wrote with a WhatsApp
username. `wa_username` then carries that username (without the `@`) and
`wa_user_id` the BSUID — that last one is what you pass as `to_user_id`
to write to them.

```json
{
  "data": [
    {
      "id": "…",
      "phone": "+14155550123",
      "name": "Jane Doe",
      "wa_username": null,
      "wa_user_id": null,
      "email": null,
      "company": "Acme",
      "avatar_url": null,
      "tags": [{ "id": "…", "name": "vip", "color": "#3b82f6" }],
      "created_at": "…",
      "updated_at": "…"
    }
  ],
  "meta": { "next_cursor": "…" }
}
```

### `POST /api/v1/contacts`

Create a contact. Scope: `contacts:write`. `phone` (E.164) is required;
`name`, `email`, `company`, and `tags` (an array of tag names, created
if missing) are optional. **Find-or-create by phone:** an existing
match returns `200` with the existing contact; a new contact returns
`201`. The response body is the serialized contact (same shape as the
list rows above).

### `GET` / `PATCH /api/v1/contacts/{id}`

Read or update one contact. Scopes: `contacts:read` / `contacts:write`.
`PATCH` updates only the fields you send (`name`, `email`, `company`);
pass `tags` (an array of tag names) to replace the contact's tags. A
contact in another account returns `404`.

### `GET /api/v1/conversations`

List conversations, newest first. Scope: `conversations:read`.
Paginated. Optional filters: `?status=` (`open` / `pending` / `closed`)
and `?contact_id=`. Each conversation embeds its contact + tags.

### `GET /api/v1/conversations/{id}`

Read one conversation. Scope: `conversations:read`. `404` if it belongs
to another account.

### `GET /api/v1/conversations/{id}/messages`

List a conversation's messages, newest first. Scope: `messages:read`.
Paginated. Each message includes its `direction` (`inbound` /
`outbound`), `status` (delivery state), `whatsapp_message_id`, and
`content_*`. The conversation is verified to belong to your account
first (`404` otherwise).

### `POST /api/v1/broadcasts`

Launch a template broadcast to a list of recipients. Scope:
`broadcasts:send`. The broadcast + its recipient rows are persisted
immediately and the sends fan out in the background, so the call
returns fast — poll `GET /api/v1/broadcasts/{id}` for progress.

```bash
curl -X POST https://your-crm.example.com/api/v1/broadcasts \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{
        "name": "July promo",
        "template_name": "promo_july",
        "template_language": "en_US",
        "recipients": [
          { "to": "+14155550123", "params": ["Jane"] },
          { "to": "+14155550124" },
          { "to_user_id": "US.1349700000000001", "params": ["Ada"] }
        ]
      }'
```

Recipients are capped at **1000 per request** — split larger sends. Each
recipient carries a `to` (E.164) or a `to_user_id` (BSUID; see "Writing
to somebody whose number you do not have" above), and with both, `to`
wins. Recipients with neither a valid number nor a valid BSUID are
dropped and counted as `rejected`. Response (202):

```json
{
  "data": {
    "broadcast_id": "…",
    "status": "sending",
    "total_recipients": 2,
    "accepted": 2,
    "rejected": 0
  }
}
```

### `GET /api/v1/broadcasts/{id}`

Broadcast status + counts. Scope: `broadcasts:send`. `status` moves
`sending` → `sent`; `delivered_count` / `read_count` keep climbing as
Meta delivery webhooks arrive. `404` for another account's broadcast.

## Pagination

Every list endpoint pages the same way. Request a page size with
`?limit=` (default 50, max 100) and read the next page with the opaque
`meta.next_cursor` from the previous response:

```
GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page
```

Cursors are keyset-based (stable under concurrent inserts). Pass the
cursor back verbatim — don't parse it. `next_cursor: null` means the
last page.

## Webhooks

Rather than polling, register an endpoint and wacrm will POST to it when
things happen in your account. **Migration required:** apply
`supabase/migrations/028_webhook_endpoints.sql`.

### Events

| Event                     | Fires when                                                   |
| ------------------------- | ------------------------------------------------------------ |
| `message.received`        | An inbound message arrives from a contact                    |
| `message.status_updated`  | A message you sent changed delivery status                   |
| `conversation.created`    | A new conversation is opened for a contact                   |
| `conversation.closed`     | A conversation is closed (dashboard or automation)           |
| `conversation.assigned`   | A conversation changes hands                                 |
| `contact.created`         | A contact is created (API, dashboard, or inbound WhatsApp)   |
| `contact.updated`         | A contact's fields change                                    |
| `contact.tag_added`       | A tag is attached to a contact                               |
| `contact.tag_removed`     | A tag is detached from a contact                             |
| `template.status_updated` | Meta moved a template's review status (surfaced by the sync) |
| `broadcast.completed`     | A campaign finished fanning out                              |

Events fire from the **domain layer**, not only from `/api/v1`: a tag
added by an agent in the dashboard, a conversation closed by an
automation and a contact created by an inbound WhatsApp message all
reach your endpoint the same way an API-driven change does.

### Managing endpoints

All under scope `webhooks:manage`.

- `POST /api/v1/webhooks` — register `{ "url": "https://…", "events": ["message.received"] }`. `url` must be `https://`. **The response includes `secret` exactly once** — store it to verify signatures; wacrm keeps only an encrypted copy.
- `GET /api/v1/webhooks` — list your endpoints (never returns the secret).
- `GET /api/v1/webhooks/{id}` — read one.
- `PATCH /api/v1/webhooks/{id}` — update `url`, `events`, or `is_active` (re-enabling clears the failure counter).
- `DELETE /api/v1/webhooks/{id}` — remove one (its delivery log goes with it).
- `GET /api/v1/webhooks/{id}/deliveries` — the delivery log, newest first
  (cursor-paginated like every other list; `?status=pending|delivered|failed|dead`).
  Never includes `payload`.
- `POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry` — try one
  again right now, from the first rung of the ladder. `409` if it is
  already queued for another attempt.
- `POST /api/v1/webhooks/{id}/test` — deliver a signed `ping`. `ping` is
  not a subscribable event; it only travels when you ask for it.
- `POST /api/v1/webhooks/{id}/rotate-secret` — new signing secret,
  returned in plaintext once. Everything after the response is signed
  with it, so update your verifier before the next delivery.

```bash
curl -X POST https://your-crm.example.com/api/v1/webhooks \
  -H "Authorization: Bearer wacrm_live_xxx" \
  -H "Content-Type: application/json" \
  -d '{ "url": "https://example.com/hooks/wacrm", "events": ["message.received"] }'
# → 201 { "data": { "id": "…", "url": "…", "events": [...], "secret": "whsec_…" } }
```

### Delivery payload

Every delivery is a POST with this envelope; `id` is a unique per-
delivery uuid you can dedupe on, and `data` varies by `event`:

```json
{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": {/* per-event, see below */}
}
```

`data` by event:

```jsonc
// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…", "content_type": "text", "text": "Hi 👋" }
// conversation.created
{ "conversation_id": "…", "contact_id": "…" }
// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }
// conversation.closed
{ "conversation_id": "…", "contact_id": "…" }
// conversation.assigned
{ "conversation_id": "…", "contact_id": "…", "assigned_agent_id": "…" }   // null = unassigned
// contact.created
{ "contact_id": "…", "phone": "14155550123", "wa_user_id": null, "name": "Jane" }
// contact.updated
{ "contact_id": "…", "phone": "…", "wa_user_id": null, "name": "Jane", "fields": ["name"] }
// contact.tag_added / contact.tag_removed
{ "contact_id": "…", "tag_id": "…" }
// template.status_updated
{ "template_id": "…", "name": "order_update", "language": "en_US", "status": "APPROVED", "previous_status": "PENDING" }
// broadcast.completed
{ "broadcast_id": "…", "status": "sent", "total": 1000, "sent": 987, "failed": 13 }
```

Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, `X-Wacrm-Delivery-Id`,
`X-Wacrm-Attempt` (1 on the first try) and `X-Wacrm-Signature`.

### Verifying the signature

`X-Wacrm-Signature: t=<unix_seconds>,v1=<hex>` where `v1 =
HMAC-SHA256(secret, "${t}.${rawBody}")`. Recompute it over the **raw
request body** and compare in constant time; reject if `t` is more than
a few minutes old (replay protection).

```js
const [, t, v1] = header.match(/t=(\d+),v1=([0-9a-f]+)/);
const expected = crypto
  .createHmac('sha256', secret)
  .update(`${t}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
```

### Delivery semantics

Delivery is **at-least-once and durable**. Every event is persisted to a
queue before the first attempt, so a receiver that is down, slow or
mid-deploy does not lose it. A failed attempt is retried five more times
— after 1 min, 5 min, 30 min, 2 h and 12 h — and is then marked `dead`
and left in the log; you can still retry it by hand. Each attempt has a
short timeout and **redirects are not followed**.

Consequences to design for:

- **Dedupe on the envelope `id`.** It is stable across retries, so a
  receiver that accepted a delivery and then timed out will see the same
  `id` again.
- **Do not assume ordering.** A retried event can arrive after a newer
  one; `occurred_at` is the authority.
- **Answer fast.** Anything that is not a 2xx — including a 3xx — counts
  as a failure and schedules a retry.
- `message.status_updated` covers messages wacrm stores (inbox + API
  sends), not broadcast-only sends, and providers re-send and re-order
  status callbacks of their own.

Each consecutive failure increments `failure_count`; after 15 in a row
the endpoint is auto-disabled (`is_active: false`) — re-enable it with
`PATCH`, which resets the counter. Delivery history is kept for 30 days.

Self-hosting note: retries need a scheduler hitting
`GET /api/webhooks/cron` every minute (see `docs/docker.md`). Without
it, only the first attempt of each delivery ever runs.

**Target restrictions (SSRF).** The `url` must be `https://` and must
resolve to a public address — requests to `localhost`, private/RFC1918
ranges, link-local (incl. cloud metadata `169.254.169.254`), and similar
internal targets are refused at delivery time.

## Roadmap

The public API now covers messaging, contacts, conversations,
broadcasts, and outbound webhooks — the full scope of
[#245](https://github.com/ArnasDon/wacrm/issues/245). Future ideas
(deals/pipelines, templates, flows) are not yet scheduled. The delivery
queue for webhooks shipped: see [Delivery semantics](#delivery-semantics).
