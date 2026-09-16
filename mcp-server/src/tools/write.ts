// ============================================================
// Write tools — registered only when WACRM_ENABLE_WRITES is set.
//
// These change data or send a WhatsApp message. They are gated so a
// read-only deployment never exposes them to the model at all. (The
// API key's scopes are still enforced server-side; a call without the
// right scope returns a clean `forbidden` error.)
// ============================================================

import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult, requireConfirm } from './shared.js';

const WRITE = { readOnlyHint: false, openWorldHint: true } as const;
const DESTRUCTIVE = { ...WRITE, destructiveHint: true } as const;

/** Header/footer/button fields shared by create and edit. */
const templateComponentInputs = {
  header_type: z
    .enum(['text', 'image', 'video', 'document'])
    .nullable()
    .optional()
    .describe('Header kind. Pass null to remove the header when editing.'),
  header_content: z
    .string()
    .nullable()
    .optional()
    .describe('Header text, for header_type "text".'),
  header_media_url: z
    .string()
    .url()
    .nullable()
    .optional()
    .describe('Publicly reachable media URL for a media header.'),
  footer_text: z
    .string()
    .nullable()
    .optional()
    .describe('Footer line. Pass null to remove it when editing.'),
  buttons: z
    .array(z.record(z.string(), z.unknown()))
    .nullable()
    .optional()
    .describe(
      'Button components, e.g. [{ "type": "QUICK_REPLY", "text": "Track" }].'
    ),
  sample_values: z
    .object({ body: z.array(z.string()) })
    .nullable()
    .optional()
    .describe(
      'One sample per body variable, in order. Meta rejects the template if they do not match.'
    ),
  from: z
    .string()
    .optional()
    .describe('Meta phone_number_id, to pick which WABA to work against.'),
  whatsapp_config_id: z
    .string()
    .optional()
    .describe('Internal id of the WhatsApp number; an alternative to `from`.'),
} as const;

const templateSchema = z
  .object({
    name: z.string().describe('Meta-approved template name.'),
    language: z.string().describe('Template language code, e.g. "en_US".'),
    params: z
      .array(z.string())
      .optional()
      .describe('Positional body variables, in order.'),
  })
  .describe('Template payload — required when type is "template".');

