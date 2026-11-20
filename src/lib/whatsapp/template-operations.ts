import type { SupabaseClient } from '@supabase/supabase-js';
// The flows path, not auth: the route tests mock this module.
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  deleteMessageTemplate,
  editMessageTemplate,
  submitMessageTemplate,
} from '@/lib/whatsapp/meta-api';
import { buildMetaTemplatePayload } from '@/lib/whatsapp/template-components';
import { ensureImageHeaderHandle } from '@/lib/whatsapp/template-header-handle';
import type { TemplatePayload } from '@/lib/whatsapp/template-validators';

// ============================================================
// Submit / edit / delete steps shared by the panel
// (`/api/whatsapp/templates/**`) and the public API
// (`/api/v1/templates/**`). Each route keeps its own auth, WABA
// resolution, status codes and response envelope; these only run the
// Meta call and the account-scoped writes, and hand failures back.
// ============================================================

/** Meta only lets these three be edited. */
export const EDITABLE_TEMPLATE_STATUSES = new Set([
  'APPROVED',
  'REJECTED',
  'PAUSED',
]);

export function isTemplatesDryRun(): boolean {
  return (
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === 'true' ||
    process.env.WHATSAPP_TEMPLATES_DRY_RUN === '1'
  );
}

/** Which step failed and its raw error; the route words the response. */
export type TemplateStepFailure = {
  ok: false;
  step: 'header' | 'meta';
  error: unknown;
};

/** The content columns every write of a template row carries. */
export function templateContentColumns(payload: TemplatePayload) {
  return {
    category: payload.category,
    header_type: payload.header_type ?? null,
    header_content: payload.header_content ?? null,
    header_media_url: payload.header_media_url ?? null,
    header_handle: payload.header_handle ?? null,
    body_text: payload.body_text,
    footer_text: payload.footer_text ?? null,
    buttons: payload.buttons ?? null,
    sample_values: payload.sample_values ?? null,
  };
}

/** Image headers need a fresh Resumable-Upload handle on every submit and edit. */
async function headerHandle(
  payload: TemplatePayload,
  accessToken: string,
  accountId: string
): Promise<TemplateStepFailure | null> {
  try {
    await ensureImageHeaderHandle(payload, accessToken, {
      accountId,
      storage: supabaseAdmin().storage,
      db: supabaseAdmin(),
    });
    return null;
  } catch (error) {
    return { ok: false, step: 'header', error };
  }
}

/** Header handle, then create on Meta. Writes nothing locally. */
export async function submitTemplateToMeta(
  payload: TemplatePayload,
  target: { wabaId: string; accessToken: string },
  accountId: string
): Promise<{ ok: true; id: string; status: string } | TemplateStepFailure> {
  const failed = await headerHandle(payload, target.accessToken, accountId);
  if (failed) return failed;
  try {
    const meta = await submitMessageTemplate({
      wabaId: target.wabaId,
      accessToken: target.accessToken,
      payload: buildMetaTemplatePayload(payload),
    });
    return { ok: true, id: meta.id, status: meta.status };
  } catch (error) {
    return { ok: false, step: 'meta', error };
  }
}

/**
 * Edit: header handle, Meta edit, then the local row back to PENDING.
 * `accessToken: null` is dry-run (no Meta call). A Meta refusal is
 * recorded on the row (`submission_error`) so the reason shows on the
 * next read. Every write is scoped by `account_id`.
 */
export async function editTemplate(
  db: SupabaseClient,
  args: {
    accountId: string;
    id: string;
    metaTemplateId: string;
    accessToken: string | null;
    payload: TemplatePayload;
    select: string;
  }
): Promise<
  | { ok: true; row: Record<string, unknown> }
  | TemplateStepFailure
  | { ok: false; step: 'local'; error: { message: string } | null }
> {
  const { accountId, id, payload } = args;
  if (args.accessToken !== null) {
    const failed = await headerHandle(payload, args.accessToken, accountId);
    if (failed) return failed;
    try {
      await editMessageTemplate({
        metaTemplateId: args.metaTemplateId,
        accessToken: args.accessToken,
        components: buildMetaTemplatePayload(payload).components,
      });
    } catch (error) {
      await db
        .from('message_templates')
        .update({
          submission_error:
            error instanceof Error ? error.message : 'Meta edit failed.',
          last_submitted_at: new Date().toISOString(),
        })
        .eq('id', id)
        .eq('account_id', accountId);
      return { ok: false, step: 'meta', error };
    }
  }

  const { data, error } = await db
    .from('message_templates')
    .update({
      ...templateContentColumns(payload),
      status: 'PENDING',
      submission_error: null,
      rejection_reason: null,
      last_submitted_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('account_id', accountId)
    .select(args.select)
    .maybeSingle();
  if (error || !data) return { ok: false, step: 'local', error };
  return { ok: true, row: data as unknown as Record<string, unknown> };
}

/**
 * Delete: on Meta first when `target` is set (only this language
 * variant, via hsm_id — without it Meta drops every translation that
 * shares the name), then the local row of this account. `deleted` is
 * false when no local row matched.
 */
export async function deleteTemplate(
  db: SupabaseClient,
  args: {
    accountId: string;
    id: string;
    name: string;
    metaTemplateId: string | null;
    target: { wabaId: string; accessToken: string } | null;
  }
): Promise<
  | { ok: true; deleted: boolean }
  | { ok: false; step: 'meta'; error: unknown }
  | { ok: false; step: 'local'; error: { message: string } }
> {
  if (args.target && args.metaTemplateId) {
    try {
      await deleteMessageTemplate({
        wabaId: args.target.wabaId,
        accessToken: args.target.accessToken,
        name: args.name,
        metaTemplateId: args.metaTemplateId,
      });
    } catch (error) {
      return { ok: false, step: 'meta', error };
    }
  }
  const { data, error } = await db
    .from('message_templates')
    .delete()
    .eq('id', args.id)
    .eq('account_id', args.accountId)
    .select('id')
    .maybeSingle();
  if (error) return { ok: false, step: 'local', error };
  return { ok: true, deleted: !!data };
}
