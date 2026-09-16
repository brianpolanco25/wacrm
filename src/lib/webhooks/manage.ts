// ============================================================
// Operaciones de gestión de un endpoint de webhook, compartidas por la
// API pública (`/api/v1/webhooks/**`, clave de API) y por el panel
// (`/api/account/webhooks/**`, sesión de cookie).
//
// Las dos superficies hacen LO MISMO con permisos distintos, así que la
// lógica vive aquí una sola vez y cada ruta pone su autenticación
// delante. Todas las funciones reciben `accountId` y lo aplican a cada
// consulta: el cliente que les llega es de rol de servicio (la cola
// solo tiene política de lectura), así que la RLS no protege nada aquí
// y el filtro explícito es lo único que separa dos empresas.
//
// Convención de resultados: `null` / `'not_found'` significa «no existe
// EN ESTA CUENTA», y la ruta lo traduce a 404 — nunca a 403, que
// confirmaría la existencia del recurso ajeno.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { encrypt } from '@/lib/whatsapp/encryption';
import { buildPage, keysetFilter, type Cursor } from '@/lib/api/v1/pagination';
import {
  DELIVERY_PUBLIC_COLUMNS,
  attemptDelivery,
  claimDelivery,
  enqueueSingleDelivery,
  type DeliveryRow,
  type DeliveryStatus,
} from '@/lib/webhooks/queue';
import {
  WEBHOOK_PUBLIC_COLUMNS,
  generateWebhookSecret,
  serializeWebhookEndpoint,
  type ApiWebhookEndpoint,
} from '@/lib/webhooks/endpoints';

/**
 * Cubo propio para las operaciones caras de webhooks (probar un
 * endpoint, reintentar a mano, rotar el secreto): cada una dispara una
 * petición saliente o regenera una credencial.
 *
 * Vive aquí y no en `RATE_LIMITS` para no chocar con la rama que está
 * tocando `src/lib/rate-limit.ts` en paralelo; queda anotado en el
 * informe como pendiente de centralizar.
 */
export const WEBHOOK_ACTION_RATE_LIMIT = { limit: 20, windowMs: 60_000 };

/** Estados que acepta el filtro `?status=` de la lista de entregas. */
export const DELIVERY_STATUSES: DeliveryStatus[] = [
  'pending',
  'delivered',
  'failed',
  'dead',
];

