/**
 * Cómo se enseña un contacto cuando puede no tener teléfono.
 *
 * Desde la migración 060 `contacts.phone` es NULL-able: un cliente que
 * escribe con nombre de usuario llega sin teléfono y solo trae su BSUID
 * (y, si lo tiene publicado, su `wa_username`). Toda la interfaz que
 * antes pintaba `contact.phone` a pelo tiene que decidir qué poner en
 * ese hueco, y la decisión es una sola para no tener tres criterios
 * distintos en bandeja, contactos y difusiones.
 *
 * Orden: **teléfono → @usuario → nada**. El BSUID no se enseña nunca:
 * es un identificador opaco de 130 caracteres que no le dice nada a
 * nadie, y enseñarlo en la lista sería ruido.
 */

export interface ContactIdentity {
  name?: string | null;
  phone?: string | null;
  wa_username?: string | null;
}

/**
 * El identificador visible del contacto, o null si no tiene ninguno
 * que enseñar. Quien lo pinta decide el texto del hueco vacío (la clave
 * `noPhone` de los catálogos, «Sin número»), porque este módulo no
 * traduce.
 */
export function contactHandle(contact: ContactIdentity | null | undefined) {
  const phone = contact?.phone?.trim();
  if (phone) return phone;
  const username = contact?.wa_username?.trim();
  if (username) return `@${username}`;
  return null;
}

/**
 * El nombre con el que se encabeza una conversación o una ficha:
 * el nombre guardado, si no el identificador visible, si no lo que
 * pase el llamante (normalmente un «Desconocido» traducido).
 */
export function contactDisplayName(
  contact: ContactIdentity | null | undefined,
  fallback: string
): string {
  const name = contact?.name?.trim();
  if (name) return name;
  return contactHandle(contact) ?? fallback;
}

/**
 * ¿Encaja este contacto con lo que se ha tecleado en el buscador?
 * Complementa a la consulta del servidor en las listas que filtran en
 * el cliente (la bandeja). El arroba es opcional al escribir.
 */
export function contactMatchesSearch(
  contact: ContactIdentity | null | undefined,
  term: string
): boolean {
  const needle = term.trim().toLowerCase();
  if (!needle) return true;
  const bare = needle.replace(/^@+/, '');
  const name = contact?.name?.toLowerCase() ?? '';
  const phone = contact?.phone?.toLowerCase() ?? '';
  const username = contact?.wa_username?.toLowerCase() ?? '';
  return (
    name.includes(needle) ||
    phone.includes(needle) ||
    (username !== '' && bare !== '' && username.includes(bare))
  );
}
