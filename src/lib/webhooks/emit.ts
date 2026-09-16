// ============================================================
// Atajo de dominio para emitir un evento de webhook.
//
// `dispatchWebhookEvent` necesita un cliente que pueda ESCRIBIR en
// `webhook_deliveries`, y esa tabla solo tiene política de lectura: la
// cola es del rol de servicio. La capa de dominio (etiquetas, cierre de
// conversación, sincronización de plantillas) trabaja casi siempre con
// el cliente de sesión del usuario, así que pedirle que pase un cliente
// de servicio sería invitar a que alguien pase el suyo y la entrega se
// pierda en silencio por RLS.
//
// `emitWebhookEvent` resuelve el cliente por dentro y NUNCA lanza: los
// llamadores son caminos de producto (guardar un contacto, cerrar un
// chat) donde un webhook caído no puede convertirse en un 500.
// ============================================================

import { supabaseAdmin } from '@/lib/flows/admin-client';
import { dispatchWebhookEvent } from '@/lib/webhooks/deliver';
import type { WebhookEvent } from '@/lib/webhooks/events';

export async function emitWebhookEvent(
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  if (!accountId) return;
  try {
    await dispatchWebhookEvent(supabaseAdmin(), accountId, event, data);
  } catch (err) {
    console.error('[webhooks] emit failed for', event, err);
  }
}
