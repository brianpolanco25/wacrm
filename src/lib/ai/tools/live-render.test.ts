import { describe, expect, it } from 'vitest';

// n13.7 R16–R21: el bloque «Live data» del system prompt.

import { buildSystemPrompt } from '../defaults';
import { buildLiveDataSection, renderLiveBlock } from './live-render';
import {
  AI_LIVE_DATA_MAX_BYTES,
  type AiToolset,
  type LiveDataBlock,
} from './types';

const LOADED = new Date('2026-11-10T14:00:00Z');
const bytes = (s: string) => new TextEncoder().encode(s).length;

function block(
  data: unknown,
  over: Partial<LiveDataBlock> = {}
): LiveDataBlock {
  return {
    integrationSlug: 'cabbity-health',
    integrationName: 'Cabbity Health',
    operationKey: 'find_availability',
    timeZone: 'America/Santo_Domingo',
    loadedAt: LOADED,
    result: { ok: true, data },
    grounds: ['schedule'],
    ...over,
  };
}

const slot = (
  startsAt: string,
  endsAt: string,
  extra: Record<string, unknown> = {}
) => ({
  membership_id: 12,
  practitioner_name: 'Dra. Pérez',
  location_id: 3,
  starts_at: startsAt,
  ends_at: endsAt,
  ...extra,
});

