import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import {
  CoexistenceBadge,
  CoexistenceStatus,
  numberDeliveryState,
  smbSyncDisplay,
} from './coexistence-status';
import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { WhatsAppConfig } from '@/types';

/**
 * #1650 R19–R22 — the coexistence block of a number card. Static
 * markup (no jsdom in this repo), as `embedded-signup-button.test.tsx`.
 */

const NOW = new Date('2026-11-02T12:00:00.000Z');
const HOUR = 60 * 60 * 1000;

const KEYS = [
  'coexistenceBadge',
  'coexistenceSyncDone',
  'coexistenceSyncPending',
  'coexistenceSyncFailed',
  'coexistenceSyncRetry',
  'coexistenceSyncRetrying',
  'coexistenceSyncRetried',
  'coexistenceSyncRetryFailed',
  'coexistenceSyncExpired',
  'bizAppWithoutCoexistence',
  'signupCoexistenceSuccess',
  'signupCoexistenceSyncFailed',
] as const;

type Messages = typeof en;
const enW = (en as Messages).Settings.whatsapp as unknown as Record<
  string,
  string
>;
const esW = (es as Messages).Settings.whatsapp as unknown as Record<
  string,
  string
>;

function row(extra: Partial<WhatsAppConfig> = {}): WhatsAppConfig {
  return {
    id: 'cfg-1',
    user_id: 'u-1',
    phone_number_id: 'pn-1',
    access_token: 'x',
    status: 'connected',
    registered_at: undefined,
    coexistence_onboarded_at: new Date(NOW.getTime() - HOUR).toISOString(),
    smb_state_sync_request_id: null,
    smb_history_sync_request_id: null,
    smb_sync_error: null,
    ...extra,
  } as WhatsAppConfig;
}

function render(node: React.ReactElement, locale: 'en' | 'es' = 'en'): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={locale === 'en' ? en : es}
    >
      {node}
    </NextIntlClientProvider>
  );
}

function status(
  r: WhatsAppConfig,
  extra: Partial<React.ComponentProps<typeof CoexistenceStatus>> = {},
  locale: 'en' | 'es' = 'en'
) {
  return render(
    <CoexistenceStatus
      row={r}
      canRetry
      busy={false}
      onRetry={() => {}}
      now={NOW}
      {...extra}
    />,
    locale
  );
}

describe('numberDeliveryState / smbSyncDisplay', () => {
  it('coexistence wins over registered_at', () => {
    expect(numberDeliveryState(row())).toBe('coexistence');
    expect(
      numberDeliveryState(
        row({ coexistence_onboarded_at: null, registered_at: '2026-10-01' })
      )
    ).toBe('registered');
    expect(numberDeliveryState(row({ coexistence_onboarded_at: null }))).toBe(
      'unregistered'
    );
  });

  it('done needs both request ids; failed needs an error', () => {
    expect(
      smbSyncDisplay(
        row({
          smb_state_sync_request_id: 'a',
          smb_history_sync_request_id: 'b',
        })
      )
    ).toBe('done');
    expect(smbSyncDisplay(row({ smb_state_sync_request_id: 'a' }))).toBe(
      'pending'
    );
    expect(smbSyncDisplay(row({ smb_sync_error: 'history: x' }))).toBe(
      'failed'
    );
  });
});

describe('CoexistenceStatus', () => {
  it('R19: the badge says coexistence', () => {
    expect(render(<CoexistenceBadge />)).toContain(enW.coexistenceBadge);
  });

  it('R19: sync completed — no button', () => {
    const html = status(
      row({ smb_state_sync_request_id: 'a', smb_history_sync_request_id: 'b' })
    );
    expect(html).toContain(enW.coexistenceSyncDone);
    expect(html).toContain('data-smb-sync="done"');
    expect(html).not.toContain(enW.coexistenceSyncRetry);
  });

  it('R19/R20: pending inside 24 h with canRetry → retry button', () => {
    const html = status(row());
    expect(html).toContain(enW.coexistenceSyncPending);
    expect(html).toContain(enW.coexistenceSyncRetry);
    expect(html).not.toContain('data-smb-sync-expired');
  });

  it('R19: failed shows the stored message', () => {
    const html = status(row({ smb_sync_error: 'history: (#100) nope' }));
    expect(html).toContain('data-smb-sync="failed"');
    expect(html).toContain('history: (#100) nope');
    expect(html).toContain(enW.coexistenceSyncRetry);
  });

  it('R20: busy → aria-busy and disabled, with the retrying label', () => {
    const html = status(row(), { busy: true });
    expect(html).toMatch(/<button[^>]*disabled=""/);
    expect(html).toMatch(/<button[^>]*aria-busy="true"/);
    expect(html).toContain(enW.coexistenceSyncRetrying);
  });

  it('R20: no button without canRetry', () => {
    const html = status(row(), { canRetry: false });
    expect(html).not.toContain('<button');
  });

  it('R20: outside 24 h → expired text and no button', () => {
    const html = status(
      row({
        coexistence_onboarded_at: new Date(
          NOW.getTime() - 25 * HOUR
        ).toISOString(),
        smb_sync_error: 'history: x',
      })
    );
    expect(html).toContain('data-smb-sync-expired');
    expect(html).toContain('24');
    expect(html).not.toContain('<button');
  });

  it('R21: warning when the last verification said biz_app_without_coexistence', () => {
    const html = status(row({ coexistence_onboarded_at: null }), {
      probeCode: 'biz_app_without_coexistence',
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain('without coexistence');
  });

  it('renders nothing for an ordinary number without a probe code', () => {
    expect(status(row({ coexistence_onboarded_at: null }))).toBe('');
  });
});

describe('R22: i18n', () => {
  it('every key exists in es and en, non-empty', () => {
    for (const key of KEYS) {
      expect(typeof enW[key], `en ${key}`).toBe('string');
      expect(typeof esW[key], `es ${key}`).toBe('string');
      expect(enW[key].length).toBeGreaterThan(0);
      expect(esW[key].length).toBeGreaterThan(0);
    }
  });

  it('renders in es and en without raw keys', () => {
    for (const locale of ['en', 'es'] as const) {
      const html =
        status(
          row({ smb_sync_error: 'boom' }),
          {
            probeCode: 'biz_app_without_coexistence',
          },
          locale
        ) +
        status(row(), { busy: true }, locale) +
        status(
          row({
            coexistence_onboarded_at: new Date(
              NOW.getTime() - 25 * HOUR
            ).toISOString(),
          }),
          {},
          locale
        ) +
        render(<CoexistenceBadge />, locale);
      for (const key of KEYS) {
        expect(html, `${locale} ${key}`).not.toContain(key);
      }
      expect(html).not.toContain('Settings.whatsapp');
    }
    expect(status(row(), {}, 'es')).toContain(esW.coexistenceSyncPending);
  });
});
