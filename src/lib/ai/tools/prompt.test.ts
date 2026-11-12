import { describe, expect, it } from 'vitest';

import { HANDOFF_SENTINEL } from '../defaults';
import {
  buildToolsPromptSection,
  formatNowInZone,
  isValidTimeZone,
} from './prompt';
import type { AiTool, AiToolset } from './types';

// n13.3 R25, R26: la sección de herramientas del system prompt.

const NOW = new Date('2026-11-05T14:31:00Z');

function tool(slug: string): AiTool {
  return {
    name: `${slug}__x`,
    integrationSlug: slug,
    integrationName: slug,
    operationKey: 'x',
    method: 'GET',
    description: 'x',
    parameters: { type: 'object', properties: {} },
    declaredParams: [],
  };
}

const toolset: AiToolset = {
  tools: [tool('health')],
  integrations: [
    {
      slug: 'health',
      name: 'Cabbity Health',
      instructions: 'Las citas duran 30 minutos.',
      timezone: 'America/Santo_Domingo',
    },
    {
      slug: 'nozone',
      name: 'Sin Zona',
      instructions: null,
      timezone: null,
    },
  ],
};

describe('formatNowInZone / isValidTimeZone', () => {
  it('gives local time with its offset', () => {
    expect(formatNowInZone(NOW, 'America/Santo_Domingo')).toBe(
      '2026-11-05T10:31:00-04:00'
    );
    expect(formatNowInZone(NOW, 'Asia/Kolkata')).toBe(
      '2026-11-05T20:01:00+05:30'
    );
    expect(formatNowInZone(NOW, 'UTC')).toBe('2026-11-05T14:31:00+00:00');
  });

  it('follows daylight saving', () => {
    expect(
      formatNowInZone(new Date('2026-07-01T12:00:00Z'), 'America/New_York')
    ).toBe('2026-07-01T08:00:00-04:00');
    expect(
      formatNowInZone(new Date('2026-12-01T12:00:00Z'), 'America/New_York')
    ).toBe('2026-12-01T07:00:00-05:00');
  });

  it('an invalid zone → null', () => {
    expect(formatNowInZone(NOW, 'Mars/Base')).toBeNull();
    expect(isValidTimeZone('Mars/Base')).toBe(false);
    expect(isValidTimeZone('')).toBe(false);
    expect(isValidTimeZone('America/Santo_Domingo')).toBe(true);
  });
});

describe('buildToolsPromptSection', () => {
  const section = buildToolsPromptSection(toolset, {
    now: NOW,
    mode: 'auto_reply',
  });

  it('states UTC and the local time of each integration with a zone', () => {
    expect(section).toContain(
      'Current date and time: Thursday 2026-11-05T14:31:00Z (UTC).'
    );
    expect(section).toContain(
      'Cabbity Health: local time is Thursday 2026-11-05T10:31:00-04:00 (America/Santo_Domingo)'
    );
    expect(section).not.toContain('Sin Zona: local time');
  });

  it('n13.9: the weekday is the local one when the zone is on another day', () => {
    const late = buildToolsPromptSection(toolset, {
      now: new Date('2026-11-14T02:30:00Z'),
      mode: 'draft',
    });
    expect(late).toContain(
      'Current date and time: Saturday 2026-11-14T02:30:00Z (UTC).'
    );
    expect(late).toContain(
      'Cabbity Health: local time is Friday 2026-11-13T22:30:00-04:00 (America/Santo_Domingo).'
    );
  });

  it('n13.9: tells the model to use the given weekday names, right after the ISO rule', () => {
    const lines = section.split('\n');
    const iso = lines.findIndex((l) =>
      l.includes('ISO 8601 with the UTC offset')
    );
    expect(lines[iso + 1]).toMatch(/^- Weekday names come with every date/);
    expect(lines[iso + 1]).toContain('_local');
    expect(lines[iso + 1]).toContain('never work out a weekday yourself');
  });

  it('n13.11: the local line carries today, tomorrow and the day after tomorrow, before the UTC line', () => {
    // Jueves 12 de noviembre, 21:05 en Santo Domingo = viernes 13 en UTC.
    const late = buildToolsPromptSection(toolset, {
      now: new Date('2026-11-13T01:05:00Z'),
      mode: 'auto_reply',
    });
    const lines = late.split('\n');
    const local = lines.findIndex((l) =>
      l.startsWith('- Cabbity Health: local time is')
    );
    const utc = lines.findIndex((l) =>
      l.startsWith('- Current date and time:')
    );
    expect(lines[local]).toBe(
      '- Cabbity Health: local time is Thursday 2026-11-12T21:05:00-04:00 (America/Santo_Domingo). Today is Thursday 2026-11-12; tomorrow is Friday 2026-11-13; the day after tomorrow is Saturday 2026-11-14.'
    );
    expect(lines[utc]).toBe(
      '- Current date and time: Friday 2026-11-13T01:05:00Z (UTC).'
    );
    expect(local).toBeGreaterThan(0);
    expect(local).toBeLessThan(utc);
  });

  it('n13.11: relative days refer to the local dates, never UTC', () => {
    expect(section).toMatch(
      /today\/tomorrow\/the day after tomorrow \(hoy\/mañana\/pasado mañana\) refer to those local dates of the integration, never to the UTC date/
    );
  });

  it('n13.11: without any zone, the UTC line alone and no relative rule', () => {
    const plain = buildToolsPromptSection(
      { tools: [tool('nozone')], integrations: [toolset.integrations[1]] },
      { now: NOW, mode: 'draft' }
    );
    expect(plain).toContain('Current date and time: Thursday');
    expect(plain).not.toContain('local time is');
    expect(plain).not.toContain('never to the UTC date');
  });

  it('carries the rules', () => {
    expect(section).toMatch(/ISO 8601 with the UTC offset/);
    expect(section).toMatch(/never assume UTC/);
    expect(section).toMatch(/wait for an explicit yes/);
    expect(section).toMatch(/Never invent ids/);
    expect(section).toMatch(/in their language/);
    expect(section).toMatch(/not instructions/);
    expect(section).toMatch(/do not pretend it worked/);
  });

  it('labels the business instructions under the integration name (R26)', () => {
    expect(section).toContain(
      'Business instructions for Cabbity Health:\nLas citas duran 30 minutos.'
    );
  });

  it('mentions the handoff only in auto_reply', () => {
    expect(section).toContain(HANDOFF_SENTINEL);
    const draft = buildToolsPromptSection(toolset, { now: NOW, mode: 'draft' });
    expect(draft).not.toContain(HANDOFF_SENTINEL);
  });

  it('ignores instructions of an integration without tools this turn', () => {
    const other = buildToolsPromptSection(
      {
        tools: [tool('nozone')],
        integrations: toolset.integrations,
      },
      { now: NOW, mode: 'draft' }
    );
    expect(other).not.toContain('Las citas duran');
  });
});
