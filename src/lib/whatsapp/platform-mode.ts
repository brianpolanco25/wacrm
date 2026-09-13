// ============================================================
// "Is this deployment a platform, or is it self-hosted?" — decided on
// the SERVER, at runtime, from three environment variables (fase 4 §1).
//
// Why not a `NEXT_PUBLIC_*` flag, which would be the obvious way to let
// the browser know: `NEXT_PUBLIC_*` is inlined into the client bundle
// at BUILD time, and `docker-compose.yml` passes those as build args.
// A self-hoster running the published image could not turn the flag on
// without rebuilding it, and a platform operator could not change the
// `config_id` (Meta hands out a new one every time the signup flow is
// reconfigured) without a redeploy. So the flag stays server-side and
// the browser asks for it: `GET /api/whatsapp/embedded-signup`.
//
// `META_APP_SECRET` participates in the DECISION and never in the
// answer: without it the code-for-token exchange cannot happen, so a
// deployment that has the other two is not actually in platform mode.
// It is never returned, logged or sent to the client.
// ============================================================

/**
 * Graph API version used by the code exchange and the JS SDK.
 *
 * Deliberately the same value as `META_API_VERSION` in `meta-api.ts`:
 * one deployment talking to two Graph versions at once is a debugging
 * trap. Meta's Embedded Signup guide recommends `v25.0` in `FB.init`;
 * moving there is a one-line change here *and* in `meta-api.ts` (plus
 * `templates/sync`), and it re-dates every send, media and template
 * call — out of scope for f4.1. An operator who needs it today sets
 * `META_GRAPH_VERSION=v25.0`, which moves the dialog and the exchange
 * without touching the rest. See `docs/docker.md`.
 */
export const DEFAULT_GRAPH_VERSION = 'v21.0';

export interface PlatformSignupConfig {
  /** Our Meta app id. Public by design — it travels in the dialog URL. */
  appId: string;
  /**
   * The Embedded Signup configuration created in the Meta app panel.
   * THE switch: present means platform mode, absent means self-hosted.
   */
  configId: string;
  /** e.g. `v21.0`. Kept in step with META_API_VERSION of meta-api.ts. */
  graphVersion: string;
}

/**
 * Read one variable with the same trimming rule f2.4 applies to
 * `META_WEBHOOK_VERIFY_TOKEN`: these values arrive from a secrets file,
 * a Kubernetes ConfigMap or a hand-edited `.env` line as often as from
 * a shell export, and a trailing newline would otherwise be truthy —
 * platform mode would activate and every Graph call would 400 on an
 * app id with a `\n` in it. Whitespace-only counts as unset.
 */
function readVar(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

/**
 * The platform-mode configuration, or `null` when this deployment is
 * self-hosted (which is the default: three variables have to be
 * deliberately set for the integrated signup to exist at all).
 */
export function getPlatformSignupConfig(): PlatformSignupConfig | null {
  const appId = readVar('META_APP_ID');
  const configId = readVar('META_CONFIG_ID');
  const appSecret = readVar('META_APP_SECRET');
  if (!appId || !configId || !appSecret) return null;

  return {
    appId,
    configId,
    graphVersion: readVar('META_GRAPH_VERSION') ?? DEFAULT_GRAPH_VERSION,
  };
}

/**
 * The app secret, for the one call site allowed to hold it (the code
 * exchange). Separate from `getPlatformSignupConfig` so the object that
 * the GET handler serialises to the browser cannot ever grow it by
 * accident: you have to ask for the secret by name to get it.
 */
export function getMetaAppSecret(): string | null {
  return readVar('META_APP_SECRET');
}

/**
 * True when the deployment is in platform mode but the operator has not
 * set `META_WEBHOOK_VERIFY_TOKEN`.
 *
 * It is not part of `getPlatformSignupConfig` — the two things are
 * independent — but it is close to fatal in combination: with platform
 * mode on, every row is written with `verify_token = NULL`, so the
 * per-tenant loop in the webhook GET has nothing to match and Meta's
 * webhook verification answers 403 forever. The UI surfaces it as a
 * warning for the operator rather than hiding the button.
 */
export function isMissingWebhookVerifyToken(): boolean {
  return !readVar('META_WEBHOOK_VERIFY_TOKEN');
}
