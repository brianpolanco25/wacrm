import {
  ChangelogView,
  changelogToc,
} from '@/components/developers/changelog-view';
import {
  docsMetadata,
  DocsPageView,
  readDocsLocale,
  type DocsPageProps,
} from '@/components/developers/docs-page-view';

export const generateMetadata = (props: DocsPageProps) =>
  docsMetadata('changelog', props);

export default async function Page(props: DocsPageProps) {
  const locale = await readDocsLocale(props);
  return (
    <DocsPageView slug="changelog" locale={locale} extraToc={changelogToc()}>
      <ChangelogView locale={locale} />
    </DocsPageView>
  );
}
