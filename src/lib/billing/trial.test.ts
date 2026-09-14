import { describe, expect, it } from 'vitest';

import { trialNotice } from './trial';

// ============================================================
// p6.2 §2: the countdown is only about `trialing`, it counts whole
// days, and below one day it stops counting and says "today".
// ============================================================

const NOW = Date.parse('2026-09-14T12:00:00.000Z');
const DAY = 86_400_000;

/** ISO timestamp `days` days away from NOW. */
function inDays(days: number): string {
  return new Date(NOW + days * DAY).toISOString();
}

describe('trialNotice', () => {
  it('counts the days left while the subscription is trialing', () => {
    expect(trialNotice('trialing', inDays(5), NOW)).toEqual({
      kind: 'days',
      days: 5,
    });
  });

  it('rounds up to the whole day, the way people count days left', () => {
    // A 14-day trial has to read "14 days" on the day it starts, not
    // "13" because milliseconds passed between the INSERT and the
    // render.
    expect(trialNotice('trialing', inDays(4.5), NOW)).toEqual({
      kind: 'days',
      days: 5,
    });
    // One millisecond into a 5-day trial: still 5.
    expect(trialNotice('trialing', inDays(5), NOW + 1)).toEqual({
      kind: 'days',
      days: 5,
    });
  });

  it('says "1 day" on the last full day', () => {
    expect(trialNotice('trialing', inDays(1), NOW)).toEqual({
      kind: 'days',
      days: 1,
    });
  });

  it('says "today" with less than a full day left', () => {
    expect(trialNotice('trialing', inDays(0.4), NOW)).toEqual({
      kind: 'today',
    });
  });

  it('still says "today" when the deadline already passed but the row says trialing', () => {
    // The window between `trial_ends_at` and whatever moves the row off
    // `trialing`. "In -1 days" is not a sentence; today is still the
    // truthful last day.
    expect(trialNotice('trialing', inDays(-3), NOW)).toEqual({ kind: 'today' });
  });

  it('says nothing once the account contracted a plan', () => {
    expect(trialNotice('active', inDays(5), NOW)).toBeNull();
  });

  it.each(['past_due', 'suspended', 'cancelled', 'expired'])(
    'says nothing on the %s rung — the dunning alert owns that one',
    (status) => {
      expect(trialNotice(status, inDays(-1), NOW)).toBeNull();
    }
  );

  it('says nothing when there is no account, no status or no deadline', () => {
    expect(trialNotice(null, inDays(5), NOW)).toBeNull();
    expect(trialNotice(undefined, inDays(5), NOW)).toBeNull();
    // `trial_ends_at` is nullable: no deadline, no number to invent.
    expect(trialNotice('trialing', null, NOW)).toBeNull();
    expect(trialNotice('trialing', 'not-a-date', NOW)).toBeNull();
  });
});
