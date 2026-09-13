// ============================================================
// Public-API broadcast core.
//
// Splits a broadcast into two phases so the HTTP route can persist +
// acknowledge fast and fan out afterwards (in `after()`):
//
//   createBroadcast()  — validate, resolve contacts, insert the
//                        `broadcasts` row + `broadcast_recipients`
//                        rows (status 'pending'), return a plan.
//   deliverBroadcast() — send each recipient's template via Meta
//                        (phone-variant retry), stamp each recipient
//                        row + the aggregate counts, finalize status.
//
// Recipient rows carry `whatsapp_message_id`, so the inbound webhook's
// status handler (which matches on that column) updates delivered/read
// for API broadcasts exactly as it does for dashboard ones.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { sendTemplateMessage } from '@/lib/whatsapp/meta-api';
import {
  resolveWhatsAppConfig,
  WhatsAppConfigError,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/resolve-config';
import { resolveTemplateHeaderMedia } from '@/lib/whatsapp/outbound-media';
import type { SendTimeParams } from '@/lib/whatsapp/template-send-builder';
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils';
import { resolveTemplateRow } from '@/lib/whatsapp/template-body';
import type { MessageTemplate } from '@/types';
import { findOrCreateContact } from '@/lib/api/v1/contacts';
import { assertQuota, recordUsage } from '@/lib/billing/enforce';

/** Thrown by createBroadcast on a caller-visible failure; route maps it. */
export class BroadcastError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = 'BroadcastError';
    this.code = code;
    this.status = status;
  }
}

/**
 * Remap a `WhatsAppConfigError` from the shared resolver onto the
 * broadcast error family, keeping code and status.
 */
export function toBroadcastError(err: unknown): unknown {
  if (err instanceof WhatsAppConfigError) {
    return new BroadcastError(err.code, err.message, err.status);
  }
  return err;
}

export interface BroadcastRecipientInput {
  /** E.164 phone. */
  to: string;
  /** Positional body params for the template ({{1}}, {{2}}…). */
  params?: string[];
}

export interface CreateBroadcastParams {
  name?: string | null;
  templateName: string;
  templateLanguage?: string | null;
  recipients: BroadcastRecipientInput[];
  /**
   * Sender number for the whole campaign (fase 4 §1). Omitted = the
   * account default. Once chosen it is frozen on the `broadcasts` row:
   * a resume must not switch numbers mid-campaign.
   */
  whatsAppConfigId?: string | null;
}

interface PlannedRecipient {
  recipientRowId: string;
  phone: string;
  params: string[];
}

export interface BroadcastPlan {
  broadcastId: string;
  /**
   * Tenant the broadcast belongs to. It scopes the header-media lookup
   * (fase 2) and it is who pays for this fan-out (fase 3). On the plan
   * rather than a parameter so a plan can never be delivered without an
   * account to bill or to scope by: every caller (`/api/v1/broadcasts`,
   * the resume route) already resolved it before it could read a single
   * recipient row.
   */
  accountId: string;
  templateName: string;
  templateLanguage: string;
  phoneNumberId: string;
  accessToken: string;
  templateRow: MessageTemplate | null;
  planned: PlannedRecipient[];
  /** Phones rejected up front (invalid E.164) — counted as failed. */
  rejected: number;
}

const MAX_RECIPIENTS = 1000;

/**
 * Validate + persist a broadcast, resolving each recipient to a
 * contact. Returns a plan for {@link deliverBroadcast}. Throws
 * {@link BroadcastError} on bad input / missing config / a malformed
 * template / a DB failure — nothing is sent in this phase.
 */
