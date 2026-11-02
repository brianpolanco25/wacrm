import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  describeRejectedDelivery,
  describeTestDelivery,
  isMetaPanelTestDelivery,
} from './webhook-diagnostics';

const sign = (body: string, secret: string) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const body = JSON.stringify({
  entry: [
    {
      id: 'waba-1',
      changes: [
        { field: 'messages', value: { metadata: { phone_number_id: '111' } } },
      ],
    },
  ],
});

describe('describeRejectedDelivery', () => {
  it('reports the number, the event and whether a secret is stored', () => {
    const r = describeRejectedDelivery(
      body,
      sign(body, 'other'),
      new Map([['111', 'stored']])
    );
    expect(r).toMatchObject({
      phoneNumberIds: ['111'],
      entryIds: ['waba-1'],
      fields: ['messages'],
      signature: 'sha256',
      hasSecret: { '111': true },
      matchesVariant: null,
    });
    expect(r.bodyBytes).toBe(Buffer.byteLength(body));
  });

  it('flags a number with no stored secret and a missing signature', () => {
    const r = describeRejectedDelivery(body, null, new Map([['111', null]]));
    expect(r.hasSecret).toEqual({ '111': false });
    expect(r.signature).toBe('missing');
  });

  it('names the body rewrite the stored secret actually signs', () => {
    const signed = body.replace('waba-1', 'waba-\\u00e9');
    const received = body.replace('waba-1', 'waba-é');
    const r = describeRejectedDelivery(
      received,
      sign(signed, 'stored'),
      new Map([['111', 'stored']])
    );
    expect(r.matchesVariant).toBe('unicode-escaped');
  });

  it('never includes the secret or message content in the report', () => {
    const r = describeRejectedDelivery(
      body,
      sign(body, 'other'),
      new Map([['111', 'super-secret-value']])
    );
    expect(JSON.stringify(r)).not.toContain('super-secret-value');
  });
});

describe('isMetaPanelTestDelivery (R26)', () => {
  const panel = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: '0',
        changes: [
          {
            field: 'messages',
            value: {
              metadata: {
                display_phone_number: '16505551111',
                phone_number_id: '123456123',
              },
            },
          },
        ],
      },
    ],
  };

  it('recognises the dashboard sample as a string and as an object', () => {
    expect(isMetaPanelTestDelivery(JSON.stringify(panel))).toBe(true);
    expect(isMetaPanelTestDelivery(panel)).toBe(true);
  });

  it('recognises an account_update sample (entry "0", no metadata)', () => {
    expect(
      isMetaPanelTestDelivery({
        entry: [
          {
            id: '0',
            changes: [
              { field: 'account_update', value: { event: 'VERIFIED_ACCOUNT' } },
            ],
          },
        ],
      })
    ).toBe(true);
  });

  it('is false when any entry has another id or any number differs', () => {
    expect(
      isMetaPanelTestDelivery({
        entry: [...panel.entry, { id: 'waba-1', changes: [] }],
      })
    ).toBe(false);
    expect(
      isMetaPanelTestDelivery({
        entry: [
          {
            id: '0',
            changes: [
              {
                field: 'messages',
                value: { metadata: { phone_number_id: '111' } },
              },
            ],
          },
        ],
      })
    ).toBe(false);
  });

  it('is false for an empty entry list, invalid JSON or non-objects', () => {
    expect(isMetaPanelTestDelivery({ entry: [] })).toBe(false);
    expect(isMetaPanelTestDelivery('{')).toBe(false);
    expect(isMetaPanelTestDelivery(null)).toBe(false);
    expect(isMetaPanelTestDelivery(42)).toBe(false);
    expect(isMetaPanelTestDelivery({ entry: 'x' })).toBe(false);
  });

  it('describes the delivery with its field names and the verification flag', () => {
    expect(describeTestDelivery(JSON.stringify(panel), false)).toEqual({
      verified: false,
      fields: ['messages'],
    });
    expect(describeTestDelivery(panel, true)).toEqual({
      verified: true,
      fields: ['messages'],
    });
  });
});
