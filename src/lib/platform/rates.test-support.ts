/**
 * Test support for the /api/platform/rates routes (s10.2). Only
 * `*.test.ts` files import it: the rate card as a migrated database
 * holds it after 076 (seed included), for `FakeDatabase`.
 */

import type { Tables } from '@/lib/security/fake-supabase';

export const OPERATOR = '11111111-1111-4111-8111-111111111111';
export const PLAIN_OWNER = '22222222-2222-4222-8222-222222222222';
export const OWNER_ACCOUNT = 'aaaaaaaa-0000-4000-8000-000000000001';

export function seedRateTables(): Tables {
  return {
    platform_admins: [
      { id: 'pa-1', user_id: OPERATOR, granted_at: null, note: 'test' },
    ],
    accounts: [{ id: OWNER_ACCOUNT, name: 'Acme', owner_user_id: PLAIN_OWNER }],
    account_members: [
      {
        id: 'm-1',
        account_id: OWNER_ACCOUNT,
        user_id: PLAIN_OWNER,
        role: 'owner',
      },
    ],
    meta_rates: [
      {
        market: 'rest_of_latam',
        category: 'service',
        usd_per_message: '0.01130',
        effective_from: '2026-10-01',
        created_at: '2026-09-30T00:00:00.000Z',
      },
      {
        market: 'rest_of_latam',
        category: 'utility',
        usd_per_message: '0.01130',
        effective_from: '2026-10-01',
        created_at: '2026-09-30T00:00:00.000Z',
      },
      {
        market: 'rest_of_latam',
        category: 'marketing',
        usd_per_message: '0.07400',
        effective_from: '2026-10-01',
        created_at: '2026-09-30T00:00:00.000Z',
      },
    ],
    // `id` only for the fake: it deletes by id. The real PK is the code.
    meta_market_countries: [
      { id: 'mc-do', country_code: 'DO', market: 'rest_of_latam' },
      { id: 'mc-mx', country_code: 'MX', market: 'mexico' },
    ],
  };
}
