import crypto from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { describeRejectedDelivery } from './webhook-diagnostics';

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
