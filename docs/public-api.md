# Public API (`/api/v1`) — where the documentation lives

The full, up-to-date contract for the public API is **served by the
application itself**, at two addresses on your own instance:

| What                                                                                                                 | Where                  |
| -------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Documentation for humans: getting started, scopes, conventions, guides, reference, webhooks, integrations, changelog | `/developers`          |
| The machine-readable contract: OpenAPI 3.1, public, unauthenticated                                                  | `/api/v1/openapi.json` |

`/developers` is public — no session needed — and reads in Spanish or
English with a selector on every page. Its **Reference** section is
generated on the server from that same OpenAPI document, so it cannot
drift from the code the way a hand-written markdown file does. That
drift is exactly why this file is no longer the reference: it grew to
nine hundred lines across one release and had to be reconciled by hand
in every branch merge.

Start at **Settings → API** in the dashboard to create a key, then
follow `/developers` for everything else:

- **Get started** — create a key, call `GET /api/v1/me`, set the
  environment up.
- **Authentication and scopes** — the twelve scopes, least privilege,
  expiry, rotation, what to do if a key leaks.
- **Conventions** — response envelope, error codes, `request_id`, rate
  limits, pagination, idempotency.
- **Guides** — send a template end to end, sync contacts and tags,
  export conversations, receive webhooks (signature verification in
  Node, Python and PHP, plus retries and duplicates).
- **Reference** — every operation, generated from the OpenAPI document.
- **Webhooks** — event catalogue, per-event `data`, signature, delivery
  semantics.
- **Integrations** — the MCP server (`mcp-server/`) and generating an
  SDK from the OpenAPI document.
- **API changelog** — what changed in `/api/v1` and when.

Self-hosting notes that are not part of the API contract stay in
[`docs/docker.md`](./docker.md) (the `GET /api/webhooks/cron` scheduler
that drives webhook retries and export jobs) and in
[`docs/security.md`](./security.md).
