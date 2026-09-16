import type { DocPage, DocSectionLabels } from '../types';

export const sections: DocSectionLabels = {
  start: 'Getting started',
  guides: 'Guides',
  reference: 'Reference',
};

export const reference: DocPage = {
  slug: 'reference',
  title: 'Reference',
  summary:
    "Every /api/v1 operation, generated from the server's own OpenAPI 3.1 document.",
  blocks: [
    {
      kind: 'lead',
      text: 'This page is not written by hand: it is generated on the server from the **OpenAPI 3.1** document your instance publishes. If a route changes and the contract changes with it, this page changes on its own.',
    },
    {
      kind: 'p',
      text: 'The document itself is served at [GET /api/v1/openapi.json](/api/v1/openapi.json), public and unauthenticated. Use it to import the API into Postman or Insomnia and to generate clients; [Integrations](/developers/integrations) covers that.',
    },
    {
      kind: 'ul',
      items: [
        'The **scope** on each operation is the one the route demands. Without it, `403`.',
        'Operations marked with `Idempotency-Key` accept that header; see [Conventions](/developers/conventions).',
        "Bodies and responses are described with the contract's schema: fields that do not appear do not exist.",
        "Every relative path hangs off your own instance's URL.",
      ],
    },
  ],
};

export const webhooks: DocPage = {
  slug: 'webhooks',
  title: 'Webhooks',
  summary:
    'Event catalogue, the data of each one, the signature, delivery semantics and the dashboard.',
  blocks: [
    {
      kind: 'lead',
      text: 'Instead of asking every minute whether something happened, you register a URL and we tell you. This page is the catalogue; to build the receiver, go to the [webhook guide](/developers/guides/webhooks).',
    },
    { kind: 'h2', id: 'events', text: 'Events' },
    {
      kind: 'table',
      head: ['Event', 'Fires when'],
      rows: [
        ['`message.received`', 'An inbound message arrives from a contact'],
        [
          '`message.status_updated`',
          'A message you sent changed delivery status',
        ],
        [
          '`conversation.created`',
          'A new conversation is opened for a contact',
        ],
        [
          '`conversation.closed`',
          'A conversation is closed (dashboard or automation)',
        ],
        ['`conversation.assigned`', 'A conversation changes hands'],
        [
          '`contact.created`',
          'A contact is created (API, dashboard or inbound WhatsApp)',
        ],
        ['`contact.updated`', "A contact's fields change"],
        ['`contact.tag_added`', 'A tag is attached to a contact'],
        ['`contact.tag_removed`', 'A tag is detached from a contact'],
        ['`template.status_updated`', "Meta moved a template's review status"],
        ['`broadcast.completed`', 'A campaign finished fanning out'],
      ],
    },
    {
      kind: 'note',
      tone: 'info',
      text: 'Events fire from the **domain layer**, not only from `/api/v1`: a tag added by an agent in the dashboard, a conversation closed by an automation and a contact created by an inbound message all reach your server the same way an API-driven change does.',
    },
    { kind: 'h2', id: 'envelope', text: 'The delivery envelope' },
    {
      kind: 'code',
      lang: 'json',
      code: `{
  "id": "8f3c…",
  "event": "message.received",
  "occurred_at": "2026-07-01T12:00:00.000Z",
  "account_id": "…",
  "data": { }
}`,
    },
    {
      kind: 'p',
      text: 'The `id` is unique per delivery and **stable across retries**: it is the key to dedupe on. Headers: `X-Wacrm-Event`, `X-Wacrm-Webhook-Id`, `X-Wacrm-Delivery-Id`, `X-Wacrm-Attempt` (1 on the first try) and `X-Wacrm-Signature`.',
    },
    { kind: 'h2', id: 'data', text: 'The `data` of each event' },
    {
      kind: 'code',
      lang: 'jsonc',
      code: `// message.received
{ "conversation_id": "…", "contact_id": "…", "whatsapp_message_id": "wamid.…",
  "content_type": "text", "text": "Hi 👋" }

// message.status_updated
{ "whatsapp_message_id": "wamid.…", "conversation_id": "…", "status": "delivered" }

// conversation.created / conversation.closed
{ "conversation_id": "…", "contact_id": "…" }

// conversation.assigned        (assigned_agent_id null = unassigned)
{ "conversation_id": "…", "contact_id": "…", "assigned_agent_id": "…" }

// contact.created
{ "contact_id": "…", "phone": "14155550123", "wa_user_id": null, "name": "Ada" }

// contact.updated
{ "contact_id": "…", "phone": "…", "wa_user_id": null, "name": "Ada",
  "fields": ["name"] }

// contact.tag_added / contact.tag_removed
{ "contact_id": "…", "tag_id": "…" }

// template.status_updated
{ "template_id": "…", "name": "order_update", "language": "en_US",
  "status": "APPROVED", "previous_status": "PENDING" }

// broadcast.completed
{ "broadcast_id": "…", "status": "sent", "total": 1000, "sent": 987, "failed": 13 }`,
    },
    { kind: 'h2', id: 'signature', text: 'Signature' },
    {
      kind: 'p',
      text: '`X-Wacrm-Signature: t=<unix seconds>,v1=<hex>`, where `v1` is `HMAC-SHA256(secret, "<t>.<raw body>")`. Recompute it over the raw body, compare in constant time and reject a `t` more than a few minutes old. Complete receivers in Node, Python and PHP are in the [guide](/developers/guides/webhooks).',
    },
    { kind: 'h2', id: 'delivery', text: 'Delivery semantics' },
    {
      kind: 'ul',
      items: [
        '**At-least-once and durable**: the event is persisted before the first attempt.',
        'Retry ladder: 1 min, 5 min, 30 min, 2 h and 12 h. After that it is left `dead` and can be retried by hand.',
        'Each attempt has a short timeout and **redirects are not followed**.',
        'Any response that is not 2xx counts as a failure.',
        'After 15 consecutive failures the destination auto-disables; `PATCH` with `is_active: true` revives it and resets the counter.',
        'Delivery history is kept for **30 days**.',
        '`message.status_updated` covers messages the CRM stores (inbox and API sends), not sends that only exist inside a broadcast.',
      ],
    },
    { kind: 'h2', id: 'ssrf', text: 'Allowed targets' },
    {
      kind: 'p',
      text: 'The `url` must be `https://` and must resolve to a public address. `localhost`, private ranges (RFC1918), link-local — including the cloud-metadata `169.254.169.254` — and similar internal targets are refused **at delivery time**, not only when the destination is registered.',
    },
    { kind: 'h2', id: 'dashboard', text: 'From the dashboard' },
    {
      kind: 'p',
      text: '**Settings → Webhooks** does the same without writing code: create a destination (the secret is shown once), edit URL and events, enable and disable, see the latest deliveries with their status code and error, and retry. The dashboard never shows the secret of an existing destination.',
    },
  ],
};

