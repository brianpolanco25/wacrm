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
3. Choose an **expiry**: 30, 90 or 365 days, or never (the default).
4. Copy the key. **The full key is shown exactly once.** wacrm
   stores only a SHA-256 hash, so it can never be shown again. If you
   lose it, revoke it and create a new one.

### Rotating a key

**Settings → API keys → Rotate.** This mints a replacement with the
same name and scopes and gives the old key a **24-hour grace period**:
both authenticate during that window, so you can deploy the new value
without an outage. The old key shows as _Rotating_ with its deadline.

The replacement inherits the old key's expiry date unless you set a new
one. If you are rotating because a key **leaked**, do not wait for the
grace period — press **Revoke now** on the old key.

Two keys cannot be rotated: an **expired** one (the replacement would
inherit an expiry already in the past — create a new key instead) and one
that is **already rotating** (finish the first rotation, or revoke it
now). Rotate is only offered on an active key for that reason.

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
| `conversations:export` | Export conversations and their messages |

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
may be reworded. Every error body also carries `request_id` — the same
value as the `X-Request-Id` response header. Quote it in a support
request.

| Status | `code`                   | Meaning                                                |
| ------ | ------------------------ | ------------------------------------------------------ |
| 401    | `unauthorized`           | Missing / malformed / unknown / revoked / expired key  |
| 403    | `forbidden`              | Valid key, but missing the required scope              |
| 429    | `rate_limited`           | Per-key rate limit exceeded                            |
| 400    | `bad_request`            | Malformed input                                        |
| 404    | `not_found`              | No such resource                                       |
| 409    | `conflict`               | A request with the same `Idempotency-Key` is in flight |
| 409    | `idempotency_mismatch`   | That `Idempotency-Key` was used for a different body   |
| 413    | `payload_too_large`      | Request body over 1 MiB                                |
| 415    | `unsupported_media_type` | A write without `Content-Type: application/json`       |
| 500    | `internal`               | Server error                                           |

### Headers on every response

- `X-Request-Id` — a UUID minted by the server for this call. Log it;
  it is repeated as `request_id` in every error body. Any value you
  send under this name is ignored.
- `Cache-Control: no-store` — API responses are account data behind a
  bearer credential and must not be cached anywhere.

### Request bodies

Writes must send `Content-Type: application/json` (`415` otherwise) and
a JSON **object** (`400` otherwise). Bodies are capped at **1 MiB**
(`413`). Unknown fields are ignored.

## Idempotency

Any `POST` that creates something — today `POST /api/v1/messages` and
`POST /api/v1/broadcasts` — accepts an `Idempotency-Key` header:

```bash
curl -X POST https://<your-domain>/api/v1/messages \
  -H "Authorization: Bearer $WACRM_API_KEY" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: order-4711-notify" \
  -d '{"to":"+14155550123","type":"text","text":"On its way"}'
```

The key is a string of your choosing, 1–255 characters. Use something
derived from the thing you are acting on (an order id, a job id), not a
random value per attempt — the whole point is that a **retry** sends the
same key.

| What you send                          | What you get                                                               |
| -------------------------------------- | -------------------------------------------------------------------------- |
| Same key, same body                    | The stored response, plus `Idempotent-Replayed: true`. Nothing runs twice. |
| Same key, different body               | `409 idempotency_mismatch`                                                 |
| Same key, first call still in progress | `409 conflict` — retry in a moment                                         |
| Same key, more than 24 h later         | Treated as a new request                                                   |
| No key                                 | No replay protection; a retry sends again                                  |

Notes:

- Keys are scoped to the **API key** that used them. Two integrations of
  the same account never see each other's responses.
- Only successful (2xx) responses are stored. A `400`, `429` or `500`
  releases the key, so you can fix the payload and retry with the same
  one.
- The same key used against a different endpoint — or against the same
  endpoint with a different **query string** — is an
  `idempotency_mismatch`, not a wrong replay.
- If the server dies while your first call is being processed, the key is
  not stuck: a reservation with no response recorded after **two minutes**
  is treated as abandoned, and the next retry with that key runs for real.
  A `409 conflict` therefore means "try again in a moment", never "wait 24
  hours".

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

Three webhook endpoints have a **tighter, per-account** budget of **20
requests per minute** on top of the per-key one, because each call makes
us open an outbound connection to a URL you chose or mints a new signing
secret: `POST /api/v1/webhooks/{id}/test`,
`POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry` and
`POST /api/v1/webhooks/{id}/rotate-secret`. It is per **account**, so two
keys of the same account share it.

