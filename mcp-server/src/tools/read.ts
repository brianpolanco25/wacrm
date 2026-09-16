// ============================================================
// Read-only tools — always registered.
//
// whoami + list/read of contacts, conversations, messages, and
// broadcast status. None of these change state, so they're safe to
// expose unconditionally. Each carries readOnlyHint so clients can
// surface them without a confirmation prompt.
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult, requireConfirm } from './shared.js';

const READ_ONLY = { readOnlyHint: true, openWorldHint: true } as const;

/**
 * Template statuses, mirroring TEMPLATE_STATUSES in the OpenAPI
 * registry (`src/lib/api/v1/openapi/schemas.ts`). `DRAFT` is ours —
 * a template saved locally that never reached Meta; the rest are
 * Meta's, stored verbatim. The API rejects anything outside this list
 * with `bad_request`, so the enum here turns that into a client-side
 * error the model can fix without a round trip.
 */
const TEMPLATE_STATUSES = [
  'DRAFT',
  'PENDING',
  'APPROVED',
  'REJECTED',
  'PAUSED',
  'DISABLED',
  'IN_APPEAL',
  'PENDING_DELETION',
] as const;

export function registerReadTools(
  server: McpServer,
  client: WacrmClient
): void {
  server.registerTool(
    'whoami',
    {
      title: 'Who am I',
      description:
        'Verify the API key and show which wacrm account it is bound to and what scopes it carries. Call this first to discover what actions are possible.',
      inputSchema: {},
      annotations: { ...READ_ONLY, title: 'Who am I' },
    },
    handle(async () => jsonResult(await client.me()))
  );

  server.registerTool(
    'list_contacts',
    {
      title: 'List contacts',
      description:
        'List contacts in the CRM, newest first. Optionally filter by a free-text search (matches name or phone) or by a tag id. Results are paginated: pass the returned next_cursor to fetch the next page.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Free-text search over name or phone number.'),
        tag: z.string().optional().describe('Tag id to filter by.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z
          .string()
          .optional()
          .describe('Opaque pagination cursor from a previous response.'),
      },
      annotations: { ...READ_ONLY, title: 'List contacts' },
    },
    handle(async (args) => jsonResult(await client.listContacts(args)))
  );

  server.registerTool(
    'get_contact',
    {
      title: 'Get contact',
      description: 'Read a single contact by its id.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get contact' },
    },
    handle(async ({ id }) => jsonResult(await client.getContact(id)))
  );

  server.registerTool(
    'list_conversations',
    {
      title: 'List conversations',
      description:
        'List conversations, newest first. Optionally filter by status (open / pending / closed) or by contact id. Paginated.',
      inputSchema: {
        status: z
          .enum(['open', 'pending', 'closed'])
          .optional()
          .describe('Conversation status filter.'),
        contact_id: z
          .string()
          .optional()
          .describe('Only conversations for this contact.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List conversations' },
    },
    handle(async (args) => jsonResult(await client.listConversations(args)))
  );

  server.registerTool(
    'get_conversation',
    {
      title: 'Get conversation',
      description:
        'Read a single conversation by id, including its contact and tags.',
      inputSchema: {
        id: z.string().describe('Conversation id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get conversation' },
    },
    handle(async ({ id }) => jsonResult(await client.getConversation(id)))
  );

  server.registerTool(
    'list_messages',
    {
      title: 'List messages',
      description:
        'List the messages in a conversation, newest first. Each message includes its direction (inbound/outbound), delivery status, and content. Paginated.',
      inputSchema: {
        conversation_id: z
          .string()
          .describe('The conversation to read messages from.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List messages' },
    },
    handle(async ({ conversation_id, limit, cursor }) =>
      jsonResult(
        await client.listConversationMessages(conversation_id, {
          limit,
          cursor,
        })
      )
    )
  );

  server.registerTool(
    'get_broadcast',
    {
      title: 'Get broadcast status',
      description:
        'Read a broadcast campaign by id — its status and delivered / read / rejected counts. Use this to poll progress after launching one.',
      inputSchema: {
        id: z.string().describe('Broadcast id.'),
      },
      annotations: { ...READ_ONLY, title: 'Get broadcast status' },
    },
    handle(async ({ id }) => jsonResult(await client.getBroadcast(id)))
  );

  // --- Tags ---------------------------------------------------------

  server.registerTool(
    'list_tags',
    {
      title: 'List tags',
      description:
        'List the account’s tags, newest first. Tag ids are what add_contact_tags and the list_contacts `tag` filter expect, so call this before filtering or tagging by name. Paginated.',
      inputSchema: {
        search: z
          .string()
          .optional()
          .describe('Case-insensitive match on the tag name.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List tags' },
    },
    handle(async (args) => jsonResult(await client.listTags(args)))
  );

  server.registerTool(
    'get_tag',
    {
      title: 'Get tag',
      description: 'Read a single tag by its id.',
      inputSchema: { id: z.string().describe('Tag id.') },
      annotations: { ...READ_ONLY, title: 'Get tag' },
    },
    handle(async ({ id }) => jsonResult(await client.getTag(id)))
  );

  // --- Templates ----------------------------------------------------

  server.registerTool(
    'list_templates',
    {
      title: 'List message templates',
      description:
        'List WhatsApp message templates, newest first. Each one carries `variables` — the ordered {{1}}…{{n}} its body expects — which is exactly what send_message needs for a template send. Only APPROVED templates can actually be sent. Paginated.',
      inputSchema: {
        status: z
          .enum(TEMPLATE_STATUSES)
          .optional()
          .describe('Exact status. APPROVED is the only sendable one.'),
        language: z
          .string()
          .optional()
          .describe('Meta language code, e.g. "en_US".'),
        category: z
          .enum(['Marketing', 'Utility', 'Authentication'])
          .optional()
          .describe('Template category.'),
        search: z
          .string()
          .optional()
          .describe('Substring of the name or the body text.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List message templates' },
    },
    handle(async (args) => jsonResult(await client.listTemplates(args)))
  );

  server.registerTool(
    'get_template',
    {
      title: 'Get message template',
      description:
        'Read one template by id, with its components (header, body, footer, buttons) and its review status.',
      inputSchema: { id: z.string().describe('Template id.') },
      annotations: { ...READ_ONLY, title: 'Get message template' },
    },
    handle(async ({ id }) => jsonResult(await client.getTemplate(id)))
  );

  // --- Exports ------------------------------------------------------

  server.registerTool(
    'list_exports',
    {
      title: 'List export jobs',
      description:
        'List the account’s conversation-export jobs, newest first. Files and rows are deleted after 7 days. Paginated.',
      inputSchema: {
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe('Page size, 1–100 (default 50).'),
        cursor: z.string().optional().describe('Opaque pagination cursor.'),
      },
      annotations: { ...READ_ONLY, title: 'List export jobs' },
    },
    handle(async (args) => jsonResult(await client.listExports(args)))
  );

  server.registerTool(
    'get_export',
    {
      title: 'Get export job',
      description:
        'Poll an export job: status goes queued → running → done | failed. When done the response carries a download_url that is signed per call and valid for 15 minutes — ask again when you need it rather than storing it, because anyone holding that URL can download the file until it expires.',
      inputSchema: { id: z.string().describe('Export job id.') },
      annotations: { ...READ_ONLY, title: 'Get export job' },
    },
    handle(async ({ id }) => jsonResult(await client.getExport(id)))
  );

  server.registerTool(
    'export_conversation',
    {
      title: 'Export one conversation',
      description:
        'Download a single conversation with every message, as JSON or CSV. The whole file comes back inline, so this can be a lot of text: above 10 000 messages it fails with `conflict` and you should use create_export instead. It spends one of the account’s 10 exports per hour, shared with create_export, so you MUST set confirm=true. Attachments appear as storage:// references, never as signed links.',
      inputSchema: {
        conversation_id: z.string().describe('The conversation to export.'),
        format: z
          .enum(['json', 'csv'])
          .default('json')
          .describe('File format. Defaults to json.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true. Guards the shared 10-per-hour export budget.'
          ),
      },
      // Read-only in the sense that matters (it changes nothing), but
      // gated anyway: the budget it spends is the account's, not ours.
      annotations: { ...READ_ONLY, title: 'Export one conversation' },
    },
    handle(async ({ conversation_id, format, confirm }) => {
      const refusal = requireConfirm(
        confirm,
        'Exporting a conversation spends one of this account’s 10 exports per hour and returns the whole transcript inline.'
      );
      if (refusal) return refusal;

      const file = await client.exportConversation(conversation_id, format);
      // The body is the file itself, so hand it over as text rather
      // than re-encoding it inside a JSON string — a CSV wrapped in
      // JSON.stringify is unreadable for both the model and the user.
      return {
        content: [
          {
            type: 'text' as const,
            text:
              `${file.filename ?? `conversation-${conversation_id}.${format}`} ` +
              `(${file.contentType})\n\n${file.body}`,
          },
        ],
      };
    })
  );
}
