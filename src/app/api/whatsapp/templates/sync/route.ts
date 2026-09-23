import { NextResponse } from 'next/server';
import {
  resolveWhatsAppConfig,
  type WhatsAppConfigRow,
} from '@/lib/whatsapp/resolve-config';
import {
  ForbiddenError,
  UnauthorizedError,
  requireRole,
  toErrorResponse,
} from '@/lib/auth/account';
import { decrypt } from '@/lib/whatsapp/encryption';
import {
  syncTemplatesFromMeta,
  TemplateSyncError,
} from '@/lib/whatsapp/template-sync';

/**
 * Lo único que viaja al navegador cuando una plantilla concreta no se
 * pudo guardar. Mismo texto que `POST /api/v1/templates/sync` (80e0e9d).
 */
const TEMPLATE_SAVE_FAILED = 'Template could not be saved';

/**
 * Sync message templates from Meta → local message_templates table.
 *
 * El algoritmo vive en `src/lib/whatsapp/template-sync.ts` desde la
 * fase 7 §3: `POST /api/v1/templates/sync` hace exactamente lo mismo
 * para un cliente de la API pública, y dos copias acabarían
 * divergiendo. Esta ruta se queda con lo que es suyo: autenticar por
 * sesión, resolver el número del panel y traducir el resultado a la
 * forma que espera la interfaz.
 */
export async function POST() {
  try {
    // Syncing rewrites the account-wide template catalog, which is
    // settings-class data: `canEditSettings` and the message_templates
    // insert/update RLS policies (migration 017) both require 'admin'.
    // Resolving account_id off the profile only proved membership.
    const { supabase, accountId, userId } = await requireRole('admin');

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
        {
          error:
            'WhatsApp not configured. Connect your WhatsApp Business account in Settings first.',
        },
        { status: 400 }
      );
    }

    if (!config.waba_id) {
      return NextResponse.json(
        {
          error:
            'WABA (WhatsApp Business Account) ID missing. Re-connect your account in Settings.',
        },
        { status: 400 }
      );
    }

    const accessToken = decrypt(config.access_token);

    const result = await syncTemplatesFromMeta(supabase, {
      accountId,
      userId,
      wabaId: config.waba_id,
      accessToken,
    });

    // Los `message` de `result.errors` son `PostgrestError.message` tal
    // cual (constraint, columna, tabla). 80e0e9d los tapó en `/api/v1` y
    // dejó aquí el detalle porque lo veía un admin de la propia cuenta,
    // pero la interfaz nunca lo muestra (solo `name` y `language`), así
    // que tampoco tiene por qué salir del servidor (a7.8 §4): va al log.
    for (const e of result.errors) {
      console.error(
        `[whatsapp/templates/sync] account=${accountId} template=${e.name}/${e.language}:`,
        e.message
      );
    }

    return NextResponse.json({
      success: result.errors.length === 0,
      total: result.total,
      inserted: result.inserted,
      updated: result.updated,
      errors: result.errors.map((e) => ({
        name: e.name,
        language: e.language,
        message: TEMPLATE_SAVE_FAILED,
      })),
      truncated: result.truncated,
    });
  } catch (error) {
    // Auth failures map to 401/403 rather than being folded into the
    // generic 500 below.
    if (error instanceof UnauthorizedError || error instanceof ForbiddenError) {
      return toErrorResponse(error);
    }
    // Meta rechazó la lectura del catálogo: mismo 502 con su mensaje que
    // devolvía la versión anterior de esta ruta.
    if (error instanceof TemplateSyncError) {
      return NextResponse.json(
        { error: error.message },
        { status: error.status }
      );
    }
    // Cualquier otra cosa (un fallo de descifrado, un error de Postgres
    // lanzado en vez de devuelto) es interna: el detalle al log, al
    // navegador un texto fijo.
    console.error('Error syncing WhatsApp templates:', error);
    return NextResponse.json(
      { error: 'Failed to sync templates' },
      { status: 500 }
    );
  }
}
