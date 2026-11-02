import type { SupabaseClient } from '@supabase/supabase-js';
import {
  findContactByWaUserId,
  findExistingContact,
  isUniqueViolation,
} from '@/lib/contacts/dedupe';

/**
 * Resolución del contacto y la conversación de un mensaje que llega por
 * el webhook de WhatsApp. Extraído de `src/app/api/whatsapp/webhook/route.ts`
 * (feature 1651) sin cambiar consultas ni logs, para que los ecos, el
 * historial y la libreta de la coexistencia usen exactamente las mismas
 * reglas de deduplicación que un entrante. El cliente llega como primer
 * parámetro: el webhook y el cron pasan el de rol de servicio, y cada
 * consulta filtra por `account_id` (CP3).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ContactRow = any;

export interface ContactOutcome {
  contact: ContactRow;
  /** True when this call created the row; drives new_contact_created
   *  automation dispatch in processMessage. */
  wasCreated: boolean;
}

/** Lo que el webhook sabe del remitente de un mensaje entrante. */
export interface InboundSender {
  /** Teléfono normalizado (solo dígitos). '' cuando Meta no lo manda. */
  phone: string;
  /** BSUID, o null. Al menos uno de los dos es no vacío. */
  waUserId: string | null;
  /** `profile.username`, sin arroba, o null. */
  username: string | null;
  /** `profile.name`, o null. */
  name: string | null;
}

/**
 * Resolver el contacto de un entrante, con las DOS identidades.
 *
 * El orden importa y es el de la spec (§5):
 *
 *   1. **Por BSUID.** Es lo único que Meta manda siempre, así que es lo
 *      primero que se prueba. Si el contacto ya existe, se le completa
 *      el teléfono cuando por fin llega, y el nombre de usuario cuando
 *      cambia.
 *   2. **Por teléfono.** Cubre a todos los contactos anteriores a este
 *      cambio (y a los creados a mano o por CSV): la primera vez que
 *      uno de ellos escribe con BSUID, se le guarda el BSUID en SU fila
 *      en lugar de abrir una segunda.
 *   3. **Crear.** Con lo que haya: teléfono, BSUID, o ambos.
 *
 * Ninguna de las actualizaciones de los pasos 1 y 2 puede tumbar el
 * mensaje: si el teléfono o el BSUID que intentamos escribir ya son de
 * OTRO contacto de la cuenta, el índice único responde 23505, se
 * registra y se sigue con el contacto que ya teníamos. Un entrante no
 * se pierde por un conflicto de identidades (CP11).
 */
export async function findOrCreateContact(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  sender: InboundSender
): Promise<ContactOutcome | null> {
  const { phone, waUserId, username, name } = sender;

  // ---- 1) por BSUID -------------------------------------------
  if (waUserId) {
    const byUserId = await findContactByWaUserId(db, accountId, waUserId);
    if (byUserId) {
      const patch: Record<string, unknown> = {};
      // El teléfono llegó más tarde (el cliente lo compartió, o volvió
      // a entrar en la ventana de 30 días): se completa, nunca se pisa
      // uno distinto que ya estuviera guardado.
      if (phone && !byUserId.phone) patch.phone = phone;
      if (username && username !== byUserId.wa_username)
        patch.wa_username = username;
      if (name && name !== byUserId.name) patch.name = name;
      await patchContact(db, accountId, byUserId.id, patch);
      return {
        contact: { ...byUserId, ...patch },
        wasCreated: false,
      };
    }
  }

  // ---- 2) por teléfono ----------------------------------------
  // El helper compartido pre-filtra en SQL por los últimos 8 dígitos
  // (para no traerse la agenda entera en cada entrante) y aplica el
  // `phonesMatch` estricto en JS sobre el puñado de candidatos. Lo
  // usan también el alta manual y la importación CSV, así que las tres
  // vías coinciden en qué es «el mismo número» (issue #212).
  const existingContact = phone
    ? await findExistingContact(db, accountId, phone)
    : null;

  if (existingContact) {
    const patch: Record<string, unknown> = {};
    // Primer webhook que trae el BSUID de un contacto de toda la vida:
    // se le guarda en su fila. Esto es lo que impide el duplicado.
    if (waUserId && !existingContact.wa_user_id) patch.wa_user_id = waUserId;
    if (username && username !== existingContact.wa_username)
      patch.wa_username = username;
    if (name && name !== existingContact.name) patch.name = name;
    await patchContact(db, accountId, existingContact.id, patch);
    return {
      contact: { ...existingContact, ...patch },
      wasCreated: false,
    };
  }

  // ---- 3) crear ------------------------------------------------
  // account_id es la columna de tenencia; user_id es la columna de
  // auditoría NOT NULL (ningún entrante tiene un «usuario que lo
  // creó» — se atribuye al dueño de la configuración de WhatsApp).
  // El nombre visible cae a lo que haya: nombre de perfil, teléfono,
  // @usuario y, en último extremo, el BSUID.
  const { data: newContact, error: createError } = await db
    .from('contacts')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      phone: phone || null,
      wa_user_id: waUserId,
      wa_username: username,
      name: name || phone || (username ? `@${username}` : waUserId),
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery (or another path)
    // created this contact between our lookup and insert, and one of
    // the unique indexes (022 por teléfono, 060 por BSUID) rejected the
    // duplicate. Re-resolve the existing row instead of dropping the
    // message.
    if (isUniqueViolation(createError)) {
      const raced = waUserId
        ? await findContactByWaUserId(db, accountId, waUserId)
        : null;
      if (raced) return { contact: raced, wasCreated: false };
      const racedByPhone = phone
        ? await findExistingContact(db, accountId, phone)
        : null;
      if (racedByPhone) return { contact: racedByPhone, wasCreated: false };
    }
    console.error('Error creating contact:', createError);
    return null;
  }

  return { contact: newContact, wasCreated: true };
}

