// ============================================================
// GET /api/account/integrations — Ajustes → Integraciones (n13.1, R14).
//
// Cualquier miembro de la cuenta (en sesión de soporte, la cuenta
// efectiva): el catálogo activo, las retiradas que la cuenta aún tiene
// activadas y, por cada una, el estado de ESTA cuenta. Nunca la
// credencial ni su cifrado. Más `planAllows` (feature `integrations`,
// D2), `canManage` (admin+; en sesión de soporte también, porque el rol
// efectivo es `admin`: n13.6 revirtió D3) y `supportSession`, para que la
// UI avise de que la acción queda registrada.
// ============================================================

import { NextResponse } from 'next/server';

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account';
import { supabaseAdmin } from '@/lib/auth/admin-client';
import { hasMinRole } from '@/lib/auth/roles';
import { getEntitlements, hasFeature } from '@/lib/billing/entitlements';
import { loadAccountIntegrations } from '@/lib/integrations/account';

export async function GET() {
  try {
    const ctx = await getCurrentAccount();
    const [integrations, entitlements] = await Promise.all([
      loadAccountIntegrations(supabaseAdmin(), ctx.accountId),
      getEntitlements(ctx.accountId),
    ]);
    return NextResponse.json({
      integrations,
      planAllows: hasFeature(entitlements, 'integrations'),
      canManage: hasMinRole(ctx.role, 'admin'),
      supportSession: Boolean(ctx.impersonation),
    });
  } catch (err) {
    return toErrorResponse(err);
  }
}
