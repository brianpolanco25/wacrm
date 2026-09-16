import {
  docsMetadata,
  DocsPageView,
  readDocsLocale,
  type DocsPageProps,
} from '@/components/developers/docs-page-view';

export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata('authentication', props);

export default async function Page(props: DocsPageProps) {
  return (
    <DocsPageView slug="authentication" locale={await readDocsLocale(props)} />
  );
}
