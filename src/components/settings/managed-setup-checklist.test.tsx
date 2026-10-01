import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';
import type { SupabaseClient } from '@supabase/supabase-js';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import {
  MANAGED_SETUP_STEPS,
  META_STEPS,
  ManagedSetupChecklist,
  fetchMetaBilling,
  toggleStep,
  type ManagedSetupBilling,
  type ManagedSetupStep,
} from './managed-setup-checklist';

// s10.6: the option-A checklist on Settings → WhatsApp. Static markup, like
// the rest of the settings tests (no jsdom): the first paint, the gate on
// `meta_billing`, the pure checkbox toggle and the read behind the gate.

type Catalogue = typeof es;

const LABELS = {
  addNumber: 'ADD-NUMBER',
  manualSetup: 'MANUAL-SETUP',
  phoneNumberId: 'PHONE-FIELD',
  wabaId: 'WABA-FIELD',
  accessToken: 'TOKEN-FIELD',
  testConnection: 'TEST-BUTTON',
};

function render(
  metaBilling: ManagedSetupBilling | null,
  opts: {
    locale?: 'es' | 'en';
    initialDone?: ManagedSetupStep[];
  } = {}
): string {
  const locale = opts.locale ?? 'es';
  const messages = (locale === 'es' ? es : en) as Catalogue;
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      <ManagedSetupChecklist
        metaBilling={metaBilling}
        fieldLabels={LABELS}
        initialDone={opts.initialDone}
      />
    </NextIntlClientProvider>
  );
}

