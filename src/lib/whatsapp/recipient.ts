/**
 * ¿A quién se le manda esto?
 *
 * Un contacto puede tener teléfono, BSUID, o los dos (migración 060).
 * Meta acepta `to` (E.164, digits-only) o `recipient` (BSUID) en el
 * cuerpo del envío, y si viajan ambos **gana `to`**. Este módulo es el
 * único sitio donde se decide cuál de las dos identidades se usa, para
 * que el compositor de la bandeja, los flujos, las automatizaciones y
 * las difusiones no puedan discrepar.
 *
 * La regla, en una línea: **teléfono si lo hay y es marcable; BSUID si
 * no**. El teléfono va primero porque es la identidad que sobrevive a
 * todo (sigue funcionando si el usuario quita el nombre de usuario) y
 * porque es la que este producto lleva usando desde el primer día; el
 * BSUID entra cuando Meta no nos ha dado teléfono.
 */

import { sanitizeBsuid } from './bsuid';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
} from './phone-utils';

/** Lo que hace falta de una fila de `contacts` para poder escribirle. */
export interface RecipientContact {
  phone?: string | null;
  wa_user_id?: string | null;
}

/** Los dos campos de destinatario que entiende la API de Meta. */
export interface MetaRecipient {
  /** Teléfono en formato Meta (solo dígitos). Gana si van los dos. */
  to?: string;
  /** BSUID. Lo que Meta llama `recipient`. */
  recipient?: string;
}

export type ResolvedRecipient =
  { kind: 'phone'; phone: string } | { kind: 'user_id'; userId: string };

/** El contacto no es alcanzable: ni teléfono marcable ni BSUID. */
export class RecipientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RecipientError';
  }
}

/**
 * Elige la identidad con la que se va a enviar. Lanza `RecipientError`
 * cuando no hay ninguna utilizable.
 *
 * Un teléfono guardado pero no marcable (no cumple E.164: basura de una
 * importación vieja, un número a medio escribir) NO es motivo para
 * fallar si el contacto tiene BSUID — se cae a él en silencio, que es
 * mejor mensaje entregado que error de formato.
 */
export function resolveRecipient(contact: RecipientContact): ResolvedRecipient {
  const phone = sanitizePhoneForMeta(contact.phone ?? '');
  if (phone && isValidE164(phone)) return { kind: 'phone', phone };

  const userId = sanitizeBsuid(contact.wa_user_id);
  if (userId) return { kind: 'user_id', userId };

  if (phone) {
    throw new RecipientError(`contact phone invalid: ${contact.phone}`);
  }
  throw new RecipientError(
    'contact has neither a valid phone number nor a WhatsApp user id'
  );
}

/**
 * Los intentos de envío, en orden, para un destinatario ya resuelto.
 *
 * Por teléfono son las variantes de prefijo troncal de siempre
 * (`phoneVariants`): Meta rechaza con «recipient not in allowed list»
 * un número registrado con o sin el 0 y hay que probar las dos formas.
 * Por BSUID hay un único intento: el id es exacto, no admite variantes,
 * y reintentar sería repetir la misma llamada.
 */
export function recipientAttempts(
  recipient: ResolvedRecipient
): MetaRecipient[] {
  if (recipient.kind === 'user_id') {
    return [{ recipient: recipient.userId }];
  }
  return phoneVariants(recipient.phone).map((phone) => ({ to: phone }));
}

/** Para logs y mensajes de error, sin exponer el número entero. */
export function describeRecipient(recipient: ResolvedRecipient): string {
  return recipient.kind === 'phone'
    ? recipient.phone
    : `user_id:${recipient.userId}`;
}
