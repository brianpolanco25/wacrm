import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { AutomationTriggerType } from '@/types';
import {
  OPEN_WINDOW_TRIGGERS,
  SAFE_WINDOW_MS,
  WARN_UTILITY_IN_WINDOW,
  templateWindowWarnings,
  waitDurationMs,
  type WindowStep,
  type WindowTemplate,
} from './template-window';

// p11.5: which `send_template` steps leave with the customer-service
// window still guaranteed open. Pure function — no mocks needed.

const TEMPLATES: WindowTemplate[] = [
  { name: 'order_update', language: 'es', category: 'Utility' },
  { name: 'promo', language: 'es', category: 'Marketing' },
  { name: 'otp', language: 'es', category: 'Authentication' },
  // Same name in two languages, different categories.
  { name: 'welcome', language: 'es', category: 'Utility' },
  { name: 'welcome', language: 'en_US', category: 'Marketing' },
  // No language stored → defaults to en_US, like SendTemplateFields.
  { name: 'legacy', language: null, category: 'Utility' },
];

let n = 0;
function tpl(template_name: string, language = 'es'): WindowStep {
  return {
    cid: `t${++n}`,
    step_type: 'send_template',
    step_config: { template_name, language },
  };
}
function wait(amount: number, unit: string): WindowStep {
  return { cid: `w${++n}`, step_type: 'wait', step_config: { amount, unit } };
}
function cond(yes: WindowStep[], no: WindowStep[]): WindowStep {
  return {
    cid: `c${++n}`,
    step_type: 'condition',
    step_config: { subject: 'tag_presence', operand: 'x' },
    branches: { yes, no },
  };
}

function warn(
  steps: WindowStep[],
  trigger: AutomationTriggerType = 'keyword_match',
  opts?: { warnUtility?: boolean }
) {
  return templateWindowWarnings(trigger, steps, TEMPLATES, opts);
}

describe('templateWindowWarnings — triggers (R1)', () => {
  it.each([
    ['new_message_received', true],
    ['first_inbound_message', true],
    ['keyword_match', true],
    ['interactive_reply', true],
    ['new_contact_created', true],
    ['conversation_assigned', false],
    ['tag_added', false],
    ['time_based', false],
  ] as const)('%s → warns: %s', (trigger, warns) => {
    const step = tpl('order_update');
    const got = warn([step], trigger);
    expect(got.get(step.cid)).toBe(warns ? 'utility' : undefined);
    expect(OPEN_WINDOW_TRIGGERS.includes(trigger)).toBe(warns);
  });
});

describe('templateWindowWarnings — waits (R2)', () => {
  it.each([
    ['wait 22 h', [wait(22, 'hours')], true],
    ['wait 23 h', [wait(23, 'hours')], false],
    ['wait 1 day', [wait(1, 'days')], false],
    ['two waits of 12 h', [wait(12, 'hours'), wait(12, 'hours')], false],
    ['wait 90 minutes', [wait(90, 'minutes')], true],
    ['no wait', [], true],
  ] as const)('%s → warns: %s', (_label, waits, warns) => {
    const step = tpl('order_update');
    const got = warn([...waits, step]);
    expect(got.has(step.cid)).toBe(warns);
  });

  it('a wait after the template does not matter', () => {
    const step = tpl('order_update');
    expect(warn([step, wait(3, 'days')]).has(step.cid)).toBe(true);
  });

  it('SAFE_WINDOW_MS is 23 h', () => {
    expect(SAFE_WINDOW_MS).toBe(23 * 3_600_000);
  });
});

