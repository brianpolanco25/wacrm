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
// empresa no sumen el doble. Se cobra DESPUÉS de resolver la
// conversación —como en el POST—, para que una ristra de 404 no queme
// el cupo de la hora.
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

    // El cubo se cobra DESPUÉS de resolver la conversación, igual que en
    // `POST /api/v1/exports`: diez 404 seguidos (un id copiado mal, un
    // chat ya borrado) no deben dejar a la cuenta sin exportaciones esa
    // hora. Lo que se raciona es el trabajo caro, y el trabajo caro
    // empieza aquí.
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

    // El nombre viaja entrecomillado dentro de `Content-Disposition`: un
    // id con comillas, punto y coma o un salto de línea partiría la
    // cabecera. Se usa el id que devolvió la base (un uuid) y aun así se
    // filtra a `[A-Za-z0-9-]`, para que la cabecera siga siendo segura el
    // día que esta ruta acepte otro identificador.
    const safeId = String((conv as Conversation).id).replace(
      /[^A-Za-z0-9-]/g,
      ''
    );
    const filename = `conversation-${safeId}.${exportExtension(requested)}`;
    const { headers } = v1Headers({
      'Content-Type': exportContentType(requested),
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    return new Response(renderExport(doc, requested), { status: 200, headers });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
