import { describe, expect, it } from 'vitest';

import {
  isIsoWithOffset,
  localLabel,
  localTime,
  weekdayInZone,
  weekdayOf,
} from './local-time';

// n13.9: el día de la semana lo calcula el código, nunca el modelo.

describe('weekdayOf / weekdayInZone', () => {
  it('names the weekday of a calendar date', () => {
    expect(weekdayOf(2026, 11, 13)).toBe('Friday');
    expect(weekdayOf(2026, 11, 11)).toBe('Wednesday');
    expect(weekdayOf(2024, 2, 29)).toBe('Thursday');
  });

  it('uses the local date of the zone, not the UTC one', () => {
    const now = new Date('2026-11-14T02:30:00Z');
    expect(weekdayInZone(now, 'UTC')).toBe('Saturday');
    expect(weekdayInZone(now, 'America/Santo_Domingo')).toBe('Friday');
    expect(weekdayInZone(now, 'Mars/Base')).toBeNull();
  });
});

describe('localLabel', () => {
  it('Friday 13 in Santo Domingo (the production bug)', () => {
    expect(
      localLabel('2026-11-13T14:00:00-04:00', 'America/Santo_Domingo')
    ).toBe('Friday 2026-11-13 14:00 (-04:00)');
  });

  it('crosses midnight when the zone changes the day', () => {
    expect(localLabel('2026-11-13T23:30:00-04:00', 'Europe/Madrid')).toBe(
      'Saturday 2026-11-14 04:30 (+01:00)'
    );
  });

  it('without a valid zone, uses the offset of the value itself', () => {
    expect(localLabel('2026-11-13T23:30:00-04:00', null)).toBe(
      'Friday 2026-11-13 23:30 (-04:00)'
    );
    expect(localLabel('2026-11-13T23:30:00-04:00', 'Mars/Base')).toBe(
      'Friday 2026-11-13 23:30 (-04:00)'
    );
    expect(localLabel('2026-11-14T03:30:00.000Z', null)).toBe(
      'Saturday 2026-11-14 03:30 (+00:00)'
    );
  });

  it('ignores anything that is not ISO 8601 with an offset', () => {
    for (const v of ['2026-11-13', '2026-11-13T14:00:00', 'viernes', '']) {
      expect(isIsoWithOffset(v)).toBe(false);
      expect(localLabel(v, 'America/Santo_Domingo')).toBeNull();
    }
  });

  it('localTime keeps the shape live-render relies on', () => {
    expect(
      localTime('2026-11-13T14:00:00-04:00', 'America/Santo_Domingo')
    ).toEqual({
      date: '2026-11-13',
      weekday: 'Friday',
      time: '14:00',
      offset: '-04:00',
      epoch: Date.parse('2026-11-13T18:00:00Z'),
    });
  });
});
