import { describe, it, expect } from 'vitest';
import { parseIdleMinutes, isIdleSince } from './idle';

describe('parseIdleMinutes', () => {
  it('accepts a positive whole number, as a number or as the builder string', () => {
    expect(parseIdleMinutes(1440)).toBe(1440);
    expect(parseIdleMinutes('1440')).toBe(1440);
    expect(parseIdleMinutes(' 60 ')).toBe(60);
  });

  it('rejects zero, negatives, fractions, blanks and junk', () => {
    for (const bad of [0, -5, 1.5, '', '  ', 'abc', null, undefined, '1e400']) {
      expect(parseIdleMinutes(bad)).toBeNull();
    }
  });
});

describe('isIdleSince', () => {
  const now = Date.parse('2026-10-24T12:00:00Z');

  it('is idle once the last customer message is at least N minutes old', () => {
    expect(isIdleSince('2026-10-23T11:59:00Z', 1440, now)).toBe(true);
    expect(isIdleSince('2026-10-23T12:00:00Z', 1440, now)).toBe(true);
  });

  it('is not idle while the customer wrote within the window', () => {
    expect(isIdleSince('2026-10-23T12:00:01Z', 1440, now)).toBe(false);
    expect(isIdleSince('2026-10-24T11:00:00Z', 1440, now)).toBe(false);
  });

  it('treats a thread the customer never wrote to as idle', () => {
    expect(isIdleSince(null, 60, now)).toBe(true);
  });

  it('fails closed on an unparseable timestamp', () => {
    expect(isIdleSince('not a date', 60, now)).toBe(false);
  });
});
