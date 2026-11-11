// ============================================================
// Herramientas de IA desde integraciones (n13.3 `integration-ai-tools`).
//
// Tipos y topes compartidos por la carga (`load.ts`), el esquema
// (`schema.ts`), el bucle (`loop.ts`) y los adaptadores de proveedor.
// Puro: sin nada de Node, lo importan también componentes de cliente.
// ============================================================

import type {
  AiGroundClaim,
  HttpMethod,
  OperationAiPolicy,
  OperationParam,
} from '@/lib/integrations/types';

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

/** n13.7 R1: lecturas en vivo como mucho por integración. */
export const AI_LIVE_READS_MAX = 3;
/** n13.7 R19: tope del bloque de datos de una lectura en el prompt. */
export const AI_LIVE_DATA_MAX_BYTES = 6000;
/** n13.7 R11: vida de un resultado `ok` en caché (`AI_LIVE_DATA_TTL_MS`). */
export const AI_LIVE_DATA_DEFAULT_TTL_MS = 60_000;
/** n13.7 R12: vida de un fallo en caché. */
export const AI_LIVE_DATA_FAIL_TTL_MS = 10_000;
/** n13.7 R28 (D8): ventana de evidencia previa de una conversación. */
export const AI_EVIDENCE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** n13.7 R32: entradas como mucho del `trail` del playground. */
export const AI_TRAIL_MAX = 50;

/** n13.7 R1: una lectura en vivo configurada por el admin. */
export interface AiLiveRead {
  operation: string;
  params: Record<string, string | number | boolean>;
}

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
  /** n13.7: política de IA saneada; ausente o `null` = sin política. */
  policy?: OperationAiPolicy | null;
}

export interface AiToolIntegration {
  slug: string;
  name: string;
  instructions: string | null;
  timezone: string | null;
  /** n13.7 R1/R9: lecturas en vivo antes de cada turno. */
  liveReads?: AiLiveRead[];
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
  /** n13.7 R32: slug de la integración (para el `trail` del playground). */
  slug?: string;
  /** n13.7 R30: la guardia de política no dejó ejecutarla. */
  blocked?: 'policy';
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
  /** n13.7 R6. */
  aiLiveReads: AiLiveRead[];
  /** n13.7 R6: operaciones `GET` activas y sus parámetros de llamada. */
  aiReadOperations: AiReadOperation[];
}

/** n13.7 R6: una operación que puede ser lectura en vivo. */
export interface AiReadOperation {
  key: string;
  name: string;
  params: Pick<
    OperationParam,
    'name' | 'type' | 'required' | 'description' | 'enum'
  >[];
}

/** n13.7 R16: resultado de una lectura en vivo, listo para el prompt. */
export interface LiveDataBlock {
  integrationSlug: string;
  integrationName: string;
  operationKey: string;
  timeZone: string | null;
  loadedAt: Date;
  result: { ok: true; data: unknown } | { ok: false };
  grounds: AiGroundClaim[];
}

/** n13.7 R28: una llamada `ok` de la IA en un turno anterior. */
export interface PriorEvidence {
  integrationSlug: string;
  operationKey: string;
}
