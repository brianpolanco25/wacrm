import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { NextIntlClientProvider } from 'next-intl';

import en from '../../../messages/en.json';
import es from '../../../messages/es.json';
import type { AiLiveRead, AiReadOperation } from '@/lib/ai/tools/types';
import {
  addLiveRead,
  IntegrationLiveReads,
  removeLiveRead,
  setLiveReadOperation,
  setLiveReadParam,
} from './integration-live-reads';
import { aiSettingsBody, liveReadsErrorOf } from './integrations-settings';

// n13.7 R7, R8: «Datos en vivo antes de responder». Marcado estático y
// las transformaciones puras del valor.

const CATALOGUES = { en, es } as const;

const OPS: AiReadOperation[] = [
  {
    key: 'find_availability',
    name: 'Buscar disponibilidad',
    params: [
      {
        name: 'location_id',
        type: 'integer',
        required: true,
        description: 'Sede',
      },
      { name: 'from', type: 'string', required: true, description: 'Desde' },
      {
        name: 'mode',
        type: 'string',
        required: false,
        description: '',
        enum: ['fast', 'full'],
      },
      { name: 'only_free', type: 'boolean', required: false, description: '' },
    ],
  },
  { key: 'list_locations', name: 'Sedes', params: [] },
];
const READ: AiLiveRead = {
  operation: 'find_availability',
  params: { location_id: 3, from: '{{today}}' },
};

function render(
  props: Partial<React.ComponentProps<typeof IntegrationLiveReads>> = {},
  locale: keyof typeof CATALOGUES = 'es'
) {
  return renderToStaticMarkup(
    <NextIntlClientProvider
      locale={locale}
      timeZone="UTC"
      messages={CATALOGUES[locale]}
    >
      <IntegrationLiveReads
        operations={OPS}
        value={[]}
        onChange={() => {}}
        {...props}
      />
    </NextIntlClientProvider>
  );
}

/** The `disabled` attribute (not the `disabled:` Tailwind variants). */
const DISABLED = /\sdisabled(=""|\s|>)/;

function tagWith(html: string, attr: string): string {
  const at = html.indexOf(attr);
  const start = html.lastIndexOf('<', at);
  return html.slice(start, html.indexOf('>', at) + 1);
}

describe('IntegrationLiveReads (R7)', () => {
  it('empty: says so, shows the template help and an enabled Add', () => {
    const html = render();
    expect(html).toContain(es.Settings.integrations.aiLiveEmpty);
    expect(html).toContain('{{today}}');
    expect(html).toContain('{{today+13d}}');
    expect(tagWith(html, 'data-action="live-add"')).not.toMatch(DISABLED);
  });

  it('with 3 reads, Add is disabled and the max is shown', () => {
    const html = render({ value: [READ, READ, READ] });
    expect(tagWith(html, 'data-action="live-add"')).toMatch(DISABLED);
    expect(html).toContain('data-live-max');
    expect(html.match(/data-live-read=/g)).toHaveLength(3);
  });

  it('a numeric input for integer, a select for enum, text for string', () => {
    const html = render({ value: [READ] });
    expect(tagWith(html, 'data-live-param="location_id"')).toContain(
      'type="number"'
    );
    expect(tagWith(html, 'data-live-param="from"')).toContain('type="text"');
    expect(tagWith(html, 'data-live-param="mode"')).toMatch(/^<select/);
    expect(html).toContain('role="switch"');
  });

  it('an integer with a template is a text input', () => {
    const html = render({
      value: [
        {
          operation: 'find_availability',
          params: { location_id: '{{today}}' },
        },
      ],
    });
    expect(tagWith(html, 'data-live-param="location_id"')).toContain(
      'type="text"'
    );
  });

  it('shows the 400 error inline', () => {
    const html = render({ value: [READ], error: 'bad read' });
    expect(tagWith(html, 'data-live-error')).toContain('role="alert"');
    expect(html).toContain('bad read');
  });

  it('a stored read whose operation is no longer readable is marked stale', () => {
    const html = render({
      value: [READ, { operation: 'create_appointment', params: {} }],
    });
    expect(html.match(/data-live-stale/g)).toHaveLength(1);
    expect(html).toContain(es.Settings.integrations.aiLiveStale);
    expect(render({ value: [READ] })).not.toContain('data-live-stale');
  });

  it('is translated in en', () => {
    const html = render({}, 'en');
    expect(html).toContain(en.Settings.integrations.aiLiveTitle);
    expect(html).not.toContain('Settings.integrations.');
  });
});

describe('live reads value helpers (R7)', () => {
  it('add up to 3 with the first operation; remove one', () => {
    let v: AiLiveRead[] = [];
    for (let i = 0; i < 4; i += 1) v = addLiveRead(v, OPS);
    expect(v).toHaveLength(3);
    expect(v[0]).toEqual({ operation: 'find_availability', params: {} });
    expect(removeLiveRead(v, 1)).toHaveLength(2);
    expect(addLiveRead([], [])).toEqual([]);
  });

  it('changing the operation clears its params', () => {
    expect(setLiveReadOperation([READ], 0, 'list_locations')).toEqual([
      { operation: 'list_locations', params: {} },
    ]);
  });

  it('param values: numbers for numeric params, templates kept as text, empty removes', () => {
    const int = { name: 'location_id', type: 'integer' as const };
    expect(setLiveReadParam([READ], 0, int, '7')[0].params.location_id).toBe(7);
    expect(
      setLiveReadParam([READ], 0, int, '{{today}}')[0].params.location_id
    ).toBe('{{today}}');
    expect(
      'location_id' in setLiveReadParam([READ], 0, int, '')[0].params
    ).toBe(false);
    expect(
      setLiveReadParam(
        [READ],
        0,
        { name: 'only_free', type: 'boolean' },
        true
      )[0].params.only_free
    ).toBe(true);
  });
});

describe('integrations-settings PATCH helpers (R7)', () => {
  it('the dialog PATCH carries aiLiveReads with instructions and zone', () => {
    expect(
      aiSettingsBody({ instructions: 'x', timezone: '', liveReads: [READ] })
    ).toEqual({ aiInstructions: 'x', aiTimezone: null, aiLiveReads: [READ] });
  });

  it('a 400 with field aiLiveReads is a dialog error; anything else is not', () => {
    expect(liveReadsErrorOf(400, { error: 'bad', field: 'aiLiveReads' })).toBe(
      'bad'
    );
    expect(
      liveReadsErrorOf(400, { error: 'bad', field: 'aiTimezone' })
    ).toBeNull();
    expect(liveReadsErrorOf(500, null)).toBeNull();
  });
});
