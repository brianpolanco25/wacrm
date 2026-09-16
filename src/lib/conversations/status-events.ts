// ============================================================
// Cambios de estado y de dueño de una conversación, con su webhook.
//
// Cerrar o reasignar un chat pasaba por un `.update()` suelto en tres
// sitios distintos (la bandeja escribía directa contra Supabase desde
// el navegador, y las automatizaciones desde el motor). La fase 7 §4
// pide que esos cambios lleguen al cliente aunque los haga una persona
// en el panel, así que el UPDATE se centraliza aquí y el evento sale
// justo detrás de la escritura que de verdad cambió algo.
//
// Dos reglas que valen para las dos funciones:
//   - la consulta se acota por `account_id` además de por `id`, así que
//     un id de otra cuenta no toca nada y se responde 404, nunca 403;
//   - el evento solo se emite si el valor CAMBIÓ. Cerrar un chat ya
//     cerrado o reasignarlo al mismo agente no es noticia.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { emitWebhookEvent } from '@/lib/webhooks/emit';
import type { ConversationStatus } from '@/types';

interface ConversationScope {
  db: SupabaseClient;
  accountId: string;
  conversationId: string;
}

interface ConversationSnapshot {
  id: string;
  contact_id: string | null;
  status: ConversationStatus;
  assigned_agent_id: string | null;
}

async function readConversation(
  scope: ConversationScope
): Promise<ConversationSnapshot | null> {
  const { data, error } = await scope.db
    .from('conversations')
    .select('id, contact_id, status, assigned_agent_id')
    .eq('id', scope.conversationId)
    .eq('account_id', scope.accountId)
    .maybeSingle();

  if (error || !data) return null;
  return data as unknown as ConversationSnapshot;
}

/**
 * Cambia el estado de una conversación. Devuelve `false` si no existe
 * en esa cuenta (el llamador responde 404). Emite `conversation.closed`
 * cuando el chat pasa a cerrado.
 */
export async function setConversationStatus(
  scope: ConversationScope,
  status: ConversationStatus
): Promise<boolean> {
  const before = await readConversation(scope);
  if (!before) return false;

  const { error } = await scope.db
    .from('conversations')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', scope.conversationId)
    .eq('account_id', scope.accountId);

  if (error) {
    console.error('[conversations] status update failed:', error);
    return false;
  }

  if (status === 'closed' && before.status !== 'closed') {
    await emitWebhookEvent(scope.accountId, 'conversation.closed', {
      conversation_id: scope.conversationId,
      contact_id: before.contact_id,
    });
  }

  return true;
}

/**
 * Asigna (o desasigna, con `null`) una conversación. Devuelve `false`
 * si no existe en esa cuenta. Emite `conversation.assigned` solo cuando
 * el agente cambia de verdad.
 */
export async function assignConversation(
  scope: ConversationScope,
  agentId: string | null
): Promise<boolean> {
  const before = await readConversation(scope);
  if (!before) return false;

  const { error } = await scope.db
    .from('conversations')
    .update({ assigned_agent_id: agentId })
    .eq('id', scope.conversationId)
    .eq('account_id', scope.accountId);

  if (error) {
    console.error('[conversations] assignment update failed:', error);
    return false;
  }

  if ((before.assigned_agent_id ?? null) !== agentId) {
    await emitWebhookEvent(scope.accountId, 'conversation.assigned', {
      conversation_id: scope.conversationId,
      contact_id: before.contact_id,
      assigned_agent_id: agentId,
    });
  }

  return true;
}

/**
 * Variante por CONTACTO, para el motor de automatizaciones: sus pasos
 * `close_conversation` / `assign_conversation` trabajan con el contacto
 * del disparo, no con un id de conversación. Aplica el cambio a las
 * conversaciones de ese contacto en la cuenta y emite un evento por
 * cada una que cambió.
 */
export async function applyConversationChangeByContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  change: { status: ConversationStatus } | { assignedAgentId: string | null }
): Promise<void> {
  const { data, error } = await db
    .from('conversations')
    .select('id, contact_id, status, assigned_agent_id')
    .eq('account_id', accountId)
    .eq('contact_id', contactId);

  if (error || !data || data.length === 0) return;
  const rows = data as unknown as ConversationSnapshot[];

  if ('status' in change) {
    const { error: updateError } = await db
      .from('conversations')
      .update({ status: change.status, updated_at: new Date().toISOString() })
      .eq('account_id', accountId)
      .eq('contact_id', contactId);
    if (updateError) {
      console.error('[conversations] bulk status update failed:', updateError);
      return;
    }
    if (change.status !== 'closed') return;
    for (const row of rows) {
      if (row.status === 'closed') continue;
      await emitWebhookEvent(accountId, 'conversation.closed', {
        conversation_id: row.id,
        contact_id: row.contact_id,
      });
    }
    return;
  }

  const { error: updateError } = await db
    .from('conversations')
    .update({ assigned_agent_id: change.assignedAgentId })
    .eq('account_id', accountId)
    .eq('contact_id', contactId);
  if (updateError) {
    console.error('[conversations] bulk assignment failed:', updateError);
    return;
  }
  for (const row of rows) {
    if ((row.assigned_agent_id ?? null) === change.assignedAgentId) continue;
    await emitWebhookEvent(accountId, 'conversation.assigned', {
      conversation_id: row.id,
      contact_id: row.contact_id,
      assigned_agent_id: change.assignedAgentId,
    });
  }
}
