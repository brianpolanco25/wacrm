import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider, createTranslator } from 'next-intl';

import en from '../../../../messages/en.json';
import es from '../../../../messages/es.json';
import type { JoinFailReason, JoinState } from '@/lib/auth/join-flow';
import { CONFLICT_FALLBACK } from '@/lib/auth/join-flow';

import { Dialog } from '@/components/ui/dialog';

import { JoinConflictBody, JoinView } from './join-view';

// i12.1 — what /join/<token> renders (R12, R14, R15, R17, R25, R34).
// The modal's content is rendered on its own too, inside a bare Dialog
// root: the portal of DialogContent does not reach a static render.

type Catalogue = typeof en;
const CATALOGUES: Array<[string, Catalogue]> = [
  ['es', es as Catalogue],
  ['en', en],
];
const REASONS: JoinFailReason[] = [
  'not_found',
  'used',
  'expired',
  'no_seats',
  'server_error',
];
const PEEK = {
  account_name: 'Acme Corp',
  role: 'agent' as const,
  expires_at: '2026-11-10T00:00:00.000Z',
};
const TOKEN = 'tok+/1';

function render(locale: string, m: Catalogue, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={m}>
      {node}
    </NextIntlClientProvider>
  );
}

function view(locale: string, m: Catalogue, state: JoinState | null) {
  return render(
    locale,
    m,
    <JoinView
      state={state}
      token={TOKEN}
      onRetry={() => {}}
      onSignOut={() => {}}
      signingOut={false}
    />
  );
}

function conflictBody(
  locale: string,
  m: Catalogue,
  accountName: string | null
) {
  return render(
    locale,
    m,
    <Dialog open>
      <JoinConflictBody
        message={CONFLICT_FALLBACK}
        accountName={accountName}
        onSignOut={() => {}}
        signingOut={false}
      />
    </Dialog>
  );
}

/** Text that belonged to the old "Accept" step, in both languages. */
const BANNED = [
  'Accept invitation',
  'Accepting moves',
  'Aceptar invitación',
  'Al aceptar',
  'personal account from signup',
];

/** Escape like React does for text nodes, to compare against markup. */
function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

describe('JoinView', () => {
  it.each(CATALOGUES)(
    '%s: loading and redirect show the waiting state',
    (l, m) => {
      for (const state of [
        null,
        { kind: 'redirect', to: '/dashboard' } as const,
      ]) {
        const html = view(l, m, state);
        expect(html).toContain(esc(m.JoinPage.loading));
        expect(html).toContain('role="status"');
        expect(html).toContain('aria-busy="true"');
      }
    }
  );

  it.each(CATALOGUES)(
    '%s: signed out names company and role, links to signup and login',
    (l, m) => {
      const html = view(l, m, { kind: 'signedOut', peek: PEEK });
      expect(html).toContain('Acme Corp');
      expect(html).toContain(esc(m.JoinPage.roles.agent));
      expect(html).toContain(esc(m.JoinPage.createAndJoin));
      expect(html).toContain(esc(m.JoinPage.haveAccount));
      const q = encodeURIComponent(TOKEN);
      expect(html).toContain(`href="/signup?invite=${q}"`);
      expect(html).toContain(`href="/login?invite=${q}"`);
    }
  );

  it.each(CATALOGUES)(
    '%s: every failure has its own title and body',
    (l, m) => {
      const titles = new Set<string>();
      for (const reason of REASONS) {
        const html = view(l, m, { kind: 'fail', reason });
        const copy = m.JoinPage.fail[reason];
        expect(html).toContain(esc(copy.title));
        expect(html).toContain(esc(copy.body));
        titles.add(copy.title);
        if (reason === 'server_error') {
          expect(html).toContain(esc(m.JoinPage.tryAgain));
        } else {
          expect(html).not.toContain(esc(m.JoinPage.tryAgain));
        }
      }
      expect(titles.size).toBe(REASONS.length);
    }
  );

  it('no_seats tells the person the team is full and to ask an admin (R34)', () => {
    expect(
      view('es', es as Catalogue, { kind: 'fail', reason: 'no_seats' })
    ).toContain('no tiene asientos libres');
    expect(view('en', en, { kind: 'fail', reason: 'no_seats' })).toContain(
      'no free seats'
    );
  });

  it.each(CATALOGUES)(
    '%s: conflict modal with and without the company name (R14)',
    (l, m) => {
      const t = createTranslator({
        locale: l,
        messages: m,
        namespace: 'JoinPage',
      });
      const named = conflictBody(l, m, 'Acme Corp');
      expect(named).toContain(
        esc(t('conflict.title', { account: 'Acme Corp' }))
      );
      expect(named).toContain(esc(m.JoinPage.conflict.fallback));
      expect(named).toContain(esc(m.JoinPage.conflict.signOut));
      expect(named).toContain(esc(m.JoinPage.conflict.goToMyAccount));
      expect(named).toContain('href="/dashboard"');

      const unnamed = conflictBody(l, m, null);
      expect(unnamed).toContain(esc(m.JoinPage.conflict.titleNoName));

      // The page behind the modal still names the company.
      const page = view(l, m, { kind: 'conflict', message: 'x', peek: PEEK });
      expect(page).toContain('Acme Corp');
    }
  );

  it('shows the server message when it sent one', () => {
    const html = render(
      'en',
      en,
      <Dialog open>
        <JoinConflictBody
          message="Your account already contains data"
          accountName="Acme"
          onSignOut={() => {}}
          signingOut
        />
      </Dialog>
    );
    expect(html).toContain('Your account already contains data');
    expect(html).toContain(esc(en.JoinPage.conflict.signingOut));
    expect(html).toMatch(/<button[^>]*disabled/);
  });

  it.each(CATALOGUES)(
    '%s: nothing says "accept" any more (R12, R25)',
    (l, m) => {
      const states: (JoinState | null)[] = [
        null,
        { kind: 'signedOut', peek: PEEK },
        { kind: 'conflict', message: 'x', peek: PEEK },
        ...REASONS.map((reason) => ({ kind: 'fail', reason }) as JoinState),
      ];
      const all =
        states.map((s) => view(l, m, s)).join('\n') +
        conflictBody(l, m, 'Acme Corp');
      for (const text of BANNED) expect(all).not.toContain(text);
      expect(JSON.stringify(m.JoinPage)).not.toMatch(/accept|acept/i);
    }
  );
});
