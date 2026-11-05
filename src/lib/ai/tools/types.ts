// ============================================================
// Herramientas de IA desde integraciones (n13.3 `integration-ai-tools`).
//
// Tipos y topes compartidos por la carga (`load.ts`), el esquema
// (`schema.ts`), el bucle (`loop.ts`) y los adaptadores de proveedor.
// Puro: sin nada de Node, lo importan también componentes de cliente.
// ============================================================

import type { HttpMethod, OperationParam } from '@/lib/integrations/types';

/** R4: herramientas como mucho por turno. */
export const AI_TOOL_MAX_TOOLS = 20;
/** R18: vueltas con herramientas por turno (más una final sin ellas). */
export const AI_TOOL_MAX_ROUNDS = 5;
/** R18: ejecuciones de herramienta por turno. */
export const AI_TOOL_MAX_CALLS = 8;
/** R23: tope del JSON del resultado que ve el modelo. */
export const AI_TOOL_RESULT_MAX_BYTES = 8192;
/** R19: presupuesto de tiempo del turno (`AI_TOOL_BUDGET_MS`). */
export const AI_TOOL_DEFAULT_BUDGET_MS = 40_000;
/** R31/R32: longitud máxima de `ai_instructions`. */
export const AI_INSTRUCTIONS_MAX = 2000;
/** R31/R32: longitud máxima de `ai_timezone`. */
export const AI_TIMEZONE_MAX = 64;

/** Subconjunto de JSON Schema que se manda a los tres proveedores. */
export interface JsonSchema {
  type: 'object' | 'string' | 'integer' | 'number' | 'boolean';
  description?: string;
  enum?: string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
}

export type AiToolMode = 'auto_reply' | 'playground' | 'draft';

export interface AiTool {
  /** R6: `^[a-zA-Z][a-zA-Z0-9_]{0,63}$`, único en el turno. */
  name: string;
  integrationSlug: string;
  integrationName: string;
  operationKey: string;
  method: HttpMethod;
  /** R9. */
  description: string;
  /** R7/R8: siempre `type: 'object'`. */
  parameters: JsonSchema;
  /** Los parámetros que puede mandar el modelo (path/query/body), para R24. */
  declaredParams: OperationParam[];
}

export interface AiToolIntegration {
  slug: string;
  name: string;
  instructions: string | null;
  timezone: string | null;
}

export interface AiToolset {
  tools: AiTool[];
  integrations: AiToolIntegration[];
}

export const EMPTY_TOOLSET: AiToolset = { tools: [], integrations: [] };

/** Argumentos de una llamada que no eran JSON válido (OpenAI). */
export const INVALID_ARGS: unique symbol = Symbol('invalid_args');

/** Llamada pedida por el modelo, ya normalizada por el adaptador. */
export interface ToolCall {
  id: string;
  name: string;
  args: unknown;
}

/** Resultado que el adaptador serializa al formato del proveedor. */
export interface ToolResultForModel {
  callId: string;
  name: string;
  isError: boolean;
  payload: Record<string, unknown>;
}

/** Lo que ven el playground y el borrador (R35/R36). */
export interface ToolUseRecord {
  integration: string;
  operation: string;
  ok: boolean;
}

/**
 * R33: lo que añade n13.3 a la vista de una integración en Ajustes. Vive
 * aquí y no en `src/lib/integrations/types.ts` para no chocar con n13.5,
 * que amplía ese archivo en paralelo.
 */
export interface AccountIntegrationAiFields {
  aiEnabled: boolean;
  aiInstructions: string | null;
  aiTimezone: string | null;
}
