// ============================================================
// GET    /api/v1/tags/{id} — read one    (scope: tags:read)
// PATCH  /api/v1/tags/{id} — rename / recolour (scope: tags:write)
// DELETE /api/v1/tags/{id} — delete it   (scope: tags:write)
//
// All account-scoped: a tag belonging to another account is a 404,
// never a 403 — the answer must not reveal that the id exists
// somewhere else (CP3).
//
// DELETE also detaches the tag from every contact that carried it.
// That is the foreign key doing it, not a second query: `contact_tags.
// tag_id REFERENCES tags(id) ON DELETE CASCADE` (migration 001), which
// is what the dashboard's own tag manager has always relied on. Doing
// it in one statement is also the only way it can be atomic — an
// explicit pre-delete of the joins would leave them gone if the tag
// delete then failed. The cascade is asserted against a real Postgres
// in `progress/checks_tags-v1.sql`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { readJsonBody } from '@/lib/api/v1/body';
import {
  TAG_COLUMNS,
  MAX_TAG_NAME_LENGTH,
  serializeTag,
  getTagById,
  findTagByName,
  normalizeTagName,
  normalizeTagColor,
  TagError,
} from '@/lib/api/v1/tags';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'tags:read');
    const { id } = await params;
    const tag = await getTagById(ctx.supabase, ctx.accountId, id);
    if (!tag) return fail('not_found', 'Tag not found', 404);
    return ok(tag);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id } = await params;

    // Fase 7 §1: every /api/v1 write reads its body through
    // `readJsonBody` — Content-Type (415), 1 MiB ceiling (413) and
    // "must be a JSON object" (400) in one place. Never `request.json()`.
    const { data: body } = await readJsonBody(request);

    const updates: Record<string, unknown> = {};

    if ('name' in body) {
      const name = normalizeTagName(body.name);
      if (!name) {
        return fail(
          'bad_request',
          `'name' must be a non-empty string of at most ${MAX_TAG_NAME_LENGTH} characters`,
          400
        );
      }
      // Renaming onto a name the account already uses would create the
      // duplicate that find-or-create exists to prevent: two rows the
      // CSV import and `tags:[…]` would then have to choose between.
      // Renaming a tag to a different casing of ITS OWN name is fine.
      const clash = await findTagByName(ctx.supabase, ctx.accountId, name);
      if (clash && clash.id !== id) {
        return fail('conflict', `A tag named '${name}' already exists`, 409);
      }
      updates.name = name;
    }

    if ('color' in body) {
      const color = normalizeTagColor(body.color);
      if (!color) {
        return fail(
          'bad_request',
          "'color' must be a hex colour such as '#3b82f6'",
          400
        );
      }
      updates.color = color;
    }

    if (Object.keys(updates).length === 0) {
      return fail('bad_request', 'No updatable fields provided', 400);
    }

    // Scoped by account_id so a foreign id touches nothing; the returned
    // row (null when unmatched) is what drives the 404.
    const { data, error } = await ctx.supabase
      .from('tags')
      .update(updates)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(TAG_COLUMNS)
      .maybeSingle();

    if (error) {
      console.error('[api/v1/tags] update error:', error);
      return fail('internal', 'Failed to update tag', 500);
    }
    if (!data) return fail('not_found', 'Tag not found', 404);

    return ok(serializeTag(data as Record<string, unknown>));
  } catch (err) {
    if (err instanceof TagError) {
      return fail(
        err.status === 400 ? 'bad_request' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id } = await params;

    const { data, error } = await ctx.supabase
      .from('tags')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle();

    if (error) {
      console.error('[api/v1/tags] delete error:', error);
      return fail('internal', 'Failed to delete tag', 500);
    }
    if (!data) return fail('not_found', 'Tag not found', 404);

    return ok({ id: data.id, deleted: true });
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
