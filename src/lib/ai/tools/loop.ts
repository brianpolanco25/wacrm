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
// ============================================================

import type { SupabaseClient } from '@supabase/supabase-js';

import { executeIntegrationOperation } from '@/lib/integrations/execute';

import { aiRequestTimeoutMs } from '../defaults';
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
import { errorPayload, toolResultPayload } from './result';
import {
  AI_TOOL_DEFAULT_BUDGET_MS,
  AI_TOOL_MAX_CALLS,
  AI_TOOL_MAX_ROUNDS,
  INVALID_ARGS,
  type AiTool,
  type AiToolset,
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
}

export interface ToolLoopDeps {
  now?: () => number;
  execute?: typeof executeIntegrationOperation;
  callProvider?: (
    provider: AiProvider,
    args: ProviderToolArgs
  ) => Promise<ProviderToolResult>;
}

export interface ToolLoopResult {
  text: string;
  usage: AiUsage | null;
  toolsUsed: ToolUseRecord[];
}

/** R19: presupuesto del turno. Override con `AI_TOOL_BUDGET_MS`. */
export function aiToolBudgetMs(): number {
  const raw = Number(process.env.AI_TOOL_BUDGET_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : AI_TOOL_DEFAULT_BUDGET_MS;
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
  const budget = aiToolBudgetMs();
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

  for (;;) {
    const final =
      rounds >= AI_TOOL_MAX_ROUNDS ||
      executed >= AI_TOOL_MAX_CALLS ||
      now() - started > budget;
    // R22: un AiError del proveedor se propaga tal cual.
    const round = await callProvider(args.config.provider, {
      apiKey: args.config.apiKey,
      model: args.config.model,
      systemPrompt: args.systemPrompt,
      messages: args.messages,
      timeoutMs: aiRequestTimeoutMs(),
      tools: specs,
      steps: [...steps],
      toolChoice: final ? 'none' : 'auto',
    });
    usage = sumUsage(usage, round.usage);
    if (final || round.toolCalls.length === 0) {
      return { text: round.text, usage, toolsUsed: used };
    }
    rounds += 1;

    const results: ToolResultForModel[] = [];
    for (const call of round.toolCalls) {
      const tool = byName.get(call.name);
      let outcome: { isError: boolean; payload: Record<string, unknown> };
      if (!tool) {
        outcome = errorPayload('unknown_tool');
      } else if (call.args === INVALID_ARGS) {
        outcome = errorPayload('invalid_arguments');
      } else if (executed >= AI_TOOL_MAX_CALLS) {
        outcome = errorPayload('limit_reached');
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
          });
          outcome = toolResultPayload(res, tool.declaredParams, flat);
          used.push({
            integration: tool.integrationName,
            operation: tool.operationKey,
            ok: res.ok,
          });
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
          used.push({
            integration: tool.integrationName,
            operation: tool.operationKey,
            ok: false,
          });
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
