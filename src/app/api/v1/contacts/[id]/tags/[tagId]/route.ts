// ============================================================
// DELETE /api/v1/contacts/{id}/tags/{tagId} — detach one tag
// (scope: tags:write)
//
// Idempotent, as a DELETE should be: detaching a tag the contact does
// not carry is a `200` with the contact unchanged, not a 404 — the
// caller asked for a state ("this contact does not have this tag") and
// that state holds. What it is NOT is an event: `contact.tag_removed`
// only fires when a join row actually went away (see
// `src/lib/contacts/tag-events.ts`).
//
// A contact or a tag from another account is a 404, from the ownership
// check inside `removeContactTag`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import { getContactById } from '@/lib/api/v1/contacts';
import { removeContactTagAndDispatch } from '@/lib/contacts/tag-events';
import { ContactTagWriteError } from '@/lib/contacts/tag-write';

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string; tagId: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'tags:write');
    const { id: contactId, tagId } = await params;

    // No body to read: both ids ride in the path, so there is nothing
    // for `readJsonBody` to guard here.
    await removeContactTagAndDispatch({
      db: ctx.supabase,
      accountId: ctx.accountId,
      contactId,
      tagId,
    });

    const contact = await getContactById(
      ctx.supabase,
      ctx.accountId,
      contactId
    );
    if (!contact) return fail('not_found', 'Contact not found', 404);
    return ok(contact);
  } catch (err) {
    if (err instanceof ContactTagWriteError) {
      return fail(
        err.status === 404 ? 'not_found' : 'internal',
        err.message,
        err.status
      );
    }
    return toApiErrorResponse(err);
  }
}
