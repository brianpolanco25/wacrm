import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { loadAiConfig } from '@/lib/ai/config';
import { buildConversationContext } from '@/lib/ai/context';
import { retrieveKnowledge } from '@/lib/ai/knowledge';
import { generateReply } from '@/lib/ai/generate';
import { buildSystemPrompt } from '@/lib/ai/defaults';
import { latestUserMessage } from '@/lib/ai/query';
import { logAiUsage } from '@/lib/ai/usage';
import { supabaseAdmin } from '@/lib/ai/admin-client';
import { AiError } from '@/lib/ai/types';
import { loadAiToolset } from '@/lib/ai/tools/load';
import { loadLiveData } from '@/lib/ai/tools/live';
import { EMPTY_TOOLSET, type LiveDataBlock } from '@/lib/ai/tools/types';

/**
 * POST /api/ai/draft  (agent+)
 *
 * Body: { conversation_id }
 * Returns: { draft } — a suggested reply for the agent to edit + send.
 *
 * Uses the account's configured provider/key (BYO). Read-only: it never
 * sends or stores anything, just hands text back to the composer.
 */
export async function POST(request: Request) {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');

    const userLimit = checkRateLimit(`ai-draft:${userId}`, RATE_LIMITS.aiDraft);
    if (!userLimit.success) return rateLimitResponse(userLimit);
    // Also cap the whole team's draws on the shared BYO provider key.
    const accountLimit = checkRateLimit(
      `ai-draft-acct:${accountId}`,
      RATE_LIMITS.aiDraftAccount
    );
    if (!accountLimit.success) return rateLimitResponse(accountLimit);

    const body = await request.json().catch(() => null);
    const conversationId =
      body && typeof body.conversation_id === 'string'
        ? body.conversation_id
        : '';
    if (!conversationId) {
      return NextResponse.json(
        { error: 'conversation_id is required' },
        { status: 400 }
      );
    }

    // RLS scopes the SSR client to the caller's account, so a missing
    // row means "not yours / not found" either way.
    const { data: conversation, error: convErr } = await supabase
      .from('conversations')
      .select('id')
      .eq('id', conversationId)
      .maybeSingle();
    if (convErr) {
      console.error('[ai/draft] conversation lookup error:', convErr);
      return NextResponse.json(
        { error: 'Failed to load conversation' },
        { status: 500 }
      );
    }
    if (!conversation) {
      return NextResponse.json(
        { error: 'Conversation not found' },
        { status: 404 }
      );
    }

    const config = await loadAiConfig(supabase, accountId).catch((err) => {
      // Decrypt failure — surface distinctly from "not configured".
      console.error('[ai/draft] loadAiConfig error:', err);
      throw new AiError('Stored API key could not be decrypted.', {
        code: 'key_decrypt_failed',
        status: 400,
      });
    });
    if (!config) {
      return NextResponse.json(
        {
          error:
            'AI assistant is not set up. Enable it in Settings → AI Assistant.',
          code: 'ai_not_configured',
        },
        { status: 400 }
      );
    }

    const messages = await buildConversationContext(supabase, conversationId);
    // Nothing to draft from — a brand-new thread with no customer text
    // would otherwise produce a nonsensical reply-to-nothing.
    if (messages.length === 0) {
      return NextResponse.json(
        {
          error: 'No messages to draft from yet.',
          code: 'no_messages',
        },
        { status: 400 }
      );
    }

    // Ground the draft in the account's knowledge base (best-effort —
    // returns [] when there's no KB or retrieval fails).
    const knowledge = await retrieveKnowledge(
      supabase,
      accountId,
      config,
      latestUserMessage(messages)
    );

    // n13.3: read-only integration tools (GET only, D5) — a draft is
    // reviewed by an agent before it is sent, so it must not change
    // anything. No service-role key → no tools, same as before.
    let toolset = EMPTY_TOOLSET;
    let admin: ReturnType<typeof supabaseAdmin> | null = null;
    try {
      admin = supabaseAdmin();
    } catch {
      admin = null;
    }
    if (admin) {
      toolset = await loadAiToolset(admin, accountId, { mode: 'draft' });
    }

    // n13.7 R9: live reads in the prompt too (no text guard in drafts,
    // R39: an agent reviews them before sending).
    const turnNow = new Date();
    let liveData: LiveDataBlock[] = [];
    if (admin && toolset.tools.length > 0) {
      liveData = await loadLiveData(admin, {
        accountId,
        toolset,
        conversationId: null,
        now: turnNow,
      });
    }

    const systemPrompt = buildSystemPrompt({
      userPrompt: config.systemPrompt,
      mode: 'draft',
      knowledge,
      tools: toolset,
      now: turnNow,
      liveData,
      // n15.1 (R26): voice notes the bot already transcribed are in the
      // context; nothing new is transcribed for a draft.
      voiceNotes: messages.some((m) => m.voice),
    });

    const { text, usage, toolsUsed } = await generateReply(
      admin && toolset.tools.length > 0
        ? {
            config,
            systemPrompt,
            messages,
            tools: { toolset, db: admin, accountId },
            grounding: { mode: 'draft', liveData },
          }
        : { config, systemPrompt, messages }
    ).catch((err: unknown) => {
      // n13.3: a later tool round failed; the earlier rounds still cost.
      if (admin && err instanceof AiError && err.usage) {
        void logAiUsage(admin, {
          accountId,
          conversationId,
          mode: 'draft',
          provider: config.provider,
          model: config.model,
          keySource: config.keySource,
          usage: err.usage,
        });
      }
      throw err;
    });

    // Record spend, tagged with whose key paid for it (BYO or the
    // platform's). Best-effort + via the
    // service role (the log has no `authenticated` INSERT policy). This
    // must not fail or delay the draft the agent is waiting on, so:
    //  - the whole thing is wrapped (constructing the admin client throws
    //    if the service-role key is unset — that must not 500 the draft);
    //  - it's fire-and-forget (`void`), not awaited, so the response
    //    isn't held for a DB round-trip.
    try {
      void logAiUsage(supabaseAdmin(), {
        accountId,
        conversationId,
        mode: 'draft',
        provider: config.provider,
        model: config.model,
        keySource: config.keySource,
        usage,
      });
    } catch (logErr) {
      console.error('[ai/draft] usage log skipped:', logErr);
    }

    return NextResponse.json({
      draft: text,
      ...(toolsUsed ? { toolsUsed } : {}),
    });
  } catch (err) {
    if (err instanceof AiError) {
      return NextResponse.json(
        { error: err.message, code: err.code },
        { status: err.status }
      );
    }
    return toErrorResponse(err);
  }
}
