import { NextResponse } from 'next/server';
import {
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { encrypt, decrypt } from '@/lib/whatsapp/encryption';
import { validateAiCredentials } from '@/lib/ai/validate';
import { embedTexts } from '@/lib/ai/embeddings';
import { hasPlatformApiKey, platformApiKey } from '@/lib/ai/platform-key';
import { AiError, type AiKeySource, type AiProvider } from '@/lib/ai/types';

function bad(message: string) {
  return NextResponse.json({ error: message }, { status: 400 });
}

/**
 * Which providers have a platform-level key on this deployment
 * (supuesto S1). Booleans only — the keys themselves never leave the
 * server. Lets the settings form accept an empty key field when the
 * platform will pay for the calls.
 */
function platformKeyAvailability(): Record<AiProvider, boolean> {
  return {
    openai: hasPlatformApiKey('openai'),
    anthropic: hasPlatformApiKey('anthropic'),
  };
}

/**
 * GET /api/ai/config
 *
 * Any member may read the config so the inbox/settings can reflect
 * whether AI is set up. The encrypted key is NEVER returned — only a
 * `has_key` flag; the settings form shows a masked placeholder.
 */
export async function GET() {
  try {
    const { supabase, accountId } = await getCurrentAccount();

    const { data, error } = await supabase
      .from('ai_configs')
      // `api_key` is selected only to derive `has_key` — it is stripped
      // out below and never returned to the client.
      .select(
        'provider, model, system_prompt, is_active, auto_reply_enabled, auto_reply_max_per_conversation, handoff_agent_id, api_key, embeddings_api_key'
      )
      .eq('account_id', accountId)
      .maybeSingle();

    if (error) {
      console.error('[ai/config GET] fetch error:', error);
      return NextResponse.json(
        { error: 'Failed to load AI configuration' },
        { status: 500 }
      );
    }

    const platform_key_available = platformKeyAvailability();
    if (!data) {
      return NextResponse.json({ configured: false, platform_key_available });
    }
    // The keys are selected only to derive the has_* flags; neither is
    // returned to the client.
    const { api_key, embeddings_api_key, ...safe } = data;
    return NextResponse.json({
      configured: true,
      has_key: !!api_key,
      has_embeddings_key: !!embeddings_api_key,
      platform_key_available,
      ...safe,
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * POST /api/ai/config  (admin+)
 *
 * Upsert the account's AI config. Validates the key with the provider
 * before persisting (mirrors the WhatsApp config verifying with Meta
 * first), then stores the key AES-256-GCM-encrypted. When `api_key` is
 * omitted the existing stored key is reused (the form sends it only
 * when the user re-enters it); an explicit `api_key: null` forgets it
 * and falls back to the platform key (supuesto S1).
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(
      `ai-config:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') return bad('Invalid request body');

    const provider = body.provider as AiProvider;
    if (provider !== 'openai' && provider !== 'anthropic') {
      return bad('provider must be "openai" or "anthropic"');
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) return bad('model is required');

    const systemPrompt =
      typeof body.system_prompt === 'string' && body.system_prompt.trim()
        ? body.system_prompt.trim()
        : null;
    const isActive = body.is_active === true;
    const autoReplyEnabled = body.auto_reply_enabled === true;

    let maxPer = Number(body.auto_reply_max_per_conversation);
    if (!Number.isFinite(maxPer)) maxPer = 3;
    maxPer = Math.min(20, Math.max(1, Math.floor(maxPer)));

    // Handoff routing target for auto-reply. A non-empty string must be a
    // member of this account (else the conversation would be assigned to a
    // stranger); an empty string / null means "leave unassigned" (the
    // shared queue). Absent → left unchanged on update below.
    const rawHandoff =
      typeof body.handoff_agent_id === 'string'
        ? body.handoff_agent_id.trim()
        : '';
    const handoffProvided = 'handoff_agent_id' in body;
    let handoffAgentId: string | null = null;
    if (rawHandoff) {
      const { data: member } = await supabase
        .from('profiles')
        .select('user_id')
        .eq('account_id', accountId)
        .eq('user_id', rawHandoff)
        .maybeSingle();
      if (!member)
        return bad('handoff_agent_id must be a member of this account');
      handoffAgentId = rawHandoff;
    }

    // Chat key. A non-empty string sets/replaces it; an explicit `null`
    // clears it — "forget my key and go back to the platform's"
    // (supuesto S1), the same convention `embeddings_api_key` already
    // uses; absent leaves the stored key untouched (the form only sends
    // the field when the admin edits it).
    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    const clearKey = body.api_key === null;

    // Embeddings key (optional, for semantic KB search): a non-empty
    // string sets/replaces it; an explicit null clears it; absent leaves
    // it unchanged. The form only sends it when the admin edits it.
    const rawEmbeddingsKey =
      typeof body.embeddings_api_key === 'string'
        ? body.embeddings_api_key.trim()
        : '';
    const clearEmbeddingsKey = body.embeddings_api_key === null;

    // Reuse the stored key when the form didn't send a fresh one.
    const { data: existing } = await supabase
      .from('ai_configs')
      .select('id, provider, model, api_key')
      .eq('account_id', accountId)
      .maybeSingle();

    // Only spend a provider round-trip when the credentials that affect
    // reachability actually changed: a brand-new row, a freshly typed
    // key, a key handed back to the platform, or a different
    // provider/model. A save that just flips a toggle or edits the
    // system prompt on an existing, already-validated config skips the
    // call — no wasted token/latency on the account's key.
    const credentialsChanged =
      !existing ||
      rawKey !== '' ||
      clearKey ||
      provider !== existing.provider ||
      model !== existing.model;

    // A key is needed only to validate, so it is only *required* when we
    // are about to validate. That keeps a platform-backed row (api_key
    // NULL) editable after the operator rotates AI_PLATFORM_*_API_KEY
    // away: turning the assistant off or fixing its prompt must not 400
    // because the deployment no longer has a key to test with.
    if (credentialsChanged) {
      // Key resolution (supuesto S1): a freshly typed key, else the
      // stored key (unless this save is clearing it), else the platform
      // key for the chosen provider. Only when none of the three exists
      // is the key actually required — the pre-S1 behaviour on a
      // deployment without platform keys.
      let apiKeyPlain: string;
      // Decided in the same branch that picks the key: `key_source` is
      // what fase 3 bills on, so it must not be a second copy of this
      // ladder that someone can update out of step.
      let keySource: AiKeySource;
      if (rawKey) {
        apiKeyPlain = rawKey;
        keySource = 'account';
      } else if (existing?.api_key && !clearKey) {
        try {
          apiKeyPlain = decrypt(existing.api_key);
        } catch {
          return bad(
            'Stored API key could not be decrypted — re-enter your key.'
          );
        }
        keySource = 'account';
      } else {
        const platformKey = platformApiKey(provider);
        if (!platformKey) return bad('api_key is required');
        apiKeyPlain = platformKey;
        keySource = 'platform';
      }

      try {
        await validateAiCredentials({
          provider,
          model,
          apiKey: apiKeyPlain,
          keySource,
          systemPrompt,
          isActive,
          autoReplyEnabled,
          autoReplyMaxPerConversation: maxPer,
          handoffAgentId: null,
          embeddingsApiKey: null,
        });
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: err.message, code: err.code },
            { status: 400 }
          );
        }
        console.error('[ai/config POST] validation error:', err);
        return bad('Could not validate the API key with the provider.');
      }
    }

    // Validate a new embeddings key before storing (a cheap 1-input
    // embed), same "verify before save" discipline as the chat key.
    if (rawEmbeddingsKey) {
      try {
        await embedTexts(rawEmbeddingsKey, ['ping']);
      } catch (err) {
        if (err instanceof AiError) {
          return NextResponse.json(
            { error: `Embeddings key: ${err.message}`, code: err.code },
            { status: 400 }
          );
        }
        console.error('[ai/config POST] embeddings validation error:', err);
        return bad('Could not validate the embeddings key.');
      }
    }

    const shared: Record<string, unknown> = {
      provider,
      model,
      system_prompt: systemPrompt,
      is_active: isActive,
      auto_reply_enabled: autoReplyEnabled,
      auto_reply_max_per_conversation: maxPer,
    };
    // Only touch the handoff target when the form actually sent the field,
    // so a partial save (e.g. flipping a toggle) doesn't wipe it.
    if (handoffProvided) shared.handoff_agent_id = handoffAgentId;
    if (rawEmbeddingsKey) {
      shared.embeddings_api_key = encrypt(rawEmbeddingsKey);
    } else if (clearEmbeddingsKey) {
      shared.embeddings_api_key = null;
    }
    // Same three-way rule for the chat key: typed → store it encrypted;
    // explicit null → back to the platform key; absent → untouched.
    if (rawKey) {
      shared.api_key = encrypt(rawKey);
    } else if (clearKey) {
      shared.api_key = null;
    }

    if (existing) {
      const { error: upErr } = await supabase
        .from('ai_configs')
        .update(shared)
        .eq('account_id', accountId);
      if (upErr) {
        console.error('[ai/config POST] update error:', upErr);
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 }
        );
      }
    } else {
      const { error: insErr } = await supabase.from('ai_configs').insert({
        account_id: accountId,
        created_by: userId,
        // Null when the account relies on the platform key (the column
        // is nullable since migration 047); `shared` overrides it with
        // the encrypted BYO key when the admin typed one.
        api_key: null,
        ...shared,
      });
      if (insErr) {
        console.error('[ai/config POST] insert error:', insErr);
        return NextResponse.json(
          { error: 'Failed to save AI configuration' },
          { status: 500 }
        );
      }
    }

    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}

/**
 * DELETE /api/ai/config  (admin+)
 *
 * Removes the account's AI config (turns everything off and forgets the
 * key). Also used to recover from a corrupted encrypted key.
 */
export async function DELETE() {
  try {
    const { supabase, accountId } = await requireRole('admin');
    const { error } = await supabase
      .from('ai_configs')
      .delete()
      .eq('account_id', accountId);
    if (error) {
      console.error('[ai/config DELETE] error:', error);
      return NextResponse.json(
        { error: 'Failed to delete AI configuration' },
        { status: 500 }
      );
    }
    return NextResponse.json({ success: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
