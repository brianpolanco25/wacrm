import {
  LegalPage,
  legalMetadata,
  type LegalPageProps,
} from '@/components/legal/legal-page';

export const generateMetadata = (props: LegalPageProps) =>
  legalMetadata('privacy', props);

export default function Page(props: LegalPageProps) {
  return <LegalPage slug="privacy" {...props} />;
}
