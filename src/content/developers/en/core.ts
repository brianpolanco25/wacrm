import type { DocPage } from '../types';

// English prose for the first three pages. Same source of truth as the
// Spanish one: `docs/public-api.md` on this branch.

export const start: DocPage = {
  slug: 'start',
  title: 'Get started',
  summary:
    'Create an API key, make your first call and set the environment up in five minutes.',
  blocks: [
    {
      kind: 'lead',
      text: 'The Cabbity CRM public API lets your own programs do what the dashboard does: send WhatsApp messages, manage contacts and tags, publish templates, launch broadcasts, export conversations and receive events on your server.',
    },
    {
      kind: 'p',
      text: 'Everything hangs off `/api/v1` on your own instance. There is no separate sandbox: what you send, gets sent.',
    },
    { kind: 'h2', id: 'plan', text: 'Which plan includes it' },
    {
      kind: 'p',
      text: 'The API and outbound webhooks ship with the **Pro** and **Negocio** plans. On the Inicio plan every `/api/v1` route answers `402` with the code `feature_unavailable` and an `upgradeUrl` in the body; the rest of the CRM is unaffected.',
    },
    { kind: 'h2', id: 'key', text: '1. Create a key' },
    {
      kind: 'p',
      text: 'In the dashboard: **Settings → API**. Only **admins** and **owners** see the button.',
    },
    {
      kind: 'ol',
      items: [
        'Press **New API key** and name it after the integration that will use it, not after yourself. Once there are six keys you will want to know which one to switch off.',
        'Grant **only** the scopes that integration needs. A key that just reads contacts should not be able to send messages; see [Authentication and scopes](/developers/authentication).',
        'Pick an **expiry**: 30, 90 or 365 days, or never. A date forces you to rotate, and rotating is what turns a leak into a scare instead of an incident.',
        'Copy the key. **It is shown exactly once**: the server keeps only a SHA-256 hash, so it can never be shown again. Lose it and you revoke it and create another.',
      ],
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'Keys cannot be created through the API itself. A key that mints keys is a silent privilege escalation: issuing them lives in the dashboard and only there.',
    },
    { kind: 'h2', id: 'first-call', text: '2. Your first call' },
    {
      kind: 'p',
      text: '`GET /api/v1/me` is the diagnostic route: it requires no scope, so it works even with a key that has none, and it tells you which account the key belongs to and what it may do.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Check the key',
      code: `curl https://your-domain.example.com/api/v1/me \\
  -H "Authorization: Bearer $CABBITY_API_KEY"`,
    },
    {
      kind: 'code',
      lang: 'json',
      label: 'Response',
      code: `{
  "data": {
    "account": { "id": "9f1c…", "name": "Acme Ltd" },
    "key": { "id": "3a20…", "scopes": ["messages:send", "contacts:read"] }
  }
}`,
    },
    {
      kind: 'p',
      text: 'A `401` here means the key is missing, malformed, unknown, revoked or expired: they are deliberately the same error, so nobody gets confirmation that a key ever existed.',
    },
    { kind: 'h2', id: 'environment', text: '3. Set the environment up' },
    {
      kind: 'p',
      text: 'The key is a credential: it does not travel in the code or in the repository. Two environment variables are enough, and they are the ones every example in these guides uses. The [MCP server](/developers/integrations) has names of its own, documented there.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'Your integration .env',
      code: `CABBITY_BASE_URL=https://your-domain.example.com
CABBITY_API_KEY=wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    },
    {
      kind: 'ul',
      items: [
        'Never put it in a web or mobile client: the API has no CORS because it is meant to be server-to-server, and any key that reaches a browser is a public key.',
        'Always log the `X-Request-Id` response header. It is the only thing we ask for in order to trace one specific call.',
        'Store the expiry date next to the key, not in the head of whoever created it.',
      ],
    },
    { kind: 'h2', id: 'next', text: 'Where to go next' },
    {
      kind: 'cards',
      items: [
        {
          href: '/developers/authentication',
          title: 'Authentication and scopes',
          text: 'What each scope allows, how a key is rotated and what to do if one leaks.',
        },
        {
          href: '/developers/conventions',
          title: 'Conventions',
          text: 'The response envelope, error codes, rate limits, pagination and idempotency.',
        },
        {
          href: '/developers/guides/templates',
          title: 'Send a template',
          text: 'From creating the template to following delivery status over a webhook.',
        },
        {
          href: '/developers/reference',
          title: 'Reference',
          text: 'Every operation, generated from the OpenAPI contract.',
        },
      ],
    },
  ],
};

export const authentication: DocPage = {
  slug: 'authentication',
  title: 'Authentication and scopes',
  summary:
    'Bearer keys, the twelve scopes, least privilege, expiry, rotation and what to do about a leak.',
  blocks: [
    {
      kind: 'lead',
      text: 'Every request authenticates with an API key sent as a bearer credential. A key belongs to **one** account: there is no cross-account access, not even for the owner of both.',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `Authorization: Bearer wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxxxxxx`,
    },
    {
      kind: 'p',
      text: 'The `wacrm_live_` prefix is visible in the dashboard so you can recognise a key in a log without holding the full value. Of the rest, only a SHA-256 hash is stored.',
    },
    { kind: 'h2', id: 'scopes', text: 'The twelve scopes' },
    {
      kind: 'p',
      text: 'A scope is a permission of the key, independent of the role of whoever created it. A key with no scopes still authenticates and can call `GET /api/v1/me`, and nothing else.',
    },
    {
      kind: 'table',
      head: ['Scope', 'Allows'],
      rows: [
        ['`messages:send`', 'Send WhatsApp messages'],
        ['`messages:read`', 'Read messages and their delivery status'],
        ['`contacts:read`', 'List and read contacts'],
        ['`contacts:write`', 'Create and update contacts'],
        ['`conversations:read`', 'List and read conversations'],
        ['`conversations:export`', 'Export conversations and their messages'],
        ['`broadcasts:send`', 'Launch broadcasts and poll their progress'],
        ['`webhooks:manage`', 'Register and manage outbound webhooks'],
        ['`tags:read`', 'List and read tags'],
        ['`tags:write`', 'Create, rename, delete and assign tags'],
        ['`templates:read`', 'List message templates and their status at Meta'],
        ['`templates:write`', 'Create, edit, delete and sync templates'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'There is no `broadcasts:read`: polling a broadcast uses `broadcasts:send`, the same scope that launches it.',
    },
    { kind: 'h2', id: 'least-privilege', text: 'Least privilege' },
    {
      kind: 'p',
      text: 'The right question when creating a key is not "what might it need some day" but "what does this program do today". Three examples cover almost everything:',
    },
    {
      kind: 'ul',
      items: [
        'An internal dashboard that displays conversations: `conversations:read` and `messages:read`. Nothing else; it cannot write.',
        "Your shop's order-shipped notice: `messages:send` and `templates:read`. It reads which variables the template expects and sends it.",
        'The nightly copy into your data warehouse: `conversations:export`. It does not even need to read contacts.',
      ],
    },
    {
      kind: 'p',
      text: "A key missing the route's scope gets `403 forbidden`, with the name of the missing scope in the message. That is deliberate: it speeds up diagnosis and reveals nothing the key's owner cannot already see in the dashboard.",
    },
    { kind: 'h2', id: 'expiry', text: 'Expiry' },
    {
      kind: 'p',
      text: 'When creating a key you pick 30, 90 or 365 days, or **never** (the default, so as not to silently put a clock on integrations that already existed). An expired key stops authenticating and answers `401`, exactly like a revoked one.',
    },
    { kind: 'h2', id: 'rotation', text: 'Rotation without downtime' },
    {
      kind: 'p',
      text: '**Settings → API → Rotate** mints a replacement with the same name and scopes and gives the old key a **24-hour grace period**: both authenticate during that window, so you can deploy the new value without an outage. The old one shows as *Rotating* with its deadline.',
    },
    {
      kind: 'ol',
      items: [
        'Rotate in the dashboard and copy the new key.',
        'Deploy the new value in your integration.',
        'Confirm with `GET /api/v1/me` that the new key answers.',
        'If you rotated because of a leak, do not wait out the 24 hours: press **Revoke now** on the old one.',
      ],
    },
    {
      kind: 'p',
      text: "The replacement inherits the old key's expiry unless you set another. Two keys cannot be rotated: an **expired** one (it would inherit a date already in the past — create a new key) and one that is **already rotating** (finish that rotation, or revoke it now).",
    },
    { kind: 'h2', id: 'leak', text: 'If a key leaks' },
    {
      kind: 'ol',
      items: [
        "**Revoke it now**, without rotating. Revocation takes effect on that key's next request.",
        'Create a new key with the minimum scopes and deploy.',
        'Review what the holder could have done: the scopes of the leaked key are the exact blast radius, which is why not handing out permissions mattered.',
        'If it had `webhooks:manage`, check in **Settings → Webhooks** that nobody added a destination, and rotate the signing secrets of the ones that were there.',
      ],
    },
    {
      kind: 'note',
      tone: 'good',
      text: 'Revoked keys stay in the list as an audit trail: creation date, last use and who created them survive the revocation.',
    },
  ],
};

export const conventions: DocPage = {
  slug: 'conventions',
  title: 'Conventions',
  summary:
    'Response envelope, error codes, request_id, rate limits, pagination and idempotency.',
  blocks: [
    {
      kind: 'lead',
      text: 'Every `/api/v1` route answers the same way, fails the same way and paginates the same way. Write against these six rules and a new endpoint will not force you to change the client.',
    },
    { kind: 'h2', id: 'envelope', text: 'The envelope' },
    {
      kind: 'code',
      lang: 'jsonc',
      code: `// success
{ "data": { /* … */ } }

// a list
{ "data": [ /* … */ ], "meta": { "next_cursor": "eyJ…" } }

// failure
{
  "error": {
    "code": "forbidden",
    "message": "This API key is missing the 'messages:send' scope",
    "request_id": "0d8f…"
  }
}`,
    },
    {
      kind: 'p',
      text: 'Always branch on `error.code`, which is stable; `error.message` is written for a human and may be reworded without notice. The one route that does not return the envelope is `GET /api/v1/conversations/{id}/export`, where the body **is the file** — its errors do come back in the envelope.',
    },
    { kind: 'h2', id: 'errors', text: 'Error codes' },
    {
      kind: 'table',
      head: ['Status', 'Code', 'Meaning'],
      rows: [
        [
          '400',
          '`bad_request`',
          'Malformed input; the message names the field',
        ],
        [
          '401',
          '`unauthorized`',
          'Key missing, malformed, unknown, revoked or expired',
        ],
        [
          '402',
          '`feature_unavailable`',
          'The plan does not include the API or webhooks',
        ],
        [
          '402',
          '`quota_exceeded`',
          "This month's allowance for a metric is spent",
        ],
        ['402', '`plan_limit_reached`', 'A stock limit of the plan is full'],
        ['403', '`forbidden`', "Valid key missing the route's scope"],
        [
          '403',
          '`account_read_only`',
          'Subscription suspended or expired: reads only',
        ],
        [
          '404',
          '`not_found`',
          'No such resource, or it belongs to another account',
        ],
        [
          '409',
          '`conflict`',
          'The resource is busy or in an incompatible state',
        ],
        [
          '409',
          '`idempotency_mismatch`',
          'That `Idempotency-Key` was used with a different body',
        ],
        ['413', '`payload_too_large`', 'Body over 1 MiB'],
        [
          '415',
          '`unsupported_media_type`',
          'A write without `Content-Type: application/json`',
        ],
        ['429', '`rate_limited`', 'Budget exhausted'],
        [
          '502',
          '`meta_error`',
          'The request reached Meta and Meta rejected it',
        ],
        ['500', '`internal`', 'Server error'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: "Another account's resource answers `404`, never `403`. That is deliberate: a `403` would confirm that the id exists somewhere.",
    },
    {
      kind: 'p',
      text: 'The three `402`s also carry `upgradeUrl` and, where it applies, `metric`, `limit` and `used`, so your program knows which ceiling it hit without reading the sentence.',
    },
    { kind: 'h2', id: 'headers', text: 'Headers on every response' },
    {
      kind: 'ul',
      items: [
        '`X-Request-Id` — a UUID the server mints for that call. It is repeated as `request_id` inside every error body. Log it; any value you send under that name is ignored.',
        '`Cache-Control: no-store` — this is account data behind a bearer credential: no cache anywhere.',
      ],
    },
    { kind: 'h2', id: 'requests', text: 'Request bodies' },
    {
      kind: 'ul',
      items: [
        'Writes send `Content-Type: application/json` (`415` otherwise) and a JSON **object** (`400` otherwise).',
        'Bodies are capped at **1 MiB** (`413`).',
        'Unknown fields are ignored; wrongly typed ones give `400` naming the field.',
      ],
    },
    { kind: 'h2', id: 'rate-limits', text: 'Rate limits' },
    {
      kind: 'p',
      text: 'The general budget is **120 requests per minute, per key**. A `429` carries `Retry-After` in seconds plus `X-RateLimit-Limit`, `X-RateLimit-Remaining` and `X-RateLimit-Reset`.',
    },
    {
      kind: 'table',
      head: ['Bucket', 'Budget', 'Scope', 'Operations'],
      rows: [
        ['general', '120/min', 'per key', 'all of them'],
        [
          '`exports`',
          '10/hour',
          'per account',
          '`GET /conversations/{id}/export` and `POST /exports`',
        ],
        ['`templatesSync`', '6/min', 'per account', '`POST /templates/sync`'],
        [
          '`webhookAction`',
          '20/min',
          'per account',
          'webhook `test`, `retry` and `rotate-secret`',
        ],
      ],
    },
    {
      kind: 'p',
      text: "The three dedicated buckets are **per account** and add to the general one: two keys of the same company share those three and not the 120/min. A request that never gets to do the work — a `404` on somebody else's id — does not spend from the export budget.",
    },
    {
      kind: 'note',
      tone: 'warn',
      text: 'The limiter is in memory and **per process**. A single-instance deploy, which is the usual case, behaves as this page describes; spread over several, the budget stops being global.',
    },
    { kind: 'h2', id: 'pagination', text: 'Pagination' },
    {
      kind: 'p',
      text: 'Every list paginates the same way: ask for a page size with `?limit=` (50 by default, 100 max) and the next page with the opaque cursor from `meta.next_cursor`.',
    },
    {
      kind: 'code',
      lang: 'http',
      code: `GET /api/v1/contacts?limit=50
→ { "data": [ … ], "meta": { "next_cursor": "eyJ…" } }

GET /api/v1/contacts?limit=50&cursor=eyJ…
→ { "data": [ … ], "meta": { "next_cursor": null } }   // last page`,
    },
    {
      kind: 'p',
      text: 'Cursors are keyset-based: they survive concurrent inserts without skipping or repeating rows. Pass them back verbatim, do not parse them. `next_cursor: null` is the last page.',
    },
    { kind: 'h2', id: 'idempotency', text: 'Idempotency' },
    {
      kind: 'p',
      text: 'Every `POST` that creates something accepts an `Idempotency-Key` header: a string of yours, 1 to 255 characters. Use a value derived from the thing you are acting on (an order id, a job id), not a random one per attempt — the whole point is that the **retry** sends the same key.',
    },
    {
      kind: 'code',
      lang: 'bash',
      code: `curl -X POST https://your-domain.example.com/api/v1/messages \\
  -H "Authorization: Bearer $CABBITY_API_KEY" \\
  -H "Content-Type: application/json" \\
  -H "Idempotency-Key: order-4711-notify" \\
  -d '{"to":"+14155550123","type":"text","text":"On its way"}'`,
    },
    {
      kind: 'table',
      head: ['What you send', 'What you get'],
      rows: [
        [
          'Same key, same body',
          'The stored response, plus `Idempotent-Replayed: true`. Nothing runs twice',
        ],
        ['Same key, different body', '`409 idempotency_mismatch`'],
        [
          'Same key, first call still in progress',
          '`409 conflict` — retry in a moment',
        ],
        ['Same key, more than 24 h later', 'Treated as a new request'],
        ['No key', 'No protection: a retry sends again'],
      ],
    },
    {
      kind: 'ul',
      items: [
        "Keys are scoped to the **API key plus endpoint**: two integrations of the same account never see each other's responses, and the same key against another route — or the same route with a different query string — is an `idempotency_mismatch`.",
        'Only successful (2xx) responses are stored. A `400`, a `429` or a `500` releases the key: fix the payload and retry with the same one.',
        'If the server dies with your first call half-done, the key is not stuck: a reservation with no response recorded after **two minutes** is treated as abandoned. A `409 conflict` therefore means "try again in a moment", never "wait 24 hours".',
      ],
    },
    {
      kind: 'p',
      text: 'Today it is accepted by `POST /messages`, `POST /broadcasts`, `POST /tags`, `POST /contacts/{id}/tags`, `POST /templates`, `PATCH /templates/{id}` and `POST /exports`. The [reference](/developers/reference) marks it operation by operation.',
    },
  ],
};