export async function createBroadcast(
  db: SupabaseClient,
  accountId: string,
  auditUserId: string,
  params: CreateBroadcastParams
): Promise<BroadcastPlan> {
  const { name, templateName, recipients } = params;

  if (!templateName) {
    throw new BroadcastError('bad_request', "'template_name' is required", 400);
  }
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new BroadcastError(
      'bad_request',
      "'recipients' must be a non-empty array of { to, params? }",
      400
    );
  }
  if (recipients.length > MAX_RECIPIENTS) {
    throw new BroadcastError(
      'bad_request',
      `A broadcast is capped at ${MAX_RECIPIENTS} recipients per request; split larger sends`,
      400
    );
  }

  // Which number does this campaign go out through? (fase 4 §1). The
  // caller's explicit choice wins; otherwise the account default. It is
  // stamped on the `broadcasts` row below so a resume days later leaves
  // through the SAME number — see broadcast-resume.
  let config: WhatsAppConfigRow;
  let accessToken: string;
  try {
    const resolved = await resolveWhatsAppConfig(db, {
      accountId,
      configId: params.whatsAppConfigId,
      withToken: true,
    });
    config = resolved.row;
    accessToken = resolved.accessToken;
  } catch (err) {
    throw toBroadcastError(err);
  }

  // Template row (once) for header/button components; guard a
  // malformed local row rather than N identical opaque failures.
  const resolvedTemplate = await resolveTemplateRow(
    db,
    accountId,
    templateName,
    params.templateLanguage
  );
  if (resolvedTemplate.malformed) {
    throw new BroadcastError(
      'template_malformed',
      'Template row is malformed locally — run "Sync from Meta" in Settings to repair it before broadcasting.',
      500
    );
  }
  const templateRow = resolvedTemplate.row;

  // Normalize the list WITHOUT touching the database: drop phones Meta
  // could not dial (counted as rejected rather than aborting the whole
  // broadcast) and collapse a number the caller listed twice, keeping
  // the first occurrence so its params aren't overwritten by a later
  // duplicate.
  const seenPhone = new Set<string>();
  const candidates: { phone: string; params: string[] }[] = [];
  let rejected = 0;
  for (const r of recipients) {
    const sanitized = sanitizePhoneForMeta(
      typeof r.to === 'string' ? r.to : ''
    );
    if (!isValidE164(sanitized)) {
      rejected++;
      continue;
    }
    if (seenPhone.has(sanitized)) continue;
    seenPhone.add(sanitized);
    candidates.push({
      phone: sanitized,
      params: Array.isArray(r.params)
        ? r.params.filter((p): p is string => typeof p === 'string')
        : [],
    });
  }

  if (candidates.length === 0) {
    throw new BroadcastError(
      'bad_request',
      'No recipients had a valid E.164 phone number',
      400
    );
  }

  // Fase 3 §4 — `broadcast_recipients`. The whole campaign is weighed
  // BEFORE anything is written: a broadcast is one unit of work for the
  // operator, and refusing it halfway would leave a half-delivered blast
  // that no one can tell the halves of. `assertQuota` raises
  // `QuotaExceededError`, which both error envelopes render as a 402
  // naming metric, limit and `/billing`.
  //
  // This sits ABOVE the contact resolution below, and the difference is
  // not cosmetic: `findOrCreateContact` WRITES. Weighed after that loop,
  // a 2 000-address campaign refused for quota still left up to 2 000
  // new contacts in the account — a refusal with a side effect, and the
  // comment that used to sit here, claiming nothing had been written
  // yet, was false.
  //
  // The price is that what gets weighed is the distinct valid phones, an
  // UPPER BOUND: contact resolution can still collapse two different
  // numbers that fuzzy-match onto one contact, and such a campaign is
  // refused slightly early. That errs towards refusing, which is the
  // safe side of a cap, and `deliverBroadcast` re-weighs the exact
  // recipient rows before the first send anyway.
  await assertQuota(accountId, 'broadcast_recipients', candidates.length);

  // Resolve each recipient to a contact (creating the ones that don't
  // exist yet) and collapse any that landed on the SAME contact, so it
  // is messaged once and the row↔params pairing below (keyed by
  // contact_id) stays unambiguous.
  const seenContact = new Set<string>();
  const deduped: { contactId: string; phone: string; params: string[] }[] = [];
  for (const c of candidates) {
    const { id } = await findOrCreateContact(db, accountId, auditUserId, {
      phone: c.phone,
    });
    if (seenContact.has(id)) continue;
    seenContact.add(id);
    deduped.push({ contactId: id, ...c });
  }

  // Persist the broadcast + its recipients. The count columns
  // (sent/delivered/read/replied/failed) are owned by the DB aggregate
  // trigger (migrations 003/005) and derived purely from
  // broadcast_recipients rows — we deliberately do NOT seed them here
  // (a manual value would be clobbered by the trigger on the first
  // recipient change). `rejected` phones have no recipient row, so they
  // are reported to the caller in the POST response, not in these
  // persisted counts.
  // Insert the parent broadcast and its recipient rows in ONE transaction
  // (migration 037's create_broadcast_with_recipients). Previously these
  // were two separate inserts: if the recipient insert failed, the parent
  // was already persisted with status 'sending' and no recipients, leaving
  // an orphaned campaign that looked like it was sending but had no
  // delivery plan (issue #370). The function body is atomic, so a recipient
  // failure now rolls the parent back and nothing orphaned survives.
  const { data: createdRows, error: createErr } = await db.rpc(
    'create_broadcast_with_recipients',
    {
      p_account_id: accountId,
      p_user_id: auditUserId,
      p_name: name || `API broadcast (${templateName})`,
      p_template_name: templateName,
      p_template_language: resolvedTemplate.language,
      p_total_recipients: deduped.length,
      p_contact_ids: deduped.map((r) => r.contactId),
      // Frozen per-recipient params (migration 038) — without them a
      // resume of this broadcast has no way to reconstruct {{1}}.
      p_template_params: deduped.map((r) => r.params),
    }
  );
  if (createErr || !createdRows || createdRows.length === 0) {
    console.error('[broadcast-core] create broadcast error:', createErr);
    throw new BroadcastError('internal', 'Failed to create broadcast', 500);
  }

  const broadcastId = createdRows[0].broadcast_id as string;

  // Freeze the sender number on the campaign (migration 053). A second
  // statement rather than an eighth RPC parameter: the transactional
  // function of 037 is granted to `service_role` only and its signature
  // is referenced by name in four GRANT/REVOKE lines, so widening it
  // buys a migration's worth of risk to save a write. If this UPDATE
  // loses (process dies between the two), the column stays NULL and a
  // resume falls back to the default — the behaviour of every campaign
  // created before 053, not a new failure mode.
  const { error: sealErr } = await db
    .from('broadcasts')
    .update({ whatsapp_config_id: config.id })
    .eq('id', broadcastId)
    .eq('account_id', accountId);
  if (sealErr) {
    console.error('[broadcast-core] seal sender number failed:', sealErr);
  }

  // Pair each inserted recipient row back to its phone/params by
  // contact_id — unambiguous now that duplicates are collapsed.
  const byContact = new Map(deduped.map((r) => [r.contactId, r]));
  const planned: PlannedRecipient[] = createdRows.map(
    (row: { recipient_id: string; contact_id: string }) => {
      const r = byContact.get(row.contact_id)!;
      return {
        recipientRowId: row.recipient_id,
        phone: r.phone,
        params: r.params,
      };
    }
  );

  return {
    broadcastId,
    accountId,
    templateName,
    templateLanguage: resolvedTemplate.language,
    phoneNumberId: config.phone_number_id,
    accessToken,
    templateRow,
    planned,
    rejected,
  };
}

