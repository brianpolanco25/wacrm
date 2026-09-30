import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

import {
  SUPPORT_REFUSED_TABLES,
  SUPPORT_WRITABLE_TABLES,
  supportWriteVerdict,
} from './support-scope';

// What a support session may change (s9.5), and the one place three
// runtimes read it from. The lists are tied to migration 072 here, so the
// browser guard and the RLS cannot drift apart in silence.

const MIGRATION = fs.readFileSync(
  path.join(process.cwd(), 'supabase/migrations/072_impersonation_actions.sql'),
  'utf8'
);

/** The `excluded` array of the migration's DO block. */
function migrationExcluded(): string[] {
  const block = /excluded\s+text\[\]\s*:=\s*ARRAY\[([\s\S]*?)\];/.exec(
    MIGRATION
  );
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/** The child tables the migration's trigger resolves through a parent. */
function migrationParents(): string[] {
  const block =
    /parents\s+jsonb\s*:=\s*jsonb_build_object\(([\s\S]*?)\n\s*\);/.exec(
      MIGRATION
    );
  expect(block).not.toBeNull();
  return [...block![1].matchAll(/^\s*'([a-z_]+)',\s*jsonb_build_array/gm)].map(
    (m) => m[1]
  );
}

describe('the tables a support session writes', () => {
  it('refuses exactly what migration 072 keeps closed', () => {
    expect([...SUPPORT_REFUSED_TABLES].sort()).toEqual(
      migrationExcluded().sort()
    );
  });

  it('never lists a table as both writable and refused', () => {
    for (const table of SUPPORT_WRITABLE_TABLES) {
      expect(SUPPORT_REFUSED_TABLES.has(table), table).toBe(false);
    }
  });

  it('includes every child table the audit trigger knows how to resolve', () => {
    for (const table of migrationParents()) {
      expect(SUPPORT_WRITABLE_TABLES.has(table), table).toBe(true);
    }
  });

  it('keeps billing, ownership, membership, API keys and the trail closed', () => {
    for (const table of [
      'subscriptions',
      'checkout_intents',
      'accounts',
      'account_invitations',
      'api_keys',
      'webhook_endpoints',
      'platform_admins',
      'impersonation_log',
      'impersonation_actions',
    ]) {
      expect(SUPPORT_WRITABLE_TABLES.has(table), table).toBe(false);
    }
  });
});

describe('supportWriteVerdict — what the middleware does with a support cookie', () => {
  it.each([
    ['POST', '/api/quick-replies'],
    ['PATCH', '/api/conversations/c-1'],
    ['DELETE', '/api/whatsapp/config'],
    ['PUT', '/api/flows/f-1'],
    ['POST', '/api/accounting'],
  ])('records %s %s', (method, p) => {
    expect(supportWriteVerdict(method, p)).toBe('record');
  });

  it.each([
    ['POST', '/api/billing/checkout'],
    ['POST', '/api/billing/subscription'],
    ['PATCH', '/api/account'],
    ['PATCH', '/api/account/'],
    ['POST', '/api/account/transfer-ownership'],
    ['PATCH', '/api/account/members/u-1'],
    ['POST', '/api/account/invitations'],
    ['DELETE', '/api/account/invitations/i-1'],
    ['POST', '/api/account/api-keys'],
    ['POST', '/api/account/api-keys/k-1/rotate'],
    ['POST', '/api/account/webhooks'],
    ['PATCH', '/api/account/webhooks/w-1'],
    ['POST', '/api/account/webhooks/w-1/rotate-secret'],
    ['POST', '/api/invitations/t/redeem'],
    ['POST', '/api/platform/impersonate'],
    ['POST', '/contacts'],
    ['POST', '/dashboard'],
  ])('blocks %s %s', (method, p) => {
    expect(supportWriteVerdict(method, p)).toBe('block');
  });

  it.each([
    ['GET', '/api/billing/checkout'],
    ['GET', '/api/account/members'],
    ['HEAD', '/contacts'],
    ['POST', '/api/platform/impersonate/stop'],
    ['POST', '/api/platform/accounts/a-1/hold'],
    ['POST', '/api/whatsapp/webhook'],
    ['POST', '/api/v1/messages'],
    ['GET', '/api/automations/cron'],
  ])('passes %s %s untouched', (method, p) => {
    expect(supportWriteVerdict(method, p)).toBe('pass');
  });
});