describe('templateWindowWarnings — conditions (R3)', () => {
  it('in a branch: parent waits up to the condition + branch waits before it', () => {
    const inYes = tpl('order_update');
    const got = warn([wait(21, 'hours'), cond([wait(2, 'hours'), inYes], [])]);
    expect(got.has(inYes.cid)).toBe(false);
  });

  it('in a branch with little waiting → warns', () => {
    const inNo = tpl('promo');
    const got = warn([wait(1, 'hours'), cond([], [wait(2, 'hours'), inNo])]);
    expect(got.get(inNo.cid)).toBe('marketing');
  });

  it('after the condition: the longest branch decides (30 h in `no`)', () => {
    const after = tpl('order_update');
    const got = warn([cond([], [wait(30, 'hours')]), after]);
    expect(got.has(after.cid)).toBe(false);
  });

  it('after the condition with no waits in either branch → warns', () => {
    const after = tpl('order_update');
    const got = warn([cond([tpl('otp')], []), after]);
    expect(got.get(after.cid)).toBe('utility');
  });

  it('nested conditions accumulate', () => {
    const deep = tpl('promo');
    const got = warn([
      wait(12, 'hours'),
      cond([cond([wait(11, 'hours'), deep], [])], []),
    ]);
    expect(got.has(deep.cid)).toBe(false);
  });
});

describe('templateWindowWarnings — categories (R4)', () => {
  it.each([
    ['order_update', 'utility'],
    ['promo', 'marketing'],
    ['otp', undefined],
  ] as const)('%s → %s', (name, expected) => {
    const step = tpl(name);
    expect(warn([step]).get(step.cid)).toBe(expected);
  });

  it('same name in two languages: the step language wins', () => {
    const es = tpl('welcome', 'es');
    const en = tpl('welcome', 'en_US');
    const got = warn([es, en]);
    expect(got.get(es.cid)).toBe('utility');
    expect(got.get(en.cid)).toBe('marketing');
  });

  it('missing language on step and template both default to en_US', () => {
    const step: WindowStep = {
      cid: 'legacy',
      step_type: 'send_template',
      step_config: { template_name: 'legacy', language: '' },
    };
    expect(warn([step]).get('legacy')).toBe('utility');
  });

  it('unknown template or none picked → nothing', () => {
    const unknown = tpl('not_synced');
    const empty = tpl('');
    const got = warn([unknown, empty]);
    expect(got.size).toBe(0);
  });

  it('no templates loaded yet → empty map', () => {
    const step = tpl('promo');
    expect(templateWindowWarnings('keyword_match', [step], []).size).toBe(0);
  });

  it('only send_template steps are flagged', () => {
    const got = warn([
      { cid: 'm', step_type: 'send_message', step_config: { text: 'hi' } },
    ]);
    expect(got.size).toBe(0);
  });
});

describe('templateWindowWarnings — WARN_UTILITY_IN_WINDOW (R5)', () => {
  it('defaults to true', () => {
    expect(WARN_UTILITY_IN_WINDOW).toBe(true);
  });

  it('warnUtility: false drops utility but keeps marketing', () => {
    const u = tpl('order_update');
    const m = tpl('promo');
    const got = warn([u, m], 'keyword_match', { warnUtility: false });
    expect(got.has(u.cid)).toBe(false);
    expect(got.get(m.cid)).toBe('marketing');
  });
});

describe('waitDurationMs — same as the engine waitMs', () => {
  it.each([
    [{ amount: 5, unit: 'minutes' }, 300_000],
    [{ amount: 2, unit: 'hours' }, 7_200_000],
    [{ amount: 1, unit: 'days' }, 86_400_000],
    [{ amount: 0, unit: 'hours' }, 1_000],
    [{ amount: -3, unit: 'days' }, 1_000],
    [{ amount: 3 }, 180_000],
    [{ unit: 'hours' }, 1_000],
  ] as const)('%o → %i ms', (cfg, ms) => {
    expect(waitDurationMs(cfg as never)).toBe(ms);
  });
});

describe('purity (R6)', () => {
  it('imports nothing but types', () => {
    const src = readFileSync(
      path.join(__dirname, 'template-window.ts'),
      'utf8'
    );
    const imports = src.match(/^import\s.*$/gm) ?? [];
    expect(imports.length).toBeGreaterThan(0);
    for (const line of imports) expect(line).toMatch(/^import type /);
    expect(src).not.toMatch(/\bfetch\(|Date\.now|new Date|window\./);
  });
});
