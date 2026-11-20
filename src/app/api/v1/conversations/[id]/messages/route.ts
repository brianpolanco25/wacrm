// ============================================================
// GET /api/v1/conversations/{id}/messages — list a conversation's
// messages (scope: messages:read), newest first, keyset-paginated.
//
// The conversation is verified to belong to the key's account before
// any message is returned — a foreign or unknown id → 404.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { serializeMessagesWithMedia } from '@/lib/api/v1/conversations';
import type { Message } from '@/types';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'messages:read');
    const { id } = await params;
    const { limit, cursor } = parseListParams(request);

    let query = ctx.supabase
      .from('messages')
      .select('*')
      .eq('conversation_id', id)
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    // Ownership gate and page in parallel (n15.6): the page is only
    // returned once the conversation is proven to be this account's.
    const [{ data: conv }, { data, error }] = await Promise.all([
      ctx.supabase
        .from('conversations')
        .select('id')
        .eq('id', id)
        .eq('account_id', ctx.accountId)
        .maybeSingle(),
      query,
    ]);
    if (!conv) return fail('not_found', 'Conversation not found', 404);
    if (error) {
      console.error('[api/v1/messages] list error:', error);
      return fail('internal', 'Failed to list messages', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      await serializeMessagesWithMedia(
        ctx.supabase,
        ctx.accountId,
        items as unknown as Message[]
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
