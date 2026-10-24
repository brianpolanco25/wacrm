import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
  extractPhoneNumberIds,
  tenantSignatureDecision,
} from './tenant-app-secret';

const sign = (body: string, secret: string) =>
  'sha256=' + crypto.createHmac('sha256', secret).update(body).digest('hex');

const delivery = (...ids: string[]) =>
  JSON.stringify({
    object: 'whatsapp_business_account',
    entry: ids.map((id) => ({
      id: 'waba-' + id,
      changes: [{ value: { metadata: { phone_number_id: id } } }],
    })),
  });

describe('extractPhoneNumberIds', () => {
  it('lists each claimed phone_number_id once, in order', () => {
    const body = JSON.stringify({
      entry: [
        {
          changes: [
            { value: { metadata: { phone_number_id: '111' } } },
            { value: { metadata: { phone_number_id: '222' } } },
            { value: { metadata: { phone_number_id: '111' } } },
          ],
        },
      ],
    });
    expect(extractPhoneNumberIds(body)).toEqual(['111', '222']);
  });

  it('returns nothing for invalid JSON, a non-Meta shape, or non-string ids', () => {
    expect(extractPhoneNumberIds('{')).toEqual([]);
    expect(extractPhoneNumberIds('{"hello":"world"}')).toEqual([]);
    expect(
      extractPhoneNumberIds(
        JSON.stringify({
          entry: [
            { changes: [{ value: { metadata: { phone_number_id: 42 } } }] },
          ],
        })
      )
    ).toEqual([]);
  });
});

describe('tenantSignatureDecision', () => {
  const body = delivery('111');

  it("accepts a delivery signed with the claimed number's own app secret", () => {
    const secrets = new Map([['111', 'rehactive-secret']]);
    expect(
      tenantSignatureDecision(body, sign(body, 'rehactive-secret'), secrets, [
        '111',
      ])
    ).toBe(true);
  });

  it("rejects a delivery signed with ANOTHER tenant's secret, even a valid one", () => {
    // Tenant B knows its own secret and forges a delivery about tenant A's number.
    const secrets = new Map([
      ['111', 'secret-of-a'],
      ['222', 'secret-of-b'],
    ]);
    expect(
      tenantSignatureDecision(body, sign(body, 'secret-of-b'), secrets, ['111'])
    ).toBe(false);
  });

  it('rejects when the claimed number has no app secret stored', () => {
    const secrets = new Map<string, string | null>([['111', null]]);
    expect(
      tenantSignatureDecision(body, sign(body, 'anything'), secrets, ['111'])
    ).toBe(false);
    expect(
      tenantSignatureDecision(body, sign(body, 'x'), new Map(), ['111'])
    ).toBe(false);
  });

  it('requires every claimed number to verify when a delivery names several', () => {
    const two = delivery('111', '222');
    const secrets = new Map([
      ['111', 'shared'],
      ['222', 'shared'],
    ]);
    expect(
      tenantSignatureDecision(two, sign(two, 'shared'), secrets, ['111', '222'])
    ).toBe(true);
    const mixed = new Map([
      ['111', 'shared'],
      ['222', 'other'],
    ]);
    expect(
      tenantSignatureDecision(two, sign(two, 'shared'), mixed, ['111', '222'])
    ).toBe(false);
  });

  it('rejects an empty claim list and a tampered body', () => {
    const secrets = new Map([['111', 's']]);
    expect(tenantSignatureDecision(body, sign(body, 's'), secrets, [])).toBe(
      false
    );
    expect(
      tenantSignatureDecision(body + ' ', sign(body, 's'), secrets, ['111'])
    ).toBe(false);
  });
});
