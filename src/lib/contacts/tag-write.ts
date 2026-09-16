import type { SupabaseClient } from '@supabase/supabase-js';

export class ContactTagWriteError extends Error {
  readonly status: number;

  constructor(message: string, status = 500) {
    super(message);
    this.name = 'ContactTagWriteError';
    this.status = status;
  }
}

interface ContactTagWriteInput {
  accountId: string;
  contactId: string;
  tagId: string;
}

async function assertContactAndTagOwnership(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<void> {
  const [contactResult, tagResult] = await Promise.all([
    db
      .from('contacts')
      .select('id')
      .eq('id', input.contactId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
    db
      .from('tags')
      .select('id')
      .eq('id', input.tagId)
      .eq('account_id', input.accountId)
      .maybeSingle(),
  ]);

  if (contactResult.error || tagResult.error) {
    throw new ContactTagWriteError('Could not verify contact tag ownership');
  }
  if (!contactResult.data) {
    throw new ContactTagWriteError('Contact not found', 404);
  }
  if (!tagResult.data) {
    throw new ContactTagWriteError('Tag not found', 404);
  }
}

/**
 * Add a tag exactly once. The unique constraint on
 * (contact_id, tag_id) is the concurrency-safe source of truth: a
 * duplicate insert is a no-op and must not emit a tag_added event.
 */
export async function addContactTagIfAbsent(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const { error } = await db
    .from('contact_tags')
    .insert({ contact_id: input.contactId, tag_id: input.tagId })
    .select('id')
    .maybeSingle();

  if (error?.code === '23505') return false;
  if (error) {
    throw new ContactTagWriteError(
      `Failed to add contact tag: ${error.message}`
    );
  }
  return true;
}

/**
 * Remove a tag from a contact. Returns **true only when a join row was
 * actually deleted** — the mirror of {@link addContactTagIfAbsent},
 * which returns true only for a join row actually inserted.
 *
 * That return value is not decoration: `contact.tag_removed` hangs off
 * it. A DELETE for a tag the contact never carried matches zero rows
 * and must not announce a removal that did not happen, exactly as a
 * duplicate insert must not announce an addition that did not happen.
 * `.select('id')` is what makes the difference visible — without it
 * PostgREST returns no rows and a deletion of nothing looks identical
 * to a deletion of something.
 */
export async function removeContactTag(
  db: SupabaseClient,
  input: ContactTagWriteInput
): Promise<boolean> {
  await assertContactAndTagOwnership(db, input);

  const { data, error } = await db
    .from('contact_tags')
    .delete()
    .eq('contact_id', input.contactId)
    .eq('tag_id', input.tagId)
    .select('id');

  if (error) {
    throw new ContactTagWriteError(
      `Failed to remove contact tag: ${error.message}`
    );
  }

  return Array.isArray(data) && data.length > 0;
}