/**
 * Escribir en un contacto lo que el último webhook nos ha enseñado de
 * él. Best-effort por diseño: el índice único de teléfono o el de BSUID
 * pueden rechazar el UPDATE si ese valor ya pertenece a otro contacto
 * de la cuenta (dos filas que resultan ser la misma persona — una
 * fusión que este webhook no va a decidir a las tres de la mañana). Se
 * registra y se sigue: el mensaje se guarda igual.
 *
 * Filtra por `account_id` además de por `id` porque el cliente de rol
 * de servicio no pasa por RLS (CP3).
 */
async function patchContact(
  db: SupabaseClient,
  accountId: string,
  contactId: string,
  patch: Record<string, unknown>
): Promise<void> {
  if (Object.keys(patch).length === 0) return;
  const { error } = await db
    .from('contacts')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', contactId)
    .eq('account_id', accountId);
  if (error) {
    console.error('[webhook] contact update skipped:', error.message ?? error);
  }
}

export async function findOrCreateConversation(
  db: SupabaseClient,
  accountId: string,
  configOwnerUserId: string,
  contactId: string,
  // The number this message came in on (migration 053). Sealed onto
  // the thread so every reply goes back out through it.
  whatsAppConfigId: string
) {
  // Look for an existing conversation in this account, oldest-first.
  //
  // We deliberately do NOT use `.single()` here. `.single()` errors on
  // *both* 0 rows and ≥2 rows, and the old code treated any error as
  // "none found" and inserted a new row. So once two conversations
  // existed for a contact (from a race — Meta retries a delivery, or a
  // batch fans out to concurrent runs), every subsequent inbound
  // message errored on the lookup and created yet another conversation,
  // snowballing into a wall of duplicate chats (issue #363).
  //
  // Ordering oldest-first and taking one row makes the lookup resolve to
  // the same canonical survivor the dedup migration (036) keeps, so any
  // pre-existing duplicates converge instead of compounding.
  const { data: existingRows, error: findError } = await db
    .from('conversations')
    .select('*')
    .eq('account_id', accountId)
    .eq('contact_id', contactId)
    .order('created_at', { ascending: true })
    .limit(1);

  if (findError) {
    console.error('Error finding conversation:', findError);
    return null;
  }

  if (existingRows && existingRows.length > 0) {
    const existing = existingRows[0];
    // Re-seal when the customer wrote to a DIFFERENT number of the same
    // company. Deliberate: the reply has to come from the number they
    // messaged, not from whichever one opened the thread months ago.
    // The (account_id, contact_id) unique index of 036 stays — one
    // contact still has ONE conversation, it just changes which of the
    // company's numbers it runs on.
    if (existing.whatsapp_config_id !== whatsAppConfigId) {
      const { error: sealError } = await db
        .from('conversations')
        .update({ whatsapp_config_id: whatsAppConfigId })
        .eq('id', existing.id)
        .eq('account_id', accountId);
      if (sealError) {
        // Never drop an inbound message over this: the worst case is a
        // reply that leaves through the account default.
        console.error('Error sealing conversation number:', sealError);
      } else {
        existing.whatsapp_config_id = whatsAppConfigId;
      }
    }
    return { conversation: existing, created: false };
  }

  // Create new conversation. Same tenancy + audit split as
  // findOrCreateContact above.
  const { data: newConv, error: createError } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: configOwnerUserId,
      contact_id: contactId,
      whatsapp_config_id: whatsAppConfigId,
    })
    .select()
    .single();

  if (createError) {
    // Lost a race: a concurrent inbound delivery created the
    // conversation between our lookup and insert, and the unique index
    // (migration 036) rejected the duplicate. Re-resolve the winning
    // row instead of dropping the message — mirrors findOrCreateContact.
    if (isUniqueViolation(createError)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('account_id', accountId)
        .eq('contact_id', contactId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (raced && raced.length > 0) {
        return { conversation: raced[0], created: false };
      }
    }
    console.error('Error creating conversation:', createError);
    return null;
  }

  return { conversation: newConv, created: true };
}