Exports have their own per-account budget of **10 per hour**, shared by
the direct download and the job endpoint. Each call walks up to ten
thousand messages (or writes a file with everything your filters match),
which makes it the most expensive operation in this API. If you need
more volume you don't need more calls: one job with filters takes every
conversation in a single pass.

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

### `GET /api/v1/conversations/{id}/export`

Download one conversation with **all** of its messages, in chronological
order. Scope: `conversations:export`.

```
GET /api/v1/conversations/{id}/export?format=csv
Authorization: Bearer wacrm_live_…
→ 200  Content-Type: text/csv
       Content-Disposition: attachment; filename="conversation-<id>.csv"
```

`format` is `json` (default) or `csv`. Unlike every other endpoint, the
body **is the file**, not the `{ "data": … }` envelope — errors still
come back in the envelope, so a failed call parses like the rest.

Each message carries a stable set of fields: `conversation_id`, `id`,
`direction`, `sender_type`, `content_type`, `text`, `media_url`,
`template_name`, `status`, `whatsapp_message_id`, `created_at`. The JSON
form nests the messages under their conversation; the CSV form is one
row per message with `conversation_id` first.

Over **10 000 messages** the answer is `409 conflict` telling you to use
the job endpoint below. Another account's (or an unknown) conversation is
`404`.

**Two things to know about the file itself:**

- **Attachments are references, not links.** Media lives in private
  buckets, so `media_url` is exported as `storage://<bucket>/<path>` —
  a stable pointer to the object, never a public URL and never a signed
  one. A signed URL is a bearer credential: writing thousands of them
  into a file that lives for seven days and can be forwarded by email is
  exactly what we won't do, and a 15-minute signature inside a file you
  download tomorrow would be a broken link dressed up as data. Resolve
  the reference from the dashboard, where the browser signs with your
  own session. Links that were never ours (Meta's CDN, an external URL)
  are exported verbatim.
- **CSV cells are protected against formula injection.** A cell whose
  text starts with `=`, `+`, `-` or `@` is prefixed with a single quote
  (`'`) so spreadsheets read it as text instead of running it. If you
  parse the CSV with code rather than opening it in Excel, strip that
  leading `'` when it is there.

### `POST /api/v1/exports`

Queue an export of **many** conversations. Scope: `conversations:export`.

```
POST /api/v1/exports
Content-Type: application/json
{
  "kind": "conversations",
  "format": "csv",
  "filters": { "status": "closed", "from": "2026-01-01T00:00:00Z" }
}
→ 202 { "data": { "id": "…", "kind": "conversations", "format": "csv",
                  "status": "queued", "filters": { … },
                  "row_count": null, "error": null,
                  "created_at": "…", "finished_at": null,
                  "expires_at": "…" } }
```

`kind` is `conversations` (the only one today) and `format` is `json` or
`csv`; both default sensibly, so `{}` is a valid body. `filters` accepts
`status`, `contact_id`, `from` and `to` (ISO-8601, on the conversation's
`created_at`). Unknown filter keys are ignored — in particular, nothing
in `filters` can widen the export beyond your own account.

The `202` means accepted, not finished: the file is built right after the
response goes out, and if that process dies the scheduled sweep picks the
job up again. Send an `Idempotency-Key` and a retried POST returns the
same job instead of queuing a second one.

### `GET /api/v1/exports`

List your export jobs, newest first, paginated like every other list.
Scope: `conversations:export`.

### `GET /api/v1/exports/{id}`

Status of one job and, once it is `done`, the download link. Scope:
`conversations:export`. Another account's (or an unknown) job is `404`.

```
GET /api/v1/exports/{id}
→ 200 { "data": { "id": "…", "status": "done", "row_count": 18432,
                  "download_url": "https://…",
                  "download_expires_at": "2026-09-16T12:15:00.000Z",
                  … } }
```

`status` moves `queued` → `running` → `done` | `failed`; on `failed`,
`error` says why in plain language (for example, an export too large to
build in one piece — narrow it with `from` / `to` and run it in parts).

`download_url` is **minted on every call and valid for 15 minutes**. It
is never stored: we keep the object's path, not the link. Ask again
whenever you need a fresh one — and don't cache it anywhere, because
anyone holding it can download the file until it expires.

**Files and job rows are deleted 7 days after they are created.** Fetch
what you need inside that window.

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
broadcasts, exports, and outbound webhooks — the full scope of
[#245](https://github.com/ArnasDon/wacrm/issues/245). Future ideas
(deals/pipelines, templates, flows) are not yet scheduled. The delivery
queue for webhooks shipped: see [Delivery semantics](#delivery-semantics).