export interface ApiWebhookDelivery {
  id: string;
  endpoint_id: string;
  event: string;
  attempt: number;
  status: DeliveryStatus;
  next_attempt_at: string | null;
  last_status_code: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

/**
 * Proyecta una fila de la cola a la forma pública. `payload` NO sale:
 * puede contener el texto del mensaje de un cliente final y la lista
 * de entregas es visible para cualquier miembro de la cuenta.
 */
export function serializeDelivery(
  row: Record<string, unknown>
): ApiWebhookDelivery {
  return {
    id: row.id as string,
    endpoint_id: row.endpoint_id as string,
    event: row.event as string,
    attempt: (row.attempt as number | null) ?? 0,
    status: row.status as DeliveryStatus,
    next_attempt_at: (row.next_attempt_at as string | null) ?? null,
    last_status_code: (row.last_status_code as number | null) ?? null,
    last_error: (row.last_error as string | null) ?? null,
    created_at: row.created_at as string,
    delivered_at: (row.delivered_at as string | null) ?? null,
  };
}

/** `true` si el endpoint existe Y es de esta cuenta. */
export async function endpointBelongsToAccount(
  db: SupabaseClient,
  accountId: string,
  endpointId: string
): Promise<boolean> {
  const { data, error } = await db
    .from('webhook_endpoints')
    .select('id')
    .eq('id', endpointId)
    .eq('account_id', accountId)
    .maybeSingle();
  return !error && !!data;
}

export interface DeliveryPage {
  items: ApiWebhookDelivery[];
  nextCursor: string | null;
}

/**
 * Últimas entregas de un endpoint, paginadas igual que el resto de
 * `/api/v1` (keyset sobre `created_at, id`). `null` si el endpoint no
 * es de esta cuenta.
 */
export async function listDeliveries(
  db: SupabaseClient,
  accountId: string,
  endpointId: string,
  opts: { limit: number; cursor: Cursor | null; status?: string | null }
): Promise<DeliveryPage | null> {
  if (!(await endpointBelongsToAccount(db, accountId, endpointId))) return null;

  let query = db
    .from('webhook_deliveries')
    .select(DELIVERY_PUBLIC_COLUMNS)
    // Doble acotación a propósito: por endpoint (que ya verificamos) y
    // por cuenta, para que el filtro sobreviva a un futuro cambio de
    // la comprobación de arriba.
    .eq('endpoint_id', endpointId)
    .eq('account_id', accountId)
    .order('created_at', { ascending: false })
    .order('id', { ascending: false })
    .limit(opts.limit + 1);

  if (opts.status) query = query.eq('status', opts.status);

  const filter = keysetFilter(opts.cursor);
  if (filter) query = query.or(filter);

  const { data, error } = await query;
  if (error) {
    console.error('[webhooks] delivery list failed:', error);
    return { items: [], nextCursor: null };
  }

  const { items, nextCursor } = buildPage(
    (data ?? []) as unknown as { created_at: string; id: string }[],
    opts.limit
  );
  return {
    items: items.map((r) => serializeDelivery(r as Record<string, unknown>)),
    nextCursor,
  };
}

export type RetryOutcome =
  | { kind: 'not_found' }
  | { kind: 'already_queued'; delivery: ApiWebhookDelivery }
  | { kind: 'attempted'; status: DeliveryStatus; delivery: ApiWebhookDelivery };

/**
 * Reintenta una entrega AHORA. Una entrega `pending` ya está en la cola
 * y no se toca (reintentarla a mano sería entregarla dos veces); una
 * `failed`, `dead` o `delivered` se reencola desde el principio de la
 * escalera y se intenta en el acto.
 */
export async function retryDelivery(
  db: SupabaseClient,
  accountId: string,
  endpointId: string,
  deliveryId: string
): Promise<RetryOutcome> {
  const { data, error } = await db
    .from('webhook_deliveries')
    .select(`${DELIVERY_PUBLIC_COLUMNS}, account_id, payload`)
    .eq('id', deliveryId)
    .eq('endpoint_id', endpointId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (error || !data) return { kind: 'not_found' };
  const row = data as unknown as DeliveryRow;

  if (row.status === 'pending') {
    return {
      kind: 'already_queued',
      delivery: serializeDelivery(data as Record<string, unknown>),
    };
  }

  // Vuelta al primer peldaño: un reintento manual no debe morir al
  // primer fallo solo porque la entrega ya había agotado la escalera.
  const { data: reset, error: resetError } = await db
    .from('webhook_deliveries')
    .update({
      attempt: 0,
      status: 'pending',
      next_attempt_at: new Date().toISOString(),
      delivered_at: null,
    })
    .eq('id', deliveryId)
    .eq('account_id', accountId)
    .select(`${DELIVERY_PUBLIC_COLUMNS}, account_id, payload`)
    .maybeSingle();

  if (resetError || !reset) return { kind: 'not_found' };

  const claimed = await claimDelivery(db, {
    id: deliveryId,
    attempt: 0,
    account_id: accountId,
  });
  if (!claimed) {
    return {
      kind: 'already_queued',
      delivery: serializeDelivery(reset as Record<string, unknown>),
    };
  }

  const status = await attemptDelivery(db, claimed);
  const { data: after } = await db
    .from('webhook_deliveries')
    .select(DELIVERY_PUBLIC_COLUMNS)
    .eq('id', deliveryId)
    .eq('account_id', accountId)
    .maybeSingle();

  return {
    kind: 'attempted',
    status,
    delivery: serializeDelivery(
      (after ?? reset) as unknown as Record<string, unknown>
    ),
  };
}

export interface TestOutcome {
  status: DeliveryStatus;
  delivery: ApiWebhookDelivery;
}

/**
 * Entrega un `ping` firmado al endpoint, aquí y ahora. `ping` no está
 * en `WEBHOOK_EVENTS` a propósito: no es suscribible, solo se manda
 * cuando alguien pulsa «probar».
 */
export async function sendTestDelivery(
  db: SupabaseClient,
  accountId: string,
  endpointId: string
): Promise<TestOutcome | null> {
  if (!(await endpointBelongsToAccount(db, accountId, endpointId))) return null;

  const row = await enqueueSingleDelivery(db, accountId, endpointId, 'ping', {
    message: 'This is a test delivery from wacrm',
  });
  if (!row) return null;

  const claimed = await claimDelivery(db, {
    id: row.id,
    attempt: row.attempt,
    account_id: accountId,
  });
  const status = claimed ? await attemptDelivery(db, claimed) : 'pending';

  const { data: after } = await db
    .from('webhook_deliveries')
    .select(DELIVERY_PUBLIC_COLUMNS)
    .eq('id', row.id)
    .eq('account_id', accountId)
    .maybeSingle();

  return {
    status,
    delivery: serializeDelivery(
      (after ?? (row as unknown)) as Record<string, unknown>
    ),
  };
}

export interface RotateOutcome {
  endpoint: ApiWebhookEndpoint;
  /** Texto plano. Se enseña UNA vez y no se puede volver a pedir. */
  secret: string;
}

/**
 * Cambia el secreto de firma del endpoint y devuelve el nuevo en claro
 * una sola vez. Las entregas en vuelo firmadas con el anterior fallarán
 * la verificación en el receptor hasta que actualice: es el precio de
 * no tener dos secretos válidos a la vez, y va dicho en la interfaz.
 */
export async function rotateWebhookSecret(
  db: SupabaseClient,
  accountId: string,
  endpointId: string
): Promise<RotateOutcome | null> {
  const secret = generateWebhookSecret();

  const { data, error } = await db
    .from('webhook_endpoints')
    .update({ secret: encrypt(secret) })
    .eq('id', endpointId)
    .eq('account_id', accountId)
    .select(WEBHOOK_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error) {
    console.error('[webhooks] secret rotation failed:', error);
    return null;
  }
  if (!data) return null;

  return {
    endpoint: serializeWebhookEndpoint(data as Record<string, unknown>),
    secret,
  };
}
