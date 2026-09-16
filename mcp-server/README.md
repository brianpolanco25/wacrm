# wacrm MCP server

A [Model Context Protocol](https://modelcontextprotocol.io) server for
**[wacrm](https://github.com/ArnasDon/wacrm)** — the self-hostable
WhatsApp CRM. It lets MCP clients (Claude Desktop, Claude Code, Cursor,
and others) drive your CRM in natural language:

> "How many conversations are still open?"
> "Find the contact for +1 415 555 0123 and show the last few messages."
> "Draft and send an order-update template to Jane."

It's a thin wrapper over wacrm's public `/api/v1` REST API, documented
at `/developers` on your own instance. All auth, scoping, and rate
limiting are enforced by your wacrm instance — this server just exposes
the API as MCP tools.

Your instance also serves the machine-readable contract at
`GET /api/v1/openapi.json` (OpenAPI 3.1, no key needed). That's the
source of truth for what each tool sends and gets back, and what to
point an SDK generator at if you'd rather not go through MCP.

## Prerequisites

1. A running wacrm instance (your own self-hosted deploy).
2. An API key: in the dashboard go to **Settings → API keys → New API
   key** and grant only the scopes you need. The key is shown once.

## Install & configure

The server reads two required environment variables and two optional
write guards:

| Variable                  | Required | Purpose                                                        |
| ------------------------- | -------- | -------------------------------------------------------------- |
| `WACRM_BASE_URL`          | yes      | Your instance URL, e.g. `https://crm.example.com`              |
| `WACRM_API_KEY`           | yes      | An API key from the dashboard                                  |
| `WACRM_ENABLE_WRITES`     | no       | `true` to expose contact writes + message sending              |
| `WACRM_ENABLE_BROADCASTS` | no       | `true` to expose mass broadcasts (needs `WACRM_ENABLE_WRITES`) |

### Claude Desktop / Claude Code / Cursor

Add to your MCP client config (e.g. `claude_desktop_config.json`, or
`.mcp.json` for Claude Code):

```json
{
  "mcpServers": {
    "wacrm": {
      "command": "npx",
      "args": ["-y", "wacrm-mcp"],
      "env": {
        "WACRM_BASE_URL": "https://crm.example.com",
        "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx"
      }
    }
  }
}
```

That configuration is **read-only** — the safe default. To let the
assistant change data or send messages, add the write guards:

```jsonc
"env": {
  "WACRM_BASE_URL": "https://crm.example.com",
  "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
  "WACRM_ENABLE_WRITES": "true",
  "WACRM_ENABLE_BROADCASTS": "true"
}
```

## Tools

Read tools are always available. Write and broadcast tools appear only
when their guard is set.

| Tool                  | Group     | Scope needed           | What it does                                          |
| --------------------- | --------- | ---------------------- | ----------------------------------------------------- |
| `whoami`              | read      | _(any valid key)_      | Show the account + scopes the key carries             |
| `list_contacts`       | read      | `contacts:read`        | List/search contacts (paginated)                      |
| `get_contact`         | read      | `contacts:read`        | Read one contact                                      |
| `list_conversations`  | read      | `conversations:read`   | List conversations, filter by status/contact          |
| `get_conversation`    | read      | `conversations:read`   | Read one conversation                                 |
| `list_messages`       | read      | `messages:read`        | List a conversation's messages                        |
| `get_broadcast`       | read      | `broadcasts:send`      | Poll a broadcast's delivery status                    |
| `list_tags`           | read      | `tags:read`            | List/search tags (ids for tagging and filtering)      |
| `get_tag`             | read      | `tags:read`            | Read one tag                                          |
| `list_templates`      | read      | `templates:read`       | List templates with their body variables              |
| `get_template`        | read      | `templates:read`       | Read one template and its components                  |
| `list_exports`        | read      | `conversations:export` | List export jobs                                      |
| `get_export`          | read      | `conversations:export` | Poll a job; get a 15-minute download link             |
| `export_conversation` | read      | `conversations:export` | Download one conversation inline (requires `confirm`) |
| `send_message`        | write     | `messages:send`        | Send a WhatsApp message (text/template/media)         |
| `create_contact`      | write     | `contacts:write`       | Create (find-or-create) a contact                     |
| `update_contact`      | write     | `contacts:write`       | Update a contact / replace its tags                   |
| `create_tag`          | write     | `tags:write`           | Create (find-or-create) a tag                         |
| `update_tag`          | write     | `tags:write`           | Rename or recolour a tag                              |
| `delete_tag`          | write     | `tags:write`           | Delete a tag everywhere (requires `confirm`)          |
| `add_contact_tags`    | write     | `tags:write`           | Add tags by id, additively                            |
| `remove_contact_tag`  | write     | `tags:write`           | Detach one tag from one contact                       |
| `create_template`     | write     | `templates:write`      | Create a template and submit it to Meta               |
| `update_template`     | write     | `templates:write`      | Edit a template and resubmit it                       |
| `delete_template`     | write     | `templates:write`      | Delete a template at Meta too (requires `confirm`)    |
| `sync_templates`      | write     | `templates:write`      | Pull Meta's catalogue (requires `confirm`)            |
| `create_export`       | write     | `conversations:export` | Queue a bulk export (requires `confirm`)              |
| `send_broadcast`      | broadcast | `broadcasts:send`      | Launch a template broadcast (requires `confirm`)      |

`export_conversation`, `list_exports` and `get_export` sit in the read
group because they change nothing — but the two that actually build a
file spend the account's shared budget of **10 exports per hour**, so
they ask for `confirm` anyway (see below).

## Safety model

Sending WhatsApp messages through an LLM is a real-world side effect, so
the server layers three guards:

1. **Read-only by default.** Write and broadcast tools are not even
   registered — the model can't see them — unless you opt in via
   `WACRM_ENABLE_WRITES` / `WACRM_ENABLE_BROADCASTS`.
2. **API-key scopes.** Whatever the guards allow, your wacrm instance
   still enforces the key's scopes. A call without the right scope
   returns a clean `forbidden` error. Issue a read-only key for a
   read-only assistant.
3. **Explicit confirmation on the costly and the irreversible.** Some
   tools refuse to run unless called with `confirm: true`. The rule is
   one of two things being true:

   - **It cannot be undone**, and the blast radius is wider than the
     thing you named: `delete_tag` (strips the tag from every contact),
     `delete_template` (deletes at Meta too, so every later send naming
     it fails), `send_broadcast` (up to 1000 real messages). These are
     also marked `destructive`, so compliant clients prompt first.
   - **It spends a budget the account shares**: `export_conversation`
     and `create_export` draw on the same 10-per-hour export bucket,
     and `sync_templates` on 6 per minute while letting Meta's
     catalogue overwrite local template data.

   The `confirm` flag is not security — the model supplies it. It
   exists so the intent shows up in the tool call the user sees.

## Development

```bash
npm install
npm run build      # compile to dist/
npm run typecheck
npm start          # run the compiled server (needs the env vars)
```

Logs go to **stderr** — stdout is reserved for the MCP protocol.

## License

MIT — same as wacrm.
