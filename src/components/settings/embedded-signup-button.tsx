'use client';

// ============================================================
// "Connect WhatsApp" — Meta's Embedded Signup dialog (fase 4 §1).
//
// The browser half of the feature. It loads Facebook's JS SDK, opens
// the dialog with the Embedded Signup configuration the SERVER told us
// about, and posts the resulting one-time code to
// `POST /api/whatsapp/embedded-signup`.
//
// Two things are worth knowing before touching this file:
//
//  1. The ids are NOT baked into the bundle. `useEmbeddedSignup()` asks
//     the server on mount (see `src/lib/whatsapp/platform-mode.ts` for
//     why). `enabled === false` means self-hosted: the button — and the
//     four other differences in the settings page — disappear.
//
//  2. The dialog reports what happened through TWO channels that race
//     each other: a `window.postMessage` event (`WA_EMBEDDED_SIGNUP`,
//     carrying the phone number and WABA ids) and the `FB.login`
//     callback (carrying the code). The callback fires immediately
//     after the message, so the message data is kept in a `ref`: a
//     `setState` would not have propagated in time.
// ============================================================

import { useCallback, useEffect, useRef, useState } from 'react';
import Script from 'next/script';
import { toast } from 'sonner';
import { Loader2, MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';

import { Button } from '@/components/ui/button';

/** What `GET /api/whatsapp/embedded-signup` answers. */
export interface EmbeddedSignupSettings {
  enabled: boolean;
  app_id?: string;
  config_id?: string;
  graph_version?: string;
  /** `missing_verify_token` — platform mode without a webhook token. */
  warning?: string;
}

// ---- the slice of the Facebook SDK we use --------------------------

interface FbLoginResponse {
  status?: string;
  authResponse?: { code?: string } | null;
}

interface FbSdk {
  init(options: {
    appId: string;
    cookie: boolean;
    xfbml: boolean;
    version: string;
  }): void;
  login(
    callback: (response: FbLoginResponse) => void,
    options: Record<string, unknown>
  ): void;
}

declare global {
  interface Window {
    FB?: FbSdk;
  }
}

/**
 * Ask the server whether this deployment offers the integrated signup.
 *
 * `null` while the answer is in flight — the caller should render
 * neither the platform layout nor the self-hosted one until it knows,
 * otherwise the settings page visibly reshuffles on every load.
 */
export function useEmbeddedSignup(): EmbeddedSignupSettings | null {
  const [settings, setSettings] = useState<EmbeddedSignupSettings | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/whatsapp/embedded-signup');
        const payload = (await res.json()) as EmbeddedSignupSettings;
        if (!cancelled) {
          setSettings(res.ok ? payload : { enabled: false });
        }
      } catch {
        // Network trouble, or a role that may not ask. Either way the
        // safe reading is "no integrated signup": the manual form is
        // always there and always works.
        if (!cancelled) setSettings({ enabled: false });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return settings;
}

interface Props {
  settings: EmbeddedSignupSettings;
  /** Called after a number was saved, so the list can reload. */
  onConnected: () => void | Promise<void>;
  disabled?: boolean;
}

/**
 * Is this `message` event coming from Meta's dialog?
 *
 * Meta's own implementation guide checks `event.origin.endsWith(
 * 'facebook.com')`, which is deliberately broad: the dialog is served
 * from several hosts (`www.`, `web.`, `business.`, locale variants) and
 * a closed list of two origins would drop a session event in silence
 * the day Meta moves it. Copying `endsWith` verbatim would also accept
 * `https://facebook.com.evil.example`, so the host is parsed instead:
 * exactly `facebook.com` or a real subdomain of it, over HTTPS only.
 *
 * Exported for the test — `openDialog` and the listener are internal.
 */
export function isMetaSignupOrigin(origin: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    // `postMessage` from a sandboxed iframe reports the literal
    // string "null"; it is not ours either way.
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return (
    url.hostname === 'facebook.com' || url.hostname.endsWith('.facebook.com')
  );
}

/**
 * The `featureType` that makes the dialog offer "connect your existing
 * WhatsApp Business app account" (coexistence). Meta's coexistence
 * guide requires it in Embedded Signup v4 — this supersedes the older
 * note in `progress/meta_embedded-signup-verificacion.md` that said
 * `featureType` no longer existed. A dialog that does not offer
 * coexistence simply ignores it, so the ordinary flow (`FINISH`) keeps
 * working with the same button.
 */
export const COEXISTENCE_FEATURE_TYPE = 'whatsapp_business_app_onboarding';

/**
 * The options `FB.login` is called with. Exported so the test can pin
 * the shape without a browser.
 */
export function buildFbLoginOptions(configId: string): Record<string, unknown> {
  return {
    config_id: configId,
    response_type: 'code',
    // Without this Meta hands back a user access token instead of the
    // code, and there is nothing to exchange on the server.
    override_default_response_type: true,
    extras: { setup: {}, featureType: COEXISTENCE_FEATURE_TYPE },
  };
}

/** What a `WA_EMBEDDED_SIGNUP` session message means for us. */
export type SignupSessionEvent =
  | {
      kind: 'finish';
      phoneNumberId?: string;
      wabaId?: string;
      coexistence: boolean;
    }
  | { kind: 'cancel'; step: string }
  | { kind: 'error'; message: string };

/**
 * Parse the raw `event.data` of a `message` event from Meta's dialog.
 *
 * `null` when it is not JSON (the SDK posts housekeeping strings through
 * the same channel) or not a `WA_EMBEDDED_SIGNUP` message. The caller
 * must check `isMetaSignupOrigin` first.
 *
 * `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` is the coexistence finish:
 * the number stays on the phone app and is also on Cloud API.
 */
export function parseSignupSessionMessage(
  data: unknown
): SignupSessionEvent | null {
  if (typeof data !== 'string') return null;
  let payload: unknown;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== 'object') return null;
  const message = payload as {
    type?: unknown;
    event?: unknown;
    data?: Record<string, unknown> | null;
  };
  if (message.type !== 'WA_EMBEDDED_SIGNUP') return null;

  const str = (value: unknown): string | undefined =>
    typeof value === 'string' && value ? value : undefined;

  switch (message.event) {
    case 'FINISH':
    case 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING':
      return {
        kind: 'finish',
        phoneNumberId: str(message.data?.phone_number_id),
        wabaId: str(message.data?.waba_id),
        coexistence:
          message.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING',
      };
    case 'CANCEL':
      return {
        kind: 'cancel',
        step: str(message.data?.current_step) ?? 'unknown',
      };
    case 'ERROR':
      return {
        kind: 'error',
        message: str(message.data?.error_message) ?? 'unknown',
      };
    default:
      return null;
  }
}

