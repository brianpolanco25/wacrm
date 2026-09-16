// ============================================================
// GET  /api/v1/tags — list tags   (scope: tags:read)
// POST /api/v1/tags — create one  (scope: tags:write)
//
// List is keyset-paginated (see src/lib/api/v1/pagination.ts) and
// supports `?search=` on the name. Create is **find-or-create by name**,
// case-insensitively: an existing tag returns 200, a new row returns
// 201. That is the same matching the CSV import and
// `PATCH /api/v1/contacts/{id} {"tags":[…]}` already do, so the three
// paths can never mint two rows for the same word.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, okList, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { withIdempotency } from '@/lib/api/v1/idempotency';
import {
  parseListParams,
  keysetFilter,
  buildPage,
} from '@/lib/api/v1/pagination';
import { resolveAuditUserId, ContactError } from '@/lib/api/v1/contacts';
import {
  TAG_COLUMNS,
  DEFAULT_TAG_COLOR,
  MAX_TAG_NAME_LENGTH,
  serializeTag,
  normalizeTagName,
  normalizeTagColor,
  findOrCreateTag,
  TagError,
} from '@/lib/api/v1/tags';

// Same treatment `GET /api/v1/contacts` gives its `?search=`: strip
// anything that could break the PostgREST pattern grammar before
// interpolating. `%`, `_` and `*` go with it, so a search term can
// never turn into a wildcard the caller did not ask for.
function sanitizeSearch(raw: string): string {
  return raw.replace(/[^\p{L}\p{N} +@.\-]/gu, '').trim();
}

export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const { limit, cursor } = parseListParams(request);
    const url = new URL(request.url);
    const search = sanitizeSearch(url.searchParams.get('search') ?? '');

    let query = ctx.supabase
      .from('tags')
      .select(TAG_COLUMNS)
      .eq('account_id', ctx.accountId);

    if (search) query = query.ilike('name', `*${search}*`);

    query = query
      .order('created_at', { ascending: false })
      .order('id', { ascending: false })
      .limit(limit + 1);

    const kf = keysetFilter(cursor);
    if (kf) query = query.or(kf);

    const { data, error } = await query;
    if (error) {
      console.error('[api/v1/tags] list error:', error);
      return fail('internal', 'Failed to list tags', 500);
    }

    const { items, nextCursor } = buildPage(
      (data ?? []) as unknown as Array<{ created_at: string; id: string }>,
      limit
    );
    return okList(
      items.map((r) => serializeTag(r as Record<string, unknown>)),
      nextCursor
    );
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');

    // Fase 7 §1: the write reads its body through the idempotency
    // helper, which calls `readJsonBody` for us — Content-Type (415),
    // the 1 MiB ceiling (413) and "must be a JSON object" (400) in one
    // place. Without an `Idempotency-Key` header it is a plain read.
    // Never `request.json()`.
    return await withIdempotency(ctx, request, async (body) => {
      const name = normalizeTagName(body.name);
      if (!name) {
        return fail(
          'bad_request',
          `'name' must be a non-empty string of at most ${MAX_TAG_NAME_LENGTH} characters`,
          400
        );
      }

      let color = DEFAULT_TAG_COLOR;
      if ('color' in body && body.color !== undefined && body.color !== null) {
        const parsed = normalizeTagColor(body.color);
        if (!parsed) {
          return fail(
            'bad_request',
            "'color' must be a hex colour such as '#3b82f6'",
            400
          );
        }
        color = parsed;
      }

      const auditUserId = await resolveAuditUserId(ctx.supabase, ctx.accountId);
      const { tag, created } = await findOrCreateTag(
        ctx.supabase,
        ctx.accountId,
        auditUserId,
        name,
        color
      );
      return ok(tag, created ? 201 : 200);
    });
  } catch (err) {
    if (err instanceof TagError || err instanceof ContactError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
