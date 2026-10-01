import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { AutomationTriggerType } from '@/types';
import type {
  WindowStep,
  WindowTemplate,
} from '@/lib/automations/template-window';
import { templateWindowWarnings } from '@/lib/automations/template-window';
import {
  TemplateWindowBadge,
  TemplateWindowNotice,
  TemplateWindowProvider,
  useTemplateWindow,
  type MetaBilling,
} from './template-window-notice';
import { toApiSteps, type BuilderStep } from './automation-builder';

// p11.5 R7–R11. No jsdom in the repo: everything is rendered to static
// markup, and "recalculates" (R10) is checked by rendering the provider
// with the state before and after the change.

type Catalogue = typeof es;
const CATALOGUES = { es, en } as const;
const w = es.Automations.builder.templateWindow;

function withIntl(
  node: React.ReactNode,
  messages: Catalogue = es,
  locale: 'es' | 'en' = 'es'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider locale={locale} timeZone="UTC" messages={messages}>
      {node}
    </NextIntlClientProvider>
  );
}

function notice(
  kind: 'utility' | 'marketing' | undefined,
  metaBilling: MetaBilling | undefined
) {
  return withIntl(
    <TemplateWindowNotice kind={kind} metaBilling={metaBilling} />
  );
}

const quota = w.quotaNote.replace('{freeTier, number}', '1000');

describe('TemplateWindowNotice (R7)', () => {
  it('utility / direct → utility text + quota note + estimate', () => {
    const html = notice('utility', 'direct');
    expect(html).toContain(w.title);
    expect(html).toContain(w.utility);
    expect(html).not.toContain(w.marketing);
    expect(html).toContain(quota);
    expect(html).toContain(w.estimate);
  });

  it('marketing / direct → marketing text + quota note', () => {
    const html = notice('marketing', 'direct');
    expect(html).toContain(w.marketing);
    expect(html).not.toContain(w.utility);
    expect(html).toContain(quota);
  });

  it('utility / managed → no quota note', () => {
    const html = notice('utility', 'managed');
    expect(html).toContain(w.utility);
    expect(html).not.toContain(quota);
    expect(html).toContain(w.estimate);
  });

  it('metaBilling unknown is treated as direct', () => {
    expect(notice('utility', undefined)).toContain(quota);
  });

  it('is advice, not an error: default Alert variant', () => {
    const html = notice('marketing', 'direct');
    expect(html).toContain('role="alert"');
    expect(html).not.toContain('text-destructive');
    expect(html).toContain('text-amber-500');
  });

  it('no kind → renders nothing', () => {
    expect(notice(undefined, 'direct')).toBe('');
  });

  it('the English catalogue renders too', () => {
    const html = withIntl(
      <TemplateWindowNotice kind="utility" metaBilling="direct" />,
      en as Catalogue,
      'en'
    );
    expect(html).toContain(en.Automations.builder.templateWindow.utility);
    expect(html).toContain('1,000');
  });
});

describe('TemplateWindowBadge (R8)', () => {
  it('amber, with an accessible label and title', () => {
    const html = withIntl(<TemplateWindowBadge />);
    expect(html).toContain(`aria-label="${w.badge}"`);
    expect(html).toContain(`title="${w.badge}"`);
    expect(html).toContain('text-amber-500');
  });
});

// ------------------------------------------------------------
// Provider (R10)
// ------------------------------------------------------------

const TEMPLATES: WindowTemplate[] = [
  { name: 'otp', language: 'es', category: 'Authentication' },
  { name: 'order_update', language: 'es', category: 'Utility' },
];

function step(template_name: string): WindowStep {
  return {
    cid: 's1',
    step_type: 'send_template',
    step_config: { template_name, language: 'es' },
  };
}

function Probe() {
  const { warnings, metaBilling } = useTemplateWindow();
  return (
    <>
      <TemplateWindowNotice
        kind={warnings.get('s1')}
        metaBilling={metaBilling}
      />
      {warnings.has('s1') && <TemplateWindowBadge />}
    </>
  );
}

function provided(triggerType: AutomationTriggerType, steps: WindowStep[]) {
  return withIntl(
    <TemplateWindowProvider
      triggerType={triggerType}
      steps={steps}
      templates={TEMPLATES}
      metaBilling="direct"
    >
      <Probe />
    </TemplateWindowProvider>
  );
}

describe('TemplateWindowProvider (R10)', () => {
  it('keyword_match → tag_added removes the notice', () => {
    const steps = [step('order_update')];
    expect(provided('keyword_match', steps)).toContain(w.utility);
    expect(provided('keyword_match', steps)).toContain(w.badge);
    expect(provided('tag_added', steps)).toBe('');
  });

  it('authentication → utility template adds it', () => {
    expect(provided('keyword_match', [step('otp')])).toBe('');
    expect(provided('keyword_match', [step('order_update')])).toContain(
      w.utility
    );
  });

  it('outside a provider → no warnings', () => {
    expect(withIntl(<Probe />)).toBe('');
  });
});

// ------------------------------------------------------------
// Non-blocking (R9)
// ------------------------------------------------------------

describe('toApiSteps is unaffected by the notice (R9)', () => {
  const tree: BuilderStep[] = [
    {
      cid: 'a',
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'es' },
    },
    {
      cid: 'b',
      step_type: 'condition',
      step_config: { subject: 'tag_presence', operand: 'vip' },
      branches: {
        yes: [
          {
            cid: 'c',
            step_type: 'send_template',
            step_config: { template_name: 'otp', language: 'es' },
          },
        ],
        no: [],
      },
    },
  ];

  it('same body with and without a warning', () => {
    const warned = templateWindowWarnings('keyword_match', tree, TEMPLATES);
    const silent = templateWindowWarnings('tag_added', tree, TEMPLATES);
    expect(warned.get('a')).toBe('utility');
    expect(silent.size).toBe(0);
    const body = toApiSteps(tree);
    expect(body).toEqual(toApiSteps(structuredClone(tree)));
    expect(JSON.stringify(body)).not.toMatch(/window|warning|cid/);
    expect(body[0]).toEqual({
      step_type: 'send_template',
      step_config: { template_name: 'order_update', language: 'es' },
      branches: undefined,
    });
  });
});

// ------------------------------------------------------------
// i18n parity (R11)
// ------------------------------------------------------------

function placeholders(s: string): string[] {
  return [...s.matchAll(/\{(\w+)/g)].map((m) => m[1]).sort();
}

describe('templateWindow i18n (R11)', () => {
  const keys = Object.keys(es.Automations.builder.templateWindow).sort();

  it('same keys in es and en', () => {
    expect(Object.keys(en.Automations.builder.templateWindow).sort()).toEqual(
      keys
    );
    expect(keys).toEqual(
      ['badge', 'estimate', 'marketing', 'quotaNote', 'title', 'utility'].sort()
    );
  });

  it.each(Object.keys(CATALOGUES))('%s: same ICU placeholders as es', (loc) => {
    const cat = CATALOGUES[loc as keyof typeof CATALOGUES].Automations.builder
      .templateWindow as Record<string, string>;
    const base = w as Record<string, string>;
    for (const k of keys) {
      expect(cat[k].length).toBeGreaterThan(0);
      expect(placeholders(cat[k])).toEqual(placeholders(base[k]));
    }
  });
});
