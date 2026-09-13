// ============================================================
// Per-number settings (fase 4 §1, migración 053).
//
// PATCH  — rename a number, flip the inbound-media mirror, or make it
//          the account's default. Credentials are NOT editable here:
//          changing a token has to go through POST /api/whatsapp/config,
//          which verifies it against Meta before it is stored.
// DELETE — remove one number. Lives on the collection route
//          (`DELETE /api/whatsapp/config?id=…`) as well; this is the
//          RESTful spelling the settings list uses.
//
// Tenancy: `requireRole('admin')` returns the caller's own account, and
// every statement below carries BOTH the row id and `account_id`. The
// id arrives in the URL and is therefore attacker-controlled: a row of
// another account must read as 404, never as 403 and never as the row
// (CP3, suite de aislamiento).
// ============================================================

import { NextResponse } from 'next/server';

import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { promoteDefault } from '@/lib/whatsapp/default-number';

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { supabase, accountId } = await requireRole('admin');

    const body = (await request.json().catch(() => null)) as Record<
      string,
      unknown
    > | null;
    if (!body) {
      return NextResponse.json(
        { error: 'Request body must be a JSON object' },
        { status: 400 }
      );
    }

    const { data: existing, error: lookupError } = await supabase
      .from('whatsapp_config')
      .select('id, is_default')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();

    if (lookupError) {
      console.error('[whatsapp/config/[id]] lookup failed:', lookupError);
      return NextResponse.json(
        { error: 'Failed to load the number' },
        { status: 500 }
      );
    }
    if (!existing) {
      return NextResponse.json(
        { error: 'That WhatsApp number does not exist on this account.' },
        { status: 404 }
      );
    }

    const updates: Record<string, unknown> = {};
    if ('label' in body) {
      const label = typeof body.label === 'string' ? body.label.trim() : '';
      updates.label = label || null;
    }
    if ('mirror_inbound_media' in body) {
      updates.mirror_inbound_media = body.mirror_inbound_media === true;
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(updates)
        .eq('id', id)
        .eq('account_id', accountId);
      if (updateError) {
        console.error('[whatsapp/config/[id]] update failed:', updateError);
        return NextResponse.json(
          { error: 'Failed to update the number' },
          { status: 500 }
        );
      }
    }

    // Only ever promotes. Demoting the default on its own would leave
    // the account without one; the way to move it is to promote another.
    if (body.is_default === true && existing.is_default !== true) {
      const promoted = await promoteDefault(supabase, accountId, id);
      if (!promoted) {
        return NextResponse.json(
          { error: 'Failed to update the number' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    const { supabase, accountId } = await requireRole('admin');

    const { data: deleted, error: deleteError } = await supabase
      .from('whatsapp_config')
      .delete()
      .eq('id', id)
      .eq('account_id', accountId)
      .select('id, is_default');

    if (deleteError) {
      console.error('[whatsapp/config/[id]] delete failed:', deleteError);
      return NextResponse.json(
        { error: 'Failed to delete the number' },
        { status: 500 }
      );
    }
    if (!deleted || deleted.length === 0) {
      return NextResponse.json(
        { error: 'That WhatsApp number does not exist on this account.' },
        { status: 404 }
      );
    }

    // Removing the default hands the title to the oldest survivor —
    // see the same block in the collection route.
    if (deleted[0].is_default) {
      const { data: survivors } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .order('created_at', { ascending: true })
        .limit(1);
      if (survivors?.[0]) {
        await supabase
          .from('whatsapp_config')
          .update({ is_default: true })
          .eq('id', survivors[0].id)
          .eq('account_id', accountId);
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
