// ============================================================
// POST /api/v1/contacts/{id}/tags — attach tags BY ID (scope: tags:write)
//
// The by-name door already exists: `PATCH /api/v1/contacts/{id}` with
// `{"tags": ["vip"]}` REPLACES the whole set, creating missing names as
// it goes. It stays exactly as it was. This one is the other half an
// integration needs: add one or more tags it already knows the id of,
// without having to send (and therefore without risking clearing) the
// tags it does not know about.
//
// The write goes through `addContactTagAndDispatch`, the same function
// the dashboard's own tag button calls. That is where the tag_added
// automation trigger fires and where the `contact.tag_added` webhook is
// emitted, so a tag added over the API is indistinguishable from one an
// agent added by hand — including the duplicate rule: re-attaching a tag
// the contact already has is a no-op, not a second event.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { withIdempotency } from '@/lib/api/v1/idempotency';
import { getContactById } from '@/lib/api/v1/contacts';
import { addContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { ContactTagWriteError } from '@/lib/contacts/tag-write';

/**
 * Bound on one call. Each id is a separate ownership check + insert +
 * automation dispatch, so an unbounded array would be an unbounded
 * handler. Callers with more send another page.
 */
export const MAX_TAG_IDS_PER_CALL = 50;

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id: contactId } = await params;

    // Fase 7 §1: the body comes through the idempotency helper, which
    // calls `readJsonBody` — Content-Type (415), the 1 MiB ceiling (413)
    // and "must be a JSON object" (400) in one place. Never
    // `request.json()`.
    return await withIdempotency(ctx, request, async (body) => {
      if (!Array.isArray(body.tag_ids)) {
        return fail('bad_request', "'tag_ids' must be an array", 400);
      }
      if (!body.tag_ids.every((t) => typeof t === 'string' && t.trim())) {
        return fail(
          'bad_request',
          "'tag_ids' must contain non-empty strings",
          400
        );
      }
      const tagIds = [
        ...new Set((body.tag_ids as string[]).map((t) => t.trim())),
      ];
      if (tagIds.length === 0) {
        return fail('bad_request', "'tag_ids' must not be empty", 400);
      }
      if (tagIds.length > MAX_TAG_IDS_PER_CALL) {
        return fail(
          'bad_request',
          `'tag_ids' accepts at most ${MAX_TAG_IDS_PER_CALL} ids per call`,
          400
        );
      }

      // Resolve the contact under this account FIRST: a contact from
      // another account is a 404 before any tag is touched.
      const contact = await getContactById(
        ctx.supabase,
        ctx.accountId,
        contactId
      );
      if (!contact) return fail('not_found', 'Contact not found', 404);

      for (const tagId of tagIds) {
        await addContactTagAndDispatch({
          db: ctx.supabase,
          accountId: ctx.accountId,
          contactId,
          tagId,
        });
      }

      const updated = await getContactById(
        ctx.supabase,
        ctx.accountId,
        contactId
      );
      return ok(updated);
    });
  } catch (err) {
    if (err instanceof ContactTagWriteError) {
      // 404 for a tag (or contact) outside the account — the message
      // already says which, and neither reveals another account's row.
      return fail(
        err.status === 404 ? 'not_found' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
