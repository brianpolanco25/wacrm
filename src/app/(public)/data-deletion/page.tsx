import {
  LegalPage,
  legalMetadata,
  type LegalPageProps,
} from '@/components/legal/legal-page';

export const generateMetadata = (props: LegalPageProps) =>
  legalMetadata('data-deletion', props);

export default function Page(props: LegalPageProps) {
  return <LegalPage slug="data-deletion" {...props} />;
}
