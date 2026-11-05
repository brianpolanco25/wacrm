// ============================================================
// Traza de las escrituras de integraciones en sesión de soporte (n13.6).
//
// El humano revirtió D3 de n13.1 (2026-11-05): el operador de plataforma,
// en sesión de soporte, activa, prueba, desactiva y ajusta la IA de una
// integración del cliente. Cada una de esas escrituras queda en
// `impersonation_actions` con la acción y el SLUG de la integración (la
// ruta solo lleva el uuid), y nunca con la credencial ni sus últimos 4.
//
// Se llama ANTES de escribir: si la traza no se puede guardar, la ruta
// responde 503 (`SupportAuditError`) y no escribe nada.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import type { AccountContext } from '@/lib/auth/account';
import { labelSupportAction } from '@/lib/auth/support-actions';
import type { SupportWriteMethod } from '@/lib/auth/support-scope';

import { findIntegrationSlug } from './account';

export type IntegrationSupportAction =
  | 'integration.enable'
  | 'integration.test'
  | 'integration.disable'
  | 'integration.ai_settings';

/**
 * Fuera de una sesión de soporte no hace nada y devuelve `true`. Dentro,
 * anota la acción y devuelve `false` si la integración no existe en el
 * catálogo (la ruta responde 404 sin escribir). `slug`, si la ruta ya lo
 * tiene, ahorra la consulta.
 */
export async function traceIntegrationSupportAction(
  ctx: Pick<AccountContext, 'impersonation'>,
  db: SupabaseClient,
  input: {
    integrationId: string;
    action: IntegrationSupportAction;
    method: SupportWriteMethod;
    path: string;
    slug?: string;
  }
): Promise<boolean> {
  if (!ctx.impersonation) return true;
  const slug =
    input.slug ?? (await findIntegrationSlug(db, input.integrationId));
  if (!slug) return false;
  await labelSupportAction(ctx.impersonation, {
    method: input.method,
    path: input.path,
    action: input.action,
    detail: slug,
  });
  return true;
}
