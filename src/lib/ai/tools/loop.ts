// ============================================================
// Bucle de herramientas de un turno de IA (n13.3, R15, R17–R22, R29, R37).
//
//   vuelta = una llamada al proveedor; turno = una respuesta al cliente.
//
// El modelo pide herramientas; se ejecutan EN ORDEN y de una en una con el
// ejecutor común (`source: 'ai'`, la cuenta de la conversación) y sus
// resultados vuelven al modelo en la vuelta siguiente. Topes: 5 vueltas
// con herramientas, 8 ejecuciones y `AI_TOOL_BUDGET_MS`; alcanzado
// cualquiera, la vuelta siguiente es la final, sin herramientas. Solo el
// texto de la última vuelta es la respuesta.
//
// Consola (R29): id de cuenta, slug, key, outcome y status. Nunca
// argumentos, cuerpos ni el texto de los resultados.
//
// n13.7: dos guardias de código, ambas solo con herramientas que
// declaran `ai_policy` (sin ellas el bucle es el de antes, R40):
//   - destructiva (R28–R31): una herramienta con `requires_prior` solo se
//     ejecuta si la evidencia de turnos ANTERIORES de la conversación
//     cumple sus pasos; si no, el modelo recibe `policy_requires_prior`.
//   - texto final (R35–R39): un texto que afirma días u horas sin datos
//     de agenda en el turno (lectura en vivo ok o llamada ok a una
//     herramienta con `grounds: schedule`) recibe UNA vuelta correctiva;
//     si insiste, el turno es un traspaso. No aplica en `draft`.
//
// n13.11: el texto final (auto_reply y draft, nunca el traspaso) pasa por
// `fixWeekdays` con la fecha de hoy en la zona de la primera integración
// con zona válida (o UTC): un weekday que contradice a su fecha se corrige.
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { executeIntegrationOperation } from '@/lib/integrations/execute';

import { HANDOFF_SENTINEL, aiRequestTimeoutMs } from '../defaults';
import { generateAnthropicWithTools } from '../providers/anthropic';
import { generateGeminiWithTools } from '../providers/gemini';
import { generateOpenAiWithTools } from '../providers/openai';
import {
  sumUsage,
  type ProviderToolArgs,
  type ProviderToolResult,
  type ToolStep,
} from '../providers/shared';
import {
  AiError,
  type AiConfig,
  type AiProvider,
  type AiUsage,
  type ChatMessage,
} from '../types';
import { flattenToolArgs } from './args';
import { loadPriorEvidence } from './evidence';
import { GROUNDING_RETRY_NOTE, mentionsSchedule } from './grounding';
import { invalidateLiveCache } from './live';
import { isValidTimeZone, todayInZone } from './local-time';
import { checkRequiresPrior, groundsSchedule } from './policy';
import { errorPayload, policyPayload, toolResultPayload } from './result';
import { fixWeekdays } from './weekday-fix';
import {
  AI_TOOL_DEFAULT_BUDGET_MS,
  AI_TOOL_MAX_CALLS,
  AI_TOOL_MAX_ROUNDS,
  INVALID_ARGS,
  type AiTool,
  type AiToolMode,
  type AiToolset,
  type LiveDataBlock,
  type PriorEvidence,
  type ToolResultForModel,
  type ToolUseRecord,
} from './types';

export interface ToolLoopArgs {
  config: AiConfig;
  systemPrompt: string;
  messages: ChatMessage[];
  toolset: AiToolset;
  /** Rol de servicio: el ejecutor lee la activación de `accountId`. */
  db: SupabaseClient;
  /** La cuenta de la conversación o de la sesión, nunca del cuerpo. */
  accountId: string;
  /** n13.7: sin él, `auto_reply` (solo importa con `ai_policy`). */
  mode?: AiToolMode;
  /** n13.7 R36: lecturas en vivo del turno (ya en el system prompt). */
  liveData?: LiveDataBlock[];
  /** n13.7 R32: evidencia previa del playground (sin conversación). */
  priorEvidence?: PriorEvidence[];
  /** n13.7 R27/R28: conversación de `auto_reply`. */
  conversationId?: string | null;
}

export interface ToolLoopDeps {
  now?: () => number;
  execute?: typeof executeIntegrationOperation;
  /** n13.7 R28: inyectable en tests. */
  loadEvidence?: typeof loadPriorEvidence;
  /** n13.7 R13: inyectable en tests. */
  invalidate?: typeof invalidateLiveCache;
  callProvider?: (
    provider: AiProvider,
    args: ProviderToolArgs
  ) => Promise<ProviderToolResult>;
}

