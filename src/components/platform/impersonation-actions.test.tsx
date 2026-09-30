import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import type { SupportActivity } from '@/lib/platform/support-activity';
import {
  ImpersonationActions,
  SupportSessionList,
} from './impersonation-actions';

// The support sessions on an account's file (s9.5). No jsdom in this repo,
// so the list is rendered to static markup; the fold is a native
// <details>, which needs no state to be tested.

const ACTIVITY: SupportActivity = {
  truncated: false,
  sessions: [
    {
      id: 'log-1',
      actorUserId: 'operator-uid-1',
      reason: 'ticket 72: tags missing',
      startedAt: '2026-09-30T11:50:00.000Z',
      expiresAt: '2026-09-30T12:20:00.000Z',
      endedAt: null,
      endedReason: null,
      open: true,
      actions: [
        {
          id: 'a1',
          method: 'POST',
          path: '/api/quick-replies',
          status: null,
          source: 'http',
          at: '2026-09-30T11:55:00.000Z',
        },
        {
          id: 'a2',
          method: 'PATCH',
          path: 'db:contacts/c-1',
          status: null,
          source: 'db',
          at: '2026-09-30T11:56:00.000Z',
        },
        {
          id: 'a3',
          method: 'POST',
          path: '/api/account/transfer-ownership',
          status: 403,
          source: 'http',
          at: '2026-09-30T11:57:00.000Z',
        },
      ],
    },
    {
      id: 'log-0',
      actorUserId: 'operator-uid-2',
      reason: 'looked at the inbox',
      startedAt: '2026-09-29T10:00:00.000Z',
      expiresAt: '2026-09-29T10:30:00.000Z',
      endedAt: '2026-09-29T10:05:00.000Z',
      endedReason: 'manual',
      open: false,
      actions: [],
    },
  ],
};

const CATALOGUES = { en, es, ko } as const;

function render(
  node: React.ReactNode,
  locale: keyof typeof CATALOGUES = 'en'
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} messages={CATALOGUES[locale]}>
      {node}
    </NextIntlClientProvider>
  );
}

describe('SupportSessionList', () => {
  it('lists every session with its reason, and the one in force says so', () => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />
    );
    expect(html).toContain('ticket 72: tags missing');
    expect(html).toContain('looked at the inbox');
    expect(html).toContain('operator-uid-1');
    expect(html).toContain(en.Platform.support.open);
  });

  it('folds each session’s actions under a disclosure', () => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />
    );
    expect(html).toContain('<details');
    expect(html).toContain(en.Platform.support.showActions);
    expect(html).toContain('/api/quick-replies');
    expect(html).toContain('db:contacts/c-1');
    expect(html).toContain('3 changes');
  });

  it('tells a request from a row, and marks what the server refused', () => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />
    );
    expect(html).toContain(en.Platform.support.sourceHttp);
    expect(html).toContain(en.Platform.support.sourceDb);
    expect(html).toContain('Refused (403)');
  });

  it('says so when a session changed nothing', () => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />
    );
    expect(html).toContain(en.Platform.support.noActions);
  });

  it('says so when nobody ever opened a session', () => {
    const html = render(
      <SupportSessionList
        activity={{ sessions: [], truncated: false }}
        actionLimit={500}
      />
    );
    expect(html).toContain(en.Platform.support.none);
  });

  it('does not claim "nothing changed" for a session whose actions were cut off', () => {
    const html = render(
      <SupportSessionList
        activity={{ ...ACTIVITY, truncated: true }}
        actionLimit={500}
      />
    );
    expect(html).toContain(en.Platform.support.olderActionsHidden);
    expect(html).not.toContain(en.Platform.support.noActions);
  });

  it('says a request row does not know its outcome', () => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />
    );
    expect(html).toContain(en.Platform.support.statusUnknown);
  });

  it('warns when older actions were cut off', () => {
    const html = render(
      <SupportSessionList
        activity={{ ...ACTIVITY, truncated: true }}
        actionLimit={500}
      />
    );
    expect(html).toContain('500 most recent');
  });

  it.each(['es', 'ko'] as const)('is translated in %s (CP6)', (locale) => {
    const html = render(
      <SupportSessionList activity={ACTIVITY} actionLimit={500} />,
      locale
    );
    expect(html).toContain(CATALOGUES[locale].Platform.support.showActions);
    expect(html).toContain(CATALOGUES[locale].Platform.support.sourceDb);
    expect(html).not.toContain('Platform.support.');
  });
});

describe('ImpersonationActions', () => {
  it('renders its card, loading, before the fetch lands', () => {
    const html = render(<ImpersonationActions accountId="acc-1" />, 'es');
    expect(html).toContain(es.Platform.support.title);
    expect(html).toContain(es.Platform.support.loading);
  });
});