describe('ManagedSetupChecklist: only for managed accounts', () => {
  it.each([['direct' as const], [null]])(
    'renders nothing when meta_billing is %s',
    (value) => {
      expect(render(value)).toBe('');
    }
  );

  it('renders the five steps of option A, in order, for a managed account', () => {
    const html = render('managed');
    expect(html).toContain('data-testid="managed-setup-checklist"');
    const order = [...html.matchAll(/data-step="([a-zA-Z]+)"/g)].map(
      (m) => m[1]
    );
    expect(order).toEqual([...MANAGED_SETUP_STEPS]);
    for (const step of MANAGED_SETUP_STEPS) {
      expect(html).toContain(es.Settings.managedSetup.steps[step].title);
    }
    expect(html).toContain('Crear el WABA en el Business Manager');
    expect(html).toContain('Registrar el número');
    expect(html).toContain('token de usuario de sistema (permanente)');
    expect(html).toContain('Verificación del nombre visible');
  });

  it('says every Meta step is paperwork in Meta, to verify in the Business Manager', () => {
    const html = render('managed');
    const inMeta = es.Settings.managedSetup.inMeta;
    expect(inMeta).toContain('verificar en el Business Manager');
    expect(html.split(inMeta).length - 1).toBe(META_STEPS.size);
    expect(html.split(es.Settings.managedSetup.inCrm).length - 1).toBe(1);
    expect(html).toContain(es.Settings.managedSetup.localOnly);
  });

  it('names the real buttons and fields of the manual form in the paste step', () => {
    const html = render('managed');
    for (const label of Object.values(LABELS)) {
      expect(html).toContain(label);
    }
  });

  it('carries no link (no Meta URL exists in the repo for these screens)', () => {
    const html = render('managed');
    expect(html).not.toContain('<a');
    expect(html).not.toContain('href=');
    // The icon's own `xmlns` is the only URL allowed in the markup.
    expect(html.replace(/xmlns="[^"]*"/g, '')).not.toMatch(/https?:\/\//);
  });

  it('starts with every box unticked; a ticked one is marked done', () => {
    const fresh = render('managed');
    expect(fresh).not.toContain('data-done="true"');
    expect(fresh.split('data-done="false"').length - 1).toBe(5);

    const some = render('managed', { initialDone: ['waba', 'token'] });
    expect(some.split('data-done="true"').length - 1).toBe(2);
    expect(some).toMatch(/data-step="waba" data-done="true"/);
    expect(some).toMatch(/data-step="number" data-done="false"/);
  });

  it('renders in English with the same structure', () => {
    const html = render('managed', { locale: 'en' });
    expect(html).toContain(en.Settings.managedSetup.title);
    expect(html).toContain('verify in the Business Manager');
    for (const label of Object.values(LABELS)) {
      expect(html).toContain(label);
    }
  });
});

describe('toggleStep (the box state, local only)', () => {
  it('ticks and unticks without touching the input set', () => {
    const start = new Set<ManagedSetupStep>(['waba']);
    const ticked = toggleStep(start, 'number', true);
    expect([...ticked].sort()).toEqual(['number', 'waba']);
    expect([...start]).toEqual(['waba']);
    const unticked = toggleStep(ticked, 'waba', false);
    expect([...unticked]).toEqual(['number']);
    expect([...toggleStep(unticked, 'number', true)]).toEqual(['number']);
  });
});

describe('fetchMetaBilling', () => {
  function client(result: {
    data?: unknown;
    error?: unknown;
    throws?: boolean;
  }) {
    const calls: Array<[string, ...unknown[]]> = [];
    const builder = {
      select: (...args: unknown[]) => {
        calls.push(['select', ...args]);
        return builder;
      },
      eq: (...args: unknown[]) => {
        calls.push(['eq', ...args]);
        return builder;
      },
      maybeSingle: () => {
        if (result.throws) return Promise.reject(new Error('network'));
        return Promise.resolve({
          data: result.data ?? null,
          error: result.error ?? null,
        });
      },
    };
    const from = vi.fn((table: string) => {
      calls.push(['from', table]);
      return builder;
    });
    return { supabase: { from } as unknown as SupabaseClient, calls };
  }

  it("reads only the account's own subscription row, scoped by account_id", async () => {
    const { supabase, calls } = client({ data: { meta_billing: 'managed' } });
    await expect(fetchMetaBilling(supabase, 'acct-a')).resolves.toBe('managed');
    expect(calls).toEqual([
      ['from', 'subscriptions'],
      ['select', 'meta_billing'],
      ['eq', 'account_id', 'acct-a'],
    ]);
  });

  it.each([
    [{ meta_billing: 'direct' }, 'direct'],
    [{ meta_billing: 'something-else' }, 'direct'],
    [null, 'direct'],
  ])('reads %j as %s', async (data, expected) => {
    const { supabase } = client({ data });
    await expect(fetchMetaBilling(supabase, 'acct-a')).resolves.toBe(expected);
  });

  it('a failed read is unknown (null), never managed', async () => {
    const failed = client({ error: { message: 'boom' } });
    await expect(fetchMetaBilling(failed.supabase, 'acct-a')).resolves.toBe(
      null
    );
    const thrown = client({ throws: true });
    await expect(fetchMetaBilling(thrown.supabase, 'acct-a')).resolves.toBe(
      null
    );
  });
});

describe('Settings → WhatsApp wires the checklist to meta_billing', () => {
  const source = readFileSync(
    path.join(process.cwd(), 'src/components/settings/whatsapp-config.tsx'),
    'utf8'
  );

  it('reads meta_billing for the current account and hands it to the checklist', () => {
    expect(source).toContain('fetchMetaBilling(supabase, accountId)');
    expect(source).toMatch(
      /<ManagedSetupChecklist\s+metaBilling=\{metaBilling\}/
    );
  });

  it('opens the manual fold by default only for managed accounts', () => {
    expect(source).toContain(
      "metaBilling === 'managed' ? ['manual'] : undefined"
    );
  });
});

describe('Settings.managedSetup keys (CP6: es and en)', () => {
  function leaves(node: unknown, prefix = ''): string[] {
    if (typeof node === 'string') return [prefix];
    return Object.entries(node as Record<string, unknown>).flatMap(([k, v]) =>
      leaves(v, prefix ? `${prefix}.${k}` : k)
    );
  }

  it('has the same keys in es and en', () => {
    expect(leaves(es.Settings.managedSetup).sort()).toEqual(
      leaves(en.Settings.managedSetup).sort()
    );
  });

  it('the paste step carries the same placeholders in both catalogues', () => {
    const names = (s: string) =>
      [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    expect(names(es.Settings.managedSetup.steps.paste.body)).toEqual(
      Object.keys(LABELS).sort()
    );
    expect(names(en.Settings.managedSetup.steps.paste.body)).toEqual(
      Object.keys(LABELS).sort()
    );
  });
});
