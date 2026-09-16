import {
  docsMetadata,
  DocsPageView,
  readDocsLocale,
  type DocsPageProps,
} from '@/components/developers/docs-page-view';

export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata('guides/templates', props);

export default async function Page(props: DocsPageProps) {
  return (
    <DocsPageView
      slug="guides/templates"
      locale={await readDocsLocale(props)}
    />
  );
}
