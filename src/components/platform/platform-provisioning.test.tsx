import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import ko from '../../../messages/ko.json';
import {
  AddMemberForm,
  CreateAccountForm,
  NewAccountButton,
  PlanAssignment,
  sendMemberInvite,
  type PlanOption,
} from './platform-provisioning';
import {
  fileScreen,
  PlatformAccountDetail,
  type Detail,
} from './platform-account-detail';
import { OperatorsTable, PlatformOperators } from './platform-operators';

// s9.4 UI, rendered to static markup like the rest of the panel (no
// jsdom, no new dependency): what each piece shows on its first paint,
// in the three catalogues. What the buttons DO is tested on the routes.

type Catalogue = typeof es;
const CATALOGUES: Array<['es' | 'en' | 'ko', Catalogue]> = [
  ['es', es],
  ['en', en as Catalogue],
  ['ko', ko as Catalogue],
];

function render(
  node: React.ReactNode,
  locale: 'es' | 'en' | 'ko' = 'es',
  messages: Catalogue = es
): string {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

const PLANS: PlanOption[] = [
  { id: 'inicio', name: 'Inicio', isPublic: true },
  { id: 'ilimitado', name: 'Ilimitado', isPublic: false },
];

const noop = () => {};

function planAssignment(provider: string | null) {
  return (
    <PlanAssignment
      accountId="aaaaaaaa-0000-4000-8000-000000000001"
      accountName="Acme"
      planId="negocio"
      planName="Negocio"
      provider={provider}
      subscriptionStatus="active"
      plans={PLANS}
      onChanged={noop}
    />
  );
}

describe('«Nueva empresa» on the census', () => {
  it('starts as a button, not an open form', () => {
    const html = render(<NewAccountButton />);
    expect(html).toContain(es.Platform.provisioning.newAccount);
    expect(html).not.toContain(es.Platform.provisioning.createTitle);
  });

  it('asks for name, owner email, optional plan and a reason', () => {
    const html = render(
      <CreateAccountForm plans={PLANS} onCancel={noop} onCreated={noop} />
    );
    const t = es.Platform.provisioning;
    for (const label of [
      t.createTitle,
      t.nameLabel,
      t.ownerEmailLabel,
      t.planLabel,
      t.planNone,
      t.reasonLabel,
      t.create,
    ]) {
      expect(html).toContain(label);
    }
    // Private plans are offered — that is what a manual assignment is for
    // — and labelled as such.
    expect(html).toContain(`Ilimitado ${t.privatePlan}`);
    // Nothing can be submitted before the fields are filled in.
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled/);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(
      <CreateAccountForm plans={PLANS} onCancel={noop} onCreated={noop} />,
      locale,
      messages
    );
    expect(html).toContain(messages.Platform.provisioning.createTitle);
    expect(html).toContain(
      messages.Platform.provisioning.reasonHelp.replace('{min}', '10')
    );
  });
});

describe('the plan on the file', () => {
  it('shows «Asignado a mano» for a manual plan (out of the MRR)', () => {
    const html = render(planAssignment('manual'));
    expect(html).toContain(es.Platform.provisioning.manualBadge);
    expect(html).toContain(es.Platform.provisioning.manualHelp);
  });

  it('does not for a PayPal plan, and says to cancel at PayPal first', () => {
    const html = render(planAssignment('paypal'));
    expect(html).not.toContain(es.Platform.provisioning.manualBadge);
    expect(html).toContain('paypal');
    expect(html).toContain(es.Platform.provisioning.assignHelp);
  });

  it('offers every plan and cannot assign before choosing one with a reason', () => {
    const html = render(planAssignment('paypal'));
    expect(html).toContain('>Inicio<');
    expect(html).toContain(es.Platform.provisioning.planPlaceholder);
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*?Asignar plan</);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(planAssignment('manual'), locale, messages);
    expect(html).toContain(messages.Platform.provisioning.manualBadge);
    expect(html).toContain(messages.Platform.provisioning.assign);
  });
});

describe('«Añadir miembro»', () => {
  it.each(CATALOGUES)(
    'offers the three roles a member can have, never owner (%s)',
    (locale, messages) => {
      const html = render(
        <AddMemberForm accountId="acc" link={null} onInvited={noop} />,
        locale,
        messages
      );
      const roles = messages.Platform.provisioning.roles;
      expect(html).toContain(messages.Platform.provisioning.memberTitle);
      for (const role of ['admin', 'agent', 'viewer'] as const) {
        expect(html).toContain(`value="${role}"`);
        expect(html).toContain(roles[role]);
      }
      expect(html).not.toContain('value="owner"');
    }
  );
});

