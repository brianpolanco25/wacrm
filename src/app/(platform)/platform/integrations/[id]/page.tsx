// ============================================================
// /platform/integrations/[id] — editor de una integración y sus
// operaciones (n13.1). Protegida por el layout `(platform)` y, otra vez,
// aquí. El id solo pasa al componente cliente; toda lectura va detrás de
// `requirePlatformAdmin()` en `/api/platform/integrations/[id]`.
//
// El segmento estático `integrations` casa antes que el dinámico
// `/platform/[id]` (ficha de cuenta), según
// node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/dynamic-routes.md.
// ============================================================

import { guardPlatformPage } from '@/lib/auth/platform-page';
import { PlatformIntegrationEditor } from '@/components/platform/platform-integration-editor';

export default async function PlatformIntegrationPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  await guardPlatformPage();
  const { id } = await params;
  return <PlatformIntegrationEditor id={id} />;
}
