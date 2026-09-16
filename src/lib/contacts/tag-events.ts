import type { SupabaseClient } from '@supabase/supabase-js';

import {
  runAutomationsForTrigger,
  type AutomationContext,
} from '@/lib/automations/engine';
import { emitWebhookEvent } from '@/lib/webhooks/emit';
import { addContactTagIfAbsent, removeContactTag } from './tag-write';
import { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

export { MAX_TAG_CHAIN_DEPTH, getTagChainDepth } from './tag-chain';

interface AddContactTagAndDispatchInput {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  tagId: string;
  context?: AutomationContext;
}

export interface AddContactTagResult {
  added: boolean;
  dispatched: boolean;
  reason?: 'duplicate' | 'max_depth';
}

/**
 * Central server-side tag writer. It dispatches tag_added only for a
 * newly-created join and caps chained tag automations to avoid loops.
 */
export async function addContactTagAndDispatch(
  input: AddContactTagAndDispatchInput
): Promise<AddContactTagResult> {
  const added = await addContactTagIfAbsent(input.db, {
    accountId: input.accountId,
    contactId: input.contactId,
    tagId: input.tagId,
  });

  if (!added) return { added: false, dispatched: false, reason: 'duplicate' };

  // Webhook saliente (fase 7 §4). Va aquí y no en la ruta porque por
  // esta función pasan TODOS los caminos que etiquetan: el panel, la
  // API pública y las automatizaciones. Solo para altas reales: una
  // etiqueta repetida no es un evento.
  await emitWebhookEvent(input.accountId, 'contact.tag_added', {
    contact_id: input.contactId,
    tag_id: input.tagId,
  });

  const depth = getTagChainDepth(input.context);
  if (depth >= MAX_TAG_CHAIN_DEPTH) {
    console.warn('[automations] tag_added chain depth limit reached', {
      accountId: input.accountId,
      contactId: input.contactId,
      tagId: input.tagId,
      depth,
    });
    return { added: true, dispatched: false, reason: 'max_depth' };
  }

  await runAutomationsForTrigger({
    accountId: input.accountId,
    triggerType: 'tag_added',
    contactId: input.contactId,
    context: {
      ...input.context,
      tag_id: input.tagId,
      vars: {
        ...(input.context?.vars ?? {}),
        _tag_chain_depth: depth + 1,
      },
    },
  });

  return { added: true, dispatched: true };
}

/**
 * Quita una etiqueta y emite `contact.tag_removed`. Espejo de
 * {@link addContactTagAndDispatch}: quitar una etiqueta no dispara
 * automatizaciones (no hay disparador `tag_removed`), pero sí es un
 * cambio que un cliente de la API quiere ver.
 */
export async function removeContactTagAndDispatch(input: {
  db: SupabaseClient;
  accountId: string;
  contactId: string;
  tagId: string;
}): Promise<void> {
  await removeContactTag(input.db, {
    accountId: input.accountId,
    contactId: input.contactId,
    tagId: input.tagId,
  });

  await emitWebhookEvent(input.accountId, 'contact.tag_removed', {
    contact_id: input.contactId,
    tag_id: input.tagId,
  });
}
