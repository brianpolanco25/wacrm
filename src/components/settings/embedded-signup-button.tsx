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

/** Origins Meta's dialog posts its session events from. */
const META_ORIGINS = ['https://www.facebook.com', 'https://web.facebook.com'];

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
  const sessionRef = useRef<{ phoneNumberId?: string; wabaId?: string } | null>(
    null
  );
  const cancelRef = useRef<string | null>(null);
  const errorRef = useRef<string | null>(null);

  useEffect(() => {
    function onMessage(event: MessageEvent) {
      if (!META_ORIGINS.includes(event.origin)) return;
      let payload: unknown;
      try {
        // The SDK also posts non-JSON housekeeping messages through the
        // same channel; those are not ours and must not throw.
        payload = JSON.parse(event.data as string);
      } catch {
        return;
      }
      const message = payload as {
        type?: string;
        event?: string;
        data?: Record<string, string>;
      };
      if (message.type !== 'WA_EMBEDDED_SIGNUP') return;

      if (message.event === 'FINISH') {
        sessionRef.current = {
          phoneNumberId: message.data?.phone_number_id,
          wabaId: message.data?.waba_id,
        };
      } else if (message.event === 'CANCEL') {
        cancelRef.current = message.data?.current_step ?? 'unknown';
      } else if (message.event === 'ERROR') {
        errorRef.current = message.data?.error_message ?? 'unknown';
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
      if (!code || !session?.phoneNumberId || !session?.wabaId) {
        toast.error(t('signupIncomplete'));
        return;
      }

      setWorking(true);
      try {
        const res = await fetch('/api/whatsapp/embedded-signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            code,
            phone_number_id: session.phoneNumberId,
            waba_id: session.wabaId,
          }),
        });
        const payload = await res.json();
        if (!res.ok) {
          toast.error(payload.error || t('signupSaveFailed'));
          return;
        }
        if (payload.registration_error) {
          // Saved and usable for sending, but Meta refused /register —
          // almost always because the business already had its own
          // two-step PIN. The manual PIN field is the retry path.
          toast.warning(
            t('signupRegistrationFailed', {
              message: String(payload.registration_error),
            })
          );
        } else {
          toast.success(t('signupSuccess'));
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

    window.FB.login((response) => void finish(response), {
      config_id: settings.config_id,
      response_type: 'code',
      // Without this Meta hands back a user access token instead of the
      // code, and there is nothing to exchange on the server.
      override_default_response_type: true,
      extras: {
        setup: {},
        featureType: '',
        sessionInfoVersion: '3',
      },
    });
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