describe('«Añadir miembro»: the one-time link survives the reload (review s9.4, finding 1)', () => {
  const URL_ = 'https://crm.test/join/tok_only_shown_once';

  function fakeFetch(status: number, body: unknown) {
    return (async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
      })) as unknown as typeof fetch;
  }

  const DETAIL: Detail = {
    accountId: 'aaaaaaaa-0000-4000-8000-000000000001',
    name: 'Acme',
    createdAt: '2026-01-01T00:00:00.000Z',
    planId: 'pro',
    planName: 'Pro',
    subscriptionStatus: 'active',
    provider: 'paypal',
    readOnly: false,
    manualHold: false,
    manualHoldAt: null,
    manualHoldReason: null,
    trialEndsAt: null,
    currentPeriodEnd: null,
    usage: [],
    limits: {},
    members: [],
    numbers: [],
    lastActivityAt: null,
    billingHistory: [],
    audit: [],
  };

  it('a 201 with emailed:false comes back as the link to share', async () => {
    const outcome = await sendMemberInvite(
      DETAIL.accountId,
      'bea@x.test',
      'agent',
      fakeFetch(201, { emailed: false, url: URL_ })
    );
    expect(outcome).toEqual({ kind: 'link', url: URL_ });
  });

  it('and the file, reloading after it, still shows that link', async () => {
    const outcome = await sendMemberInvite(
      DETAIL.accountId,
      'bea@x.test',
      'agent',
      fakeFetch(201, { emailed: false, url: URL_ })
    );
    if (outcome.kind !== 'link') throw new Error('expected a link');

    // First paint of the file is `loading` (the reload `onInvited` fires
    // is in flight). Before the fix this was the full-screen spinner, the
    // form unmounted and the link was gone.
    const html = render(
      <PlatformAccountDetail
        accountId={DETAIL.accountId}
        initial={{ detail: DETAIL, inviteLink: outcome.url }}
      />
    );
    expect(html).toContain(URL_);
    expect(html).toContain(es.Platform.provisioning.inviteLink);
    expect(html).toContain(es.Platform.provisioning.memberTitle);
    expect(html).not.toContain(es.Platform.loading);
  });

  it.each([
    [
      201,
      { emailed: true, url: URL_ },
      { kind: 'emailed', email: 'bea@x.test' },
    ],
    [
      409,
      { code: 'already_member' },
      { kind: 'error', reason: 'alreadyMember' },
    ],
    [402, { code: 'plan_limit' }, { kind: 'error', reason: 'seatLimit' }],
    [500, { error: 'x' }, { kind: 'error', reason: 'failed' }],
  ])('HTTP %s → %j', async (status, body, expected) => {
    expect(
      await sendMemberInvite(
        'acc',
        'bea@x.test',
        'agent',
        fakeFetch(status, body)
      )
    ).toEqual(expected);
  });

  it.each([
    [{ loading: true, failed: null, hasDetail: false }, 'loading'],
    [{ loading: false, failed: 'error', hasDetail: false }, 'failed'],
    [{ loading: false, failed: 'notFound', hasDetail: false }, 'failed'],
    // A reload, or a failed reload, never takes the file off the screen.
    [{ loading: true, failed: null, hasDetail: true }, 'ready'],
    [{ loading: false, failed: 'error', hasDetail: true }, 'ready'],
  ] as const)('fileScreen(%j) → %s', (state, screen) => {
    expect(fileScreen(state)).toBe(screen);
  });
});

describe('/platform/operators', () => {
  const READY = {
    kind: 'ready' as const,
    currentUserId: 'me',
    operators: [
      {
        userId: 'me',
        email: 'me@x.test',
        fullName: 'Me',
        grantedAt: '2026-01-01T00:00:00.000Z',
        grantedBy: null,
        note: 'bootstrap',
      },
      {
        userId: 'other',
        email: 'bea@x.test',
        fullName: 'Bea',
        grantedAt: '2026-02-01T00:00:00.000Z',
        grantedBy: 'me',
        note: 'support hire',
      },
    ],
  };

  it('opens on the loading state, never on an empty table', () => {
    const html = render(<PlatformOperators />);
    expect(html).toContain(es.Platform.operators.loading);
    expect(html).toContain(es.Platform.operators.grantTitle);
  });

  it('says so when the list could not be loaded', () => {
    const html = render(
      <OperatorsTable state={{ kind: 'error' }} onRevoke={noop} />
    );
    expect(html).toContain(es.Platform.operators.loadFailed);
  });

  it('lists every operator, marks you, and offers «revoke» on the others only', () => {
    const html = render(<OperatorsTable state={READY} onRevoke={noop} />);
    expect(html).toContain('me@x.test');
    expect(html).toContain('bea@x.test');
    expect(html).toContain(es.Platform.operators.you);
    // One revoke button: Bea's. Not your own row.
    const revokes = html.split(es.Platform.operators.revoke).length - 1;
    expect(revokes).toBe(1);
  });

  it.each(CATALOGUES)('is translated in %s (CP6)', (locale, messages) => {
    const html = render(
      <OperatorsTable state={READY} onRevoke={noop} />,
      locale,
      messages
    );
    expect(html).toContain(messages.Platform.operators.columns.email);
    expect(html).toContain(messages.Platform.operators.revoke);
  });
});

/** Every `t('…')` key a component asks for (literal keys). */
function keysUsedBy(file: string): string[] {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/platform', file),
    'utf8'
  );
  const keys = new Set<string>();
  for (const match of source.matchAll(/\bt\(\s*'([A-Za-z0-9_.]+)'/g)) {
    keys.add(match[1]);
  }
  return [...keys];
}

function resolve(messages: Record<string, unknown>, dotted: string): unknown {
  return dotted
    .split('.')
    .reduce<unknown>(
      (node, part) =>
        node && typeof node === 'object'
          ? (node as Record<string, unknown>)[part]
          : undefined,
      messages
    );
}

describe('every key exists in es, en AND ko (CP6)', () => {
  it.each([
    ['platform-provisioning.tsx', 'provisioning'],
    ['platform-operators.tsx', 'operators'],
  ])('%s', (file, namespace) => {
    const keys = keysUsedBy(file);
    expect(keys.length).toBeGreaterThan(10);
    // The role labels are asked for by template (`roles.${r}`).
    if (namespace === 'provisioning') {
      keys.push('roles.admin', 'roles.agent', 'roles.viewer');
    }
    for (const [locale, catalogue] of CATALOGUES) {
      const ns = (catalogue.Platform as Record<string, unknown>)[namespace];
      for (const key of keys) {
        expect(
          resolve(ns as Record<string, unknown>, key),
          `messages/${locale}.json is missing Platform.${namespace}.${key}`
        ).toBeTypeOf('string');
      }
    }
  });
});
