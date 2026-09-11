import { NextResponse } from 'next/server';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import {
  resolveWhatsAppConfig,
  WhatsAppConfigError,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/resolve-config';
import { resolveTemplateHeaderMedia } from '@/lib/whatsapp/outbound-media';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { assertQuota, recordUsage } from '@/lib/billing/enforce';

interface BroadcastResult {
  phone: string;
  status: 'sent' | 'failed';
  whatsapp_message_id?: string;
  error?: string;
}

type OutstandingLookup =
  | {
      ok: true;
      outstanding: number | null;
      /** Sender number frozen on the campaign (migration 053). */
      whatsAppConfigId: string | null;
    }
  | { ok: false; response: NextResponse };

/**
 * How many recipients of the PERSISTED campaign still have to go out.
 *
 * The wizard (`use-broadcast-sending.ts`) splits a campaign into
 * requests of ten, so `recipients.length` measures a batch, never a
 * campaign: with 995 left in the monthly allowance a 1 000-recipient
 * blast would sail through its first 99 batches and take a 402 on the
 * hundredth — which is not retryable — leaving exactly the
 * half-delivered campaign fase 3 §4 sets out to avoid.
 *
 * Counting the campaign's still-'pending' rows fixes that: on the FIRST
 * batch every recipient is pending, so the whole campaign is weighed
 * before a single message leaves; on later batches what already went
 * out is in `usage_counters` instead, so `used + outstanding` keeps
 * adding up to the same number and the check never trips mid-campaign.
 * Recipients that failed are neither pending nor counted — a send Meta
 * refused is not billable, and it does not hold a seat either.
 *
 * `null` for a caller that sent no `broadcast_id` (the legacy body
 * shape, and anything calling this endpoint directly): all such a
 * request says about itself is its own recipient list.
 */
async function outstandingRecipients(
  supabase: SupabaseClient,
  accountId: string,
  broadcastId: unknown
): Promise<OutstandingLookup> {
  if (typeof broadcastId !== 'string' || broadcastId.length === 0) {
    return { ok: true, outstanding: null, whatsAppConfigId: null };
  }

  // Ownership first. An id belonging to another tenant must not be
  // measurable from here — and must never be billed to this account.
  const { data: broadcast, error: lookupError } = await supabase
    .from('broadcasts')
    .select('id, whatsapp_config_id')
    .eq('id', broadcastId)
    .eq('account_id', accountId)
    .maybeSingle();

  if (lookupError || !broadcast) {
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Broadcast not found' },
        { status: 404 }
      ),
    };
  }

  const { count, error: countError } = await supabase
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId)
    .eq('status', 'pending');

  if (countError) {
    // Fail closed, same rule as the stock limits: "we could not count"
    // can never be read as "you are using none of your allowance".
    console.error(
      '[broadcast] outstanding recipient count failed:',
      countError
    );
    return {
      ok: false,
      response: NextResponse.json(
        { error: 'Could not measure this campaign against your plan limit' },
        { status: 500 }
      ),
    };
  }

  return {
    ok: true,
    outstanding: count ?? 0,
    whatsAppConfigId: (broadcast.whatsapp_config_id as string | null) ?? null,
  };
}

/**
 * Two input shapes are accepted:
 *
 *   NEW (preferred — supports per-recipient variable substitution):
 *     {
 *       recipients: Array<{ phone: string; params: string[] }>,
 *       template_name, template_language
 *     }
 *
 *   LEGACY (all phones receive the same params — kept so existing
 *   callers don't break):
 *     {
 *       phone_numbers: string[],
 *       template_params: string[],
 *       template_name, template_language
 *     }
 *
 * Previous implementation only supported the legacy shape, and the
 * sending hook was forced to ship every batch with `templateParams[0]`
 * — meaning every recipient got contact-0's personalization. The new
 * shape is what actually fixes that.
 */