export interface ToolLoopResult {
  text: string;
  usage: AiUsage | null;
  toolsUsed: ToolUseRecord[];
  /** n13.7 R37/R38: qué hizo la guardia del texto (no se persiste). */
  grounding?: 'retried' | 'handoff';
}

/** R19: presupuesto del turno. Override con `AI_TOOL_BUDGET_MS`. */
export function aiToolBudgetMs(): number {
  const raw = Number(process.env.AI_TOOL_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : AI_TOOL_DEFAULT_BUDGET_MS;
}

/**
 * n13.11: corrige el weekday del texto final con la fecha de hoy en la zona
 * de la primera integración con zona válida (si ninguna, UTC). El traspaso
 * no se toca.
 */
function guardWeekdays(
  text: string,
  toolset: AiToolset,
  now: Date,
  accountId: string
): string {
  if (!text || text.includes(HANDOFF_SENTINEL)) return text;
  const zone =
    toolset.integrations.find(
      (i) => i.timezone !== null && isValidTimeZone(i.timezone)
    )?.timezone ?? 'UTC';
  const today = todayInZone(now, zone);
  if (!today) return text;
  const fixed = fixWeekdays(text, today);
  if (fixed.fixes > 0) {
    console.warn('[ai weekday-fix]', accountId, fixed.fixes);
  }
  return fixed.text;
}

function defaultCallProvider(
  provider: AiProvider,
  args: ProviderToolArgs
): Promise<ProviderToolResult> {
  switch (provider) {
    case 'openai':
      return generateOpenAiWithTools(args);
    case 'anthropic':
      return generateAnthropicWithTools(args);
    case 'gemini':
      return generateGeminiWithTools(args);
    default:
      throw new AiError(`Unsupported AI provider: ${String(provider)}`, {
        code: 'unsupported_provider',
        status: 400,
      });
  }
}

export async function runToolLoop(
  args: ToolLoopArgs,
  deps: ToolLoopDeps = {}
): Promise<ToolLoopResult> {
  const now = deps.now ?? Date.now;
  const execute = deps.execute ?? executeIntegrationOperation;
  const callProvider = deps.callProvider ?? defaultCallProvider;
  const invalidate = deps.invalidate ?? invalidateLiveCache;
  const budget = aiToolBudgetMs();
  const mode: AiToolMode = args.mode ?? 'auto_reply';
  const byName = new Map<string, AiTool>(
    args.toolset.tools.map((t) => [t.name, t])
  );
  const specs = args.toolset.tools.map((t) => ({
    name: t.name,
    description: t.description,
    parameters: t.parameters,
  }));

  const started = now();
  const steps: ToolStep[] = [];
  const used: ToolUseRecord[] = [];
  let usage: AiUsage | null = null;
  let executed = 0;
  let rounds = 0;

  // n13.7 R28/R31/R32: evidencia previa, UNA vez y solo si hace falta.
  const guarded = args.toolset.tools.some(
    (t) => (t.policy?.requires_prior?.length ?? 0) > 0
  );
  let evidence: PriorEvidence[] = [];
  if (guarded) {
    if (args.priorEvidence) {
      evidence = args.priorEvidence;
    } else {
      try {
        evidence = await (deps.loadEvidence ?? loadPriorEvidence)(
          args.db,
          args.accountId,
          args.conversationId ?? null,
          new Date(now())
        );
      } catch {
        evidence = [];
      }
    }
  }
  // R32: el `slug` solo viaja cuando el playground lo necesita para el trail.
  const record = (tool: AiTool, ok: boolean, blocked?: 'policy') => {
    used.push({
      integration: tool.integrationName,
      operation: tool.operationKey,
      ok,
      ...(guarded ? { slug: tool.integrationSlug } : {}),
      ...(blocked ? { blocked } : {}),
    });
  };
  // n13.9: zona de cada integración, para los campos `_local` del resultado.
  const timeZoneOf = new Map<string, string | null>(
    args.toolset.integrations.map((i) => [i.slug, i.timezone])
  );
  const toolNameOf = (slug: string, key: string) =>
    args.toolset.tools.find(
      (t) => t.integrationSlug === slug && t.operationKey === key
    )?.name ?? key;

  // n13.7 R36: guardia del texto final.
  const textGuard =
    mode !== 'draft' &&
    args.toolset.tools.some((t) => groundsSchedule(t.policy));
  let grounded = (args.liveData ?? []).some(
    (b) => b.result.ok && b.grounds.includes('schedule')
  );
  let retried = false;
  let retryRound = false;
  let grounding: ToolLoopResult['grounding'];

  for (;;) {
    const final =
      !retryRound &&
      (rounds >= AI_TOOL_MAX_ROUNDS ||
        executed >= AI_TOOL_MAX_CALLS ||
        now() - started > budget);
    // R22: un AiError del proveedor se propaga, con el uso de las vueltas
    // previas para que el llamador lo registre igualmente.
    const round = await callProvider(args.config.provider, {
      apiKey: args.config.apiKey,
      model: args.config.model,
      systemPrompt: retryRound
        ? `${args.systemPrompt}\n\n${GROUNDING_RETRY_NOTE}`
        : args.systemPrompt,
      messages: args.messages,
      timeoutMs: aiRequestTimeoutMs(),
      tools: specs,
      steps: [...steps],
      toolChoice: final ? 'none' : 'auto',
    }).catch((err: unknown) => {
      if (err instanceof AiError && usage)
        err.usage = sumUsage(err.usage, usage);
      throw err;
    });
    usage = sumUsage(usage, round.usage);
    if (final || round.toolCalls.length === 0) {
      const text = round.text;
      if (
        textGuard &&
        !grounded &&
        !text.includes(HANDOFF_SENTINEL) &&
        mentionsSchedule(text)
      ) {
        // R37: una vuelta correctiva, fuera de AI_TOOL_MAX_ROUNDS.
        if (
          !retried &&
          executed < AI_TOOL_MAX_CALLS &&
          now() - started <= budget
        ) {
          retried = true;
          retryRound = true;
          grounding = 'retried';
          continue;
        }
        // R38: sin fundamento tras la vuelta (o sin poder hacerla).
        console.warn('[ai grounding]', args.accountId, mode, 'handoff');
        return {
          text: HANDOFF_SENTINEL,
          usage,
          toolsUsed: used,
          grounding: 'handoff',
        };
      }
      return {
        text: guardWeekdays(
          text,
          args.toolset,
          new Date(now()),
          args.accountId
        ),
        usage,
        toolsUsed: used,
        ...(grounding ? { grounding } : {}),
      };
    }
    // La vuelta correctiva no cuenta para AI_TOOL_MAX_ROUNDS (R37).
    if (retryRound) retryRound = false;
    else rounds += 1;

    const results: ToolResultForModel[] = [];
    for (const call of round.toolCalls) {
      const tool = byName.get(call.name);
      let outcome: { isError: boolean; payload: Record<string, unknown> };
      const policyCheck =
        tool && guarded
          ? checkRequiresPrior(tool.policy, tool.integrationSlug, evidence)
          : ({ ok: true } as const);
      if (!tool) {
        outcome = errorPayload('unknown_tool');
      } else if (call.args === INVALID_ARGS) {
        outcome = errorPayload('invalid_arguments');
      } else if (executed >= AI_TOOL_MAX_CALLS) {
        outcome = errorPayload('limit_reached');
      } else if (!policyCheck.ok) {
        // R30: sin llamar a la integración ni registrar fila.
        outcome = policyPayload(
          policyCheck.missing.map((step) =>
            step
              .map((key) => toolNameOf(tool.integrationSlug, key))
              .join(' or ')
          )
        );
        record(tool, false, 'policy');
        console.info(
          '[ai tools]',
          args.accountId,
          tool.integrationSlug,
          tool.operationKey,
          'policy_requires_prior'
        );
      } else {
        executed += 1;
        const flat = flattenToolArgs(call.args);
        try {
          const res = await execute(args.db, {
            accountId: args.accountId,
            integrationSlug: tool.integrationSlug,
            operationKey: tool.operationKey,
            params: flat,
            source: 'ai',
            ...(args.conversationId
              ? { conversationId: args.conversationId }
              : {}),
          });
          outcome = toolResultPayload(
            res,
            tool.declaredParams,
            flat,
            timeZoneOf.get(tool.integrationSlug) ?? null,
            new Date(now())
          );
          record(tool, res.ok);
          if (res.ok) {
            if (groundsSchedule(tool.policy)) grounded = true;
            // R13: una escritura cambia lo que devolverían las lecturas.
            if (tool.method !== 'GET') {
              invalidate(args.accountId, tool.integrationSlug);
            }
          }
          console.info(
            '[ai tools]',
            args.accountId,
            tool.integrationSlug,
            tool.operationKey,
            res.ok ? 'ok' : res.outcome,
            res.status
          );
        } catch {
          // R21: pese al contrato del ejecutor; el error no se escribe.
          outcome = errorPayload('error');
          record(tool, false);
          console.error(
            '[ai tools]',
            args.accountId,
            tool.integrationSlug,
            tool.operationKey,
            'threw'
          );
        }
      }
      results.push({ callId: call.id, name: call.name, ...outcome });
    }
    steps.push({ assistant: round.assistant, results });
  }
}
