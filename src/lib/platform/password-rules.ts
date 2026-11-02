/** Shortest and longest password an operator may set by hand. The
 *  ceiling is bcrypt's: past 72 bytes the rest is silently ignored.
 *  Its own file so the panel (client) and the route (server) share one
 *  number without the client importing the service-role helpers. */
export const OPERATOR_MIN_PASSWORD_LENGTH = 8;
export const OPERATOR_MAX_PASSWORD_LENGTH = 72;

const ALPHABET = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** A random password without look-alike characters (0/O, 1/l/I). */
export function generatePassword(length = 14): string {
  const bytes = new Uint32Array(length);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}
