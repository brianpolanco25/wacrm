import type { DocPage } from '../types';

// English guides. Each one is a whole task, start to finish, with the
// code it needs and nothing else.

export const guides: DocPage = {
  slug: 'guides',
  title: 'Guides',
  summary: 'Four complete tasks, from the first call to the last detail.',
  blocks: [
    {
      kind: 'lead',
      text: 'The [reference](/developers/reference) says what each operation accepts. These guides say in which order to call them to get something done.',
    },
    {
      kind: 'cards',
      items: [
        {
          href: '/developers/guides/templates',
          title: 'Send a template end to end',
          text: 'Create it, wait for Meta to approve it, send it and follow delivery over a webhook.',
        },
        {
          href: '/developers/guides/contacts-tags',
          title: 'Sync contacts and tags',
          text: 'Push your customer base without duplicating rows and keep tags current.',
        },
        {
          href: '/developers/guides/exports',
          title: 'Export conversations',
          text: 'Direct download for one conversation, background jobs for everything else.',
        },
        {
          href: '/developers/guides/webhooks',
          title: 'Receive webhooks',
          text: 'Verify the signature in Node, Python and PHP, and live with retries and duplicates.',
        },
      ],
    },
  ],
};

export const guidesTemplates: DocPage = {
  slug: 'guides/templates',
  title: 'Send a template end to end',
  summary:
    'Create the template, wait for Meta to approve it, send it and follow its delivery over a webhook.',
  blocks: [
    {
      kind: 'lead',
      text: "Outside the 24 hours after a customer's last message, WhatsApp only allows **approved templates**. This guide walks the whole path: create it, wait for Meta, send it and find out whether it arrived.",
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'You need a key with `templates:write`, `templates:read`, `messages:send` and, for the last step, `webhooks:manage`.',
    },
    { kind: 'h2', id: 'create', text: '1. Create the template' },
    {
      kind: 'p',
      text: 'The template is created in the CRM and submitted to Meta for review in the same call. Body variables are positional and **contiguous from `{{1}}`**, and you must supply one sample value per variable: Meta rejects the template otherwise, and we would rather tell you before the round trip.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/templates',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/templates" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-template-v1" \\
  -d '{
        "name": "order_update",
        "language": "en_US",
        "category": "Utility",
        "body_text": "Hi {{1}}, your order {{2}} is on its way.",
        "sample_values": { "body": ["Ada", "A-123"] },
        "footer_text": "Reply STOP to opt out"
      }'`,
    },
    {
      kind: 'ul',
      items: [
        "`name` follows Meta's rule: lowercase letters, digits and underscores.",
        "The `Authentication` category is refused with `400`: those templates need Meta's own one-time-password flow. Create them in WhatsApp Manager and pull them in with `POST /api/v1/templates/sync`.",
        'A `(name, language)` pair that already exists in your account is a `409` **before** we call Meta.',
        "With several connected numbers, pick the WhatsApp Business Account with `from` (Meta's `phone_number_id`) or with `whatsapp_config_id`.",
        'The `Idempotency-Key` matters more here than elsewhere: Meta caps template creation at 100 per hour per account.',
      ],
    },
    {
      kind: 'p',
      text: 'The response is `201` with the template in `PENDING`. If Meta rejects the submission you get `502 meta_error` with its public message, and **nothing is stored** locally.',
    },
    { kind: 'h2', id: 'approval', text: '2. Wait for approval' },
    {
      kind: 'p',
      text: "Meta's review takes minutes to hours. There are two ways to find out, and only one of them is good:",
    },
    {
      kind: 'ul',
      items: [
        '**Subscribe to `template.status_updated`** ([webhook guide](/developers/guides/webhooks)). One event per status change, no polling.',
        'If you truly cannot receive webhooks, call `POST /api/v1/templates/sync` — which is what asks Meta — and then read `GET /api/v1/templates`. The sync bucket is **6 per minute, per account**, so do not put it in a tight loop.',
      ],
    },
    {
      kind: 'table',
      head: ['Status', 'What it means'],
      rows: [
        ['`DRAFT`', 'Created locally, not yet at Meta'],
        ['`PENDING`', 'Under review'],
        ['`APPROVED`', 'Can be sent'],
        ['`REJECTED`', '`rejection_reason` says why; edit and resubmit'],
        ['`PAUSED`', 'Recoverable: edit and send it back to review'],
        ['`DISABLED`', 'Terminal, it does not come back'],
      ],
    },
    { kind: 'h2', id: 'variables', text: '3. Learn which variables it wants' },
    {
      kind: 'p',
      text: 'Do not guess the number of parameters: `GET /api/v1/templates` tells you. Every template carries `variables`, the ordered list of the `{{1}}…{{n}}` its body expects.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'GET /api/v1/templates',
      code: `curl -G "$CABBITY_BASE_URL/api/v1/templates" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  --data-urlencode "search=order_update" \\
  --data-urlencode "status=APPROVED"`,
    },
    {
      kind: 'code',
      lang: 'json',
      label: 'Response fragment',
      code: `"variables": [
  { "index": 1, "placeholder": "{{1}}", "example": "Ada" },
  { "index": 2, "placeholder": "{{2}}", "example": "A-123" }
]`,
    },
    {
      kind: 'p',
      text: '`example` is the sample value the template was approved with: useful for a preview, **never** sent as a default.',
    },
    { kind: 'h2', id: 'send', text: '4. Send it' },
    {
      kind: 'p',
      text: "A template's identity when sending is the `name` + `language` pair, not its `id`. The `params` go in the order of `variables`.",
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/messages',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/messages" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-A-123-notify" \\
  -d '{
        "to": "+14155550123",
        "type": "template",
        "template": {
          "name": "order_update",
          "language": "en_US",
          "params": ["Ada", "A-123"]
        }
      }'`,
    },
    {
      kind: 'p',
      text: 'The `201` carries `message_id`, `whatsapp_message_id`, `conversation_id`, `contact_id` and `contact_created`. The contact and the conversation are found or created from the E.164 number: you do not need to register them first.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: "Only an `APPROVED` template can be sent. A `PENDING` or `REJECTED` one comes back from Meta as `502 meta_error` on the send, not as a `400` of ours: the decision is Meta's and it arrives late on purpose, once we already tried.",
    },
    {
      kind: 'p',
      text: 'To write to somebody whose number you do not have — a customer who messaged you with their WhatsApp username — send `to_user_id` with their BSUID (`CC.<alphanumerics>`) instead of `to`. `GET /api/v1/contacts` returns it as `wa_user_id`.',
    },
    { kind: 'h2', id: 'tracking', text: '5. Follow the delivery' },
    {
      kind: 'p',
      text: 'The `201` means "Meta accepted it", not "the customer read it". The real status arrives later, and it arrives over a webhook.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Subscribe to the two events that matter',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/webhooks" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "url": "https://your-server.example.com/hooks/cabbity",
        "events": ["message.status_updated", "template.status_updated"]
      }'`,
    },
    {
      kind: 'p',
      text: 'Keep the `secret` that comes back in that response: it is shown **exactly once** and it is what verifies the signature. The `message.status_updated` event carries `whatsapp_message_id` — the same one the send returned — and the new `status`.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Delivery statuses arrive repeated and out of order because that is how the provider sends them. Keep the latest by `occurred_at` and dedupe on the envelope `id`; the [webhook guide](/developers/guides/webhooks) covers it.',
    },
    { kind: 'h2', id: 'editing', text: 'Editing a template later' },
    {
      kind: 'p',
      text: '`PATCH /api/v1/templates/{id}` edits and resubmits. Meta **replaces** components instead of patching them, so anything you leave out is inherited from the stored template: send `"footer_text": null` to actually remove the footer. `name` and `language` are immutable — to Meta each pair is its own template — and only `APPROVED`, `REJECTED` and `PAUSED` ones can be edited, up to 10 times per template every 30 days.',
    },
  ],
};

