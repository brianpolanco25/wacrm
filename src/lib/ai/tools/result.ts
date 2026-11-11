// ============================================================
// Lo que ve el modelo de una llamada a herramienta (n13.3, R17, R18,
// R21, R23, R24).
//
// Puro. El resultado del ejecutor se convierte en un objeto JSON pequeño:
// éxito con `data` (truncado a 8 KiB) o fallo con su `outcome` y una
// pista fija en inglés. Nunca lleva la credencial (el ejecutor no la
// devuelve) ni texto que no venga del resultado.
// ============================================================

import type { IntegrationCallResult } from '@/lib/integrations/execute';
import { validateCallParams } from '@/lib/integrations/request';
import type { OperationParam, RemoteError } from '@/lib/integrations/types';

import { AI_TOOL_RESULT_MAX_BYTES } from './types';

export type LoopErrorCode =
  | 'unknown_tool'
  | 'invalid_arguments'
  | 'limit_reached'
  | 'error'
  | 'policy_requires_prior';

export const OUTCOME_HINTS: Record<string, string> = {
  invalid_params:
    'The arguments do not match the tool schema; fix them and try again.',
  not_enabled: 'This tool is not available for this business right now.',
  http_error: 'The service returned an error.',
  http_error_404: 'Not found: check the id.',
  http_error_conflict:
    'The service rejected the request; read the error and ask the customer.',
  timeout: 'The service did not respond; do not retry more than once.',
  unreachable: 'The service did not respond; do not retry more than once.',
  rate_limited: 'Too many calls; do not retry now.',
  too_large: 'The response was too large; narrow the query.',
  blocked: 'The call could not be made.',
  error: 'The call could not be made.',
  unknown_tool: 'There is no tool with that name; use only the tools listed.',
  invalid_arguments:
    'The arguments were not valid JSON; send a JSON object that matches the schema.',
  limit_reached:
    'Too many tool calls in this reply; answer with what you already have.',
  // n13.7 R30: `{tools}` se sustituye por los nombres de las que faltan.
  policy_requires_prior:
    'This action is not allowed yet. First call: {tools}, and offer the customer the alternatives in this message. The action can only be done in a later message, after the customer has seen them.',
};

const REMOTE_TEXT_MAX = 300;
const encoder = new TextEncoder();

function byteLength(text: string): number {
  return encoder.encode(text).length;
}

function hintFor(outcome: string, status: number | null): string {
  if (outcome === 'http_error') {
    if (status === 404) return OUTCOME_HINTS.http_error_404;
    if (status === 409 || status === 422) {
      return OUTCOME_HINTS.http_error_conflict;
    }
  }
  return OUTCOME_HINTS[outcome] ?? OUTCOME_HINTS.error;
}

/**
 * R23: `{ok,status,data}`; si su JSON pasa de 8192 bytes, el prefijo más
 * largo del JSON de `data` que quepa (por puntos de código: nunca parte
 * un carácter) en `data_text`, con `truncated: true`.
 */
function successPayload(
  status: number,
  data: unknown
): Record<string, unknown> {
  const full = { ok: true, status, data };
  const fullJson = JSON.stringify(full);
  if (
    fullJson !== undefined &&
    byteLength(fullJson) <= AI_TOOL_RESULT_MAX_BYTES
  ) {
    return full;
  }
  const dataJson = JSON.stringify(data) ?? 'null';
  const chars = Array.from(dataJson);
  const build = (n: number) => ({
    ok: true,
    status,
    truncated: true,
    data_text: chars.slice(0, n).join(''),
  });
  const fits = (n: number) =>
    byteLength(JSON.stringify(build(n))) <= AI_TOOL_RESULT_MAX_BYTES;
  let lo = 0;
  let hi = chars.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(mid)) lo = mid;
    else hi = mid - 1;
  }
  return build(lo);
}

function shortText(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  return Array.from(value).slice(0, REMOTE_TEXT_MAX).join('');
}

/** El cuerpo de error del tercero (`remoteError`, n13.5), cortado a 300. */
function remoteErrorOf(
  remote: RemoteError | undefined
): { code?: string; message?: string } | null {
  if (!remote) return null;
  const code = shortText(remote.code);
  const message = shortText(remote.message);
  if (code === null && message === null) return null;
  return {
    ...(code !== null ? { code } : {}),
    ...(message !== null ? { message } : {}),
  };
}

/** R23/R24: resultado del ejecutor → payload para el modelo. */
export function toolResultPayload(
  result: IntegrationCallResult,
  declaredParams: OperationParam[],
  flatArgs: Record<string, unknown>
): { isError: boolean; payload: Record<string, unknown> } {
  if (result.ok) {
    return {
      isError: false,
      payload: successPayload(result.status, result.data),
    };
  }
  const payload: Record<string, unknown> = {
    ok: false,
    outcome: result.outcome,
    status: result.status ?? null,
    hint: hintFor(result.outcome, result.status ?? null),
  };
  if (result.outcome === 'invalid_params') {
    const check = validateCallParams(declaredParams, flatArgs);
    if (!check.ok) {
      payload.problem = check.problem;
      payload.param = check.param;
    }
  }
  const remote = remoteErrorOf(result.remoteError);
  if (remote) payload.error = remote;
  return { isError: true, payload };
}

/** R17/R18/R21: fallos del bucle, sin llamar al ejecutor. */
export function errorPayload(code: LoopErrorCode): {
  isError: true;
  payload: Record<string, unknown>;
} {
  return {
    isError: true,
    payload: {
      ok: false,
      outcome: code,
      status: null,
      hint: OUTCOME_HINTS[code],
    },
  };
}

/**
 * n13.7 R30: la guardia de política bloqueó la llamada. `required` = un
 * texto por paso que falta (alternativas unidas por « or »).
 */
export function policyPayload(required: string[]): {
  isError: true;
  payload: Record<string, unknown>;
} {
  const base = errorPayload('policy_requires_prior');
  return {
    isError: true,
    payload: {
      ...base.payload,
      error: 'policy_requires_prior',
      required,
      hint: OUTCOME_HINTS.policy_requires_prior.replace(
        '{tools}',
        required.join(', then ')
      ),
    },
  };
}
