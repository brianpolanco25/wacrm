// ============================================================
// GET   /api/v1/conversations/{id} — read one conversation
//       (scope: conversations:read).
// PATCH /api/v1/conversations/{id} — act on one conversation
//       (scope: conversations:write): assign, change status, pause or
//       resume the AI, mark as read.
//
// Both are account-scoped: a foreign id → 404.
//
// PATCH body (at least one field):
//   { "assigned_agent_id": "<user id>" | null,   // an account member that is not a viewer
//     "status": "open" | "pending" | "closed",
//     "ai_autoreply_disabled": true | false,     // false = hand the thread back to the AI
//     "read": true }                             // unread_count = 0
// Everything is validated BEFORE anything is written, so a bad field
// leaves the conversation untouched. The effects (and their webhooks:
// conversation.assigned / closed / updated) are the ones the panel
// produces — they come from `lib/conversations/status-events.ts`.
// ============================================================

import { requireApiKey } from '@/lib/auth/api-context';
import { readJsonBody } from '@/lib/api/v1/body';
import { ok, fail, toApiErrorResponse } from '@/lib/api/v1/respond';
import {
  CONVERSATION_SELECT,
  normalizeConversation,
} from '@/lib/inbox/conversations';
import {
  loadAccountAiOn,
  serializeConversation,
} from '@/lib/api/v1/conversations';
import { checkAccountMember } from '@/lib/conversations/members';
import {
  assignConversation,
  markConversationRead,
  setConversationAiPaused,
  setConversationStatus,
} from '@/lib/conversations/status-events';
import type { Conversation, ConversationStatus } from '@/types';

const STATUSES: readonly string[] = ['open', 'pending', 'closed'];

async function readSerialized(
  ctx: Awaited<ReturnType<typeof requireApiKey>>,
  id: string
) {
  const { data, error } = await ctx.supabase
    .from('conversations')
    .select(CONVERSATION_SELECT)
    .eq('id', id)
    .eq('account_id', ctx.accountId)
    .maybeSingle();
  if (error) return { error: true as const, value: null };
  if (!data) return { error: false as const, value: null };
  const accountAiOn = await loadAccountAiOn(ctx.supabase, ctx.accountId);
  return {
    error: false as const,
    value: serializeConversation(normalizeConversation(data as Conversation), {
      accountAiOn,
    }),
  };
}

export async function GET(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const { id } = await params;

    const result = await readSerialized(ctx, id);
    if (result.error) {
      console.error('[api/v1/conversations] read error');
      return fail('internal', 'Failed to read conversation', 500);
    }
    if (!result.value) return fail('not_found', 'Conversation not found', 404);
    return ok(result.value);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const ctx = await requireApiKey(request, 'conversations:write');
    const { id } = await params;
    const { data: body } = await readJsonBody(request);

    const hasAssign = 'assigned_agent_id' in body;
    const hasStatus = 'status' in body;
    const hasAi = 'ai_autoreply_disabled' in body;
    const hasRead = 'read' in body;
    if (!hasAssign && !hasStatus && !hasAi && !hasRead) {
      return fail(
        'bad_request',
        "Provide at least one of 'assigned_agent_id', 'status', 'ai_autoreply_disabled' or 'read'",
        400
      );
    }

    const agentId = body.assigned_agent_id;
    if (hasAssign && agentId !== null && typeof agentId !== 'string') {
      return fail(
        'bad_request',
        "'assigned_agent_id' must be a string or null",
        400
      );
    }
    if (
      hasStatus &&
      !(typeof body.status === 'string' && STATUSES.includes(body.status))
    ) {
      return fail(
        'bad_request',
        "'status' must be one of open, pending, closed",
        400
      );
    }
    if (hasAi && typeof body.ai_autoreply_disabled !== 'boolean') {
      return fail(
        'bad_request',
        "'ai_autoreply_disabled' must be a boolean",
        400
      );
    }
    if (hasRead && body.read !== true) {
      return fail('bad_request', "'read' must be true", 400);
    }

    // The conversation must be this account's before anything else.
    const { data: existing, error: existingError } = await ctx.supabase
      .from('conversations')
      .select('id')
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .maybeSingle();
    if (existingError) {
      console.error(
        '[api/v1/conversations] patch lookup error:',
        existingError
      );
      return fail('internal', 'Failed to update conversation', 500);
    }
    if (!existing) return fail('not_found', 'Conversation not found', 404);

    // The assignee must be a non-viewer member of THIS account.
    if (hasAssign && typeof agentId === 'string') {
      const member = await checkAccountMember(
        ctx.supabase,
        ctx.accountId,
        agentId,
        { rejectViewer: true }
      );
      if (!member.ok && member.reason === 'error') {
        return fail('internal', 'Failed to update conversation', 500);
      }
      if (!member.ok) {
        return fail(
          'invalid_member',
          "'assigned_agent_id' must be a non-viewer member of this account",
          400
        );
      }
    }

    const scope = {
      db: ctx.supabase,
      accountId: ctx.accountId,
      conversationId: id,
    };
    // Order matters: resuming the AI releases the assignee, so an explicit
    // `assigned_agent_id` in the same request is applied after it and wins.
    let applied = true;
    if (hasAi) {
      applied =
        applied &&
        (await setConversationAiPaused(
          scope,
          body.ai_autoreply_disabled as boolean
        ));
    }
    if (hasAssign) {
      applied =
        applied &&
        (await assignConversation(scope, (agentId as string | null) ?? null));
    }
    if (hasStatus) {
      applied =
        applied &&
        (await setConversationStatus(scope, body.status as ConversationStatus));
    }
    if (hasRead) {
      applied = applied && (await markConversationRead(scope));
    }
    if (!applied) {
      return fail('internal', 'Failed to update conversation', 500);
    }

    const result = await readSerialized(ctx, id);
    if (result.error || !result.value) {
      return fail('internal', 'Failed to read conversation', 500);
    }
    return ok(result.value);
  } catch (err) {
    return toApiErrorResponse(err);
  }
}