export const guidesContactsTags: DocPage = {
  slug: 'guides/contacts-tags',
  title: 'Sync contacts and tags',
  summary:
    'Push your customer base without duplicating rows and keep tags current from your own system.',
  blocks: [
    {
      kind: 'lead',
      text: 'Contacts and tags are the shared vocabulary between your system and the CRM. Both write paths are designed so that a process that repeats — a nightly sync, a retry — does not dirty the data.',
    },
    { kind: 'h2', id: 'create', text: 'Creating contacts without duplicates' },
    {
      kind: 'p',
      text: '`POST /api/v1/contacts` is **find-or-create by phone**: if the number already exists in your account it returns `200` with the existing contact; if it is new, `201`. You can replay your whole base without checking first.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/contacts" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "phone": "+14155550123",
        "name": "Ada Lovelace",
        "email": "ada@example.com",
        "company": "Acme",
        "tags": ["vip", "beta"]
      }'`,
    },
    {
      kind: 'ul',
      items: [
        '`phone` goes in **E.164** (`+` and country code). It is what identifies the contact.',
        'The `tags` field of this route and of `PATCH /contacts/{id}` takes **names** and **replaces** the whole set. Tags that do not exist are created.',
        'A contact who has only ever written with a WhatsApp username has `phone: null`; their identity is `wa_user_id` (the BSUID) and their public handle is `wa_username`.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Replacing is dangerous when you do not own every tag on the contact: an agent added `urgent` by hand and your sync, which knows nothing about it, deletes it. To add without overwriting, use the by-id route below.',
    },
    { kind: 'h2', id: 'tags', text: 'Tags as a resource of their own' },
    {
      kind: 'p',
      text: '`POST /api/v1/tags` is find-or-create too, this time **by name, case-insensitively**: `VIP` and `vip` are the same tag. A name that already exists returns `200` with the tag that was there and does **not** change its colour.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/tags" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: tag-vip" \\
  -d '{ "name": "vip", "color": "#3b82f6" }'`,
    },
    {
      kind: 'p',
      text: "Uniqueness is enforced by the database, not by the code: two simultaneous calls with the same name produce **one** tag, and the loser of the race gets the winner's row with `200` — not a duplicate and not a `500`. Renaming a tag onto a name already in use is `409 conflict` (changing only the casing of its own name is fine).",
    },
    { kind: 'h2', id: 'assign', text: 'Attaching and detaching by id' },
    {
      kind: 'p',
      text: 'The additive door is `POST /api/v1/contacts/{id}/tags` with `{ "tag_ids": [...] }` (50 per call at most): it adds without touching what the contact already had. A tag it already carried is a no-op, not a second event.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `# attach two tags by id
curl -X POST "$CABBITY_BASE_URL/api/v1/contacts/$CONTACT_ID/tags" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{ "tag_ids": ["6f0c…", "a91b…"] }'

# detach one
curl -X DELETE "$CABBITY_BASE_URL/api/v1/contacts/$CONTACT_ID/tags/6f0c…" \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'note',
      tone: 'good',
      text: '**All or nothing.** Every id is resolved against your account before the first write, so a list with one unknown or foreign id attaches none of them and fires no events: the `404` and the state of your data say the same thing.',
    },
    {
      kind: 'p',
      text: 'Detaching a tag the contact did not carry is a `200` with the contact unchanged and **no** `contact.tag_removed` webhook: that event only fires when something really went away.',
    },
    {
      kind: 'h2',
      id: 'effects',
      text: 'Tagging fires what the dashboard fires',
    },
    {
      kind: 'p',
      text: 'A tag attached through the API fires the same `tag_added` automation trigger and the same `contact.tag_added` webhook as an agent attaching it by hand. There is no back door with fewer side effects: if your welcome automation starts on a tag, it starts from your program too.',
    },
    { kind: 'h2', id: 'read', text: 'Reading what is there' },
    {
      kind: 'ul',
      items: [
        '`GET /api/v1/contacts` accepts `?search=` (name or phone) and `?tag=<tagId>`, and paginates by cursor like every list.',
        '`GET /api/v1/tags` accepts `?search=` over the name.',
        '`DELETE /api/v1/tags/{id}` deletes the tag **and detaches it from every contact** that carried it. There is no undo.',
      ],
    },
    {
      kind: 'p',
      text: 'For a large dump, walk the pages until `meta.next_cursor` is `null` and honour the `429`: the general budget is 120 requests per minute per key, and `Retry-After` tells you exactly how long to wait.',
    },
  ],
};