/**
 * The body `POST /api/whatsapp/embedded-signup` receives.
 *
 * In coexistence Meta's `FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING` event
 * carries only `waba_id` — no `phone_number_id` — so the field travels
 * only when the dialog gave it; the server resolves it from the WABA
 * otherwise.
 */
export function buildSignupRequestBody(
  code: string,
  session: { phoneNumberId?: string; wabaId: string; coexistence: boolean }
): {
  code: string;
  phone_number_id?: string;
  waba_id: string;
  coexistence: boolean;
} {
  return {
    code,
    ...(session.phoneNumberId
      ? { phone_number_id: session.phoneNumberId }
      : {}),
    waba_id: session.wabaId,
    coexistence: session.coexistence === true,
  };
}

export type SignupResultMessageKey =
  | 'signupSuccess'
  | 'signupRegistrationFailed'
  | 'signupCoexistenceSuccess'
  | 'signupCoexistenceSyncFailed';

/** Which toast a 200 from the signup route deserves. */
export function signupResultMessageKey(payload: {
  coexistence?: boolean;
  registration_error?: string | null;
  smb_sync?: { state_sync?: string; history?: string };
}): SignupResultMessageKey {
  if (payload.coexistence === true) {
    const sync = payload.smb_sync;
    const failed = sync?.state_sync === 'failed' || sync?.history === 'failed';
    return failed ? 'signupCoexistenceSyncFailed' : 'signupCoexistenceSuccess';
  }
  return payload.registration_error
    ? 'signupRegistrationFailed'
    : 'signupSuccess';
}

