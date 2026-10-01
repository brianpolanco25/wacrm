// ============================================================
// Proveedor de correo (p11.7). El repo no tenía ninguno: los correos de
// invitación y recuperación los manda Supabase Auth, que no sirve para
// correos arbitrarios. Esto es lo mínimo para los avisos de facturación:
//
//   - por defecto NO hay proveedor (`resolveEmailProvider` → null): el
//     cron responde `emails.enabled = false` y solo quedan los banners;
//   - `EMAIL_PROVIDER=console` escribe una línea por correo en el log
//     (desarrollo), sin direcciones;
//   - con `EMAIL_API_URL`, `EMAIL_API_KEY` y `EMAIL_FROM`, un POST JSON
//     `{ from, to, subject, text }` con `Authorization: Bearer` (supuesto
//     S-B1 de `specs/billing-emails/design.md`). `fetch` nativo, sin
//     dependencias (CP5). Si el proveedor real habla otro formato, solo
//     cambia `createHttpEmailProvider`.
//
// `send` nunca lanza: devuelve `{ ok: false, error }`, y `error` lleva
// solo el código HTTP o el nombre del error. Nunca la clave, el cuerpo
// ni las direcciones (R6).
// ============================================================

export interface EmailMessage {
  to: string[];
  subject: string;
  text: string;
  /** Qué aviso es; solo para el log del proveedor de consola. */
  kind: string;
}

export type EmailSendResult = { ok: true } | { ok: false; error: string };

export interface EmailProvider {
  readonly name: 'http' | 'console';
  /** Nunca lanza. */
  send(message: EmailMessage): Promise<EmailSendResult>;
}

export type EmailProviderResolution =
  | { provider: EmailProvider; reason: null }
  | { provider: null; reason: 'not_configured' | 'misconfigured' };

export const EMAIL_SEND_TIMEOUT_MS = 10_000;

/** Tope de `last_error` y de la línea de log de un fallo (R6). */
export const EMAIL_ERROR_MAX_LENGTH = 300;

export function sanitizeEmailError(raw: string): string {
  return raw.slice(0, EMAIL_ERROR_MAX_LENGTH);
}

/**
 * `https:` siempre; `http:` solo hacia `localhost` o `127.0.0.1`, para un
 * relé en la misma máquina. Cualquier otra cosa, no.
 */
function isAllowedUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return (
    url.protocol === 'http:' &&
    (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
  );
}

export function createHttpEmailProvider(
  cfg: { url: string; apiKey: string; from: string },
  fetchImpl: typeof fetch = (...args) => fetch(...args)
): EmailProvider {
  return {
    name: 'http',
    async send(message) {
      if (!isAllowedUrl(cfg.url)) {
        return { ok: false, error: 'invalid EMAIL_API_URL' };
      }
      try {
        const res = await fetchImpl(cfg.url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${cfg.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: cfg.from,
            to: message.to,
            subject: message.subject,
            text: message.text,
          }),
          signal: AbortSignal.timeout(EMAIL_SEND_TIMEOUT_MS),
        });
        // El cuerpo no se lee: podría repetir direcciones o el texto.
        // Se descarta para liberar la conexión.
        try {
          await res.body?.cancel();
        } catch {
          // Da igual: la respuesta ya está decidida por el código.
        }
        if (res.ok) return { ok: true };
        return { ok: false, error: sanitizeEmailError(`HTTP ${res.status}`) };
      } catch (err) {
        const name =
          err && typeof err === 'object' && 'name' in err
            ? String((err as { name: unknown }).name)
            : 'Error';
        return { ok: false, error: sanitizeEmailError(name || 'Error') };
      }
    },
  };
}

export const consoleEmailProvider: EmailProvider = {
  name: 'console',
  async send(message) {
    console.info(
      `[email:console] ${message.kind} to ${message.to.length} recipient(s): ${message.subject}`
    );
    return { ok: true };
  },
};

function present(value: string | undefined): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/**
 * R4. Lee el entorno al llamarla, no al importar (así `vi.stubEnv`
 * funciona). Las tres variables HTTP mandan sobre `EMAIL_PROVIDER`.
 */
export function resolveEmailProvider(
  env: Record<string, string | undefined> = process.env
): EmailProviderResolution {
  const url = env.EMAIL_API_URL;
  const apiKey = env.EMAIL_API_KEY;
  const from = env.EMAIL_FROM;
  if (present(url) && present(apiKey) && present(from)) {
    return {
      provider: createHttpEmailProvider({
        url: url.trim(),
        apiKey: apiKey.trim(),
        from: from.trim(),
      }),
      reason: null,
    };
  }
  if (env.EMAIL_PROVIDER === 'console') {
    return { provider: consoleEmailProvider, reason: null };
  }
  const partial = present(url) || present(apiKey) || present(from);
  return {
    provider: null,
    reason: partial ? 'misconfigured' : 'not_configured',
  };
}
