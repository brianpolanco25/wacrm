// ============================================================
// /api/whatsapp/service-cap — cuota gratis de mensajes de servicio por
// número (p11.3).
//
//   GET   cualquier miembro: la acción de la cuenta y, por número, los
//         mensajes de servicio entregados este mes y si agotó la cuota.
//         Lo pintan la bandeja (aviso) y Ajustes → WhatsApp.
//   PATCH admin+, fuera de una sesión de soporte: cambia
//         `accounts.service_cap_action` (warn | pause_ai).
//
// El conteo sale de `service_quota_usage` (080), que solo ejecuta
// `service_role`: la RLS de `message_charges` (075) deja leer solo a
// admin+, y el aviso es para todos. Ese es el ÚNICO uso del rol de
// servicio aquí, y siempre con el `account_id` de la sesión (CP3). Todo
// lo demás va con el cliente de la sesión (RLS) y filtro explícito.
//
// Nunca llama a Meta. Las cuentas `managed` (076) no tienen cuota que
// cuidar: `numbers: []` sin tocar la función.
// ============================================================

import { NextResponse } from 'next/server';

import {
  assertNotSupportSession,
  getCurrentAccount,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/flows/admin-client';
import {
  SERVICE_FREE_TIER_PER_NUMBER,
  asServiceCapAction,
  loadServiceUsage,
  serviceCapState,
  serviceMonthWindow,
  type ServiceCapAction,
} from '@/lib/billing/service-cap';
import { metaBillingOf } from '@/lib/whatsapp/payment-method';

const LOAD_FAILED = 'Failed to load the service quota';

/** Para que la ruta no confunda un fallo de lectura con un error de auth. */
class LoadError extends Error {}

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const { monthStart, resetsAt } = serviceMonthWindow(new Date());

    try {
      const { data: sub, error: subErr } = await ctx.supabase
        .from('subscriptions')
        .select('meta_billing')
        .eq('account_id', ctx.accountId)
        .maybeSingle();
      if (subErr) throw new LoadError(`subscriptions: ${subErr.message}`);
      const metaBilling = metaBillingOf(sub as Record<string, unknown> | null);

      const { data: account, error: accErr } = await ctx.supabase
        .from('accounts')
        .select('service_cap_action')
        .eq('id', ctx.accountId)
        .maybeSingle();
      if (accErr) throw new LoadError(`accounts: ${accErr.message}`);
      const action = asServiceCapAction(account?.service_cap_action);

      const base = {
        metaBilling,
        action,
        freeTier: SERVICE_FREE_TIER_PER_NUMBER,
        monthStart: monthStart.toISOString(),
        resetsAt: resetsAt.toISOString(),
      };
      if (metaBilling === 'managed') {
        return NextResponse.json({ ...base, numbers: [] });
      }

      const { data: rows, error: cfgErr } = await ctx.supabase
        .from('whatsapp_config')
        .select('id, label, display_phone_number, is_default, created_at')
        .eq('account_id', ctx.accountId)
        .order('is_default', { ascending: false })
        .order('created_at', { ascending: true });
      if (cfgErr) throw new LoadError(`whatsapp_config: ${cfgErr.message}`);

      const numbers = (rows ?? []) as Array<{
        id: string;
        label: string | null;
        display_phone_number: string | null;
      }>;
      // Sin números no hay nada que contar.
      const usage =
        numbers.length > 0
          ? await loadServiceUsage(supabaseAdmin(), ctx.accountId)
          : new Map();

      return NextResponse.json({
        ...base,
        numbers: numbers.map((n) => ({
          id: n.id,
          label: n.label ?? null,
          displayPhoneNumber: n.display_phone_number ?? null,
          ...serviceCapState(usage.get(n.id)),
        })),
      });
    } catch (err) {
      console.error(
        '[service-cap] GET failed:',
        err instanceof Error ? err.message : err
      );
      return NextResponse.json({ error: LOAD_FAILED }, { status: 500 });
    }
  } catch (err) {
    return toErrorResponse(err);
  }
}

export async function PATCH(request: Request) {
  try {
    const ctx = await requireRole('admin');
    // Una sesión de soporte actúa como admin, pero `accounts` queda fuera de
    // lo que puede escribir (072): 403 explícito y auditado, no un 404 por RLS.
    await assertNotSupportSession(ctx);

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
    }
    const raw = (body as { action?: unknown } | null)?.action;
    if (raw !== 'warn' && raw !== 'pause_ai') {
      return NextResponse.json(
        { error: "action must be 'warn' or 'pause_ai'" },
        { status: 400 }
      );
    }
    const action: ServiceCapAction = raw;

    // Cliente de la sesión: lo protege `accounts_update` (017).
    const { data, error } = await ctx.supabase
      .from('accounts')
      .update({ service_cap_action: action })
      .eq('id', ctx.accountId)
      .select('service_cap_action')
      .maybeSingle();
    if (error) {
      console.error('[service-cap] PATCH failed:', error.message);
      return NextResponse.json(
        { error: 'Failed to save the setting' },
        { status: 500 }
      );
    }
    if (!data) {
      return NextResponse.json({ error: 'Account not found' }, { status: 404 });
    }
    return NextResponse.json({
      action: asServiceCapAction(data.service_cap_action),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