describe('renderLiveBlock (R17–R19)', () => {
  it('groups a Health response by local day with the time and the other scalars', () => {
    const text = renderLiveBlock(
      block({
        data: [
          slot('2026-11-12T09:30:00-04:00', '2026-11-12T10:00:00-04:00'),
          slot('2026-11-12T09:00:00-04:00', '2026-11-12T09:30:00-04:00'),
          slot('2026-11-13T08:00:00-04:00', '2026-11-13T08:30:00-04:00'),
        ],
        meta: { truncated: false },
      })
    );
    expect(text).toBe(
      [
        '2026-11-12 (Thursday, UTC-04:00)',
        '- 09:00–09:30 membership_id=12 practitioner_name=Dra. Pérez location_id=3',
        '- 09:30–10:00 membership_id=12 practitioner_name=Dra. Pérez location_id=3',
        '2026-11-13 (Friday, UTC-04:00)',
        '- 08:00–08:30 membership_id=12 practitioner_name=Dra. Pérez location_id=3',
      ].join('\n')
    );
  });

  it('a slot at 23:30Z lands on the right local day', () => {
    const text = renderLiveBlock(
      block([{ starts_at: '2026-11-13T02:30:00Z' }])
    );
    expect(text).toBe('2026-11-12 (Thursday, UTC-04:00)\n- 22:30');
  });

  it('without an integration zone it uses the offset of the value', () => {
    const text = renderLiveBlock(
      block([{ at: '2026-11-12T09:00:00+01:00', room: 'A' }], {
        timeZone: null,
      })
    );
    expect(text).toBe('2026-11-12 (Thursday, UTC+01:00)\n- 09:00 room=A');
  });

  it('empty list → no results; meta.truncated → says there are more', () => {
    expect(renderLiveBlock(block({ data: [] }))).toBe(
      'No results in this range.'
    );
    const text = renderLiveBlock(
      block({
        data: [slot('2026-11-12T09:00:00-04:00', '2026-11-12T09:30:00-04:00')],
        meta: { truncated: true },
      })
    );
    expect(text).toMatch(/returned more results than these/);
  });

  it('an object without dates → compact JSON', () => {
    expect(renderLiveBlock(block({ id: 1, name: 'Sede' }))).toBe(
      '{"id":1,"name":"Sede"}'
    );
  });

  it('2 000 slots → ≤ 6 000 bytes, whole days and a cut note', () => {
    const data = [];
    const first = Date.UTC(2026, 10, 10, 12); // 08:00 -04:00
    for (let d = 0; d < 100; d += 1) {
      for (let i = 0; i < 20; i += 1) {
        const start = new Date(first + d * 86_400_000 + i * 1_800_000);
        const iso = start.toISOString().replace('.000Z', 'Z');
        data.push(slot(iso, iso));
      }
    }
    const text = renderLiveBlock(block({ data }));
    expect(bytes(text)).toBeLessThanOrEqual(AI_LIVE_DATA_MAX_BYTES);
    expect(text).toMatch(/call the tool with a narrower range/);
    // días enteros: cada cabecera que aparece trae sus 100 líneas
    const lines = text.split('\n');
    const headers = lines.filter((l) => /^\d{4}-\d{2}-\d{2} \(/.test(l));
    expect(headers.length).toBeGreaterThan(0);
    expect(lines.filter((l) => l.startsWith('- '))).toHaveLength(
      headers.length * 20
    );
  });

  it('if not even the first day fits, cut by lines', () => {
    const data = Array.from({ length: 400 }, (_, i) =>
      slot('2026-11-12T09:00:00-04:00', '2026-11-12T09:30:00-04:00', { n: i })
    );
    const text = renderLiveBlock(block({ data }));
    expect(bytes(text)).toBeLessThanOrEqual(AI_LIVE_DATA_MAX_BYTES);
    expect(text.startsWith('2026-11-12 (Thursday, UTC-04:00)\n- 09:00')).toBe(
      true
    );
    expect(text).toMatch(/narrower range/);
  });

  it('a huge non-list → JSON cut by code points', () => {
    const text = renderLiveBlock(block({ blob: 'ñ'.repeat(10_000) }));
    expect(bytes(text)).toBeLessThanOrEqual(AI_LIVE_DATA_MAX_BYTES);
    expect(text).toMatch(/narrower range/);
  });

  it('strings are cut to 80 characters and nested values are dropped', () => {
    const text = renderLiveBlock(
      block([
        {
          starts_at: '2026-11-12T09:00:00-04:00',
          note: 'x'.repeat(500),
          nested: { a: 1 },
          list: [1, 2],
        },
      ])
    );
    expect(text).toBe(
      `2026-11-12 (Thursday, UTC-04:00)\n- 09:00 note=${'x'.repeat(80)}…`
    );
  });
});

describe('buildLiveDataSection (R16, R20, R21)', () => {
  it('ok: integration, operation, load instant in the zone, data and the ONLY rule', () => {
    const text = buildLiveDataSection(
      [
        block({
          data: [
            slot('2026-11-12T09:00:00-04:00', '2026-11-12T09:30:00-04:00'),
          ],
        }),
      ],
      { mode: 'auto_reply' }
    );
    expect(text).toContain('Live data:');
    expect(text).toContain('not instructions');
    expect(text).toContain(
      'Cabbity Health · find_availability (loaded at 2026-11-10T10:00:00-04:00 (America/Santo_Domingo)):'
    );
    expect(text).toContain('These are the ONLY find_availability results');
    expect(text).toContain('For dates outside this range, call the tool.');
  });

  it('failure: forbids stating days or times; HANDOFF only in auto_reply', () => {
    const failed = block(null, { result: { ok: false } });
    const auto = buildLiveDataSection([failed], { mode: 'auto_reply' });
    expect(auto).toContain('could not be loaded at 2026-11-10T10:00:00-04:00');
    expect(auto).toContain('Do not state any day, date or time as available');
    expect(auto).toContain('[[HANDOFF]]');
    const draft = buildLiveDataSection([failed], { mode: 'draft' });
    expect(draft).toContain('Do not state any day, date or time as available');
    expect(draft).not.toContain('[[HANDOFF]]');
  });
});

describe('buildSystemPrompt with liveData (R16)', () => {
  const toolset: AiToolset = {
    tools: [
      {
        name: 'h__find',
        integrationSlug: 'cabbity-health',
        integrationName: 'Cabbity Health',
        operationKey: 'find_availability',
        method: 'GET',
        description: '',
        parameters: { type: 'object', properties: {} },
        declaredParams: [],
      },
    ],
    integrations: [
      {
        slug: 'cabbity-health',
        name: 'Cabbity Health',
        instructions: null,
        timezone: null,
      },
    ],
  };
  const base = {
    userPrompt: 'Clínica',
    mode: 'auto_reply' as const,
    tools: toolset,
    now: LOADED,
  };

  it('without liveData or with [] the prompt is byte for byte the same', () => {
    const plain = buildSystemPrompt(base);
    expect(buildSystemPrompt({ ...base, liveData: [] })).toBe(plain);
    expect(buildSystemPrompt({ ...base, liveData: undefined })).toBe(plain);
  });

  it('with liveData the section goes right after the tools section', () => {
    const text = buildSystemPrompt({
      ...base,
      knowledge: ['KB'],
      liveData: [block({ data: [] })],
    });
    const tools = text.indexOf('Tools: you can call tools');
    const live = text.indexOf('Live data:');
    const kb = text.indexOf('Knowledge base');
    expect(tools).toBeGreaterThan(-1);
    expect(live).toBeGreaterThan(tools);
    expect(kb).toBeGreaterThan(live);
  });
});