export function registerWriteTools(
  server: McpServer,
  client: WacrmClient
): void {
  server.registerTool(
    'send_message',
    {
      title: 'Send WhatsApp message',
      description:
        'Send a WhatsApp message to a phone number (E.164, e.g. +14155550123). The contact and conversation are found-or-created automatically. Use type "text" for a free-form message (only valid inside the 24-hour customer-service window), or "template" to send an approved template (required to open a new conversation). Media types (image/video/document/audio) require a media_url. This sends a real message to a real person — confirm the recipient and content with the user before calling.',
      inputSchema: {
        to: z
          .string()
          .describe(
            'Recipient phone number in E.164 format, e.g. +14155550123.'
          ),
        type: z
          .enum(['text', 'template', 'image', 'video', 'document', 'audio'])
          .default('text')
          .describe('Message type. Defaults to "text".'),
        text: z
          .string()
          .optional()
          .describe(
            'Message body for "text", or the caption for a media type.'
          ),
        media_url: z
          .string()
          .url()
          .optional()
          .describe(
            'Publicly reachable URL of the media file (required for media types).'
          ),
        filename: z
          .string()
          .optional()
          .describe('File name for a "document" send.'),
        template: templateSchema.optional(),
        reply_to_message_id: z
          .string()
          .optional()
          .describe(
            'Optional id of a message in the same conversation to reply to.'
          ),
      },
      annotations: {
        title: 'Send WhatsApp message',
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    handle(async (args) => jsonResult(await client.sendMessage(args)))
  );

  server.registerTool(
    'create_contact',
    {
      title: 'Create contact',
      description:
        'Create a contact by phone number (E.164, required). Find-or-create: if a contact with that phone already exists it is returned unchanged. Optional: name, email, company, and tags (tag names, created if missing).',
      inputSchema: {
        phone: z
          .string()
          .describe('Phone number in E.164 format, e.g. +14155550123.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z
          .array(z.string())
          .optional()
          .describe('Tag names; created if they do not exist.'),
      },
      annotations: {
        title: 'Create contact',
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    handle(async (args) => jsonResult(await client.createContact(args)))
  );

  server.registerTool(
    'update_contact',
    {
      title: 'Update contact',
      description:
        'Update an existing contact. Only the fields you pass are changed. Pass tags (an array of tag names) to replace the contact’s tags entirely.',
      inputSchema: {
        id: z.string().describe('Contact id.'),
        name: z.string().optional(),
        email: z.string().email().optional(),
        company: z.string().optional(),
        tags: z
          .array(z.string())
          .optional()
          .describe('Replaces the contact’s tags.'),
      },
      annotations: {
        title: 'Update contact',
        readOnlyHint: false,
        openWorldHint: true,
      },
    },
    handle(async ({ id, ...body }) =>
      jsonResult(await client.updateContact(id, body))
    )
  );

  // --- Tags ---------------------------------------------------------

  server.registerTool(
    'create_tag',
    {
      title: 'Create tag',
      description:
        'Create a tag. Find-or-create by name, case-insensitive: a name the account already uses returns the existing tag unchanged (its colour is not touched).',
      inputSchema: {
        name: z.string().min(1).max(64).describe('Tag name.'),
        color: z
          .string()
          .optional()
          .describe('Hex colour, #rgb or #rrggbb. Defaults to #3b82f6.'),
      },
      annotations: { ...WRITE, title: 'Create tag' },
    },
    handle(async (args) => jsonResult(await client.createTag(args)))
  );

  server.registerTool(
    'update_tag',
    {
      title: 'Rename or recolour a tag',
      description:
        'Change a tag’s name, colour, or both. Renaming onto a name the account already uses is a `conflict`; changing only the casing of its own name is allowed.',
      inputSchema: {
        id: z.string().describe('Tag id.'),
        name: z.string().min(1).max(64).optional(),
        color: z.string().optional().describe('Hex colour, #rgb or #rrggbb.'),
      },
      annotations: { ...WRITE, title: 'Rename or recolour a tag' },
    },
    handle(async ({ id, ...body }) =>
      jsonResult(await client.updateTag(id, body))
    )
  );

  server.registerTool(
    'delete_tag',
    {
      title: 'Delete tag',
      description:
        'Delete a tag AND detach it from every contact carrying it. There is no undo — the tag memberships are gone too, not just the tag. You MUST set confirm=true.',
      inputSchema: {
        id: z.string().describe('Tag id.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true. The tag is removed from every contact that had it.'
          ),
      },
      annotations: { ...DESTRUCTIVE, title: 'Delete tag' },
    },
    handle(async ({ id, confirm }) => {
      const refusal = requireConfirm(
        confirm,
        'Deleting a tag also strips it from every contact that carries it, and cannot be undone.'
      );
      if (refusal) return refusal;
      return jsonResult(await client.deleteTag(id));
    })
  );

  server.registerTool(
    'add_contact_tags',
    {
      title: 'Add tags to a contact',
      description:
        'Add tags to a contact by tag id, WITHOUT touching the ones it already carries — unlike update_contact, which replaces the whole set and works by name. All-or-nothing: if any id is unknown, nothing is attached. Get the ids from list_tags.',
      inputSchema: {
        contact_id: z.string().describe('Contact id.'),
        tag_ids: z
          .array(z.string())
          .min(1)
          .max(50)
          .describe('Tag ids, 1–50 per call.'),
      },
      annotations: { ...WRITE, title: 'Add tags to a contact' },
    },
    handle(async ({ contact_id, tag_ids }) =>
      jsonResult(await client.addContactTags(contact_id, tag_ids))
    )
  );

  server.registerTool(
    'remove_contact_tag',
    {
      title: 'Remove a tag from a contact',
      description:
        'Detach one tag from one contact. The tag itself survives; use delete_tag to remove it from the account. Idempotent: removing a tag the contact does not carry succeeds and changes nothing.',
      inputSchema: {
        contact_id: z.string().describe('Contact id.'),
        tag_id: z.string().describe('Tag id to remove.'),
      },
      annotations: { ...WRITE, title: 'Remove a tag from a contact' },
    },
    handle(async ({ contact_id, tag_id }) =>
      jsonResult(await client.removeContactTag(contact_id, tag_id))
    )
  );

  // --- Templates ----------------------------------------------------

  server.registerTool(
    'create_template',
    {
      title: 'Create a message template',
      description:
        'Create a WhatsApp template and submit it to Meta for review; it comes back PENDING and is only sendable once APPROVED, which takes minutes to hours. The name must be lowercase letters, digits and underscores. Body variables must run contiguously from {{1}}, and sample_values.body needs exactly one sample per variable. Category "Authentication" is rejected — create those in WhatsApp Manager and pull them in with sync_templates.',
      inputSchema: {
        name: z
          .string()
          .describe('Template name: lowercase, digits, underscores.'),
        language: z.string().describe('Meta language code, e.g. "en_US".'),
        category: z
          .enum(['Marketing', 'Utility'])
          .describe('Template category.'),
        body_text: z
          .string()
          .describe('Body text, with {{1}}…{{n}} placeholders.'),
        ...templateComponentInputs,
      },
      annotations: { ...WRITE, title: 'Create a message template' },
    },
    handle(async (args) => jsonResult(await client.createTemplate(args)))
  );

  server.registerTool(
    'update_template',
    {
      title: 'Edit a message template',
      description:
        'Edit a template and resubmit it for review (it returns to PENDING). Meta REPLACES components rather than patching them, so anything you omit is inherited from the stored template: pass an explicit null in footer_text, header_type or buttons to actually remove it. `name` and `language` are immutable. Only templates that reached Meta and sit in APPROVED, REJECTED or PAUSED can be edited; Meta caps edits at 10 per template per 30 days.',
      inputSchema: {
        id: z.string().describe('Template id.'),
        category: z.enum(['Marketing', 'Utility']).optional(),
        body_text: z.string().optional(),
        ...templateComponentInputs,
      },
      annotations: { ...WRITE, title: 'Edit a message template' },
    },
    handle(async ({ id, ...body }) =>
      jsonResult(await client.updateTemplate(id, body))
    )
  );

  server.registerTool(
    'delete_template',
    {
      title: 'Delete a message template',
      description:
        'Delete a template at Meta AND locally. Irreversible, and it breaks every future send of that template — including scheduled broadcasts that name it. Only this language variant goes, not the other translations sharing the name. You MUST set confirm=true.',
      inputSchema: {
        id: z.string().describe('Template id.'),
        from: z
          .string()
          .optional()
          .describe('Meta phone_number_id, to pick the WABA.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true. The template is deleted at Meta as well as locally.'
          ),
      },
      annotations: { ...DESTRUCTIVE, title: 'Delete a message template' },
    },
    handle(async ({ id, from, confirm }) => {
      const refusal = requireConfirm(
        confirm,
        'Deleting a template removes it at Meta too, and any send or broadcast naming it will start failing.'
      );
      if (refusal) return refusal;
      return jsonResult(await client.deleteTemplate(id, { from }));
    })
  );

  server.registerTool(
    'sync_templates',
    {
      title: 'Pull the template catalogue from Meta',
      description:
        'Pull Meta’s template catalogue into the CRM. Meta wins on every conflict, so local edits that have not reached Meta are overwritten; local templates with no counterpart at Meta are kept, not deleted. One call walks up to 20 pages of the Graph API and the account gets 6 per minute, so you MUST set confirm=true. For status changes, subscribing to the template.status_updated webhook beats polling this.',
      inputSchema: {
        from: z
          .string()
          .optional()
          .describe('Meta phone_number_id, to pick the WABA.'),
        whatsapp_config_id: z
          .string()
          .optional()
          .describe('Internal id of the WhatsApp number.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true. Meta’s catalogue overwrites local template data.'
          ),
      },
      annotations: { ...WRITE, title: 'Pull the template catalogue from Meta' },
    },
    handle(async ({ confirm, ...body }) => {
      const refusal = requireConfirm(
        confirm,
        'A sync lets Meta’s catalogue overwrite local template data and spends one of this account’s 6 syncs per minute.'
      );
      if (refusal) return refusal;
      return jsonResult(await client.syncTemplates(body));
    })
  );

  // --- Exports ------------------------------------------------------

  server.registerTool(
    'create_export',
    {
      title: 'Order a bulk conversation export',
      description:
        'Queue an export of many conversations at once; use export_conversation for a single one. Returns 202 with a queued job — poll get_export for the download link. It spends one of the account’s 10 exports per hour, shared with export_conversation, and an unfiltered call can pull the entire message history, so you MUST set confirm=true. Files and job rows are deleted after 7 days.',
      inputSchema: {
        format: z
          .enum(['json', 'csv'])
          .default('json')
          .describe('File format. Defaults to json.'),
        status: z
          .enum(['open', 'pending', 'closed'])
          .optional()
          .describe('Only conversations in this status.'),
        contact_id: z
          .string()
          .optional()
          .describe('Only conversations for this contact.'),
        from: z
          .string()
          .optional()
          .describe('ISO 8601 lower bound on the conversation’s created_at.'),
        to: z
          .string()
          .optional()
          .describe('ISO 8601 upper bound on the conversation’s created_at.'),
        confirm: z
          .boolean()
          .optional()
          .describe(
            'Must be true. Guards the shared 10-per-hour export budget.'
          ),
      },
      annotations: { ...WRITE, title: 'Order a bulk conversation export' },
    },
    handle(async ({ confirm, format, status, contact_id, from, to }) => {
      const refusal = requireConfirm(
        confirm,
        'A bulk export spends one of this account’s 10 exports per hour, and with no filters it copies the whole message history into a downloadable file.'
      );
      if (refusal) return refusal;

      const filters: Record<string, string> = {};
      if (status) filters.status = status;
      if (contact_id) filters.contact_id = contact_id;
      if (from) filters.from = from;
      if (to) filters.to = to;

      return jsonResult(
        await client.createExport({ kind: 'conversations', format, filters })
      );
    })
  );
}