export const guidesExports: DocPage = {
  slug: 'guides/exports',
  title: 'Export conversations',
  summary:
    'Direct download of one conversation, and background jobs for large volumes.',
  blocks: [
    {
      kind: 'lead',
      text: 'There are two paths, and the difference is not the format but the size: one specific conversation downloads in the same call; everything else is queued and picked up when it is ready.',
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Both paths need the `conversations:export` scope and share a bucket of **10 requests per hour, per account**. It is the most expensive operation in this API.',
    },
    { kind: 'h2', id: 'direct', text: 'One conversation, now' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -L "$CABBITY_BASE_URL/api/v1/conversations/$CONVERSATION_ID/export?format=csv" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -o conversation.csv`,
    },
    {
      kind: 'p',
      text: '`format` is `json` (default) or `csv`. This is **the only route in the API whose body is not the `{data}` envelope**: the body is the file, with its `Content-Disposition`. Errors do come back in the envelope, so a failure parses like everywhere else.',
    },
    {
      kind: 'p',
      text: 'Every message carries a stable set of fields: `conversation_id`, `id`, `direction`, `sender_type`, `content_type`, `text`, `media_url`, `template_name`, `status`, `whatsapp_message_id` and `created_at`. The JSON form nests messages under their conversation; the CSV form is one row per message.',
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Over **10 000 messages** the answer is `409 conflict` pointing you at the job endpoint. It is not a whim: holding that download in a single request breaks exactly when there is most data.',
    },
    { kind: 'h2', id: 'job', text: 'Many conversations, in the background' },
    {
      kind: 'code',
      lang: 'bash',
      label: 'POST /api/v1/exports',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/exports" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: export-2026-01" \\
  -d '{
        "kind": "conversations",
        "format": "csv",
        "filters": { "status": "closed", "from": "2026-01-01T00:00:00Z" }
      }'`,
    },
    {
      kind: 'p',
      text: 'The response is `202` with the job in `queued`. The file is built right after the response goes out and, if that process dies, the scheduled sweep picks it up again. With an `Idempotency-Key`, a retry returns **the same job** instead of queuing a second one.',
    },
    {
      kind: 'ul',
      items: [
        "`filters` accepts `status`, `contact_id`, `from` and `to` (ISO-8601, on the conversation's `created_at`). Unknown keys are ignored.",
        'Nothing you put in `filters` can widen the export beyond your own account.',
        'A single job with filters walks every conversation in one pass: if you need more volume you do not need more calls.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'The job has a ceiling too: **250,000 messages**. Past it the job ends `failed` with an `error` that says so — "This export exceeds 250,000 messages" — and no half-written file: we would rather hand you nothing than an incomplete export that looks complete. The way out is to slice it by date with the `from` and `to` filters (quarters, months) and run one job per slice.',
    },
    { kind: 'h2', id: 'collect', text: 'Collecting the file' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl "$CABBITY_BASE_URL/api/v1/exports/$JOB_ID" \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'code',
      lang: 'json',
      code: `{
  "data": {
    "id": "…",
    "status": "done",
    "row_count": 18432,
    "download_url": "https://…",
    "download_expires_at": "2026-09-16T12:15:00.000Z"
  }
}`,
    },
    {
      kind: 'p',
      text: "Status moves `queued` → `running` → `done` | `failed`; on `failed`, `error` explains why in plain language. The `download_url` is **minted on every call and valid for 15 minutes**, and it is never stored: we keep the object's path, not the link. Ask for another whenever you need one, and do not cache it, because anyone holding it can download the file until it expires.",
    },
    {
      kind: 'note',
      tone: 'warn',
      text: '**Files and job rows are deleted 7 days after they are created.** Fetch what you need inside that window.',
    },
    { kind: 'h2', id: 'file', text: 'Two things about the file' },
    {
      kind: 'p',
      text: "**Attachments are references, not links.** Media lives in private buckets, so `media_url` is exported as `storage://<bucket>/<path>`: a stable pointer, never a public URL and never a signed one. A signed URL is a credential, and writing thousands of them into a file that lives for seven days and gets forwarded by email is exactly what we will not do. Links that were never ours (Meta's CDN, an external URL) are exported verbatim.",
    },
    {
      kind: 'p',
      text: '**CSV cells are protected against formula injection.** A cell whose text starts with `=`, `+`, `-` or `@` is prefixed with a single quote so the spreadsheet reads it as text instead of running it. If you parse the CSV with code, strip that quote when it is there.',
    },
  ],
};

export const guidesWebhooks: DocPage = {
  slug: 'guides/webhooks',
  title: 'Receive webhooks',
  summary:
    'Verify the signature in Node, Python and PHP, and live with retries and duplicate deliveries.',
  blocks: [
    {
      kind: 'lead',
      text: 'A webhook is a `POST` request **we** make to **your** server. Since anyone can call that URL, the first thing your receiver does is not read the body: it is check the signature.',
    },
    { kind: 'h2', id: 'register', text: '1. Register the destination' },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST "$CABBITY_BASE_URL/api/v1/webhooks" \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -d '{
        "url": "https://your-server.example.com/hooks/cabbity",
        "events": ["message.received", "conversation.closed"]
      }'`,
    },
    {
      kind: 'p',
      text: 'The `201` includes `secret` **exactly once**: store it where you store credentials. All we keep is an encrypted copy, so there is no way to show it to you again; if you lose it, `POST /api/v1/webhooks/{id}/rotate-secret` mints another (and returns it once).',
    },
    {
      kind: 'p',
      text: 'The URL must be `https://` and must resolve to a public address: `localhost`, private ranges and the cloud-metadata `169.254.169.254` are refused **at delivery time**, not only at registration.',
    },
    { kind: 'h2', id: 'signature', text: '2. The signature scheme' },
    {
      kind: 'p',
      text: 'Every delivery carries the `X-Wacrm-Signature` header in this shape:',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `X-Wacrm-Signature: t=1789012345,v1=8f3c9a…`,
    },
    {
      kind: 'ul',
      items: [
        '`t` is the signing time in Unix seconds.',
        '`v1` is `HMAC-SHA256(secret, "<t>.<raw body>")` in hexadecimal.',
        'It is computed over the **raw body**, byte for byte, not over a re-serialized JSON: reordering keys or changing whitespace breaks the signature.',
        'Compare it in **constant time** and reject a `t` more than a few minutes old (replay protection). Five minutes is the tolerance we use.',
      ],
    },
    { kind: 'h3', id: 'node', text: 'Node' },
    {
      kind: 'code',
      lang: 'javascript',
      label: 'Express — mind the raw body',
      code: `import crypto from 'node:crypto';
import express from 'express';

const app = express();
const SECRET = process.env.CABBITY_WEBHOOK_SECRET;
const TOLERANCE = 300; // seconds

function verify(header, rawBody) {
  const parts = Object.fromEntries(
    String(header || '')
      .split(',')
      .map((kv) => {
        const i = kv.indexOf('=');
        return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
      })
  );
  const t = Number(parts.t);
  const v1 = (parts.v1 || '').toLowerCase();
  if (!Number.isFinite(t) || !v1) return false;
  if (Math.abs(Date.now() / 1000 - t) > TOLERANCE) return false;

  const expected = crypto
    .createHmac('sha256', SECRET)
    .update(\`\${t}.\${rawBody}\`)
    .digest('hex');
  // timingSafeEqual throws when the lengths differ.
  if (expected.length !== v1.length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(v1));
}

// express.raw(), NOT express.json(): the body must arrive untouched.
app.post(
  '/hooks/cabbity',
  express.raw({ type: 'application/json' }),
  (req, res) => {
    const raw = req.body.toString('utf8');
    if (!verify(req.get('X-Wacrm-Signature'), raw)) {
      return res.status(401).end();
    }
    const event = JSON.parse(raw);
    res.status(200).end();   // answer first
    enqueue(event);          // work afterwards
  }
);`,
    },
    { kind: 'h3', id: 'python', text: 'Python' },
    {
      kind: 'code',
      lang: 'python',
      label: 'Flask',
      code: `import hashlib
import hmac
import os
import time

from flask import Flask, abort, request

app = Flask(__name__)
SECRET = os.environ["CABBITY_WEBHOOK_SECRET"].encode()
TOLERANCE = 300  # seconds


def verify(header: str, raw: bytes) -> bool:
    parts = {}
    for kv in (header or "").split(","):
        if "=" in kv:
            k, v = kv.split("=", 1)
            parts[k.strip()] = v.strip()
    try:
        t = int(parts["t"])
        v1 = parts["v1"].lower()
    except (KeyError, ValueError):
        return False
    if abs(time.time() - t) > TOLERANCE:
        return False
    expected = hmac.new(
        SECRET, f"{t}.".encode() + raw, hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected, v1)


@app.post("/hooks/cabbity")
def hooks():
    raw = request.get_data()  # bytes, untouched
    if not verify(request.headers.get("X-Wacrm-Signature", ""), raw):
        abort(401)
    event = request.get_json(force=True)
    enqueue(event)   # the work, outside the request
    return "", 200`,
    },
    { kind: 'h3', id: 'php', text: 'PHP' },
    {
      kind: 'code',
      lang: 'php',
      label: 'Plain PHP',
      code: `<?php
declare(strict_types=1);

function cabbity_verify(
    string $header,
    string $raw,
    string $secret,
    int $tolerance = 300
): bool {
    $parts = [];
    foreach (explode(',', $header) as $kv) {
        $pair = explode('=', $kv, 2);
        if (count($pair) === 2) {
            $parts[trim($pair[0])] = trim($pair[1]);
        }
    }
    if (!isset($parts['t'], $parts['v1'])) {
        return false;
    }
    $t = (int) $parts['t'];
    if (abs(time() - $t) > $tolerance) {
        return false;
    }
    $expected = hash_hmac('sha256', $t . '.' . $raw, $secret);
    return hash_equals($expected, strtolower($parts['v1']));
}

$raw = file_get_contents('php://input');   // the body as it arrived
$header = $_SERVER['HTTP_X_WACRM_SIGNATURE'] ?? '';

if (!cabbity_verify($header, $raw, getenv('CABBITY_WEBHOOK_SECRET'))) {
    http_response_code(401);
    exit;
}

http_response_code(200);   // answer now
fastcgi_finish_request();  // and work afterwards
enqueue(json_decode($raw, true));`,
    },
    { kind: 'h2', id: 'retries', text: '3. Retries and duplicates' },
    {
      kind: 'p',
      text: 'Delivery is **at-least-once and durable**: every event is persisted to a queue before the first attempt, so a receiver that is down, slow or mid-deploy loses nothing. A failed attempt is retried five more times — after 1 min, 5 min, 30 min, 2 h and 12 h — and is then left `dead` in the log, from where you can retry it by hand.',
    },
    {
      kind: 'table',
      head: ['Situation', 'What your receiver does'],
      rows: [
        [
          'The same `id` arrives twice',
          'Drop it. The envelope `id` is stable across retries: a receiver that accepted and then timed out will see the same one',
        ],
        [
          'An old event arrives after a newer one',
          'Do not assume ordering. `occurred_at` is the authority',
        ],
        [
          'Your process is slow',
          'Answer 2xx first and work afterwards. Anything that is not 2xx — including a 3xx — counts as a failure and schedules a retry',
        ],
        [
          'You pile up 15 consecutive failures',
          'The destination auto-disables (`is_active: false`). Re-enable it with `PATCH`, which also resets the counter',
        ],
      ],
    },
    {
      kind: 'p',
      text: 'The cheap way to drop duplicates is a table with the envelope `id` as primary key and an insert that ignores conflicts: if it was already there, that event was already processed.',
    },
    {
      kind: 'code',
      lang: 'sql',
      code: `CREATE TABLE seen_events (
  id          uuid PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);

-- returns 0 rows if it was already there: do not process it again
INSERT INTO seen_events (id) VALUES ($1) ON CONFLICT DO NOTHING;`,
    },
    { kind: 'h2', id: 'debug', text: '4. Debugging' },
    {
      kind: 'ul',
      items: [
        '`POST /api/v1/webhooks/{id}/test` delivers a genuinely signed `ping`. `ping` is not a subscribable event: it only travels when you ask for it.',
        "`GET /api/v1/webhooks/{id}/deliveries` is the delivery log, with each attempt's status code and error (`?status=pending|delivered|failed|dead`). It never includes the `payload`.",
        '`POST /api/v1/webhooks/{id}/deliveries/{deliveryId}/retry` retries one right now, from the first rung of the ladder.',
        'In the dashboard, **Settings → Webhooks** shows the same thing with buttons.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'On a self-hosted instance, retries need a scheduler calling `GET /api/webhooks/cron` every minute (see `docs/docker.md`). Without it, only the first attempt of each delivery ever runs.',
    },
    {
      kind: 'p',
      text: "The full list of events and of each one's `data` is in [Webhooks](/developers/webhooks).",
    },
  ],
};
