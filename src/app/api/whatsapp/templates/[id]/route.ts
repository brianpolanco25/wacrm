import { UUID_RE } from '@/lib/uuid';
import { NextResponse } from 'next/server';
import {
  resolveWhatsAppConfig,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/resolve-config';
import { resolveEffectiveAccountId } from '@/lib/auth/account';
import { createClient } from '@/lib/supabase/server';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  validateTemplatePayload,
  type TemplatePayload,
} from '@/lib/whatsapp/template-validators';
import {
  EDITABLE_TEMPLATE_STATUSES,
  deleteTemplate,
  editTemplate,
  isTemplatesDryRun as isDryRun,
} from '@/lib/whatsapp/template-operations';

/**
 * Per-template lifecycle endpoint.
 *
 * PATCH  — edit an existing Meta-side template (and re-submit). Used
 *          by the "Edit" action on APPROVED rows and the "Resubmit"
 *          action on REJECTED / PAUSED rows. Meta replaces components
 *          wholesale on edit and bumps status back to PENDING.
 *
 * DELETE — remove the template on Meta (when meta_template_id is set,
 *          scoped to a single language variant via hsm_id) AND drop
 *          the local row. Local-only rows skip the Meta call.
 *
 * Initial submission (DRAFT → PENDING) lives at the sibling
 * /submit endpoint — keep this route narrowly about lifecycle of
 * already-submitted templates.
 */

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
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

    // Resolve the caller's account_id so template + whatsapp_config
    // lookups work for teammates who didn't author the row.
    // The effective account (s9.5): the impersonated company inside a
    // support session, never the operator's own profile.
    const accountId =
      (await resolveEffectiveAccountId(supabase, user.id)) ?? undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    let payload: TemplatePayload;
    try {
      payload = (await request.json()) as TemplatePayload;
    } catch {
      return NextResponse.json(
        { error: 'Invalid JSON body.' },
        { status: 400 }
      );
    }

    // RLS handles ownership, but we need the existing row to read
    // meta_template_id and status — fetch explicitly.
    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, status, meta_template_id, language')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (lookupErr || !existing) {
      return NextResponse.json(
        { error: 'Template not found.' },
        { status: 404 }
      );
    }

    if (!existing.meta_template_id) {
      return NextResponse.json(
        {
          error:
            'This template was never submitted to Meta — use New Template to submit it instead.',
        },
        { status: 400 }
      );
    }

    if (!EDITABLE_TEMPLATE_STATUSES.has(existing.status)) {
      return NextResponse.json(
        {
          error: `Templates in status ${existing.status} cannot be edited. Allowed: APPROVED, REJECTED, PAUSED.`,
        },
        { status: 400 }
      );
    }

    if (payload.category === 'Authentication') {
      return NextResponse.json(
        {
          error:
            'AUTHENTICATION templates are not editable here — manage them in Meta WhatsApp Manager.',
        },
        { status: 400 }
      );
    }

    try {
      validateTemplatePayload(payload);
    } catch (e) {
      return NextResponse.json(
        { error: e instanceof Error ? e.message : 'Validation failed.' },
        { status: 400 }
      );
    }

    let accessToken: string | null = null;
    if (!isDryRun()) {
      // Fase 4 §1, deuda deliberada: en Meta las plantillas son POR WABA y
      // aquí son UNIQUE(account_id, name, language), así que una cuenta con
      // números bajo WABA DISTINTAS no puede expresar a cuál pertenece cada
      // plantilla. Hasta que `message_templates` tenga su propia `waba_id`,
      // las rutas de plantillas trabajan contra el número PREDETERMINADO.
      // Correcto en el caso normal (varios números, una WABA); anotado como
      // deuda en progress/impl_multi-number.md.
      let config: WhatsAppConfigRow;
      try {
        config = (await resolveWhatsAppConfig(supabase, { accountId })).row;
      } catch {
        return NextResponse.json(
          { error: 'WhatsApp not configured.' },
          { status: 400 }
        );
      }
      accessToken = decrypt(config.access_token);
    }

    // Meta replaces components wholesale on edit and the status flips
    // back to PENDING for review.
    const result = await editTemplate(supabase, {
      accountId,
      id,
      metaTemplateId: existing.meta_template_id,
      accessToken,
      payload,
      select: '*',
    });
    if (!result.ok) {
      if (result.step === 'local') {
        const reason = result.error?.message ?? 'row not found';
        return NextResponse.json(
          {
            error: `Edited on Meta but failed to save locally: ${reason}. Run "Sync from Meta" to recover.`,
          },
          { status: 500 }
        );
      }
      const e = result.error;
      const fallback =
        result.step === 'header'
          ? 'Header image upload failed.'
          : 'Meta edit failed.';
      return NextResponse.json(
        { error: e instanceof Error ? e.message : fallback },
        { status: result.step === 'header' ? 400 : 502 }
      );
    }
    const row = result.row;

    return NextResponse.json({
      success: true,
      template: row,
      dry_run: isDryRun(),
    });
  } catch (error) {
    console.error('Error editing template:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to edit template.',
      },
      { status: 500 }
    );
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params;
    if (!UUID_RE.test(id)) {
      return NextResponse.json(
        { error: 'Invalid template id.' },
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

    // Same account-scoping rationale as the PATCH handler above —
    // teammates need to be able to operate on shared templates +
    // the shared whatsapp_config.
    // The effective account (s9.5): the impersonated company inside a
    // support session, never the operator's own profile.
    const accountId =
      (await resolveEffectiveAccountId(supabase, user.id)) ?? undefined;
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 }
      );
    }

    const { data: existing, error: lookupErr } = await supabase
      .from('message_templates')
      .select('id, name, meta_template_id')
      .eq('id', id)
      .eq('account_id', accountId)
      .maybeSingle();
    if (lookupErr || !existing) {
      return NextResponse.json(
        { error: 'Template not found.' },
        { status: 404 }
      );
    }

    let target: { wabaId: string; accessToken: string } | null = null;
    if (existing.meta_template_id && !isDryRun()) {
      // Fase 4 §1, deuda deliberada: en Meta las plantillas son POR WABA y
      // aquí son UNIQUE(account_id, name, language), así que una cuenta con
      // números bajo WABA DISTINTAS no puede expresar a cuál pertenece cada
      // plantilla. Hasta que `message_templates` tenga su propia `waba_id`,
      // las rutas de plantillas trabajan contra el número PREDETERMINADO.
      // Correcto en el caso normal (varios números, una WABA); anotado como
      // deuda en progress/impl_multi-number.md.
      let config: WhatsAppConfigRow;
      try {
        config = (await resolveWhatsAppConfig(supabase, { accountId })).row;
      } catch {
        return NextResponse.json(
          { error: 'WhatsApp not configured — cannot delete on Meta.' },
          { status: 400 }
        );
      }
      if (!config.waba_id) {
        return NextResponse.json(
          { error: 'WhatsApp not configured — cannot delete on Meta.' },
          { status: 400 }
        );
      }
      target = {
        wabaId: config.waba_id,
        accessToken: decrypt(config.access_token),
      };
    }

    const result = await deleteTemplate(supabase, {
      accountId,
      id,
      name: existing.name,
      metaTemplateId: existing.meta_template_id,
      target,
    });
    if (!result.ok && result.step === 'meta') {
      const e = result.error;
      const message = e instanceof Error ? e.message : 'Meta delete failed.';
      return NextResponse.json({ error: message }, { status: 502 });
    }
    if (!result.ok) {
      return NextResponse.json(
        {
          error: `Deleted on Meta but failed to delete locally: ${result.error.message}.`,
        },
        { status: 500 }
      );
    }

    return NextResponse.json({ success: true, dry_run: isDryRun() });
  } catch (error) {
    console.error('Error deleting template:', error);
    return NextResponse.json(
      {
        error:
          error instanceof Error ? error.message : 'Failed to delete template.',
      },
      { status: 500 }
    );
  }
}
