import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../../messages/en.json';
import es from '../../../../messages/es.json';
import type { InvitePeek, JoinFailReason } from '@/lib/auth/join-flow';

import {
  SignupInviteCheckEmail,
  SignupInviteChecking,
  SignupInviteFail,
  useSignupInviteCopy,
} from './signup-invite-view';

// i12.1 — the invitation screens of /signup?invite= (R8, R11, R26, R32,
// R34), in both catalogues.

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
const PEEK: InvitePeek = {
  account_name: 'Acme Corp',
  role: 'admin',
  expires_at: '2026-11-10T00:00:00.000Z',
};

function render(locale: string, m: Catalogue, node: React.ReactNode) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={m}>
      {node}
    </NextIntlClientProvider>
  );
}

function esc(s: string) {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function CopyProbe({ peek }: { peek: InvitePeek | null }) {
  const copy = useSignupInviteCopy(peek);
  return <p>{copy ? `${copy.title}|${copy.description}` : 'NO-INVITE'}</p>;
}

describe('signup invitation screens', () => {
  it.each(CATALOGUES)(
    '%s: the form title and description name the company and role (R26)',
    (l, m) => {
      const html = render(l, m, <CopyProbe peek={PEEK} />);
      expect(html).toContain('Acme Corp');
      expect(html).toContain(esc(m.JoinPage.roles.admin));
      expect(render(l, m, <CopyProbe peek={null} />)).toContain('NO-INVITE');
    }
  );

  it('says you go straight into the company', () => {
    expect(render('es', es as Catalogue, <CopyProbe peek={PEEK} />)).toContain(
      'entrarás directamente a Acme Corp'
    );
    expect(render('en', en, <CopyProbe peek={PEEK} />)).toContain(
      'go straight into Acme Corp'
    );
  });

  it.each(CATALOGUES)(
    '%s: checking the invitation before the form (R8)',
    (l, m) => {
      const html = render(l, m, <SignupInviteChecking />);
      expect(html).toContain(esc(m.SignupInvite.checking));
      expect(html).toContain('role="status"');
      expect(html).not.toContain('<form');
    }
  );

  it.each(CATALOGUES)(
    '%s: every reason shows its copy and no form (R8, R32)',
    (l, m) => {
      for (const reason of REASONS) {
        const html = render(
          l,
          m,
          <SignupInviteFail reason={reason} onRetry={() => {}} />
        );
        expect(html).toContain(esc(m.JoinPage.fail[reason].title));
        expect(html).toContain(esc(m.JoinPage.fail[reason].body));
        expect(html).toContain('href="/signup"');
        expect(html).not.toContain('<form');
        if (reason === 'server_error') {
          expect(html).toContain(esc(m.JoinPage.tryAgain));
        }
      }
    }
  );

  it('no_seats says the company has no free seats (R34)', () => {
    expect(
      render('es', es as Catalogue, <SignupInviteFail reason="no_seats" />)
    ).toContain('no tiene asientos libres');
    expect(render('en', en, <SignupInviteFail reason="no_seats" />)).toContain(
      'no free seats'
    );
  });

  it.each(CATALOGUES)(
    '%s: "check your email" names the email and the company (R11)',
    (l, m) => {
      const html = render(
        l,
        m,
        <SignupInviteCheckEmail
          email="ana@acme.test"
          accountName="Acme Corp"
          token="t/1"
        />
      );
      expect(html).toContain(esc(m.SignupInvite.checkEmailTitle));
      expect(html).toContain('ana@acme.test');
      expect(html).toContain('Acme Corp');
      expect(html).toContain('href="/login?invite=t%2F1"');
    }
  );
});
