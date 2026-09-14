/**
 * BSUID — «business-scoped user id» de WhatsApp.
 *
 * Desde abril de 2026 Meta identifica a quien escribe con un id propio
 * del par portafolio-de-negocio/usuario (`contacts[].user_id` y
 * `messages[].from_user_id` en el webhook, `recipient_user_id` en los
 * estados) y OMITE el teléfono cuando el usuario usa nombre de usuario
 * y no hemos hablado con él en 30 días ni está en la libreta del
 * negocio. El BSUID es, por tanto, la única identidad garantizada.
 *
 * Formato documentado: `CC.<hasta 128 alfanuméricos>` — dos letras de
 * país, un punto y el identificador (p. ej. `US.13497…`).
 *
 * Aquí hay DOS validaciones a propósito, y la diferencia importa:
 *
 *   * `sanitizeBsuid` es PERMISIVA y es la que usa todo lo que viene de
 *     Meta (webhook) o sale hacia Meta (envío). Si mañana Meta emite un
 *     prefijo que no encaja en el patrón documentado, un entrante NO se
 *     puede perder por eso (CP11) ni un envío puede quedar bloqueado.
 *     Solo descarta lo que no puede ser un id: vacío, con espacios o
 *     absurdamente largo.
 *   * `isValidBsuid` es ESTRICTA y se usa con lo que teclea un tercero
 *     (`to_user_id` en la API pública): ahí un 400 inmediato y claro
 *     vale más que un error de Meta doscientos milisegundos después.
 */

/** Tope defensivo: 2 + 1 + 128 del formato documentado, con holgura. */
const MAX_BSUID_LENGTH = 160;

/** `CC.<alfanum>` — el formato que documenta Meta. */
export const BSUID_PATTERN = /^[A-Za-z]{2}\.[A-Za-z0-9]{1,128}$/;

/**
 * Normaliza un BSUID que llega de Meta (o que ya está guardado).
 * Devuelve el valor recortado, o null si no puede ser un id.
 * Deliberadamente no comprueba `BSUID_PATTERN`: ver la cabecera.
 */
export function sanitizeBsuid(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (trimmed.length > MAX_BSUID_LENGTH) return null;
  // Un id con espacios en medio no es un id: es otra cosa mal parseada.
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}

/** Comprobación estricta contra el formato documentado por Meta. */
export function isValidBsuid(value: unknown): boolean {
  return typeof value === 'string' && BSUID_PATTERN.test(value.trim());
}

/**
 * Normaliza un nombre de usuario de WhatsApp (`profile.username`).
 * Se guarda SIN arroba: el arroba es decoración de la interfaz, y
 * guardarlo obligaría a recortarlo en cada búsqueda. Tolera que llegue
 * con arroba porque así es como lo escribe un humano en el buscador.
 */
export function sanitizeWaUsername(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/^@+/, '');
  if (!trimmed) return null;
  if (trimmed.length > 128) return null;
  if (/\s/.test(trimmed)) return null;
  return trimmed;
}
