import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import { useSubscriptionStatusLabel } from './subscription-status';

// s9.6: the census and the account page name `incomplete` as a state of
// its own («Alta incompleta»), with the same labels as the dashboard.

function Label({ status }: { status: string | null }) {
  const label = useSubscriptionStatusLabel();
  return <span>{label(status)}</span>;
}

function render(
  status: string | null,
  locale: 'es' | 'en' | 'ko',
  messages: typeof es
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <Label status={status} />
    </NextIntlClientProvider>
  );
}

describe('useSubscriptionStatusLabel', () => {
  it.each([
    ['es', es],
    ['en', en as typeof es],
    ['ko', ko as typeof es],
  ] as const)('names incomplete in %s', (locale, messages) => {
    expect(render('incomplete', locale, messages)).toBe(
      `<span>${messages.Platform.metrics.status.incomplete}</span>`
    );
  });

  it('says «Alta incompleta» in Spanish, «sin suscripción» for none, and an unknown status verbatim', () => {
    expect(render('incomplete', 'es', es)).toContain('Alta incompleta');
    expect(render(null, 'es', es)).toContain(es.Platform.metrics.status.none);
    expect(render('weird', 'es', es)).toContain('weird');
  });
});