/**
 * Fan out a {@link BroadcastPlan}: send each recipient's template
 * (phone-variant retry) and stamp its `broadcast_recipients` row.
 * Best-effort per recipient — one failure never aborts the rest.
 * Designed to run inside `after()`.
 *
 * The per-status count columns on `broadcasts` are owned by the DB
 * aggregate trigger (migrations 003/005): each recipient-row update
 * below advances them automatically, and later Meta delivery/read
 * webhooks keep advancing them. We therefore never write those columns
 * here — only the terminal `status` — otherwise a manual value would
 * race and clobber the trigger-maintained counts.
 *
 * Fase 3 §4: the pass is weighed against `broadcast_recipients` before
 * the first send and counted afterwards for what actually left. The
 * check lives HERE, not in the routes, because every fan-out in the
 * product funnels through this function — the public API's create, and
 * the dashboard's resume/retry. A limit honoured by one caller is not a
 * limit. `createBroadcast` checks too: it is the cheaper refusal (no
 * campaign is persisted), while this one is the one that cannot be
 * walked around.
 */
export async function deliverBroadcast(
  db: SupabaseClient,
  plan: BroadcastPlan
): Promise<void> {
  // Throws QuotaExceededError -> 402. Before the loop on purpose — and
  // before the header-media upload below — so that when the allowance
  // cannot cover the pass, nobody is messaged at all and nothing is
  // uploaded to Meta for a campaign that is not going out.
  await assertQuota(
    plan.accountId,
    'broadcast_recipients',
    plan.planned.length
  );

  // A bucket-hosted media header is uploaded to Meta once and sent by id
  // to every recipient; a failure here fails the whole pass up front
  // rather than once per recipient, so it is stamped on every row.
  let headerParams: SendTimeParams | undefined;
  try {
    headerParams = await resolveTemplateHeaderMedia(
      plan.templateRow,
      undefined,
      {
        accountId: plan.accountId,
        phoneNumberId: plan.phoneNumberId,
        accessToken: plan.accessToken,
        storage: db.storage,
        db,
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    for (const recipient of plan.planned) {
      await db
        .from('broadcast_recipients')
        .update({ status: 'failed', error_message: message })
        .eq('id', recipient.recipientRowId);
    }
    await finalizeBroadcastStatus(db, plan.broadcastId);
    return;
  }

  let sent = 0;
  for (const recipient of plan.planned) {
    const variants = phoneVariants(recipient.phone);
    let sentMessageId: string | null = null;
    let lastError: string | null = null;

    for (const variant of variants) {
      try {
        const result = await sendTemplateMessage({
          phoneNumberId: plan.phoneNumberId,
          accessToken: plan.accessToken,
          to: variant,
          templateName: plan.templateName,
          language: plan.templateLanguage,
          template: plan.templateRow ?? undefined,
          messageParams: headerParams,
          params: recipient.params,
        });
        sentMessageId = result.messageId;
        lastError = null;
        break;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Unknown error';
        lastError = message;
        // Only a "recipient not allowed" error is worth another variant.
        if (!isRecipientNotAllowedError(message)) break;
      }
    }

    if (sentMessageId) {
      sent++;
      await db
        .from('broadcast_recipients')
        .update({
          status: 'sent',
          sent_at: new Date().toISOString(),
          whatsapp_message_id: sentMessageId,
          error_message: null,
        })
        .eq('id', recipient.recipientRowId);
    } else {
      await db
        .from('broadcast_recipients')
        .update({
          status: 'failed',
          error_message: lastError || 'Unknown error',
        })
        .eq('id', recipient.recipientRowId);
    }
  }

  // Counted after the fan-out and only for what Meta accepted: an
  // invalid number or a rejected send is not a recipient the customer
  // reached, so it is not billable.
  await recordUsage(plan.accountId, 'broadcast_recipients', sent);

  await finalizeBroadcastStatus(db, plan.broadcastId);
}

/**
 * Flip a broadcast out of `sending` once no recipient is left pending.
 *
 * Derived from the recipient rows rather than from a counter local to
 * one delivery pass: a resume (issue #472) delivers only the leftovers,
 * so "nothing sent *this* pass" must not mark a campaign failed when
 * 800 of its 1 000 recipients went out earlier. `failed` means every
 * single recipient failed; anything else that reached Meta is `sent`,
 * with the per-recipient failures visible in `failed_count`.
 *
 * Per-status counts stay trigger-owned (migrations 003/005) — only the
 * terminal `status` is written here.
 */
export async function finalizeBroadcastStatus(
  db: SupabaseClient,
  broadcastId: string
): Promise<void> {
  const countWhere = async (status: string): Promise<number> => {
    const { count } = await db
      .from('broadcast_recipients')
      .select('id', { count: 'exact', head: true })
      .eq('broadcast_id', broadcastId)
      .eq('status', status);
    return count ?? 0;
  };

  // Still work outstanding (a capped resume pass) — leave it 'sending'
  // so the UI keeps offering Resume.
  if ((await countWhere('pending')) > 0) return;

  const failed = await countWhere('failed');
  const { count: total } = await db
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcastId);

  await db
    .from('broadcasts')
    .update({
      status: failed > 0 && failed === (total ?? 0) ? 'failed' : 'sent',
      updated_at: new Date().toISOString(),
    })
    .eq('id', broadcastId);
}
