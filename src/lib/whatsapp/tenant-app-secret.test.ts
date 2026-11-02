import crypto from 'node:crypto';
import { describe, it, expect, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { encrypt } from './encryption';
import {
  extractAccountOnlyWabaIds,
  extractPhoneNumberIds,
  tenantSignatureDecision,
  wabaConfigsSignedBy,
  wabaSignatureDecision,
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
      tenantSignatureDecision(
        body.replace('waba-111', 'waba-999'),
        sign(body, 's'),
        secrets,
        ['111']
      )
    ).toBe(false);
  });
});

describe('account-level events (account_update, no phone number)', () => {
  const accountEvent = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-9',
        changes: [{ field: 'account_update', value: { event: 'X' } }],
      },
    ],
  });

  it('extracts the account only when no change names a number', () => {
    expect(extractAccountOnlyWabaIds(accountEvent)).toEqual(['waba-9']);
    expect(extractAccountOnlyWabaIds(delivery('111'))).toEqual([]);
    expect(extractAccountOnlyWabaIds('{')).toEqual([]);
  });

  it("accepts it when one of the account's stored secrets signs it", () => {
    const secrets = new Map([['waba-9', ['nope', 's']]]);
    expect(
      wabaSignatureDecision(accountEvent, sign(accountEvent, 's'), secrets, [
        'waba-9',
      ])
    ).toBe(true);
  });

  it('rejects an account with no secret, a wrong secret or no claim', () => {
    const sig = sign(accountEvent, 's');
    expect(
      wabaSignatureDecision(accountEvent, sig, new Map(), ['waba-9'])
    ).toBe(false);
    expect(
      wabaSignatureDecision(accountEvent, sig, new Map([['waba-9', ['x']]]), [
        'waba-9',
      ])
    ).toBe(false);
    expect(wabaSignatureDecision(accountEvent, sig, new Map(), [])).toBe(false);
  });
});

describe('wabaConfigsSignedBy (R21, R25)', () => {
  const body = JSON.stringify({
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'account_update',
            value: { event: 'PARTNER_REMOVED', waba_id: 'waba-1' },
          },
        ],
      },
    ],
  });

  function fakeDb(result: { data: unknown; error: unknown }) {
    const eq = vi.fn(async () => result);
    const select = vi.fn(() => ({ eq }));
    const from = vi.fn(() => ({ select }));
    return { db: { from } as unknown as SupabaseClient, from, select, eq };
  }

  const rows = [
    { id: 'cfg-a', account_id: 'acct-a', app_secret: encrypt('secret-a') },
    { id: 'cfg-b', account_id: 'acct-b', app_secret: encrypt('secret-b') },
  ];

  it('returns only the row whose own secret signs the delivery', async () => {
    const { db, eq } = fakeDb({ data: rows, error: null });
    expect(
      await wabaConfigsSignedBy(db, 'waba-1', body, sign(body, 'secret-a'))
    ).toEqual([{ id: 'cfg-a', account_id: 'acct-a' }]);
    expect(eq).toHaveBeenCalledWith('waba_id', 'waba-1');
  });

  it('returns [] when no stored secret signs it', async () => {
    const { db } = fakeDb({ data: rows, error: null });
    expect(
      await wabaConfigsSignedBy(db, 'waba-1', body, sign(body, 'other'))
    ).toEqual([]);
  });

  it('skips rows with a null or undecryptable secret', async () => {
    const { db } = fakeDb({
      data: [
        { id: 'cfg-n', account_id: 'acct-a', app_secret: null },
        { id: 'cfg-x', account_id: 'acct-a', app_secret: 'not-encrypted' },
      ],
      error: null,
    });
    expect(
      await wabaConfigsSignedBy(db, 'waba-1', body, sign(body, 'secret-a'))
    ).toEqual([]);
  });

  it('returns [] when the lookup errors or there is no signature', async () => {
    const errored = fakeDb({ data: null, error: { message: 'boom' } });
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    expect(
      await wabaConfigsSignedBy(
        errored.db,
        'waba-1',
        body,
        sign(body, 'secret-a')
      )
    ).toEqual([]);
    spy.mockRestore();
    const { db, from } = fakeDb({ data: rows, error: null });
    expect(await wabaConfigsSignedBy(db, 'waba-1', body, null)).toEqual([]);
    expect(from).not.toHaveBeenCalled();
  });
});
