// ============================================================
// Outbound webhook event vocabulary — pure, no I/O.
//
// An endpoint subscribes to one or more of these. Adding an event is
// one entry here plus a `dispatchWebhookEvent` call at the source of
// the event (the DB stores subscriptions as a free `text[]`, so no
// migration is needed — same model as API scopes).
//
// Los disparadores viven en la CAPA DE DOMINIO, no en `/api/v1`: un
// contacto que se etiqueta desde el panel o una conversación que cierra
// una automatización tienen que llegar al cliente igual que si los
// hubiera movido su propia integración.
// ============================================================

export const WEBHOOK_EVENTS = [
  'message.received', // an inbound WhatsApp message landed
  'message.status_updated', // a sent message advanced (sent/delivered/read)
  'conversation.created', // a new conversation was opened for a contact
  'conversation.closed', // a conversation was closed (panel or automation)
  'conversation.assigned', // a conversation changed hands
  'contact.created', // a contact was created
  'contact.updated', // a contact's fields changed
  'contact.tag_added', // a tag was attached to a contact
  'contact.tag_removed', // a tag was detached from a contact
  'template.status_updated', // Meta moved a template's review status
  'broadcast.completed', // a campaign finished fanning out
] as const;

export type WebhookEvent = (typeof WEBHOOK_EVENTS)[number];

/** Human-readable descriptions (surfaced in docs / a future UI). */
export const WEBHOOK_EVENT_DESCRIPTIONS: Record<WebhookEvent, string> = {
  'message.received': 'An inbound message was received from a contact',
  'message.status_updated':
    'A message you sent changed delivery status (sent/delivered/read/failed)',
  'conversation.created': 'A new conversation was opened',
  'conversation.closed': 'A conversation was closed',
  'conversation.assigned': 'A conversation was assigned to an agent',
  'contact.created': 'A contact was created',
  'contact.updated': 'A contact was updated',
  'contact.tag_added': 'A tag was added to a contact',
  'contact.tag_removed': 'A tag was removed from a contact',
  'template.status_updated':
    "Meta changed a message template's review status (approved/rejected/…)",
  'broadcast.completed': 'A broadcast finished sending',
};

/**
 * Campos que lleva el `data` de cada evento. Es documentación
 * ejecutable: el panel y `/developers` la muestran, y un cambio aquí
 * es un cambio de contrato con el cliente.
 */
export const WEBHOOK_EVENT_DATA_FIELDS: Record<WebhookEvent, string[]> = {
  'message.received': [
    'conversation_id',
    'contact_id',
    'whatsapp_message_id',
    'content_type',
    'text',
  ],
  'message.status_updated': [
    'whatsapp_message_id',
    'conversation_id',
    'status',
  ],
  'conversation.created': ['conversation_id', 'contact_id'],
  'conversation.closed': ['conversation_id', 'contact_id'],
  'conversation.assigned': [
    'conversation_id',
    'contact_id',
    'assigned_agent_id',
  ],
  'contact.created': ['contact_id', 'phone', 'wa_user_id', 'name'],
  'contact.updated': ['contact_id', 'phone', 'wa_user_id', 'name', 'fields'],
  'contact.tag_added': ['contact_id', 'tag_id'],
  'contact.tag_removed': ['contact_id', 'tag_id'],
  'template.status_updated': [
    'template_id',
    'name',
    'language',
    'status',
    'previous_status',
  ],
  'broadcast.completed': ['broadcast_id', 'status', 'total', 'sent', 'failed'],
};

/** Type-narrow an unknown value into a valid `WebhookEvent`. */
export function isWebhookEvent(value: unknown): value is WebhookEvent {
  return (
    typeof value === 'string' &&
    (WEBHOOK_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Validate + de-duplicate a caller-supplied event list. Returns the
 * cleaned list, or `null` if any entry is unknown (callers turn that
 * into a 400). An empty list is rejected as `null` too — an endpoint
 * subscribed to nothing is almost certainly a mistake.
 */
export function normalizeEvents(input: unknown): WebhookEvent[] | null {
  if (!Array.isArray(input) || input.length === 0) return null;
  const out: WebhookEvent[] = [];
  for (const entry of input) {
    if (!isWebhookEvent(entry)) return null;
    if (!out.includes(entry)) out.push(entry);
  }
  return out;
}
