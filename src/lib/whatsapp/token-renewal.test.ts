import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { FakeDatabase, type Row } from '@/lib/security/fake-supabase';

// ---------------------------------------------------------------------------
// Migration 067: the sweep that keeps 60-day Embedded Signup tokens alive.
//
// What is pinned here, in the order the module does it:
//   - self-hosted (no platform app) does nothing and says so;
//   - only embedded_signup rows with a date inside the window are touched;
//   - a row retried too recently is left alone;
//   - an already expired token is not sent to Meta and gets the
//     "reconnect" message, once;
//   - a successful refresh replaces the token (encrypted), moves the
//     expiry and clears the error;
//   - a refused refresh records the attempt and Meta's message, and
//     leaves the working token where it was;
//   - the token never reaches console.*.
// ---------------------------------------------------------------------------

vi.mock('@/lib/whatsapp/encryption', () => ({
  encrypt: (v: string) => `enc:${v}`,
  decrypt: (v: string) => {
    if (!String(v).startsWith('enc:')) throw new Error('bad ciphertext');
    return String(v).replace(/^enc:/, '');
  },
}));

import {
  TOKEN_EXPIRED_MESSAGE,
  TOKEN_RENEWAL_RETRY_MS,
  TOKEN_RENEWAL_WINDOW_MS,
  renewExpiringTokens,
} from './token-renewal';

const NOW = new Date('2026-09-25T12:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

function iso(offsetMs: number): string {
  return new Date(NOW.getTime() + offsetMs).toISOString();
}

function row(overrides: Row = {}): Row {
  return {
    id: 'cfg-1',
    account_id: 'acct-a',
    user_id: 'user-a',
    phone_number_id: '1111',
    access_token: 'enc:EAAB-old',
    provisioned_via: 'embedded_signup',
    token_expires_at: iso(5 * DAY),
    token_renewal_attempted_at: null,
    token_renewal_error: null,
    token_renewed_at: null,
    ...overrides,
  };
}

function client(rows: Row[]): { db: FakeDatabase; supabase: SupabaseClient } {
  const db = new FakeDatabase({ whatsapp_config: rows });
  return { db, supabase: db.admin as unknown as SupabaseClient };
}

let refresh: ReturnType<typeof vi.fn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.stubEnv('META_APP_ID', 'app-123');
  vi.stubEnv('META_CONFIG_ID', '4722841751306607');
  vi.stubEnv('META_APP_SECRET', 'the-app-secret');
  refresh = vi.fn();
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  errorSpy.mockRestore();
});

function sweep(supabase: SupabaseClient) {
  return renewExpiringTokens(supabase, {
    now: () => NOW,
    refresh: refresh as never,
  });
}

