// ============================================================
// POST /api/whatsapp/config/smb-sync — «Reintentar sincronización»
// (#1650, coexistencia).
//
// The button on the number card when the one-shot contacts/history
// syncs of a coexistence number did not go through at signup. Runs only
// the types without a `request_id` (the claim in `coexistence.ts` makes
// that atomic) and only inside Meta's 24 h window from the onboarding.
// No automatic retry exists anywhere: Meta counts the calls.
//
//   body { config_id }
//   200  { smb_sync: { state_sync, history } }
//   400  without config_id
//   401/403  no session or below `admin`
//   404  the number is not the caller's account (no Meta call, no write)
//   409  `not_coexistence` | `smb_sync_window_expired` (no Meta call)
//   429  more than 3 per minute and user
//
// Reads and writes go through the service role (the 088 trigger voids
// the client's writes to the smb_* columns), always filtered by `id` +
// the session's `account_id`. Route Handler POST: Next 16 does not
// cache non-GET methods.
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import {
  isWithinSmbSyncWindow,
  runSmbAppDataSync,
} from '@/lib/whatsapp/coexistence';
import { decrypt } from '@/lib/whatsapp/encryption';

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin');

    const limit = checkRateLimit(`smb-sync:${ctx.userId}`, RATE_LIMITS.smbSync);
    if (!limit.success) return rateLimitResponse(limit);

    let body: { config_id?: unknown };
    try {
      body = (await request.json()) as { config_id?: unknown };
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const configId =
      typeof body?.config_id === 'string' ? body.config_id.trim() : '';
    if (!configId) {
      return NextResponse.json(
        { error: 'config_id is required' },
        { status: 400 }
      );
    }

    const admin = supabaseAdmin();
    const { data: row, error } = await admin
      .from('whatsapp_config')
      .select('id, phone_number_id, access_token, coexistence_onboarded_at')
      .eq('id', configId)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (error) {
      console.error('[smb-sync] config lookup failed:', error.message);
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }
    if (!row) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 });
    }
    if (!row.coexistence_onboarded_at) {
      return NextResponse.json({ error: 'not_coexistence' }, { status: 409 });
    }
    if (!isWithinSmbSyncWindow(row.coexistence_onboarded_at as string)) {
      return NextResponse.json(
        { error: 'smb_sync_window_expired' },
        { status: 409 }
      );
    }

    let accessToken: string;
    try {
      accessToken = decrypt(row.access_token as string);
    } catch {
      // Never the value, never the ciphertext.
      console.error('[smb-sync] could not decrypt the access token');
      return NextResponse.json(
        { error: 'Internal server error' },
        { status: 500 }
      );
    }

    const smbSync = await runSmbAppDataSync(admin, {
      accountId: ctx.accountId,
      configId: row.id as string,
      phoneNumberId: row.phone_number_id as string,
      accessToken,
    });

    return NextResponse.json({ smb_sync: smbSync });
  } catch (err) {
    return toErrorResponse(err);
  }
}
