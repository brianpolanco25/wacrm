import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { useEffectiveAccountId } from './use-auth';

// ============================================================
// `useAuth().accountId` is the account the panel is SHOWING.
//
// Before this round it was always `profile.account_id` — the operator's
// own — so during a support session every filtered list showed the wrong
// company under the customer's banner, and every unfiltered one showed
// both. The value now comes from the support flag cookie while a session
// is open.
//
// No jsdom in this repo (and no new deps), so the hook is exercised
// through `renderToStaticMarkup` with `document.cookie` stubbed. That
// works because `useSyncExternalStore`'s server snapshot reads the same
// cookie: wherever there is no `document` — a real server render — it
// answers `null`, which is the honest answer there.
// ============================================================

const OWN = 'aaaaaaaa-0000-4000-8000-00000000000a';
const CUSTOMER = 'bbbbbbbb-0000-4000-8000-00000000000b';

function setCookies(value: string) {
  (globalThis as { document?: { cookie: string } }).document = {
    cookie: value,
  };
}

afterEach(() => {
  delete (globalThis as { document?: unknown }).document;
});

function Probe({ own }: { own: string | null }) {
  const accountId = useEffectiveAccountId(own);
  return <span data-account={accountId ?? 'none'} />;
}

function accountShown(own: string | null): string {
  const html = renderToStaticMarkup(<Probe own={own} />);
  return /data-account="([^"]*)"/.exec(html)![1];
}

describe('useEffectiveAccountId', () => {
  it('returns the impersonated account while the support session is open', () => {
    setCookies(`theme=dark; wacrm_support_active=${CUSTOMER}`);
    expect(accountShown(OWN)).toBe(CUSTOMER);
  });

  it("returns the operator's own account once the session is over", () => {
    setCookies('theme=dark');
    expect(accountShown(OWN)).toBe(OWN);
  });

  it('shows nothing at all when the flag names no account', () => {
    // Fail closed. Falling back to `OWN` here would put the operator's
    // own rows under the customer's banner.
    setCookies('wacrm_support_active=1');
    expect(accountShown(OWN)).toBe('none');
  });

  it('does not invent an account for a cookie that merely looks similar', () => {
    setCookies(`not_wacrm_support_active=${CUSTOMER}`);
    expect(accountShown(OWN)).toBe(OWN);
  });

  it('answers null on the server, where there is no cookie jar', () => {
    delete (globalThis as { document?: unknown }).document;
    expect(accountShown(OWN)).toBe(OWN);
  });
});
