// ============================================================
// Forma de un catálogo de integración versionado en el repo (n13.5, D6).
//
// Solo tipos. Lo importa `scripts/integrations-bootstrap-catalog.ts`, que
// Node 24 ejecuta sin compilar (type stripping): nada de alias `@/`,
// imports relativos con extensión `.ts` y, hacia fuera de `catalogs/`,
// solo `import type` (se borran al ejecutar).
// ============================================================

import type {
  HttpMethod,
  OperationAiPolicy,
  OperationOutput,
  OperationParam,
} from '../types.ts';

/** Fila de `integrations` tal como la escribe el script de carga. */
export interface CatalogIntegration {
  slug: string;
  name: string;
  description: string;
  logo_url: null;
  base_url: string;
  auth_scheme: 'bearer' | 'header';
  auth_header_name: string | null;
  credential_help: string;
  test_path: string;
  sort_order: number;
}

/** Fila de `integration_operations` tal como la escribe el script. */
export interface CatalogOperation {
  key: string;
  name: string;
  description: string;
  method: HttpMethod;
  path: string;
  params: OperationParam[];
  outputs: OperationOutput[];
  response_description: string;
  /** Solo al crear la fila; el script no lo vuelve a tocar. */
  is_active: boolean;
  sort_order: number;
  /** n13.7: política de IA; ausente = `null` en la base. */
  ai_policy?: OperationAiPolicy | null;
}

export interface IntegrationCatalogDefinition {
  integration: CatalogIntegration;
  operations: CatalogOperation[];
}
