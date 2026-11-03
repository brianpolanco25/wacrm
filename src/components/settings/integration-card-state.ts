// ============================================================
// Lógica pura de las tarjetas de Ajustes → Integraciones (n13.1, R19):
// estado de la tarjeta, acciones visibles según rol / plan, y la
// secuencia «activar → probar» que la UI lanza al guardar una
// credencial. Fuera del componente para probarla sin DOM.
// ============================================================

import type {
  AccountIntegrationView,
  IntegrationTestStatus,
} from '@/lib/integrations/types';

export type CardStatus = 'active' | 'inactive' | 'planRequired' | 'retired';
export type CardAction = 'activate' | 'test' | 'change' | 'deactivate';

/** A dónde manda «Mejorar plan» (el mismo destino que el 402 de la API). */
export const UPGRADE_PATH = '/billing';

export interface CardContext {
  planAllows: boolean;
  canManage: boolean;
}

/**
 * Estado que se pinta: `Retirada` gana a todo (el operador la apagó),
 * luego `Requiere plan`, luego `Activa` / `No activada`.
 */
export function cardStatus(
  view: Pick<AccountIntegrationView, 'retired' | 'enabled'>,
  planAllows: boolean
): CardStatus {
  if (view.retired) return 'retired';
  if (!planAllows) return 'planRequired';
  return view.enabled ? 'active' : 'inactive';
}

/**
 * Acciones visibles. Sin `canManage` (agent / viewer, o sesión de
 * soporte), ninguna: solo lectura. Retirada o sin plan, solo
 * «Desactivar» si sigue activada (la ruta lo permite sin plan).
 */
export function visibleActions(
  view: Pick<AccountIntegrationView, 'retired' | 'enabled'>,
  ctx: CardContext
): CardAction[] {
  if (!ctx.canManage) return [];
  if (view.retired || !ctx.planAllows)
    return view.enabled ? ['deactivate'] : [];
  return view.enabled ? ['test', 'change', 'deactivate'] : ['activate'];
}

/** Etiqueta del campo de credencial: `Token` o el nombre de la cabecera. */
export function credentialLabel(
  view: Pick<AccountIntegrationView, 'authScheme' | 'authHeaderName'>
):
  | { key: 'credentialLabelBearer' }
  | { key: 'credentialLabelHeader'; header: string } {
  return view.authScheme === 'header' && view.authHeaderName
    ? { key: 'credentialLabelHeader', header: view.authHeaderName }
    : { key: 'credentialLabelBearer' };
}

export type Fetcher = (url: string, init?: RequestInit) => Promise<Response>;

export interface TestOutcome {
  result: IntegrationTestStatus;
  status: number | null;
  testedAt: string;
}

export type ActivateResult =
  | {
      ok: true;
      integration: AccountIntegrationView | null;
      /** null si la prueba no pudo lanzarse (429, red…). */
      test: TestOutcome | null;
    }
  | { ok: false; status: number; error: string | null };

function testUrl(id: string) {
  return `/api/account/integrations/${encodeURIComponent(id)}/test`;
}

/** POST de la prueba; null si no hubo resultado. */
export async function runConnectionTest(
  integrationId: string,
  fetcher: Fetcher = fetch
): Promise<TestOutcome | null> {
  try {
    const res = await fetcher(testUrl(integrationId), { method: 'POST' });
    if (!res.ok) return null;
    return (await res.json()) as TestOutcome;
  } catch {
    return null;
  }
}

/**
 * R19: guarda la credencial (PUT) y, solo si se guardó, lanza la prueba
 * (POST test). Un PUT fallido no prueba nada.
 */
export async function activateAndTest(
  integrationId: string,
  credential: string,
  fetcher: Fetcher = fetch
): Promise<ActivateResult> {
  let res: Response;
  try {
    res = await fetcher(
      `/api/account/integrations/${encodeURIComponent(integrationId)}`,
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential }),
      }
    );
  } catch {
    return { ok: false, status: 0, error: null };
  }
  const body = (await res.json().catch(() => null)) as {
    integration?: AccountIntegrationView | null;
    error?: string;
  } | null;
  if (!res.ok) {
    return { ok: false, status: res.status, error: body?.error ?? null };
  }
  const test = await runConnectionTest(integrationId, fetcher);
  return { ok: true, integration: body?.integration ?? null, test };
}