describe('renewExpiringTokens', () => {
  it('is disabled outside platform mode and touches nothing', async () => {
    vi.stubEnv('META_CONFIG_ID', '');
    const { db, supabase } = client([row()]);

    const result = await sweep(supabase);

    expect(result).toEqual({
      enabled: false,
      scanned: 0,
      renewed: 0,
      failed: 0,
      skipped: 0,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(db.rows('whatsapp_config')[0]?.access_token).toBe('enc:EAAB-old');
  });

  it('only looks at embedded_signup rows whose token expires inside the window', async () => {
    refresh.mockResolvedValue({
      accessToken: 'EAAB-fresh',
      expiresAt: iso(60 * DAY),
    });
    const { supabase } = client([
      row({ id: 'due', token_expires_at: iso(3 * DAY) }),
      row({ id: 'far', token_expires_at: iso(TOKEN_RENEWAL_WINDOW_MS + DAY) }),
      row({ id: 'manual', provisioned_via: 'manual' }),
      row({ id: 'permanent', token_expires_at: null }),
    ]);

    const result = await sweep(supabase);

    expect(result.scanned).toBe(1);
    expect(result.renewed).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('replaces the token encrypted, moves the expiry and clears the error', async () => {
    refresh.mockResolvedValue({
      accessToken: 'EAAB-fresh',
      expiresAt: iso(60 * DAY),
    });
    const { db, supabase } = client([
      row({ token_renewal_error: 'a previous failure' }),
    ]);

    const result = await sweep(supabase);

    expect(result).toEqual({
      enabled: true,
      scanned: 1,
      renewed: 1,
      failed: 0,
      skipped: 0,
    });
    expect(refresh).toHaveBeenCalledWith({
      accessToken: 'EAAB-old',
      appId: 'app-123',
      appSecret: 'the-app-secret',
      graphVersion: 'v21.0',
    });
    const saved = db.rows('whatsapp_config')[0]!;
    expect(saved.access_token).toBe('enc:EAAB-fresh');
    expect(saved.token_expires_at).toBe(iso(60 * DAY));
    expect(saved.token_renewed_at).toBe(NOW.toISOString());
    expect(saved.token_renewal_attempted_at).toBe(NOW.toISOString());
    expect(saved.token_renewal_error).toBeNull();
  });

  it('records a refusal and keeps the working token', async () => {
    refresh.mockRejectedValue(
      new Error('Error validating access token: Session has expired')
    );
    const { db, supabase } = client([row()]);

    const result = await sweep(supabase);

    expect(result.failed).toBe(1);
    expect(result.renewed).toBe(0);
    const saved = db.rows('whatsapp_config')[0]!;
    expect(saved.access_token).toBe('enc:EAAB-old');
    expect(saved.token_expires_at).toBe(iso(5 * DAY));
    expect(saved.token_renewal_attempted_at).toBe(NOW.toISOString());
    expect(saved.token_renewal_error).toBe(
      'Error validating access token: Session has expired'
    );
    expect(saved.token_renewed_at).toBeNull();
  });

  it('does not retry a row attempted less than the retry interval ago', async () => {
    const { supabase } = client([
      row({
        token_renewal_attempted_at: iso(-(TOKEN_RENEWAL_RETRY_MS - 60_000)),
        token_renewal_error: 'transient',
      }),
    ]);

    const result = await sweep(supabase);

    expect(result.skipped).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
  });

  it('retries once the retry interval has passed', async () => {
    refresh.mockResolvedValue({
      accessToken: 'EAAB-fresh',
      expiresAt: iso(60 * DAY),
    });
    const { supabase } = client([
      row({
        token_renewal_attempted_at: iso(-(TOKEN_RENEWAL_RETRY_MS + 60_000)),
        token_renewal_error: 'transient',
      }),
    ]);

    const result = await sweep(supabase);

    expect(result.renewed).toBe(1);
    expect(refresh).toHaveBeenCalledTimes(1);
  });

  it('does not send an already expired token to Meta; records "reconnect" once', async () => {
    const { db, supabase } = client([row({ token_expires_at: iso(-DAY) })]);

    const first = await sweep(supabase);
    expect(first.skipped).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    const saved = db.rows('whatsapp_config')[0]!;
    expect(saved.token_renewal_error).toBe(TOKEN_EXPIRED_MESSAGE);
    expect(saved.token_renewal_attempted_at).toBe(NOW.toISOString());
    expect(saved.access_token).toBe('enc:EAAB-old');

    // A later sweep, past the retry gate, sees the message already there
    // and does not rewrite the row.
    const later = new Date(NOW.getTime() + TOKEN_RENEWAL_RETRY_MS + DAY);
    const writesBefore = db.log.filter((e) => e.op === 'update').length;
    await renewExpiringTokens(supabase, {
      now: () => later,
      refresh: refresh as never,
    });
    expect(refresh).not.toHaveBeenCalled();
    expect(db.log.filter((e) => e.op === 'update').length).toBe(writesBefore);
  });

  it('records a decryption failure instead of throwing', async () => {
    const { db, supabase } = client([row({ access_token: 'legacy-garbage' })]);

    const result = await sweep(supabase);

    expect(result.failed).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(db.rows('whatsapp_config')[0]?.token_renewal_error).toBe(
      'bad ciphertext'
    );
  });

  it('keeps the old expiry when Meta answers without expires_in', async () => {
    refresh.mockResolvedValue({ accessToken: 'EAAB-fresh', expiresAt: null });
    const { db, supabase } = client([row()]);

    await sweep(supabase);

    const saved = db.rows('whatsapp_config')[0]!;
    expect(saved.access_token).toBe('enc:EAAB-fresh');
    expect(saved.token_expires_at).toBe(iso(5 * DAY));
  });

  it('never prints a token', async () => {
    refresh.mockRejectedValue(new Error('Invalid OAuth access token.'));
    const { supabase } = client([row()]);

    await sweep(supabase);

    const printed = errorSpy.mock.calls.flat().map(String).join('\n');
    expect(printed).not.toContain('EAAB-old');
    expect(printed).toContain('Invalid OAuth access token.');
  });
});
