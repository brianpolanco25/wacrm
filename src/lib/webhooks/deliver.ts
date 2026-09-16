// ============================================================
// Entrega saliente de webhooks — punto de entrada de dominio.
//
// `dispatchWebhookEvent` es lo ÚNICO que llama el resto del producto
// cuando pasa algo que un cliente pueda querer saber. Persiste una
// entrega por endpoint suscrito (`webhook_deliveries`, migración 062)
// y hace el primer intento en caliente; lo que falle lo recoge el
// barrido de `GET /api/webhooks/cron` con la escalera de S-A6.
//
// Semántica (documentada en docs/public-api.md):
//   - **Al menos una vez** por endpoint. El sobre lleva `id`; el
//     receptor deduplica por ahí.
//   - Cinco reintentos (1 min, 5 min, 30 min, 2 h, 12 h) y después
//     `dead`. Cada fallo suma al contador consecutivo del endpoint, que
//     se autodesactiva a los 15 (migración 028); un éxito lo reinicia.
//   - Es mejor esfuerzo y NUNCA lanza: quien la llama suele estar en el
//     `after()` del webhook de Meta, donde un fallo de entrega no puede
//     tocar el 200 que Meta espera (CP11).
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { WebhookEvent } from '@/lib/webhooks/events';
import {
  claimAndAttempt,
  enqueueWebhookDeliveries,
} from '@/lib/webhooks/queue';

export {
  DELIVERY_TIMEOUT_MS,
  MAX_CONSECUTIVE_FAILURES,
  MAX_ATTEMPTS,
  RETRY_BACKOFF_MS,
} from '@/lib/webhooks/queue';

/**
 * Encola `event` (+ `data`) para cada endpoint activo de `accountId`
 * suscrito, e intenta cada entrega una vez. Nunca lanza.
 */
export async function dispatchWebhookEvent(
  db: SupabaseClient,
  accountId: string,
  event: WebhookEvent,
  data: unknown
): Promise<void> {
  try {
    const rows = await enqueueWebhookDeliveries(db, accountId, event, data);
    if (rows.length === 0) return;

    // El primer intento va en paralelo y aislado: un receptor lento no
    // retrasa al de al lado y un fallo no impide encolar el resto.
    await Promise.allSettled(rows.map((row) => claimAndAttempt(db, row)));
  } catch (err) {
    // Nunca dejar que un problema de entrega suba al llamador.
    console.error('[webhooks] dispatch failed:', err);
  }
}
