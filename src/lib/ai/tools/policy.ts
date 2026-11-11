// ============================================================
// Política de IA de una operación (n13.7, R23, R26, R29).
//
// Puro. `requires_prior` son pasos en orden; cada paso, keys alternativas
// de la MISMA integración. Se cumple si en la evidencia previa hay, para
// cada paso, una llamada a alguna de sus keys POSTERIOR a la que cumplió
// el paso anterior.
// ============================================================

import {
  AI_GROUND_CLAIMS,
  type AiGroundClaim,
  type OperationAiPolicy,
} from '@/lib/integrations/types';

import type { PriorEvidence } from './types';

/**
 * Formato de key de operación: el mismo `OPERATION_KEY_RE` de
 * `catalog-validate.ts`, copiado porque aquel importa `node:net` y este
 * archivo lo carga también el esquema de herramientas.
 */
const POLICY_KEY_RE = /^[a-z][a-z0-9_]{1,63}$/;
export const POLICY_MAX_STEPS = 3;
export const POLICY_MAX_KEYS_PER_STEP = 4;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * R23: `null` si la política es válida (o está ausente), o el problema.
 */
export function policyProblem(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  if (!isPlainObject(raw)) return 'ai_policy must be an object or null';
  for (const key of Object.keys(raw)) {
    if (key !== 'grounds' && key !== 'requires_prior') {
      return `ai_policy has an unknown key: ${key}`;
    }
  }
  if (raw.grounds !== undefined) {
    if (
      !Array.isArray(raw.grounds) ||
      raw.grounds.some(
        (g) => !(AI_GROUND_CLAIMS as readonly unknown[]).includes(g)
      )
    ) {
      return `ai_policy.grounds accepts only: ${AI_GROUND_CLAIMS.join(', ')}`;
    }
  }
  if (raw.requires_prior !== undefined) {
    const steps = raw.requires_prior;
    if (!Array.isArray(steps) || steps.length > POLICY_MAX_STEPS) {
      return `ai_policy.requires_prior must be a list of at most ${POLICY_MAX_STEPS} steps`;
    }
    for (const step of steps) {
      if (
        !Array.isArray(step) ||
        step.length === 0 ||
        step.length > POLICY_MAX_KEYS_PER_STEP
      ) {
        return `each ai_policy.requires_prior step needs 1 to ${POLICY_MAX_KEYS_PER_STEP} operation keys`;
      }
      if (step.some((k) => typeof k !== 'string' || !POLICY_KEY_RE.test(k))) {
        return 'ai_policy.requires_prior has an invalid operation key';
      }
    }
  }
  return null;
}

/** La política leída de la base, o `null` si no es válida (R26). */
export function sanitizePolicy(raw: unknown): OperationAiPolicy | null {
  if (raw === null || raw === undefined || policyProblem(raw) !== null) {
    return null;
  }
  const value = raw as OperationAiPolicy;
  const out: OperationAiPolicy = {};
  if (value.grounds && value.grounds.length > 0) {
    out.grounds = [...new Set(value.grounds)] as AiGroundClaim[];
  }
  if (value.requires_prior && value.requires_prior.length > 0) {
    out.requires_prior = value.requires_prior.map((s) => [...s]);
  }
  return out.grounds || out.requires_prior ? out : null;
}

export function groundsSchedule(
  policy: OperationAiPolicy | null | undefined
): boolean {
  return policy?.grounds?.includes('schedule') === true;
}

/** R29: ¿se puede ejecutar ya? Si no, los pasos que faltan (en orden). */
export function checkRequiresPrior(
  policy: OperationAiPolicy | null | undefined,
  integrationSlug: string,
  evidence: PriorEvidence[]
): { ok: true } | { ok: false; missing: string[][] } {
  const steps = policy?.requires_prior ?? [];
  if (steps.length === 0) return { ok: true };
  const keys = evidence
    .filter((e) => e.integrationSlug === integrationSlug)
    .map((e) => e.operationKey);
  let after = -1;
  for (let i = 0; i < steps.length; i += 1) {
    const step = steps[i];
    let found = -1;
    for (let j = after + 1; j < keys.length; j += 1) {
      if (step.includes(keys[j])) {
        found = j;
        break;
      }
    }
    if (found === -1) return { ok: false, missing: steps.slice(i) };
    after = found;
  }
  return { ok: true };
}
