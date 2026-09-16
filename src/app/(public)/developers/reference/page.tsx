import { getTranslations } from 'next-intl/server';

import {
  docsMetadata,
  DocsPageView,
  readDocsLocale,
  type DocsPageProps,
} from '@/components/developers/docs-page-view';
import { buildReference } from '@/components/developers/openapi/model';
import {
  ReferenceView,
  referenceToc,
} from '@/components/developers/openapi/render';
import { getOpenApiDocument } from '@/components/developers/openapi/source';

export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata('reference', props);

/**
 * La referencia se construye en el servidor a partir del documento
 * OpenAPI: nada de esto viaja al navegador como datos, solo el HTML ya
 * pintado.
 */
export default async function Page(props: DocsPageProps) {
  const locale = await readDocsLocale(props);
  const t = await getTranslations('Developers.reference');
  const model = buildReference(getOpenApiDocument());
  return (
    <DocsPageView
      slug="reference"
      locale={locale}
      extraToc={referenceToc(model, t('webhookEvents'))}
    >
      <ReferenceView model={model} />
    </DocsPageView>
  );
}