interface NewRecipient {
  phone: string;
  /** Body variable values, one per {{N}}. Legacy field. */
  params?: string[];
  /**
   * Structured per-send values (header text variable, media URL
   * override, URL/COPY_CODE button values). When set, takes
   * precedence over `params` for the body too — see
   * sendTemplateMessage for the merge rules.
   */
  messageParams?: SendTimeParams;
}

export async function POST(request: Request) {
  try {
    // Requires the 'agent' role — `canSendMessages` in lib/auth/roles is
    // explicit that running broadcasts is a write operation and that
    // viewers are read-only.
    //
    // This endpoint writes NOTHING to the database: it reads the config
    // and template, then calls Meta directly. So unlike the rest of the
    // app there was no RLS policy backstopping a missing role check —
    // resolving `account_id` straight off the profile (which only needs
    // 'viewer') was the ONLY gate, and it let a viewer blast a template
    // to arbitrary phone numbers from the account's WhatsApp number.
    // Nothing about that is recoverable after the fact, so the check has
    // to happen here.
    const { supabase, accountId, userId } = await requireRole('agent');

    // Per-user broadcast budget. Note: this limits how often a user
    // can *start* a campaign, not how many messages go out inside
    // one — the fan-out loop below runs without additional gating.
    const limit = checkRateLimit(`broadcast:${userId}`, RATE_LIMITS.broadcast);
    if (!limit.success) {
      return rateLimitResponse(limit);
    }

    const body = await request.json();
    const {
      recipients: newRecipients,
      phone_numbers,
      template_name,
      template_language,
      template_params,
      // Set by the wizard so the allowance below is weighed per
      // campaign instead of per batch of ten. Optional on purpose.
      broadcast_id,
    } = body;

    // Normalize to a list of {phone, params} regardless of shape.
    let recipients: NewRecipient[];
    if (Array.isArray(newRecipients) && newRecipients.length > 0) {
      recipients = newRecipients;
    } else if (Array.isArray(phone_numbers) && phone_numbers.length > 0) {
      const shared: string[] = Array.isArray(template_params)
        ? template_params
        : [];
      recipients = phone_numbers.map((phone: string) => ({
        phone,
        params: shared,
      }));
    } else {
      return NextResponse.json(
        {
          error:
            'Provide either `recipients` (preferred) or `phone_numbers` — must be a non-empty array',
        },
        { status: 400 }
      );
    }

    if (!template_name) {
      return NextResponse.json(
        { error: 'template_name is required' },
        { status: 400 }
      );
    }

    // Fase 3 §4: `broadcast_recipients`, weighed PER CAMPAIGN and not
    // per request — see `outstandingRecipients` for why a batch is the
    // wrong unit. Never less than what this very request would send, so
    // a direct caller (no `broadcast_id`) is still held to its own list
    // and a stale count can't wave a batch through. `toErrorResponse`
    // turns the throw into a 402 naming the metric, the limit and
    // `/billing`.
    const lookup = await outstandingRecipients(
      supabase,
      accountId,
      broadcast_id
    );
    if (!lookup.ok) return lookup.response;
    await assertQuota(
      accountId,
      'broadcast_recipients',
      Math.max(lookup.outstanding ?? 0, recipients.length)
    );

    // Fase 4 §1: this endpoint delivers ONE BATCH of a campaign that
    // the wizard created client-side, so the sender number is whatever
    // that `broadcasts` row froze — never the account default, or the
    // batches of a single campaign would leave through different
    // numbers as soon as someone changed the default mid-send.
    // `lookup.whatsAppConfigId` is null for a direct caller with no
    // `broadcast_id` and for campaigns older than migration 053; both
    // fall through to the default, which is what they used anyway.
    let config: WhatsAppConfigRow;
    let accessToken: string;
    try {
      const resolved = await resolveWhatsAppConfig(supabase, {
        accountId,
        configId: lookup.whatsAppConfigId ?? null,
        withToken: true,
      });
      config = resolved.row;
      accessToken = resolved.accessToken;
    } catch (err) {
      if (err instanceof WhatsAppConfigError) {
        return NextResponse.json(
          {
            error:
              err.code === 'whatsapp_number_not_found'
                ? 'The WhatsApp number this broadcast was sent from is no longer connected. Reconnect it, or start a new broadcast from another number.'
                : 'WhatsApp not configured. Please set up your WhatsApp integration first.',
          },
          { status: 400 }
        );
      }
      throw err;
    }

    // Load the template row once so sendTemplateMessage can build
    // header + button components on each iteration. Loading inside
    // the loop would N+1 against Supabase for every recipient.
    // Guard against a malformed local row crashing every send in
    // the loop with the same opaque TypeError — fail loudly once.
    const resolvedTemplate = await resolveTemplateRow(
      supabase,
      accountId,
      template_name,
      template_language
    );
    if (resolvedTemplate.malformed) {
      return NextResponse.json(
        {
          error:
            'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
        },
        { status: 500 }
      );
    }
    const templateRow = resolvedTemplate.row;

    const results: BroadcastResult[] = [];
    let sentCount = 0;
    let failedCount = 0;

    for (const recipient of recipients) {
      const sanitized = sanitizePhoneForMeta(recipient.phone);

      if (!isValidE164(sanitized)) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: 'Invalid phone number format',
        });
        failedCount++;
        continue;
      }

      // A bucket-hosted media header (the template's own or this
      // recipient's override) goes to Meta by media id. Cached per
      // (number, object), so the common "same header for everyone"
      // case uploads once for the whole broadcast. Scoped to this
      // account: an override naming another account's object is refused.
      let messageParams = recipient.messageParams;
      try {
        messageParams = await resolveTemplateHeaderMedia(
          templateRow,
          recipient.messageParams,
          {
            accountId,
            phoneNumberId: config.phone_number_id,
            accessToken,
            storage: supabaseAdmin().storage,
            db: supabaseAdmin(),
          }
        );
      } catch (error) {
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: error instanceof Error ? error.message : 'Unknown error',
        });
        failedCount++;
        continue;
      }

      // Retry with phone variants on "not in allowed list" so numbers
      // that differ only in a trunk-prefix 0 still reach recipients.
      const variants = phoneVariants(sanitized);
      let sentMessageId: string | null = null;
      let lastError: string | null = null;

      for (const variant of variants) {
        try {
          const result = await sendTemplateMessage({
            phoneNumberId: config.phone_number_id,
            accessToken,
            to: variant,
            templateName: template_name,
            language: resolvedTemplate.language,
            template: templateRow ?? undefined,
            messageParams,
            params: recipient.params ?? [],
          });
          sentMessageId = result.messageId;
          lastError = null;
          break;
        } catch (error) {
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          if (!isRecipientNotAllowedError(errorMessage)) {
            lastError = errorMessage;
            break;
          }
          lastError = errorMessage;
          // retry with next variant
        }
      }

      if (sentMessageId) {
        results.push({
          phone: recipient.phone,
          status: 'sent',
          whatsapp_message_id: sentMessageId,
        });
        sentCount++;
      } else {
        console.error(
          `Failed to send broadcast to ${recipient.phone}:`,
          lastError
        );
        results.push({
          phone: recipient.phone,
          status: 'failed',
          error: lastError || 'Unknown error',
        });
        failedCount++;
      }
    }

    // Counted after the fan-out and only for what actually left:
    // invalid numbers and Meta rejections are not recipients the
    // customer reached, so they are not billable.
    await recordUsage(accountId, 'broadcast_recipients', sentCount);

    return NextResponse.json({
      success: true,
      total: recipients.length,
      sent: sentCount,
      failed: failedCount,
      results,
    });
  } catch (error) {
    // requireRole throws Unauthorized/Forbidden; toErrorResponse maps
    // those to 401/403 and collapses anything else to a generic 500.
    console.error('Error in WhatsApp broadcast POST:', error);
    return toErrorResponse(error);
  }
}
