import { NextResponse } from 'next/server';
import { createClient } from '@/lib/supabase/server';
import { getMediaUrl, downloadMedia } from '@/lib/whatsapp/meta-api';
import {
  resolveWhatsAppConfig,
  WhatsAppConfigError,
} from '@/lib/whatsapp/resolve-config';

export async function GET(
  request: Request,
  { params }: { params: Promise<{ mediaId: string }> }
) {
  try {
    const { mediaId } = await params;

    if (!mediaId) {
      return NextResponse.json(
        { error: 'Media ID is required' },
        { status: 400 }
      );
    }

    const supabase = await createClient();

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser();

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // Resolve the caller's account_id — whatsapp_config is one-per-
    // account post-multi-user, so a teammate fetching media for a
    // conversation in the shared inbox needs the account's config,
    // not their personal (non-existent) row.
    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle();
    const accountId = profile?.account_id as string | undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    // Fase 4 §1: the account may have several numbers and this route
    // only knows a Meta media id — there is no conversation in the URL
    // to resolve the right one from. It uses the DEFAULT number, which
    // is correct in the normal case: the token of ANY number under a
    // WABA can download any media of that WABA. It only misses when an
    // account has numbers under DIFFERENT WABAs; that is recorded as
    // debt in progress/impl_multi-number.md rather than papered over
    // by threading a conversation_id through every <img src>.
    let accessToken: string;
    try {
      accessToken = (
        await resolveWhatsAppConfig(supabase, { accountId, withToken: true })
      ).accessToken;
    } catch (err) {
      if (err instanceof WhatsAppConfigError) {
        return NextResponse.json(
          { error: 'WhatsApp not configured' },
          { status: 400 }
        );
      }
      throw err;
    }

    // Get the download URL from Meta
    const mediaInfo = await getMediaUrl({ mediaId, accessToken });

    // Download the binary data
    const { buffer, contentType } = await downloadMedia({
      downloadUrl: mediaInfo.url,
      accessToken,
    });

    return new Response(new Uint8Array(buffer), {
      status: 200,
      headers: {
        'Content-Type':
          contentType || mediaInfo.mimeType || 'application/octet-stream',
        'Cache-Control': 'public, max-age=86400',
      },
    });
  } catch (error) {
    console.error('Error in WhatsApp media GET:', error);
    return NextResponse.json(
      { error: 'Failed to fetch media' },
      { status: 500 }
    );
  }
}
