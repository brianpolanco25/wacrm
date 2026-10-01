// ============================================================
// Template sent with the customer-service window open (p11.5).
//
// When an automation answers an inbound message, the 24 h customer
// service window is open and a plain text reply is a *service* message.
// A template sent in that same window is billed at its own category's
// rate instead: utility at the utility rate (S-U1), marketing at the
// marketing rate — the most expensive one (S-U2). The builder uses this
// to nudge the author towards a plain text; it is advice only and never
// blocks a save.
//
// Pure on purpose: no fetch, no Supabase, no clock, no `window`, and
// only type imports, so a client component can call it without pulling
// server code. That is also why it does not import `waitMs` from the
// engine (private, in a module that imports `supabaseAdmin`): the
// conversion is duplicated below and pinned by a test.
// ============================================================

import type { AutomationTriggerType, WaitStepConfig } from '@/types';

/**
 * S-U1 (unverified Meta rule). Set to `false` if Meta confirms that a
 * utility template delivered inside the open window is free: that turns
 * off only the utility notice; the marketing one stays.
 */
export const WARN_UTILITY_IN_WINDOW = true;

/** S-U3/S-U4: 24 h window minus 1 h of slack for the automations cron. */
export const SAFE_WINDOW_MS = 23 * 60 * 60 * 1000;

/**
 * Free service messages per number and month. Mirrors
 * SERVICE_FREE_TIER_PER_NUMBER (p11.3, server-only module); here only
 * for the notice text. Keep both in step if Meta changes it.
 */
export const FREE_SERVICE_MESSAGES_PER_NUMBER = 1000;

/** Triggers the webhook fires from an inbound customer message. */
export const OPEN_WINDOW_TRIGGERS: readonly AutomationTriggerType[] = [
  'new_message_received',
  'first_inbound_message',
  'keyword_match',
  'interactive_reply',
  'new_contact_created',
];

export type TemplateWindowWarning = 'utility' | 'marketing';

/** The minimum of the builder's step node this needs. */
export interface WindowStep {
  cid: string;
  step_type: string;
  step_config: Record<string, unknown>;
  branches?: { yes: WindowStep[]; no: WindowStep[] };
}

/** The minimum of a synced `message_templates` row this needs. */
export interface WindowTemplate {
  name: string;
  language?: string | null;
  category: string;
}

const DEFAULT_LANGUAGE = 'en_US';

/**
 * Same conversion as the engine's `waitMs`: days, hours, otherwise
 * minutes; never under 1 s. A non-numeric amount yields 1 s (the engine
 * would get NaN there; validation never lets one through).
 */
export function waitDurationMs(cfg: Partial<WaitStepConfig>): number {
  const unitMs =
    cfg.unit === 'days'
      ? 86_400_000
      : cfg.unit === 'hours'
        ? 3_600_000
        : 60_000;
  const amount = Number(cfg.amount);
  if (!Number.isFinite(amount)) return 1_000;
  return Math.max(1_000, amount * unitMs);
}

/**
 * Which `send_template` steps (by `cid`) go out with the window still
 * guaranteed open, and what to warn about. Empty map when the trigger
 * does not come from an inbound message.
 */
export function templateWindowWarnings(
  triggerType: AutomationTriggerType,
  steps: WindowStep[],
  templates: WindowTemplate[],
  opts: { warnUtility?: boolean } = {}
): Map<string, TemplateWindowWarning> {
  const out = new Map<string, TemplateWindowWarning>();
  if (!OPEN_WINDOW_TRIGGERS.includes(triggerType)) return out;
  const warnUtility = opts.warnUtility ?? WARN_UTILITY_IN_WINDOW;

  const categoryOf = (cfg: Record<string, unknown>): string | null => {
    const name = typeof cfg.template_name === 'string' ? cfg.template_name : '';
    if (!name) return null;
    const lang =
      (typeof cfg.language === 'string' && cfg.language) || DEFAULT_LANGUAGE;
    const tmpl = templates.find(
      (t) => t.name === name && (t.language ?? DEFAULT_LANGUAGE) === lang
    );
    return tmpl?.category ?? null;
  };

  // Walks one scope in order and returns the elapsed time at its end.
  const walk = (list: WindowStep[], start: number): number => {
    let elapsed = start;
    for (const step of list) {
      if (step.step_type === 'wait') {
        elapsed += waitDurationMs(step.step_config as Partial<WaitStepConfig>);
      } else if (step.step_type === 'condition') {
        const yes = walk(step.branches?.yes ?? [], elapsed);
        const no = walk(step.branches?.no ?? [], elapsed);
        // Conservative: the longer branch decides for what follows.
        elapsed = Math.max(yes, no);
      } else if (
        step.step_type === 'send_template' &&
        elapsed < SAFE_WINDOW_MS
      ) {
        const category = categoryOf(step.step_config);
        if (category === 'Utility' && warnUtility) out.set(step.cid, 'utility');
        else if (category === 'Marketing') out.set(step.cid, 'marketing');
      }
    }
    return elapsed;
  };

  walk(steps, 0);
  return out;
}
