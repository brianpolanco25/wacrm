// ============================================================
// GET /api/v1/conversations — list conversations (scope: conversations:read)
//
// Keyset-paginated. By default newest-created first. Filters: `?status=`
// (open/pending/closed), `?contact_id=`, `?assigned_agent_id=` (a user id
// or `none` for unassigned), `?unread=true` and `?search=` (contact name
// or phone). `?sort=last_activity` orders by `(last_message_at desc,
// id desc)` — the order of a chat inbox — with its own opaque cursor
// (don't mix cursors between sorts). Each conversation embeds its contact
// + tags via the shared CONVERSATION_SELECT and reports the 24 h service
// window (`service_window_expires_at`) and the AI state.
//
// Tenancy: the key's client is service-role, so every query here —
// including the contact lookup behind `search` — filters by account_id.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import {
  parseActivityListParams,
  activityKeysetFilter,
  buildActivityPage,
} from '@/lib/api/v1/pagination-activity';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import {
  loadAccountAiOn,
  serializeConversation,
} from '@/lib/api/v1/conversations';
import type { Conversation } from '@/types';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Same rule as GET /contacts: strip what could break the `.or()` grammar.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-_]/gu, '').trim();
}

/** Cap on the contacts a `search` may match (keeps the `in` list sane). */
const SEARCH_CONTACT_CAP = 500;

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const url = new URL(request.url);
    const status = url.searchParams.get('status');
    const contactId = url.searchParams.get('contact_id');
    const sort = url.searchParams.get('sort');
    const assigned = url.searchParams.get('assigned_agent_id');
    const unread = url.searchParams.get('unread');
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');

    if (sort !== null && sort !== 'created_at' && sort !== 'last_activity') {
      return fail(
        'bad_request',
        "'sort' must be 'created_at' or 'last_activity'",
        400
      );
    }
    if (assigned !== null && assigned !== 'none' && !UUID_RE.test(assigned)) {
      return fail(
        'bad_request',
        "'assigned_agent_id' must be a user id or 'none'",
        400
      );
    }
    if (unread !== null && unread !== 'true' && unread !== 'false') {
      return fail('bad_request', "'unread' must be 'true' or 'false'", 400);
    }
    const byActivity = sort === 'last_activity';

    let query = ctx.supabase
      .from('conversations')
      .select(CONVERSATION_SELECT)
      .eq('account_id', ctx.accountId);

    if (status) query = query.eq('status', status);
    if (contactId) query = query.eq('contact_id', contactId);
    if (assigned === 'none') query = query.is('assigned_agent_id', null);
    else if (assigned) query = query.eq('assigned_agent_id', assigned);
    if (unread === 'true') query = query.gt('unread_count', 0);

    if (search) {
      const { data: found, error: searchError } = await ctx.supabase
        .from('contacts')
        .select('id')
        .eq('account_id', ctx.accountId)
        .or(`name.ilike.*${search}*,phone.ilike.*${search}*`)
        .limit(SEARCH_CONTACT_CAP);
      if (searchError) {
        console.error('[api/v1/conversations] search error:', searchError);
        return fail('internal', 'Failed to list conversations', 500);
      }
      const ids = ((found ?? []) as Array<{ id: string }>).map((c) => c.id);
      if (ids.length === 0) return okList([], null);
      query = query.in('contact_id', ids);
    }

    let page: (rows: unknown[]) => {
      items: unknown[];
      nextCursor: string | null;
    };

    if (byActivity) {
      const { limit, cursor } = parseActivityListParams(request);
      query = query
        .order('last_message_at', { ascending: false, nullsFirst: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const kf = activityKeysetFilter(cursor);
      if (kf) query = query.or(kf);
      page = (rows) =>
        buildActivityPage(
          rows as Array<{ last_message_at: string | null; id: string }>,
          limit
        );
    } else {
      const { limit, cursor } = parseListParams(request);
      query = query
        .order('created_at', { ascending: false })
        .order('id', { ascending: false })
        .limit(limit + 1);
      const kf = keysetFilter(cursor);
      if (kf) query = query.or(kf);
      page = (rows) =>
        buildPage(rows as Array<{ created_at: string; id: string }>, limit);
    }

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/conversations] list error:', error);
      return fail('internal', 'Failed to list conversations', 500);
    }

    const { items, nextCursor } = page(data ?? []);
    const accountAiOn = await loadAccountAiOn(ctx.supabase, ctx.accountId);
    return okList(
      items.map((r) =>
        serializeConversation(normalizeConversation(r as Conversation), {
          accountAiOn,
        })
      ),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
