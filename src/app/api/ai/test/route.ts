import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { decrypt } from '@/lib/whatsapp/encryption';
import { validateAiCredentials } from '@/lib/ai/validate';
import { platformApiKey } from '@/lib/ai/platform-key';
import { AiError, type AiKeySource, type AiProvider } from '@/lib/ai/types';

/**
 * POST /api/ai/test  (admin+)
 *
 * "Test key" button: validate a candidate provider/model/key against
 * the provider WITHOUT saving. Three-way `api_key`, mirroring the save
 * route: a string tests that key; omitted tests the stored one (so an
 * admin can re-test an existing config after changing the model, say);
 * an explicit `null` tests the platform key for the provider, which is
 * what the account will be using once it gives its own key up
 * (supuesto S1). Returns `{ ok: true }` on success, 400 with the
 * provider's message on failure.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('admin');

    const limit = checkRateLimit(`ai-test:${userId}`, RATE_LIMITS.adminAction);
    if (!limit.success) return rateLimitResponse(limit);

    const body = await request.json().catch(() => null);
    if (!body || typeof body !== 'object') {
      return NextResponse.json(
        { error: 'Invalid request body' },
        { status: 400 }
      );
    }

    const provider = body.provider as AiProvider;
    if (provider !== 'openai' && provider !== 'anthropic') {
      return NextResponse.json(
        { error: 'provider must be "openai" or "anthropic"' },
        { status: 400 }
      );
    }
    const model = typeof body.model === 'string' ? body.model.trim() : '';
    if (!model) {
      return NextResponse.json({ error: 'model is required' }, { status: 400 });
    }

    const rawKey = typeof body.api_key === 'string' ? body.api_key.trim() : '';
    // Same three-way convention as POST /api/ai/config, and for the same
    // reason: what gets tested must be the key the next save will
    // actually use. An explicit `api_key: null` means "I am handing this
    // account back to the platform key" — testing the stored key there
    // would green-light a key that is about to be deleted.
    const clearKey = body.api_key === null;
    let apiKeyPlain = rawKey;
    // Which key ends up being tested — reported to `validateAiCredentials`
    // for symmetry with the real call paths (nothing is logged here).
    let keySource: AiKeySource = 'account';
    if (!apiKeyPlain) {
      let storedKey: string | null = null;
      if (!clearKey) {
        const { data: existing } = await supabase
          .from('ai_configs')
          .select('api_key')
          .eq('account_id', accountId)
          .maybeSingle();
        storedKey = existing?.api_key ?? null;
      }
      if (storedKey) {
        try {
          apiKeyPlain = decrypt(storedKey);
        } catch {
          return NextResponse.json(
            {
              error:
                'Stored API key could not be decrypted — re-enter your key.',
            },
            { status: 400 }
          );
        }
      } else {
        // Supuesto S1: with no typed key and no stored key to fall back
        // on, test the platform key for this provider — that is what the
        // account would actually call the provider with.
        const platformKey = platformApiKey(provider);
        if (!platformKey) {
          return NextResponse.json(
            { error: 'Enter an API key to test.' },
            { status: 400 }
          );
        }
        apiKeyPlain = platformKey;
        keySource = 'platform';
      }
    }

    try {
      await validateAiCredentials({
        provider,
        model,
        apiKey: apiKeyPlain,
        keySource,
        systemPrompt: null,
        isActive: true,
        autoReplyEnabled: false,
        autoReplyMaxPerConversation: 3,
        handoffMode: 'queue',
        handoffAgentId: null,
        handoffMessage: null,
        embeddingsApiKey: null,
      });
    } catch (err) {
      if (err instanceof AiError) {
        return NextResponse.json(
          { error: err.message, code: err.code },
          { status: 400 }
        );
      }
      console.error('[ai/test] validation error:', err);
      return NextResponse.json(
        { error: 'Could not validate the API key.' },
        { status: 400 }
      );
    }

    return NextResponse.json({ ok: true });
  } catch (err) {
    return toErrorResponse(err);
  }
}
