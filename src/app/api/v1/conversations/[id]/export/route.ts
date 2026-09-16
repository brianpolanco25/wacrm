// ============================================================
// GET /api/v1/conversations/{id}/export?format=json|csv — la
// conversación entera con sus mensajes, como descarga
// (scope: conversations:export).
//
// A diferencia del resto de `/api/v1`, la respuesta NO va en el sobre
// `{ data: … }`: el cuerpo es el archivo. Es lo que pide la spec
// («devuelve … como descarga») y lo que hace que
// `curl -OJ` deje un .csv utilizable en el disco. Las cabeceras
// transversales (`Cache-Control: no-store`, `X-Request-Id`) siguen
// estando: se piden a `v1Headers`, que es el único sitio donde se
// escriben. Los ERRORES sí van en el sobre, así que un cliente que
// falla parsea lo de siempre.
//
// El tope de 10 000 mensajes se comprueba con un `count` de cabecera,
// antes de traer una sola fila: si se pasara, esta ruta habría que
// cargar el historial entero en memoria solo para descubrir que no
// cabe. Por encima → 409 apuntando a `POST /api/v1/exports`.
//
// Cubo propio `exports` (10/hora POR CUENTA, S-A7): la operación más
// cara de la API, y va por cuenta para que dos claves de la misma
// empresa no sumen el doble.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { fail, toApiErrorResponse, v1Headers } from '@/lib/api/v1/respond';
import { checkRateLimit, RATE_LIMITS } from '@/lib/rate-limit';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import {
  SYNC_MESSAGE_LIMIT,
  buildSingleConversationDocument,
  countConversationMessages,
  exportContentType,
  exportExtension,
  fetchConversationMessages,
  isExportFormat,
  renderExport,
} from '@/lib/exports/conversations';
import type { Conversation } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:export');
    const { id } = await params;

    const requested = new URL(request.url).searchParams.get('format') ?? 'json';
    if (!isExportFormat(requested)) {
      return fail('bad_request', "'format' must be 'json' or 'csv'", 400);
    }

    const limit = checkRateLimit(
      `exports:${ctx.accountId}`,
      RATE_LIMITS.exports
    );
    if (!limit.success) {
      return fail(
        'rate_limited',
        'Too many exports for this account; try again later',
        429,
        {
          'Retry-After': String(
            Math.max(1, Math.ceil((limit.reset - Date.now()) / 1000))
          ),
        }
      );
    }

    // Propiedad primero: un id de otra cuenta no existe (CP3).
    const { data: conv, error } = await ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/exports] conversation read error:', error);
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!conv) return fail('not_found', 'Conversation not found', 404);

    const total = await countConversationMessages(ctx.supabase, id);
    if (total > SYNC_MESSAGE_LIMIT) {
      return fail(
        'conflict',
        `This conversation has ${total} messages, over the ${SYNC_MESSAGE_LIMIT} ` +
          'limit for a direct download. Use POST /api/v1/exports instead.',
        409
      );
    }

    const messages = await fetchConversationMessages(ctx.supabase, id, {
      max: SYNC_MESSAGE_LIMIT,
    });
    const doc = buildSingleConversationDocument(
      normalizeConversation(conv as Conversation),
      messages
    );

    const filename = `conversation-${id}.${exportExtension(requested)}`;
    const { headers } = v1Headers({
      'Content-Type': exportContentType(requested),
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new Response(renderExport(doc, requested), { status: 200, headers });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
