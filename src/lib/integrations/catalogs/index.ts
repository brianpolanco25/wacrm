// ============================================================
// Registro de catálogos versionados (n13.5, D6): `slug → definición`.
// El siguiente conector solo añade su archivo y una línea aquí.
// Ejecutable por Node 24 sin alias (lo importa el script de carga).
// ============================================================

import { CABBITY_HEALTH_CATALOG } from './cabbity-health.ts';
import type { IntegrationCatalogDefinition } from './definition.ts';

export const INTEGRATION_CATALOGS: Readonly<
  Record<string, IntegrationCatalogDefinition>
> = {
  'cabbity-health': CABBITY_HEALTH_CATALOG,
};
