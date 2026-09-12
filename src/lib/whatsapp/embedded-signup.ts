// ============================================================
// The code-for-token exchange of Embedded Signup (fase 4 §1).
//
// Why this is NOT in `meta-api.ts`: every function there takes a named
// -parameter object and NEVER reads `process.env` — that is the module's
// stated contract, and the exchange needs our app's id and secret. So
// it lives here, keeps the named-parameter shape, and the route is the
// one that reads the environment (through `platform-mode.ts`).
//
// Handling rule for this whole file: the `code` and the resulting token
// are credentials. Neither may reach `console.*` — not in a success
// log, not inside an error object. When Meta rejects the exchange we
// propagate `error.message` and nothing else; the caller logs that.
// ============================================================

import { randomInt } from 'node:crypto';

export interface ExchangeCodeArgs {
  /** One-time code from `FB.login`'s `authResponse.code`. */
  code: string;
  /** Our Meta app id (`META_APP_ID`). */
  appId: string;
  /** Our Meta app secret (`META_APP_SECRET`). Never leaves the server. */
  appSecret: string;
  /** Graph version, e.g. `v21.0`. */
  graphVersion: string;
}

export interface ExchangedToken {
  /** The business's access token, in clear. Encrypt before storing. */
  accessToken: string;
  /**
   * ISO timestamp when Meta says the token expires, or `null`.
   *
   * Business-integration tokens minted through Embedded Signup are
   * normally permanent and Meta omits `expires_in` entirely, so `null`
   * is the expected case rather than an error. We store the value when
   * it is there; nothing renews on it yet (out of scope, by decision).
   */
  expiresAt: string | null;
}

interface TokenResponse {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  error?: { message?: string; type?: string; code?: number };
}

/**
 * Trade the one-time code the dialog returned for the business's
 * access token.
 *
 * `GET /{version}/oauth/access_token?client_id&client_secret&code`.
 * There is deliberately no `redirect_uri`: Embedded Signup never
 * redirects the browser anywhere — the code arrives through the JS SDK
 * callback — and sending one makes Meta reject the exchange for a
 * mismatch against a redirect that never happened.
 */
export async function exchangeCodeForToken(
  args: ExchangeCodeArgs
): Promise<ExchangedToken> {
  const { code, appId, appSecret, graphVersion } = args;

  const url = new URL(
    `https://graph.facebook.com/${graphVersion}/oauth/access_token`
  );
  url.searchParams.set('client_id', appId);
  url.searchParams.set('client_secret', appSecret);
  url.searchParams.set('code', code);

  const response = await fetch(url.toString(), { method: 'GET' });

  // Tolerate a non-JSON body: Meta's edge occasionally answers an HTML
  // error page under load, and `response.json()` would throw a parse
  // error that says nothing about what went wrong.
  let data: TokenResponse = {};
  try {
    data = (await response.json()) as TokenResponse;
  } catch {
    /* keep the empty object; the branches below produce the message */
  }

  if (!response.ok) {
    throw new Error(
      data.error?.message ?? `Meta API error: ${response.status}`
    );
  }

  if (!data.access_token) {
    // 200 without a token. Happens when the code was already redeemed
    // (they are single use) or expired between the dialog and here.
    throw new Error(
      'Meta returned no access token for this code. The code is single-use and short-lived — reopen the dialog and try again.'
    );
  }

  const expiresAt =
    typeof data.expires_in === 'number' && data.expires_in > 0
      ? new Date(Date.now() + data.expires_in * 1000).toISOString()
      : null;

  return { accessToken: data.access_token, expiresAt };
}

/**
 * A fresh 6-digit registration PIN.
 *
 * Numbers created through Embedded Signup have no two-step
 * verification, so `POST /{phone_number_id}/register` needs a PIN that
 * WE pick. `crypto.randomInt` rather than `Math.random`: this value
 * ends up being a credential on Meta's side — whoever knows it can
 * re-register the number against another app — and it is stored
 * encrypted for exactly that reason.
 *
 * Zero-padded to six characters: Meta wants six digits, and `1234`
 * would be rejected while `001234` is a perfectly valid PIN.
 */
export function generateRegistrationPin(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, '0');
}