export function EmbeddedSignupButton({
  settings,
  onConnected,
  disabled,
}: Props) {
  const t = useTranslations('Settings.whatsapp');

  const [sdkReady, setSdkReady] = useState(false);
  const [sdkFailed, setSdkFailed] = useState(false);
  const [working, setWorking] = useState(false);

  // What the dialog told us, outside React state on purpose (see the
  // header comment): the FB.login callback reads these microseconds
  // after the message arrives.
  const sessionRef = useRef<{
    phoneNumberId?: string;
    wabaId?: string;
    coexistence: boolean;
  } | null>(null);
  const cancelRef = useRef<string | null>(null);
  const errorRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!isMetaSignupOrigin(event.origin)) return;
      const message = parseSignupSessionMessage(event.data);
      if (!message) return;

      if (message.kind === 'finish') {
        sessionRef.current = {
          phoneNumberId: message.phoneNumberId,
          wabaId: message.wabaId,
          coexistence: message.coexistence,
        };
      } else if (message.kind === 'cancel') {
        cancelRef.current = message.step;
      } else {
        errorRef.current = message.message;
      }
    }

    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, []);

  const finish = useCallback(
    async (response: FbLoginResponse) => {
      const code = response.authResponse?.code;
      const session = sessionRef.current;

      // Closed the dialog on purpose. Nothing was created on Meta's
      // side worth mentioning and nothing is sent to our server.
      if (cancelRef.current) {
        toast.info(t('signupCancelled', { step: cancelRef.current }));
        return;
      }
      if (errorRef.current) {
        toast.error(t('signupError', { message: errorRef.current }));
        return;
      }
      // The window was closed without any event at all: `FB.login`
      // answers `{ status: 'unknown' }` and no authResponse.
      if (!code && !session) {
        toast.error(t('signupNotCompleted'));
        return;
      }
      // The awkward case: the flow finished but the code never made it
      // back (the window closed at the last instant). We have the ids
      // but cannot mint a token, and half a row is worse than none.
      // In coexistence Meta sends only the WABA id (the server resolves
      // the number); otherwise both ids are required.
      if (
        !code ||
        !session?.wabaId ||
        (!session.phoneNumberId && !session.coexistence)
      ) {
        toast.error(t('signupIncomplete'));
        return;
      }

      setWorking(true);
      try {
        const res = await fetch('/api/whatsapp/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            buildSignupRequestBody(code, {
              phoneNumberId: session.phoneNumberId,
              wabaId: session.wabaId,
              coexistence: session.coexistence,
            })
          ),
        });
        const payload = await res.json();
        if (!res.ok) {
          toast.error(payload.error || t('signupSaveFailed'));
          return;
        }
        const key = signupResultMessageKey(payload);
        if (key === 'signupRegistrationFailed') {
          // Saved and usable for sending, but Meta refused /register —
          // almost always because the business already had its own
          // two-step PIN. The manual PIN field is the retry path.
          toast.warning(
            t('signupRegistrationFailed', {
              message: String(payload.registration_error),
            })
          );
        } else if (key === 'signupCoexistenceSyncFailed') {
          // Connected, but the one-shot contacts/history sync did not
          // go through. The number card offers the retry (24 h window).
          toast.warning(t('signupCoexistenceSyncFailed'));
        } else {
          toast.success(t(key));
        }
        await onConnected();
      } catch (err) {
        console.error('Embedded signup failed:', err);
        toast.error(t('signupSaveFailed'));
      } finally {
        setWorking(false);
      }
    },
    [onConnected, t]
  );

  function openDialog() {
    if (!window.FB || !settings.config_id) return;
    sessionRef.current = null;
    cancelRef.current = null;
    errorRef.current = null;

    window.FB.login(
      (response) => void finish(response),
      buildFbLoginOptions(settings.config_id)
    );
  }

  if (!settings.enabled || !settings.app_id || !settings.config_id) return null;

  return (
    <>
      <Script
        src="https://connect.facebook.net/en_US/sdk.js"
        // `afterInteractive` (the default) is the right one here:
        // `beforeInteractive` is only legal in the root layout and
        // would pull Meta's SDK into every page of the app.
        strategy="afterInteractive"
        onLoad={() => {
          window.FB?.init({
            appId: settings.app_id as string,
            cookie: true,
            xfbml: false,
            version: settings.graph_version ?? 'v21.0',
          });
          setSdkReady(true);
        }}
        onError={() => setSdkFailed(true)}
      />
      <Button
        size="sm"
        onClick={openDialog}
        disabled={disabled || !sdkReady || sdkFailed || working}
        className="bg-primary text-primary-foreground hover:bg-primary/90 shrink-0"
      >
        {working ? (
          <>
            <Loader2 className="size-4 animate-spin" />
            {t('connecting')}
          </>
        ) : (
          <>
            <MessageCircle className="size-4" />
            {sdkFailed ? t('sdkUnavailable') : t('connectWhatsApp')}
          </>
        )}
      </Button>
    </>
  );
}