export const integrations: DocPage = {
  slug: 'integrations',
  title: 'Integrations',
  summary:
    'The MCP server for assistants and how to generate an SDK from the OpenAPI document.',
  blocks: [
    {
      kind: 'lead',
      text: 'Two ways to avoid writing a client by hand: an MCP server ready for assistants, and the OpenAPI document to generate the SDK for your language.',
    },
    { kind: 'h2', id: 'mcp', text: 'MCP server' },
    {
      kind: 'p',
      text: 'The `wacrm-mcp` package is a [Model Context Protocol](https://modelcontextprotocol.io) server wrapping this very API, so clients like Claude Desktop, Claude Code or Cursor can drive the CRM in natural language: "how many conversations are still open?", "find the contact for +1 415 555 0123 and show the last few messages".',
    },
    {
      kind: 'p',
      text: 'It reimplements nothing: authentication, scopes and limits are still enforced by your instance.',
    },
    {
      kind: 'code',
      lang: 'jsonc',
      label: 'MCP client configuration',
      code: `{
  "mcpServers": {
    "wacrm": {
      "command": "npx",
      "args": ["-y", "wacrm-mcp"],
      "env": {
        "WACRM_BASE_URL": "https://your-domain.example.com",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}`,
    },
    {
      kind: 'table',
      head: ['Variable', 'Required', 'Purpose'],
      rows: [
        ['`WACRM_BASE_URL`', 'yes', 'Your instance URL'],
        ['`WACRM_API_KEY`', 'yes', 'A key created in the dashboard'],
        [
          '`WACRM_ENABLE_WRITES`',
          'no',
          '`true` to expose contact writes and message sending',
        ],
        [
          '`WACRM_ENABLE_BROADCASTS`',
          'no',
          '`true` to expose broadcasts (needs `WACRM_ENABLE_WRITES`)',
        ],
      ],
    },
    {
      kind: 'note',
      tone: 'good',
      text: "The configuration above is **read-only**, which is the safe default: without the two switches the write tools are not even registered and the model cannot see them. Even with them on, the key's scopes still rule: for a read-only assistant, issue a read-only key.",
    },
    {
      kind: 'p',
      text: 'Mass broadcast is the one tool that additionally requires `confirm: true` and is marked destructive, so the client asks first.',
    },
    { kind: 'h2', id: 'sdk', text: 'Generating an SDK from the OpenAPI' },
    {
      kind: 'p',
      text: 'Your instance publishes the full contract at [GET /api/v1/openapi.json](/api/v1/openapi.json) — public, unauthenticated. It is a standard **OpenAPI 3.1** document: any generator understands it.',
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'TypeScript types',
      code: `npx openapi-typescript https://your-domain.example.com/api/v1/openapi.json \\
  -o src/types/cabbity.d.ts`,
    },
    {
      kind: 'code',
      lang: 'bash',
      label: 'A client in Python, Java, Go…',
      code: `npx @openapitools/openapi-generator-cli generate \\
  -i https://your-domain.example.com/api/v1/openapi.json \\
  -g python \\
  -o ./cabbity-client`,
    },
    {
      kind: 'ul',
      items: [
        'Regenerate the client when you upgrade the instance: the document is built from the code, so it reflects what your version actually serves.',
        'The security scheme is `bearer`: the generator will leave you a place to put the key.',
        "Webhook events travel in the document's `webhooks` section, so you can generate the receiver's types too.",
        'To poke at it by hand, import that same URL into Postman or Insomnia.',
      ],
    },
    { kind: 'h2', id: 'no-sdk', text: 'Without a generator' },
    {
      kind: 'p',
      text: "The API is HTTP with JSON and a bearer credential: `curl`, `fetch` or your language's library are enough. Every list paginates the same way and every error carries the same envelope, so a hundred-line client covers the whole API. What is worth wrapping once is the retry on `429` reading `Retry-After`, and the `Idempotency-Key` on writes.",
    },
  ],
};

export const changelog: DocPage = {
  slug: 'changelog',
  title: 'API changelog',
  summary: 'What changed in /api/v1 and when, newest first.',
  blocks: [
    {
      kind: 'lead',
      text: 'Changes to the public `/api/v1` contract, newest first. Internal changes nobody can see from outside do not show up here.',
    },
    {
      kind: 'ul',
      items: [
        '**Adding does not break.** New fields in a response, new endpoints and new values in an enum can appear in any version: ignore what you do not know.',
        '**Removing does break**, which is why we do not do it inside `v1`. If something had to go, it would be announced here as deprecated first.',
        'Always branch on `error.code`, never on `error.message`, which gets reworded without notice.',
      ],
    },
  ],
};
