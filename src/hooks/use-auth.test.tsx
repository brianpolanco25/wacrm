import { afterEach, describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

import { accountSummaryFor, useEffectiveAccountId } from './use-auth';

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

// ============================================================
// The name over the rows.
//
// `accountId` and the account SUMMARY (name, default currency — what the
// header prints) move on different clocks: the first is re-read from the
// flag cookie every time the tab regains focus, the second crosses the
// network. The summary used to be resolved ONCE, inside `fetchProfile`,
// which only re-runs on an auth-state change. So whenever the flag moved
// on its own the two drifted apart, and the panel went back to the
// mislabelled view of the first round — in both directions:
//
//   - the session expires with the tab open (or is ended from a second
//     tab): every list reloads with the OPERATOR's rows while the header
//     still names the customer, under a banner promising nothing saves;
//   - a session is started from another tab: the old tab shows the
//     CUSTOMER's rows with the operator's company in the header, and no
//     banner at all.
//
// `accountSummaryFor` is the guard: a summary is shown only while it is
// about the account the lists are querying. The provider re-fetches on
// the same trigger as the flag, and this withholds the stale name during
// the window where that fetch has not landed.
// ============================================================

const OWN_SUMMARY = { id: OWN, name: 'Operator Co', default_currency: 'USD' };
const CUSTOMER_SUMMARY = {
  id: CUSTOMER,
  name: 'Customer Co',
  default_currency: 'EUR',
};

/** The company name the header would print, given what has been fetched. */
function headerName(
  fetched: typeof OWN_SUMMARY | null,
  own: string | null
): string {
  function Header() {
    const accountId = useEffectiveAccountId(own);
    const shown = accountSummaryFor(fetched, accountId);
    return <span data-name={shown?.name ?? 'none'} />;
  }
  const html = renderToStaticMarkup(<Header />);
  return /data-name="([^"]*)"/.exec(html)![1];
}

describe('the account summary the header prints', () => {
  it("names the customer's company during the session", () => {
    setCookies(`wacrm_support_active=${CUSTOMER}`);
    expect(headerName(CUSTOMER_SUMMARY, OWN)).toBe('Customer Co');
  });

  it("names the operator's own company with no session open", () => {
    setCookies('theme=dark');
    expect(headerName(OWN_SUMMARY, OWN)).toBe('Operator Co');
  });

  it('goes blank the moment the session expires under it', () => {
    // The flag is gone (expiry, or "exit" pressed in another tab), so
    // `accountId` is already back to the operator's and every list has
    // reloaded with their rows. The customer's name must NOT stay on
    // the header over them — this is the direction the reviewer caught.
    setCookies(`wacrm_support_active=${CUSTOMER}`);
    expect(headerName(CUSTOMER_SUMMARY, OWN)).toBe('Customer Co');

    setCookies('theme=dark');
    expect(headerName(CUSTOMER_SUMMARY, OWN)).toBe('none');
  });

  it('goes blank the moment a session opens from another tab', () => {
    // The other direction: this tab had fetched its own company, and a
    // flag appeared naming the customer. The lists now show the
    // customer's rows; the operator's name must not sit over them.
    setCookies('theme=dark');
    expect(headerName(OWN_SUMMARY, OWN)).toBe('Operator Co');

    setCookies(`wacrm_support_active=${CUSTOMER}`);
    expect(headerName(OWN_SUMMARY, OWN)).toBe('none');
  });

  it('stays blank while the flag names no account', () => {
    // `accountId` is null there (fail closed), and a name without an
    // account is exactly the label with nothing behind it.
    setCookies('wacrm_support_active=1');
    expect(headerName(CUSTOMER_SUMMARY, OWN)).toBe('none');
    expect(headerName(OWN_SUMMARY, OWN)).toBe('none');
  });

  it('prints nothing before the fetch lands', () => {
    setCookies(`wacrm_support_active=${CUSTOMER}`);
    expect(headerName(null, OWN)).toBe('none');
  });
});

describe('accountSummaryFor', () => {
  it('hands back the summary only when it is about that same account', () => {
    expect(accountSummaryFor(CUSTOMER_SUMMARY, CUSTOMER)).toBe(
      CUSTOMER_SUMMARY
    );
    expect(accountSummaryFor(CUSTOMER_SUMMARY, OWN)).toBeNull();
    expect(accountSummaryFor(OWN_SUMMARY, CUSTOMER)).toBeNull();
  });

  it('withholds it while there is no effective account at all', () => {
    // Signed out, still loading, or a flag that names nothing: falling
    // back to the last known currency would put the customer's EUR on
    // the operator's deals.
    expect(accountSummaryFor(OWN_SUMMARY, null)).toBeNull();
    expect(accountSummaryFor(null, OWN)).toBeNull();
  });
});
