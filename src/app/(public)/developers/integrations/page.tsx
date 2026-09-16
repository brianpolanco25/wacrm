import {
  docsMetadata,
  DocsPageView,
  readDocsLocale,
  type DocsPageProps,
} from '@/components/developers/docs-page-view';

export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata('integrations', props);

export default async function Page(props: DocsPageProps) {
  return (
    <DocsPageView slug="integrations" locale={await readDocsLocale(props)} />
  );
}
